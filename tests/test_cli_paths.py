import tempfile
import unittest
from pathlib import Path
from transcribe import default_output_path

class OutputTests(unittest.TestCase):
    def test_distinct_urls_and_existing_outputs_are_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory=Path(tmp)
            one=default_output_path('https://youtu.be/first',directory,True)
            two=default_output_path('https://youtu.be/second',directory,True)
            self.assertNotEqual(one,two)
            one.write_text('Existing user document')
            again=default_output_path('https://youtu.be/first',directory,True)
            self.assertNotEqual(one,again)
            self.assertEqual(one.read_text(),'Existing user document')


class StageRecoveryTests(unittest.TestCase):
    def test_interrupted_media_download_keeps_completed_transcript_for_retry(self):
        import json
        from unittest.mock import patch
        from transcribe import main
        document = {'schema_version': 1, 'title': 'Caption fixture',
                    'source_url': 'https://x.com/example/status/123', 'language': 'en',
                    'segments': [{'id': 'segment-1', 'start': 0.2, 'end': 1.5, 'text': 'A completed caption'}],
                    'provenance': {'kind': 'platform_subtitles', 'language': 'en'}}
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            cache = directory / 'cache'
            output = directory / 'transcript.raw.md'
            args = ['transcribe.py', document['source_url'], '--language', 'en',
                    '--work-dir', str(cache), '-o', str(output), '--keep-media', '--no-diarize']
            with patch('sys.argv', args), patch('transcribe.fetch_subtitle_document', return_value=document), \
                    patch('transcribe.download_playback', side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    main()
            self.assertEqual(json.loads((cache / 'document.json').read_text()), document)
            self.assertFalse(output.exists(), 'an interrupted job must not claim a final result')
            with patch('sys.argv', args), patch('transcribe.fetch_subtitle_document') as captions, \
                    patch('transcribe.download_playback', return_value=cache / 'playback.mp4') as media:
                main()
                captions.assert_not_called()
                media.assert_called_once()
            self.assertEqual(json.loads(output.with_suffix('.json').read_text()), document)

    def test_successful_playback_retry_clears_old_warning_without_recognizing_again(self):
        import json
        from unittest.mock import patch
        from transcribe import main
        document = {'schema_version':1, 'title':'Saved', 'source_url':'https://x.com/example/status/123',
                    'segments':[{'id':'a','start':0,'end':1,'text':'Keep original'}],
                    'provenance':{'kind':'platform_subtitles','playback_warning':'Unavailable'}}
        with tempfile.TemporaryDirectory() as td:
            cache = Path(td) / 'cache'; cache.mkdir()
            (cache / 'document.json').write_text(json.dumps(document))
            output = Path(td) / 'result.md'
            args = ['transcribe.py', document['source_url'], '--work-dir', str(cache), '-o', str(output), '--keep-media', '--no-diarize']
            with patch('sys.argv', args), patch('transcribe.fetch_subtitle_document') as captions, \
                    patch('transcribe.transcribe_fast') as recognition, patch('transcribe.download_playback'):
                main()
            captions.assert_not_called(); recognition.assert_not_called()
            actual = json.loads(output.with_suffix('.json').read_text())
            self.assertNotIn('playback_warning', actual['provenance'])
            self.assertEqual(actual['segments'], document['segments'])


class ASRProvenanceTests(unittest.TestCase):
    def test_no_eligible_captions_and_forced_asr_have_different_evidence(self):
        import json
        from unittest.mock import patch
        from transcribe import main
        for force in (False, True):
            with tempfile.TemporaryDirectory() as td:
                path = Path(td)
                output = path / 'result.md'
                args = ['transcribe.py', 'https://x.com/example/status/123', '-o', str(output), '--no-diarize']
                if force:
                    args += ['--force-transcribe', '--language', 'en']
                with patch('sys.argv', args), patch('transcribe.fetch_subtitle_document', return_value=None) as captions, \
                        patch('transcribe.download_audio', return_value=(path / 'audio.wav', 'Test')), \
                        patch('transcribe.transcribe_fast', return_value={'language': 'en', 'segments': [{'start': 0, 'end': 1, 'text': 'Test'}]}):
                    main()
                document = json.loads(output.with_suffix('.json').read_text())
                self.assertEqual(document['provenance']['subtitle_check'], 'skipped' if force else 'no_eligible_track')
                self.assertEqual(document['provenance']['language_basis'], 'user_hint' if force else 'asr_detected')
                self.assertEqual(document['provenance']['caption_method'], 'asr')
                self.assertEqual(document['provenance']['review_status'], 'unreviewed')
                self.assertEqual(document['provenance']['source_platform'], 'x')
                self.assertEqual(captions.call_count, 0 if force else 1)

    def test_failed_caption_retrieval_never_implicitly_starts_asr(self):
        from unittest.mock import patch
        from transcribe import main
        from subtitle_import import SubtitleRetrievalError
        with patch('sys.argv', ['transcribe.py', 'https://x.com/example/status/123', '--no-diarize']), \
                patch('transcribe.fetch_subtitle_document', side_effect=SubtitleRetrievalError('Retry captions')), \
                patch('transcribe.download_audio') as download, patch('transcribe.transcribe_fast') as asr:
            with self.assertRaises(SubtitleRetrievalError):
                main()
        download.assert_not_called()
        asr.assert_not_called()
