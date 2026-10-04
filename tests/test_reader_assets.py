import hashlib
import tempfile
import unittest
from pathlib import Path
from scripts.reader_assets import refresh


class AssetTests(unittest.TestCase):
    def test_stale_missing_tokens_refresh_and_external_references_stay_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'app.js').write_text('new source')
            (root / 'style.css').write_text('new style')
            html = '<script src="app.js?v=old"></script><link href="style.css"><script src="https://example.org/external.js"></script>'
            changed = refresh(html, root)
            self.assertIn('app.js?v=' + hashlib.sha256(b'new source').hexdigest()[:10], changed)
            self.assertIn('style.css?v=' + hashlib.sha256(b'new style').hexdigest()[:10], changed)
            self.assertIn('src="https://example.org/external.js"', changed)
            self.assertEqual(refresh(changed, root), changed)

    def test_missing_asset_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                refresh('<script src="missing.js?v=old">', Path(directory))
