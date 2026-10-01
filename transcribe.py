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

from transcript import make_document, save_document, to_markdown


def download_audio(url: str, out_dir: Path) -> tuple[Path, str]:
    """Download audio with yt-dlp. Returns (path, title)."""
    out_template = str(out_dir / "%(id)s.%(ext)s")
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
    files = list(out_dir.glob("*.wav"))
    if not files:
        raise RuntimeError("yt-dlp produced no wav file")

    title = subprocess.run(
        ["yt-dlp", "--get-title", "--no-playlist", url],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return files[0], title


def transcribe(audio_path: Path, language: str | None, hf_token: str | None) -> dict:
    import whisperx

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


def format_transcript(result: dict, title: str, with_speakers: bool) -> str:
    lines = [f"# {title}", ""]
    current_speaker: str | None = None
    buffer: list[str] = []

    def flush():
        if not buffer:
            return
        if with_speakers:
            label = current_speaker or "SPEAKER_?"
            lines.append(f"**{label}**: {' '.join(buffer).strip()}")
        else:
            lines.append(" ".join(buffer).strip())
        lines.append("")

    for seg in result["segments"]:
        speaker = seg.get("speaker") if with_speakers else None
        text = seg["text"].strip()
        if speaker != current_speaker:
            flush()
            buffer = [text]
            current_speaker = speaker
        else:
            buffer.append(text)
    flush()
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url")
    parser.add_argument("-o", "--output", help="Output .md path (default: ./<id>.raw.md)")
    parser.add_argument("--language", help="Force language code (zh, en, ...). Auto if omitted.")
    parser.add_argument("--no-diarize", action="store_true", help="Skip speaker diarization")
    args = parser.parse_args()

    hf_token = None if args.no_diarize else os.environ.get("HF_TOKEN")
    if not args.no_diarize and not hf_token:
        print(
            "warning: HF_TOKEN not set — skipping speaker diarization. "
            "See README to enable.",
            file=sys.stderr,
        )

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        print(f"[1/2] downloading audio...", file=sys.stderr)
        audio_path, title = download_audio(args.url, tmp)

        print(f"[2/2] transcribing (this may take a while)...", file=sys.stderr)
        result = transcribe(audio_path, args.language, hf_token)

        document = make_document(result, title, args.url)
        text = to_markdown(document)

        out_path = (
            Path(args.output)
            if args.output
            else Path(audio_path.stem + ".raw.md").resolve()
        )
        # When using a temp file as the default name, write to cwd
        if not args.output:
            out_path = Path.cwd() / (audio_path.stem + ".raw.md")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text, encoding="utf-8")
        structured_path = out_path.with_suffix(".json")
        save_document(document, structured_path)
        print(f"  reader document: {structured_path}", file=sys.stderr)

    print(f"\n✓ raw transcript: {out_path}", file=sys.stderr)
    print(out_path)


if __name__ == "__main__":
    main()
