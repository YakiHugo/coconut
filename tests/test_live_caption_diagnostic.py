"""Public diagnostics expose finite categories, never upstream free text."""
import unittest
from scripts.live_caption_diagnostic import diagnostic_category

class CaptionDiagnosticTests(unittest.TestCase):
    def test_signed_urls_and_credentials_never_enter_diagnostics(self):
        for value in ('https://cdn.example/a?sig=shortsecret','HTTP://cdn.example/a?sig=shortsecret',
                      '//cdn.example/a?sig=shortsecret','token=shortsecret','Cookie: session=shortsecret',
                      '/private/cache/source.mp4','x'*1000):
            self.assertEqual(diagnostic_category('Request failed: '+value),'other_upstream_diagnostic')
    def test_known_diagnostics_have_only_finite_categories(self):
        self.assertEqual(diagnostic_category('Requested format is not available'),'requested_format_unavailable')
        self.assertEqual(diagnostic_category('No video formats found!'),'no_formats')
        self.assertEqual(diagnostic_category('Requested format is not available https://cdn.example/?sig=secret'),'other_upstream_diagnostic')
