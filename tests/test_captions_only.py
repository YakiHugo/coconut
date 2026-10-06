"""Caption-only permission gates never need network, models, or paid inference."""
import contextlib
import io
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from import_jobs import ImportJobs
from subtitle_import import SubtitleRetrievalError
from transcribe import main

URL = 'https://x.com/example/status/123'
DOCUMENT = {'schema_version': 1, 'title': 'Caption fixture', 'source_url': URL,
            'language': 'en', 'segments': [{'id': 'one', 'start': 0, 'end': 1, 'text': 'Original caption'}],
            'provenance': {'kind': 'platform_subtitles', 'language': 'en'}}


class CaptionsOnlyTests(unittest.TestCase):
    def test_no_captions_never_download_audio_media_or_initialize_either_asr(self):
        for backend in ('faster-whisper', 'whisperx'):
            with self.subTest(backend=backend), tempfile.TemporaryDirectory() as td:
                cache = Path(td) / 'cache'
                args = ['transcribe.py', URL, '--captions-only', '--keep-media',
                        '--work-dir', str(cache), '--backend', backend, '--no-diarize']
                with patch('sys.argv', args), patch('transcribe.fetch_subtitle_document', return_value=None), \
                        patch('transcribe.download_audio') as audio, patch('transcribe.download_playback') as media, \
                        patch('transcribe.transcribe_fast') as fast, patch('transcribe.transcribe') as whisperx:
                    with self.assertRaisesRegex(ValueError, 'Captions-only mode stopped'):
                        main()
                for action in (audio, media, fast, whisperx):
                    action.assert_not_called()
                self.assertEqual(json.loads((cache / 'manifest.json').read_text())['captions_only'], True)
                self.assertFalse((cache / 'document.json').exists())
                self.assertFalse((cache / 'audio.json').exists())

    def test_retrieval_failure_does_not_relax_caption_only_permission(self):
        with patch('sys.argv', ['transcribe.py', URL, '--captions-only']), \
                patch('transcribe.fetch_subtitle_document', side_effect=SubtitleRetrievalError('Unavailable')), \
                patch('transcribe.download_audio') as audio, patch('transcribe.transcribe_fast') as asr:
            with self.assertRaises(SubtitleRetrievalError):
                main()
        audio.assert_not_called()
        asr.assert_not_called()

    def test_conflicting_cli_options_reject_before_caption_lookup(self):
        with patch('sys.argv', ['transcribe.py', URL, '--captions-only', '--force-transcribe']), \
                patch('transcribe.fetch_subtitle_document') as captions, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as error:
                main()
        self.assertEqual(error.exception.code, 2)
        captions.assert_not_called()

    def test_cached_permission_cannot_change_in_either_direction(self):
        for first in (False, True):
            with self.subTest(first=first), tempfile.TemporaryDirectory() as td:
                cache = Path(td) / 'cache'
                output = Path(td) / 'result.md'
                base = ['transcribe.py', URL, '--work-dir', str(cache), '-o', str(output), '--no-diarize']
                with patch('sys.argv', base + (['--captions-only'] if first else [])), \
                        patch('transcribe.fetch_subtitle_document', return_value=DOCUMENT), contextlib.redirect_stdout(io.StringIO()):
                    main()
                with patch('sys.argv', base + ([] if first else ['--captions-only'])), \
                        patch('transcribe.download_audio') as audio, patch('transcribe.transcribe_fast') as asr, \
                        patch('transcribe.fetch_subtitle_document') as captions:
                    with self.assertRaisesRegex(ValueError, 'different input/options'):
                        main()
                captions.assert_not_called()
                audio.assert_not_called()
                asr.assert_not_called()

    def test_caption_success_and_retry_never_recognize_again(self):
        with tempfile.TemporaryDirectory() as td:
            cache, output = Path(td) / 'cache', Path(td) / 'result.md'
            args = ['transcribe.py', URL, '--work-dir', str(cache), '-o', str(output), '--captions-only', '--no-diarize']
            with patch('sys.argv', args), patch('transcribe.fetch_subtitle_document', return_value=DOCUMENT) as captions, \
                    patch('transcribe.download_audio') as audio, patch('transcribe.transcribe_fast') as asr, \
                    contextlib.redirect_stdout(io.StringIO()):
                main()
                main()
            captions.assert_called_once()
            audio.assert_not_called()
            asr.assert_not_called()
            self.assertEqual(json.loads(output.with_suffix('.json').read_text()), DOCUMENT)


class CaptionOnlyJobTests(unittest.TestCase):
    def test_queue_rejects_non_boolean_and_conflicting_options_before_insertion(self):
        with tempfile.TemporaryDirectory() as td:
            jobs = ImportJobs(Path(td))
            for options in ({'captions_only': 'true'}, {'captions_only': 1}, {'captions_only': None},
                            {'captions_only': True, 'force_transcribe': True}):
                with self.subTest(options=options), self.assertRaises(ValueError):
                    jobs.enqueue(URL, URL, options)
            self.assertEqual(jobs.list(), [])

    def test_actual_caption_only_subprocess_and_durable_option(self):
        with tempfile.TemporaryDirectory() as td:
            directory = Path(td)
            source = directory / 'original.srt'
            source.write_text('1\n00:00:00,000 --> 00:00:01,000\nCaption only\n')
            jobs = ImportJobs(directory / 'jobs')
            job = jobs.enqueue(str(source), 'Original', {'captions_only': True})
            jobs.start()
            try:
                actual = self.wait(jobs, job['id'])
                self.assertEqual(actual['status'], 'done', actual.get('error'))
                self.assertEqual(jobs.result(job['id'])['segments'][0]['text'], 'Caption only')
                manifest = json.loads((jobs.directory / job['id'] / 'cache' / 'manifest.json').read_text())
                self.assertTrue(manifest['captions_only'])
            finally:
                jobs.close()
            self.assertTrue(ImportJobs(directory / 'jobs').get(job['id'])['options']['captions_only'])

    def test_actual_non_caption_subprocess_fails_closed_even_on_retry(self):
        with tempfile.TemporaryDirectory() as td:
            source = Path(td) / 'not-captions.mp4'
            source.write_bytes(b'No model should ever see this fixture')
            jobs = ImportJobs(Path(td) / 'jobs')
            job = jobs.enqueue(str(source), 'Original', {'captions_only': True})
            jobs.start()
            try:
                for retry in (False, True):
                    if retry:
                        jobs.retry(job['id'])
                    actual = self.wait(jobs, job['id'])
                    self.assertEqual(actual['status'], 'failed')
                    self.assertIn('Captions-only mode stopped', actual['error'])
                    self.assertTrue(actual['options']['captions_only'])
                    self.assertFalse((jobs.directory / job['id'] / 'transcript.raw.json').exists())
            finally:
                jobs.close()

    @staticmethod
    def wait(jobs, identifier):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            actual = jobs.get(identifier)
            if actual['status'] in ('done', 'failed'):
                return actual
            time.sleep(.02)
        raise AssertionError('Worker did not finish')
