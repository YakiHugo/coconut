"""Offline model-adapter contracts; authored stubs never load or fetch weights."""
import contextlib
import copy
import io
import json
import tempfile
import types
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

# sys.modules stubs must not unload NumPy's native modules after reconciliation.
import numpy

from audio_pipeline import SAMPLE_RATE, AudioChunk, validate_result, owned_segments, normalize_word_clocks
from audio_pipeline import _without_invalid_context
from transcription import QwenBackend, model_files, probe, run, sentence_segments, correct_verified_names


def wav(path):
    with wave.open(str(path), 'wb') as audio:
        audio.setparams((1, 2, SAMPLE_RATE, 0, 'NONE', 'not compressed'))
        audio.writeframes(b'\0' * SAMPLE_RATE * 2 * 2)


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.profile = {'backend': 'qwen-mlx', 'asr_model': str(self.root / 'asr'),
                        'align_model': str(self.root / 'align')}
        for key in ('asr_model', 'align_model'):
            directory = Path(self.profile[key])
            directory.mkdir()
            for name in ('config.json', 'tokenizer_config.json', 'tokenizer.json'):
                (directory / name).write_text('{}')
            (directory / 'model.safetensors').write_bytes(b'authored placeholder; never loaded')
        self.audio = self.root / 'source.wav'
        wav(self.audio)

    def backend(self):
        with patch('importlib.metadata.version', return_value='authored'):
            return QwenBackend(self.profile, self.root)

    def test_missing_model_and_partial_shards_are_not_ready_without_download(self):
        with patch('importlib.util.find_spec', return_value=object()):
            self.assertTrue(probe(self.profile)['available'])
            (Path(self.profile['asr_model']) / 'model.safetensors.index.json').write_text(json.dumps({'weight_map': {'w': 'missing.safetensors'}}))
            self.assertFalse(probe(self.profile)['available'])
        with self.assertRaises(ValueError):
            model_files('model/name')

    def test_moss_probe_needs_its_own_model_but_not_qwen_or_sherpa(self):
        directory = Path(self.profile['asr_model'])
        (directory / 'config.json').write_text(json.dumps({'model_type': 'moss_transcribe_diarize'}))
        profile = {**self.profile, 'backend': 'moss-mlx', 'align_model': '/absent/qwen',
                   'segmentation': '/absent/segmentation', 'embedding': '/absent/embedding'}
        with patch('importlib.util.find_spec', side_effect=lambda name: None if name == 'sherpa_onnx' else object()):
            status = probe(profile)
            self.assertTrue(status['available'])
            self.assertTrue(status['speakers'])
            (directory / 'config.json').write_text('{}')
            self.assertFalse(probe(profile)['available'])

    def test_moss_probe_missing_runtime_does_not_select_another_engine(self):
        with patch('importlib.util.find_spec', return_value=None):
            status = probe({**self.profile, 'backend': 'moss-mlx'})
        self.assertFalse(status['available'])
        self.assertEqual(status['code'], 'missing_dependencies')
        self.assertIn('MOSS', status['message'])

    def test_moss_worker_uses_native_recipe_without_qwen_alignment_or_acoustic_overwrite(self):
        from audio_pipeline import _file_digest
        calls = []
        native = dict(language=None, segments=[dict(start=.1, end=1.8, text='刘源你好。',
            speaker='第1块 · S01', speaker_id='speaker-0001', provider_speaker='0:S01',
            speaker_scope='chunk', speaker_status='native_chunk_local',
            timing_basis='native_segment', alignment_status='unavailable', chunk_index=0)],
            pipeline=dict(version='moss-native-v1', chunks=2, duration=2,
                          speaker_count=2, speaker_method='moss-native-v1'))
        def recognize(source, **options):
            calls.append((source, options))
            options['progress'](0, 2)
            return copy.deepcopy(native)
        profile = {**self.profile, 'backend': 'moss-mlx',
                   'segmentation': '/unused/sherpa', 'embedding': '/unused/embedding'}
        work = self.root / 'moss-worker'
        with patch('transcription.probe', return_value={'available': True}), \
                patch.dict('sys.modules', {'moss_asr': types.SimpleNamespace(run_moss_pipeline=recognize)}), \
                patch('transcription.QwenBackend', side_effect=AssertionError('Qwen must not run')), \
                patch('audio_speakers.SherpaSpeakerBackend', side_effect=AssertionError('Sherpa must not run')), \
                contextlib.redirect_stdout(io.StringIO()):
            run(dict(profile=profile, input=str(self.audio), work=str(work),
                     sha256=_file_digest(self.audio), title='对话刘元', hotwords=['刘元'],
                     name_corrections={'刘源': '刘元'}))
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1]['model_path'], profile['asr_model'])
        self.assertEqual(calls[0][1]['hotwords'], ['刘元'])
        document = json.loads((work / 'result.json').read_text())
        cue = document['segments'][0]
        self.assertEqual(cue['text'], '刘元你好。')
        self.assertEqual(cue['original_text'], '刘源你好。')
        self.assertEqual(cue['speaker_scope'], 'chunk')
        self.assertEqual(cue['timing_basis'], 'native_segment')
        self.assertNotIn('words', cue)
        self.assertEqual((cue['start'], cue['end']), (.1, 1.8))
        self.assertEqual(document['provenance']['backend'], 'moss-mlx')
        self.assertEqual(document['provenance']['speaker_method'], 'moss-native-v1')
        self.assertEqual(document['provenance']['language_basis'], 'unknown')

    def test_title_and_names_reach_qwen_and_changed_context_uses_separate_checkpoints(self):
        calls = []
        def recognize(*args, **kwargs):
            calls.append(kwargs)
            return types.SimpleNamespace(text='张元你好。', segments=[dict(text='张元你好。', start=0, end=2, language='Chinese')])
        def align(**kwargs):
            return [types.SimpleNamespace(text='张元你好。', start_time=0, end_time=2)]
        modules = {'mlx_audio': types.ModuleType('mlx_audio'), 'mlx_audio.stt': types.SimpleNamespace(
            load=lambda name: types.SimpleNamespace(generate=recognize if name == self.profile['asr_model'] else align))}
        from audio_pipeline import _file_digest
        request = dict(profile=self.profile, input=str(self.audio), work=str(self.root / 'work'),
                       sha256=_file_digest(self.audio), title='对话张元', hotwords=['张元', '陈旌', '张元'])
        with patch('transcription.probe', return_value={'available': True}), \
                patch('importlib.metadata.version', return_value='authored'), \
                patch.dict('sys.modules', modules), contextlib.redirect_stdout(io.StringIO()):
            run(request)
            run(request)
            run({**request, 'title': '张元访谈第二期'})
            background = dict(platform='xiaoyuzhou', show='技术访谈', publisher='测试作者',
                              description='本期讨论 Manus 和推理系统。')
            run({**request, 'context': background})
            run({**request, 'context': background})
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[0]['hotwords'], ['张元', '陈旌'])
        self.assertEqual(calls[0]['system_prompt'], '节目标题：对话张元')
        self.assertEqual(calls[1]['system_prompt'], '节目标题：张元访谈第二期')
        self.assertIn('节目名称：技术访谈', calls[2]['system_prompt'])
        self.assertIn('发布者提供的内容说明：本期讨论 Manus 和推理系统。', calls[2]['system_prompt'])
        self.assertEqual(len(list((self.root / 'work').glob('audio-context-*'))), 3)

    def test_invalid_vocabulary_is_rejected_before_inference(self):
        for hotwords in ('张元', [''], [42], ['a' * 81], ['a'] * 65):
            with self.assertRaises(ValueError):
                QwenBackend(self.profile, self.root, hotwords=hotwords)

    def test_reviewed_aliases_correct_word_text_across_units_and_preserve_raw_history(self):
        source = {'segments': [dict(id='one', start=0, end=2, text='刘源你好', speaker='张元', words=[
            dict(word='刘', start=0, end=.2), dict(word='源你好', start=.2, end=2)])]}
        before = copy.deepcopy(source)
        result = correct_verified_names(source, {'刘源': '刘元'})
        cue = result['segments'][0]
        self.assertEqual(cue['text'], '刘元你好')
        self.assertEqual(cue['original_text'], '刘源你好')
        self.assertEqual(''.join(w['word'] for w in cue['words']), cue['text'])
        self.assertEqual([(w['start'], w['end']) for w in cue['words']], [(0, .2), (.2, 2)])
        self.assertEqual(cue['speaker'], '张元')
        self.assertEqual(source, before)
        source['segments'][0]['original_text'] = '此前的原始识别'
        self.assertEqual(correct_verified_names(source, {'刘源': '刘元'})['segments'][0]['original_text'], '此前的原始识别')
        self.assertEqual(correct_verified_names(before, {})['segments'], before['segments'])
        source['segments'][0]['words'].pop()
        with self.assertRaises(ValueError):
            correct_verified_names(source, {'刘源': '刘元'})

    def test_alignment_failure_retries_without_recognizing_again(self):
        asr_calls, align_calls = [], []
        def recognize(*args, **kwargs):
            asr_calls.append(args)
            return types.SimpleNamespace(text='你好，世界。', segments=[dict(text='你好，世界。', start=0, end=2, language='Chinese')])
        def align(**kwargs):
            align_calls.append(kwargs)
            if len(align_calls) == 1:
                raise RuntimeError('authored alignment failure')
            return [types.SimpleNamespace(text='你好', start_time=.1, end_time=.8),
                    types.SimpleNamespace(text='世界', start_time=1, end_time=1.8)]
        modules = {'mlx_audio': types.ModuleType('mlx_audio'), 'mlx_audio.stt': types.SimpleNamespace(load=lambda name: types.SimpleNamespace(generate=recognize if name == self.profile['asr_model'] else align))}
        backend = self.backend()
        with patch.dict('sys.modules', modules), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError):
                backend.recognize(self.audio, request_id='authored')
            result = backend.recognize(self.audio, request_id='authored')
        self.assertEqual(len(asr_calls), 1)
        self.assertEqual(len(align_calls), 2)
        self.assertEqual(align_calls[-1]['audio'].dtype, numpy.float32)
        self.assertEqual(len(align_calls[-1]['audio']), 2*SAMPLE_RATE)
        self.assertFalse(list(self.root.rglob('align-*.wav')))
        self.assertEqual(result['segments'][0]['text'], '你好，世界。')
        self.assertEqual(''.join(w['word'] for w in result['segments'][0]['words']), '你好，世界。')
        self.assertEqual(result['language'], 'zh')

    def test_partial_alignment_never_deletes_text_at_a_chunk_boundary(self):
        raw = {'segments': [dict(start=8.8, end=10.9, text='前文后文', words=[
            dict(start=8.8, end=9.2, word='前'), dict(start=10.5, end=10.9, word='后')])]}
        value = validate_result(raw, 12)
        self.assertNotIn('words', value['segments'][0])
        chunk = AudioChunk(0, 0, 12*SAMPLE_RATE, 0, 10*SAMPLE_RATE)
        self.assertEqual(owned_segments(value, chunk, 20*SAMPLE_RATE)[0]['text'], '前文后文')
        self.assertEqual(raw['segments'][0]['text'], '前文后文')

    def test_bad_context_clock_does_not_block_recognized_core_or_change_raw(self):
        chunk=AudioChunk(1, 0, 10*SAMPLE_RATE, SAMPLE_RATE, 9*SAMPLE_RATE)
        raw=dict(segments=[dict(start=0,end=10,text='前，正文尾。',words=[
            dict(word='前',start=-.08,end=.1),dict(word='正文',start=3,end=6),dict(word='尾',start=9.92,end=10.16)])])
        original=copy.deepcopy(raw)
        kept=validate_result(_without_invalid_context(raw,chunk),10)
        self.assertEqual(kept['discarded_invalid_context_words'],2)
        self.assertEqual(kept['segments'][0]['words'],[dict(word='正文',start=3,end=6,text_start=0,text_end=2)])
        self.assertEqual(raw,original)
        raw['segments'][0]['words'][-1]['start']=8.99
        with self.assertRaises(ValueError): validate_result(_without_invalid_context(raw,chunk),10)
        self.assertIsNone(_without_invalid_context(original,AudioChunk(0,0,10*SAMPLE_RATE,0,10*SAMPLE_RATE)))
        raw['segments'][0]['text']='与词不符'
        self.assertIsNone(_without_invalid_context(raw,chunk))

    def test_bad_owned_word_keeps_text_without_fabricating_a_clock(self):
        from audio_pipeline import InvalidWindowClocks, recognize_window
        from unittest.mock import Mock
        raw = dict(segments=[dict(start=0, end=2, text='保留原话。',
                                  words=[dict(word='保留原话', start=1.2, end=2.2)])])
        backend = Mock()
        backend.recognize.side_effect = InvalidWindowClocks('word outside audio', raw, 2)
        result = recognize_window(backend, self.audio, 'timing', AudioChunk(0, 0, 32000, 0, 32000))
        self.assertEqual(result['segments'][0], dict(start=0, end=2, text='保留原话。',
                         alignment_status='needs_review', timing_basis='audio_chunk'))
        self.assertIn('words', raw['segments'][0])
        raw['segments'][0]['end'] = 3
        with self.assertRaises(ValueError):
            recognize_window(backend, self.audio, 'bad-segment', AudioChunk(0, 0, 32000, 0, 32000))

    def test_generation_limit_redecodes_audio_and_rejects_partial_recovery(self):
        from unittest.mock import Mock
        with wave.open(str(self.audio),'wb') as stream:
            stream.setparams((1,2,SAMPLE_RATE,0,'NONE','not compressed'))
            stream.writeframes(b'\0'*(SAMPLE_RATE*2*8))
        backend=self.backend()
        segments=[dict(text='你好。',start=0,end=4,language='Chinese'),dict(text='再见。',start=4,end=8,language='Chinese')]
        initial=types.SimpleNamespace(text='不停重复',segments=[],generation_tokens=256)
        backend.asr=Mock()
        backend.asr.generate.side_effect=[initial,types.SimpleNamespace(text='你好。再见。',segments=segments,generation_tokens=12),
                                        initial,types.SimpleNamespace(text='你好。',segments=segments[:1],generation_tokens=12)]
        backend.aligner=Mock()
        backend.aligner.generate.side_effect=lambda **kw:[types.SimpleNamespace(text=kw['text'],start_time=.1,end_time=3.)]
        with patch.dict('sys.modules',{'mlx_audio.stt':types.SimpleNamespace(load=None)}),contextlib.redirect_stdout(io.StringIO()):
            result=backend.recognize(self.audio,request_id='recover')
            with self.assertRaisesRegex(RuntimeError,'partial text discarded'):
                backend.recognize(self.audio,request_id='partial')
        self.assertEqual([segment['text'] for segment in result['segments']],['你好。','再见。'])
        self.assertEqual(result['segments'][1]['words'][0]['start'],4.1)
        self.assertNotIn('chunk_duration',backend.asr.generate.call_args_list[0].kwargs)
        self.assertEqual(backend.asr.generate.call_args_list[1].kwargs['chunk_duration'],4.)
        self.assertFalse((self.root/'recognition-partial.json').exists())

    def test_only_failed_decodes_trigger_text_retry(self):
        from transcription import _decode_failed
        def output(text, end=8):
            return types.SimpleNamespace(text=text, segments=[dict(start=0, end=end)], generation_tokens=7)
        self.assertFalse(_decode_failed(output('嗯，对对对，这次 OpenAI AI 升级了。'), 256, 8))
        self.assertTrue(_decode_failed(output('啊对，' * 25), 256, 8))
        self.assertTrue(_decode_failed(output('前一半。', 4), 256, 8))

    def test_complete_alignment_crops_exact_source_punctuation_and_spacing(self):
        raw = {'segments': [dict(start=8, end=11, text='Hello, 世界！', words=[
            dict(start=8, end=9, word='Hello'), dict(start=10.5, end=11, word='世界')])]}
        value = validate_result(raw, 12)
        chunk = AudioChunk(0, 0, 12*SAMPLE_RATE, 0, 10*SAMPLE_RATE)
        retained = owned_segments(value, chunk, 20*SAMPLE_RATE)[0]
        self.assertEqual(retained['text'], 'Hello,')
        self.assertEqual(''.join(word['word'] for word in retained['words']), retained['text'])
        self.assertEqual(retained['words'][0]['text_end'], 6)

    def test_bounded_overlap_and_adjacent_zero_words_keep_exact_audio_and_text(self):
        segment = dict(start=0, end=4, text='先也继续。后文。', words=[
            dict(word='先', start=.05, end=.5), dict(word='也', start=.5, end=.5),
            dict(word='继续。', start=.48, end=1), dict(word='后文。', start=2, end=3)])
        normalize_word_clocks(segment)
        self.assertEqual(''.join(word['word'] for word in segment['words']), segment['text'])
        self.assertEqual([(word['start'], word['end']) for word in segment['words']], [(.05, .5), (.5, 1), (2, 3)])
        self.assertEqual(segment['words'][0]['word'], '先也')
        self.assertEqual(segment['words'][-1], dict(word='后文。', start=2, end=3))

    def test_pipeline_writes_canonical_document_with_original_script_and_no_display_conversion(self):
        backend = self.backend()
        backend.recognize = lambda *args, **kwargs: {'language': 'zh', 'segments': [dict(start=0, end=2, text='我們寫代碼。')]}
        from audio_pipeline import _file_digest
        with patch('transcription.probe', return_value={'available': True}), patch('transcription.QwenBackend', return_value=backend), patch('audio_pipeline.prepare_audio', side_effect=lambda source, directory: source), contextlib.redirect_stdout(io.StringIO()):
            run(dict(profile=self.profile, input=str(self.audio), work=str(self.root / 'work'), sha256=_file_digest(self.audio), title='Authored'))
        document = json.loads((self.root / 'work' / 'result.json').read_text())
        self.assertEqual(document['segments'][0]['text'], '我們寫代碼。')
        self.assertEqual(document['provenance']['backend'], 'qwen-mlx')
        self.assertEqual(document['provenance']['review_status'], 'unreviewed')

    def test_word_aligned_sentences_allow_two_voices_in_one_qwen_audio_extent(self):
        from audio_speakers import label_segments
        original = {'start': 0, 'end': 2, 'text': '你好。再见！', 'words': [
            {'start': 0, 'end': 1, 'word': '你好。'},
            {'start': 1, 'end': 2, 'word': '再见！'}]}
        before = copy.deepcopy(original)
        segments = sentence_segments([original])
        label_segments(segments, [dict(start=0, end=1, speaker='a'), dict(start=1, end=2, speaker='b')],
                       {'a': {'speaker_id': 'speaker-0001'}, 'b': {'speaker_id': 'speaker-0002'}})
        self.assertEqual([s['speaker_id'] for s in segments], ['speaker-0001', 'speaker-0002'])
        self.assertEqual(''.join(s['text'] for s in segments), original['text'])
        self.assertEqual([w for s in segments for w in s['words']], original['words'])
        self.assertEqual(original, before)

    def test_sentence_pause_splitting_preserves_spaces_and_keeps_incomplete_alignment_whole(self):
        original = dict(start=0, end=4, text='Hello world', words=[
            dict(start=0, end=1, word='Hello '), dict(start=3, end=4, word='world')])
        split = sentence_segments([original])
        self.assertEqual([s['text'] for s in split], ['Hello ', 'world'])
        partial = {**original, 'words': original['words'][:1]}
        self.assertEqual(sentence_segments([partial]), [partial])
        untimed = dict(start=0, end=4, text='Keep every untimed word.')
        self.assertEqual(sentence_segments([untimed]), [untimed])

    def test_english_sentence_boundaries_rebase_offsets_without_mutating_raw_alignment(self):
        words = [dict(start=0, end=1, word='Hello. ', text_start=0, text_end=7),
                 dict(start=1, end=2, word='Goodbye.', text_start=7, text_end=15)]
        split = sentence_segments([dict(start=0, end=2, text='Hello. Goodbye.', words=words)])
        self.assertEqual([s['text'] for s in split], ['Hello. ', 'Goodbye.'])
        self.assertEqual(split[1]['words'][0]['text_start'], 0)
        self.assertEqual(split[1]['words'][0]['text_end'], 8)
        self.assertEqual(words[1]['text_start'], 7)

    def test_configured_speakers_are_checked_without_loading_models(self):
        profile = {**self.profile, 'segmentation': str(self.audio), 'embedding': str(self.audio)}
        with patch('importlib.util.find_spec', return_value=object()):
            self.assertTrue(probe(profile)['speakers'])
            self.assertFalse(probe({**profile, 'embedding': ''})['available'])
            self.assertFalse(probe({**profile, 'embedding': str(self.root / 'absent.onnx')})['available'])
        with patch('importlib.util.find_spec', side_effect=lambda name: None if name == 'sherpa_onnx' else object()):
            self.assertEqual(probe(profile)['code'], 'missing_dependencies')

    def test_invalid_verified_speaker_count_is_rejected(self):
        for count in (True, 0, 33, '2'):
            with patch('transcription.probe', return_value={'available': True}), self.assertRaisesRegex(ValueError, 'speaker count'):
                from audio_pipeline import _file_digest
                run(dict(profile=self.profile, input=str(self.audio), work=str(self.root / 'work'), sha256=_file_digest(self.audio), speaker_count=count))

    def test_qwen_speaker_stage_reuses_recognition_and_acoustic_checkpoints(self):
        calls = {'asr': 0, 'voices': 0, 'refinement': 0}
        backend = self.backend()
        def recognize(*args, **kwargs):
            calls['asr'] += 1
            return {'language': 'zh', 'segments': [dict(start=0, end=2, text='你好再见', words=[
                dict(start=0, end=1, word='你好'), dict(start=1, end=2, word='再见')])]}
        backend.recognize = recognize
        class Voices:
            local_only = True
            cache_key = {'fixture': 'two-authored-voices'}
            def analyze(inner, path):
                calls['voices'] += 1
                return {'embedding_model': 'authored', 'turns': [dict(start=0, end=1, speaker='a'),
                    dict(start=1, end=2, speaker='b')], 'evidence': {
                    'a': {'embedding': [1, 0], 'duration': 2},
                    'b': {'embedding': [0, 1], 'duration': 2}}}
            def refine_turns(inner, path, turns):
                calls['refinement'] += 1
                return turns
        from audio_pipeline import _file_digest
        request = dict(profile={**self.profile, 'segmentation': str(self.audio), 'embedding': str(self.audio)},
                       input=str(self.audio), work=str(self.root / 'work'), sha256=_file_digest(self.audio))
        with patch('transcription.probe', return_value={'available': True}), \
                patch('transcription.QwenBackend', return_value=backend), \
                patch.dict('sys.modules', {'sherpa_onnx': types.ModuleType('sherpa_onnx')}), \
                patch('audio_speakers.SherpaSpeakerBackend', return_value=Voices()), \
                contextlib.redirect_stdout(io.StringIO()):
            run(request)
            run(request)
        document = json.loads((self.root / 'work' / 'result.json').read_text())
        self.assertEqual(calls, {'asr': 1, 'voices': 1, 'refinement': 1})
        self.assertEqual([s['speaker_id'] for s in document['segments']], ['speaker-0001', 'speaker-0002'])
        self.assertEqual([s['text'] for s in document['segments']], ['你好', '再见'])
        self.assertEqual(document['provenance']['speaker_method'], 'recording-acoustic-v1')
