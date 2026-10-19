import json
import unittest
from unittest.mock import patch

import ai_reader


class ExactSelectionTests(unittest.TestCase):
    def selection(self, text='chosen'):
        return {'version': 1, 'cue_ids': ['a'], 'from': 0, 'to': len(text.encode('utf-16-le')) // 2,
                'separators': [], 'text': text}

    def ask(self, selection, segments=None, question='Translate the exact selection'):
        return ai_reader.ask(question, 'zh', segments or [{'id': 'a', 'text': selection['text']}],
                             'codex', exact_selection=selection)

    def test_4500_character_selection_is_separate_from_short_question(self):
        selection = self.selection('文' * 4500)
        with patch('ai_reader.codex_answer', return_value={'answer': '译文', 'citations': ['a']}) as provider:
            self.ask(selection)
        payload = json.loads(provider.call_args.args[0])
        self.assertEqual(payload['question'], 'Translate the exact selection')
        self.assertEqual(payload['exact_selection'], selection)
        self.assertIn('exact_selection', ai_reader.SYSTEM)

    def test_utf16_offsets_and_cross_cue_separators_are_exact(self):
        selection = {'version': 1, 'cue_ids': ['a', 'b'], 'from': 1, 'to': 8,
                     'separators': ['\r\n'], 'text': '😀x\r\nyz'}
        with patch('ai_reader.codex_answer', return_value={'answer': 'ok', 'citations': ['a', 'b']}) as provider:
            self.ask(selection, [{'id': 'a', 'text': 'A😀x'}, {'id': 'b', 'text': 'yzB'}])
        self.assertEqual(json.loads(provider.call_args.args[0])['exact_selection'], selection)

    def test_malformed_selection_rejected_before_model(self):
        valid = self.selection()
        bad = [None, [], {}, {**valid, 'unknown': 1}, {**valid, 'version': True},
               {**valid, 'version': 2}, {**valid, 'from': True}, {**valid, 'to': 1.5},
               {**valid, 'from': -1}, {**valid, 'to': 7}, {**valid, 'to': 0},
               {**valid, 'cue_ids': ['b']}, {**valid, 'cue_ids': ['a', 'a']},
               {**valid, 'separators': ['']}, {**valid, 'text': 'forged'},
               {k: v for k, v in valid.items() if k != 'version'}]
        with patch('ai_reader.codex_answer') as provider:
            for selection in bad:
                with self.subTest(selection=selection), self.assertRaises(ValueError):
                    self.ask(selection, [{'id': 'a', 'text': 'chosen'}])
            provider.assert_not_called()

    def test_split_surrogate_and_invalid_unicode_are_rejected(self):
        with patch('ai_reader.codex_answer') as provider:
            for selection in [dict(self.selection('😀'), to=1, text='\ud83d'),
                              dict(self.selection('😀'), **{'from': 1, 'text': '\ude00'}),
                              dict(self.selection('x'), text='\ud800')]:
                with self.subTest(selection=selection), self.assertRaises(ValueError):
                    self.ask(selection, [{'id': 'a', 'text': '😀'}])
            provider.assert_not_called()

    def test_segment_order_separator_and_segment_limit(self):
        segments = [{'id': 'a', 'text': 'a'}, {'id': 'b', 'text': 'b'}]
        selection = {'version': 1, 'cue_ids': ['a', 'b'], 'from': 0, 'to': 3,
                     'separators': [' '], 'text': 'a b'}
        with patch('ai_reader.codex_answer') as provider:
            for bad in [{**selection, 'cue_ids': ['b', 'a']},
                        *[{**selection, 'separators': [separator]} for separator in ['\t', 'abc', '   ', 1]]]:
                with self.subTest(selection=bad), self.assertRaises(ValueError): self.ask(bad, segments)
            segments = [{'id': str(i), 'text': 'a'} for i in range(49)]
            selection.update(cue_ids=[s['id'] for s in segments], separators=[''] * 48, to=49, text='a' * 49)
            with self.assertRaises(ValueError): self.ask(selection, segments)
            provider.assert_not_called()

    def test_exact_context_rejects_blank_cues_and_malformed_unicode_ids(self):
        with patch('ai_reader.codex_answer') as provider:
            for blank in ('', ' ', '\r\n', '\t'):
                selection = {'version': 1, 'cue_ids': ['a', 'b'], 'from': 0, 'to': 1,
                             'separators': [' '], 'text': 'x'}
                with self.subTest(blank=blank), self.assertRaises(ValueError):
                    self.ask(selection, [{'id': 'a', 'text': 'x'}, {'id': 'b', 'text': blank}])
            for identifier in ('\ud800', 'a\udfff'):
                selection = {**self.selection('x'), 'cue_ids': [identifier]}
                with self.subTest(identifier=identifier), self.assertRaises(ValueError):
                    self.ask(selection, [{'id': identifier, 'text': 'x'}])
            provider.assert_not_called()
        with patch('ai_reader.codex_answer', return_value={'answer': 'ok', 'citations': ['a']}):
            ai_reader.ask('Q', 'en', [{'id': 'a', 'text': ' '}], 'codex')

    def test_selection_question_and_combined_input_budgets(self):
        with patch('ai_reader.codex_answer') as provider:
            with self.assertRaises(ValueError): self.ask(self.selection('😀' * 50001))
            with self.assertRaises(ValueError): self.ask(self.selection(), question='😀' * 2001)
            with self.assertRaises(ValueError): self.ask(self.selection(), question='Q' + ' ' * 4000)
            # The individually legal selection doubles up in the quoted context.
            with self.assertRaises(ValueError):
                self.ask(self.selection('x' * 100000), [{'id': 'a', 'text': 'x' * 151000}])
            provider.assert_not_called()

    def test_maximum_selection_and_payload_boundary_are_inclusive(self):
        selection = self.selection('😀' * 50000)
        with patch('ai_reader.codex_answer', return_value={'answer': 'ok', 'citations': ['a']}) as provider:
            self.ask(selection)
            self.assertEqual(json.loads(provider.call_args.args[0])['exact_selection'], selection)
            selection = self.selection('x')
            base = {'question': 'Q', 'answer_language': 'zh', 'transcript': [{'id': 'a', 'text': 'x'}],
                    'exact_selection': selection}
            size = len(json.dumps(base, ensure_ascii=False, separators=(',', ':')).encode('utf-16-le')) // 2
            segments = [{'id': 'a', 'text': 'x' * (250001 - size)}]
            self.ask(selection, segments, question='Q')
            self.assertEqual(ai_reader.utf16_length(provider.call_args.args[0]), 250000)
            provider.reset_mock()
            segments[0]['text'] += 'x'
            with self.assertRaises(ValueError): self.ask(selection, segments, question='Q')
            provider.assert_not_called()

    def test_absent_selection_preserves_legacy_and_failure_releases_lock(self):
        with patch('ai_reader.codex_answer', side_effect=ValueError('cancelled')):
            with self.assertRaisesRegex(ValueError, 'cancelled'): self.ask(self.selection())
        with patch('ai_reader.codex_answer', return_value={'answer': 'ok', 'citations': ['a']}) as provider:
            ai_reader.ask('Q', 'en', [{'id': 'a', 'text': 'source'}], 'codex')
        self.assertNotIn('exact_selection', json.loads(provider.call_args.args[0]))


if __name__ == '__main__': unittest.main()
