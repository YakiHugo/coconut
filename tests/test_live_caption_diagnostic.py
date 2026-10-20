"""Public diagnostics must redact signed URLs, not just filesystem paths."""
import unittest
from scripts.live_caption_diagnostic import safe

class CaptionDiagnosticTests(unittest.TestCase):
    def test_signed_urls_are_removed_with_the_complete_query(self):
        for value in ('https://cdn.example/audio.m4s?sig=shortsecret&expires=42',
                      'http://cdn.example/caption?token=shortsecret'):
            result=safe('Request failed: '+value+' after one attempt')
            self.assertEqual(result,'Request failed: [url] after one attempt')
            self.assertNotIn('shortsecret',result)
    def test_paths_identifiers_and_output_size_are_bounded(self):
        self.assertNotIn('/private/cache/source.mp4',safe('/private/cache/source.mp4'))
        self.assertEqual(safe('x'*40),'[identifier]')
        self.assertLessEqual(len(safe('a '*300)),300)
