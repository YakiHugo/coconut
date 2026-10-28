"""Offline packaged-operation contracts using the pinned official caption runtime."""
import base64
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import runpy
import socket
import sys
import unittest
import urllib.error
from types import SimpleNamespace
from unittest.mock import patch

from scripts import public_video_caption_guard as video_guard
from scripts import public_x_caption_guard as x_guard

ROOT = Path(__file__).resolve().parents[1]
YOUTUBE = 'https://www.youtube.com/watch?v=BaW_jenozKc'
BILIBILI = 'https://www.bilibili.com/video/BV1xx411c7mD'
X = 'https://x.com/example/status/123'
PROVIDERS = ['x', 'youtube', 'bilibili']
VTT = b'WEBVTT\n\n00:00.000 --> 00:04.000\nOriginal packaged route fixture.\n'


@unittest.skipUnless(importlib.util.find_spec('yt_dlp'), 'Pinned yt-dlp required')
class PackagedLauncherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.launcher = runpy.run_path(str(ROOT / 'desktop/helper/caption_helper_launcher.py'))

    def invoke(self, request):
        with patch.object(sys, 'argv', ['caption-helper', '--protocol=1']), \
                patch.object(sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(json.dumps(request).encode()))):
            return self.launcher['main']()

    def test_version_advertises_packaged_providers_without_network(self):
        with patch.object(socket, 'socket') as connect:
            result = self.invoke({'operation': 'version'})
        self.assertEqual(result['publicProviders'], PROVIDERS)
        self.assertEqual(result['developmentProviders'], PROVIDERS)
        self.assertTrue(result['publicExtraction'])
        self.assertEqual(result['guardProtocol'], 1)
        self.assertTrue(result['tlsRootsVerified'])
        connect.assert_not_called()

    def test_packaged_extract_dispatches_each_existing_guard_and_preserves_bytes(self):
        for url, identity in [(YOUTUBE, 'BaW_jenozKc'), (BILIBILI, 'BV1xx411c7mD'), (X, '123')]:
            fixture = {'source': {'url': url, 'id': identity}, 'track': {'language': 'en'},
                       'format': 'vtt', 'bytes': VTT}
            with self.subTest(url=url), \
                    patch.object(video_guard, 'extract_public_video_captions', return_value=copy.deepcopy(fixture)) as video, \
                    patch.object(x_guard, 'extract_public_captions', return_value=copy.deepcopy(fixture)) as twitter:
                result = self.invoke({'operation': 'extract', 'url': url, 'language': 'en'})
                chosen, other = (twitter, video) if url == X else (video, twitter)
                chosen.assert_called_once()
                self.assertEqual(chosen.call_args.args, (url, 'en'))
                self.assertTrue(chosen.call_args.kwargs['ca_file'])
                self.assertIsNone(chosen.call_args.kwargs.get('proxy'))
                other.assert_not_called()
                self.assertEqual(result['status'], 'ok')
                self.assertEqual(base64.b64decode(result['captionBase64']), VTT)
                self.assertNotIn('bytes', result)

    def test_packaged_operation_runs_real_official_extractors_with_authored_responses(self):
        # Reuse the upstream-shaped metadata fixtures; no platform traffic.
        from test_public_video_caption_guard import PLAYER, STATE, Response
        for url, identity, extractor in [(YOUTUBE, 'BaW_jenozKc', 'youtube'),
                                          (BILIBILI, 'BV1xx411c7mD', 'bilibili')]:
            calls = []
            def open_request(request, timeout=None):
                calls.append(request.full_url)
                self.assertEqual(request.get_header('User-agent'), 'Coconut-public-captions/1.0')
                self.assertIsNone(request.get_header('Cookie'))
                target = request.full_url
                if '/watch?' in target:
                    body = ('<script>var ytInitialPlayerResponse = '+json.dumps(PLAYER)+';</script>').encode()
                elif '/api/timedtext?' in target:
                    body = VTT
                elif '/video/' in target:
                    body = ('<script>window.__INITIAL_STATE__='+json.dumps(STATE)+';</script>').encode()
                elif '/pagelist?' in target:
                    body = json.dumps({'code': 0, 'data': STATE['videoData']['pages']}).encode()
                elif '/nav' in target:
                    body = json.dumps({'code': -101, 'data': {'wbi_img': {
                        'img_url': 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
                        'sub_url': 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'}}}).encode()
                elif '/playurl?' in target:
                    body = b'{"code":0,"data":{"dash":{"video":[],"audio":[]},"timelength":4000}}'
                elif '/wbi/v2?' in target:
                    body = b'{"code":0,"data":{"subtitle":{"subtitles":[{"lan":"en","subtitle_url":"//aisubtitle.hdslb.com/bfs/subtitle/fixture.json"}]}}}'
                elif '/bfs/subtitle/' in target:
                    body = b'{"body":[{"from":0,"to":4,"content":"Original packaged route fixture."}]}'
                else:
                    self.fail('Unexpected network request: '+target)
                return Response(body)
            with self.subTest(url=url), \
                    patch.object(video_guard.urllib.request.OpenerDirector, 'open', side_effect=open_request), \
                    contextlib.redirect_stderr(io.StringIO()):
                result = self.invoke({'operation': 'extract', 'url': url, 'language': 'en'})
            self.assertEqual(result['status'], 'ok')
            self.assertEqual(result['source']['url'], url)
            self.assertEqual(result['source']['id'], identity)
            self.assertEqual(result['source']['extractor'], extractor)
            self.assertEqual(result['track']['language'], 'en')
            self.assertFalse(result['source']['translated'])
            self.assertFalse(result['source']['live'])
            self.assertIn(b'Original packaged route fixture.', base64.b64decode(result['captionBase64']))
            self.assertGreater(len(calls), 0)
            self.assertLessEqual(len(calls), video_guard.MAX_REQUESTS)

    def test_packaged_real_extractor_stops_on_denial_without_fallback(self):
        for url in (YOUTUBE, BILIBILI):
            with self.subTest(url=url), \
                    patch.object(video_guard.urllib.request.OpenerDirector, 'open',
                        side_effect=urllib.error.HTTPError(url, 403, '', {}, io.BytesIO())) as send, \
                    contextlib.redirect_stderr(io.StringIO()):
                result = self.invoke({'operation': 'extract', 'url': url, 'language': 'en'})
                self.assertEqual(result['status'], 'access_restricted')
                self.assertEqual(result['diagnostic']['reason'], 'http_access_denied')
                self.assertEqual(result['diagnostic']['requests_attempted'], 1)
                self.assertEqual(result['diagnostic']['responses_received'], 1)
                send.assert_called_once()

    def test_packaged_failures_keep_only_bounded_status_diagnostics_and_languages(self):
        statuses = ['access_restricted', 'unavailable', 'language_required', 'network_unavailable',
                    'metadata_incomplete', 'no_matching_captions', 'extractor_failed',
                    'caption_file_invalid', 'caption_parse_failed', 'guard_stopped']
        for status in statuses:
            expected = {'status': status, 'diagnostic': {'stage': 'metadata',
                'reason': 'transport_unavailable', 'requests_attempted': 1, 'responses_received': 0},
                'languages': ['en', 'zh']}
            fixture = {**expected, 'bytes': b'private', 'rawError': 'private'}
            with self.subTest(status=status), \
                    patch.object(video_guard, 'extract_public_video_captions', return_value=fixture) as video, \
                    patch.object(x_guard, 'extract_public_captions') as twitter:
                self.assertEqual(self.invoke({'operation': 'extract', 'url': YOUTUBE, 'language': None}), expected)
                video.assert_called_once()
                twitter.assert_not_called()

    def test_packaged_route_cannot_accept_development_proxy_or_extra_inputs(self):
        for extra in [{'trustedProxy': 'http://127.0.0.1:7897'}, {'bilibiliCookies': {'SESSDATA':'fixture'}}, {'cookiefile': '/private/cookies'},
                      {'client': 'android'}, {'operation': 'extract-arbitrary'}]:
            with self.subTest(extra=extra), \
                    patch.object(video_guard, 'extract_public_video_captions') as video, \
                    patch.object(x_guard, 'extract_public_captions') as twitter:
                request = {'operation': 'extract', 'url': YOUTUBE, 'language': 'en', **extra}
                self.assertEqual(self.invoke(request), {'status': 'unavailable'})
                video.assert_not_called()
                twitter.assert_not_called()

    def test_development_proxy_remains_separate_from_packaged_route(self):
        fixture = {'status': 'network_unavailable'}
        with patch.object(video_guard, 'extract_public_video_captions', return_value=fixture) as video:
            self.assertEqual(self.invoke({'operation': 'extract-development', 'url': YOUTUBE,
                'language': 'en', 'trustedProxy': 'http://127.0.0.1:7897'}), fixture)
            self.assertEqual(video.call_args.kwargs['proxy'], 'http://127.0.0.1:7897')

    def test_development_session_is_bilibili_only_and_remains_a_private_input(self):
        session = {'SESSDATA':'fixture-session'}
        for url in (YOUTUBE, X):
            with patch.object(video_guard, 'extract_public_video_captions') as video, patch.object(x_guard, 'extract_public_captions') as twitter:
                self.assertEqual(self.invoke({'operation':'extract-development','url':url,'language':None,'bilibiliCookies':session}), {'status':'guard_stopped'})
                video.assert_not_called();twitter.assert_not_called()
        with patch.object(video_guard, 'extract_public_video_captions', return_value={'status':'no_matching_captions'}) as video:
            result = self.invoke({'operation':'extract-development','url':BILIBILI,'language':None,'bilibiliCookies':session,'trustedProxy':'http://127.0.0.1:7897'})
            self.assertEqual(result, {'status':'no_matching_captions'})
            self.assertEqual(video.call_args.kwargs['bilibili_cookies'], session)
            self.assertNotIn('fixture-session', repr(result))

    def test_packaged_real_guard_rejects_invalid_inputs_before_any_socket(self):
        for url in ['https://www.youtube.com/watch?v=invalid', 'http://www.youtube.com/watch?v=BaW_jenozKc',
                    'https://name:secret@www.youtube.com/watch?v=BaW_jenozKc',
                    'https://www.bilibili.com/video/av123', 'https://b23.tv/example']:
            with self.subTest(url=url), patch.object(socket, 'socket') as connect:
                result = self.invoke({'operation': 'extract', 'url': url, 'language': 'en'})
                self.assertNotEqual(result.get('status'), 'ok')
                connect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
