"""Explicit, small live probe. No accounts; reports metadata only, never caption text.

Uses upstream public subtitle test URLs. This is not run by normal tests or startup.
Exit 0 means both succeeded, 2 means neither did; neither is evidence of absence.
Run from the repository with the pinned yt-dlp and certifi installed.
"""
import contextlib
import io
import json
from pathlib import Path
import signal
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import certifi
from scripts.public_video_caption_guard import extract_public_video_captions


def main():
    successes = 0
    for provider, url, language in [
        ('youtube', 'https://www.youtube.com/watch?v=QRS8MkLhQmM', 'en'),
        ('bilibili', 'https://www.bilibili.com/video/BV12N4y1M7rh', 'zh'),
    ]:
        started = time.monotonic()
        def timeout(*_):
            raise TimeoutError('probe deadline')
        old = signal.signal(signal.SIGALRM, timeout)
        signal.alarm(130)
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                result = extract_public_video_captions(url, language, ca_file=certifi.where())
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old)
        status = result.get('status', 'ready')
        successes += status == 'ready'
        print(json.dumps({'provider': provider, 'url': url, 'requested_language': language,
            'method': 'pinned_official_extractor_guarded_public_transport', 'status': status,
            'elapsed_seconds': round(time.monotonic() - started, 3),
            'bytes': len(result.get('bytes', b'')),
            'caption_language': result.get('source', {}).get('language'),
            'caption_method': result.get('track', {}).get('captionMethod')}, ensure_ascii=True), flush=True)
    return 0 if successes == 2 else 1 if successes else 2


if __name__ == '__main__':
    raise SystemExit(main())
