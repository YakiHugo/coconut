import copy
import unittest

from transcript_cleanup import decisions


def document(*texts):
    return {'segments': [dict(id=str(i), start=i * 3, end=i * 3 + 3,
                             speaker='a', text=text) for i, text in enumerate(texts)]}


def cleaned(doc):
    plan = decisions(doc)
    result = []
    for cue in doc['segments']:
        raw = cue['text'].encode('utf-16-le')
        spans = [e for e in plan['decisions'] if e['cue_id'] == cue['id']]
        for e in reversed(spans):
            raw = raw[:e['from'] * 2] + raw[e['to'] * 2:]
        result.append(raw.decode('utf-16-le'))
    return result


class CleanupPolicyTests(unittest.TestCase):
    def test_local_fillers_and_restarts_preserve_source_and_clocks(self):
        doc = document('我我我觉得，呃，这个问题值得认真讨论。')
        before = copy.deepcopy(doc)
        self.assertEqual(cleaned(doc), ['我觉得，这个问题值得认真讨论。'])
        self.assertEqual(doc, before)

    def test_responses_negation_emphasis_and_referents_survive(self):
        texts = ['嗯。', '啊？', '不不不，这件事我完全不同意。',
                 '非常非常重要，大家想一想。', '那个城市就是我们的目的地，然后再去北京。',
                 '他说的“嗯”和“呃”这两个词需要区分。']
        self.assertEqual(cleaned(document(*texts)), texts)

    def test_initial_acknowledgement_is_preserved_but_following_pause_is_not(self):
        self.assertEqual(cleaned(document('嗯呃，然后我们开始今天的讨论。')), ['嗯，然后我们开始今天的讨论。'])

    def test_unicode_offsets_and_adjacent_punctuation(self):
        self.assertEqual(cleaned(document('🥥我觉得，嗯，值得试一试，呃。')), ['🥥我觉得，值得试一试。'])

    def test_unknown_short_filler_is_not_erased_using_neighbour_identity(self):
        doc = document('这件事情需要认真讨论。', '嗯，', '我们继续讨论下一个问题。')
        doc['segments'][1]['speaker'] = None
        self.assertEqual(cleaned(doc)[1], '嗯，')

    def test_backchannel_compounds_grammatical_particles_and_emphasis_survive(self):
        texts = ['这个产品，嗯哼，团队也不错，嗯哼，但是还需要观察。',
                 '在即便认为自己可能是对的，对方是错的的时候。',
                 '我很很不自信，但以后可能更更厉害。',
                 '这个人说话和和气气，处理是是非非也的的确确很谨慎。']
        self.assertEqual(cleaned(document(*texts)), texts)


if __name__ == '__main__':
    unittest.main()
