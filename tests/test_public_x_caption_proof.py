"""Offline policy/validation tests. These do not claim live caption availability."""
import contextlib
import io
import json
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


if __name__ == '__main__':
    unittest.main()
