"""Portable, source-linked transcript data shared by the CLI and local reader."""
from __future__ import annotations

import json
import math
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse


def source_link(url: str, seconds: float) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {'https', 'http'}:
        return ''
    host = (parsed.hostname or '').lower()
    if host in {'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'}:
        key = 't'
    elif host in {'bilibili.com', 'www.bilibili.com', 'm.bilibili.com'}:
        key = 't'
    elif host in {'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'}:
        if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443) or not re.fullmatch(r'/(?:[A-Za-z0-9_]{1,15}/status|i/status)/[0-9]{1,20}/?', parsed.path):
            return ''
        key = 't'
    else:
        return url
    query = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True) if k != key]
    query.append((key, str(max(0, int(seconds)))))
    return urlunparse(parsed._replace(query=urlencode(query), fragment=''))


def make_document(result: dict, title: str, source_url: str) -> dict:
    segments = []
    previous_start = -1.0
    for index, segment in enumerate(result.get('segments', [])):
        start = float(segment.get('start', 0))
        end = float(segment.get('end', start))
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start or start < previous_start:
            raise ValueError(f'Invalid timestamps in segment {index + 1}')
        text = segment.get('text', '')
        if not isinstance(text, str):
            raise ValueError(f'Invalid text in segment {index + 1}')
        previous_start = start
        if not text.strip():
            continue
        speaker = segment.get('speaker')
        segments.append({'id': f'segment-{index + 1}', 'start': start, 'end': end,
                         'text': text.strip(), 'speaker': speaker if isinstance(speaker, str) else None})
    if not segments:
        raise ValueError('The transcript contains no text segments')
    return {'schema_version': 1, 'title': title, 'source_url': source_url,
            'language': result.get('language'), 'segments': segments}


def timestamp(seconds: float) -> str:
    whole = max(0, int(seconds))
    hours, rest = divmod(whole, 3600)
    minutes, secs = divmod(rest, 60)
    return f'{hours:02}:{minutes:02}:{secs:02}' if hours else f'{minutes:02}:{secs:02}'


def to_markdown(document: dict) -> str:
    lines = [f"# {document['title']}", '']
    for segment in document['segments']:
        label = timestamp(segment['start'])
        link = source_link(document.get('source_url', ''), segment['start'])
        marker = f'[{label}]({link})' if link else label
        speaker = f" **{segment['speaker']}**:" if segment.get('speaker') else ''
        lines.extend([f"{marker}{speaker} {segment['text']}", ''])
    return '\n'.join(lines)


def save_document(document: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(document, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
