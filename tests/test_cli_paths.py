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
