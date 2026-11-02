"""Owner-local video acquisition using yt-dlp's native network and downloaders.

This is not an SSRF sandbox. Only the authenticated local bridge may invoke it.
Upstream handles DNS, redirects, proxies and TLS; Coconut owns source identity,
credential policy, bounded resources and the stable result contract. No ASR.
"""
from __future__ import annotations
import copy
import hashlib
import http.cookiejar
import io
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time
import urllib.request
import urllib.response
import zlib
from urllib.parse import urlparse

import yt_dlp
from yt_dlp.downloader.http import HttpFD
from yt_dlp.extractor.bilibili import BiliBiliIE
from yt_dlp.extractor.youtube import YoutubeIE
from yt_dlp.networking import Request, Response
from yt_dlp.networking._urllib import UrllibRH as NativeUrllibRH
from yt_dlp.networking.exceptions import HTTPError, RequestError
from yt_dlp.version import __version__

import subtitle_import
from scripts.public_x_caption_guard import StopProof, PINNED_VERSION
from scripts.public_video_caption_guard import source_identity, validate_bilibili_cookies, json3_document_vtt
from scripts.public_video_media import choose_media, select_bilibili_audio_urls

MAX_CAPTION = 1024 * 1024
MAX_METADATA = 4 * 1024 * 1024
MAX_TOTAL = 24 * 1024 * 1024
MAX_MEDIA = 200 * 1024 * 1024
MAX_REQUESTS = 32  # Calls into the upstream handler, not its internal redirect hops.
PROXY_KEYS = frozenset(('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
                        'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'))


def network_options(network):
    """Validate the startup-only snapshot again at the process boundary."""
    network = network or {'mode': 'direct'}
    if not isinstance(network, dict) or network.get('mode') not in ('direct', 'custom', 'environment'):
        raise StopProof('proxy_configuration_invalid')
    mode = network['mode']
    if mode == 'direct' and set(network) == {'mode'}:
        return {'all': '__noproxy__'}
    if mode == 'custom' and set(network) == {'mode', 'proxy'}:
        proxy = network['proxy']
        if not isinstance(proxy, str) or not re.fullmatch(r'http://(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}', proxy):
            raise StopProof('proxy_configuration_invalid')
        if not 1 <= urlparse(proxy).port <= 65535:
            raise StopProof('proxy_configuration_invalid')
        return {'all': proxy}
    if mode == 'environment' and set(network) == {'mode', 'environment'}:
        environment = network['environment']
        if not isinstance(environment, dict) or set(environment) - PROXY_KEYS:
            raise StopProof('proxy_configuration_invalid')
        for name, value in environment.items():
            if not isinstance(value, str) or len(value) > (4096 if name.lower() == 'no_proxy' else 2048) or re.search(r'[\x00-\x1f\x7f]', value):
                raise StopProof('proxy_configuration_invalid')
            if name.lower() != 'no_proxy' and value:
                try:
                    parsed = urlparse(value)
                    valid = (not re.search(r'[\x00-\x20\x7f\\]', value) and '@' not in parsed.netloc
                             and parsed.scheme in ('http', 'socks4', 'socks4a', 'socks5', 'socks5h') and parsed.hostname
                             and not parsed.username and not parsed.password and parsed.path in ('', '/')
                             and not parsed.query and not parsed.fragment and (parsed.port is None or 1 <= parsed.port <= 65535))
                except ValueError:
                    valid = False
                if not valid:
                    raise StopProof('proxy_configuration_invalid')
        # Use stdlib precedence (including lowercase and NO_PROXY), never OS/PAC.
        # The helper process is single-request and has a sanitized environment.
        prior = os.environ
        try:
            os.environ = dict(environment)
            proxies = urllib.request.getproxies_environment()
        finally:
            os.environ = prior
        if 'http' in proxies and 'https' not in proxies:
            proxies['https'] = proxies['http']  # yt-dlp's normal compatibility rule.
        return proxies
    raise StopProof('proxy_configuration_invalid')


class QuietLogger:
    def __init__(self): self.warned = False
    def debug(self, _message): pass
    def warning(self, _message): self.warned = True
    def error(self, _message): pass


class RawResponseBudget(io.IOBase):
    """Bound upstream's own response/redirect reads before they allocate a body."""
    def __init__(self, response, owner):
        self.response, self.owner, self.read_bytes = response, owner, 0
        self.media = owner.stage == 'media_download'
        self.limit = MAX_MEDIA if self.media else MAX_CAPTION if owner.stage == 'caption_download' else MAX_METADATA
    def readable(self): return True
    def read(self, amount=-1):
        try:
            self.owner.check_budget()
            total = self.owner.raw_media_bytes if self.media else self.owner.raw_metadata_bytes + self.owner.expanded_metadata_bytes
            remaining = min(self.limit - self.read_bytes, (MAX_MEDIA if self.media else MAX_TOTAL) - total)
            body = self.response.read(min(amount if amount is not None and amount >= 0 else remaining + 1, remaining + 1))
            self.read_bytes += len(body)
            if self.media: self.owner.raw_media_bytes += len(body)
            else: self.owner.raw_metadata_bytes += len(body)
            if len(body) > remaining: raise StopProof('budget_exceeded')
            return body
        except BaseException:
            self.close()
            raise
    def close(self):
        self.response.close()
        super().close()


class NativeResponsePolicy(urllib.request.BaseHandler):
    # Before yt-dlp HTTPHandler (500) eagerly decodes compressed responses and
    # before urllib's redirect/error handlers consume bodies. Transport unchanged.
    handler_order = 400
    def __init__(self, owner): self.owner = owner
    def http_request(self, request):
        self.owner.check_budget()
        parsed=urlparse(request.full_url)
        if parsed.scheme != 'https' or parsed.username is not None or parsed.password is not None: raise StopProof('request_scope_stopped')
        request.add_header('Accept-Encoding', 'identity')
        return request
    https_request = ftp_request = http_request
    def http_response(self, request, response):
        self.owner.observed_response()
        reason = {401:'login_required',403:'http_access_denied',412:'http_access_denied',429:'rate_limited'}.get(response.code)
        encodings = response.headers.get_all('Content-Encoding', [])
        encoding = encodings[0].strip().lower() if len(encodings) == 1 else ''
        media = self.owner.stage == 'media_download'
        # Text endpoints may ignore identity. Decode only a single standard gzip
        # or zlib-deflate member, with both raw and expanded body limits. Media
        # must remain identity so upstream Range offsets always describe bytes.
        if (reason or len(encodings) > 1 or encoding not in ('', 'identity', 'gzip', 'deflate')
                or media and encoding not in ('', 'identity')):
            response.close()
            raise StopProof(reason or 'encoded_response_rejected')
        bounded = RawResponseBudget(response, self.owner)
        headers = response.headers
        if encoding in ('gzip', 'deflate'):
            try:
                raw = bounded.read()  # At most the stage limit, plus one overflow byte.
                self.owner.check_budget()
                remaining = min(bounded.limit, MAX_TOTAL - self.owner.raw_metadata_bytes
                                - self.owner.expanded_metadata_bytes + len(raw))
                decoder = zlib.decompressobj(31 if encoding == 'gzip' else zlib.MAX_WBITS)
                body = decoder.decompress(raw, remaining + 1)
                self.owner.check_budget()
                if len(body) > remaining: raise StopProof('budget_exceeded')
                # Never silently admit truncated data, extra members, trailing
                # bytes, raw-deflate or an unbounded flush/decompression call.
                if not decoder.eof or decoder.unconsumed_tail or decoder.unused_data:
                    raise StopProof('encoded_response_rejected')
                self.owner.expanded_metadata_bytes += max(0, len(body) - len(raw))
                headers = copy.copy(response.headers)
                del headers['Content-Encoding']
                del headers['Content-Length']
                headers['Content-Length'] = str(len(body))
                bounded = io.BytesIO(body)
            except zlib.error:
                raise StopProof('encoded_response_rejected') from None
            finally:
                response.close()
        wrapped = urllib.response.addinfourl(bounded, headers, response.url, response.code)
        wrapped.msg = response.msg
        return wrapped
    https_response = http_response


class BoundedMedia(io.IOBase):
    """Hard read budget before HttpFD writes; max_filesize alone is insufficient."""
    def __init__(self, response, owner):
        self.response, self.owner = response, owner
    def readable(self): return True
    def read(self, amount=None):
        self.owner.check_budget()
        remaining = MAX_MEDIA - self.owner.media_bytes
        body = self.response.read(min(amount if amount is not None and amount >= 0 else remaining + 1, remaining + 1))
        self.owner.media_bytes += len(body)
        if self.owner.media_bytes > MAX_MEDIA:
            raise StopProof('budget_exceeded')
        return body
    def close(self):
        self.response.close()
        super().close()


class OwnerVideoDL(yt_dlp.YoutubeDL):
    def __init__(self, url, network=None, cookies=None, *, media_only=False):
        self.provider, self.identity = source_identity(url)
        self.source_url = url
        self.media_only = media_only
        self.expected_duration = None
        self.stage = 'extractor_setup'
        self.count = self.responses = self.total = self.media_bytes = 0
        self.raw_media_bytes = self.raw_metadata_bytes = self.expanded_metadata_bytes = 0
        self.current_response_observed = False
        self.started = time.monotonic()
        self.media_url = None
        self.open_responses = []
        self.access_verified = False
        if __version__ != PINNED_VERSION:
            raise StopProof('dependency_mismatch')
        from yt_dlp.globals import plugin_dirs, plugin_ies, plugin_pps, all_plugins_loaded
        if plugin_ies.value or plugin_pps.value:
            raise StopProof('dependency_mismatch')
        plugin_dirs.value = []
        all_plugins_loaded.value = True
        self.source_logger = QuietLogger()
        settings = dict(quiet=True, no_warnings=False, logger=self.source_logger,
            cookiefile=None, cookiesfrombrowser=None, username=None, password=None,
            usenetrc=False, cachedir=False, proxy='', nocheckcertificate=False,
            socket_timeout=15, retries=0, extractor_retries=0, fragment_retries=0,
            file_access_retries=0, skip_download=True, noplaylist=True,
            writesubtitles=not media_only, writeautomaticsub=not media_only, check_formats=False,
            ignore_no_formats_error=True, format='best/bestaudio/bestvideo',
            fixup='never', external_downloader={}, postprocessors=[],
            js_runtimes={}, remote_components=[],
            extractor_args={'youtube': {'player_client': ['web'], 'fetch_pot': ['never'],
                'player_skip': ['js', 'configs', 'initial_data'], 'skip': ['hls', 'dash', 'translated_subs']}},
            http_headers={'User-Agent': 'Coconut/0.1 owner-local-source'})
        super().__init__(settings, auto_init=False)
        # Assign the cached-property value before native request-director construction.
        # No OS proxy discovery or ambient trust-store overrides are permitted.
        self.proxies = network_options(network)
        for name, value in validate_bilibili_cookies(cookies, self.provider).items():
            self.cookiejar.set_cookie(http.cookiejar.Cookie(0, name, value, None, False,
                '.bilibili.com', True, True, '/', True, True, None, True, None, None, {}))
        owner = self
        class Youtube(YoutubeIE):
            @classmethod
            def ie_key(cls): return 'Youtube'
            @staticmethod
            def _get_checkok_params(): return {}
            def raise_login_required(self, *args, **kwargs): raise StopProof('login_required')
            def _report_pot_subtitles_skipped(self, *args, **kwargs): raise StopProof('subtitle_token_required')
            def _download_initial_webpage(self, webpage_url, webpage_client, video_id):
                page = self._download_webpage(webpage_url, video_id)
                initial = self._search_json(self._YT_INITIAL_PLAYER_RESPONSE_RE, page, 'initial player response', video_id, default={})
                if initial: owner.check_player(initial)
                return page
        class Bilibili(BiliBiliIE):
            @classmethod
            def ie_key(cls): return 'BiliBili'
            def raise_login_required(self, *args, **kwargs): raise StopProof('login_required')
            def _download_webpage_handle(self, url, *args, **kwargs):
                page, handle = super()._download_webpage_handle(url, *args, **kwargs)
                state = self._search_json(r'window\.__INITIAL_STATE__\s*=', page, 'initial state', owner.identity, default={})
                if state.get('videoData', {}).get('bvid') not in (None, owner.identity): raise StopProof('identity_mismatch')
                risk = self._search_json(r'\bwindow\._riskdata_\s*=', page, 'risk', owner.identity, default={})
                code = state.get('error', {}).get('trueCode')
                if code == -403: raise StopProof('login_required')
                video = state.get('videoData', {})
                if risk.get('v_voucher') or code == -404 or video.get('is_upower_exclusive'): raise StopProof('access_restricted')
                owner.expected_duration = video.get('duration')
                return page, handle
            def _get_chapters(self, aid, cid):
                # Coconut does not consume extractor chapters. Upstream would fetch
                # the same subtitle-login API a second time solely for this field.
                return None
            def extract_formats(self, play_info):
                if play_info and (play_info.get('is_preview') or any('试看' in str(value) for value in play_info.get('accept_description', []))):
                    raise StopProof('access_restricted')
                from scripts.public_video_caption_guard import mark_single_bilibili_progressive
                return mark_single_bilibili_progressive(select_bilibili_audio_urls(super().extract_formats(play_info), play_info), play_info)
            def _download_json(self, url, *args, **kwargs):
                return super()._download_json('https:' + url if isinstance(url, str) and url.startswith('//') else url, *args, **kwargs)
        self.add_info_extractor(Youtube() if self.provider == 'youtube' else Bilibili())
        class UrllibRH(NativeUrllibRH):
            def _create_instance(self, *args, **kwargs):
                opener = super()._create_instance(*args, **kwargs)
                opener.add_handler(NativeResponsePolicy(owner))
                return opener
        # The pinned minimal runtime's native handler, plus only response policy.
        # Optional locally installed backends cannot bypass that policy.
        self._request_director = self.build_request_director([UrllibRH])

    def observed_response(self):
        # Count upstream calls that observed a response, not inner redirect hops.
        if not self.current_response_observed:
            self.responses += 1
            self.current_response_observed = True

    def check_budget(self):
        if time.monotonic() - self.started > (900 if self.stage == 'media_download' else 120):
            raise StopProof('budget_exceeded')

    def check_player(self, player):
        status = player.get('playabilityStatus', {}).get('status')
        if status != 'OK':
            raise StopProof('login_required' if status == 'LOGIN_REQUIRED' else 'access_restricted' if status else 'metadata_incomplete')
        if player.get('videoDetails', {}).get('videoId') != self.identity:
            raise StopProof('identity_mismatch')
        self.access_verified = True

    def get_info_extractor(self, key):
        if key != ('Youtube' if self.provider == 'youtube' else 'BiliBili'):
            raise StopProof('alternate_extractor_stopped')
        return super().get_info_extractor(key)

    def urlopen(self, request):
        if isinstance(request, str): request = Request(request)
        if not isinstance(request, Request) or request.proxies or request.extensions.get('impersonate'):
            raise StopProof('unsupported_request')
        parsed = urlparse(request.url)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None or parsed.password is not None
                or any(key.lower() in ('authorization', 'proxy-authorization') for key in request.headers)):
            raise StopProof('request_scope_stopped')
        self.check_budget()
        if self.count >= MAX_REQUESTS: raise StopProof('budget_exceeded')
        if self.stage == 'media_download' and request.url != self.media_url:
            raise StopProof('request_scope_stopped')
        self.count += 1
        self.current_response_observed = False
        try:
            # Crucial: upstream owns actual transport. No custom DNS/CONNECT/Range.
            response = super().urlopen(request)
        except HTTPError as error:
            self.observed_response()
            status = error.status
            error.close()
            raise StopProof({401: 'login_required', 403: 'http_access_denied', 412: 'http_access_denied',
                             429: 'rate_limited'}.get(status, 'upstream_error')) from None
        except RequestError:
            raise StopProof('transport_unavailable') from None
        self.observed_response()
        self.open_responses.append(response)
        final = urlparse(response.url)
        if final.scheme != 'https' or final.username is not None or final.password is not None:
            response.close()
            raise StopProof('request_scope_stopped')
        if self.stage == 'media_download':
            if response.status not in (200, 206) or response.headers.get('Content-Type', '').split(';')[0].lower() not in ('audio/mp4', 'video/mp4', 'application/octet-stream'):
                raise StopProof('unexpected_response')
            return Response(BoundedMedia(response, self), response.url, dict(response.headers), status=response.status)
        if response.status != 200: raise StopProof('unexpected_response')
        limit = MAX_CAPTION if self.stage == 'caption_download' else MAX_METADATA
        body = response.read(limit + 1)
        response.close()
        self.total += len(body)
        if len(body) > limit or self.total > MAX_TOTAL: raise StopProof('budget_exceeded')
        if parsed.hostname == 'api.bilibili.com':
            payload = json.loads(body)
            anonymous_nav = parsed.path == '/x/web-interface/nav' and payload.get('code') == -101 and payload.get('data', {}).get('wbi_img')
            if not anonymous_nav and payload.get('code', 0) != 0:
                raise StopProof('login_required' if payload['code'] in (-101, 401) else 'rate_limited' if payload['code'] == 429 else 'access_restricted')
            if isinstance(payload.get('data'), dict) and payload['data'].get('need_login_subtitle'):
                raise StopProof('subtitle_login_required')
        elif parsed.hostname == 'www.youtube.com' and parsed.path == '/youtubei/v1/player':
            self.check_player(json.loads(body))
        headers = {key: value for key, value in response.headers.items() if key.lower() not in ('content-length', 'content-encoding')}
        headers['Content-Length'] = str(len(body))
        return Response(io.BytesIO(body), response.url, headers, status=response.status)

    def close(self):
        for response in self.open_responses: response.close()
        super().close()


def verified_info(downloader, url):
    downloader.stage = 'metadata'
    info = downloader.extract_info(url, download=False)
    subtitle_import.validate_media_info(info)
    if str(info.get('id', '')) != downloader.identity: raise StopProof('identity_mismatch')
    duration = info.get('duration')
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= 21600:
        raise StopProof('duration_unavailable')
    if downloader.provider == 'bilibili' and isinstance(downloader.expected_duration, (int, float)) and abs(duration - downloader.expected_duration) > max(5, downloader.expected_duration * .05):
        raise StopProof('access_restricted')
    if downloader.provider == 'youtube' and (not downloader.access_verified or info.get('live_status') not in ('not_live', 'was_live')):
        raise StopProof('metadata_incomplete')
    return info


def download_media(downloader, info, output, language, subtitle_check, purpose):
    selected = choose_media(info, downloader.provider, language)
    if selected is None: return {'status': 'media_unavailable'}
    if output.exists() or output.with_suffix(output.suffix + '.part').exists():
        raise StopProof('request_scope_stopped')
    downloader.stage = 'media_download'
    downloader.media_url = selected['url']
    options = dict(downloader.params, skip_download=False, max_filesize=MAX_MEDIA,
                   continuedl=False, nopart=False, updatetime=False, http_chunk_size=8 * 1024 * 1024,
                   buffersize=64 * 1024, noresizebuffer=True, noprogress=True)
    try:
        ok, _ = HttpFD(downloader, options).download(str(output), {
            'url': selected['url'], 'ext': selected['_extension'],
            'http_headers': {'Referer': downloader.source_url}, 'protocol': 'https'})
        if not ok or not output.is_file() or not 12 <= output.stat().st_size <= MAX_MEDIA:
            raise StopProof('unexpected_response')
        with output.open('rb') as stream:
            if stream.read(12)[4:8] != b'ftyp': raise StopProof('unexpected_response')
        with output.open('rb') as stream:
            digest = hashlib.sha256()
            for chunk in iter(lambda: stream.read(64 * 1024), b''): digest.update(chunk)
            digest = digest.hexdigest()
        return {'status': 'media_ready', 'media': {'filename': output.name, 'bytes': output.stat().st_size,
            'sha256': digest, 'type': selected['_type'], 'kind': selected['_kind']},
            'source': {'url': downloader.source_url, 'id': downloader.identity, 'provider': downloader.provider,
                'title': str(info.get('title') or 'Video source')[:500], 'duration': info['duration'],
                'subtitle_check': subtitle_check, **({'purpose': 'source'} if purpose == 'source' else {}),
                'audio_language': selected['_audio_language'], 'audio_language_basis': selected['_audio_language_basis'],
                'audio_role': selected['_audio_role'], 'format': selected['_extension'],
                'format_id': str(selected.get('format_id') or '')[:80]}}
    finally:
        output.with_suffix(output.suffix + '.part').unlink(missing_ok=True)


def acquire_video(url, language=None, *, network=None, bilibili_cookies=None, output=None, purpose=None):
    downloader = None
    media_ready = False
    try:
        with OwnerVideoDL(url, network, bilibili_cookies, media_only=output is not None and purpose == 'source') as downloader:
            info = verified_info(downloader, url)
            if downloader.media_only:
                # Explicit independent media action: do not fetch or re-test subtitles,
                # and never turn their absent query into a claim of caption absence.
                result = download_media(downloader, info, output, language, 'not_requested', purpose)
                media_ready = result.get('status') == 'media_ready'
                return result
            downloader.stage = 'track_selection'
            selected = subtitle_import.select_track(info, language)
            languages = subtitle_import.available_caption_languages(info, formats=('vtt', 'srt', 'json3'))
            ambiguous = not selected and subtitle_import.preferred_language(info, language)[0] is None and bool(languages)
            if ambiguous: return {'status': 'language_required', 'languages': languages}
            if not selected and downloader.source_logger.warned:
                raise StopProof('metadata_incomplete')
            if output is not None:
                if selected and purpose != 'source': return {'status': 'captions_available'}
                result = download_media(downloader, info, output, language, 'found' if selected else 'no_matching_captions', purpose)
                media_ready = result.get('status') == 'media_ready'
                return result
            if not selected: return {'status': 'no_matching_captions'}
            field, track = selected
            formats = subtitle_import.eligible_formats(info[field][track])
            # Bilibili produces inline SRT: bound it before yt-dlp writes any file.
            if any(isinstance(item.get('data'), str) and len(item['data'].encode()) > MAX_CAPTION for item in formats):
                raise StopProof('budget_exceeded')
            info = dict(info, **{field: {track: formats}})
            with tempfile.TemporaryDirectory(prefix='coconut-source-captions-') as temporary:
                directory = Path(temporary)
                downloader.params.update(outtmpl={'default': str(directory / 'caption.%(ext)s')},
                    writesubtitles=field == 'subtitles', writeautomaticsub=field == 'automatic_captions',
                    subtitleslangs=[track], subtitlesformat='vtt/srt/json3')
                downloader.stage = 'caption_download'
                result = downloader.process_ie_result(info, download=True)
                filename = (result.get('requested_subtitles') or {}).get(track, {}).get('filepath')
                if not filename: raise StopProof('invalid_caption_file')
                file = Path(filename)
                if not file.resolve().is_relative_to(directory.resolve()) or file.is_symlink() or not file.is_file() or not 0 < file.stat().st_size <= MAX_CAPTION:
                    raise StopProof('invalid_caption_file')
                extension = file.suffix[1:]
                body = file.read_bytes()
                if extension == 'json3':
                    body = json3_document_vtt(subtitle_import.subtitle_document(file))
                    extension = 'vtt'
                automatic = subtitle_import.track_is_automatic(field, track)
                _, basis = subtitle_import.preferred_language(info, language)
                return {'source': {'url': url, 'id': downloader.identity, 'title': str(info.get('title') or 'Video transcript')[:500],
                    'duration': info['duration'], 'language': subtitle_import.track_language(track), 'automatic': automatic,
                    'extractor': downloader.provider, 'translated': False, 'live': False,
                    'live_status': info.get('live_status') or 'not_live'},
                    'track': {'language': subtitle_import.track_language(track), 'captionMethod': 'automatic' if automatic else 'platform_provided',
                        'languageBasis': basis if basis != 'unknown' else 'single_track', 'captionTrack': track, 'reviewStatus': 'unreviewed'},
                    'format': extension, 'bytes': body}
    except StopProof as stopped:
        reason = stopped.outcome
        access = reason in ('access_restricted', 'login_required', 'subtitle_login_required', 'rate_limited', 'http_access_denied')
        # A local upstream subtitle-policy observation is not a whole-video denial.
        # Keep the stop: no subtitle/media request or token acquisition follows.
        status = 'subtitle_token_required' if reason == 'subtitle_token_required' else 'access_restricted' if access else 'network_unavailable' if reason == 'transport_unavailable' else 'metadata_incomplete' if reason == 'metadata_incomplete' else 'guard_stopped'
        return {'status': status, 'diagnostic': {'stage': downloader.stage if downloader else 'initialization', 'reason': reason,
            'requests_attempted': downloader.count if downloader else 0, 'responses_received': downloader.responses if downloader else 0}}
    except Exception:
        return {'status': 'extractor_failed', 'diagnostic': {'stage': downloader.stage if downloader else 'initialization', 'reason': 'extractor_error',
            'requests_attempted': downloader.count if downloader else 0, 'responses_received': downloader.responses if downloader else 0}}
    finally:
        # A file is handed off only after success; caller also cleans its private directory.
        if output is not None:
            output.with_suffix(output.suffix + '.part').unlink(missing_ok=True)
            if not media_ready: output.unlink(missing_ok=True)
