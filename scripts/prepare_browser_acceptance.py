#!/usr/bin/env python3
"""Prepare ephemeral media fixtures without invoking ASR or subscription AI.

Original-media mode downloads only publicly accessible media and existing English
captions. It stops if captions are unavailable. Raw content stays outside the
checkout and must never be published as a CI artifact.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from import_jobs import ImportJobs
from subtitle_import import fetch_subtitle_document, validate_video_url
from transcript import make_document, save_document
from transcribe import download_playback


def prepare(directory: Path, mode: str, url: str = '') -> dict:
    directory = directory.resolve()
    if directory.is_relative_to(ROOT):
        raise ValueError('Use an ephemeral directory outside the checkout')
    directory.mkdir(parents=True, exist_ok=True)
    if any(directory.iterdir()):
        raise ValueError('The acceptance directory must be empty')
    identifier = uuid.uuid4().hex
    folder = directory / identifier
    cache = folder / 'cache'
    cache.mkdir(parents=True)
    if mode == 'original':
        validate_video_url(url)
        # Never call transcribe.py or the processing queue: missing captions must
        # fail closed instead of falling back to an ASR/model download.
        with (directory / 'private-preparation.log').open('w') as log:
            with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                document = fetch_subtitle_document(url, cache, 'en')
                if document is None:
                    raise ValueError('No suitable existing English captions; ASR is disabled')
                duration = document.get('provenance', {}).get('media_duration')
                if not isinstance(duration, (int, float)) or not 0 < duration <= 21600:
                    raise ValueError('A completed video with a known bounded duration is required')
                playback = download_playback(url, cache)
        source = url
        title = url  # Preserve the original document title through jobs.result().
    else:
        # More than two pages, with a real H.264/AAC file and no model involved.
        segments = [dict(start=i * .75, end=i * .75 + .6,
                         text=f'Synthetic cue {i + 1:04d}: deterministic reading evidence.')
                    for i in range(221)]
        document = make_document({'language': 'en', 'segments': segments},
                                 'Coconut browser acceptance sample', '')
        document['provenance'] = {'kind': 'imported_subtitles', 'language': 'en'}
        playback = folder / 'source.mp4'
        subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-f', 'lavfi',
                        '-i', 'testsrc2=size=320x180:rate=10', '-f', 'lavfi',
                        '-i', 'sine=frequency=440:sample_rate=16000', '-t', '166.5',
                        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
                        '-c:a', 'aac', '-b:a', '24k', '-movflags', '+faststart',
                        str(playback)], check=True, capture_output=True, timeout=120)
        source = str(playback)
        title = document['title']
    save_document(document, folder / 'transcript.raw.json')
    jobs = ImportJobs(directory)
    # This is deliberately a completed-fixture import, not a claim that ASR ran.
    with jobs.connect() as db:
        now = time.time()
        db.execute('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                   (identifier, source, title, json.dumps({'language': 'en', 'keep_media': True}),
                    'done', 'Acceptance fixture ready', None, now, now))
    result = jobs.result(identifier)
    save_document(result, directory / 'acceptance-result.json')
    return {'mode': mode, 'job_id': identifier, 'cues': len(result['segments']),
            'media_bytes': playback.stat().st_size,
            'asr_invoked': False, 'subscription_invoked': False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('synthetic', 'original'), required=True)
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    try:
        evidence = prepare(args.directory, args.mode, os.environ.get('COCONUT_ORIGINAL_URL', ''))
    except Exception as error:
        # Exceptions from downloaders can embed captions, signed media URLs, and
        # filesystem paths. Public CI receives the category only.
        print(json.dumps({'preparation': 'failed', 'category': type(error).__name__,
                          'asr_invoked': False, 'subscription_invoked': False}))
        return 1
    print(json.dumps(evidence))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
