"""Read existing subtitles before spending time on speech recognition."""
from __future__ import annotations

import html
from html.entities import html5
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from transcript import make_document

TIME = r'(?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3}'
CUE = re.compile(rf'^({TIME})\s+-->\s+({TIME})(?:\s+.*)?$')


def seconds(text: str) -> float:
    parts = text.replace(',', '.').split(':')
    if len(parts) not in (2, 3):
        raise ValueError('Invalid subtitle timestamp')
    values = [float(p) for p in parts]
    if any(v < 0 for v in values) or values[-1] >= 60 or values[-2] >= 60:
        raise ValueError('Invalid subtitle timestamp')
    total = 0.0
    for value in values:
        total = total * 60 + value
    return total


def vtt_entities(value: str) -> str:
    """HTML references; WebVTT annotations are not HTML attributes."""
    windows1252 = {128:8364,130:8218,131:402,132:8222,133:8230,134:8224,135:8225,136:710,137:8240,138:352,139:8249,140:338,142:381,145:8216,146:8217,147:8220,148:8221,149:8226,150:8211,151:8212,152:732,153:8482,154:353,155:8250,156:339,158:382,159:376}

    def decode(match):
        key = match[1]
        if key[0] == '#':
            digits = key.rstrip(';')
            # Bound conversion of maliciously long numeric references.
            digits = digits[2:] if digits[:2].lower() == '#x' else digits[1:]
            digits = digits.lstrip('0') or '0'
            code = int(digits, 16 if key[:2].lower() == '#x' else 10) if len(digits) <= 7 else 0x110000
            return '\ufffd' if not code or code > 0x10ffff or 0xd800 <= code <= 0xdfff else chr(windows1252.get(code, code))
        for length in range(min(len(key), 32), 0, -1):
            name = key[:length]
            if name not in html5:
                continue
            return html5[name] + key[length:]
        return match[0]

    return re.sub(r'&(#(?:x[0-9a-f]+|[0-9]+);?|[a-z][a-z0-9]*;?)', decode, value, flags=re.I)


def vtt_payload(value: str) -> tuple[str, str | None]:
    """Preserve one voice per cue; render mixed voices as labels, without new timings.

    Voice classes, annotations and nesting: WebVTT sections 4.2.2 and 6.4.
    """
    stack = [('', None)]
    runs = []

    def append(raw):
        text, speaker = vtt_entities(raw), stack[-1][1]
        if runs and runs[-1][0] == speaker:
            runs[-1][1] += text
        else:
            runs.append([speaker, text])

    tags = r'<\/?(?:b|i|u|ruby|rt|v|c|lang|X-word-ms)(?:[.][^\t\n\f\r >]*)?(?:[\t\n\f\r ][^>]*)?>|<\d{2,}:\d{2}(?::\d{2})?\.\d{3}>'
    position = 0
    for match in re.finditer(tags, value, flags=re.I):
        append(value[position:match.start()])
        position = match.end()
        tag = re.fullmatch(r'<(\/?)([a-z-]+)(?:[.][^\t\n\f\r >]*)?(?:[\t\n\f\r ]([^>]*))?>', match[0], flags=re.I)
        if not tag:  # Inline timestamps and legacy word timing wrappers.
            continue
        name = tag[2].lower()
        if name == 'x-word-ms':
            continue
        if tag[1]:
            if name == 'ruby' and stack[-1][0] == 'rt':
                stack.pop()
            if stack[-1][0] == name:
                stack.pop()
        elif name != 'rt' or stack[-1][0] == 'ruby':
            speaker = (re.sub(r'[\t\n\f\r ]+', ' ', vtt_entities(tag[3] or '')).strip(' ') or None) if name == 'v' else stack[-1][1]
            stack.append((name, speaker))
    append(value[position:])
    spoken = [(speaker, text) for speaker, text in runs if text.strip()]
    voices = {speaker for speaker, _ in spoken}
    speaker = spoken[0][0] if len(voices) == 1 else None
    if len(voices) > 1:
        text = '\n'.join((f'[{voice}] ' if voice else '') + text.strip() for voice, text in spoken)
    else:
        text = ''.join(text for _, text in runs).strip()
    return text, speaker


def parse_subtitles(text: str, extension: str) -> list[dict]:
    if extension == '.json3':
        source = json.loads(text)
        segments = []
        for event in source.get('events', []):
            body = ''.join(s.get('utf8', '') for s in event.get('segs', []))
            if not body.strip():
                continue
            start = event['tStartMs'] / 1000
            end = start + event.get('dDurationMs', 0) / 1000
            segments.append({'start': start, 'end': end, 'text': body.strip()})
        return segments
    if extension not in ('.vtt', '.srt'):
        raise ValueError(f'Unsupported subtitle format: {extension}')
    text = text.lstrip('\ufeff').replace('\r\n', '\n').replace('\r', '\n')
    segments = []
    for block in re.split(r'\n\s*\n', text):
        lines = block.strip().splitlines()
        if not lines or (extension == '.vtt' and re.match(r'^(?:WEBVTT|NOTE|STYLE|REGION)(?:[ \t]|$)', lines[0])):
            continue
        for index, line in enumerate(lines):
            if '-->' not in line:
                continue
            match = CUE.fullmatch(line.strip())
            if not match:
                raise ValueError('Invalid subtitle cue')
            payload = '\n'.join(lines[index + 1:])
            if extension == '.vtt':
                body, speaker = vtt_payload(payload)
            else:
                body = html.unescape(re.sub(r'</?(?:b|i|u|ruby|rt|v|c|X-word-ms)(?:[ .][^>]*)?>|<\d{2}:\d{2}(?::\d{2})?\.\d{3}>', '', payload, flags=re.I)).strip()
                speaker = None
            if body:
                segment = {'start': seconds(match[1]), 'end': seconds(match[2]), 'text': body}
                if speaker is not None:
                    segment['speaker'] = speaker
                # Suppress exact duplicates, but never guess that repeated speech is redundant.
                if not segments or segment != segments[-1]:
                    segments.append(segment)
            break
    return segments


def subtitle_document(path: Path, title: str | None = None, source_url: str = '', *, kind: str = 'imported_subtitles', language: str | None = None) -> dict:
    result = {'segments': parse_subtitles(path.read_text(encoding='utf-8-sig'), path.suffix.lower()), 'language': language}
    document = make_document(result, title or path.stem, source_url)
    document['provenance'] = {'kind': kind, 'language': language,
                              'caption_method': 'unknown', 'review_status': 'unreviewed',
                              'language_basis': 'user_hint' if language else 'unknown'}
    return document


def track_language(key: str) -> str:
    """Strip extractor annotations without turning translated text into source text."""
    value = key.lower()
    if value.startswith('ai-'):
        value = value[3:]
    return value[:-5] if value.endswith('-orig') else value


def track_is_automatic(field: str, key: str) -> bool:
    # Bilibili can place ai-* tracks in `subtitles`, rather than automatic_captions.
    return field == 'automatic_captions' or key.lower().startswith('ai-')


def eligible_formats(tracks: object) -> list[dict]:
    if not isinstance(tracks, list):
        return []
    return [track for track in tracks if isinstance(track, dict)
            and track.get('ext') in ('vtt', 'srt', 'json3')
            and not track.get('is_translated')
            and not ('tlang' in parse_qs(urlparse(str(track.get('url', ''))).query, keep_blank_values=True))]


def preferred_language(info: dict, language: str | None = None) -> tuple[str | None, str]:
    if language:
        return track_language(language), 'user_hint'
    if isinstance(info.get('language'), str) and info['language']:
        return track_language(info['language']), 'platform_metadata'
    originals = {track_language(key) for key, tracks in (info.get('automatic_captions') or {}).items()
                 if key.endswith('-orig') and eligible_formats(tracks)}
    if len(originals) == 1:
        return originals.pop(), 'original_track'
    return None, 'unknown'


def select_track(info: dict, language: str | None = None) -> tuple[str, str] | None:
    """Prefer supplied source-language captions, then un-translated automatic ones.

    A platform-supplied track is not evidence of human authorship or accuracy.
    With no language evidence, accept only a single supplied language; do not
    choose an arbitrary alphabetically first translation from a multilingual set.
    """
    preferred, _ = preferred_language(info, language)
    # Automatic tracks still count as language evidence when judging ambiguity.
    # Excluding ai-* first can make a supplied translation look like the only source.
    available_languages = {track_language(key)
        for field in ('subtitles', 'automatic_captions')
        for key, tracks in (info.get(field) or {}).items()
        if key not in ('live_chat', 'danmaku') and eligible_formats(tracks)}
    if not preferred and len(available_languages) > 1:
        return None
    candidates = []
    for field in ('subtitles', 'automatic_captions'):
        for key, tracks in (info.get(field) or {}).items():
            if key in ('live_chat', 'danmaku') or not eligible_formats(tracks):
                continue
            automatic = track_is_automatic(field, key)
            if not preferred and automatic and not key.endswith('-orig'):
                continue
            code = track_language(key)
            if preferred and code != preferred and code.split('-')[0] != preferred.split('-')[0]:
                continue
            candidates.append((automatic, code != preferred, not key.endswith('-orig'), field, key))
    if not preferred and len({track_language(item[-1]) for item in candidates}) > 1:
        return None
    if not candidates:
        return None
    chosen = min(candidates)
    return chosen[-2], chosen[-1]


def source_evidence(url: str, info: dict | None = None) -> dict:
    """Platform identity comes from the validated URL; medium needs media evidence."""
    host = (urlparse(url).hostname or '').lower()
    platforms = {
        'youtube': {'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'},
        'bilibili': {'bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv'},
        'x': {'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'},
    }
    evidence = {}
    for platform, hosts in platforms.items():
        if host in hosts:
            evidence['source_platform'] = platform
            break
    info = info or {}
    formats = [info, *(info.get('formats') or [])]
    if any(isinstance(item, dict) and item.get('vcodec') not in (None, 'none') for item in formats):
        evidence['source_medium'] = 'video'
    elif any(isinstance(item, dict) and item.get('vcodec') == 'none'
             and item.get('acodec') not in (None, 'none') for item in formats):
        evidence['source_medium'] = 'audio'
    return evidence


class SubtitleRetrievalError(RuntimeError):
    """Access/extraction/download failure, never evidence that captions are absent."""


class CaptionLogger:
    def __init__(self):
        self.warnings = []

    def debug(self, message):
        pass

    def warning(self, message):
        self.warnings.append(str(message))
        print(f'[subtitles] warning: {message}', file=sys.stderr)

    def error(self, message):
        self.warning(message)


def validate_video_url(url: str) -> None:
    parsed = urlparse(url)
    x_hosts = {'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'}
    hosts = {'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv'} | x_hosts
    if parsed.scheme != 'https' or parsed.hostname not in hosts or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('Use a public HTTPS YouTube, Bilibili, or X/Twitter video URL')
    host = parsed.hostname
    path = parsed.path
    if host in x_hosts:
        if not re.fullmatch(r'/(?:[A-Za-z0-9_]{1,15}/status|i/status)/[0-9]{1,20}/?', path):
            raise ValueError('Provide one X/Twitter video post, not a profile or search')
    elif host in {'youtube.com', 'www.youtube.com', 'm.youtube.com'}:
        video_id = parse_qs(parsed.query).get('v', [''])[0] if path == '/watch' else (path.split('/')[-1] if path.startswith('/shorts/') else '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id):
            raise ValueError('Provide one YouTube video, not a playlist or channel')
    elif host == 'youtu.be':
        if not re.fullmatch(r'/[A-Za-z0-9_-]{11}/?', path):
            raise ValueError('Provide one YouTube video')
    elif host != 'b23.tv' and not re.fullmatch(r'/video/(?:BV[A-Za-z0-9]{10}|av[0-9]+)/?', path):
        raise ValueError('Provide one Bilibili video, not a collection or channel')


def validate_media_info(info: dict | None) -> None:
    if not info or info.get('_type') in ('playlist', 'multi_video') or 'entries' in info:
        raise ValueError('Please provide a single video')
    if info.get('is_live') or info.get('live_status') in ('is_live', 'is_upcoming', 'post_live'):
        raise ValueError('Live/upcoming videos are not supported; use a completed recording')



def tls_cli_options() -> list[str]:
    # Honor an explicitly configured system trust store, keeping TLS verification on.
    # yt-dlp otherwise overrides SSL_CERT_FILE with its bundled certifi roots.
    return ['--compat-options', 'no-certifi'] if os.environ.get('SSL_CERT_FILE') or os.environ.get('SSL_CERT_DIR') else []


def fetch_subtitle_document(url: str, directory: Path, language: str | None = None) -> dict | None:
    validate_video_url(url)
    from yt_dlp import YoutubeDL

    logger = CaptionLogger()
    settings = {'logger': logger, 'quiet': True, 'no_warnings': False, 'skip_download': True,
                'noplaylist': True, 'extract_flat': 'in_playlist', 'socket_timeout': 30, 'retries': 1,
                'extractor_retries': 1, 'listsubtitles': False, 'writesubtitles': True, 'writeautomaticsub': True, 'compat_opts': {'no-certifi'} if tls_cli_options() else set(), 'outtmpl': str(directory / 'captions.%(ext)s')}
    try:
        with YoutubeDL(dict(settings)) as downloader:
            info = downloader.extract_info(url, download=False)
    except Exception as error:
        raise SubtitleRetrievalError('Caption retrieval failed; this does not confirm captions are absent. Retry or explicitly choose local ASR.') from error
    validate_media_info(info)
    selected = select_track(info, language)
    if selected is None:
        if logger.warnings:
            raise SubtitleRetrievalError('Caption availability could not be confirmed because the platform reported a warning. Retry or explicitly choose local ASR.')
        if preferred_language(info, language)[0] is None and any(
                key not in ('live_chat', 'danmaku') and eligible_formats(tracks)
                for field in ('subtitles', 'automatic_captions')
                for key, tracks in (info.get(field) or {}).items()):
            raise SubtitleRetrievalError('已发现字幕，但无法确认原语言。请在处理选项选择原语言后重试，或明确选择重新转录；未启动 ASR。')
        return None
    # Remove translated/unsupported formats from the selected track before giving
    # metadata back to yt-dlp; format preference must not reselect a translation.
    info = dict(info)
    field, track = selected
    info[field] = dict(info[field])
    info[field][track] = eligible_formats(info[field][track])
    settings.update({'simulate': False, 'listsubtitles': False, 'writesubtitles': field == 'subtitles', 'writeautomaticsub': field == 'automatic_captions',
                     'subtitleslangs': [track], 'subtitlesformat': 'vtt/srt/json3'})
    try:
        with YoutubeDL(dict(settings)) as downloader:
            downloaded = downloader.process_ie_result(info, download=True)
    except Exception as error:
        raise SubtitleRetrievalError('Caption download failed; available captions were not imported. Retry or explicitly choose local ASR.') from error
    subtitle = (downloaded.get('requested_subtitles') or {}).get(track) or {}
    filename = subtitle.get('filepath')
    if not filename:
        raise SubtitleRetrievalError('Caption download did not produce a file; captions are not confirmed absent')
    path = Path(filename).resolve()
    if not path.is_relative_to(directory.resolve()) or not path.is_file():
        raise RuntimeError('Subtitle output was outside its work directory')
    document = subtitle_document(path, str(info.get('title') or 'Untitled video'), url,
                                 kind='automatic_subtitles' if track_is_automatic(field, track) else 'platform_subtitles', language=track_language(track))
    _, basis = preferred_language(info, language)
    document['provenance'].update({
        'caption_method': 'automatic' if track_is_automatic(field, track) else 'platform_provided',
        'caption_track': track, 'language_basis': basis if basis != 'unknown' else 'single_track',
        'subtitle_check': 'found', **source_evidence(url, info),
    })
    # Keep the platform's media identity distinct from a post URL (which may
    # embed a different media ID). These fields are evidence, not download URLs.
    if isinstance(info.get('id'), str):
        document['provenance']['media_id'] = info['id']
    duration = info.get('duration')
    if isinstance(duration, (int, float)) and 0 < duration <= 6 * 3600:
        document['provenance']['media_duration'] = duration
    return document
