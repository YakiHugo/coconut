"""Read existing subtitles before spending time on speech recognition."""
from __future__ import annotations

import html
import json
import os
import re
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
        if not lines or lines[0].startswith(('NOTE', 'STYLE', 'REGION')):
            continue
        for index, line in enumerate(lines):
            if '-->' not in line:
                continue
            match = CUE.fullmatch(line.strip())
            if not match:
                raise ValueError('Invalid subtitle cue')
            body = html.unescape(re.sub(r'</?(?:b|i|u|ruby|rt|v|c)(?:[ .][^>]*)?>|<\d{2}:\d{2}(?::\d{2})?\.\d{3}>', '', '\n'.join(lines[index + 1:]), flags=re.I)).strip()
            if body:
                segment = {'start': seconds(match[1]), 'end': seconds(match[2]), 'text': body}
                # Suppress exact duplicates, but never guess that repeated speech is redundant.
                if not segments or segment != segments[-1]:
                    segments.append(segment)
            break
    return segments


def subtitle_document(path: Path, title: str | None = None, source_url: str = '', *, kind: str = 'imported_subtitles', language: str | None = None) -> dict:
    result = {'segments': parse_subtitles(path.read_text(encoding='utf-8-sig'), path.suffix.lower()), 'language': language}
    document = make_document(result, title or path.stem, source_url)
    document['provenance'] = {'kind': kind, 'language': language}
    return document


def select_track(info: dict, language: str | None = None) -> tuple[str, str] | None:
    """Prefer explicit source-language subtitles; never silently choose a translation."""
    preferred = language or info.get('language')
    if not preferred:
        originals = [key[:-5] for key in (info.get('automatic_captions') or {}) if key.endswith('-orig')]
        if len(originals) == 1:
            preferred = originals[0]
    for field in ('subtitles', 'automatic_captions'):
        tracks = info.get(field) or {}
        keys = [key for key, value in tracks.items() if key not in ('live_chat', 'danmaku') and any(isinstance(track, dict) and track.get('ext') in ('vtt', 'srt', 'json3') for track in value)]
        if preferred:
            exact = [key for key in keys if key.lower() == preferred.lower()]
            related = [key for key in keys if key.split('-')[0].lower() == preferred.split('-')[0].lower()]
            keys = exact or related
        elif field == 'automatic_captions':
            # Without a source-language hint, auto-translated tracks cannot be identified reliably.
            keys = [key for key in keys if key.endswith('-orig')]
        if keys:
            return field, sorted(keys)[0]
    return None


def validate_video_url(url: str) -> None:
    parsed = urlparse(url)
    hosts = {'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv'}
    if parsed.scheme != 'https' or parsed.hostname not in hosts or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('Use a public HTTPS YouTube or Bilibili video URL')
    host = parsed.hostname
    path = parsed.path
    if host in {'youtube.com', 'www.youtube.com', 'm.youtube.com'}:
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

    settings = {'quiet': True, 'no_warnings': False, 'skip_download': True,
                'noplaylist': True, 'extract_flat': 'in_playlist', 'socket_timeout': 30, 'retries': 1,
                'extractor_retries': 1, 'listsubtitles': False, 'writesubtitles': True, 'writeautomaticsub': True, 'compat_opts': {'no-certifi'} if tls_cli_options() else set(), 'outtmpl': str(directory / 'captions.%(ext)s')}
    with YoutubeDL(dict(settings)) as downloader:
        info = downloader.extract_info(url, download=False)
    validate_media_info(info)
    selected = select_track(info, language)
    if selected is None:
        return None
    field, track = selected
    settings.update({'simulate': False, 'listsubtitles': False, 'writesubtitles': field == 'subtitles', 'writeautomaticsub': field == 'automatic_captions',
                     'subtitleslangs': [track], 'subtitlesformat': 'vtt/srt/json3'})
    with YoutubeDL(dict(settings)) as downloader:
        downloaded = downloader.process_ie_result(info, download=True)
    subtitle = (downloaded.get('requested_subtitles') or {}).get(track) or {}
    filename = subtitle.get('filepath')
    if not filename:
        raise RuntimeError('Subtitle download did not produce a file')
    path = Path(filename).resolve()
    if not path.is_relative_to(directory.resolve()) or not path.is_file():
        raise RuntimeError('Subtitle output was outside its work directory')
    return subtitle_document(path, str(info.get('title') or 'Untitled video'), url,
                             kind='platform_subtitles' if field == 'subtitles' else 'automatic_subtitles', language=track)
