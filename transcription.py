"""Offline, one-job transcription worker. No HTTP, database, or model downloads."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import json
import math
import os
import re
import signal
import sys
import threading
import time
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
                from audio_vad import silero_model
                if importlib.util.find_spec('onnxruntime') is None:
                    return dict(available=False, code='missing_dependencies',
                                message='本地 Silero VAD 需要 ONNX Runtime；请安装转录依赖。')
                silero_model(profile.get('vad_model'))
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


QWEN_ADAPTER = 'qwen-local-segment-retry-v3'


def _covers_audio(segments, duration):
    previous_end = 0.
    for segment in segments or []:
        start, end = segment['start'], segment['end']
        if not 0 <= start < end <= duration + .001 or abs(start - previous_end) > .001:
            return False
        previous_end = end
    return bool(segments) and abs(previous_end - duration) <= .001


def _decode_failed(result, budget, duration):
    # MLX returns audio-window extents here, before it has word or sentence times.
    if getattr(result, 'generation_tokens', 0) >= budget or (result.segments and not _covers_audio(result.segments, duration)):
        return True
    letters = ''.join(c for c in result.text if c.isalnum())
    return any(len(match.group()) >= 40 for match in re.finditer(r'(.{1,20}?)\1{19,}', letters))


def _missing_audio_ranges(path, frames, result):
    import numpy as np
    from audio_pipeline import aligner_audio, SAMPLE_RATE
    duration = frames / SAMPLE_RATE
    segments = result.segments or []
    if not segments and result.text.strip():
        return []
    gaps, edge = [], 0.
    for item in segments:
        if not item['text'].strip():
            continue
        start, end = max(0., item['start']), min(duration, item['end'])
        if start > edge:
            gaps.append((edge, min(start, duration)))
        edge = max(edge, end)
    if edge < duration:
        gaps.append((edge, duration))
    audible = []
    for start, end in gaps:
        if end - start < .5:
            continue
        first = round(start * SAMPLE_RATE)
        samples = aligner_audio(Path(path), first, round(end * SAMPLE_RATE))
        for offset in range(0, len(samples), SAMPLE_RATE):
            block = samples[offset:offset + SAMPLE_RATE]
            if len(block) >= SAMPLE_RATE // 2 and np.mean(block * block) >= .005 ** 2:
                a = first + offset
                audible.append((a / SAMPLE_RATE, (a + len(block)) / SAMPLE_RATE))
    return audible


class QwenBackend:
    local_only = True

    def __init__(self, profile, work, *, title='', context=None, hotwords=None):
        from importlib.metadata import version
        if not isinstance(title, str) or len(title) > 1000:
            raise ValueError('Invalid transcription title context')
        if hotwords is None:
            hotwords = []
        if (not isinstance(hotwords, list) or len(hotwords) > 64 or
                any(not isinstance(word, str) or not word.strip() or len(word) > 80 for word in hotwords)):
            raise ValueError('Invalid transcription vocabulary')
        def clean(value, limit):
            return re.sub(r'<\|[^>]*\|>', '', value).strip()[:limit]

        if context is not None and not isinstance(context, dict):
            raise ValueError('Invalid publisher context')
        source = context or {}
        for key, limit in [('show', 200), ('description', 6000)]:
            value = source.get(key, '')
            if not isinstance(value, str) or len(value) > limit:
                raise ValueError('Invalid publisher context field')
        participants = source.get('participants', [])
        if not isinstance(participants, list) or len(participants) > 64:
            raise ValueError('Invalid publisher participants')
        names, labels = [], []
        for person in participants:
            if not isinstance(person, dict) or not isinstance(person.get('name'), str) or not 1 <= len(person['name']) <= 80:
                raise ValueError('Invalid publisher participant')
            name = clean(person['name'], 80)
            if name and name not in names:
                names.append(name)
                role = person.get('role')
                labels.append(name + ('（' + role + '）' if role in ('主持人', '嘉宾') else ''))
        terms = [term for term in dict.fromkeys(clean(word, 80) for word in hotwords) if term and term not in names]
        name_line = '参与者：' + '、'.join(labels) if labels else ''
        term_line = '名称与拼写：' + '、'.join(terms) if terms else ''
        description = re.split(r'(?im)^\s*(?:时间轴|时间线|章节|联系方式|chapters|timestamps|contact)\s*[:：]?',
                               source.get('description', ''), maxsplit=1)[0]
        lines = [('标题', clean(title, 240)), ('节目', clean(source.get('show', ''), 200)),
                 ('简介', clean(description, 800))]
        self.vocabulary_prompt = '\n'.join(line for line in (name_line, term_line) if line)
        prompt = '\n'.join([*(label + '：' + value for label, value in lines if value),
                            *([self.vocabulary_prompt] if self.vocabulary_prompt else [])])
        self.hints = {'system_prompt':prompt} if prompt else {}
        self.profile, self.work = profile, work
        self.asr = self.aligner = None
        self.cache_key = dict(backend='qwen-mlx', runtime=version('mlx-audio'),
                              asr=fingerprint(profile['asr_model']),
                              aligner=fingerprint(profile['align_model']), adapter=QWEN_ADAPTER, prompt_format='publisher-fields-v1')
        if self.hints:
            self.cache_key['context'] = self.hints

    def release(self, stage):
        import gc
        setattr(self, stage, None)
        gc.collect()
        mlx = sys.modules.get('mlx.core')
        if mlx is not None:
            mlx.clear_cache()

    def recognize_text(self, path, duration, request_id, directory):
        from mlx_audio.stt import load
        raw_path = directory / ('recognition-' + request_id + '.json')

        def recognize():
            if self.asr is None:
                with contextlib.redirect_stdout(sys.stderr):
                    self.asr = load(self.profile['asr_model'])
            budget = min(16384, max(256, math.ceil(duration * 12) + 64))
            with contextlib.redirect_stdout(sys.stderr):
                result = self.asr.generate(str(path), max_tokens=budget, verbose=False, **self.hints)
            failed = _decode_failed(result, budget, duration)
            frames = round(duration * 16000)
            missing = _missing_audio_ranges(path, frames, result)
            missing_seconds = sum(b-a for a,b in missing)
            stats = dict(first_pass_missing_ranges=missing, first_pass_invalid_decode=failed,
                         retry_attempted=False, retry_recovered=False, retry_elapsed_seconds=0.)
            if failed or missing_seconds >= 8.:
                if duration < 4:
                    raise RuntimeError('ASR decoding failed; text may be incomplete')
                retry_budget = min(16384, max(4096, budget * 2))
                retry_options = {'system_prompt':self.vocabulary_prompt} if self.vocabulary_prompt else {}
                started = time.monotonic()
                with contextlib.redirect_stdout(sys.stderr):
                    retry = self.asr.generate(str(path), max_tokens=retry_budget,
                        chunk_duration=min(30, duration / 2), verbose=False, **retry_options)
                stats.update(retry_attempted=True, retry_elapsed_seconds=round(time.monotonic()-started, 3))
                valid = not _decode_failed(retry, retry_budget, duration) and _covers_audio(retry.segments, duration)
                if failed and not valid:
                    raise RuntimeError('ASR shorter-window retry returned incomplete or repetitive output; partial text discarded')
                if valid and (failed or sum(b-a for a,b in _missing_audio_ranges(path, frames, retry)) < missing_seconds):
                    result = retry
                    stats['retry_recovered'] = True
            return {'text': result.text, 'segments': result.segments, 'asr_observation':stats,
                    **({'recovery':'shorter_audio_windows'} if stats['retry_recovered'] else {})}

        return checkpoint(raw_path, recognize)

    def align_recognition(self, path, raw, duration, request_id, directory, *, origin=0., check=lambda: None):
        from mlx_audio.stt import load
        from audio_pipeline import InvalidWindowClocks, validate_result
        raw = dict(raw)
        if not raw.get('segments') and raw.get('text', '').strip():
            raw['segments'] = [dict(text=raw['text'], start=0, end=duration)]
        segments, languages = [], []
        for index, item in enumerate(raw['segments']):
            check()
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
            aligned_path = directory / ('alignment-' + request_id + '-' + str(index) + '.json')
            def align():
                from audio_pipeline import SAMPLE_RATE, aligner_audio
                if self.aligner is None:
                    with contextlib.redirect_stdout(sys.stderr):
                        self.aligner = load(self.profile['align_model'])
                waveform = aligner_audio(Path(path), round((origin + start) * SAMPLE_RATE), round((origin + end) * SAMPLE_RATE))
                with contextlib.redirect_stdout(sys.stderr):
                    result = self.aligner.generate(audio=waveform, text=item['text'], language=language)
                values = getattr(result, 'items', result)
                return [dict(word=value.text, start=float(value.start_time) + start,
                             end=float(value.end_time) + start) for value in values]
            # Failure retains the ASR checkpoint; explicit retry invokes only
            # the missing alignment, not the expensive recognition again.
            segment['words'] = checkpoint(aligned_path, align)
            segments.append(segment)
        value = {'segments': segments, 'language': languages[0] if len(set(languages)) == 1 else None}
        try:
            return validate_result(value, duration)
        except ValueError as error:
            raise InvalidWindowClocks(str(error), value, duration) from error


    def recognize(self, path, *, request_id):
        from audio_pipeline import _wav_frames, SAMPLE_RATE
        duration = _wav_frames(path) / SAMPLE_RATE
        raw = self.recognize_text(path, duration, request_id, self.work)
        return self.align_recognition(path, raw, duration, request_id, self.work)


def _check_cancel(event):
    if event is not None and event.is_set():
        raise InterruptedError('Transcription cancelled')


def _qwen_stages(backend, audio, directory, chunks, frames, hard_seams, check):
    from dataclasses import asdict
    from audio_pipeline import (SAMPLE_RATE, _digest, owned_segments, stitch_segments, normalize_word_clocks,
                                validate_window_clocks, write_chunk)
    from seam_recovery import recover_seam

    identity = _digest(backend.cache_key)
    recognition = directory / 'recognition' / identity
    alignment = directory / 'alignment' / identity
    recognition.mkdir(parents=True, exist_ok=True)
    alignment.mkdir(parents=True, exist_ok=True)
    requests = [_digest(asdict(chunk)) for chunk in chunks]
    try:
        for index, (chunk, key) in enumerate(zip(chunks, requests), 1):
            check()
            emit(phase='recognize', chunk=index, chunks=len(chunks))
            if (recognition / ('recognition-' + key + '.json')).exists():
                continue
            window = directory / 'window.wav'
            try:
                write_chunk(audio, chunk, window)
                backend.recognize_text(window, chunk.duration, key, recognition)
            finally:
                window.unlink(missing_ok=True)
    finally:
        backend.release('asr')

    segments, languages, recovered, evidence = [], [], [], []
    previous = None
    stats = dict(first_pass_chunks=0, first_pass_missing_seconds=0., first_pass_invalid_decode_chunks=0,
                 retry_chunks=0, retry_recovered_chunks=0,retry_elapsed_seconds=0.)
    for index, (chunk, key) in enumerate(zip(chunks, requests), 1):
        check()
        emit(phase='align', chunk=index, chunks=len(chunks))
        raw = json.loads((recognition / ('recognition-' + key + '.json')).read_text())
        observation = raw.get('asr_observation')
        if observation:
            a, b = chunk.core_start_frame/SAMPLE_RATE-chunk.start, chunk.core_end_frame/SAMPLE_RATE-chunk.start
            stats['first_pass_chunks'] += 1
            stats['first_pass_missing_seconds'] += sum(max(0.,min(b,y)-max(a,x)) for x,y in observation['first_pass_missing_ranges'])
            stats['first_pass_invalid_decode_chunks'] += observation['first_pass_invalid_decode']
            stats['retry_chunks'] += observation['retry_attempted']
            stats['retry_recovered_chunks'] += observation['retry_recovered']
            stats['retry_elapsed_seconds'] += observation['retry_elapsed_seconds']
        aligned = validate_window_clocks(
            lambda: backend.align_recognition(audio, raw, chunk.duration, key, alignment,
                                              origin=chunk.start, check=check), chunk)
        segments.extend(owned_segments(aligned, chunk, frames))
        if previous and chunk.index in hard_seams:
            words, observations = recover_seam(previous[0], previous[1], aligned, chunk)
            recovered.extend(words)
            evidence.extend(observations)
        previous = aligned, chunk
        if aligned.get('language'):
            languages.append(aligned['language'])
    language = languages[0] if len(set(languages)) == 1 else None
    output = sorted(stitch_segments(segments) + recovered, key=lambda item: (item['start'], item['end']))
    for cue in output:
        normalize_word_clocks(cue)
    stats['first_pass_missing_seconds'] = round(stats['first_pass_missing_seconds'], 3)
    stats['retry_elapsed_seconds'] = round(stats['retry_elapsed_seconds'], 3)
    return {'segments': sentence_segments(output), 'language': language, 'seam_recovery': evidence, 'asr_metrics':stats}


def _qwen_document(request, source, work, profile, speaker_count, backend, options):
    from audio_pipeline import _directory, _wav_frames, plan_silence_chunks, prepare_audio, SAMPLE_RATE, VERSION
    from existing_alignment import repair_transcribed_clocks
    from transcript import make_document, save_document

    event = options.get('cancel_event')
    def check():
        _check_cancel(event)

    with _directory(work / 'stages') as directory:
        check()
        manifest = directory / 'source.json'
        source_identity = {'sha256': request['sha256']}
        if manifest.exists():
            if json.loads(manifest.read_text()) != source_identity:
                raise ValueError('Transcription work belongs to another recording')
        else:
            save_document(source_identity, manifest)
        maximum = options.get('max_decoded_frames')
        audio = prepare_audio(source, directory) if maximum is None else prepare_audio(source, directory, max_frames=maximum)
        frames = _wav_frames(audio)
        duration = frames / SAMPLE_RATE
        expected = request.get('media_duration')
        if expected is not None and (type(expected) not in (int, float) or not math.isfinite(expected) or expected <= 0):
            raise ValueError('Invalid source media duration')
        if expected is not None and abs(duration - expected) > max(3, expected * .005):
            raise ValueError('Audio duration does not match the transcript source')
        try:
            from audio_vad import speech_evidence
            vad = speech_evidence(audio, source, directory, model=profile.get('vad_model'), check=check)
            chunks, hard_seams = plan_silence_chunks(frames, vad['speech_frames'],
                options['chunk_seconds'], options['context_seconds'])
            result = _qwen_stages(backend, audio, directory, chunks, frames, hard_seams, check)
            result['chunking'] = dict(method='silero-silence-v1', chunks=len(chunks),
                silence_cuts=len(chunks)-1-len(hard_seams), forced_cuts=len(hard_seams))
            check()
            document = make_document(result, request.get('title', '文字稿'), '')
            document['media_duration'] = duration
            repair_transcribed_clocks(document, audio, directory, profile.get('align_model'),
                                       getattr(backend, 'aligner', None), check=check)
        finally:
            backend.release('aligner')
        check()
        document['provenance'] = dict(kind='local_asr', backend='qwen-mlx', model=Path(profile['asr_model']).name,
            caption_method='asr', review_status='unreviewed', language_basis='asr_detected' if result.get('language') else 'unknown',
            alignment_warning=result.get('alignment_warning'), source_sha256=request['sha256'],
            speaker_method='unavailable', audio_pipeline=VERSION)
        if 'chunking' in result:
            document['provenance']['chunking'] = result['chunking']
        if result.get('asr_metrics', {}).get('first_pass_chunks'):
            document['provenance']['asr_metrics'] = result['asr_metrics']
        if profile.get('segmentation'):
            from audio_speakers import diarize_recording, fuse_speakers
            turns = diarize_recording(audio, directory / 'speakers', profile['segmentation'], profile['embedding'],
                expected_speakers=speaker_count, check=check,
                progress=lambda index, total: emit(phase='speakers', chunk=index, chunks=total))
            cues = fuse_speakers(document['segments'], turns, check=check)
            document['segments'] = cues
            count = sum(bool(cue.get('speaker_id')) for cue in cues)
            document['provenance'].update(speaker_method='recording-acoustic-v1', speaker_backend='sherpa-onnx',
                speaker_model='pyannote-segmentation-3.0 + 3dspeaker-eres2net + recording-clusters-v1',
                speaker_status=f'automatic_unreviewed:{count}/{len(cues)}')
        check()
        document = correct_verified_names(document, request.get('name_corrections'))
        emit(phase='save')
        save_document(document, work / 'result.json')
        emit(phase='done')


def run(request, *, qwen_backend=None, pipeline_options=None):
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
    if pipeline_options:
        options.update(pipeline_options)
    if profile['backend'] == 'qwen-mlx':
        backend = qwen_backend or QwenBackend(profile, work, title=request.get('title', ''), context=request.get('context'), hotwords=request.get('hotwords'))
        return _qwen_document(request, source, work, profile, speaker_count, backend, options)
    if profile['backend'] == 'moss-mlx':
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
    document = correct_verified_names(document, request.get('name_corrections'))
    emit(phase='save')
    save_document(document, work / 'result.json')
    emit(phase='done')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--probe', action='store_true')
    args = parser.parse_args()
    request_line = sys.stdin.buffer.readline(64 * 1024 * 1024 + 1)
    if not request_line.endswith(b'\n') or len(request_line) > 64 * 1024 * 1024:
        raise ValueError('Missing or oversized worker request')
    request = json.loads(request_line)
    if args.probe:
        if request.get('operation') == 'align_existing':
            from existing_alignment import probe_alignment
            emit(**probe_alignment(request['profile']))
        else:
            emit(**probe(request['profile']))
        return
    # Keep stdin open during work. Parent death closes it and terminates this
    # task even when Node cannot run its normal cancellation handler.
    finished = threading.Event()
    cancel = threading.Event()
    def parent_closed():
        # A daemon blocked on BufferedReader.read() can abort CPython at normal
        # interpreter shutdown. Read the raw fd so completion needs no I/O lock.
        while os.read(sys.stdin.fileno(), 4096):
            pass
        if not finished.is_set():
            os.kill(os.getpid(), signal.SIGTERM)
    if request.get('operation') != 'align_existing':
        def terminate(_signal, _frame):
            cancel.set()
            raise InterruptedError('Transcription cancelled')
        signal.signal(signal.SIGTERM, terminate)
    threading.Thread(target=parent_closed, daemon=True).start()
    try:
        if request.get('operation') == 'align_existing':
            from existing_alignment import run_alignment
            run_alignment(request)
        else:
            run(request, pipeline_options={'cancel_event': cancel})
    finally:
        finished.set()


if __name__ == '__main__':
    main()
