"""Offline model-adapter contracts; authored stubs never load or fetch weights."""
import contextlib
import io
import json
import tempfile
import types
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from audio_pipeline import SAMPLE_RATE, AudioChunk, validate_result, owned_segments
from transcription import QwenBackend, model_files, probe, run


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

    def test_complete_alignment_crops_exact_source_punctuation_and_spacing(self):
        raw = {'segments': [dict(start=8, end=11, text='Hello, 世界！', words=[
            dict(start=8, end=9, word='Hello'), dict(start=10.5, end=11, word='世界')])]}
        value = validate_result(raw, 12)
        chunk = AudioChunk(0, 0, 12*SAMPLE_RATE, 0, 10*SAMPLE_RATE)
        self.assertEqual(owned_segments(value, chunk, 20*SAMPLE_RATE)[0]['text'], 'Hello,')

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
