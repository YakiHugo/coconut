"""Do not turn short or simultaneous competing speech into one person's words."""
import copy
import unittest
from audio_speakers import label_segments, fuse_speakers, _global_clusters
from transcript_readability import assign_speakers


class SpeakerBoundaryRegression(unittest.TestCase):
    decisions = {'a': {'speaker_id': 'speaker-0001'}, 'b': {'speaker_id': 'speaker-0002'}}

    def test_short_reply_is_not_deleted_before_whole_cue_vote(self):
        cue = dict(id='one', start=0, end=5, text='这是比较长的解释嗯继续说', words=[
            dict(word='这是比较长的解释', start=0, end=4),
            dict(word='嗯', start=4, end=4.3), dict(word='继续说', start=4.3, end=5)])
        before = copy.deepcopy(cue)
        turns = [dict(start=0, end=4, speaker='a'), dict(start=4, end=4.3, speaker='b'),
                 dict(start=4.3, end=5, speaker='a')]
        result = fuse_speakers([cue], [{**turn,'speaker_id':self.decisions.get(turn['speaker'],{}).get('speaker_id')} for turn in turns], split=False)
        self.assertIsNone(result[0]['speaker_id'])
        for key in ('text', 'words', 'start', 'end', 'id'):
            self.assertEqual(result[0][key], before[key])

    def test_minor_competing_turn_blocks_coarse_majority(self):
        turns = [dict(start=0, end=10, speaker='a'), dict(start=4, end=4.3, speaker='b')]
        cue = dict(start=0, end=10)
        label_segments([cue], turns, self.decisions)
        self.assertIsNone(cue['speaker_id'])
        plain = dict(start=0, end=10, text='原话')
        self.assertEqual(assign_speakers([plain], turns), 0)
        self.assertNotIn('speaker', plain)

    def test_unknown_word_is_not_outvoted_by_long_known_text(self):
        cue = dict(id='one', start=0, end=5, text='这是比较长的解释嗯', words=[
            dict(word='这是比较长的解释', start=0, end=4), dict(word='嗯', start=4, end=5)])
        turns = [dict(start=0, end=4, speaker='a'), dict(start=4, end=5, speaker='unknown')]
        result = fuse_speakers([cue], [{**turn,'speaker_id':self.decisions.get(turn['speaker'],{}).get('speaker_id')} for turn in turns], split=False)
        self.assertIsNone(result[0]['speaker_id'])

    def test_punctuation_cannot_invent_a_voice_change(self):
        cue = dict(id='one', start=0, end=3, text='你好。', words=[
            dict(word='你好', start=0, end=2), dict(word='。', start=2, end=3)])
        turns = [dict(start=0, end=2, speaker='a'), dict(start=2, end=3, speaker='b')]
        result = fuse_speakers([cue], [{**turn,'speaker_id':self.decisions.get(turn['speaker'],{}).get('speaker_id')} for turn in turns])
        self.assertEqual(len(result), 1)
        self.assertIsNone(result[0]['speaker_id'])
        self.assertEqual(result[0]['text'], '你好。')

    def test_simultaneous_local_lanes_cannot_share_recording_identity(self):
        for expected in (None, 1):
            voices = _global_clusters([(5., [1.,0.]),(5., [1.,0.])], {0:{1},1:{0}}, expected, lambda:None)
            self.assertFalse(voices.get(0) and voices.get(0)==voices.get(1))

if __name__ == '__main__':
    unittest.main()
