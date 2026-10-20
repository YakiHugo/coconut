"""Explicit anonymous audio fallback after the guarded original-caption check.

Only one direct M4A URL from that same verified extractor result is used.
Never follow redirects, obtain tokens, read cookies, resolve manifests, execute
downloaders, or switch candidates after a denial. CDN URLs are transient.
"""
from __future__ import annotations
import hashlib
import math
import re
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse, parse_qs
from scripts.public_x_caption_guard import StopProof

MAX_MEDIA = 200 * 1024 * 1024
MIME_TYPES = frozenset(('audio/mp4', 'video/mp4', 'application/octet-stream'))


def audio_url_allowed(value, provider):
    if not isinstance(value, str) or len(value) > 8192 or re.search(r'[\x00-\x20\x7f\\]', value):
        return False
    try:
        parsed = urlparse(value)
        if (parsed.scheme != 'https' or parsed.username or parsed.password or
                parsed.port not in (None, 443) or parsed.fragment or
                any(part in ('.', '..') for part in parsed.path.split('/'))):
            return False
        if any(key.lower() in {'pot','token','access_token','auth','authorization','cookie','session'} for key in parse_qs(parsed.query)):
            return False
        host = parsed.hostname or ''
        if provider == 'youtube':
            return bool(re.fullmatch(r'(?:rr?|r)[0-9]+---sn-[a-z0-9-]+\.googlevideo\.com', host)
                        and parsed.path == '/videoplayback')
        if provider == 'bilibili':
            return bool(re.fullmatch(r'[a-z0-9.-]+\.(?:bilivideo\.com|bilivideo\.cn|bilivideo\.net)', host)
                        and re.fullmatch(r'/[A-Za-z0-9_./-]+\.m4s', parsed.path))
    except (ValueError, TypeError):
        pass
    return False


def choose_audio(info, provider):
    candidates = []
    for item in info.get('formats') or []:
        if not isinstance(item, dict):
            continue
        size = item.get('filesize')
        if (item.get('ext') != 'm4a' or item.get('vcodec') != 'none' or
                item.get('acodec') in (None, 'none') or item.get('has_drm') or
                item.get('protocol') != 'https' or item.get('fragments') or
                not audio_url_allowed(item.get('url'), provider)):
            continue
        if size is not None and (isinstance(size, bool) or not isinstance(size, (int, float))
                                 or not math.isfinite(size) or not 0 < size <= MAX_MEDIA):
            continue
        bitrate = item.get('abr')
        candidates.append((bitrate if isinstance(bitrate, (int, float)) and math.isfinite(bitrate) and bitrate > 0 else float('inf'), item))
    # Prefer the smallest advertised bitrate; no retries with another candidate.
    return min(candidates, key=lambda item: item[0])[1] if candidates else None


def download_verified_audio(info, transport, output, source_url):
    selected = choose_audio(info, transport.provider)
    if selected is None:
        return {'status': 'media_unavailable'}
    if transport.count >= 32 or time.monotonic() - transport.started > 120:
        raise StopProof('budget_exceeded')
    transport.stage = 'media_download'
    transport.count += 1
    request = urllib.request.Request(selected['url'], headers={
        'User-Agent': 'Coconut-public-captions/1.0', 'Accept-Encoding': 'identity',
        'Referer': source_url}, method='GET')
    written = 0
    try:
        with transport.opener.open(request, timeout=15) as response:
            transport.responses += 1
            if response.status != 200 or response.headers.get('Content-Encoding', 'identity') != 'identity':
                raise StopProof('unexpected_response')
            if response.headers.get('Content-Type', '').split(';')[0].strip().lower() not in MIME_TYPES:
                raise StopProof('unexpected_response')
            length = response.headers.get('Content-Length')
            if length is not None and (not re.fullmatch(r'[0-9]+', length) or not 12 <= int(length) <= MAX_MEDIA):
                raise StopProof('budget_exceeded')
            digest = hashlib.sha256()
            with output.open('xb') as stream:
                first = True
                while True:
                    if time.monotonic() - transport.started > 120:
                        raise StopProof('budget_exceeded')
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > MAX_MEDIA:
                        raise StopProof('budget_exceeded')
                    if first:
                        # M4A's ISO-BMFF header; never accept an HTML/login body.
                        if len(chunk) < 12 or chunk[4:8] != b'ftyp':
                            raise StopProof('unexpected_response')
                        first = False
                    digest.update(chunk)
                    stream.write(chunk)
            if written < 12 or length is not None and written != int(length):
                raise StopProof('unexpected_response')
    except urllib.error.HTTPError as error:
        transport.responses += 1
        code = error.code
        error.close()
        raise StopProof({401:'login_required',403:'http_access_denied',412:'http_access_denied',429:'rate_limited'}.get(code,'upstream_error')) from None
    except (urllib.error.URLError, OSError):
        raise StopProof('transport_unavailable') from None
    return {'status':'media_ready','media':{'filename':'public-audio.m4a','bytes':written,
        'sha256':digest.hexdigest(),'type':'audio/mp4','kind':'audio'},
        'source':{'url':source_url,'id':transport.identity,'provider':transport.provider,
        'title':str(info.get('title') or 'Video audio')[:500],'duration':info['duration'],
        'subtitle_check':'no_matching_captions','format':'m4a','format_id':str(selected.get('format_id') or '')[:80]}}


def extract_public_video_audio(url, language=None, *, output, ca_file=None, proxy=None):
    from scripts.public_video_caption_guard import extract_public_video_captions
    result = extract_public_video_captions(url, language, ca_file=ca_file, proxy=proxy, _media_output=output)
    if isinstance(result.get('bytes'), bytes):
        # Captions appeared since the user's initial check. Prefer them, but do
        # not silently substitute this separate audio action with an import.
        result = {'status':'captions_available'}
    if result.get('status') != 'media_ready':
        output.unlink(missing_ok=True)
    return result
