import copy
import unittest

from audio_speakers import _global_clusters, fuse_speakers


class RecordingSpeakerTest(unittest.TestCase):
    def test_late_and_overlapping_voices_keep_distinct_identity(self):
        samples = [(4., [1.,0.]), (4., [1.,0.]), (4., [1.,0.]), (4., [0.,1.]),
                   (.7, [0.,1.]), (.4, [.707,.707])]
        result = _global_clusters(samples, {1:{2},2:{1}}, None, lambda:None)
        self.assertEqual(result[0], result[1])
        self.assertNotEqual(result[1], result[2])
        self.assertEqual(result[3], result[4])
        self.assertNotIn(5, result)

    def test_only_safe_transition_splits_and_preserves_all_text(self):
        turns = [dict(start=0,end=1,speaker_id='speaker-0001'),
                 dict(start=1,end=2,speaker_id='speaker-0002')]
        cue = dict(id='q',start=0,end=2,text='午餐，到了',words=[
            dict(word='午餐，',start=0,end=1),dict(word='到了',start=1,end=2)])
        before = copy.deepcopy(cue)
        result = fuse_speakers([cue],turns)
        self.assertEqual([c['speaker_id'] for c in result], ['speaker-0001','speaker-0002'])
        self.assertEqual(''.join(c['text'] for c in result),cue['text'])
        self.assertEqual(cue,before)
        cue['text'] = '午餐到了'
        cue['words'][0]['word'] = '午餐'
        self.assertIsNone(fuse_speakers([cue],turns)[0]['speaker_id'])

    def test_one_window_cannot_establish_an_extra_person_in_a_long_recording(self):
        samples = [(7., [1., 0.]) for _ in range(5)] + [(8., [0., 1.])]
        labels = _global_clusters(samples, {}, None, lambda: None)
        self.assertEqual(len(set(labels.values())), 1)
        self.assertNotIn(5, labels)

    def test_english_space_keeps_a_real_pause_available_for_a_speaker_change(self):
        turns = [dict(start=0, end=.8, speaker_id='speaker-0001'),
                 dict(start=1.1, end=2, speaker_id='speaker-0002')]
        words = [dict(word='Yes ', start=0, end=.8), dict(word='Understood', start=1.1, end=2)]
        cue = dict(id='q', start=0, end=2, text='Yes Understood', words=words)
        result = fuse_speakers([cue], turns)
        self.assertEqual([c['speaker_id'] for c in result], ['speaker-0001', 'speaker-0002'])
        self.assertEqual([w for c in result for w in c['words']], words)

    def test_ascii_quote_can_close_a_timed_sentence(self):
        from transcription import sentence_segments

        words = [dict(word='"Yes." ', start=0, end=.8), dict(word='Understood.', start=1.1, end=2)]
        cue = dict(start=0, end=2, text='"Yes." Understood.', words=words)
        self.assertEqual([c['text'] for c in sentence_segments([cue])], ['"Yes." ', 'Understood.'])

    def test_activity_smoothing_preserves_observed_overlap_and_never_invents_it(self):
        from audio_speakers import _stable_activity

        activity = [(0, 20, (0,)), (20, 29, (1,)), (29, 40, (0,)),
                    (45, 65, (0,)), (65, 85, (0, 1)), (85, 105, (1,))]
        result = list(_stable_activity(activity, 0, 105, 100))
        self.assertEqual([span for span in result if len(span[2]) == 2], [(65, 85, (0, 1))])
        self.assertIn((29, 65, (0,)), result)
