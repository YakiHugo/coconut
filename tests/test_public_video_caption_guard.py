"""Offline guard tests and authored upstream-response-shaped fixtures, not live proof."""
import contextlib
import copy
import importlib.util
import io
import json
import socket
import ssl
import unittest
import urllib.error
from types import SimpleNamespace
from unittest.mock import patch, MagicMock
from scripts import public_video_caption_guard as guard

YOUTUBE = 'https://www.youtube.com/watch?v=BaW_jenozKc'
BILIBILI = 'https://www.bilibili.com/video/BV1xx411c7mD'
VTT = b'WEBVTT\n\n00:00.000 --> 00:04.000\nAuthored original fixture.\n'
PLAYER = {'playabilityStatus': {'status': 'OK'},
    'videoDetails': {'videoId': 'BaW_jenozKc', 'title': 'Authored fixture', 'lengthSeconds': '4', 'isLiveContent': False, 'author': 'Fixture'},
    'microformat': {'playerMicroformatRenderer': {'category': 'Education', 'uploadDate': '2020-01-01'}},
    'captions': {'playerCaptionsTracklistRenderer': {'captionTracks': [{
        'baseUrl': 'https://www.youtube.com/api/timedtext?v=BaW_jenozKc&lang=en',
        'languageCode': 'en', 'vssId': '.en', 'name': {'simpleText': 'English'}}]}}, 'streamingData': {}}
STATE = {'videoData': {'bvid': 'BV1xx411c7mD', 'aid': 1, 'cid': 2,
    'title': 'Authored Bilibili fixture', 'duration': 4, 'pages': [{'cid': 2, 'page': 1, 'part': 'Fixture'}], 'rights': {}},
    'upData': {'name': 'Fixture', 'mid': 3}}

class Response:
    status = 200
    headers = {}
    def __init__(self, body): self.body = io.BytesIO(body)
    def read(self, size): return self.body.read(size)
    def __enter__(self): return self
    def __exit__(self, *args): self.body.close()


class TransportTests(unittest.TestCase):
    def test_media_credentials_redirects_translations_and_other_origins_stop(self):
        for source, urls in [(YOUTUBE, ['https://www.youtube.com/api/timedtext?v=wrong&fmt=vtt',
            'https://www.youtube.com/api/timedtext?v=BaW_jenozKc&fmt=vtt&tlang=fr',
            'https://rr1.googlevideo.com/videoplayback', 'https://accounts.google.com/login',
            'https://www.youtube.com/embed/BaW_jenozKc', 'https://evil.test/file.vtt']),
            (BILIBILI, ['https://comment.bilibili.com/1.xml', 'https://i0.hdslb.com/video.mp4',
            'https://aisubtitle.hdslb.com.evil.test/bfs/subtitle/a.json',
            'http://aisubtitle.hdslb.com/bfs/subtitle/a.json',
            'https://aisubtitle.hdslb.com/bfs/subtitle/../../other.json',
            'https://aisubtitle.hdslb.com/bfs/subtitle/./a.json',
            'https://aisubtitle.hdslb.com/bfs/subtitle/%2e%2e/other.json'])]:
            transport = guard.VideoTransport(source)
            for url in urls:
                with self.subTest(url=url), self.assertRaises(guard.StopProof):
                    transport.kind(url, 'GET', None, {})
            with self.assertRaises(guard.StopProof): transport.kind(source, 'GET', None, {'Cookie': 'private'})
        with self.assertRaises(guard.StopProof):
            guard.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://accounts.google.com')

    def test_transport_denial_budget_network_and_no_ambient_proxy(self):
        for code in (401, 403, 412, 429):
            transport = guard.VideoTransport(YOUTUBE)
            with patch.object(transport.opener, 'open', side_effect=urllib.error.HTTPError(YOUTUBE, code, '', {}, io.BytesIO())) as send:
                with self.assertRaises(guard.StopProof) as caught:
                    transport.send(SimpleNamespace(url=YOUTUBE, method='GET', data=None, headers={}))
                self.assertEqual(caught.exception.outcome, 'access_restricted'); self.assertEqual(send.call_count, 1)
        transport = guard.VideoTransport(YOUTUBE)
        with patch.object(transport.opener, 'open', side_effect=urllib.error.URLError('offline')):
            with self.assertRaises(guard.StopProof) as caught:
                transport.send(SimpleNamespace(url=YOUTUBE, method='GET', data=None, headers={}))
            self.assertEqual(caught.exception.outcome, 'transport_unavailable')
        transport.count = guard.MAX_REQUESTS
        with patch.object(transport.opener, 'open') as send, self.assertRaises(guard.StopProof):
            transport.send(SimpleNamespace(url=YOUTUBE, method='GET', data=None, headers={}))
        send.assert_not_called()

    def test_api_denial_and_bounded_payload(self):
        for payload in [{'code': -403}, {'code': 0, 'data': {'need_login_subtitle': True}}]:
            transport = guard.VideoTransport(BILIBILI)
            with patch.object(transport.opener, 'open', return_value=Response(json.dumps(payload).encode())):
                with self.assertRaises(guard.StopProof) as caught:
                    transport.send(SimpleNamespace(url='https://api.bilibili.com/x/player/wbi/v2?aid=1&cid=2', method='GET', data=None, headers={}))
                self.assertEqual(caught.exception.outcome, 'access_restricted')
        transport = guard.VideoTransport(YOUTUBE)
        with patch.object(transport.opener, 'open', return_value=Response(b'x'*(guard.MAX_RESPONSE+1))), self.assertRaises(guard.StopProof):
            transport.send(SimpleNamespace(url=YOUTUBE, method='GET', data=None, headers={}))


class PinnedConnectionTests(unittest.TestCase):
    @staticmethod
    def record(address):
        family = socket.AF_INET6 if ':' in address else socket.AF_INET
        sockaddr = (address, 443, 0, 0) if family == socket.AF_INET6 else (address, 443)
        return (family, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', sockaddr)

    def test_non_global_and_mixed_dns_never_open_a_socket(self):
        public = self.record('142.250.191.46')
        for address in ('127.0.0.1', '169.254.169.254', '10.0.0.4', '::1',
                        '::ffff:127.0.0.1', '100.64.0.1', '224.0.0.1', '2001:db8::1'):
            for records in ([self.record(address)], [public, self.record(address)]):
                with self.subTest(address=address, mixed=len(records)>1), \
                        patch.object(guard.socket, 'getaddrinfo', return_value=records), \
                        patch.object(guard.socket, 'socket') as create:
                    connection = guard.PinnedHTTPSConnection('www.youtube.com', timeout=15)
                    with self.assertRaises(guard.StopProof): connection.connect()
                    create.assert_not_called()

    def test_numeric_connect_is_pinned_and_original_tls_identity_is_retained(self):
        first = self.record('142.250.191.46')
        private_rebinding = [self.record('127.0.0.1')]
        context = ssl.create_default_context()
        connection = guard.PinnedHTTPSConnection('www.youtube.com', timeout=15, context=context)
        raw = MagicMock()
        wrapped = MagicMock()
        with patch.object(guard.socket, 'getaddrinfo', side_effect=[[first], private_rebinding]) as lookup, \
                patch.object(guard.socket, 'socket', return_value=raw) as create, \
                patch.object(context, 'wrap_socket', return_value=wrapped) as wrap:
            connection.connect()
            lookup.assert_called_once_with('www.youtube.com', 443, socket.AF_UNSPEC, socket.SOCK_STREAM)
            create.assert_called_once_with(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP)
            raw.connect.assert_called_once_with(('142.250.191.46', 443))
            wrap.assert_called_once_with(raw, server_hostname='www.youtube.com')
            self.assertIs(connection.sock, wrapped)
            self.assertTrue(context.check_hostname)
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
            connection.close()

    def test_tls_failure_closes_validated_socket_without_retry_or_downgrade(self):
        connection = guard.PinnedHTTPSConnection('www.youtube.com', timeout=15)
        raw = MagicMock()
        with patch.object(guard.socket, 'getaddrinfo', return_value=[self.record('142.250.191.46')]) as lookup, \
                patch.object(guard.socket, 'socket', return_value=raw), \
                patch.object(connection._context, 'wrap_socket', side_effect=ssl.SSLCertVerificationError()):
            with self.assertRaises(ssl.SSLCertVerificationError): connection.connect()
            raw.close.assert_called_once(); lookup.assert_called_once()

    def test_real_urllib_path_uses_pinned_connection(self):
        transport = guard.VideoTransport(YOUTUBE)
        with patch.object(guard.socket, 'getaddrinfo', return_value=[self.record('169.254.169.254')]), \
                patch.object(guard.socket, 'socket') as create:
            with self.assertRaises(guard.StopProof) as caught:
                transport.send(SimpleNamespace(url=YOUTUBE, method='GET', data=None, headers={}))
            self.assertEqual(caught.exception.outcome, 'non_public_address')
            create.assert_not_called()


@unittest.skipUnless(importlib.util.find_spec('yt_dlp'), 'Pinned yt-dlp not installed; CI extractor-contract job installs it')
class OfficialExtractorTests(unittest.TestCase):
    def extract(self, source, player=None, state=None, denied=False, network=False):
        calls = []
        player = copy.deepcopy(PLAYER if player is None else player)
        state = copy.deepcopy(STATE if state is None else state)
        def open_request(request, timeout=None):
            calls.append(request.full_url)
            self.assertEqual(request.get_header('User-agent'), 'Coconut-public-captions/1.0')
            self.assertIsNone(request.get_header('Cookie'))
            if network: raise urllib.error.URLError('offline')
            if denied: raise urllib.error.HTTPError(request.full_url, 403, '', {}, io.BytesIO())
            url = request.full_url
            if '/watch?' in url:
                body = ('<script>var ytInitialPlayerResponse = '+json.dumps(player)+';</script>').encode()
            elif '/api/timedtext?' in url: body = VTT
            elif '/video/' in url:
                body = ('<script>window.__INITIAL_STATE__='+json.dumps(state)+';</script>').encode()
            elif '/pagelist?' in url: body = json.dumps({'code': 0, 'data': state['videoData']['pages']}).encode()
            elif '/nav' in url:
                body = json.dumps({'code': -101, 'data': {'wbi_img': {
                    'img_url': 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
                    'sub_url': 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'}}}).encode()
            elif '/playurl?' in url: body = b'{"code":0,"data":{"dash":{"video":[],"audio":[]},"timelength":4000}}'
            elif '/wbi/v2?' in url: body = b'{"code":0,"data":{"subtitle":{"subtitles":[{"lan":"en","subtitle_url":"//aisubtitle.hdslb.com/bfs/subtitle/fixture.json"}]}}}'
            elif '/bfs/subtitle/' in url: body = b'{"body":[{"from":0,"to":4,"content":"Authored original fixture."}]}'
            else: self.fail('Unexpected network request: '+url)
            return Response(body)
        with patch.object(guard.urllib.request.OpenerDirector, 'open', side_effect=open_request), contextlib.redirect_stderr(io.StringIO()):
            result = guard.extract_public_video_captions(source)
        return result, calls

    def test_player_api_does_not_claim_age_or_content_acknowledgement(self):
        import yt_dlp
        with guard.guarded_extractors(guard.VideoTransport(YOUTUBE)):
            with yt_dlp.YoutubeDL({'quiet': True}) as downloader:
                self.assertEqual(downloader.get_info_extractor('Youtube')._get_checkok_params(), {})

    def test_real_official_youtube_extractor_and_shared_parser(self):
        result, calls = self.extract(YOUTUBE)
        self.assertEqual(result['format'], 'vtt'); self.assertEqual(result['bytes'], VTT)
        self.assertEqual(result['source']['id'], 'BaW_jenozKc')
        self.assertEqual(result['track']['languageBasis'], 'single_track')
        self.assertEqual(len(calls), 2)
        self.assertNotIn('has_verified', calls[0])

    def test_unknown_necessary_access_or_completion_is_not_ready(self):
        for field in ('isLiveContent', 'playabilityStatus', 'videoId'):
            player = copy.deepcopy(PLAYER)
            if field == 'playabilityStatus': del player[field]
            else: del player['videoDetails'][field]
            result, calls = self.extract(YOUTUBE, player=player)
            self.assertEqual(result['status'], 'metadata_incomplete')
            self.assertFalse(any('/api/timedtext' in url for url in calls))
        player = copy.deepcopy(PLAYER); player['playabilityStatus']['status'] = None
        self.assertEqual(self.extract(YOUTUBE, player=player)[0]['status'], 'metadata_incomplete')

    def test_optional_metadata_can_be_missing_and_completed_broadcasts_remain_usable(self):
        player = copy.deepcopy(PLAYER)
        del player['videoDetails']['author']; del player['microformat']
        del player['videoDetails']['isLiveContent']; player['videoDetails']['isLive'] = False
        result, _ = self.extract(YOUTUBE, player=player)
        self.assertEqual(result['source']['live_status'], 'not_live')
        player['videoDetails']['isLiveContent'] = True
        result, _ = self.extract(YOUTUBE, player=player)
        self.assertEqual(result['source']['live_status'], 'was_live')
        self.assertEqual(result['bytes'], VTT)

    def test_original_automatic_track_and_required_token_are_honest(self):
        player = copy.deepcopy(PLAYER)
        track = player['captions']['playerCaptionsTracklistRenderer']['captionTracks'][0]
        track.update(kind='asr', vssId='a.en', isTranslatable=True)
        result, calls = self.extract(YOUTUBE, player=player)
        self.assertEqual(result['source']['automatic'], True)
        self.assertEqual(result['track']['captionTrack'], 'en-orig')
        self.assertEqual(result['track']['languageBasis'], 'original_track')
        self.assertFalse(any('tlang=' in url for url in calls))
        track['baseUrl'] += '&exp=xpe'
        result, calls = self.extract(YOUTUBE, player=player)
        self.assertEqual(result['status'], 'access_restricted')
        self.assertEqual(len(calls), 1)

    def test_real_official_bilibili_extractor_and_inline_srt(self):
        result, calls = self.extract(BILIBILI)
        self.assertEqual(result['format'], 'srt'); self.assertIn(b'Authored original fixture.', result['bytes'])
        self.assertEqual(result['source']['id'], 'BV1xx411c7mD')
        self.assertTrue(any('/wbi/v2?' in url for url in calls))
        self.assertFalse(any('videoplayback' in url or '.mp4' in url for url in calls))

    def test_no_fallback_after_access_denial_or_network_failure(self):
        for source in (YOUTUBE, BILIBILI):
            for key, status in [('denied', 'access_restricted'), ('network', 'network_unavailable')]:
                result, calls = self.extract(source, **{key: True})
                self.assertEqual(result['status'], status); self.assertEqual(len(calls), 1)
        player = copy.deepcopy(PLAYER); player['playabilityStatus']['status'] = 'LOGIN_REQUIRED'
        result, calls = self.extract(YOUTUBE, player=player)
        self.assertEqual(result['status'], 'access_restricted'); self.assertEqual(len(calls), 1)
        state = copy.deepcopy(STATE); state['videoData']['is_upower_exclusive'] = True
        result, calls = self.extract(BILIBILI, state=state)
        self.assertEqual(result['status'], 'access_restricted'); self.assertEqual(len(calls), 1)

    def test_language_ambiguity_and_wrong_identity_do_not_download(self):
        player = copy.deepcopy(PLAYER)
        track = copy.deepcopy(player['captions']['playerCaptionsTracklistRenderer']['captionTracks'][0])
        track.update(languageCode='fr', vssId='.fr', baseUrl=track['baseUrl'].replace('lang=en', 'lang=fr'))
        player['captions']['playerCaptionsTracklistRenderer']['captionTracks'].append(track)
        result, calls = self.extract(YOUTUBE, player=player)
        self.assertEqual(result['status'], 'language_required')
        self.assertFalse(any('/api/timedtext' in url for url in calls))
        state = copy.deepcopy(STATE); state['videoData']['bvid'] = 'BV1aaaaaaaaa'
        result, calls = self.extract(BILIBILI, state=state)
        self.assertEqual(result['status'], 'guard_stopped')
        self.assertEqual(result['diagnostic']['reason'], 'identity_mismatch')


@unittest.skipUnless(importlib.util.find_spec('yt_dlp'), 'Pinned yt-dlp required')
class FailureDiagnosticTests(unittest.TestCase):
    extract = OfficialExtractorTests.extract
    def test_constructor_failure_is_local_not_absent_captions(self):
        import yt_dlp
        with patch.object(yt_dlp.YoutubeDL, '__init__', side_effect=TypeError('PRIVATE_TOKEN /private/path')):
            result, calls = self.extract(YOUTUBE)
        self.assertEqual(calls, [])
        self.assertEqual(result, {'status': 'extractor_failed', 'diagnostic': {
            'stage': 'extractor_setup', 'reason': 'extractor_error', 'requests_attempted': 0, 'responses_received': 0}})
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_parse_failure_preserves_observed_response_counts_without_source_text(self):
        with patch.object(guard.subtitle_import, 'subtitle_document', side_effect=ValueError('PRIVATE_CAPTION')):
            result, calls = self.extract(YOUTUBE)
        self.assertEqual(result, {'status': 'caption_parse_failed', 'diagnostic': {
            'stage': 'caption_parse', 'reason': 'caption_parse_failed', 'requests_attempted': 2, 'responses_received': 2}})
        self.assertEqual(len(calls), 2)

    def test_output_file_failure_is_not_absence(self):
        with patch.object(guard.subtitle_import, 'fetch_subtitle_document', return_value={'provenance': {}}):
            result = guard.extract_public_video_captions(YOUTUBE)
        self.assertEqual(result['status'], 'caption_file_invalid')
        self.assertEqual(result['diagnostic']['stage'], 'caption_output')
        self.assertEqual(result['diagnostic']['requests_attempted'], 0)

    def test_unknown_missing_document_is_not_evidence_of_no_matching_track(self):
        with patch.object(guard.subtitle_import, 'fetch_subtitle_document', return_value=None):
            result = guard.extract_public_video_captions(YOUTUBE)
        self.assertEqual(result['status'], 'extractor_failed')

    def test_known_guard_and_transport_outcomes_have_distinct_bounded_evidence(self):
        for name, status, reason, responses in [('denied', 'access_restricted', 'access_restricted', 1),
                ('network', 'network_unavailable', 'transport_unavailable', 0)]:
            result, calls = self.extract(YOUTUBE, **{name: True})
            self.assertEqual(result['status'], status)
            self.assertEqual(result['diagnostic']['reason'], reason)
            self.assertEqual(result['diagnostic']['requests_attempted'], 1)
            self.assertEqual(result['diagnostic']['responses_received'], responses)
            self.assertEqual(len(calls), 1)
        with patch.object(guard.VideoTransport, 'kind', side_effect=guard.StopProof('request_scope_stopped')):
            result, calls = self.extract(YOUTUBE)
        self.assertEqual(result['status'], 'guard_stopped')
        self.assertEqual(result['diagnostic']['reason'], 'request_scope_stopped')
        self.assertEqual(result['diagnostic']['requests_attempted'], 0)
        self.assertEqual(calls, [])

    def test_no_matching_track_requires_successful_metadata_and_selection(self):
        # Authored metadata with no warning: the actual shared selector runs.
        info={'id':'BaW_jenozKc','duration':4,'live_status':'not_live','subtitles':{},'automatic_captions':{}}
        def extract(downloader, *args, **kwargs):
            # The fixture models a verified player response; no external request.
            guard.subtitle_import.select_track(info, 'en')
            return None
        @contextlib.contextmanager
        def local_fixture(transport):
            transport.youtube_access_verified=True
            yield
        with patch.object(guard, 'guarded_extractors', local_fixture), patch.object(guard.subtitle_import, 'fetch_subtitle_document', extract):
            result=guard.extract_public_video_captions(YOUTUBE, 'en')
        self.assertEqual(result['status'], 'no_matching_captions')
        self.assertEqual(result['diagnostic']['stage'], 'track_selection')
        self.assertEqual(result['diagnostic']['reason'], 'no_matching_track')

@unittest.skipUnless(importlib.util.find_spec('yt_dlp'), 'Pinned yt-dlp required')
class LauncherDiagnosticTests(unittest.TestCase):
    def run_launcher(self, result=None, failure=None):
        import runpy
        import sys
        from pathlib import Path
        request={'operation':'extract-development','url':YOUTUBE,'language':'en'}
        output=io.StringIO()
        stdin=SimpleNamespace(buffer=io.BytesIO(json.dumps(request).encode()))
        with patch.object(sys, 'argv', ['caption-helper', '--protocol=1']), patch.object(sys, 'stdin', stdin), \
                patch.object(guard, 'extract_public_video_captions', return_value=result, side_effect=failure), \
                contextlib.redirect_stdout(output):
            runpy.run_path(str(Path(__file__).parents[1]/'desktop/helper/caption_helper_launcher.py'), run_name='__main__')
        return json.loads(output.getvalue())

    def test_launcher_preserves_failure_classification_and_observed_stage(self):
        result={'status':'extractor_failed','diagnostic':{'stage':'extractor_setup',
                'reason':'extractor_error','requests_attempted':0,'responses_received':0}}
        self.assertEqual(self.run_launcher(result),result)

    def test_launcher_exception_is_unknown_execution_not_no_captions(self):
        result=self.run_launcher(failure=ValueError('PRIVATE_TOKEN /private/path'))
        self.assertEqual(result,{'status':'extractor_failed','diagnostic':{'stage':'helper_execution',
            'reason':'helper_error','requests_attempted':None,'responses_received':None}})
        self.assertNotIn('PRIVATE',json.dumps(result))
