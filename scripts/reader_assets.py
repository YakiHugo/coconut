#!/usr/bin/env python3
"""Refresh or verify cache tokens for every local reader script and stylesheet."""
import argparse
import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'reader'
REFERENCE = re.compile(r'(?P<prefix>(?:src|href)=")(?P<name>[a-z-]+\.(?:js|css))(?:\?v=[^"]*)?(?P<end>")')


def refresh(html, root=ROOT):
    def replace(match):
        digest = hashlib.sha256((root / match['name']).read_bytes()).hexdigest()[:10]
        return f'{match["prefix"]}{match["name"]}?v={digest}{match["end"]}'
    return REFERENCE.sub(replace, html)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    path = ROOT / 'index.html'
    html = path.read_text()
    expected = refresh(html)
    if args.check and expected != html:
        parser.exit(1, 'Reader asset tokens are stale. Run python scripts/reader_assets.py\n')
    if not args.check:
        path.write_text(expected)


if __name__ == '__main__':
    main()
