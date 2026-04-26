#!/bin/bash
# One-time install script for podcast-transcribe (macOS, Apple Silicon)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Checking Homebrew..."
if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew not installed. Install first: https://brew.sh"
    exit 1
fi

echo "==> Installing system deps (ffmpeg, yt-dlp, python@3.11)..."
brew install ffmpeg yt-dlp python@3.11

echo "==> Creating Python venv..."
if [ ! -d ".venv" ]; then
    /opt/homebrew/bin/python3.11 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

echo "==> Installing Python packages (this takes a few minutes)..."
pip install --upgrade pip
# WhisperX pulls in faster-whisper, pyannote.audio, torch
pip install whisperx anthropic

echo "==> Making scripts executable..."
chmod +x transcribe.py polish.py pt

cat <<EOF

==============================================================
✓ Install complete.

Add to PATH (and your ~/.zshrc):
    export PATH="$SCRIPT_DIR:\$PATH"

Optional environment variables:

  HF_TOKEN              — for speaker diarization (recommended)
                          1. Sign up at https://huggingface.co
                          2. Accept license at
                             https://huggingface.co/pyannote/speaker-diarization-3.1
                          3. Generate a read token at
                             https://huggingface.co/settings/tokens
                          4. export HF_TOKEN=hf_xxxxx

  ANTHROPIC_API_KEY     — for automatic Claude polishing
                          https://console.anthropic.com
                          (Or skip this and paste the raw transcript
                           into Claude Code yourself.)

Usage:
    pt <url>                         # full pipeline
    transcribe.py <url>              # just transcribe
    polish.py transcript.raw.md      # just polish
==============================================================
EOF
