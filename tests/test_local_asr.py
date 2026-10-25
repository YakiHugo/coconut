"""Optional ASR readiness/permission regression tests: offline fixtures only."""
import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from import_jobs import ImportJobs
import local_asr
from serve import build_server
from transcribe import main, transcribe_fast


REVISION = 'a' * 40
READY = {
    'available': True, 'code': 'ready', 'model': 'small',
    'backend': 'faster-whisper', 'local_only': True, 'model_download': False,
    'inference_tested': False, 'model_cached': True, 'message': 'Ready fixture',
    'missing_dependencies': [], 'broken_dependencies': [],
}


def make_model(cache):
    repository = cache / 'models--Systran--faster-whisper-small'
    snapshot = repository / 'snapshots' / REVISION
    snapshot.mkdir(parents=True)
    (snapshot / 'model.bin').write_bytes(b'opaque test fixture, never loaded')
    (snapshot / 'config.json').write_text('{"test_fixture": true}')
    (snapshot / 'tokenizer.json').write_text('{"test_fixture": true}')
    (snapshot / 'vocabulary.txt').write_text('fixture')
    (repository / 'refs').mkdir()
    (repository / 'refs' / 'main').write_text(REVISION)
    return snapshot


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.cache = Path(self.temp.name) / 'hub'
        self.environment = patch.dict(os.environ, {'HF_HUB_CACHE': str(self.cache)})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.temp.cleanup()

    def test_missing_dependencies_are_actionable_and_do_not_import_or_create_cache(self):
        with patch('local_asr.importlib.util.find_spec', return_value=None), \
                patch('local_asr.importlib.import_module') as imported:
            result = local_asr.executor_status()
        self.assertFalse(result['available'])
        self.assertEqual(result['code'], 'missing_dependencies')
        self.assertIn('faster-whisper', result['missing_dependencies'])
        self.assertFalse(result['model_download'])
        self.assertEqual(result['upload_operations'], 1)
        self.assertFalse(result['inference_tested'])
        imported.assert_not_called()
        self.assertFalse(self.cache.exists())

    def test_broken_installed_libraries_never_report_ready(self):
        make_model(self.cache)
        with patch('local_asr.importlib.util.find_spec', return_value=object()), \
                patch('local_asr.importlib.import_module', side_effect=ImportError('broken ABI')):
            result = local_asr.executor_status()
        self.assertFalse(result['available'])
        self.assertTrue(result['model_cached'])
        self.assertEqual(result['code'], 'missing_dependencies')
        self.assertIn('ctranslate2', result['broken_dependencies'])

    def test_importable_dependencies_without_model_never_initialize_or_download(self):
        constructors = Mock()
        with patch('local_asr.importlib.util.find_spec', return_value=object()), \
                patch('local_asr.importlib.import_module', return_value=constructors):
            result = local_asr.executor_status()
        self.assertEqual(result['code'], 'missing_model')
        self.assertFalse(result['available'])
        constructors.assert_not_called()
        self.assertEqual(constructors.mock_calls, [])
        self.assertIn('outside this import', result['message'])
        self.assertFalse(self.cache.exists())

    def test_complete_snapshot_is_pinned_and_status_does_not_leak_paths(self):
        snapshot = make_model(self.cache)
        before = sorted(str(path) for path in self.cache.rglob('*'))
        with patch('local_asr._dependency_problems', return_value=([], [])):
            result = local_asr.executor_status()
            self.assertEqual(local_asr.require_local_model(), snapshot.resolve())
        self.assertTrue(result['available'])
        self.assertEqual(result['upload_operations'], 1)
        self.assertEqual(result['code'], 'ready')
        self.assertFalse(result['inference_tested'])
        self.assertNotIn(str(self.cache), json.dumps(result))
        self.assertEqual(before, sorted(str(path) for path in self.cache.rglob('*')))

    def test_partial_snapshots_and_invalid_metadata_fail_closed(self):
        snapshot = make_model(self.cache)
        for name in ('model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt'):
            path = snapshot / name
            content = path.read_bytes()
            with self.subTest(missing=name):
                path.unlink()
                self.assertIsNone(local_asr.cached_model_path())
                path.write_bytes(b'')
                self.assertIsNone(local_asr.cached_model_path())
                path.write_bytes(content)
        for payload in ('{', 'null', '[]'):
            with self.subTest(metadata=payload):
                (snapshot / 'tokenizer.json').write_text(payload)
                self.assertIsNone(local_asr.cached_model_path())

    def test_normal_hub_blob_symlinks_and_cached_revisions_work_without_remote_refs(self):
        snapshot = make_model(self.cache)
        repository = snapshot.parent.parent
        blobs = repository / 'blobs'
        blobs.mkdir()
        (snapshot / 'model.bin').rename(blobs / 'weights')
        (snapshot / 'model.bin').symlink_to('../../blobs/weights')
        (repository / 'refs' / 'main').unlink()
        self.assertEqual(local_asr.cached_model_path(), snapshot.resolve())
        (repository / 'refs' / 'main').write_text('../../private')
        self.assertEqual(local_asr.cached_model_path(), snapshot.resolve())

    def test_cache_environment_precedence_and_default_are_read_only(self):
        values = {'XDG_CACHE_HOME': '/tmp/xdg', 'HF_HOME': '/tmp/hf',
                  'HUGGINGFACE_HUB_CACHE': '/tmp/legacy', 'HF_HUB_CACHE': '/tmp/current'}
        with patch.dict(os.environ, values, clear=True):
            self.assertEqual(local_asr._hub_cache(), Path('/tmp/current'))
            del os.environ['HF_HUB_CACHE']
            self.assertEqual(local_asr._hub_cache(), Path('/tmp/legacy'))
            del os.environ['HUGGINGFACE_HUB_CACHE']
            self.assertEqual(local_asr._hub_cache(), Path('/tmp/hf/hub'))
            del os.environ['HF_HOME']
            self.assertEqual(local_asr._hub_cache(), Path('/tmp/xdg/huggingface/hub'))

    def test_disappearing_cache_does_not_fall_back_to_a_model_alias(self):
        with patch('local_asr.executor_status', return_value=READY), \
                patch('local_asr.cached_model_path', return_value=None):
            with self.assertRaisesRegex(ValueError, 'no longer available'):
                local_asr.require_local_model()

    def test_unsupported_model_is_rejected_without_dependency_or_model_work(self):
        with patch('local_asr._dependency_problems') as dependencies, \
                patch('local_asr.cached_model_path') as model:
            self.assertEqual(local_asr.executor_status('large-v3')['code'], 'invalid_model')
        dependencies.assert_not_called()
        model.assert_not_called()


class LocalUploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server, self.jobs = build_server(Path(self.temp.name), 0)
        self.jobs.close()  # Admission tests never start a recognition process.
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def upload(self, query='local_only=true'):
        return Request(self.base + '/api/uploads?filename=recording.mp3&' + query,
                       data=b'not audio; no inference allowed',
                       headers={'Content-Type': 'application/octet-stream'})

    def test_status_is_read_only_and_uses_existing_host_guards(self):
        with patch('serve.executor_status', return_value=READY) as status:
            with urlopen(self.base + '/api/ingestion-executor/status') as response:
                self.assertEqual(json.load(response), READY)
            for headers in ({'Host': 'evil.example'}, {'Origin': 'https://evil.example'}):
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(self.base + '/api/ingestion-executor/status', headers=headers))
                self.assertEqual(error.exception.code, 403)
            status.assert_called_once_with()
        self.assertEqual(self.jobs.list(), [])

    def test_unavailable_preflight_rejects_before_upload_storage_or_enqueue(self):
        before = set(self.jobs.directory.iterdir())
        unavailable = {**READY, 'available': False, 'code': 'missing_model', 'message': 'Cached model missing'}
        with patch('serve.executor_status', return_value=unavailable), \
                patch.object(self.jobs, 'enqueue') as enqueue:
            with self.assertRaises(HTTPError) as raised:
                urlopen(self.upload())
            with raised.exception as response:
                self.assertEqual(response.code, 503)
                result = json.load(response)
                self.assertEqual(result['code'], 'missing_model')
                self.assertFalse(result['model_download'])
        enqueue.assert_not_called()
        self.assertEqual(before, set(self.jobs.directory.iterdir()))
        self.assertEqual(self.jobs.list(), [])

    def test_ready_upload_uses_durable_existing_job_and_cancel_retry(self):
        with patch('serve.executor_status', return_value=READY):
            with urlopen(self.upload()) as response:
                self.assertEqual(response.status, 201)
                job = json.load(response)
        self.assertTrue(job['options']['local_only'])
        self.assertEqual(job['status'], 'queued')
        source = self.jobs.directory / job['id'] / 'source.mp3'
        self.assertEqual(source.read_bytes(), b'not audio; no inference allowed')
        self.jobs.cancel(job['id'])
        self.jobs.retry(job['id'])
        restored = ImportJobs(self.jobs.directory)
        self.assertTrue(restored.get(job['id'])['options']['local_only'])
        self.assertEqual(restored.get(job['id'])['status'], 'queued')

    def test_pending_local_only_media_survives_all_job_states_and_supports_ranges(self):
        with patch('serve.executor_status', return_value=READY):
            with urlopen(self.upload()) as response:
                job = json.load(response)
        path = '/api/ingestion-executor/jobs/' + job['id'] + '/media'
        for state in ('queued', 'running', 'failed', 'cancelled', 'interrupted', 'done'):
            with self.subTest(state=state):
                with self.jobs.connect() as db:
                    db.execute('UPDATE jobs SET status=? WHERE id=?', (state, job['id']))
                with urlopen(self.base + path) as response:
                    self.assertEqual(response.headers['Content-Type'], 'audio/mpeg')
                    self.assertEqual(response.read(), b'not audio; no inference allowed')
                with urlopen(Request(self.base + path, headers={'Range': 'bytes=4-8'})) as response:
                    self.assertEqual(response.status, 206)
                    self.assertEqual(response.read(), b'audio')
                with urlopen(Request(self.base + path, method='HEAD')) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.read(), b'')
                if state != 'done':
                    with self.assertRaises(HTTPError) as error:
                        urlopen(self.base + '/api/jobs/' + job['id'] + '/media')
                    self.assertEqual(error.exception.code, 409)

    def test_pending_endpoint_cannot_expose_ordinary_uploads_or_untrusted_paths(self):
        with urlopen(self.upload('')) as response:
            ordinary = json.load(response)
        with self.jobs.connect() as db:
            db.execute("UPDATE jobs SET status='done' WHERE id=?", (ordinary['id'],))
        with self.assertRaises(HTTPError) as error:
            urlopen(self.base + '/api/ingestion-executor/jobs/' + ordinary['id'] + '/media')
        self.assertEqual(error.exception.code, 404)
        with patch('serve.executor_status', return_value=READY):
            with urlopen(self.upload()) as response:
                job = json.load(response)
        path = self.base + '/api/ingestion-executor/jobs/' + job['id'] + '/media'
        for headers in ({'Origin': 'https://evil.example'}, {'Sec-Fetch-Site': 'cross-site'}):
            with self.assertRaises(HTTPError) as error:
                urlopen(Request(path, headers=headers))
            self.assertEqual(error.exception.code, 403)
        source = self.jobs.directory / job['id'] / 'source.mp3'
        private = self.jobs.directory / 'private.mp3'
        source.rename(private)
        source.symlink_to(private)
        with self.assertRaises(HTTPError) as error:
            urlopen(path)
        self.assertEqual(error.exception.code, 404)
        with self.jobs.connect() as db:
            db.execute('UPDATE jobs SET source=? WHERE id=?', (str(private), job['id']))
        with self.assertRaises(HTTPError) as error:
            urlopen(path)
        self.assertEqual(error.exception.code, 404)

    def test_ordinary_upload_does_not_preflight_or_gain_local_only(self):
        for query in ('', 'local_only=false'):
            with self.subTest(query=query), patch('serve.executor_status') as status:
                with urlopen(self.upload(query)) as response:
                    self.assertNotIn('local_only', json.load(response)['options'])
                status.assert_not_called()

    def test_invalid_or_ambiguous_query_is_rejected_before_storage(self):
        for query in ('local_only=1', 'local_only=', 'local_only=true&local_only=false'):
            with self.subTest(query=query), patch('serve.executor_status') as status:
                with self.assertRaises(HTTPError) as raised:
                    urlopen(self.upload(query))
                self.assertEqual(raised.exception.code, 400)
                status.assert_not_called()
        self.assertEqual(self.jobs.list(), [])


class LocalOnlyJobTests(unittest.TestCase):
    def test_validation_rejects_ambiguous_scope_before_insertion(self):
        with tempfile.TemporaryDirectory() as td:
            jobs = ImportJobs(Path(td))
            for source, options in (
                ('file.mp3', {'local_only': 'true'}),
                ('file.mp3', {'local_only': 1}),
                ('file.mp3', {'local_only': None}),
                ('file.mp3', {'local_only': True, 'model': 'medium'}),
                ('https://x.com/example/status/123', {'local_only': True}),
            ):
                with self.subTest(source=source, options=options), self.assertRaises(ValueError):
                    jobs.enqueue(source, source, options)
            self.assertEqual(jobs.list(), [])

    def test_subprocess_retains_local_only_on_failure_retry_and_sets_offline_environment(self):
        with tempfile.TemporaryDirectory() as td:
            jobs = ImportJobs(Path(td))
            job = jobs.enqueue('/fixture.mp3', 'Fixture', {'local_only': True})
            for retry in (False, True):
                if retry:
                    jobs.retry(job['id'])
                with jobs.connect() as db:
                    db.execute("UPDATE jobs SET status='running' WHERE id=?", (job['id'],))
                    row = dict(db.execute('SELECT * FROM jobs WHERE id=?', (job['id'],)).fetchone())
                process = Mock(stderr=io.StringIO('Expected fixture failure\n'))
                process.wait.return_value = 1
                with patch('import_jobs.subprocess.Popen', return_value=process) as popen:
                    jobs._run(row)
                command = popen.call_args.args[0]
                self.assertIn('--local-files-only', command)
                self.assertIn('--no-diarize', command)
                self.assertIn('--no-align', command)
                self.assertEqual(command[command.index('--backend') + 1], 'faster-whisper')
                self.assertEqual(command[command.index('--model') + 1], 'small')
                for key, value in local_asr.OFFLINE_ENVIRONMENT.items():
                    self.assertEqual(popen.call_args.kwargs['env'][key], value)
                self.assertEqual(jobs.get(job['id'])['status'], 'failed')
                self.assertTrue(jobs.get(job['id'])['options']['local_only'])


class LocalTranscriptionTests(unittest.TestCase):
    def fake_runtime(self):
        runtime = SimpleNamespace(WhisperModel=Mock(), BatchedInferencePipeline=Mock())
        segment = SimpleNamespace(start=0, end=1, text='Offline fixture', words=[])
        runtime.WhisperModel.return_value.transcribe.return_value = ([segment], SimpleNamespace(language='en'))
        runtime.BatchedInferencePipeline.return_value.transcribe.return_value = ([segment], SimpleNamespace(language='en'))
        return runtime

    def test_local_constructor_uses_existing_absolute_directory_and_local_files_flag(self):
        runtime = self.fake_runtime()
        with patch.dict(sys.modules, {'faster_whisper': runtime}), patch.dict(os.environ, {}, clear=False), \
                patch('transcribe.require_local_model', return_value=Path('/existing/snapshot')) as require:
            result = transcribe_fast(Path('/fixture.wav'), None, model_name='small',
                                     device='cpu', compute_type='int8', local_files_only=True)
            self.assertEqual(os.environ['HF_HUB_OFFLINE'], '1')
        require.assert_called_once_with('small')
        runtime.WhisperModel.assert_called_once_with('/existing/snapshot', device='cpu',
                                                    compute_type='int8', local_files_only=True)
        self.assertEqual(result['segments'][0]['text'], 'Offline fixture')

    def test_missing_model_stops_before_constructor_and_never_falls_back_to_whisperx(self):
        runtime = self.fake_runtime()
        with patch.dict(sys.modules, {'faster_whisper': runtime}), patch.dict(os.environ, {}, clear=False), \
                patch('transcribe.require_local_model', side_effect=ValueError('Cached model missing')), \
                patch('transcribe.transcribe') as whisperx:
            with self.assertRaisesRegex(ValueError, 'Cached model missing'):
                transcribe_fast(Path('/fixture.wav'), None, model_name='small',
                                device='cpu', compute_type='int8', local_files_only=True)
        runtime.WhisperModel.assert_not_called()
        whisperx.assert_not_called()

    def test_batch_size_uses_existing_offline_model_and_preserves_sequential_option(self):
        for size in (1,8):
            runtime=self.fake_runtime()
            with self.subTest(size=size),patch.dict(sys.modules,{'faster_whisper':runtime}), \
                    patch('transcribe.require_local_model',return_value=Path('/existing/snapshot')):
                result=transcribe_fast(Path('/fixture.wav'),'zh',model_name='small',device='cpu',
                                       compute_type='int8',batch_size=size,local_files_only=True)
            self.assertEqual(result['segments'][0]['text'],'Offline fixture')
            if size==1:
                runtime.BatchedInferencePipeline.assert_not_called()
                runtime.WhisperModel.return_value.transcribe.assert_called_once_with(
                    '/fixture.wav',language='zh',vad_filter=True,word_timestamps=True)
            else:
                runtime.BatchedInferencePipeline.assert_called_once_with(model=runtime.WhisperModel.return_value)
                runtime.WhisperModel.return_value.transcribe.assert_not_called()
                runtime.BatchedInferencePipeline.return_value.transcribe.assert_called_once_with(
                    '/fixture.wav',language='zh',vad_filter=True,word_timestamps=True,batch_size=8,without_timestamps=False)

    def test_ordinary_constructor_keeps_existing_advanced_behavior(self):
        runtime = self.fake_runtime()
        with patch.dict(sys.modules, {'faster_whisper': runtime}), \
                patch('transcribe.require_local_model') as require:
            transcribe_fast(Path('/fixture.wav'), None, model_name='medium', device='cpu', compute_type='int8')
        require.assert_not_called()
        runtime.WhisperModel.assert_called_once_with('medium', device='cpu', compute_type='int8')

    def test_cli_rejects_whisperx_alternate_models_and_remote_input_without_any_work(self):
        for arguments in (['file.mp3', '--backend', 'whisperx'],
                          ['file.mp3', '--model', 'large-v3'],
                          ['https://x.com/example/status/123']):
            with self.subTest(arguments=arguments), patch('sys.argv', ['transcribe.py', *arguments, '--local-files-only']), \
                    patch('transcribe.transcribe_fast') as fast, patch('transcribe.transcribe') as whisperx, \
                    patch('transcribe.download_audio') as audio, patch('transcribe.fetch_subtitle_document') as captions, \
                    contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    main()
                self.assertEqual(error.exception.code, 2)
            for action in (fast, whisperx, audio, captions):
                action.assert_not_called()

    def test_cli_preserves_permission_in_manifest_and_completed_transcript_is_reused(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / 'fixture.wav'
            import wave
            with wave.open(str(source), 'wb') as stream:
                stream.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
                stream.writeframes(b'\0' * 32000)
            output = root / 'result.md'
            cache = root / 'cache'
            runtime = self.fake_runtime()
            args = ['transcribe.py', str(source), '--local-files-only', '--work-dir', str(cache), '-o', str(output)]
            with patch('sys.argv', args), patch.dict(os.environ, {'HF_TOKEN': 'unused-fixture'}), \
                    patch.dict(sys.modules, {'faster_whisper': runtime}), \
                    patch('transcribe.require_local_model', return_value=Path('/existing/snapshot')), \
                    patch('transcribe.transcribe') as whisperx, patch('transcribe.download_audio') as audio, \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                main()
                main()
            runtime.WhisperModel.assert_called_once()
            whisperx.assert_not_called()
            audio.assert_not_called()
            manifest = json.loads((cache / 'manifest.json').read_text())
            self.assertTrue(manifest['local_files_only'])
            self.assertFalse(manifest['diarize'])
            self.assertEqual(json.loads(output.with_suffix('.json').read_text())['provenance']['model'], 'small')
            with patch('sys.argv', [part for part in args if part != '--local-files-only']), \
                    patch('transcribe.transcribe_fast') as fast:
                with self.assertRaisesRegex(ValueError, 'different input/options'):
                    main()
            fast.assert_not_called()
