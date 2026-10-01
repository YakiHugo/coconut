"""Offline regressions for subtitle discovery, launch paths, and shutdown."""
import json
import os
import select
import signal
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import transcribe
from subtitle_import import fetch_subtitle_document, select_track


class ReviewRegressions(unittest.TestCase):
    def test_discovery_enables_extractor_subtitles_before_selecting(self):
        instances = []
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)

            class FakeYoutubeDL:
                def __init__(self, settings):
                    self.settings = dict(settings)
                    instances.append(self)

                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    return False

                def extract_info(self, url, download=False):
                    # BiliBiliIE uses InfoExtractor.extract_subtitles, which
                    # returns no tracks unless one of these flags is set.
                    enabled = self.settings.get('listsubtitles') or self.settings.get('writesubtitles')
                    return {'id': 'video', 'title': 'Example', 'language': 'zh',
                            'subtitles': {'zh': [{'ext': 'srt'}]} if enabled else {}}

                def process_ie_result(self, info, download=True):
                    path = directory / 'captions.zh.srt'
                    path.write_text('1\n00:00:01,000 --> 00:00:02,000\nHello\n')
                    return {**info, 'requested_subtitles': {'zh': {'filepath': str(path)}}}

            with patch.dict(sys.modules, {'yt_dlp': types.SimpleNamespace(YoutubeDL=FakeYoutubeDL)}):
                result = fetch_subtitle_document('https://www.bilibili.com/video/BV17x411w7KC', directory)
            self.assertIsNotNone(result)
            self.assertEqual(result['segments'][0]['text'], 'Hello')
            self.assertTrue(instances[0].settings.get('listsubtitles') or instances[0].settings.get('writesubtitles'))
            self.assertFalse(instances[1].settings.get('listsubtitles'))

    def test_source_marker_prevents_selecting_unrelated_manual_translation(self):
        info = {'subtitles': {'en': [{'ext': 'vtt'}]},
                'automatic_captions': {'zh-orig': [{'ext': 'vtt'}]}}
        self.assertEqual(select_track(info), ('automatic_captions', 'zh-orig'))

    def test_audio_download_uses_the_current_python_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            audio = directory / 'video.wav'

            def run(command, **kwargs):
                if '--dump-single-json' not in command:
                    audio.write_bytes(b'fixture')
                return subprocess.CompletedProcess(command, 0, stdout='{"title":"Example","duration":5}')

            with patch('transcribe.subprocess.run', side_effect=run) as mocked:
                result = transcribe.download_audio('https://youtube.com/watch?v=abcdefghijk', directory)
            self.assertEqual(result, (audio, 'Example'))
            for call in mocked.call_args_list:
                self.assertEqual(call.args[0][:3], [sys.executable, '-m', 'yt_dlp'])
                self.assertIn('--ignore-config', call.args[0])

    def test_audio_preflight_rejects_live_and_unsafe_metadata_before_downloading(self):
        invalid_metadata = [
            {'is_live': True, 'duration': 60},
            {'live_status': 'is_live', 'duration': 60},
            {'live_status': 'is_upcoming', 'duration': 60},
            {'live_status': 'post_live', 'duration': 60},
            {'_type': 'playlist', 'entries': [], 'duration': 60},
            {'duration': None},
            {'duration': 6 * 3600 + 1},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            for info in invalid_metadata:
                with self.subTest(info=info):
                    response = subprocess.CompletedProcess([], 0, stdout=json.dumps(info))
                    with patch('transcribe.subprocess.run', return_value=response) as mocked:
                        with self.assertRaises(ValueError):
                            transcribe.download_audio('https://youtube.com/watch?v=abcdefghijk', Path(tmp))
                    self.assertEqual(mocked.call_count, 1, 'Invalid metadata must stop before audio download')
                    self.assertIn('--skip-download', mocked.call_args.args[0])
                    self.assertIn('--dump-single-json', mocked.call_args.args[0])
                    self.assertEqual(list(Path(tmp).iterdir()), [])

    @unittest.skipUnless(os.name == 'posix', 'Local worker process groups are POSIX-only')
    def test_sigterm_stops_active_import_and_marks_it_interrupted(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            started = directory / 'started'
            stopped = directory / 'stopped'
            shim = directory / 'fake-python'
            shim.write_text(
                '#!' + sys.executable + '\n'
                'import os, signal, sys, time\nfrom pathlib import Path\n'
                'def stop(*args):\n'
                f'    Path({str(stopped)!r}).write_text("stopped")\n'
                '    sys.exit(0)\n'
                'signal.signal(signal.SIGTERM, stop)\n'
                f'Path({str(started)!r}).write_text(str(os.getpid()))\n'
                'time.sleep(60)\n'
            )
            shim.chmod(0o755)
            script = (
                'import serve, sys\n'
                'original_build = serve.build_server\n'
                'def build(directory, port):\n'
                '    server, jobs = original_build(directory, port)\n'
                f'    jobs.python = {str(shim)!r}\n'
                '    jobs.enqueue("fixture", "Fixture")\n'
                '    return server, jobs\n'
                'serve.build_server = build\n'
                f'sys.argv = ["serve.py", "--port", "0", "--data-dir", {str(directory / "jobs")!r}]\n'
                'serve.main()\n'
            )
            parent = subprocess.Popen([sys.executable, '-c', script],
                                      cwd=Path(__file__).resolve().parents[1],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      text=True)
            child_pid = None
            try:
                readable, _, _ = select.select([parent.stdout], [], [], 10)
                self.assertTrue(readable, 'The server never announced startup')
                self.assertIn('Coconut is ready', parent.stdout.readline())
                deadline = time.monotonic() + 10
                while not started.exists() and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertTrue(started.exists(), 'The fake importer did not start')
                child_pid = int(started.read_text())
                parent.terminate()
                parent.wait(timeout=12)
                self.assertTrue(stopped.exists(), 'SIGTERM left the importer running')
                from import_jobs import ImportJobs
                restored = ImportJobs(directory / 'jobs')
                self.assertEqual(restored.list()[0]['status'], 'interrupted')
            finally:
                if parent.poll() is None:
                    parent.kill()
                    parent.wait(timeout=3)
                if child_pid is not None:
                    try:
                        os.killpg(child_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                parent.stdout.close()
                parent.stderr.close()


if __name__ == '__main__':
    unittest.main()
