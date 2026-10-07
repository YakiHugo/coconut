#!/usr/bin/env python3
"""One bounded, redacted proof of the pinned extractor's public X guest route.

This is an acceptance harness, not a production import adapter. It calls
Coconut's real fetch_subtitle_document, preserving upstream guest activation and
GraphQL extraction but narrowing transport to metadata, manifests and captions.
No cookies, account credentials, proxy, syndication fallback or media requests.
"""
from __future__ import annotations

import contextlib
import json
import math
import os
from pathlib import Path
import re
import signal
import sys
import tempfile
import time
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from subtitle_import import fetch_subtitle_document, parse_subtitles
from transcript import source_link

SOURCE_URL = 'https://x.com/VaibhavSisinty/status/2105733670493651236?s=20'
POST_ID = '2105733670493651236'
from scripts.public_x_caption_guard import (
    MAX_SECONDS, PINNED_VERSION, PublicTransport, StopProof, guarded_extractor,
)


def verify_document(document, directory: Path) -> dict:
    if document is None:
        raise StopProof('no_suitable_public_captions')
    provenance = document.get('provenance', {})
    segments = document.get('segments', [])
    if (document.get('source_url') != SOURCE_URL or provenance.get('source_platform') != 'x'
            or provenance.get('kind') not in ('platform_subtitles', 'automatic_subtitles')
            or provenance.get('subtitle_check') != 'found'
            or provenance.get('language') != 'en' or provenance.get('review_status') != 'unreviewed'
            or not re.fullmatch(r'\d{1,20}', str(provenance.get('media_id', '')))):
        raise StopProof('provenance_check_failed')
    duration = provenance.get('media_duration')
    if (not isinstance(duration, (int, float)) or isinstance(duration, bool)
            or not math.isfinite(duration) or not 0 < duration <= 21600 or len(segments) < 3):
        raise StopProof('timestamp_check_failed')
    previous = -1
    for segment in segments:
        start, end = segment.get('start'), segment.get('end')
        if (not all(isinstance(value, (int, float)) and not isinstance(value, bool)
                    and math.isfinite(value) for value in (start, end))
                or not 0 <= start <= end <= duration + 1 or start < previous
                or not isinstance(segment.get('text'), str) or not segment['text'].strip()):
            raise StopProof('timestamp_check_failed')
        previous = start
    files = list(directory.iterdir())
    if len(files) != 1 or files[0].suffix != '.vtt' or not files[0].is_file():
        raise StopProof('caption_only_files_check_failed')
    raw = parse_subtitles(files[0].read_text(encoding='utf-8-sig'), '.vtt')
    retained = [{key: segment[key] for key in ('start', 'end', 'text')} for segment in segments]
    if retained != raw or json.loads(json.dumps(document)) != document:
        raise StopProof('caption_roundtrip_check_failed')
    for segment in (segments[0], segments[len(segments) // 2], segments[-1]):
        link = urlparse(source_link(SOURCE_URL, segment['start']))
        if link.hostname != 'x.com' or parse_qs(link.query).get('t') != [str(int(segment['start']))]:
            raise StopProof('source_link_check_failed')
    return {'cues': len(segments), 'first_start_seconds': segments[0]['start'],
            'last_end_seconds': segments[-1]['end'], 'duration_seconds': duration,
            'provenance_kind': provenance['kind'], 'language': 'en',
            'raw_timestamps_preserved': True, 'caption_only_files': True}


def run_proof(transport: PublicTransport, directory: Path) -> dict:
    with guarded_extractor(transport):
        document = fetch_subtitle_document(SOURCE_URL, directory, 'en')
    if any(name in sys.modules for name in ('transcribe', 'faster_whisper', 'whisperx', 'transformers')):
        raise StopProof('unexpected_model_import')
    if transport.counts['guest_activation'] != 1 or transport.counts['post_metadata'] != 1 or not transport.counts['caption']:
        raise StopProof('public_guest_route_not_proven')
    return verify_document(document, directory)


def main() -> int:
    os.umask(0o077)
    transport = PublicTransport(POST_ID)
    report = {'suite': 'public-x-caption-proof', 'status': 'stopped',
              'extractor_version': PINNED_VERSION, 'route': 'anonymous_guest_graphql',
              'media_requests': 0, 'asr_invoked': False, 'model_invoked': False}
    previous_handler = signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(StopProof('deadline_reached')))
    signal.alarm(MAX_SECONDS)
    try:
        # Never emit extractor warnings/errors: they can contain content or URLs.
        with open(os.devnull, 'w') as silent, contextlib.redirect_stdout(silent), contextlib.redirect_stderr(silent):
            with tempfile.TemporaryDirectory(prefix='coconut-public-caption-') as temporary:
                report.update(run_proof(transport, Path(temporary)))
        report['status'] = 'passed'
    except StopProof as stopped:
        report['outcome'] = stopped.outcome
    except Exception:
        report['outcome'] = 'extraction_or_validation_failed'
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous_handler)
    report['requests'] = transport.counts
    report['response_bytes'] = transport.bytes_read
    report['elapsed_seconds'] = round(time.monotonic() - transport.started, 2)
    print(json.dumps(report, sort_keys=True))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
