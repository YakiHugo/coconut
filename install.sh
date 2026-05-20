#!/bin/bash
# One-time install script for coconut (macOS / Linux)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OS="$(uname -s)"

hint_install() {
    local pkg="$1"
    case "$OS" in
        Darwin) echo "    brew install $pkg" ;;
        Linux)
            case "$pkg" in
                python@3.11) echo "    sudo apt install python3.11 python3.11-venv  # Debian/Ubuntu" ;;
                *)           echo "    sudo apt install $pkg  # Debian/Ubuntu" ;;
            esac
            ;;
        *) echo "    (install $pkg for your platform)" ;;
    esac
}

echo "==> Detected OS: $OS"

# Locate python3.11
PY=""
if command -v python3.11 >/dev/null 2>&1; then
    PY="python3.11"
elif [ -x /opt/homebrew/bin/python3.11 ]; then
    PY="/opt/homebrew/bin/python3.11"
elif [ -x /usr/local/bin/python3.11 ]; then
    PY="/usr/local/bin/python3.11"
fi

if [ -z "$PY" ]; then
    echo "ERROR: python3.11 not found."
    echo "Install:"
    hint_install "python@3.11"
    exit 1
fi

# Check ffmpeg + yt-dlp
missing=()
for cmd in ffmpeg yt-dlp; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        missing+=("$cmd")
    fi
done
if [ "${#missing[@]}" -gt 0 ]; then
    echo "ERROR: missing system deps: ${missing[*]}"
    for cmd in "${missing[@]}"; do
        echo "Install $cmd:"
        hint_install "$cmd"
    done
    exit 1
fi

echo "==> Using $PY ($($PY --version))"
echo "==> Creating Python venv..."
if [ ! -d ".venv" ]; then
    "$PY" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

echo "==> Installing Python packages (this takes a few minutes)..."
pip install --upgrade pip
pip install whisperx

chmod +x transcribe.py polish.py notes.py pt

cat <<EOF

==============================================================
✓ Install complete.

Add to PATH (and your ~/.zshrc or ~/.bashrc):
    export PATH="$SCRIPT_DIR:\$PATH"

Optional environment variables:

  HF_TOKEN              — for speaker diarization (recommended)
                          1. Sign up at https://huggingface.co
                          2. Accept license at
                             https://huggingface.co/pyannote/speaker-diarization-3.1
                          3. Generate a read token at
                             https://huggingface.co/settings/tokens
                          4. export HF_TOKEN=hf_xxxxx

  Local CLI for polishing — install one of:
                          claude:  https://docs.claude.com/en/docs/claude-code
                          codex:   https://github.com/openai/codex
                          Then run \`claude\` or \`codex\` once interactively
                          to log in. polish.py auto-detects which is on PATH.
                          (Or skip and paste the raw transcript into
                           Claude / ChatGPT yourself.)

Usage:
    pt <url-or-file>                 # full pipeline: transcribe → polish → notes
    transcribe.py <url-or-file>      # just transcribe (URL or local audio/video)
    polish.py transcript.raw.md      # just polish
    notes.py transcript.md           # just generate AI notes
==============================================================
EOF
