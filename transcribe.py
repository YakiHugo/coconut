#!/usr/bin/env python3
"""Transcribe a YouTube/Bilibili/X URL to a raw markdown transcript with speaker labels."""
import os, sys
_venv = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".venv", "bin", "python3")
if __name__ == "__main__" and os.path.exists(_venv) and os.path.abspath(sys.executable) != os.path.abspath(_venv):
    os.execv(_venv, [_venv] + sys.argv)

import argparse
import contextlib
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from transcript import make_document, save_document, to_markdown
from subtitle_import import fetch_subtitle_document, subtitle_document, validate_video_url, validate_media_info, tls_cli_options


def download_audio(url: str, out_dir: Path) -> tuple[Path, str]:
    """Download audio with yt-dlp. Returns (path, title)."""
    validate_video_url(url)
    metadata = subprocess.run(
        [sys.executable, "-m", "yt_dlp", "--ignore-config", *tls_cli_options(), "--socket-timeout", "30", "--retries", "1",
         "--dump-single-json", "--skip-download", "--flat-playlist", "--playlist-end", "1", "--no-playlist", url],
        check=True, capture_output=True, text=True, timeout=90,
    )
    info = json.loads(metadata.stdout)
    validate_media_info(info)
    duration = info.get('duration')
    if not isinstance(duration, (int, float)) or not 0 < duration <= 6 * 3600:
        raise ValueError('Only completed recordings with known duration up to 6 hours are supported')
    out_template = str(out_dir / "%(id)s.%(ext)s")
    subprocess.run(
        [
            sys.executable, "-m", "yt_dlp", "--ignore-config", *tls_cli_options(),
            "--socket-timeout", "30", "--retries", "1",
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

    return files[0], str(info.get('title') or 'Untitled video')


def download_playback(url: str, directory: Path) -> Path:
    """Keep a bounded, fixed-name source copy for local timestamp playback."""
    validate_video_url(url)
    target = directory / 'playback.mp4'
    marker = directory / 'playback.json'
    if target.is_file() and not target.is_symlink() and marker.is_file() and not marker.is_symlink():
        try:
            saved = json.loads(marker.read_text())
            if saved == {'file': 'playback.mp4', 'size': target.stat().st_size} and 0 < target.stat().st_size <= 200 * 1024 * 1024:
                return target
        except (ValueError, OSError):
            pass
    subprocess.run([sys.executable, '-m', 'yt_dlp', '--ignore-config', *tls_cli_options(),
                    '--socket-timeout', '30', '--retries', '1', '--no-playlist',
                    '--max-filesize', str(200 * 1024 * 1024), '--force-overwrites',
                    '-f', 'worst[ext=mp4][protocol=https]/worst[ext=mp4]',
                    '-o', str(target), url], check=True, timeout=900,
                   stdout=subprocess.DEVNULL)
    if not target.is_file() or target.is_symlink() or not 0 < target.stat().st_size <= 200 * 1024 * 1024:
        raise RuntimeError('Playback download exceeded the local media limit or produced no file')
    save_document({'file': 'playback.mp4', 'size': target.stat().st_size}, marker)
    return target


def transcribe_fast(audio_path: Path, language: str | None, *, model_name: str, device: str, compute_type: str, batch_size: int = 8) -> dict:
    """Lightweight base path; precise alignment and diarization remain optional."""
    from faster_whisper import WhisperModel
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    segments, info = model.transcribe(str(audio_path), language=language, vad_filter=True, word_timestamps=True)
    output = []
    for segment in segments:
        output.append({'start': segment.start, 'end': segment.end, 'text': segment.text,
                       'words': [{'start': word.start, 'end': word.end, 'word': word.word} for word in (segment.words or [])]})
        print(f"[transcribe] processed through {segment.end:.1f}s", file=sys.stderr)
    return {'language': info.language, 'segments': output}


def transcribe(audio_path: Path, language: str | None, hf_token: str | None, *, model_name: str = "large-v3", device: str = "cpu", compute_type: str = "int8", batch_size: int = 8, align: bool = True) -> dict:
    import whisperx

    print(f"  loading whisper {model_name} on {device}...", file=sys.stderr)
    model = whisperx.load_model(
        model_name, device, compute_type=compute_type, language=language
    )
    audio = whisperx.load_audio(str(audio_path))
    result = model.transcribe(audio, batch_size=batch_size)
    detected_lang = result["language"]
    print(f"  detected language: {detected_lang}", file=sys.stderr)

    if align:
        print("  aligning word timestamps...", file=sys.stderr)
        try:
            align_model, metadata = whisperx.load_align_model(language_code=detected_lang, device=device)
            result = whisperx.align(result["segments"], align_model, metadata, audio, device, return_char_alignments=False)
        except Exception as error:
            print(f"warning: alignment unavailable ({type(error).__name__}); keeping ASR timestamps", file=sys.stderr)
            result["alignment_warning"] = "Alignment failed; original segment timestamps retained"
    result["language"] = detected_lang

    if hf_token:
        print("  diarizing speakers (pyannote)...", file=sys.stderr)
        from whisperx.diarize import DiarizationPipeline
        diarize_model = DiarizationPipeline(
            use_auth_token=hf_token, device=device
        )
        diarize_segments = diarize_model(audio)
        result = whisperx.assign_word_speakers(diarize_segments, result)
    return result


def default_output_path(source: str, directory: Path, is_url: bool) -> Path:
    stem = 'video-' + hashlib.sha256(source.encode()).hexdigest()[:12] if is_url else Path(source).stem
    candidate = directory / (stem + '.raw.md')
    number = 1
    while candidate.exists() or candidate.with_suffix('.json').exists():
        number += 1
        candidate = directory / (stem + f'-{number}.raw.md')
    return candidate


def main():
    parser = argparse.ArgumentParser(description="Import subtitles or transcribe a public video/local media file")
    parser.add_argument("source", help="YouTube/Bilibili/X URL, media file, SRT, or VTT")
    parser.add_argument("-o", "--output", help="Output Markdown path")
    parser.add_argument("--language", help="Original language hint, e.g. zh or en")
    parser.add_argument("--work-dir", type=Path, help="Keep completed stages for retry in this private directory")
    parser.add_argument("--source-url", default="", help="Optional source link for a local file")
    parser.add_argument("--force-transcribe", action="store_true", help="Ignore platform subtitles and recognize audio")
    parser.add_argument("--keep-media", action="store_true", help="Keep a bounded local MP4 copy for playback (requires --work-dir)")
    parser.add_argument("--no-diarize", action="store_true")
    parser.add_argument("--no-align", action="store_true")
    parser.add_argument("--backend", choices=("faster-whisper", "whisperx"), default="faster-whisper")
    parser.add_argument("--model", default="small", help="Initial conservative resource default, not a quality benchmark winner")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--batch-size", type=int, default=8)
    args = parser.parse_args()
    if args.keep_media and not args.work_dir:
        parser.error('keep-media requires a persistent work-dir')
    if args.batch_size < 1:
        parser.error("batch-size must be positive")
    source = Path(args.source).expanduser()
    is_url = args.source.startswith(('http://', 'https://'))
    if is_url:
        validate_video_url(args.source)
    elif not source.is_file():
        parser.error("Local source file does not exist")
    source_url = args.source if is_url else args.source_url
    hf_token = None if args.no_diarize else os.environ.get("HF_TOKEN")
    document = None
    workspace = contextlib.nullcontext(str(args.work_dir)) if args.work_dir else tempfile.TemporaryDirectory()
    with workspace as td:
        tmp = Path(td)
        tmp.mkdir(parents=True, exist_ok=True)
        fingerprint = {"source": str(source.resolve()) if not is_url else args.source,
                       "language": args.language, "force": args.force_transcribe,
                       "backend": args.backend, "model": args.model,
                       "source_url": source_url, "align": not args.no_align,
                       "diarize": bool(hf_token), "device": args.device, "compute_type": args.compute_type}
        if args.keep_media:
            fingerprint['keep_media'] = True
        if not is_url:
            fingerprint['source_size'] = source.stat().st_size
            fingerprint['source_mtime_ns'] = source.stat().st_mtime_ns
        manifest = tmp / 'manifest.json'
        if manifest.exists() and json.loads(manifest.read_text()) != fingerprint:
            raise ValueError('Work directory belongs to different input/options; use a new directory')
        save_document(fingerprint, manifest)
        cached_document = tmp / 'document.json'
        if cached_document.exists():
            document = json.loads(cached_document.read_text())
            print('[resume] using completed transcript', file=sys.stderr)
        if document is None and not is_url and source.suffix.lower() in ('.srt', '.vtt', '.json3'):
            print("[import] reading subtitle file", file=sys.stderr)
            document = subtitle_document(source, source_url=source_url, language=args.language)
        elif document is None and is_url and not args.force_transcribe:
            print("[subtitles] checking existing original-language captions", file=sys.stderr)
            document = fetch_subtitle_document(args.source, tmp, args.language)
        if document is None:
            if is_url:
                print("[download] downloading audio", file=sys.stderr)
                audio_meta = tmp / 'audio.json'
                if audio_meta.exists():
                    meta = json.loads(audio_meta.read_text())
                    audio_path, title = tmp / meta['file'], meta['title']
                    if not audio_path.is_file():
                        raise RuntimeError('Cached audio is missing; remove the incomplete work directory and retry')
                else:
                    audio_path, title = download_audio(args.source, tmp)
                    save_document({'file': audio_path.name, 'title': title}, audio_meta)
            else:
                audio_path, title = source, source.stem
            print("[transcribe] recognizing speech", file=sys.stderr)
            if args.backend == 'faster-whisper':
                result = transcribe_fast(audio_path, args.language, model_name=args.model,
                                         device=args.device, compute_type=args.compute_type,
                                         batch_size=args.batch_size)
            else:
                result = transcribe(audio_path, args.language, hf_token, model_name=args.model,
                                    device=args.device, compute_type=args.compute_type,
                                    batch_size=args.batch_size, align=not args.no_align)
            document = make_document(result, title, source_url)
            document["provenance"] = {"kind": "local_asr", "model": args.model, "backend": args.backend,
                                      "language": result.get("language"),
                                      "alignment_warning": result.get("alignment_warning")}
        # Commit completed caption/ASR work before the optional media stage.
        # A stop or crash during a large download must not discard the transcript.
        save_document(document, cached_document)
        if is_url and args.keep_media:
            print('[playback] keeping a local source copy (up to 200 MiB)', file=sys.stderr)
            try:
                download_playback(args.source, tmp)
                document.get('provenance', {}).pop('playback_warning', None)
            except (subprocess.SubprocessError, OSError, RuntimeError):
                document.setdefault('provenance', {})['playback_warning'] = 'Local playback download unavailable; use the original source link'
                print('[playback] copy unavailable; transcript and original source links retained', file=sys.stderr)
        save_document(document, cached_document)
        out_path = Path(args.output) if args.output else default_output_path(args.source, Path.cwd(), is_url)
        if not is_url and source.resolve() in (out_path.resolve(), out_path.with_suffix('.json').resolve()):
            raise ValueError('Output must not overwrite the source file')
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(to_markdown(document), encoding="utf-8")
        structured_path = out_path.with_suffix('.json')
        save_document(document, structured_path)
        print(f"[done] reader document: {structured_path}", file=sys.stderr)
        print(out_path)


if __name__ == "__main__":
    main()
