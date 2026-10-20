"""Explicit anonymous audio fallback after the guarded original-caption check.

Only one direct M4A or combined MP4 URL from that same verified extractor result is used.
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
                        and re.fullmatch(r'/[A-Za-z0-9_./-]+\.(?:m4s|mp4)', parsed.path))
    except (ValueError, TypeError):
        pass
    return False


def choose_audio(info, provider, language=None):
    candidates = []
    identity_formats = [item for item in info.get('formats') or []
                        if isinstance(item, dict) and item.get('acodec') not in (None, 'none')]
    audio_formats = [item for item in identity_formats if item.get('vcodec') == 'none']
    def role_allowed(item):
        return (item.get('language_preference') != -10 and
                not str(item.get('language') or '').endswith('-desc') and
                not re.search(r'descriptive|description|dubbed|配音', str(item.get('format_note') or ''), re.I))
    def language_code(item):
        value = item.get('language')
        return value if isinstance(value, str) and re.fullmatch(r'[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}', value) else None
    for item in audio_formats:
        size = item.get('filesize')
        if (not role_allowed(item) or item.get('ext') != 'm4a' or item.get('has_drm') or
                item.get('protocol') != 'https' or item.get('fragments') or
                not audio_url_allowed(item.get('url'), provider)):
            continue
        if size is not None and (isinstance(size, bool) or not isinstance(size, (int, float))
                                 or not math.isfinite(size) or not 0 < size <= MAX_MEDIA):
            continue
        candidates.append(item)
    if not candidates:
        return None
    if provider == 'youtube':
        # Pinned yt-dlp's documented extractor mapping: 10 original, 5 default,
        # -10 descriptive. Never prefer a cheaper dubbed/description track.
        originals = [item for item in identity_formats if item.get('language_preference') == 10]
        if originals:
            languages = {language_code(item) for item in originals}
            if None in languages or len(languages) != 1 or not all(role_allowed(item) for item in originals):
                return None
            chosen_language = next(iter(languages))
            candidates = [item for item in candidates if item.get('language_preference') == 10 and language_code(item) == chosen_language]
            basis = 'platform_original'
        else:
            # yt-dlp can omit encrypted/ineligible originals before info.formats.
            # A surviving default track is therefore not proof of original audio.
            return None
        if language and chosen_language.split('-')[0] != language.split('-')[0]:
            return None
    else:
        # Bilibili's pinned single-CID DASH extractor publishes bitrate variants,
        # not a language/role choice. Do not invent language or select annotated
        # future multi-language tracks without a dedicated contract.
        if any(item.get('language') or item.get('language_preference') is not None or not role_allowed(item) for item in audio_formats):
            return None
        chosen_language, basis = None, 'provider_single_source'
    if not candidates:
        return None
    def bitrate(item):
        value = item.get('abr', item.get('tbr'))
        return value if isinstance(value, (int, float)) and math.isfinite(value) and value > 0 else float('inf')
    selected = min(candidates, key=bitrate)
    return {**selected, '_audio_language':chosen_language, '_audio_language_basis':basis}



def choose_media(info, provider, language=None):
    audio = choose_audio(info, provider, language)
    if audio:
        return {**audio, '_kind':'audio', '_type':'audio/mp4', '_extension':'m4a',
                '_audio_role':'original' if provider == 'youtube' else 'unknown'}
    # A combined public source stream is not a claim about original voice.
    # Do not use another client, a token, DRM, manifest, or separate track merge.
    formats = [item for item in info.get('formats') or [] if isinstance(item, dict)]
    candidates = []
    for item in formats:
        size = item.get('filesize')
        if (item.get('ext') != 'mp4' or item.get('has_drm') or item.get('fragments')
                or item.get('protocol') != 'https' or item.get('vcodec') == 'none'
                or item.get('acodec') == 'none' or not audio_url_allowed(item.get('url'), provider)):
            continue
        if size is not None and (isinstance(size, bool) or not isinstance(size, (int,float))
                                or not math.isfinite(size) or not 0 < size <= MAX_MEDIA):
            continue
        if (item.get('language_preference') == -10 or
                re.search(r'descriptive|description|dubbed|配音', str(item.get('format_note') or ''), re.I)):
            continue
        if provider == 'youtube':
            # Pinned WEB explicitly exempts public combined itag18 from GVS POT.
            # Never include missing-POT formats or seek another client.
            if str(item.get('format_id')) != '18':
                continue
            preference = item.get('language_preference')
            lang = item.get('language')
            if lang is not None and (not isinstance(lang,str) or not re.fullmatch(r'[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}',lang)):
                continue
            if lang is not None and preference not in (5,10):
                continue
            if language and lang and lang.split('-')[0] != language.split('-')[0]:
                continue
            role = {10:'original',5:'default'}.get(preference,'unknown')
            basis = 'platform_video_stream'
        else:
            # Legacy single-CID MP4 may omit codec and language annotations.
            # Explicit audio/video-only or future labelled alternatives are not
            # guessed to be equivalent to that source stream.
            if item.get('_coconut_single_durl') is not True or any(f.get('language') or f.get('language_preference') is not None for f in formats):
                continue
            lang, role, basis = None, 'unknown', 'provider_single_source'
        candidates.append({**item,'_kind':'video','_type':'video/mp4','_extension':'mp4',
                           '_audio_language':lang,'_audio_role':role,'_audio_language_basis':basis})
    if not candidates:
        return None
    if provider == 'youtube' and len(candidates) != 1:
        return None
    return min(candidates, key=lambda item: item.get('filesize') or MAX_MEDIA)


def download_verified_audio(info, transport, output, source_url, language=None):
    selected = choose_media(info, transport.provider, language)
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
    return {'status':'media_ready','media':{'filename':'public-media.bin','bytes':written,
        'sha256':digest.hexdigest(),'type':selected['_type'],'kind':selected['_kind']},
        'source':{'url':source_url,'id':transport.identity,'provider':transport.provider,
        'title':str(info.get('title') or 'Video audio')[:500],'duration':info['duration'],
        'subtitle_check':'no_matching_captions','audio_language':selected['_audio_language'],
        'audio_language_basis':selected['_audio_language_basis'],'audio_role':selected['_audio_role'],
        'format':selected['_extension'],'format_id':str(selected.get('format_id') or '')[:80]}}


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
