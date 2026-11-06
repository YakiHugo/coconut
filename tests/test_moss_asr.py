"""Native MOSS service contracts with real PCM blocks and an authored model."""
from __future__ import annotations

import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

import moss_asr


def wav(path, seconds=2):
    with wave.open(str(path), 'wb') as stream:
        stream.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        for index in range(seconds):
            # The block's actual PCM is observable to the authored backend.
            stream.writeframesraw((index + 1).to_bytes(2, 'little') * 16000)


def generated(text='甲', *, start=0.0, end=.9, label='S01', tokens=10):
    return SimpleNamespace(text=f'[{start:.2f}][{label}]{text}[{end:.2f}]',
        segments=[{'start': start, 'end': end, 'speaker_id': label,
                   'text': f'[{label}] {text}'}], generation_tokens=tokens,
        prompt_tokens=20, total_tokens=tokens + 20, total_time=.01,
        prompt_tps=100, generation_tps=100)


class AuthoredModel:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def generate(self, path, **kwargs):
        with wave.open(str(path), 'rb') as stream:
            pcm = stream.readframes(stream.getnframes())
            self.calls.append({'frames': len(pcm) // 2, 'pcm': pcm, 'kwargs': kwargs})
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class MossRecipeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.wav'
        wav(self.source)
        self.model = self.root / 'model'
        self.model.mkdir()
        for name, value in [('config.json', {'model_type': 'moss_transcribe_diarize'}),
                            ('tokenizer_config.json', {}), ('tokenizer.json', {})]:
            (self.model / name).write_text(json.dumps(value))
        (self.model / 'model.safetensors').write_bytes(b'authored opaque weights')
        (self.model / 'chat_template.jinja').write_text('authored template')
        self.work = self.root / 'work'
        self.runtime = patch('moss_asr.version', return_value='authored-runtime-v1')
        self.runtime.start()
        self.addCleanup(self.runtime.stop)

    def run_recipe(self, model, **kwargs):
        with patch('moss_asr._load_model', return_value=model):
            return moss_asr.run_moss_pipeline(self.source, model_path=self.model,
                work_dir=self.work, chunk_seconds=1, **kwargs)

    def test_disjoint_pcm_preserves_every_native_segment_and_scopes_speakers(self):
        first = generated('甲')
        first.text += '[0.50][S02]乙[0.95]'
        first.segments.append({'start': .5, 'end': .95, 'speaker_id': 'S02', 'text': '[S02] 乙'})
        model = AuthoredModel([first, generated('丙')])
        progress = []
        result = self.run_recipe(model, progress=lambda a, b: progress.append((a, b)))
        self.assertEqual([s['text'] for s in result['segments']], ['甲', '乙', '丙'])
        self.assertEqual([s['start'] for s in result['segments']], [0, .5, 1])
        self.assertEqual([s['speaker_id'] for s in result['segments']],
                         ['speaker-0001', 'speaker-0002', 'speaker-0003'])
        self.assertEqual([s['provider_speaker'] for s in result['segments']], ['0:S01', '0:S02', '1:S01'])
        self.assertEqual([s['speaker'] for s in result['segments']],
                         ['第1块 · S01', '第1块 · S02', '第2块 · S01'])
        self.assertTrue(all(s['speaker_scope'] == 'chunk' for s in result['segments']))
        self.assertTrue(all(s['speaker_status'] == 'native_chunk_local' for s in result['segments']))
        self.assertTrue(all(s['timing_basis'] == 'native_segment' and 'words' not in s
                            for s in result['segments']))
        self.assertEqual(progress, [(0, 2), (1, 2)])
        self.assertEqual([c['frames'] for c in model.calls], [16000, 16000])
        self.assertEqual(model.calls[0]['pcm'], b'\x01\x00' * 16000)
        self.assertEqual(model.calls[1]['pcm'], b'\x02\x00' * 16000)
        self.assertEqual(result['pipeline']['speaker_count'], 3)
        self.assertIsNone(result['pipeline']['recording_speaker_count'])
        self.assertEqual(result['pipeline']['boundary_method'], 'disjoint-native-segments-v1')
        self.assertFalse(list(self.work.glob('chunk-*.wav')))

    def test_single_block_has_recording_scope_and_keeps_native_clocks(self):
        wav(self.source, 1)
        result = self.run_recipe(AuthoredModel([generated('一段', start=.13, end=.82)]))
        cue = result['segments'][0]
        self.assertEqual((cue['start'], cue['end']), (.13, .82))
        self.assertEqual((cue['speaker'], cue['speaker_scope'], cue['speaker_status']),
                         ('S01', 'recording', 'native_recording'))
        self.assertEqual(result['pipeline']['recording_speaker_count'], 1)
        self.assertIsNone(result['language'])

    def test_hotwords_and_title_are_prompted_once_without_provider_merge(self):
        model = AuthoredModel([generated(), generated()])
        self.run_recipe(model, title='对话张小珺', hotwords=['MOSS', '张小珺', ' MOSS '])
        prompt = model.calls[0]['kwargs']['prompt']
        self.assertEqual(prompt.count('热词提示：'), 1)
        self.assertIn('热词提示：MOSS, 张小珺', prompt)
        self.assertIn('节目标题', prompt)
        self.assertNotIn('hotwords', model.calls[0]['kwargs'])
        self.assertEqual(model.calls[0]['kwargs']['max_tokens'], 4096)
        self.assertEqual(model.calls[0]['kwargs']['temperature'], 0)

    def test_complete_cache_resumes_without_loading_model_and_ids_stay_stable(self):
        first = self.run_recipe(AuthoredModel([generated('甲'), generated('乙')]))
        with patch('moss_asr._load_model', side_effect=AssertionError('must not infer')):
            second = moss_asr.run_moss_pipeline(self.source, model_path=self.model,
                work_dir=self.work, chunk_seconds=1)
        self.assertEqual(first['segments'], second['segments'])
        self.assertTrue(all(c['reused'] for c in second['pipeline']['chunk_summaries']))
        record = json.loads((self.work / 'native-00000.json').read_text())
        self.assertEqual(record['raw_text'], '[0.00][S01]甲[0.90]')
        self.assertEqual(record['native_segments'][0]['text'], '[S01] 甲')

    def test_failed_later_block_retries_only_missing_work_and_preserves_attempt(self):
        model = AuthoredModel([generated('第一块'), RuntimeError('authored interruption')])
        with self.assertRaisesRegex(RuntimeError, 'authored interruption'):
            self.run_recipe(model)
        self.assertEqual(json.loads((self.work / 'native-00000.json').read_text())['status'], 'complete')
        self.assertEqual(json.loads((self.work / 'native-00001.json').read_text())['status'], 'failed')
        retry = AuthoredModel([generated('第二块')])
        result = self.run_recipe(retry)
        self.assertEqual([s['text'] for s in result['segments']], ['第一块', '第二块'])
        self.assertEqual(len(retry.calls), 1)
        self.assertEqual(len(list((self.work / 'attempts').glob('00001-*.json'))), 1)

    def test_exhausted_output_is_saved_but_not_a_complete_transcript(self):
        with self.assertRaisesRegex(ValueError, 'generation limit'):
            self.run_recipe(AuthoredModel([generated('完整外观也不能掩盖截断', tokens=4096)]))
        record = json.loads((self.work / 'native-00000.json').read_text())
        self.assertEqual(record['status'], 'failed')
        self.assertIn('完整外观', record['raw_text'])
        self.assertFalse((self.work / 'native-00001.json').exists())

    def test_parseable_prefix_with_truncated_tail_is_rejected_and_saved(self):
        partial = generated('前文')
        partial.text += '[0.95][S01]后文未完成'
        with self.assertRaisesRegex(ValueError, 'truncated'):
            self.run_recipe(AuthoredModel([partial]))
        record = json.loads((self.work / 'native-00000.json').read_text())
        self.assertEqual(record['status'], 'failed')
        self.assertTrue(record['raw_text'].endswith('后文未完成'))

    def test_model_load_failure_can_be_retried(self):
        with patch('moss_asr._load_model', side_effect=RuntimeError('authored load failure')):
            with self.assertRaisesRegex(RuntimeError, 'load failure'):
                moss_asr.run_moss_pipeline(self.source, model_path=self.model,
                    work_dir=self.work, chunk_seconds=1)
        result = self.run_recipe(AuthoredModel([generated('重试'), generated('完成')]))
        self.assertEqual(len(result['segments']), 2)

    def test_changed_title_hotwords_or_chunk_plan_do_not_reuse_work(self):
        self.run_recipe(AuthoredModel([generated(), generated()]))
        for kwargs in ({'title': 'new title'}, {'hotwords': ['new']}, {'chunk_seconds': .5}):
            with self.subTest(kwargs=kwargs), patch('moss_asr._load_model', side_effect=AssertionError('must not infer')):
                with self.assertRaisesRegex(ValueError, 'different input/options'):
                    moss_asr.run_moss_pipeline(self.source, model_path=self.model,
                        work_dir=self.work, **({'chunk_seconds': 1} | kwargs))

    def test_changed_source_weights_template_or_runtime_do_not_reuse_work(self):
        self.run_recipe(AuthoredModel([generated(), generated()]))
        for p in [self.source, self.model / 'model.safetensors', self.model / 'chat_template.jinja']:
            with self.subTest(path=p.name):
                original = p.read_bytes()
                try:
                    p.write_bytes(original + b'changed')
                    with self.assertRaisesRegex(ValueError, 'different input/options'):
                        self.run_recipe(AuthoredModel([]))
                finally:
                    p.write_bytes(original)
        with patch('moss_asr.version', return_value='authored-runtime-v2'):
            with self.assertRaisesRegex(ValueError, 'different input/options'):
                self.run_recipe(AuthoredModel([]))

    def test_prepared_audio_is_hash_bound(self):
        prepared = self.root / 'prepared.wav'
        wav(prepared)
        with patch('moss_asr.prepare_audio', return_value=prepared):
            self.run_recipe(AuthoredModel([generated(), generated()]))
            data = bytearray(prepared.read_bytes())
            data[-1] ^= 1
            prepared.write_bytes(data)
            with self.assertRaisesRegex(ValueError, 'Prepared MOSS audio changed'):
                self.run_recipe(AuthoredModel([]))

    def test_cached_native_fields_are_revalidated(self):
        self.run_recipe(AuthoredModel([generated(), generated()]))
        cache = self.work / 'native-00000.json'
        d = json.loads(cache.read_text())
        d['native_segments'][0]['text'] = '[S01] changed without raw'
        cache.write_text(json.dumps(d))
        with patch('moss_asr._load_model', side_effect=AssertionError('must not infer')):
            with self.assertRaisesRegex(ValueError, 'raw/native fields differ'):
                moss_asr.run_moss_pipeline(self.source, model_path=self.model,
                    work_dir=self.work, chunk_seconds=1)

    def test_cached_budget_cannot_hide_exhaustion(self):
        self.run_recipe(AuthoredModel([generated(), generated()]))
        cache = self.work / 'native-00000.json'
        value = json.loads(cache.read_text())
        value['max_tokens'] = 999999
        value['generation_tokens'] = 4096
        cache.write_text(json.dumps(value))
        with patch('moss_asr._load_model', side_effect=AssertionError('must not infer')):
            with self.assertRaisesRegex(ValueError, 'generation budget differs'):
                moss_asr.run_moss_pipeline(self.source, model_path=self.model,
                    work_dir=self.work, chunk_seconds=1)

    def test_invalid_adapter_object_keeps_available_raw_diagnostics(self):
        incomplete = SimpleNamespace(text='raw output without adapter segments', generation_tokens=10)
        with self.assertRaisesRegex(ValueError, 'native segments'):
            self.run_recipe(AuthoredModel([incomplete]))
        record = json.loads((self.work / 'native-00000.json').read_text())
        self.assertEqual(record['status'], 'failed')
        self.assertEqual(record['raw_text'], incomplete.text)

    def test_empty_pcm_and_nonlocal_paths_fail_without_loading(self):
        with patch('moss_asr._load_model', side_effect=AssertionError('must not infer')):
            with self.assertRaisesRegex(ValueError, 'Absolute'):
                moss_asr.run_moss_pipeline(self.source, model_path='remote/model', work_dir=self.work)
            wav(self.source, 0)
            with patch('moss_asr.prepare_audio', return_value=self.source):
                with self.assertRaisesRegex(ValueError, 'nonempty'):
                    moss_asr.run_moss_pipeline(self.source, model_path=self.model, work_dir=self.work)

    def test_unknown_model_type_does_not_load_or_fallback(self):
        (self.model / 'config.json').write_text(json.dumps({'model_type': 'qwen3_asr'}))
        with self.assertRaisesRegex(ValueError, 'Expected a local MOSS'):
            self.run_recipe(AuthoredModel([]))

    def test_invalid_recipe_options_fail_before_model_load(self):
        for change in ({'title': 4}, {'hotwords': 'MOSS'}, {'hotwords': ['']},
                       {'chunk_seconds': 0}, {'chunk_seconds': 1801}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                moss_asr.run_moss_pipeline(self.source, model_path=self.model,
                    work_dir=self.work, **change)


class NativeValidationTests(unittest.TestCase):
    def normalize(self, value):
        return moss_asr.normalize_native(value.text, value.segments, 1, value.generation_tokens, 4096)

    def test_empty_native_cues_are_omitted_consistently_without_fake_words(self):
        value = generated('正文')
        value.text = '[0.00][S02]  [0.10]' + value.text
        result = self.normalize(value)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['text'], '正文')
        self.assertNotIn('words', result[0])

    def test_silent_empty_output_has_no_fabricated_segment(self):
        value = SimpleNamespace(text='', segments=[{'start': 0, 'end': 1, 'text': ''}], generation_tokens=0)
        self.assertEqual(self.normalize(value), [])

    def test_adapter_fallback_free_text_and_missing_token_count_are_not_success(self):
        value = generated()
        value.text = 'untimed fallback'
        value.segments = [{'start': 0, 'end': 1, 'text': value.text}]
        with self.assertRaisesRegex(ValueError, 'unparsed'):
            self.normalize(value)
        value = generated()
        value.generation_tokens = None
        with self.assertRaisesRegex(ValueError, 'token count'):
            self.normalize(value)

    def test_zero_negative_outside_and_disordered_native_clocks_are_rejected(self):
        values = [generated(start=.2, end=.2), generated(start=-.1), generated(end=1.2)]
        disordered = generated('晚', start=.5, end=.9)
        second = generated('早', start=.2, end=.4)
        disordered.text += second.text
        disordered.segments += second.segments
        values.append(disordered)
        for value in values:
            with self.subTest(text=value.text), self.assertRaises(ValueError):
                self.normalize(value)

    def test_raw_native_label_and_text_mismatch_are_rejected(self):
        for field, value in [('speaker_id', 'S02'), ('text', '[S01] 另一个词'), ('start', .1)]:
            candidate = generated()
            candidate.segments[0][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'raw/native'):
                self.normalize(candidate)


if __name__ == '__main__':
    unittest.main()
