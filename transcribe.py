#!/usr/bin/env python3
"""Transcribe a YouTube/Bilibili URL to a raw markdown transcript with speaker labels."""
import os, sys
_venv = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".venv", "bin", "python3")
if os.path.exists(_venv) and os.path.abspath(sys.executable) != os.path.abspath(_venv):
    os.execv(_venv, [_venv] + sys.argv)

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

import whisperx


_FORBIDDEN_FILENAME_CHARS = '/\\:*?"<>|\n\r\t'


def sanitize_filename(name: str, max_len: int = 80) -> str:
    cleaned = "".join("_" if c in _FORBIDDEN_FILENAME_CHARS else c for c in name)
    cleaned = " ".join(cleaned.split()).strip(" .")
    return cleaned[:max_len]


def fetch_metadata(url: str) -> tuple[str | None, str | None]:
    """Return (title, id) without downloading the media."""
    try:
        out = subprocess.run(
            ["yt-dlp", "--print", "%(title)s\t%(id)s",
             "--no-playlist", "--skip-download", url],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
    except subprocess.CalledProcessError:
        return (None, None)
    if "\t" not in out:
        return (None, None)
    title, vid_id = out.split("\t", 1)
    return (title.strip() or None, vid_id.strip() or None)


def download_audio(url: str, out_dir: Path) -> Path:
    out_template = str(out_dir / "audio.%(ext)s")
    subprocess.run(
        [
            "yt-dlp",
            "-f", "bestaudio",
            "-x", "--audio-format", "wav",
            "--audio-quality", "0",
            "-o", out_template,
            "--no-playlist",
            url,
        ],
        check=True,
    )
    p = out_dir / "audio.wav"
    if p.exists():
        return p
    files = list(out_dir.glob("*.wav"))
    if not files:
        raise RuntimeError("yt-dlp produced no wav file")
    return files[0]


def convert_to_wav(src: Path, out_dir: Path) -> Path:
    """Re-encode any local audio/video file to 16-bit mono 16kHz wav for whisper."""
    dst = out_dir / "audio.wav"
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", str(src),
            "-vn", "-ac", "1", "-ar", "16000",
            "-acodec", "pcm_s16le",
            str(dst),
        ],
        check=True,
    )
    return dst


def audio_duration_seconds(path: Path) -> float | None:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error",
             "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        return float(out)
    except (subprocess.CalledProcessError, ValueError):
        return None


def transcribe(audio_path: Path, language: str | None, hf_token: str | None) -> dict:
    device = "cpu"
    compute_type = "int8"

    print("  loading whisper large-v3...", file=sys.stderr)
    model = whisperx.load_model(
        "large-v3", device, compute_type=compute_type, language=language
    )
    audio = whisperx.load_audio(str(audio_path))
    result = model.transcribe(audio, batch_size=16)
    detected_lang = result["language"]
    print(f"  detected language: {detected_lang}", file=sys.stderr)

    print("  aligning word timestamps...", file=sys.stderr)
    align_model, metadata = whisperx.load_align_model(
        language_code=detected_lang, device=device
    )
    result = whisperx.align(
        result["segments"], align_model, metadata, audio, device,
        return_char_alignments=False,
    )

    if hf_token:
        print("  diarizing speakers (pyannote)...", file=sys.stderr)
        diarize_model = whisperx.DiarizationPipeline(
            use_auth_token=hf_token, device=device
        )
        diarize_segments = diarize_model(audio)
        result = whisperx.assign_word_speakers(diarize_segments, result)
    return result


def _fmt_ts(seconds: float) -> str:
    s = max(0, int(seconds))
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"


def format_transcript(result: dict, title: str, with_speakers: bool) -> str:
    lines = [f"# {title}", ""]
    current_speaker: str | None = None
    buffer: list[str] = []
    buffer_start: float | None = None

    def flush():
        if not buffer:
            return
        ts = f"[{_fmt_ts(buffer_start or 0)}]"
        if with_speakers:
            label = current_speaker or "SPEAKER_?"
            lines.append(f"{ts} **{label}**: {' '.join(buffer).strip()}")
        else:
            lines.append(f"{ts} {' '.join(buffer).strip()}")
        lines.append("")

    for seg in result["segments"]:
        speaker = seg.get("speaker") if with_speakers else None
        text = seg["text"].strip()
        seg_start = seg.get("start")
        if speaker != current_speaker:
            flush()
            buffer = [text]
            buffer_start = seg_start
            current_speaker = speaker
        else:
            buffer.append(text)
    flush()
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="A URL (yt-dlp supported) or a local audio/video file path")
    parser.add_argument("-o", "--output", help="Output .md path (default: ./<title>.raw.md)")
    parser.add_argument("--language", help="Force language code (zh, en, ...). Auto if omitted.")
    parser.add_argument("--no-diarize", action="store_true", help="Skip speaker diarization")
    parser.add_argument("--force", action="store_true", help="Re-transcribe even if output exists")
    args = parser.parse_args()

    hf_token = None if args.no_diarize else os.environ.get("HF_TOKEN")
    if not args.no_diarize and not hf_token:
        print(
            "warning: HF_TOKEN not set — skipping speaker diarization. "
            "See README to enable.",
            file=sys.stderr,
        )

    local_src = Path(args.source)
    is_local = local_src.exists() and local_src.is_file()

    if is_local:
        print("[1/3] using local file", file=sys.stderr)
        title = local_src.stem
        vid_id = None
    else:
        print("[1/3] resolving metadata...", file=sys.stderr)
        title, vid_id = fetch_metadata(args.source)
    safe_title = sanitize_filename(title) if title else ""
    stem = safe_title or vid_id or "transcript"
    display_title = title or stem

    if args.output:
        out_path = Path(args.output)
    else:
        out_path = Path.cwd() / f"{stem}.raw.md"

    if out_path.exists() and not args.force:
        print(f"✓ raw transcript already exists: {out_path}", file=sys.stderr)
        print("  (use --force to re-transcribe)", file=sys.stderr)
        print(out_path)
        return

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        if is_local:
            print(f"[2/3] preparing audio: {local_src.name}", file=sys.stderr)
            audio_path = convert_to_wav(local_src, tmp)
        else:
            print(f"[2/3] downloading audio: {display_title}", file=sys.stderr)
            audio_path = download_audio(args.source, tmp)

        duration = audio_duration_seconds(audio_path)
        if duration:
            mins = duration / 60
            print(
                f"[3/3] transcribing {mins:.1f} min of audio "
                f"(CPU large-v3 ETA ~{mins * 0.15:.0f}-{mins * 0.20:.0f} min)...",
                file=sys.stderr,
            )
        else:
            print("[3/3] transcribing (this may take a while)...", file=sys.stderr)

        result = transcribe(audio_path, args.language, hf_token)
        text = format_transcript(result, display_title, with_speakers=bool(hf_token))
        if not is_local:
            text = text.replace(
                f"# {display_title}\n",
                f"# {display_title}\n<!-- source: {args.source} -->\n",
                1,
            )
        out_path.write_text(text, encoding="utf-8")

    print(f"\n✓ raw transcript: {out_path}", file=sys.stderr)
    print(out_path)


if __name__ == "__main__":
    main()
