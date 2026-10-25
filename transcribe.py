#!/usr/bin/env python3
"""Transcribe a YouTube/Bilibili/X URL to a raw markdown transcript with speaker labels."""
import os, sys
_venv = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".venv", "bin", "python3")
if __name__ == "__main__" and "--local-files-only" not in sys.argv and os.path.exists(_venv) and os.path.abspath(sys.executable) != os.path.abspath(_venv):
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
from local_asr import OFFLINE_ENVIRONMENT, require_local_model
from transcript_readability import enhance_from_environment
from audio_pipeline import CallableBackend, JsonCommandBackend, VERSION as AUDIO_PIPELINE_VERSION, run_audio_pipeline
from subtitle_import import fetch_subtitle_document, subtitle_document, validate_video_url, validate_media_info, tls_cli_options, source_evidence


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


def transcribe_fast(audio_path: Path, language: str | None, *, model_name: str, device: str, compute_type: str, batch_size: int = 8, local_files_only: bool = False, pipeline_options: dict | None = None) -> dict:
    """Lightweight base path; precise alignment and diarization remain optional."""
    if local_files_only:
        # Establish the offline guard before importing the runtime/Hub modules.
        # A pinned existing directory and required tokenizer also prevent the
        # model-name and missing-tokenizer download fallbacks.
        os.environ.update(OFFLINE_ENVIRONMENT)
        model_path = require_local_model(model_name)
    from faster_whisper import WhisperModel, BatchedInferencePipeline
    if local_files_only:
        model = WhisperModel(str(model_path), device=device, compute_type=compute_type,
                             local_files_only=True)
    else:
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
    # Use the requested batch size for long recordings as well as WhisperX.
    # A size of one retains the sequential decoder; both use the same already
    # constructed model, offline guard, VAD and word-timestamp output contract.
    recognizer = BatchedInferencePipeline(model=model) if batch_size > 1 else model
    def recognize(path):
        segments, info = recognizer.transcribe(str(path), language=language, vad_filter=True,
                                          word_timestamps=True,
                                          **({'batch_size': batch_size, 'without_timestamps': False} if batch_size > 1 else {}))
        output = []
        for segment in segments:
            output.append({'start': segment.start, 'end': segment.end, 'text': segment.text,
                       'words': [{'start': word.start, 'end': word.end, 'word': word.word} for word in (segment.words or [])]})
            print(f"[transcribe] processed through chunk {segment.end:.1f}s", file=sys.stderr)
        return {'language': info.language, 'segments': output}
    if pipeline_options is None:
        return recognize(audio_path)
    backend = CallableBackend({'backend': 'faster-whisper', 'model': model_name,
                               'device': device, 'compute_type': compute_type,
                               'batch_size': batch_size, 'language': language}, recognize)
    return run_audio_pipeline(audio_path, backend, local_only=local_files_only, **pipeline_options)


def transcribe(audio_path: Path, language: str | None, hf_token: str | None, *, model_name: str = "large-v3", device: str = "cpu", compute_type: str = "int8", batch_size: int = 8, align: bool = True, pipeline_options: dict | None = None) -> dict:
    import whisperx

    print(f"  loading whisper {model_name} on {device}...", file=sys.stderr)
    model = whisperx.load_model(
        model_name, device, compute_type=compute_type, language=language
    )
    if pipeline_options is not None:
        aligners = {}
        def recognize(path):
            audio = whisperx.load_audio(str(path))
            result = model.transcribe(audio, batch_size=batch_size)
            detected = result.get('language') or language
            if align:
                try:
                    if detected not in aligners:
                        aligners[detected] = whisperx.load_align_model(language_code=detected, device=device)
                    align_model, metadata = aligners[detected]
                    result = whisperx.align(result['segments'], align_model, metadata, audio, device,
                                            return_char_alignments=False)
                except Exception:
                    result['alignment_warning'] = 'Alignment failed; original segment timestamps retained'
            result['language'] = detected
            for segment in result.get('segments', []):
                if any(word.get('start') is None or word.get('end') is None
                       for word in segment.get('words', [])):
                    segment.pop('words', None)
                    result['alignment_warning'] = 'Incomplete word alignment; segment timestamps retained'
            return result
        # Chunk-local WhisperX diarizer labels cannot identify people across
        # chunks. Recording identities use the independent acoustic backend.
        backend = CallableBackend({'backend': 'whisperx', 'model': model_name, 'language': language,
                                   'device': device, 'compute_type': compute_type,
                                   'batch_size': batch_size, 'align': align}, recognize)
        return run_audio_pipeline(audio_path, backend, **pipeline_options)
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
    parser.add_argument("--captions-only", action="store_true", help="Require existing captions; never fall back to ASR or load recognition models (optional playback media is separate)")
    parser.add_argument("--keep-media", action="store_true", help="Keep a bounded local MP4 copy for playback (requires --work-dir)")
    parser.add_argument("--local-files-only", action="store_true", help="Use only an already cached small model for local media; never download models or use WhisperX")
    parser.add_argument("--no-diarize", action="store_true", help='Disable legacy WhisperX/HF diarization; explicitly configured local acoustic models are independent')
    parser.add_argument("--no-align", action="store_true")
    parser.add_argument("--backend", choices=("faster-whisper", "whisperx", "json-command"), default="faster-whisper")
    parser.add_argument('--provider-command', help='JSON array of trusted executable arguments; explicit cloud/provider bridge')
    parser.add_argument('--provider-id', help='Versioned provider/model identity for chunk recovery')
    parser.add_argument('--chunk-seconds', type=float, default=600, help='Owned audio seconds per chunk (plus context)')
    parser.add_argument('--chunk-context', type=float, default=5, help='Audio context on each side of a chunk')
    parser.add_argument("--model", default="small", help="Initial conservative resource default, not a quality benchmark winner")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--batch-size", type=int, default=8)
    args = parser.parse_args()
    import math
    if not math.isfinite(args.chunk_seconds) or not math.isfinite(args.chunk_context) or (
            args.chunk_seconds <= 0 or args.chunk_context < 0 or args.chunk_context * 2 >= args.chunk_seconds):
        parser.error('chunk-seconds must be positive and exceed twice chunk-context')
    provider_command = None
    if args.backend == 'json-command':
        try:
            provider_command = json.loads(args.provider_command or '')
            if not isinstance(provider_command, list) or not provider_command or not all(
                    isinstance(item, str) and item for item in provider_command) or not args.provider_id:
                raise ValueError()
        except ValueError:
            parser.error('json-command requires --provider-command as a JSON argument array and --provider-id')
    elif args.provider_command or args.provider_id:
        parser.error('provider options require the json-command backend')
    if args.local_files_only:
        if args.backend != 'faster-whisper' or args.model != 'small':
            parser.error('local-files-only requires the faster-whisper backend and small model')
        if args.source.startswith(('http://', 'https://')):
            parser.error('local-files-only requires an uploaded local file')
        os.environ.update(OFFLINE_ENVIRONMENT)
    if args.captions_only and args.force_transcribe:
        parser.error('captions-only cannot be combined with force-transcribe')
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
    hf_token = None if args.no_diarize or args.local_files_only else os.environ.get("HF_TOKEN")
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
        fingerprint.update(audio_pipeline=AUDIO_PIPELINE_VERSION, chunk_seconds=args.chunk_seconds,
                           chunk_context=args.chunk_context, batch_size=args.batch_size)
        if provider_command:
            fingerprint['provider'] = JsonCommandBackend(provider_command, identity=args.provider_id, language=args.language).cache_key
        if args.keep_media:
            fingerprint['keep_media'] = True
        # Keep old work directories compatible when the option is absent, but
        # never reuse an ASR-enabled cache under a captions-only permission.
        if args.captions_only:
            fingerprint['captions_only'] = True
        if args.local_files_only:
            fingerprint['local_files_only'] = True
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
            if args.captions_only:
                raise ValueError('No suitable existing captions. Captions-only mode stopped before audio download or speech recognition; no model was loaded. 仅字幕模式：没有可用字幕，未识别语音或下载模型。')
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
            speaker_backend = None
            segmentation = os.environ.get('COCONUT_SPEAKER_SEGMENTATION_MODEL', '')
            embedding = os.environ.get('COCONUT_SPEAKER_EMBEDDING_MODEL', '')
            if segmentation or embedding:
                if not segmentation or not embedding:
                    raise ValueError('Both speaker segmentation and embedding models are required')
                from audio_speakers import SherpaSpeakerBackend
                speaker_backend = SherpaSpeakerBackend(segmentation, embedding)
            elif args.backend == 'whisperx' and hf_token:
                print('[speakers] chunked WhisperX uses the independent acoustic stage; '
                      'configure local speaker models for recording-wide identities', file=sys.stderr)
            pipeline_options = {'work_dir': tmp / 'speech', 'speaker_backend': speaker_backend,
                                'chunk_seconds': args.chunk_seconds, 'context_seconds': args.chunk_context,
                                'progress': lambda index, total: print(
                                    f'[transcribe] chunk {index + 1}/{total}', file=sys.stderr, flush=True)}
            if args.backend == 'faster-whisper':
                result = transcribe_fast(audio_path, args.language, model_name=args.model,
                                         device=args.device, compute_type=args.compute_type,
                                         batch_size=args.batch_size,
                                         pipeline_options=pipeline_options,
                                         **({'local_files_only': True} if args.local_files_only else {}))
            elif args.backend == 'whisperx':
                result = transcribe(audio_path, args.language, hf_token, model_name=args.model,
                                    device=args.device, compute_type=args.compute_type,
                                    batch_size=args.batch_size, align=not args.no_align,
                                    pipeline_options=pipeline_options)
            else:
                result = run_audio_pipeline(audio_path,
                    JsonCommandBackend(provider_command, identity=args.provider_id, language=args.language), **pipeline_options)
            document = make_document(result, title, source_url)
            document["provenance"] = {"kind": "provider_asr" if provider_command else "local_asr",
                                      "model": args.provider_id if provider_command else args.model, "backend": args.backend,
                                      "language": result.get("language"),
                                      "alignment_warning": result.get("alignment_warning"),
                                      "caption_method": "asr", "review_status": "unreviewed",
                                      "language_basis": "user_hint" if args.language else "asr_detected",
                                      "subtitle_check": ("skipped" if args.force_transcribe else "no_eligible_track") if is_url else "not_applicable",
                                      **source_evidence(source_url)}
            if result.get('pipeline'):
                pipeline = result['pipeline']
                document['provenance'].update(audio_pipeline=pipeline['version'],
                    audio_chunks=str(pipeline['chunks']), speaker_method=pipeline['speaker_method'],
                    speaker_backend='sherpa-onnx' if speaker_backend else 'unavailable',
                    speaker_status=f"automatic_unreviewed:{pipeline['speaker_count']} voices" if speaker_backend else 'unavailable',
                    media_duration=pipeline['duration'])
        # Run only explicitly provisioned local reading models. A failure must
        # leave the completed ASR result available, with an honest status.
        if document.get('provenance', {}).get('kind') in ('local_asr', 'provider_asr'):
            save_document(document, cached_document)
            print('[reading] preparing readable transcript', file=sys.stderr)
            try:
                reading_audio = source if not is_url else locals().get('audio_path')
                if reading_audio is None and (tmp / 'audio.json').is_file():
                    reading_audio = tmp / json.loads((tmp / 'audio.json').read_text())['file']
                document = enhance_from_environment(document, reading_audio)
                document.get('provenance', {}).pop('readability_warning', None)
            except (ImportError, OSError, RuntimeError, ValueError):
                document.setdefault('provenance', {})['readability_warning'] = 'Local reading models unavailable; original ASR transcript retained'
                print('[reading] local enhancement unavailable; original transcript retained', file=sys.stderr)
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
