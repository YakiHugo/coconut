"""Offline policy/validation tests. These do not claim live caption availability."""
import contextlib
import io
import json
import importlib.util
import ssl
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
from urllib.parse import urlencode

from scripts import prove_public_x_captions as proof
from scripts import public_x_caption_guard as guard
from subtitle_import import subtitle_document

GUEST = 'https://api.x.com/1.1/guest/activate.json'
METADATA = 'https://x.com/i/api/graphql/pinned/TweetResultByRestId?' + urlencode({
    'variables': json.dumps({'tweetId': proof.POST_ID})})
VTT = 'https://video.twimg.com/public/subtitles/en.vtt'
BODY = b'WEBVTT\n\n00:00.220 --> 00:01.250\nAuthored cue.\n\n00:01.500 --> 00:02.001\nSecond.\n\n00:02.250 --> 00:03.750\nLast.\n'


class Response:
    def __init__(self, body, headers=None):
        self.body = io.BytesIO(body)
        self.headers = headers or {}
        self.status = 200

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.body.close()

    def read(self, size):
        return self.body.read(size)


class PublicCaptionGuardTests(unittest.TestCase):
    def expect_stop(self, outcome, fn, *args, **kwargs):
        with self.assertRaises(guard.StopProof) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.outcome, outcome)

    def test_explicit_bundled_ca_keeps_certificate_and_hostname_verification(self):
        context = ssl.create_default_context()
        with patch.object(guard.ssl, 'create_default_context', return_value=context) as create:
            transport = guard.PublicTransport(proof.POST_ID, ca_file='/bundle/certifi/cacert.pem')
        create.assert_called_once_with(cafile='/bundle/certifi/cacert.pem')
        handler = next(item for item in transport.opener.handlers if isinstance(item, guard.urllib.request.HTTPSHandler))
        self.assertIs(handler._context, context)
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    def test_one_public_route_only(self):
        cases = [(GUEST, 'POST', b'', 'guest_activation'),
                 (METADATA, 'GET', None, 'post_metadata'),
                 ('https://video.twimg.com/public/master.m3u8', 'GET', None, 'manifest'),
                 (VTT, 'GET', None, 'caption')]
        for url, method, data, expected in cases:
            self.assertEqual(guard.request_kind(url, method, data, {}, proof.POST_ID), expected)

    def test_reject_media_fallback_accounts_and_unsafe_urls(self):
        for url in [
            'https://video.twimg.com/source.mp4', 'https://video.twimg.com/audio.m4a',
            'https://video.twimg.com/segment.ts', 'https://video.twimg.com/caption.json',
            'https://cdn.syndication.twimg.com/tweet-result?id=' + proof.POST_ID,
            'https://x.com/i/flow/login', 'https://127.0.0.1/test.vtt',
            'https://video.twimg.com.evil.test/test.vtt', 'https://evil@video.twimg.com/test.vtt',
            'http://video.twimg.com/test.vtt', 'https://video.twimg.com:444/test.vtt',
            VTT + '#fragment', METADATA.replace(proof.POST_ID, '111'),
        ]:
            with self.subTest(url=url):
                self.expect_stop('request_scope_stopped', guard.request_kind, url, 'GET', None, {}, proof.POST_ID)

    def test_credential_and_impersonation_headers_rejected(self):
        for name in ('Cookie', 'cookie', 'X-CSRF-Token', 'Proxy-Authorization'):
            self.expect_stop('credential_input_stopped', guard.request_kind,
                             GUEST, 'POST', b'', {name: 'DO-NOT-PRINT'}, proof.POST_ID)
        for name in ('Authorization', 'X-Guest-Token'):
            self.expect_stop('credential_destination_stopped', guard.request_kind,
                             VTT, 'GET', None, {name: 'DO-NOT-PRINT'}, proof.POST_ID)
        self.expect_stop('impersonation_stopped', guard.request_kind,
                         GUEST, 'POST', b'', {'User-Agent': 'Googlebot'}, proof.POST_ID)

    def test_no_follow_redirects(self):
        self.expect_stop('redirect_stopped', guard.NoRedirect().redirect_request,
                         None, None, 302, 'Found', {}, 'https://x.com/i/flow/login')

    def test_access_denial_is_terminal_and_body_is_not_read(self):
        for status in (401, 403, 429):
            transport = guard.PublicTransport(proof.POST_ID)
            private = io.BytesIO(b'DO-NOT-PRINT')
            error = urllib.error.HTTPError(GUEST, status, 'DO-NOT-PRINT', {}, private)
            with patch.object(transport.opener, 'open', side_effect=error) as send:
                self.expect_stop('access_restricted', transport.send, GUEST, 'POST', b'', {})
            self.assertEqual(send.call_count, 1)
            self.assertEqual(transport.bytes_read, 0)
            self.assertTrue(private.closed)

    def test_200_api_errors_and_unavailable_posts_stop(self):
        cases = [(b'{"errors":[{"message":"private"}]}', 'api_error_stopped'),
                 (b'{"data":{"tweetResult":{"result":{"__typename":"TweetUnavailable"}}}}', 'post_unavailable_stopped'),
                 (b'<html>challenge</html>', 'non_json_response_stopped')]
        for body, outcome in cases:
            transport = guard.PublicTransport(proof.POST_ID)
            with patch.object(transport.opener, 'open', return_value=Response(body)) as send:
                self.expect_stop(outcome, transport.send, METADATA, 'GET', None, {})
            self.assertEqual(send.call_count, 1)

    def test_caption_transport_has_honest_fixed_agent_and_no_cookie_handler(self):
        transport = guard.PublicTransport(proof.POST_ID)
        with patch.object(transport.opener, 'open', return_value=Response(BODY)) as send:
            actual, _, _ = transport.send(VTT, 'GET', None, {})
        self.assertEqual(actual, BODY)
        request = send.call_args.args[0]
        self.assertEqual(request.get_header('User-agent'), 'Coconut-public-caption-proof/1.0')
        self.assertEqual(request.get_header('Accept-encoding'), 'identity')
        self.assertFalse(any(isinstance(item, __import__('urllib.request', fromlist=['HTTPCookieProcessor']).HTTPCookieProcessor)
                             for item in transport.opener.handlers))

    def test_encrypted_manifest_never_reaches_downloader(self):
        for tag in (b'#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://outside.invalid/key"',
                    b'#EXT-X-KEY:METHOD=AES-128,URI="https://outside.invalid/key"',
                    b'#EXT-X-SESSION-KEY:METHOD=AES-128,URI="https://outside.invalid/key"'):
            transport = guard.PublicTransport(proof.POST_ID)
            with patch.object(transport.opener, 'open', return_value=Response(b'#EXTM3U\n' + tag + b'\n')):
                self.expect_stop('encrypted_manifest_stopped', transport.send,
                                 'https://video.twimg.com/captions.m3u8', 'GET', None, {})

    def test_request_and_time_budgets(self):
        transport = guard.PublicTransport(proof.POST_ID)
        transport.counts['caption'] = guard.MAX_REQUESTS
        with patch.object(transport.opener, 'open') as send:
            self.expect_stop('request_limit_reached', transport.send, VTT, 'GET', None, {})
            send.assert_not_called()
        transport.counts['caption'] = 0
        transport.started -= guard.MAX_SECONDS + 1
        self.expect_stop('deadline_reached', transport.send, VTT, 'GET', None, {})

    def test_never_refresh_guest_or_retry_post(self):
        transport = guard.PublicTransport(proof.POST_ID)
        for url, method, body, kind in [(GUEST, 'POST', b'', 'guest_activation'),
                                        (METADATA, 'GET', None, 'post_metadata')]:
            transport.counts[kind] = 1
            self.expect_stop('repeat_metadata_stopped', transport.send, url, method, body, {})

    def test_byte_budgets_and_content_guards(self):
        cases = [(VTT, b'x' * (guard.MAX_RESPONSE_BYTES + 1), 'response_limit_reached'),
                 (VTT, b'<html>Sign in</html>', 'non_caption_response_stopped'),
                 ('https://video.twimg.com/master.m3u8', b'media bytes', 'non_manifest_response_stopped')]
        for url, body, outcome in cases:
            transport = guard.PublicTransport(proof.POST_ID)
            with patch.object(transport.opener, 'open', return_value=Response(body)):
                self.expect_stop(outcome, transport.send, url, 'GET', None, {})
        transport = guard.PublicTransport(proof.POST_ID)
        transport.bytes_read = guard.MAX_TOTAL_BYTES
        with patch.object(transport.opener, 'open', return_value=Response(BODY)):
            self.expect_stop('total_byte_limit_reached', transport.send, VTT, 'GET', None, {})

    def fixture_document(self, directory):
        path = directory / 'captions.en.vtt'
        path.write_bytes(BODY)
        document = subtitle_document(path, 'Authored test', proof.SOURCE_URL, kind='platform_subtitles', language='en')
        document['provenance'].update(source_platform='x', subtitle_check='found', media_id='1234', media_duration=4.125)
        return document

    def test_actual_parser_preserves_timestamps_and_export_roundtrip(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            document = self.fixture_document(directory)
            report = proof.verify_document(document, directory)
        self.assertEqual(report['cues'], 3)
        self.assertEqual(report['first_start_seconds'], .220)
        self.assertEqual(report['last_end_seconds'], 3.750)
        self.assertTrue(report['raw_timestamps_preserved'])
        self.assertNotIn('Authored', json.dumps(report))

    def test_no_caption_never_passes(self):
        self.expect_stop('no_suitable_public_captions', proof.verify_document, None, Path('/tmp'))

    def test_media_file_or_changed_timestamp_never_passes(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            document = self.fixture_document(directory)
            (directory / 'source.mp4').write_bytes(b'forbidden')
            self.expect_stop('caption_only_files_check_failed', proof.verify_document, document, directory)
            (directory / 'source.mp4').unlink()
            document['segments'][0]['start'] = .221
            self.expect_stop('caption_roundtrip_check_failed', proof.verify_document, document, directory)

    def test_main_redacts_all_upstream_logs_and_cleans_files(self):
        seen = []
        def fail(transport, directory):
            seen.append(directory)
            (directory / 'captions.en.vtt').write_bytes(BODY)
            print('DO-NOT-PRINT-TOKEN-OR-CAPTION')
            raise ValueError('DO-NOT-PRINT-SIGNED-URL')
        stdout = io.StringIO()
        with patch.object(proof, 'run_proof', fail), contextlib.redirect_stdout(stdout):
            self.assertEqual(proof.main(), 1)
        result = json.loads(stdout.getvalue())
        self.assertEqual(result['outcome'], 'extraction_or_validation_failed')
        self.assertNotIn('DO-NOT-PRINT', stdout.getvalue())
        self.assertFalse(seen[0].exists())


class IsolatedCaptionAPITests(unittest.TestCase):
    fixture_document = PublicCaptionGuardTests.fixture_document
    @contextlib.contextmanager
    def fake_guard(self, transport):
        transport.counts.update(guest_activation=1, post_metadata=1, caption=1)
        yield

    def test_api_preserves_private_bytes_and_honest_provenance(self):
        import subtitle_import
        def caption(url, directory, language):
            document = self.fixture_document(directory)
            document['provenance'].update(caption_method='platform_provided', language_basis='single_track', caption_track='en')
            return document
        stdout = io.StringIO()
        with patch.object(guard, 'guarded_extractor', self.fake_guard), patch.object(subtitle_import, 'fetch_subtitle_document', caption), contextlib.redirect_stdout(stdout):
            result = guard.extract_public_captions(proof.SOURCE_URL)
        self.assertEqual(result['bytes'], BODY)
        self.assertEqual(result['format'], 'vtt')
        self.assertEqual(result['source']['url'], proof.SOURCE_URL)
        self.assertFalse(result['source']['automatic'])
        self.assertEqual(result['track']['captionMethod'], 'platform_provided')
        self.assertEqual(result['track']['reviewStatus'], 'unreviewed')
        self.assertEqual(result['track']['captionTrack'], 'en')
        self.assertEqual(stdout.getvalue(), '')

    def test_api_denial_is_redacted(self):
        @contextlib.contextmanager
        def deny(_):
            raise guard.StopProof('access_restricted')
            yield
        with patch.object(guard, 'guarded_extractor', deny):
            self.assertEqual(guard.extract_public_captions(proof.SOURCE_URL), {'status': 'access_restricted'})

    def test_api_rejects_non_x_and_arbitrary_options(self):
        for url, language in [('https://youtu.be/abcdefghijk', None),
                              (proof.SOURCE_URL, '--cookies-from-browser chrome'),
                              ('https://x.com/i/flow/login', None)]:
            with patch.object(guard, 'guarded_extractor') as extract:
                self.assertEqual(guard.extract_public_captions(url, language), {'status': 'unavailable'})
                extract.assert_not_called()

    def test_api_reports_missing_language_without_guessing(self):
        import subtitle_import
        def ambiguous(url, directory, language):
            subtitle_import.select_track({'subtitles': {'en': [{'ext': 'vtt'}], 'zh': [{'ext': 'vtt'}]}})
            raise subtitle_import.SubtitleRetrievalError('private error')
        with patch.object(guard, 'guarded_extractor', self.fake_guard), patch.object(subtitle_import, 'fetch_subtitle_document', ambiguous):
            self.assertEqual(guard.extract_public_captions(proof.SOURCE_URL), {'status': 'language_required'})


@unittest.skipUnless(importlib.util.find_spec('yt_dlp'), 'Pinned yt-dlp is exercised in the live-proof CI job')
class PinnedExtractorFullPathTests(unittest.TestCase):
    def fixture_opener(self, encrypted=False):
        metadata = {'data': {'tweetResult': {'result': {'__typename': 'Tweet', 'legacy': {
            'id_str': proof.POST_ID, 'full_text': 'Authored offline fixture',
            'extended_entities': {'media': [{'id_str': '1234', 'type': 'video', 'video_info': {
                'duration_millis': 4000, 'variants': [{'url': 'https://video.twimg.com/master.m3u8',
                'content_type': 'application/x-mpegURL'}]}}]}}}}}}
        master = b'#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="https://video.twimg.com/captions.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,SUBTITLES="subs"\nhttps://video.twimg.com/video.m3u8\n'
        captions = (b'#EXTM3U\n#EXT-X-TARGETDURATION:4\n'
                    + (b'#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://outside.invalid/key"\n' if encrypted else b'')
                    + b'#EXTINF:4.0,\nhttps://video.twimg.com/captions.vtt\n#EXT-X-ENDLIST\n')
        def open_fixture(request, timeout):
            kind = guard.request_kind(request.full_url, request.method, request.data, dict(request.header_items()), proof.POST_ID)
            if kind == 'guest_activation':
                body = b'{"guest_token":"offline-fixture"}'
            elif kind == 'post_metadata':
                body = json.dumps(metadata).encode()
            elif request.full_url.endswith('/master.m3u8'):
                body = master
            elif request.full_url.endswith('/captions.m3u8'):
                body = captions
            elif kind == 'caption':
                body = BODY
            else:
                raise AssertionError('Unexpected fixture request')
            return Response(body)
        return open_fixture

    def test_real_extractor_hls_caption_to_production_document(self):
        import subtitle_import
        transport = guard.PublicTransport(proof.POST_ID)
        with tempfile.TemporaryDirectory() as temporary, patch.object(transport.opener, 'open', side_effect=self.fixture_opener()), guard.guarded_extractor(transport):
            document = subtitle_import.fetch_subtitle_document(proof.SOURCE_URL, Path(temporary), 'en')
            result = proof.verify_document(document, Path(temporary))
        self.assertEqual(result['cues'], 3)
        self.assertEqual(transport.counts, {'guest_activation': 1, 'post_metadata': 1, 'manifest': 2, 'caption': 1})

    def test_real_extractor_encrypted_hls_stops_before_ffmpeg(self):
        import subtitle_import
        from yt_dlp.downloader.external import FFmpegFD
        transport = guard.PublicTransport(proof.POST_ID)
        with tempfile.TemporaryDirectory() as temporary, patch.object(transport.opener, 'open', side_effect=self.fixture_opener(encrypted=True)), guard.guarded_extractor(transport), patch.object(FFmpegFD, 'real_download') as external:
            with self.assertRaises(guard.StopProof) as stopped:
                subtitle_import.fetch_subtitle_document(proof.SOURCE_URL, Path(temporary), 'en')
        self.assertEqual(stopped.exception.outcome, 'encrypted_manifest_stopped')
        external.assert_not_called()
        self.assertEqual(transport.counts['caption'], 0)

    def test_external_and_process_paths_are_independently_disabled(self):
        import subprocess
        from yt_dlp.downloader.external import FFmpegFD, ExternalFD
        transport = guard.PublicTransport(proof.POST_ID)
        with guard.guarded_extractor(transport):
            self.assertFalse(FFmpegFD.available())
            for target in (lambda: FFmpegFD.real_download(None, 'ignored', {}),
                           lambda: ExternalFD.real_download(None, 'ignored', {}),
                           lambda: FFmpegFD._call_downloader(None, 'ignored', {}),
                           lambda: subprocess.Popen(['must-never-execute'])):
                with self.assertRaises(guard.StopProof) as stopped:
                    target()
                self.assertEqual(stopped.exception.outcome, 'external_execution_stopped')


if __name__ == '__main__':
    unittest.main()
