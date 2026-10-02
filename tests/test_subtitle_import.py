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

    def test_tls_option_honors_existing_trust_store_without_disabling_verification(self):
        import os
        from unittest.mock import patch
        from subtitle_import import tls_cli_options
        with patch.dict(os.environ, {'SSL_CERT_FILE':'/already/configured/roots.pem'}, clear=True):
            self.assertEqual(tls_cli_options(), ['--compat-options','no-certifi'])
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(tls_cli_options(), [])

    def test_subtitles_preserve_code_generics(self):
        result = parse_subtitles('1\n00:00:01,000 --> 00:00:02,000\n<b>Use</b> List<T> &amp; compare\n', '.srt')
        self.assertEqual(result[0]['text'], 'Use List<T> & compare')

    def test_x_status_url_is_narrowly_scoped(self):
        for url in ['https://x.com/example/status/123?s=20', 'https://twitter.com/example/status/123?t=251',
                    'https://www.x.com/i/status/123', 'https://mobile.twitter.com/example/status/123/']:
            validate_video_url(url)
        for url in ['https://x.com/example', 'https://x.com/search?q=video', 'https://x.com/i/flow/login',
                    'https://x.com/example/status/nope', 'https://x.com/example/status/123/other',
                    'https://x.com/example/status/123/video/1', 'https://x.com.evil.test/example/status/123',
                    'https://x.com@evil.test/example/status/123', 'https://evil@x.com/example/status/123',
                    'http://x.com/example/status/123', 'https://x.com:8443/example/status/123',
                    'https://x.com/example/status/123%2f..%2fsearch']:
            with self.subTest(url=url), self.assertRaises(ValueError): validate_video_url(url)

    def test_x_word_timing_markup_is_not_transcript_text(self):
        text = 'WEBVTT\n\n1\n00:00:01.220 --> 00:00:03.400\n<X-word-ms ms=100,200 index=1 character_ranges=0-2,3-6>Use List<T> &amp; keep it</X-word-ms>\n'
        self.assertEqual(parse_subtitles(text, '.vtt'), [{'start':1.22, 'end':3.4, 'text':'Use List<T> & keep it'}])

    def test_platform_media_evidence_is_attached_to_downloaded_captions(self):
        import sys, tempfile, types
        from pathlib import Path
        from unittest.mock import patch
        from subtitle_import import fetch_subtitle_document
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'captions.en.vtt'
            path.write_text('WEBVTT\n\n00:00:00.220 --> 00:00:02.181\n<X-word-ms index=1>Original fixture</X-word-ms>\n')
            class Downloader:
                def __init__(self, settings): self.settings=settings
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def extract_info(self, url, download=False):
                    return {'id':'987','title':'Fixture','duration':4.321,'subtitles':{'en':[{'ext':'vtt'}]}}
                def process_ie_result(self, info, download=True):
                    return {'requested_subtitles':{'en':{'filepath':str(path)}}}
            with patch.dict(sys.modules, {'yt_dlp':types.SimpleNamespace(YoutubeDL=Downloader)}):
                doc=fetch_subtitle_document('https://x.com/example/status/123',Path(td),'en')
            self.assertEqual(doc['source_url'],'https://x.com/example/status/123')
            self.assertEqual(doc['provenance'],{'kind':'platform_subtitles','language':'en','media_id':'987','media_duration':4.321})
            self.assertEqual(doc['segments'][0]['text'],'Original fixture')
