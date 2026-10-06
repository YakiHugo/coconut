import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


path = Path(__file__).resolve().parents[1] / 'scripts' / 'prepare_browser_acceptance.py'
spec = importlib.util.spec_from_file_location('browser_acceptance_fixture', path)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class BrowserAcceptanceFixtureTests(unittest.TestCase):
    def test_missing_captions_stop_before_media_without_asr(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(fixture, 'fetch_subtitle_document', return_value=None), \
                    patch.object(fixture, 'download_playback') as media:
                with self.assertRaisesRegex(ValueError, 'ASR is disabled'):
                    fixture.prepare(Path(directory), 'original', 'https://x.com/example/status/123')
                media.assert_not_called()

    def test_unbounded_original_stops_before_media(self):
        for duration in (None, 0, 21601):
            with self.subTest(duration=duration), tempfile.TemporaryDirectory() as directory:
                document = {'provenance': {'media_duration': duration}}
                with patch.object(fixture, 'fetch_subtitle_document', return_value=document), \
                        patch.object(fixture, 'download_playback') as media:
                    with self.assertRaisesRegex(ValueError, 'bounded duration'):
                        fixture.prepare(Path(directory), 'original', 'https://x.com/example/status/123')
                    media.assert_not_called()

    def test_private_inputs_cannot_be_written_inside_checkout(self):
        with self.assertRaisesRegex(ValueError, 'outside the checkout'):
            fixture.prepare(fixture.ROOT / 'private-browser-fixture', 'synthetic')

    def test_nonempty_directory_is_not_reused_or_deleted(self):
        with tempfile.TemporaryDirectory() as directory:
            original = Path(directory) / 'keep.txt'
            original.write_text('Keep existing data')
            with self.assertRaisesRegex(ValueError, 'must be empty'):
                fixture.prepare(Path(directory), 'synthetic')
            self.assertEqual(original.read_text(), 'Keep existing data')


if __name__ == '__main__':
    unittest.main()
