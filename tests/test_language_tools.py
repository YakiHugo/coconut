import io,json,os,subprocess,tempfile,types,unittest,zipfile
from pathlib import Path
from unittest.mock import patch
from language_tools import LocalTranslator,validate_segments
import ai_reader

class LanguageTests(unittest.TestCase):
    def test_limits_and_duplicate_ids(self):
        for value in [[],{},[{'id':'a','text':''}],[{'id':'a','text':'x'}]*2,[{'id':'a','text':'x'*4001}]]:
            with self.assertRaises(ValueError):validate_segments(value)
        self.assertEqual(validate_segments([{'id':'a','text':'hello'}])[0]['id'],'a')

    def test_missing_model_never_downloads_without_opt_in(self):
        with tempfile.TemporaryDirectory() as td, patch('language_tools.urlopen') as network:
            t=LocalTranslator(td)
            with self.assertRaisesRegex(ValueError,'allow the first model'):t.translate('en','zh',[{'id':'a','text':'hello'}])
            network.assert_not_called()

    def test_translation_is_bounded_and_preserves_ids(self):
        with tempfile.TemporaryDirectory() as td:
            directory=Path(td)/'en-zh';directory.mkdir();(directory/'metadata.json').write_text('{}')
            tokenizer=types.SimpleNamespace(encode=lambda text,out_type:[text],decode=lambda tokens:tokens[0])
            model=types.SimpleNamespace(translate_batch=lambda inputs,**kw:[types.SimpleNamespace(hypotheses=[['译文']]) for _ in inputs])
            translator=LocalTranslator(td);translator.loaded=(('en','zh'),tokenizer,model,{'package_version':'test'})
            with patch.dict('sys.modules',{'ctranslate2':types.SimpleNamespace(),'sentencepiece':types.SimpleNamespace()}):
                result=translator.translate('en','zh',[{'id':'a','text':'source'}])
            self.assertEqual(result,[{'id':'a','text':'译文','source_text':'source','provider':'local_argos_test'}])

    def test_archive_traversal_rejected_without_writing_outside(self):
        archive=io.BytesIO()
        with zipfile.ZipFile(archive,'w') as z:z.writestr('../outside','bad')
        index=[{'from_code':'en','to_code':'fr','links':['https://argos-net.com/model']}]
        with tempfile.TemporaryDirectory() as td,patch('language_tools.urlopen',side_effect=[io.BytesIO(json.dumps(index).encode()),io.BytesIO(archive.getvalue())]):
            with self.assertRaisesRegex(ValueError,'Unsafe model archive'):LocalTranslator(Path(td)/'models').install('en','fr')
            self.assertFalse((Path(td)/'outside').exists())

class AiReaderTests(unittest.TestCase):
    def test_environment_does_not_forward_credentials_or_provider_overrides(self):
        with patch.dict(os.environ,{'ANTHROPIC_API_KEY':'secret','ANTHROPIC_AUTH_TOKEN':'secret','CLAUDE_CODE_OAUTH_TOKEN':'secret','OPENAI_API_KEY':'secret','NODE_OPTIONS':'secret','PATH':'/bin','HOME':'/home/test'},clear=True):
            self.assertEqual(ai_reader.safe_environment(),{'PATH':'/bin','HOME':'/home/test'})

    def test_auth_only_accepts_subscription_not_api_or_ambiguous_login(self):
        for method in ['api_key','api_key_helper','oauth_token','third_party','none',None]:
            with patch('ai_reader.shutil.which',return_value='/cli/claude'),patch('ai_reader.subprocess.run',return_value=types.SimpleNamespace(returncode=0,stdout=json.dumps({'loggedIn':True,'authMethod':method}))):
                self.assertFalse(ai_reader.subscription_status()['ready'])

    def test_structured_reading_runs_no_tools_no_session_no_api_fallback(self):
        def run(command,**kwargs):
            if 'status' in command:return types.SimpleNamespace(returncode=0,stdout='{"loggedIn":true,"authMethod":"claude.ai"}')
            self.assertEqual(command[command.index('--tools')+1],'')
            self.assertIn('--no-session-persistence',command);self.assertIn('--safe-mode',command)
            self.assertEqual(command[command.index('--disallowedTools')+1],'mcp__*')
            self.assertNotIn('ANTHROPIC_API_KEY',kwargs['env'])
            self.assertIn('source',kwargs['input']);self.assertTrue(Path(kwargs['cwd']).is_dir())
            return types.SimpleNamespace(returncode=0,stdout='{"structured_output":{"answer":"Result","citations":["a"]}}')
        with patch('ai_reader.shutil.which',return_value='/cli/claude'),patch('ai_reader.subprocess.run',side_effect=run):
            self.assertEqual(ai_reader.ask('Question','zh',[{'id':'a','text':'source'}])['citations'],['a'])

    def test_errors_and_invalid_citations_are_not_saved_or_retried_on_api(self):
        for stdout,code in [('quota exhausted',1),('{"is_error":true}',0),('{"structured_output":{"answer":"x","citations":["made-up"]}}',0)]:
            with patch('ai_reader.subscription_status',return_value={'ready':True}),patch('ai_reader.shutil.which',return_value='/cli/claude'),patch('ai_reader.subprocess.run',return_value=types.SimpleNamespace(returncode=code,stdout=stdout)) as run:
                with self.assertRaises(ValueError):ai_reader.ask('Question','en',[{'id':'a','text':'source'}])
                self.assertEqual(run.call_count,1)

class CodexReaderTests(unittest.TestCase):
    def test_subscription_command_is_ephemeral_and_disables_execution_and_connectors(self):
        def run(command,**kwargs):
            if '--help' in command:return types.SimpleNamespace(returncode=0,stdout='--ephemeral --ignore-user-config --output-schema --sandbox')
            if 'features' in command:return types.SimpleNamespace(returncode=0,stdout='\n'.join(ai_reader.CODEX_DISABLED))
            if 'status' in command:return types.SimpleNamespace(returncode=0,stdout='',stderr='Logged in using ChatGPT')
            self.assertEqual(command[-1],'-');self.assertTrue(kwargs['input'].startswith(ai_reader.SYSTEM));self.assertIn('source',kwargs['input'])
            for flag in ['--ephemeral','--ignore-user-config','--json']:self.assertIn(flag,command)
            self.assertIn('model_provider="openai"',command);self.assertIn('forced_login_method="chatgpt"',command)
            for feature in ['shell_tool','unified_exec','apps','plugins','hooks','computer_use','browser_use','multi_agent']:self.assertIn(feature,command)
            events=[{'type':'item.completed','item':{'type':'agent_message','text':json.dumps({'answer':'Result','citations':['a']})}},{'type':'turn.completed'}]
            return types.SimpleNamespace(returncode=0,stdout='\n'.join(json.dumps(x) for x in events))
        with patch('ai_reader.shutil.which',return_value='/cli/codex'),patch('ai_reader.subprocess.run',side_effect=run):
            result=ai_reader.ask('Q','zh',[{'id':'a','text':'source'}],'codex')
            self.assertEqual(result['provider'],'chatgpt_subscription')

    def test_exhausted_subscription_stops_without_fallback(self):
        with patch('ai_reader.codex_status',return_value={'ready':True}),patch('ai_reader.shutil.which',return_value='/cli/codex'),patch('ai_reader.subprocess.run',return_value=types.SimpleNamespace(returncode=1,stdout='limit')) as run:
            with self.assertRaisesRegex(ValueError,'不会购买额度'):ai_reader.ask('Q','en',[{'id':'a','text':'source'}],'codex')
            self.assertEqual(run.call_count,1)

class SubscriptionTranslationTests(unittest.TestCase):
    def test_translation_requires_exact_complete_ordered_ids(self):
        source=[{'id':'a','text':'First'},{'id':'b','text':'Second'}]
        invalid=[{'translations':[{'id':'a','text':'一'}]}, {'translations':[{'id':'a','text':'一'},{'id':'a','text':'二'}]}, {'translations':[{'id':'b','text':'二'},{'id':'a','text':'一'}]}, {'translations':[{'id':'a','text':'一'},{'id':'b','text':''}]}]
        for result in invalid:
            with patch('ai_reader.codex_answer',return_value=result):
                with self.assertRaises(ValueError):ai_reader.subscription_translate('en','zh',source)
        with patch('ai_reader.codex_answer',return_value={'translations':[{'id':'a','text':'一'},{'id':'b','text':'二'}]}) as call:
            result=ai_reader.subscription_translate('en','zh',source)
            self.assertEqual([t['source_text'] for t in result],['First','Second'])
            self.assertEqual(result[0]['provider'],'chatgpt_subscription_translation')
            payload,schema,instruction=call.call_args.args
            self.assertEqual(schema['properties']['translations']['minItems'],2)
            self.assertEqual(schema['properties']['translations']['items']['properties']['id']['enum'],['a','b'])
            self.assertEqual(json.loads(payload)['cues'],source)
            self.assertIn('untrusted data',instruction)

    def test_translation_quota_error_never_falls_back(self):
        with patch('ai_reader.codex_answer',side_effect=ValueError('quota exhausted')) as call,patch('ai_reader.subscription_status') as alternate:
            with self.assertRaisesRegex(ValueError,'quota exhausted'):ai_reader.subscription_translate('en','zh',[{'id':'a','text':'Source'}])
            call.assert_called_once();alternate.assert_not_called()

class SubscriptionContextTests(unittest.TestCase):
    @staticmethod
    def cue(identifier, position, text='Source'):
        return {'id':identifier,'text':text,'position':position,'start':float(position),'end':float(position+1)}

    def test_prompt_has_separate_target_ids_and_ordered_read_only_context(self):
        targets=[self.cue('b',1,'until approved')]
        context=[self.cue('a',0,'Do not send')]
        with patch('ai_reader.codex_answer',return_value={'translations':[{'id':'b','text':'获得批准之前'}]}) as provider:
            result=ai_reader.subscription_translate('en','zh',targets,context=context)
        payload,schema,instruction=provider.call_args.args
        payload=json.loads(payload)
        self.assertEqual(payload['target_ids'],['b'])
        self.assertEqual(payload['cues'],context+targets)
        self.assertEqual(schema['properties']['translations']['items']['properties']['id']['enum'],['b'])
        self.assertEqual([r['id'] for r in result],['b'])
        self.assertIn('context-only IDs must never',instruction)
        self.assertIn('negation',instruction)

    def test_context_only_response_and_invalid_context_are_rejected_before_writes(self):
        target=[self.cue('b',1)]
        context=[self.cue('a',0)]
        with patch('ai_reader.codex_answer',return_value={'translations':[{'id':'a','text':'Wrong target'}]}):
            with self.assertRaises(ValueError):ai_reader.subscription_translate('en','zh',target,context=context)
        invalid=[None, [{**context[0],'position':1}], [{**context[0],'start':float('nan')}],
                 [{**context[0],'position':False}], [{'id':'b','text':'duplicate','position':0,'start':0,'end':1}],
                 [self.cue('x'+str(i),i+2,'x'*4000) for i in range(11)]]
        # None is the explicit legacy no-context path; other malformed context is never forwarded.
        for value in invalid[1:]:
            with self.subTest(context=value),patch('ai_reader.codex_answer') as provider:
                with self.assertRaises(ValueError):ai_reader.subscription_translate('en','zh',target,context=value)
                provider.assert_not_called()
        with patch('ai_reader.codex_answer') as provider:
            with self.assertRaises(ValueError):ai_reader.subscription_translate('en','zh',[self.cue('b',2),self.cue('a',1)],context=[])
            provider.assert_not_called()

    def test_combined_context_and_targets_share_the_existing_character_cap(self):
        targets=[self.cue('t'+str(i),i,'x'*4000) for i in range(6)]
        context=[self.cue('c'+str(i),i+6,'y'*4000) for i in range(4)]
        result={'translations':[{'id':s['id'],'text':'译文'} for s in targets]}
        with patch('ai_reader.codex_answer',return_value=result) as provider:
            ai_reader.subscription_translate('en','zh',targets,context=context)
            provider.assert_called_once()
        with patch('ai_reader.codex_answer') as provider:
            with self.assertRaisesRegex(ValueError,'too large'):
                ai_reader.subscription_translate('en','zh',targets,context=context+[self.cue('extra',10)])
            provider.assert_not_called()
