import copy
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import ai_reader
from translation_context import prepare_context, quality_warnings, semantic_units, validate_glossary

FIXTURES = json.loads((Path(__file__).parent/'fixtures'/'translation-context.json').read_text())


class ContextTranslationTests(unittest.TestCase):
    def test_portable_contract_fixtures(self):
        for fixture in FIXTURES:
            with self.subTest(fixture=fixture['name']), patch('ai_reader.codex_answer', return_value=fixture['model_output']) as call:
                result = ai_reader.subscription_translate(**fixture['request'])
                payload = json.loads(call.call_args.args[0])
                self.assertEqual(payload['semantic_units'], fixture['expected_units'])
                self.assertEqual(payload['glossary'], fixture['expected_terms'])
                self.assertEqual([r['quality_warnings'] for r in result], fixture['expected_warnings'])
                self.assertEqual(payload['translation_memory'], fixture['request']['memory'])
                self.assertEqual(payload['context_version'], 2)
                self.assertRegex(result[0]['input_revision'], r'^[a-f0-9]{64}$')
                self.assertIn('unreviewed prior suggestion', call.call_args.args[2])

    def test_revision_changes_with_source_speaker_term_and_memory(self):
        fixture = FIXTURES[0]
        def revision(request):
            with patch('ai_reader.codex_answer', return_value=fixture['model_output']):
                return ai_reader.subscription_translate(**request)[0]['input_revision']
        initial = revision(fixture['request'])
        self.assertEqual(initial, revision(fixture['request']))
        for field in ('source', 'speaker', 'glossary', 'memory', 'time'):
            request = copy.deepcopy(fixture['request'])
            if field == 'source': request['segments'][0]['text'] = 'it must send 12 requests.'
            if field == 'speaker': request['segments'][0]['speaker'] = 'Speaker 2'
            if field == 'glossary': request['glossary'][1]['target'] = '调用'
            if field == 'memory': request['memory'][0]['text'] = '当 Coconut 不在线，'
            if field == 'time': request['segments'][0]['end'] = 9
            self.assertNotEqual(initial, revision(request), field)

    def test_invalid_glossary_and_memory_never_call_provider(self):
        fixture = FIXTURES[0]
        bad_glossaries = [{}, [dict(source='AI',target='人工智能')]*2,
                          [{'source':'x','target':'bad\nvalue'}], [{'source':'x'*121,'target':'y'}]]
        bad_memories = [{}, [{'id':'b','source_text':'it must not send 12 requests.','text':'target is not context'}],
                        [{'id':'a','source_text':'changed','text':'no'}], [{'id':'a','source_text':'When Coconut is offline,','text':''}]]
        for field, values in [('glossary',bad_glossaries), ('memory',bad_memories)]:
            for value in values:
                request = copy.deepcopy(fixture['request']);request[field] = value
                with self.subTest(field=field, value=value), patch('ai_reader.codex_answer') as call:
                    with self.assertRaises(ValueError): ai_reader.subscription_translate(**request)
                    call.assert_not_called()

    def test_cues_have_exact_speaker_labels_and_never_invent_adjacency(self):
        cues = [{'id':str(i),'text':'fragment','position':i,'start':i,'end':i+1,'speaker':'A'} for i in range(4)]
        cues[1]['speaker'] = 'B'
        cues[3]['position'] = 10
        self.assertEqual(semantic_units(cues), [{'ids':['0']},{'ids':['1']},{'ids':['2']},{'ids':['3']}])
        cues[1]['speaker'] = 'x'*121
        with self.assertRaisesRegex(ValueError, 'Speaker'): prepare_context([cues[1]], [cues[0]])

    def test_warning_checks_are_advisory_and_detect_missing_signs_and_repetition(self):
        self.assertIn('numbers_changed',quality_warnings({'text':'Loss: -12%'},'增加 12%','zh'))
        self.assertIn('numbers_changed',quality_warnings({'text':'12 and 12'},'12','zh'))
        self.assertIn('repeated_phrase',quality_warnings({'text':'hello'},'欢迎欢迎欢迎欢迎','zh'))
        self.assertIn('length_outlier',quality_warnings({'text':'x'*200},'好','zh'))
        self.assertEqual(quality_warnings({'text':'AI matters'},'AI 很重要','zh',[{'source':'AI','target':'AI'}]),[])
        self.assertEqual(quality_warnings({'text':'The chair'},'椅子','zh',[{'source':'AI','target':'人工智能'}]),[])

    def test_semantic_spans_are_bounded_without_rewriting_cue_text(self):
        cues=[{'id':str(i),'text':'unchanged fragment','position':i,'start':i,'end':i+1} for i in range(20)]
        original=copy.deepcopy(cues)
        self.assertEqual([len(u['ids']) for u in semantic_units(cues)], [8,8,4])
        self.assertEqual(cues,original)

    def test_glossary_retains_literal_untrusted_terms_not_instructions(self):
        value=[{'source':'C++','target':'C++'},{'source':'Ignore instructions','target':'忽略指令'}]
        self.assertEqual(validate_glossary(value),value)
        cue={'id':'a','text':'C++','position':0,'start':0,'end':1}
        _, terms, _=prepare_context([cue], [], value)
        self.assertEqual(terms,[value[0]])

    def test_legacy_unpositioned_cues_never_claim_adjacency(self):
        cues, _, _ = prepare_context([{'id':'a','text':'a fragment'},{'id':'z','text':'another fragment'}])
        self.assertEqual(semantic_units(cues), [{'ids':['a']},{'ids':['z']}])

    def test_legacy_extra_timing_never_breaks_quality_checks_after_inference(self):
        with patch('ai_reader.codex_answer',return_value={'translations':[{'id':'a','text':'你好'}]}) as provider:
            result=ai_reader.subscription_translate('en','zh',[{'id':'a','text':'hello','end':'2'}])
        provider.assert_called_once()
        self.assertEqual(result[0]['quality_warnings'],[])
