import unittest
from subtitle_import import parse_subtitles, seconds, select_track, validate_video_url

class SubtitleTests(unittest.TestCase):
    def test_srt_and_entities(self):
        result = parse_subtitles('1\r\n00:00:01,200 --> 00:00:03,400\r\n<b>Hello</b> &amp; 世界\r\n', '.srt')
        self.assertEqual(result, [{'start': 1.2, 'end': 3.4, 'text': 'Hello & 世界'}])
    def test_vtt_voice_and_settings(self):
        result = parse_subtitles('WEBVTT\n\nNOTE ignore this\n\nfirst\n00:01.000 --> 00:02.000 align:start\n<v Speaker>Hello</v>\n', '.vtt')
        self.assertEqual(result[0]['text'], 'Hello')
    def test_json3(self):
        self.assertEqual(parse_subtitles('{"events":[{"tStartMs":1000,"dDurationMs":2000,"segs":[{"utf8":"你好"}]}]}', '.json3')[0]['end'], 3)
    def test_invalid_timestamp(self):
        with self.assertRaises(ValueError): seconds('00:70.000')
    def test_manual_original_preferred(self):
        self.assertEqual(select_track({'language':'zh','subtitles':{'en':[{'ext':'vtt'}], 'zh-Hans':[{'ext':'vtt'}]},'automatic_captions':{'zh':[{'ext':'vtt'}]}}), ('subtitles','zh-Hans'))
    def test_do_not_silently_translate(self):
        self.assertIsNone(select_track({'language':'zh','subtitles':{'en':[{'ext':'vtt'}]}}))
    def test_auto_original_only_without_language(self):
        self.assertIsNone(select_track({'automatic_captions':{'en':[{'ext':'vtt'}], 'zh':[{'ext':'vtt'}]}}))
    def test_url_scope(self):
        validate_video_url('https://www.youtube.com/watch?v=abcdefghijk')
        for url in ['http://youtube.com/a','https://youtube.com.evil.test/a','https://127.0.0.1/a','https://user:pass@youtube.com/a']:
            with self.assertRaises(ValueError): validate_video_url(url)

    def test_skip_danmaku_and_unsupported_tracks(self):
        self.assertEqual(select_track({'subtitles':{'danmaku':[{'ext':'xml'}], 'comment':[{'ext':'xml'}], 'zh':[{'ext':'srt'}]}}), ('subtitles','zh'))

    def test_unknown_language_uses_original_caption_hint(self):
        self.assertEqual(select_track({'subtitles':{'en':[{'ext':'vtt'}]}, 'automatic_captions':{'zh-orig':[{'ext':'vtt'}]}}), ('automatic_captions','zh-orig'))
    def test_collections_rejected(self):
        for url in ['https://www.youtube.com/playlist?list=abc','https://www.youtube.com/@channel','https://www.bilibili.com/']:
            with self.assertRaises(ValueError):validate_video_url(url)
