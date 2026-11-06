"""Offline, one-job transcription worker. No HTTP, database, or model downloads."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
import re
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
        acoustic_speakers = backend != 'moss-mlx' and bool(profile.get('segmentation') or profile.get('embedding'))
        speakers = backend == 'moss-mlx' or acoustic_speakers
        if acoustic_speakers:
            if not profile.get('segmentation') or not profile.get('embedding'):
                raise ValueError('Both speaker models are required')
            if importlib.util.find_spec('sherpa_onnx') is None:
                return dict(available=False, code='missing_dependencies', message='本地说话人分组环境未准备；不会自动安装或下载模型。')
            for name in ('segmentation', 'embedding'):
                file = Path(profile[name])
                if not file.is_absolute() or not file.is_file() or file.stat().st_size == 0:
                    raise ValueError('Missing local speaker model')
        if backend in ('qwen-mlx', 'moss-mlx'):
            for package in ('mlx', 'mlx_audio', 'av'):
                if importlib.util.find_spec(package) is None:
                    name = 'MOSS' if backend == 'moss-mlx' else 'Qwen'
                    return dict(available=False, code='missing_dependencies', message=f'本地 {name} / MLX 环境未准备；不会自动安装或下载模型。')
            model_files(profile.get('asr_model', ''))
            if backend == 'qwen-mlx':
                model_files(profile.get('align_model', ''))
            elif json.loads((Path(profile['asr_model']) / 'config.json').read_text()).get('model_type') != 'moss_transcribe_diarize':
                raise ValueError('Expected a local MOSS transcription model')
        elif backend == 'faster-whisper':
            from local_asr import executor_status
            status = executor_status()
            return {**{key: status[key] for key in ('available', 'code', 'message') if key in status}, 'speakers': speakers}
        else:
            raise ValueError('Unsupported transcription backend')
    except (ValueError, OSError, KeyError, ImportError, json.JSONDecodeError):
        return dict(available=False, code='missing_model', message='本地模型文件尚未准备完整；不会自动下载，阅读仍可使用。')
    return dict(available=True, code='ready', speakers=speakers, message='本地模型文件与运行环境已准备；尚不代表转录质量已验证。')


def sentence_segments(segments):
    """Split complete word alignments at sentences/pauses without changing text.

    Qwen audio extents can span minutes and several voices. Keep recognition
    checkpoints intact; derive readable cues before assigning acoustic speakers.
    Untimed or incompletely aligned text keeps its original coarse extent.
    """
    result = []
    for segment in segments:
        words = segment.get('words') or []
        if not words or ''.join(word['word'] for word in words).strip() != segment['text'].strip():
            result.append(segment)
            continue
        group = []

        def emit_group():
            if group:
                aligned, offset = [], 0
                for word in group:
                    item = dict(word)
                    if 'text_start' in item or 'text_end' in item:
                        item.update(text_start=offset, text_end=offset + len(item['word']))
                    aligned.append(item)
                    offset += len(item['word'])
                result.append({**segment, 'text': ''.join(word['word'] for word in group),
                               'start': min(word['start'] for word in group),
                               'end': max(word['end'] for word in group), 'words': aligned})
                group.clear()

        for word in words:
            if group and word['start'] - group[-1]['end'] > .8:
                emit_group()
            group.append(word)
            text = ''.join(item['word'] for item in group)
            if (re.search(r'[。！？.!?][\s”’」』）)]*$', word['word']) or
                    len(text) >= 160 and re.search(r'[，,；;：:][\s”’」』）)]*$', word['word']) or
                    group[-1]['end'] - group[0]['start'] >= 45):
                emit_group()
        emit_group()
    return result


def correct_verified_names(document, corrections):
    """Apply episode-scoped, explicitly reviewed aliases; preserve ASR history.

    This is not phonetic guessing or an unrestricted transcript rewrite. Equal
    length aliases can be projected onto aligned words without moving clocks.
    """
    import copy
    corrections = {} if corrections is None else corrections
    if (not isinstance(corrections, dict) or len(corrections) > 64 or any(
            not isinstance(source, str) or not isinstance(target, str) or
            not source.strip() or not target.strip() or not 2 <= len(source) <= 80 or
            len(source) != len(target) or source == target
            for source, target in corrections.items())):
        raise ValueError('Invalid verified name corrections')
    result = copy.deepcopy(document)
    if not corrections:
        return result
    pattern = re.compile('|'.join(re.escape(name) for name in sorted(corrections, key=lambda n: (-len(n), n))))
    for cue in result['segments']:
        original = cue['text']
        corrected = pattern.sub(lambda match: corrections[match.group()], original)
        if corrected == original:
            continue
        words = cue.get('words')
        if words and ''.join(word['word'] for word in words) != original:
            raise ValueError('Cannot project name correction onto incomplete word alignment')
        cue.setdefault('original_text', original)
        cue['text'] = corrected
        offset = 0
        for word in words or []:
            length = len(word['word'])
            word['word'] = corrected[offset:offset + length]
            offset += length
    return result


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

    def __init__(self, profile, work, *, title='', hotwords=None):
        from importlib.metadata import version
        if not isinstance(title, str) or len(title) > 1000:
            raise ValueError('Invalid transcription title context')
        if hotwords is None:
            hotwords = []
        if (not isinstance(hotwords, list) or len(hotwords) > 64 or
                any(not isinstance(word, str) or not word.strip() or len(word) > 80 for word in hotwords)):
            raise ValueError('Invalid transcription vocabulary')
        self.hints = {}
        if title.strip():
            self.hints['system_prompt'] = '节目标题：' + title.strip()
        if hotwords:
            self.hints['hotwords'] = list(dict.fromkeys(word.strip() for word in hotwords))
        self.profile, self.work = profile, work
        self.asr = self.aligner = None
        self.cache_key = dict(backend='qwen-mlx', runtime=version('mlx-audio'),
                              asr=fingerprint(profile['asr_model']),
                              aligner=fingerprint(profile['align_model']), adapter='qwen-local-v1')
        if self.hints:
            self.cache_key['context'] = self.hints

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
                result = self.asr.generate(str(path), max_tokens=16384, verbose=False, **self.hints)
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
    speaker_count = request.get('speaker_count')
    if speaker_count is not None and (type(speaker_count) is not int or not 1 <= speaker_count <= 32):
        raise ValueError('Invalid verified speaker count')
    emit(phase='prepare')
    speaker_backend = None
    if profile['backend'] != 'moss-mlx' and (profile.get('segmentation') or profile.get('embedding')):
        from audio_speakers import SherpaSpeakerBackend
        if not profile.get('segmentation') or not profile.get('embedding'):
            raise ValueError('Both acoustic models are required')
        if profile['backend'] != 'qwen-mlx':
            speaker_backend = SherpaSpeakerBackend(Path(profile['segmentation']), Path(profile['embedding']))
    options = dict(work_dir=work / 'audio', speaker_backend=speaker_backend,
                   chunk_seconds=240, context_seconds=5,
                   progress=lambda index, total: emit(phase='recognize', chunk=index + 1, chunks=total))
    if profile['backend'] == 'qwen-mlx':
        backend = QwenBackend(profile, work, title=request.get('title', ''), hotwords=request.get('hotwords'))
        if backend.hints:
            # A new title/vocabulary must not silently reuse recognition made
            # without those hints, or invalidate the older recoverable work.
            context_key = hashlib.sha256(json.dumps(backend.hints, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]
            options['work_dir'] = work / ('audio-context-' + context_key)
        result = run_audio_pipeline(source, backend, local_only=True, **options)
        result['segments'] = sentence_segments(result['segments'])
        model = Path(profile['asr_model']).name
    elif profile['backend'] == 'moss-mlx':
        from moss_asr import run_moss_pipeline
        result = run_moss_pipeline(source, model_path=profile['asr_model'],
                                   work_dir=work / 'moss', title=request.get('title', ''),
                                   hotwords=request.get('hotwords'),
                                   progress=lambda index, total: emit(phase='recognize', chunk=index + 1, chunks=total))
        model = Path(profile['asr_model']).name
    else:
        from transcribe import transcribe_fast
        result = transcribe_fast(source, None, model_name='small', device='cpu', compute_type='int8',
                                 local_files_only=True, pipeline_options=options)
        model = 'small'
    document = make_document(result, request.get('title', '文字稿'), '')
    document['provenance'] = dict(kind='local_asr', backend=profile['backend'], model=model,
        caption_method='asr', review_status='unreviewed', language_basis='asr_detected' if result.get('language') else 'unknown',
        alignment_warning=result.get('alignment_warning'), source_sha256=request['sha256'],
        speaker_method=result['pipeline']['speaker_method'], audio_pipeline=result['pipeline']['version'])
    if profile['backend'] == 'qwen-mlx' and profile.get('segmentation'):
        from transcript_readability import enhance_document
        emit(phase='speakers')
        document = enhance_document(document, source, segmentation=profile['segmentation'],
                                    embedding=profile['embedding'], work_dir=work / 'speakers',
                                    split_speakers=True, speaker_count=speaker_count)
    document = correct_verified_names(document, request.get('name_corrections'))
    emit(phase='save')
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
