import copy
import unittest
import tempfile
import json
import wave
import types
from pathlib import Path
from unittest.mock import patch
from existing_alignment import align_document, language_name, probe_alignment


class ExistingAlignmentTests(unittest.TestCase):
    def setUp(self):
        self.doc = dict(key='source', language='en', provenance={'kind':'platform_subtitles'},
                        segments=[dict(id='one', start=1., end=3., text='Hello, world!', speaker='A')])
    def good(self, cue):
        return [dict(word='Hello',start=1.1,end=1.5),dict(word='world',start=2.,end=2.8)]
    def test_preserves_original_and_is_never_quality_confirmation(self):
        before=copy.deepcopy(self.doc)
        result=align_document(self.doc,4,self.good)
        self.assertEqual(self.doc,before)
        self.assertEqual(result['source_snapshot'],before)
        cue=result['document']['segments'][0]
        self.assertEqual((cue['id'],cue['text'],cue['start'],cue['end'],cue['speaker']),('one','Hello, world!',1.,3.,'A'))
        self.assertEqual(''.join(w['word'] for w in cue['words']),cue['text'])
        self.assertEqual(result['alignment_report']['source_text_quality'],'unverified')
        self.assertEqual(result['alignment_report']['status'],'candidate')
    def test_incomplete_text_does_not_erase_original_word_clocks(self):
        self.doc['segments'][0]['words']=[dict(word='original',start=1,end=2)]
        r=align_document(self.doc,4,lambda cue:[dict(word='different',start=1,end=2)])
        self.assertEqual(r['document']['segments'],self.doc['segments'])
        self.assertEqual(r['alignment_report']['aligned_cues'],0)
    def test_bad_windows_skip_model(self):
        for start,end,reason in [(None,3,'missing_timing'),(1,70,'window_too_long'),(1,101,'outside_audio')]:
            with self.subTest(reason=reason):
                self.doc['segments'][0].update(start=start,end=end)
                with patch.object(self,'good') as model:
                    r=align_document(self.doc,100,model)
                    model.assert_not_called()
                    self.assertEqual(r['alignment_report']['cues'][0]['reason'],reason)
    def test_invalid_word_order_and_bounds_rejected(self):
        for words in [[dict(word='Hello world',start=0,end=2)], [dict(word='Hello',start=2,end=2.5),dict(word='world',start=1,end=1.5)], [dict(word='Hello world',start=1,end=float('nan'))]]:
            with self.subTest(words=words):
                r=align_document(self.doc,4,lambda cue:words)
                self.assertEqual(r['alignment_report']['status'],'needs_review')
                self.assertNotIn('words',r['document']['segments'][0])
    def test_duplicate_ids_rejected(self):
        self.doc['segments']*=2
        with self.assertRaises(ValueError):align_document(self.doc,4,self.good)

    def test_context_pass_fills_collapsed_clock_without_shifting_good_clock(self):
        first = [dict(word='Hello', start=1.1, end=1.5), dict(word='world', start=2., end=2.)]
        alternate = [dict(word='Hello', start=1.14, end=1.48), dict(word='world', start=1.96, end=2.16)]
        result = align_document(self.doc, 4, lambda cue:first, retry=lambda cue:alternate)
        words = result['document']['segments'][0]['words']
        self.assertEqual([(w['start'],w['end']) for w in words], [(1.1,1.5),(1.96,2.16)])
        self.assertEqual(''.join(w['word'] for w in words), 'Hello, world!')
        self.assertEqual(result['alignment_report']['cues'][0]['clock_recovery'], 'context_pass')
        self.assertEqual(first[0]['word'], 'Hello')
        self.assertEqual(alternate[0]['word'], 'Hello')

    def test_context_pass_cannot_buy_coverage_with_wrong_text_drift_or_overlap(self):
        first = [dict(word='Hello',start=1.1,end=1.5), dict(word='world',start=1.4,end=1.4)]
        for replacement in [dict(word='other',start=1.5,end=1.6),dict(word='world',start=2,end=2.1),
                            dict(word='world',start=1.35,end=1.44)]:
            result = align_document(self.doc,4,lambda cue:first,retry=lambda cue:[first[0],replacement])
            self.assertEqual(result['alignment_report']['aligned_cues'],0)
            self.assertEqual(result['document']['segments'],self.doc['segments'])
        from unittest.mock import Mock
        retry = Mock()
        align_document(self.doc,4,self.good,retry=retry)
        align_document(self.doc,4,lambda cue:[dict(word='different',start=1.,end=1.)],retry=retry)
        retry.assert_not_called()
    def test_fresh_asr_keeps_text_and_sentence_when_word_retry_is_inconclusive(self):
        from existing_alignment import repair_transcribed_clocks
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            cue = {**self.doc['segments'][0], 'words': [
                dict(word='Hello, ', start=1.1, end=1.5), dict(word='world!', start=2., end=2.)]}
            good = {**copy.deepcopy(cue), 'id':'good'}
            good['words'][1]['end'] = 2.3
            for finish, expected_basis in [(2.16, 'word'), (2.82, 'word_partial')]:
                doc = dict(language='en', segments=[copy.deepcopy(cue), copy.deepcopy(good)])
                measure = Mock(return_value=[dict(word='Hello', start=1.1, end=1.5),
                                             dict(word='world', start=2., end=finish)])
                with patch('audio_pipeline.prepare_audio'), patch('audio_pipeline._wav_frames', return_value=64000), patch('existing_alignment.audio_aligner', return_value=measure):
                    repair_transcribed_clocks(doc, directory/'audio.wav', directory, 'model')
                revised = doc['segments'][0]
                self.assertEqual((revised['text'], revised['start'], revised['end']), ('Hello, world!', 1., 3.))
                self.assertEqual(revised['timing_basis'], expected_basis)
                self.assertEqual(''.join(word['word'] for word in revised['words']), revised['text'])
                self.assertEqual((revised['words'][0]['start'], revised['words'][0]['end']), (1.1, 1.5))
                if expected_basis == 'word_partial':
                    self.assertEqual(revised['alignment_status'], 'needs_review')
                    self.assertEqual(revised['words'][1]['start'], revised['words'][1]['end'])
                self.assertEqual(doc['segments'][1], good)
                measure.assert_called_once()

    def test_worker_cache_binds_audio_text_and_model_and_loads_only_aligner(self):
        from existing_alignment import run_alignment
        from audio_pipeline import _file_digest, SAMPLE_RATE
        with tempfile.TemporaryDirectory() as root:
            root=Path(root); audio=root/'source.wav'
            with wave.open(str(audio),'wb') as f:
                f.setparams((1,2,SAMPLE_RATE,0,'NONE','not compressed'))
                f.writeframes(b'\0'*SAMPLE_RATE*2*4)
            calls=[]
            class Model:
                def generate(self,**kw):
                    calls.append(kw)
                    return types.SimpleNamespace(items=[types.SimpleNamespace(text='Hello',start_time=.1,end_time=.5),types.SimpleNamespace(text='world',start_time=1.,end_time=1.8)])
            loaded=[]
            def load(path):
                loaded.append(path);return Model()
            request=dict(input=str(audio),sha256=_file_digest(audio),work=str(root/'work'),document=self.doc,profile={'align_model':'/only/align'})
            with patch('existing_alignment.probe_alignment',return_value={'available':True}), patch('transcription.fingerprint',return_value='model-a') as fingerprint, patch('importlib.metadata.version',return_value='test'), patch.dict('sys.modules',{'mlx_audio':types.ModuleType('mlx_audio'),'mlx_audio.stt':types.SimpleNamespace(load=load)}), patch('transcription.emit'):
                run_alignment(request);run_alignment(request)
                self.assertEqual(len(calls),1)
                self.assertEqual(loaded,['/only/align'])
                first=json.loads((root/'work/result.json').read_text())
                self.assertEqual(first['source_sha256'],request['sha256'])
                self.assertEqual(first['alignment_report']['status'],'candidate')
                fingerprint.return_value='model-b'
                run_alignment(request)
                self.assertEqual(len(calls),2)
                second=json.loads((root/'work/result.json').read_text())
                self.assertNotEqual(first['alignment_identity'],second['alignment_identity'])
                request['document']=copy.deepcopy(self.doc)
                request['document']['segments'][0]['text']='different'
                run_alignment(request)
                self.assertEqual(len(calls),3)
                self.assertEqual(json.loads((root/'work/result.json').read_text())['alignment_report']['status'],'needs_review')
                request['sha256']='wrong'
                with self.assertRaises(ValueError):run_alignment(request)

    def test_language_codes(self):
        self.assertEqual(language_name('zh-CN'),'chinese')
        self.assertEqual(language_name('en_US'),'english')
        self.assertEqual(language_name('Chinese'),'chinese')
    def test_probe_does_not_require_asr_or_speaker_models(self):
        with patch('importlib.util.find_spec',return_value=object()),patch('transcription.model_files') as models:
            self.assertTrue(probe_alignment({'align_model':'/local/align'})['available'])
            models.assert_called_once_with('/local/align')

if __name__=='__main__':unittest.main()
