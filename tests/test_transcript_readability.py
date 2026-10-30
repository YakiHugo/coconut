import copy
import unittest
from unittest.mock import Mock, patch
from transcript_readability import project_punctuation, punctuate, assign_speakers, stabilize_speaker_labels, enhance_from_environment


def cue(text, start=0, speaker=None):
    return {'id': str(start), 'start': start, 'end': start + 2, 'text': text, 'speaker': speaker}


class ReadabilityTests(unittest.TestCase):
    def test_manual_corrections_are_isolated_from_automatic_punctuation(self):
        cues = [cue('第一句'), cue('已人工校正的原话', 2), cue('第三句', 4)]
        cues[1]['original_text'] = '识别错误的旧稿'
        engine = Mock()
        engine.add_punctuation.side_effect = lambda text: text + '。'
        self.assertEqual(punctuate(cues, engine), (2, 0))
        self.assertEqual(cues[1]['text'], '已人工校正的原话')
        self.assertEqual([call.args[0] for call in engine.add_punctuation.call_args_list], ['第一句', '第三句'])

    def test_punctuation_maps_to_original_cues_without_moving_timing_or_words(self):
        cues = [cue('Hello 大家好 我是小俊'), cue('今天聊 Dyna Robotics', 2)]
        original = copy.deepcopy(cues)
        engine = Mock()
        engine.add_punctuation.return_value = 'Hello，大家好，我是小俊。今天聊 Dyna Robotics。'
        changed, rejected = punctuate(cues, engine)
        self.assertEqual((changed, rejected), (2, 0))
        self.assertEqual(cues[0]['text'], 'Hello，大家好，我是小俊。')
        self.assertEqual(cues[1]['text'], '今天聊 Dyna Robotics。')
        for old, new in zip(original, cues):
            self.assertEqual(new['original_text'], old['text'])
            self.assertEqual([(new[k], old[k]) for k in ['id', 'start', 'end']], [(old[k], old[k]) for k in ['id', 'start', 'end']])

    def test_model_rewrite_deletion_and_reordering_are_rejected_atomically(self):
        for text in ['你好，我们聊机器人。', '你好，机器人。', '机器人，你好。']:
            with self.subTest(text=text):
                cues = [cue('你好今天聊机器人')]
                before = copy.deepcopy(cues)
                engine = Mock()
                engine.add_punctuation.return_value = text
                self.assertEqual(punctuate(cues, engine), (0, 1))
                self.assertEqual(cues, before)

    def test_existing_punctuation_and_original_history_are_preserved(self):
        engine = Mock()
        cues = [cue('这是已校对的句子。')]
        self.assertEqual(punctuate(cues, engine), (0, 0))
        engine.add_punctuation.assert_not_called()
        self.assertEqual(project_punctuation([cue('v1.2 版本')], 'v1.2 版本。'), ['v1.2 版本。'])
        with self.assertRaises(ValueError):
            project_punctuation([cue('Dyna Robotics')], 'Dyna robots。')
        self.assertEqual(project_punctuation([cue('你好,我叫Linden')], '你好,，我叫Linden。'), ['你好,我叫Linden。'])

    def test_truncated_mixed_script_blocks_narrow_context_without_losing_words(self):
        cues = [cue('第一句', 0), cue('第二句', 2)]
        engine = Mock()
        engine.add_punctuation.side_effect = ['第一句。', '第一句。', '第二句。']
        self.assertEqual(punctuate(cues, engine), (2, 0))
        self.assertEqual([c['text'] for c in cues], ['第一句。', '第二句。'])

    def test_speaker_changes_and_source_gaps_are_separate_punctuation_contexts(self):
        cues = [cue('第一句', 0, 'A'), cue('第二句', 2, 'B'), cue('第三句', 20, 'B')]
        engine = Mock()
        engine.add_punctuation.side_effect = lambda text: text + '。'
        self.assertEqual(punctuate(cues, engine), (3, 0))
        self.assertEqual(engine.add_punctuation.call_count, 3)

    def test_acoustic_majority_labels_only_confident_cues_and_keeps_manual_names(self):
        cues = [cue('a'), cue('b', 2), cue('c', 4), cue('d', 6, '手工姓名')]
        turns = [{'start': 0, 'end': 2.6, 'speaker': 8}, {'start': 2.6, 'end': 5, 'speaker': 9},
                 {'start': 5, 'end': 6, 'speaker': 8}, {'start': 6, 'end': 8, 'speaker': 8}]
        self.assertEqual(assign_speakers(cues, turns), 2)
        self.assertEqual([c['speaker'] for c in cues], ['说话人 1', '说话人 2', None, '手工姓名'])
        self.assertNotIn('original_speaker', cues[0])

    def test_unconfigured_pipeline_does_not_import_runtime_or_mutate_source(self):
        source = {'segments': [cue('原稿')], 'provenance': {'kind': 'local_asr'}}
        before = copy.deepcopy(source)
        with patch.dict('os.environ', {}, clear=True), patch('builtins.__import__', wraps=__import__) as imported:
            result = enhance_from_environment(source)
        self.assertEqual(source, before)
        self.assertEqual(result, before)
        self.assertIsNot(source, result)
        self.assertFalse(any(c.args[0] == 'sherpa_onnx' for c in imported.call_args_list))

    def test_fragmented_clustering_does_not_invent_a_cast_of_speakers(self):
        cues = [cue('保留原稿', i*2, f'说话人 {i}') for i in range(20)]
        self.assertEqual(stabilize_speaker_labels(cues, {c['id'] for c in cues}), (0, True))
        self.assertTrue(all(c['speaker'] is None for c in cues))

    def test_tiny_clusters_become_unknown_instead_of_being_guessed_into_a_person(self):
        cues = [cue('主体声音', 0, 'raw-3'), cue('噪声', 100, 'raw-4'), cue('手工', 102, '主持人')]
        cues[0]['end'] = 100
        count, fragmented = stabilize_speaker_labels(cues, {'0', '100'})
        self.assertEqual((count, fragmented), (1, False))
        self.assertEqual([c['speaker'] for c in cues], ['说话人 1', None, '主持人'])


if __name__ == '__main__':
    unittest.main()
