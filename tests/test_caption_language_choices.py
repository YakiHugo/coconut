import unittest
import subtitle_import as s

class CaptionLanguageChoices(unittest.TestCase):
    def test_only_actual_eligible_tracks_are_choices(self):
        info = {'subtitles': {'en': [{'ext': 'vtt'}], 'fr': [{'ext': 'srt'}],
            'ai-zh': [{'ext': 'json3'}], 'danmaku': [{'ext': 'vtt'}],
            'de': [{'ext': 'vtt', 'is_translated': True}],
            'es': [{'ext': 'vtt', 'url': 'https://example.test/caption?tlang=es'}],
            'it': [{'ext': 'jpg'}], 'invalid-code-too-long': [{'ext': 'vtt'}]},
            'automatic_captions': {'en-orig': [{'ext': 'vtt'}]}}
        self.assertEqual(s.available_caption_languages(info), ['en', 'fr'])
        for language in s.available_caption_languages(info):
            self.assertIsNotNone(s.select_track(info, language))
        self.assertEqual(s.available_caption_languages(info, ('vtt',)), ['en'])
        self.assertEqual(s.available_caption_languages({}), [])
