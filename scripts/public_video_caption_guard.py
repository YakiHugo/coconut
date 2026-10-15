"""Development-only captions: pinned official extractors, bounded public transport.

Site parsing stays upstream. No login, ambient cookies, media bytes, token
providers, external processes, redirects or alternate clients after a denial.
"""
from __future__ import annotations
import contextlib
import io
import http.client
import ipaddress
import socket
import json
import math
import re
import ssl
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch
from scripts.public_x_caption_guard import StopProof, NoRedirect, PINNED_VERSION
import subtitle_import

MAX_REQUESTS = 32
MAX_RESPONSE = 4 * 1024 * 1024
MAX_TOTAL = 24 * 1024 * 1024
MAX_CAPTION = 1024 * 1024


# Match the bridge's public-network boundary independently of DNS/TLS trust.
V4_EXCLUDED = tuple(map(ipaddress.ip_network, ('0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10',
    '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
    '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
    '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4')))
V6_EXCLUDED = tuple(map(ipaddress.ip_network, ('2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20')))


def public_address(value):
    try:
        if '%' in value:
            return False
        address = ipaddress.ip_address(value)
        if not address.is_global:
            return False
        if address.version == 4:
            return not any(address in network for network in V4_EXCLUDED)
        return address in ipaddress.ip_network('2000::/3') and not any(address in network for network in V6_EXCLUDED)
    except ValueError:
        return False


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    def connect(self):
        if self._tunnel_host or self.source_address:
            raise StopProof('request_scope_stopped')
        records = socket.getaddrinfo(self.host, self.port, socket.AF_UNSPEC, socket.SOCK_STREAM)
        if not records or any(family not in (socket.AF_INET, socket.AF_INET6) or
                socktype != socket.SOCK_STREAM or not public_address(address[0])
                for family, socktype, _protocol, _canonname, address in records):
            raise StopProof('non_public_address')
        family, socktype, protocol, _, address = records[0]
        # Connect this numeric sockaddr directly. Never invoke create_connection,
        # which would resolve the hostname again after validation (DNS rebinding).
        raw = socket.socket(family, socktype, protocol)
        try:
            raw.settimeout(self.timeout)
            raw.connect(address)
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


class PublicHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, request):
        return self.do_open(PinnedHTTPSConnection, request, context=self._context)


def source_identity(url):
    subtitle_import.validate_video_url(url)
    p = urlparse(url)
    if p.hostname == 'www.youtube.com' and p.path == '/watch':
        identity = parse_qs(p.query).get('v', [''])[0]
        if re.fullmatch(r'[A-Za-z0-9_-]{11}', identity):
            return 'youtube', identity
    if p.hostname == 'www.bilibili.com':
        match = re.fullmatch(r'/video/(BV[A-Za-z0-9]{10})/?', p.path)
        if match:
            return 'bilibili', match[1]
    raise ValueError('Canonical public video URL required')


class VideoTransport:
    def __init__(self, url, ca_file=None):
        self.provider, self.identity = source_identity(url)
        self.count = self.total = self.responses = 0
        self.stage = 'initialization'
        self.youtube_access_verified = False
        self.started = time.monotonic()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
            PublicHTTPSHandler(context=ssl.create_default_context(cafile=ca_file)))

    def kind(self, url, method, data, headers):
        p = urlparse(url)
        q = parse_qs(p.query, keep_blank_values=True)
        if (p.scheme != 'https' or p.username or p.password or p.port not in (None, 443) or p.fragment
                or any(part in ('.', '..') for part in p.path.split('/'))
                or any(k.lower() in ('cookie', 'authorization', 'proxy-authorization', 'x-csrf-token') for k in headers)):
            raise StopProof('request_scope_stopped')
        if self.provider == 'youtube' and p.hostname == 'www.youtube.com':
            if method == 'GET' and data is None:
                if p.path == '/watch' and q.get('v') == [self.identity]:
                    return 'webpage'
                if (p.path == '/api/timedtext' and q.get('v') == [self.identity]
                        and q.get('fmt') in (['vtt'], ['srt'], ['json3']) and 'tlang' not in q):
                    return 'caption'
            if p.path in ('/youtubei/v1/player', '/youtubei/v1/next') and method == 'POST':
                payload = json.loads(data)
                if payload.get('videoId') == self.identity and payload.get('context', {}).get('client', {}).get('clientName') == 'WEB':
                    return 'metadata'
        if self.provider == 'bilibili' and method == 'GET' and data is None:
            if p.hostname == 'www.bilibili.com' and p.path.rstrip('/') == '/video/' + self.identity:
                return 'webpage'
            if p.hostname == 'api.bilibili.com' and p.path in (
                    '/x/web-interface/nav', '/x/web-interface/wbi/view/detail',
                    '/x/player/pagelist', '/x/player/wbi/playurl', '/x/player/wbi/v2'):
                return 'metadata'
            if (p.hostname in ('aisubtitle.hdslb.com', 'subtitle.bilibili.com', 'subtitle.hdslb.com', 'i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com')
                    and re.fullmatch(r'/bfs/(?:ai_subtitle|subtitle)/[A-Za-z0-9_./-]+\.json', p.path)):
                return 'caption'
        raise StopProof('request_scope_stopped')

    def verify_youtube_player(self, player):
        status = player.get('playabilityStatus', {}).get('status')
        if status is None:
            raise StopProof('metadata_incomplete')
        if status != 'OK':
            raise StopProof('access_restricted')
        identity = player.get('videoDetails', {}).get('videoId')
        if identity is None:
            raise StopProof('metadata_incomplete')
        if identity != self.identity:
            raise StopProof('identity_mismatch')
        self.youtube_access_verified = True

    def send(self, request):
        kind = self.kind(request.url, request.method, request.data, dict(request.headers))
        if self.count >= MAX_REQUESTS or time.monotonic() - self.started > 120:
            raise StopProof('budget_exceeded')
        self.count += 1
        headers = dict(request.headers)
        headers.update({'User-Agent': 'Coconut-public-captions/1.0', 'Accept-Encoding': 'identity'})
        req = urllib.request.Request(request.url, data=request.data, headers=headers, method=request.method)
        try:
            with self.opener.open(req, timeout=15) as response:
                self.responses += 1
                if response.status != 200 or response.headers.get('Content-Encoding', 'identity') != 'identity':
                    raise StopProof('unexpected_response')
                limit = MAX_CAPTION if kind == 'caption' else MAX_RESPONSE
                body = response.read(limit + 1)
                self.total += len(body)
                if len(body) > limit or self.total > MAX_TOTAL:
                    raise StopProof('budget_exceeded')
                if kind == 'metadata' or self.provider == 'bilibili' and kind == 'caption':
                    payload = json.loads(body)
                    if self.provider == 'bilibili':
                        anonymous_nav = (urlparse(request.url).path == '/x/web-interface/nav' and
                            payload.get('code') == -101 and isinstance(payload.get('data'), dict) and payload['data'].get('wbi_img'))
                        if not anonymous_nav and payload.get('code', 0) in (-101, -403, -352, -412, 401, 403, 429):
                            raise StopProof('access_restricted')
                        if not anonymous_nav and payload.get('code', 0) != 0:
                            raise StopProof('upstream_error')
                        if isinstance(payload.get('data'), dict) and payload['data'].get('need_login_subtitle'):
                            raise StopProof('access_restricted')
                    elif urlparse(request.url).path == '/youtubei/v1/player':
                        self.verify_youtube_player(payload)
                return body, dict(response.headers), response.status
        except urllib.error.HTTPError as error:
            self.responses += 1
            code = error.code
            error.close()
            raise StopProof('access_restricted' if code in (401, 403, 412, 429) else 'upstream_error') from None
        except (urllib.error.URLError, OSError):
            raise StopProof('transport_unavailable') from None


@contextlib.contextmanager
def guarded_extractors(transport):
    import yt_dlp
    from yt_dlp.version import __version__
    from yt_dlp.globals import plugin_dirs, plugin_ies, plugin_pps, all_plugins_loaded
    from yt_dlp.networking import Request, Response
    from yt_dlp.extractor.youtube import YoutubeIE
    from yt_dlp.extractor.bilibili import BiliBiliIE
    if __version__ != PINNED_VERSION or plugin_ies.value or plugin_pps.value:
        raise StopProof('dependency_mismatch')
    plugin_dirs.value = []
    all_plugins_loaded.value = True

    class PublicYoutubeIE(YoutubeIE):
        @classmethod
        def ie_key(cls):
            return 'Youtube'

        @staticmethod
        def _get_checkok_params():
            # Do not claim an age/content acknowledgement on the API route either.
            return {}

        def _download_initial_webpage(self, webpage_url, webpage_client, video_id):
            # Keep upstream parsing, without its age-verification query flags.
            webpage = self._download_webpage(webpage_url, video_id)
            initial = self._search_json(self._YT_INITIAL_PLAYER_RESPONSE_RE, webpage,
                                        'initial player response', video_id, default={})
            if initial:
                transport.verify_youtube_player(initial)
            return webpage

        def raise_login_required(self, *args, **kwargs):
            raise StopProof('access_restricted')

        def _report_pot_subtitles_skipped(self, *args, **kwargs):
            raise StopProof('access_restricted')

    class PublicBiliBiliIE(BiliBiliIE):
        @classmethod
        def ie_key(cls):
            return 'BiliBili'

        def _download_json(self, url, *args, **kwargs):
            # Upstream Bilibili often supplies protocol-relative subtitle URLs;
            # resolve them against this HTTPS route, never default urllib to HTTP.
            if isinstance(url, str) and url.startswith('//'):
                url = 'https:' + url
            return super()._download_json(url, *args, **kwargs)

        def _download_webpage_handle(self, *args, **kwargs):
            webpage, handle = super()._download_webpage_handle(*args, **kwargs)
            if not self._match_valid_url(handle.url):
                return webpage, handle
            state = self._search_json(r'window\.__INITIAL_STATE__\s*=', webpage, 'initial state', self._match_id(handle.url), default={})
            if state.get('videoData', {}).get('bvid') not in (None, transport.identity):
                raise StopProof('identity_mismatch')
            risk = self._search_json(r'\bwindow\._riskdata_\s*=', webpage, 'risk', self._match_id(handle.url), default={})
            if risk.get('v_voucher') or state.get('error', {}).get('trueCode') in (-403, -404) or state.get('videoData', {}).get('is_upower_exclusive'):
                raise StopProof('access_restricted')
            return webpage, handle

        def raise_login_required(self, *args, **kwargs):
            raise StopProof('access_restricted')

    class CaptionsDL(yt_dlp.YoutubeDL):
        def __init__(self, settings):
            transport.stage = 'extractor_setup'
            settings = dict(settings, cookiefile=None, cookiesfrombrowser=None,
                username=None, password=None, usenetrc=False, proxy='', cachedir=False,
                retries=0, extractor_retries=0, fragment_retries=0, file_access_retries=0,
                socket_timeout=15, skip_download=True, check_formats=False,
                ignore_no_formats_error=True, fixup='never', format='best',
                external_downloader={}, postprocessors=[], js_runtimes={}, remote_components=[],
                extractor_args={'youtube': {'player_client': ['web'], 'fetch_pot': ['never'],
                    'player_skip': ['js', 'configs', 'initial_data'], 'skip': ['hls', 'dash', 'translated_subs']}},
                http_headers={'User-Agent': 'Coconut-public-captions/1.0'})
            super().__init__(settings, auto_init=False)
            self.add_info_extractor(PublicYoutubeIE() if transport.provider == 'youtube' else PublicBiliBiliIE())

        def extract_info(self, *args, **kwargs):
            transport.stage = 'metadata'
            return super().extract_info(*args, **kwargs)

        def get_info_extractor(self, key):
            if key != ('Youtube' if transport.provider == 'youtube' else 'BiliBili'):
                raise StopProof('alternate_extractor_stopped')
            return super().get_info_extractor(key)

        def urlopen(self, request):
            if isinstance(request, str):
                request = Request(request)
            if not isinstance(request, Request) or request.extensions.get('impersonate'):
                raise StopProof('unsupported_request')
            body, headers, status = transport.send(request)
            return Response(io.BytesIO(body), request.url, headers, status=status)

        def process_ie_result(self, result, *args, **kwargs):
            if kwargs.get('download', args[0] if args else True):
                transport.stage = 'caption_download'
            # Always ordinary verified TLS; never retry with TLS impersonation.
            for field in ('subtitles', 'automatic_captions'):
                for formats in (result.get(field) or {}).values():
                    for fmt in formats:
                        fmt.pop('impersonate', None)
            return super().process_ie_result(result, *args, **kwargs)

    def stop_process(*args, **kwargs):
        raise StopProof('external_execution_stopped')

    with patch.object(yt_dlp, 'YoutubeDL', CaptionsDL), patch.object(subprocess.Popen, '__init__', stop_process):
        yield


def extract_public_video_captions(url, language=None, *, ca_file=None):
    import tempfile
    language_required = False
    completion = None
    selection_completed = False
    transport = None
    original_select = subtitle_import.select_track
    original_parse = subtitle_import.subtitle_document

    def failure(status, reason):
        return {'status': status, 'diagnostic': {'stage': transport.stage if transport else 'initialization',
                'reason': reason, 'requests_attempted': transport.count if transport else 0,
                'responses_received': transport.responses if transport else 0}}

    def parse(*args, **kwargs):
        transport.stage = 'caption_parse'
        return original_parse(*args, **kwargs)

    def select(info, hint=None):
        nonlocal language_required, completion, selection_completed
        transport.stage = 'track_selection'
        provider, identity = source_identity(url)
        subtitle_import.validate_media_info(info)
        if provider == 'youtube':
            if not transport.youtube_access_verified or info.get('live_status') not in ('not_live', 'was_live'):
                raise StopProof('metadata_incomplete')
            completion = info['live_status']
        else:
            completion = 'not_live'  # Bilibili's single VOD extractor, never its live extractor.
        media_id = str(info.get('id', ''))
        if provider == 'youtube' and media_id != identity:
            raise StopProof('identity_mismatch')
        if provider == 'bilibili' and identity.startswith('BV') and media_id != identity:
            raise StopProof('identity_mismatch')
        duration = info.get('duration')
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= 21600:
            raise StopProof('duration_unavailable')
        selected = original_select(info, hint)
        selection_completed = True
        language_required = selected is None and subtitle_import.preferred_language(info, hint)[0] is None and any(
            key not in ('danmaku', 'live_chat') and subtitle_import.eligible_formats(tracks)
            for field in ('subtitles', 'automatic_captions') for key, tracks in (info.get(field) or {}).items())
        return selected

    try:
        transport = VideoTransport(url, ca_file)
        with tempfile.TemporaryDirectory(prefix='coconut-video-captions-') as temporary:
            directory = Path(temporary)
            with guarded_extractors(transport), patch.object(subtitle_import, 'select_track', select), patch.object(subtitle_import, 'subtitle_document', parse):
                document = subtitle_import.fetch_subtitle_document(url, directory, language)
            if not document:
                if not selection_completed:
                    return failure('extractor_failed', 'extractor_error')
                return failure('language_required' if language_required else 'no_matching_captions',
                               'language_unknown' if language_required else 'no_matching_track')
            transport.stage = 'caption_output'
            files = list(directory.iterdir())
            if len(files) != 1 or files[0].suffix not in ('.vtt', '.srt') or not 0 < files[0].stat().st_size <= MAX_CAPTION:
                return failure('caption_file_invalid', 'invalid_caption_file')
            p = document['provenance']
            return {'source': {'url': url, 'id': p['media_id'], 'title': document['title'],
                'duration': p['media_duration'], 'language': p['language'],
                'automatic': p['caption_method'] == 'automatic', 'extractor': transport.provider,
                'translated': False, 'live': False, 'live_status': completion},
                'track': {'language': p['language'], 'captionMethod': p['caption_method'],
                    'languageBasis': p['language_basis'], 'captionTrack': p['caption_track'], 'reviewStatus': 'unreviewed'},
                'format': files[0].suffix[1:], 'bytes': files[0].read_bytes()}
    except StopProof as stopped:
        reasons = {'access_restricted', 'transport_unavailable', 'metadata_incomplete',
                   'request_scope_stopped', 'non_public_address', 'identity_mismatch', 'budget_exceeded',
                   'unexpected_response', 'upstream_error', 'dependency_mismatch',
                   'alternate_extractor_stopped', 'unsupported_request', 'external_execution_stopped',
                   'duration_unavailable', 'redirect_stopped'}
        reason = stopped.outcome if stopped.outcome in reasons else 'guard_stopped'
        status = {'access_restricted': 'access_restricted', 'transport_unavailable': 'network_unavailable',
                  'metadata_incomplete': 'metadata_incomplete'}.get(reason, 'guard_stopped')
        return failure(status, reason)
    except Exception:
        if language_required:
            return failure('language_required', 'language_unknown')
        if transport and transport.stage == 'caption_parse':
            return failure('caption_parse_failed', 'caption_parse_failed')
        if transport and transport.stage in ('caption_output', 'caption_download'):
            return failure('caption_file_invalid', 'caption_download_or_file_failed')
        return failure('extractor_failed', 'extractor_error')
