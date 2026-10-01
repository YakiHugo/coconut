#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
python3 -c 'import sys; assert sys.version_info >= (3,10), "Python 3.10+ required; 3.12 tested"'
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo 'Note: install ffmpeg to enable downloaded-media extraction. Subtitle imports still work.'
fi
printf '\nReady. Run ./coconut and open the local URL it prints.\n'
