"""Narrow transport for official yt-dlp's anonymous X guest caption route.

Reusable guard, not an enabled product capability. A caller must supply one
validated post ID, enforce MAX_SECONDS externally, keep output ephemeral and
suppress upstream logs. No credentials or platform token literals are stored here.
"""
from __future__ import annotations

import contextlib
import io
import json
import re
import time
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch

PINNED_VERSION = '2026.08.19'
MAX_SECONDS = 120
MAX_REQUESTS = 12
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 12 * 1024 * 1024


class StopProof(BaseException):
    """Fail closed, without being swallowed by extractor retries/fallbacks."""
    def __init__(self, outcome: str):
        self.outcome = outcome


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise StopProof('redirect_stopped')


def request_kind(url: str, method: str, data, headers: dict, post_id: str) -> str:
    """Never admit media bytes, a different post, or a fallback access route."""
    parsed = urlparse(url)
    if (parsed.scheme != 'https' or parsed.username or parsed.password
            or parsed.port not in (None, 443) or parsed.fragment):
        raise StopProof('request_scope_stopped')
    lower = {name.lower(): value for name, value in headers.items()}
    if any(name in lower for name in ('cookie', 'x-csrf-token', 'proxy-authorization')):
        raise StopProof('credential_input_stopped')
    if any(word in lower.get('user-agent', '').lower() for word in ('googlebot', 'bingbot')):
        raise StopProof('impersonation_stopped')
    if parsed.hostname == 'api.x.com' and parsed.path == '/1.1/guest/activate.json':
        if method == 'POST' and data == b'' and not parsed.query:
            return 'guest_activation'
    if parsed.hostname == 'x.com' and re.fullmatch(r'/i/api/graphql/[A-Za-z0-9_-]+/TweetResultByRestId', parsed.path):
        try:
            variables = json.loads(parse_qs(parsed.query)['variables'][0])
        except (KeyError, ValueError, IndexError):
            raise StopProof('request_scope_stopped') from None
        if method == 'GET' and data is None and variables.get('tweetId') == post_id:
            return 'post_metadata'
    if parsed.hostname == 'video.twimg.com' and method == 'GET' and data is None:
        if any(name in lower for name in ('authorization', 'x-guest-token')):
            raise StopProof('credential_destination_stopped')
        if parsed.path.endswith('.m3u8'):
            return 'manifest'
        if parsed.path.endswith('.vtt'):
            return 'caption'
    raise StopProof('request_scope_stopped')


class PublicTransport:
    def __init__(self, post_id: str):
        if not re.fullmatch(r'\d{1,20}', post_id):
            raise ValueError('A numeric X post ID is required')
        self.post_id = post_id
        self.started = time.monotonic()
        self.counts = dict.fromkeys(('guest_activation', 'post_metadata', 'manifest', 'caption'), 0)
        self.bytes_read = 0
        # No environment proxy, cookie processor, browser profile or login flow.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def send(self, url, method, data, headers):
        kind = request_kind(url, method, data, headers, self.post_id)
        if time.monotonic() - self.started >= MAX_SECONDS:
            raise StopProof('deadline_reached')
        if sum(self.counts.values()) >= MAX_REQUESTS:
            raise StopProof('request_limit_reached')
        if kind in ('guest_activation', 'post_metadata') and self.counts[kind]:
            raise StopProof('repeat_metadata_stopped')
        self.counts[kind] += 1
        headers = dict(headers)
        # One stable, honest agent; never rotate identity after a denial.
        headers['User-Agent'] = 'Coconut-public-caption-proof/1.0'
        headers['Accept-Encoding'] = 'identity'
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=15) as response:
                status = response.status
                if status != 200:
                    raise StopProof('http_response_stopped')
                if response.headers.get('Content-Encoding', 'identity') != 'identity':
                    raise StopProof('unexpected_encoding_stopped')
                body = response.read(MAX_RESPONSE_BYTES + 1)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise StopProof('response_limit_reached')
                self.bytes_read += len(body)
                if self.bytes_read > MAX_TOTAL_BYTES:
                    raise StopProof('total_byte_limit_reached')
                if kind in ('guest_activation', 'post_metadata'):
                    try:
                        payload = json.loads(body)
                    except (ValueError, UnicodeError):
                        raise StopProof('non_json_response_stopped') from None
                    # 200 responses can still express an access denial. Stop on
                    # any API error; never rotate guest sessions or try syndication.
                    if not isinstance(payload, dict) or payload.get('errors'):
                        raise StopProof('api_error_stopped')
                    if kind == 'post_metadata':
                        result = payload.get('data', {}).get('tweetResult', {}).get('result', {})
                        if result.get('__typename') in ('TweetUnavailable', 'TweetTombstone') or 'tombstone' in result:
                            raise StopProof('post_unavailable_stopped')
                elif kind == 'manifest' and not body.lstrip().startswith(b'#EXTM3U'):
                    raise StopProof('non_manifest_response_stopped')
                elif kind == 'caption' and not body.lstrip(b'\xef\xbb\xbf \r\n\t').startswith(b'WEBVTT'):
                    raise StopProof('non_caption_response_stopped')
                return body, dict(response.headers), status
        except urllib.error.HTTPError as error:
            # Do not read or log upstream error bodies, URLs, headers or tokens.
            code = error.code
            error.close()
            raise StopProof('access_restricted' if code in (401, 403, 429)
                            else 'http_error_stopped') from None
        except (urllib.error.URLError, OSError):
            raise StopProof('transport_unavailable') from None



@contextlib.contextmanager
def guarded_extractor(transport: PublicTransport):
    try:
        import yt_dlp
        from yt_dlp.version import __version__
        from yt_dlp.globals import plugin_dirs
        from yt_dlp.networking import Request, Response
    except ImportError:
        raise StopProof('pinned_dependency_missing') from None
    if __version__ != PINNED_VERSION:
        raise StopProof('pinned_dependency_mismatch')
    # The public Python API otherwise searches ambient plugin directories.
    plugin_dirs.value = []
    from yt_dlp.extractor.twitter import TwitterIE

    class GuardedTwitterIE(TwitterIE):
        def _call_syndication_api(self, *args, **kwargs):
            raise StopProof('syndication_fallback_stopped')

        def _generate_syndication_token(self, *args, **kwargs):
            raise StopProof('syndication_fallback_stopped')

        def raise_login_required(self, *args, **kwargs):
            raise StopProof('login_required')

    class CaptionOnlyDL(yt_dlp.YoutubeDL):
        def __init__(self, settings):
            settings = dict(settings, cookiefile=None, cookiesfrombrowser=None,
                            username=None, password=None, usenetrc=False,
                            proxy='', cachedir=False, retries=0, extractor_retries=0,
                            fragment_retries=0, file_access_retries=0, socket_timeout=15,
                            skip_download=True, check_formats=False, fixup='never',
                            js_runtimes={}, remote_components=[], postprocessors=[],
                            extractor_args={'twitter': {'api': ['graphql']}},
                            http_headers={'User-Agent': 'Coconut-public-caption-proof/1.0'})
            super().__init__(settings, auto_init=False)
            self.add_info_extractor(GuardedTwitterIE())

        def urlopen(self, request):
            if isinstance(request, str):
                request = Request(request)
            if not isinstance(request, Request) or request.extensions.get('impersonate'):
                raise StopProof('unsupported_request_stopped')
            body, headers, status = transport.send(request.url, request.method, request.data, dict(request.headers))
            return Response(io.BytesIO(body), request.url, headers, status=status)

    with patch.object(yt_dlp, 'YoutubeDL', CaptionOnlyDL):
        yield
