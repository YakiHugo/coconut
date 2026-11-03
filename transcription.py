"""Offline, one-job transcription worker. No HTTP, database, or model downloads."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
import signal
import sys
import threading
from pathlib import Path

os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                  HF_HUB_DISABLE_IMPLICIT_TOKEN='1')

LANGUAGES = {'chinese': 'zh', 'english': 'en', 'cantonese': 'yue', 'japanese': 'ja',
             'korean': 'ko', 'french': 'fr', 'german': 'de', 'spanish': 'es',
             'italian': 'it', 'portuguese': 'pt', 'russian': 'ru'}


def emit(**value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def model_files(directory):
    root = Path(directory)
    if not root.is_absolute() or not root.is_dir():
        raise ValueError('Missing local MLX model directory')
    config = json.loads((root / 'config.json').read_text())
    if not isinstance(config, dict) or not (root / 'tokenizer_config.json').is_file():
        raise ValueError('Incomplete local MLX model')
    if not any((root / name).is_file() for name in ('tokenizer.json', 'tokenizer.model', 'vocab.json')):
        raise ValueError('Missing local tokenizer')
    weights = sorted(root.glob('*.safetensors'))
    if not weights or any(file.stat().st_size == 0 for file in weights):
        raise ValueError('Missing local MLX weights')
    index = root / 'model.safetensors.index.json'
    if index.exists():
        shards = set(json.loads(index.read_text())['weight_map'].values())
        if not shards or not shards.issubset({file.name for file in weights}):
            raise ValueError('Missing local MLX weight shard')
    return sorted(set(weights + list(root.glob('*.json')) + list(root.glob('*.model'))))


def probe(profile):
    backend = profile.get('backend')
    try:
        if backend == 'qwen-mlx':
            for package in ('mlx', 'mlx_audio', 'av'):
                if importlib.util.find_spec(package) is None:
                    return dict(available=False, code='missing_dependencies', message='本地 Qwen / MLX 环境未准备；不会自动安装或下载模型。')
            model_files(profile.get('asr_model', ''))
            model_files(profile.get('align_model', ''))
        elif backend == 'faster-whisper':
            from local_asr import executor_status
            status = executor_status()
            return {key: status[key] for key in ('available', 'code', 'message') if key in status}
        else:
            raise ValueError('Unsupported transcription backend')
    except (ValueError, OSError, KeyError, ImportError, json.JSONDecodeError):
        return dict(available=False, code='missing_model', message='本地模型文件尚未准备完整；不会自动下载，阅读仍可使用。')
    return dict(available=True, code='ready', message='本地模型文件与运行环境已准备；尚不代表转录质量已验证。')


def fingerprint(directory):
    digest = hashlib.sha256()
    for file in model_files(directory):
        digest.update(file.name.encode())
        with file.open('rb') as source:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(block)
    return digest.hexdigest()


def checkpoint(path, operation):
    from transcript import save_document
    if path.exists():
        return json.loads(path.read_text())
    result = operation()
    save_document(result, path)
    return result


class QwenBackend:
    local_only = True

    def __init__(self, profile, work):
        from importlib.metadata import version
        self.profile, self.work = profile, work
        self.asr = self.aligner = None
        self.cache_key = dict(backend='qwen-mlx', runtime=version('mlx-audio'),
                              asr=fingerprint(profile['asr_model']),
                              aligner=fingerprint(profile['align_model']), adapter='qwen-local-v1')

    def recognize(self, path, *, request_id):
        from mlx_audio.stt import load
        from audio_pipeline import validate_result
        import wave
        with wave.open(str(path)) as audio:
            duration = audio.getnframes() / audio.getframerate()
        raw_path = self.work / ('recognition-' + request_id + '.json')

        def recognize():
            if self.asr is None:
                with contextlib.redirect_stdout(sys.stderr):
                    self.asr = load(self.profile['asr_model'])
            emit(phase='recognize')
            # A generous bound per <=4 minute processing unit. Keep raw text
            # before invoking the independent aligner, including every segment.
            with contextlib.redirect_stdout(sys.stderr):
                result = self.asr.generate(str(path), max_tokens=16384, verbose=False)
            if getattr(result, 'generation_tokens', 0) >= 16384:
                raise RuntimeError('ASR generation limit reached; text may be incomplete')
            return {'text': result.text, 'segments': result.segments}

        raw = checkpoint(raw_path, recognize)
        if not raw.get('segments') and raw.get('text', '').strip():
            raw['segments'] = [dict(text=raw['text'], start=0, end=duration)]
        segments, languages = [], []
        for index, item in enumerate(raw['segments']):
            if not item['text'].strip():
                continue
            start, end = float(item['start']), float(item['end'])
            if not 0 <= start < end <= duration + .05:
                raise ValueError('Invalid Qwen audio extent')
            language = str(item.get('language') or '').lower()
            code = LANGUAGES.get(language, language)
            if code:
                languages.append(code)
            segment = dict(start=start, end=end, text=item['text'], alignment_status='unavailable', timing_basis='audio_chunk')
            # MLX's ASR segment extents are audio chunks, not word timestamps.
            # Align each emitted audio/text pair and cache it independently.
            aligned_path = self.work / ('alignment-' + request_id + '-' + str(index) + '.json')
            def align():
                from audio_pipeline import AudioChunk, SAMPLE_RATE, write_chunk
                if self.aligner is None:
                    with contextlib.redirect_stdout(sys.stderr):
                        self.aligner = load(self.profile['align_model'])
                emit(phase='align')
                cut = self.work / ('align-' + request_id + '.wav')
                chunk = AudioChunk(0, round(start * SAMPLE_RATE), round(end * SAMPLE_RATE),
                                   round(start * SAMPLE_RATE), round(end * SAMPLE_RATE))
                try:
                    write_chunk(Path(path), chunk, cut)
                    with contextlib.redirect_stdout(sys.stderr):
                        result = self.aligner.generate(audio=str(cut), text=item['text'], language=language)
                    values = getattr(result, 'items', result)
                    return [dict(word=value.text, start=float(value.start_time) + start,
                                 end=float(value.end_time) + start) for value in values]
                finally:
                    cut.unlink(missing_ok=True)
            # Failure retains the ASR checkpoint; explicit retry invokes only
            # the missing alignment, not the expensive recognition again.
            segment['words'] = checkpoint(aligned_path, align)
            segments.append(segment)
        value = {'segments': segments, 'language': languages[0] if len(set(languages)) == 1 else None}
        return validate_result(value, duration)


def run(request):
    from audio_pipeline import run_audio_pipeline, _file_digest
    from transcript import make_document, save_document
    profile = request['profile']
    status = probe(profile)
    if not status['available']:
        raise RuntimeError(status['code'])
    source, work = Path(request['input']), Path(request['work'])
    if not source.is_absolute() or not work.is_absolute():
        raise ValueError('Absolute owned paths required')
    work.mkdir(parents=True, exist_ok=True)
    if _file_digest(source) != request['sha256']:
        raise ValueError('Source media changed')
    emit(phase='prepare')
    speaker_backend = None
    if profile.get('segmentation') or profile.get('embedding'):
        from audio_speakers import SherpaSpeakerBackend
        if not profile.get('segmentation') or not profile.get('embedding'):
            raise ValueError('Both acoustic models are required')
        speaker_backend = SherpaSpeakerBackend(Path(profile['segmentation']), Path(profile['embedding']))
    options = dict(work_dir=work / 'audio', speaker_backend=speaker_backend,
                   chunk_seconds=240, context_seconds=5,
                   progress=lambda index, total: emit(phase='recognize', chunk=index + 1, chunks=total))
    if profile['backend'] == 'qwen-mlx':
        backend = QwenBackend(profile, work)
        result = run_audio_pipeline(source, backend, local_only=True, **options)
        model = Path(profile['asr_model']).name
    else:
        from transcribe import transcribe_fast
        result = transcribe_fast(source, None, model_name='small', device='cpu', compute_type='int8',
                                 local_files_only=True, pipeline_options=options)
        model = 'small'
    emit(phase='save')
    document = make_document(result, request.get('title', '文字稿'), '')
    document['provenance'] = dict(kind='local_asr', backend=profile['backend'], model=model,
        caption_method='asr', review_status='unreviewed', language_basis='asr_detected',
        alignment_warning=result.get('alignment_warning'), source_sha256=request['sha256'],
        speaker_method=result['pipeline']['speaker_method'], audio_pipeline=result['pipeline']['version'])
    save_document(document, work / 'result.json')
    emit(phase='done')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--probe', action='store_true')
    args = parser.parse_args()
    request = json.loads(sys.stdin.readline())
    if args.probe:
        emit(**probe(request['profile']))
        return
    # Keep stdin open during work. Parent death closes it and terminates this
    # task even when Node cannot run its normal cancellation handler.
    finished = threading.Event()
    def parent_closed():
        # A daemon blocked on BufferedReader.read() can abort CPython at normal
        # interpreter shutdown. Read the raw fd so completion needs no I/O lock.
        while os.read(sys.stdin.fileno(), 4096):
            pass
        if not finished.is_set():
            os.kill(os.getpid(), signal.SIGTERM)
    threading.Thread(target=parent_closed, daemon=True).start()
    try:
        run(request)
    finally:
        finished.set()


if __name__ == '__main__':
    main()
