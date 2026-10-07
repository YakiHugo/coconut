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
import ssl
import subprocess
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
    def __init__(self, post_id: str, *, ca_file: str | None = None):
        if not re.fullmatch(r'\d{1,20}', post_id):
            raise ValueError('A numeric X post ID is required')
        self.post_id = post_id
        self.started = time.monotonic()
        self.counts = dict.fromkeys(('guest_activation', 'post_metadata', 'manifest', 'caption'), 0)
        self.bytes_read = 0
        # No environment proxy, cookie processor, browser profile or login flow.
        context = ssl.create_default_context(cafile=ca_file)
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPSHandler(context=context))

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
                elif kind == 'manifest':
                    if not body.lstrip().startswith(b'#EXTM3U'):
                        raise StopProof('non_manifest_response_stopped')
                    # HlsFD can delegate unsupported encryption to FFmpegFD,
                    # which would bypass this transport. No keys/decryption
                    # are part of this public caption-only route.
                    if re.search(br'(?im)^\s*#EXT-X-(?:SESSION-)?KEY\s*:', body) or b'#EXT-X-FAXS-CM:' in body:
                        raise StopProof('encrypted_manifest_stopped')
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
        from yt_dlp.globals import plugin_dirs, plugin_ies, plugin_pps
        from yt_dlp.networking import Request, Response
    except ImportError:
        raise StopProof('pinned_dependency_missing') from None
    if __version__ != PINNED_VERSION:
        raise StopProof('pinned_dependency_mismatch')
    if plugin_ies.value or plugin_pps.value:
        raise StopProof('preloaded_plugins_stopped')
    # The public Python API otherwise searches ambient plugin directories.
    plugin_dirs.value = []
    from yt_dlp.extractor.twitter import TwitterIE
    from yt_dlp.downloader.external import ExternalFD, FFmpegFD
    from yt_dlp.postprocessor.ffmpeg import FFmpegPostProcessor

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
                            skip_download=True, check_formats=False, fixup='never', format='best',
                            external_downloader={}, external_downloader_args={}, hls_prefer_native=True,
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

    def stop_external(*args, **kwargs):
        raise StopProof('external_execution_stopped')

    # These are independent of URL filtering: unsupported HLS must never hand
    # its URLs to ffmpeg/curl/etc. Prevent probes as well as actual processes.
    with contextlib.ExitStack() as stack:
        stack.enter_context(patch.object(yt_dlp, 'YoutubeDL', CaptionOnlyDL))
        for downloader in (ExternalFD, FFmpegFD):
            stack.enter_context(patch.object(downloader, 'real_download', stop_external))
            stack.enter_context(patch.object(downloader, '_call_downloader', stop_external))
            stack.enter_context(patch.object(downloader, 'available', return_value=False))
        stack.enter_context(patch.object(FFmpegPostProcessor, 'available', property(lambda _: False)))
        stack.enter_context(patch.object(subprocess.Popen, '__init__', stop_external))
        yield


def extract_public_captions(url: str, language: str | None = None, *, ca_file: str | None = None) -> dict:
    """Isolated-process API; bytes are private VTT, never a download URL.

    Intended for a fixed JSON helper protocol, not arbitrary yt-dlp arguments.
    Uses Coconut's existing language/provenance rules (subtitle_import.py and
    transcript.py; standard library only). Run on the child process main thread.
    A platform-provided track is not evidence of manual/human authorship.
    The native launcher passes its bundled certifi.where() as ca_file; this is
    an internal trust-store choice, never a user-supplied protocol option.
    """
    import math
    import os
    from pathlib import Path
    import signal
    import tempfile
    import threading
    import subtitle_import

    if threading.current_thread() is not threading.main_thread() or not hasattr(signal, 'SIGALRM'):
        return {'status': 'unavailable'}
    try:
        subtitle_import.validate_video_url(url)
        parsed = urlparse(url)
        if parsed.hostname not in {'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'}:
            return {'status': 'unavailable'}
        post_id = parsed.path.rstrip('/').rsplit('/', 1)[-1]
        if language is not None and (not isinstance(language, str) or not re.fullmatch(r'[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*', language)):
            return {'status': 'unavailable'}
        transport = PublicTransport(post_id, ca_file=ca_file)
    except (TypeError, ValueError, OSError):
        return {'status': 'unavailable'}

    language_required = False
    original_select = subtitle_import.select_track

    def remember_selection(info, hint=None):
        nonlocal language_required
        selected = original_select(info, hint)
        if selected is None and subtitle_import.preferred_language(info, hint)[0] is None:
            language_required = any(
                key not in ('live_chat', 'danmaku') and subtitle_import.eligible_formats(tracks)
                for field in ('subtitles', 'automatic_captions')
                for key, tracks in (info.get(field) or {}).items())
        return selected

    def deadline(*_):
        raise StopProof('deadline_reached')

    previous_handler = signal.signal(signal.SIGALRM, deadline)
    signal.alarm(MAX_SECONDS)
    try:
        with open(os.devnull, 'w') as silent, contextlib.redirect_stdout(silent), contextlib.redirect_stderr(silent):
            with tempfile.TemporaryDirectory(prefix='coconut-public-caption-') as temporary:
                directory = Path(temporary)
                with guarded_extractor(transport), patch.object(subtitle_import, 'select_track', remember_selection):
                    document = subtitle_import.fetch_subtitle_document(url, directory, language)
                if document is None:
                    return {'status': 'unavailable'}
                if (transport.counts['guest_activation'] != 1 or transport.counts['post_metadata'] != 1
                        or not transport.counts['caption']):
                    return {'status': 'unavailable'}
                provenance = document['provenance']
                duration = provenance.get('media_duration')
                files = list(directory.iterdir())
                if (len(files) != 1 or files[0].suffix != '.vtt' or not files[0].is_file()
                        or not re.fullmatch(r'\d{1,20}', str(provenance.get('media_id', '')))
                        or not isinstance(duration, (int, float)) or isinstance(duration, bool)
                        or not math.isfinite(duration) or not 0 < duration <= 21600):
                    return {'status': 'unavailable'}
                body = files[0].read_bytes()
                if len(body) > MAX_RESPONSE_BYTES:
                    return {'status': 'unavailable'}
                return {
                    'source': {'url': url, 'id': provenance['media_id'], 'title': document['title'],
                               'duration': duration, 'language': provenance['language'],
                               'automatic': provenance['caption_method'] == 'automatic',
                               'extractor': 'twitter', 'translated': False, 'live': False},
                    'track': {'language': provenance['language'],
                              'captionMethod': provenance['caption_method'],
                              'languageBasis': provenance['language_basis'],
                              'captionTrack': provenance['caption_track'],
                              'reviewStatus': 'unreviewed'},
                    'format': 'vtt', 'bytes': body,
                }
    except StopProof as stopped:
        return {'status': 'access_restricted' if stopped.outcome in (
            'access_restricted', 'login_required', 'post_unavailable_stopped') else 'unavailable'}
    except Exception:
        return {'status': 'language_required' if language_required else 'unavailable'}
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous_handler)
