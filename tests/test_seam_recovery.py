"""Small timing excerpt observed in local replay; not an ASR accuracy benchmark."""
import copy
from dataclasses import replace
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from audio_pipeline import AudioChunk, SAMPLE_RATE, validate_result, owned_segments, stitch_segments, run_audio_pipeline, CallableBackend
from seam_recovery import recover_seam
from transcript import make_document
from tests.test_audio_pipeline import wav


def fixture():
    # Global times rebased by 6270 s from the observed 6274.048 s seam.
    # Both recognizers contain 人。 but independently align it across the core.
    left = AudioChunk(0, 0, 9*16000, 0, 64768)
    right = AudioChunk(1, 0, 10*16000, 64768, 10*16000)
    def result(times):
        words = [dict(word=t, start=a, end=b) for t, a, b in times]
        return validate_result({'segments':[dict(start=words[0]['start'], end=words[-1]['end'],
            text=''.join(w['word'] for w in words), words=words)]}, 10)
    a=result([('成',3.048,3.208),('为',3.208,3.208),('合',3.208,3.208),('伙',3.368,3.696),('人。',4.024,4.352),('嗯',4.728,4.888)])
    b=result([('成',3.048,3.208),('为',3.208,3.288),('合',3.288,3.368),('伙',3.368,3.528),('人。',3.528,3.608),('嗯',4.728,4.888)])
    return a,left,b,right


class SeamTests(unittest.TestCase):
    def test_observed_double_crop_recovers_exactly_one_original_word(self):
        a,left,b,right=fixture();before=copy.deepcopy((a,b))
        owned=owned_segments(a,left,160000)+owned_segments(b,right,160000)
        self.assertEqual(''.join(s['text'] for s in stitch_segments(owned)), '成为合伙嗯')
        recovered,trace=recover_seam(a,left,b,right)
        self.assertEqual([s['text'] for s in recovered],['人。'])
        self.assertEqual((recovered[0]['start'],recovered[0]['end']),(4.024,4.352))
        final=sorted(stitch_segments(owned)+recovered,key=lambda s:s['start'])
        self.assertEqual(''.join(s['text'] for s in final),'成为合伙人。嗯')
        self.assertTrue(all(x['end']<=y['start'] for x,y in zip(final,final[1:])))
        self.assertIsNone(recovered[0]['speaker_id'])
        self.assertEqual([x['owned'] for x in trace[0]['sources']],[False,False])
        self.assertEqual((a,b),before)
        doc=make_document({'segments':final,'seam_recovery':trace},'Replay','')
        self.assertEqual(doc['seam_recovery'],trace)

    def test_short_response_alone_is_not_a_consensus_anchor(self):
        a,left,b,right=fixture()
        for result in (a,b):
            result['segments'][0]['words']=result['segments'][0]['words'][4:5]
        self.assertEqual(recover_seam(a,left,b,right),([],[]))

    def test_one_owned_copy_or_one_sided_word_is_not_added(self):
        a,left,b,right=fixture();b['segments'][0]['words'][4].update(start=4.06,end=4.15)
        self.assertEqual(recover_seam(a,left,b,right),([],[]))
        a,left,b,right=fixture();b['segments'][0]['words'][4]['word']='员。'
        self.assertEqual(recover_seam(a,left,b,right),([],[]))

    def test_repeated_tokens_and_homophones_abstain(self):
        a,left,b,right=fixture()
        for result in (a,b):
            result['segments'][0]['words'].append(dict(word='人',start=7,end=7.1))
        self.assertEqual(recover_seam(a,left,b,right),([],[]))
        a,left,b,right=fixture()
        for result in (a,b):
            for word in result['segments'][0]['words']:word['word']='嗯'
        self.assertEqual(recover_seam(a,left,b,right),([],[]))

    def test_unaligned_context_can_already_own_the_word_so_abstains(self):
        a,left,b,right=fixture()
        b['segments'].append({'text':'人', 'start':4.1, 'end':4.3})
        self.assertEqual(recover_seam(a,left,b,right),([],[]))

    def test_unrelated_drift_splits_anchor_without_poisoning_local_consensus(self):
        a,left,b,right=fixture()
        for result,end in ((a,6.0),(b,7.0)):
            result['segments'][0]['words'].append(dict(word='后来',start=end,end=end+.2))
        self.assertEqual([cue['text'] for cue in recover_seam(a,left,b,right)[0]],['人。'])

    def test_cross_segment_anchor_and_repeated_phrase_abstain(self):
        a,left,b,right=fixture()
        for result in (a,b):
            words=result['segments'][0]['words']
            result['segments']=[{'words':words[:3]},{'words':words[3:]}]
        self.assertEqual(recover_seam(a,left,b,right),([],[]))
        a,left,b,right=fixture()
        for result in (a,b):
            result['segments'][0]['words']+=copy.deepcopy(result['segments'][0]['words'])
        self.assertEqual(recover_seam(a,left,b,right),([],[]))

    def test_unbounded_drift_disconnected_cores_and_no_overlap_abstain(self):
        a,left,b,right=fixture();a['segments'][0]['words'][4].update(start=5,end=5.4)
        self.assertEqual(recover_seam(a,left,b,right),([],[]))
        a,left,b,right=fixture();right=replace(right,core_start_frame=right.core_start_frame+1)
        self.assertEqual(recover_seam(a,left,b,right),([],[]))

    def test_clock_choice_must_not_overlap_retained_neighbors(self):
        a,left,b,right=fixture()
        for result in (a,b):result['segments'][0]['words'][5].update(start=4.15,end=4.3)
        self.assertEqual(recover_seam(a,left,b,right),([],[]))

    def test_later_acoustic_pass_cannot_inherit_a_speaker_from_uncertain_clock(self):
        from audio_speakers import fuse_speakers
        a,left,b,right=fixture();cues,_=recover_seam(a,left,b,right)
        turns=[{'start':3,'end':5,'speaker':'a'}];decisions={'a':{'speaker_id':'speaker-1','status':'automatic_unreviewed'}}
        for split in (False,True):
            result=fuse_speakers(copy.deepcopy(cues),[{**turn,'speaker_id':decisions.get(turn['speaker'],{}).get('speaker_id')} for turn in turns],split=split)
            self.assertEqual(len(result),1)
            self.assertIsNone(result[0]['speaker_id'])
            self.assertEqual(result[0]['speaker_status'],'seam_recovered_unknown')

    def test_pipeline_replay_and_cache_resume_preserve_unknown_speaker_and_trace(self):
        a,left,b,right=fixture()
        with tempfile.TemporaryDirectory() as td:
            source=Path(td)/'input.wav';wav(source,10);work=Path(td)/'work'
            calls=[]
            def recognize(path):
                value=(a,b)[len(calls)];calls.append(path);return copy.deepcopy(value)
            backend=CallableBackend({'fixture':'seam'},recognize)
            with patch('audio_pipeline.plan_chunks',return_value=[left,right]):
                first=run_audio_pipeline(source,backend,work_dir=work)
                caches={p.name:p.read_bytes() for p in work.glob('asr-*.json')}
                second=run_audio_pipeline(source,backend,work_dir=work)
            self.assertEqual(len(calls),2)
            self.assertEqual(first,second)
            self.assertEqual(caches,{p.name:p.read_bytes() for p in work.glob('asr-*.json')})
            self.assertEqual(''.join(s['text'] for s in first['segments']),'成为合伙人。嗯')
            self.assertEqual(len(first['seam_recovery']),1)
            self.assertEqual(json.loads((work/'seam-00000-00001.json').read_text())['decisions'],first['seam_recovery'])
