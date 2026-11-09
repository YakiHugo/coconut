"""Candidate word clocks for an existing timed transcript; never a quality verdict."""
from __future__ import annotations
import copy
import contextlib
import importlib.util
import json
import math
import sys
from pathlib import Path


def probe_alignment(profile):
    from transcription import model_files
    try:
        if any(importlib.util.find_spec(name) is None for name in ('mlx', 'mlx_audio', 'av')):
            return dict(available=False, code='missing_dependencies', message='本地对齐环境未准备；不会自动下载模型。')
        model_files(profile.get('align_model', ''))
    except (ValueError, OSError, KeyError, ImportError, json.JSONDecodeError):
        return dict(available=False, code='missing_model', message='本地对齐模型未准备；不会自动下载模型。')
    return dict(available=True, code='ready', message='本地对齐已配置；对齐不证明原文准确。')


def language_name(value):
    from transcription import LANGUAGES
    code = str(value or '').lower().replace('_', '-').split('-')[0]
    return next((name for name, short in LANGUAGES.items() if short == code), code)


def align_document(document, duration, align):
    """Pure validation boundary; align(cue) returns recording-relative word clocks."""
    from audio_pipeline import bind_word_spans
    if not isinstance(document, dict) or not isinstance(document.get('segments'), list) or not document['segments']:
        raise ValueError('A nonempty timed transcript is required')
    result = copy.deepcopy(document)
    rows, ids = [], set()
    for cue in result['segments']:
        if not isinstance(cue, dict) or not isinstance(cue.get('text'), str) or not cue.get('id') or cue['id'] in ids:
            raise ValueError('Unique cue IDs and text are required')
        ids.add(cue['id'])
        row = dict(cue_id=cue['id'], status='needs_review')
        start, end = cue.get('start'), cue.get('end')
        if not all(type(v) in (int, float) and math.isfinite(v) for v in (start, end)):
            row['reason'] = 'missing_timing'
        elif start < 0 or end <= start or end > duration + .02:
            row['reason'] = 'outside_audio'
        elif end - start > 60:
            row['reason'] = 'window_too_long'
        elif not cue['text'].strip():
            row['reason'] = 'empty_text'
        else:
            try:
                words = copy.deepcopy(align(cue))
                previous = start
                if not isinstance(words, list) or not words:
                    raise ValueError('missing_words')
                for word in words:
                    if not isinstance(word, dict) or not isinstance(word.get('word'), str):
                        raise ValueError('invalid_words')
                    a, b = word.get('start'), word.get('end')
                    if not all(type(v) in (int, float) and math.isfinite(v) for v in (a, b)) or a < start or b > end or b <= a or a < previous:
                        raise ValueError('invalid_word_timing')
                    previous = b
                candidate = dict(text=cue['text'], words=words)
                if not bind_word_spans(candidate):
                    raise ValueError('incomplete_text_mapping')
                cue.update(words=candidate['words'], timing_basis='word', alignment_status='complete')
                row.update(status='aligned', reason=None)
            except Exception:
                # Do not leak model paths/errors, erase original clocks, or manufacture timing.
                row['reason'] = 'alignment_unverified'
        rows.append(row)
    count = sum(row['status'] == 'aligned' for row in rows)
    report = dict(schema_version=1, source_text_quality='unverified', status='candidate' if count == len(rows) else 'needs_review',
                  aligned_cues=count, total_cues=len(rows), coverage=count / len(rows), cues=rows)
    result['provenance'] = {**result.get('provenance', {}), 'alignment_method': 'qwen-existing-v1', 'source_text_quality': 'unverified'}
    return dict(document=result, alignment_report=report, source_snapshot=copy.deepcopy(document))


def run_alignment(request):
    from audio_pipeline import _digest, _file_digest, _wav_frames, prepare_audio, AudioChunk, SAMPLE_RATE, write_chunk
    from transcription import fingerprint, checkpoint, emit
    from transcript import save_document
    from importlib.metadata import version
    profile = request['profile']
    status = probe_alignment(profile)
    if not status['available']:
        raise RuntimeError(status['code'])
    source, work = Path(request['input']), Path(request['work'])
    if not source.is_absolute() or not work.is_absolute():
        raise ValueError('Absolute owned paths required')
    if _file_digest(source) != request['sha256']:
        raise ValueError('Source media changed')
    document = request['document']
    identity = dict(audio=request['sha256'], document=document, model=fingerprint(profile['align_model']),
                    runtime=version('mlx-audio'), adapter='qwen-existing-v1')
    cache = work / ('alignment-' + _digest(identity))
    cache.mkdir(parents=True, exist_ok=True)
    emit(phase='prepare')
    audio = prepare_audio(source, cache)
    duration = _wav_frames(audio) / SAMPLE_RATE
    model = None
    def align(cue):
        nonlocal model
        key = _digest(cue)
        def generate():
            nonlocal model
            from mlx_audio.stt import load
            if model is None:
                with contextlib.redirect_stdout(sys.stderr):
                    model = load(profile['align_model'])
            start, end = cue['start'], cue['end']
            cut = cache / (key + '.wav')
            try:
                write_chunk(audio, AudioChunk(0, round(start*SAMPLE_RATE), round(end*SAMPLE_RATE), 0, 0), cut)
                emit(phase='align')
                with contextlib.redirect_stdout(sys.stderr):
                    response = model.generate(audio=str(cut), text=cue['text'], language=language_name(document.get('language')))
                return [dict(word=item.text, start=float(item.start_time)+start, end=float(item.end_time)+start)
                        for item in getattr(response, 'items', response)]
            finally:
                cut.unlink(missing_ok=True)
        return checkpoint(cache / (key + '.json'), generate)
    result = align_document(document, duration, align)
    result['source_sha256'] = request['sha256']
    result['alignment_identity'] = _digest(identity)
    emit(phase='save')
    save_document(result, work / 'result.json')
    emit(phase='done')
