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


def _observations(cue, words):
    from audio_pipeline import bind_word_spans, normalize_word_clocks
    words = copy.deepcopy(words)
    if not isinstance(words, list) or not words:
        raise ValueError('missing_words')
    for word in words:
        if not isinstance(word, dict) or not isinstance(word.get('word'), str):
            raise ValueError('invalid_words')
        if not all(type(word.get(key)) in (int, float) and math.isfinite(word[key]) for key in ('start', 'end')):
            raise ValueError('invalid_word_timing')
    observed = dict(text=cue['text'], start=cue['start'], end=cue['end'], words=words)
    if not bind_word_spans(observed):
        raise ValueError('incomplete_text_mapping')
    normalize_word_clocks(observed)
    return observed['words']


def _clock_path(cue, original, alternate=None):
    paths = [(cue['start'], 0, None)]
    if alternate is not None and [w['word'] for w in alternate] != [w['word'] for w in original]:
        return None
    for index, word in enumerate(original):
        choices = [word]
        if alternate is not None:
            other = alternate[index]
            if max(abs(other[key] - word[key]) for key in ('start', 'end')) <= .24 + 1e-9:
                choices.append(other)
        paths_next = []
        for changed, choice in enumerate(choices):
            if not cue['start'] <= choice['start'] < choice['end'] <= cue['end']:
                continue
            prior = min((state for state in paths if state[0] <= choice['start']),
                        key=lambda state: state[1], default=None)
            if prior is not None:
                paths_next.append((choice['end'], prior[1] + changed, (choice, prior[2])))
        if not paths_next:
            return None
        paths = paths_next
    node = min(paths, key=lambda state: state[1])[2]
    selected = []
    while node is not None:
        word, node = node
        selected.append(word)
    return selected[::-1]


def _partial_word_clocks(cue):
    """Retain the longest compatible set of observed clocks and exact source slices."""
    words = cue['words']
    if ''.join(word['word'] for word in words) != cue['text']:
        return None
    valid = [i for i, w in enumerate(words) if cue['start'] <= w['start'] < w['end'] <= cue['end']]
    if not valid:
        return None
    paths = {}
    for i in valid:
        best = max((j for j in paths if words[j]['end'] <= words[i]['start']),
                   key=lambda j: paths[j][0], default=None)
        paths[i] = (1 if best is None else paths[best][0] + 1, best)
    cursor = max(paths, key=lambda i: paths[i][0])
    kept = set()
    while cursor is not None:
        kept.add(cursor)
        cursor = paths[cursor][1]
    clocks = []
    edge = cue['start']
    for i, word in enumerate(words):
        if i in kept:
            clocks.append(word)
            edge = word['end']
        else:
            clocks.append(dict(word, start=edge, end=edge))
    return clocks


def align_document(document, duration, align, *, retry=None):
    """Pure validation boundary; align(cue) returns recording-relative word clocks."""
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
                first = _observations(cue, align(cue))
                words = _clock_path(cue, first)
                if words is None and retry is not None and all(start - .24 <= w['start'] <= w['end'] <= end + .24 for w in first):
                    words = _clock_path(cue, first, _observations(cue, retry(cue)))
                    if words:
                        row['clock_recovery'] = 'context_pass'
                if words is None:
                    raise ValueError('invalid_word_timing')
                cue.update(words=words, timing_basis='word', alignment_status='complete')
                row.update(status='aligned', reason=None)
            except Exception:
                # Do not leak model paths/errors, erase original clocks, or manufacture timing.
                row['reason'] = 'alignment_unverified'
        rows.append(row)
    count = sum(row['status'] == 'aligned' for row in rows)
    report = dict(schema_version=1, source_text_quality='unverified', status='candidate' if count == len(rows) else 'needs_review',
                  aligned_cues=count, total_cues=len(rows), coverage=count / len(rows), cues=rows)
    result['provenance'] = {**result.get('provenance', {}), 'alignment_method': 'qwen-existing-v2', 'source_text_quality': 'unverified'}
    return dict(document=result, alignment_report=report, source_snapshot=copy.deepcopy(document))


def audio_aligner(audio, frames, cache, model_path, language, model=None):
    from audio_pipeline import SAMPLE_RATE, _digest, aligner_audio
    from transcription import checkpoint, emit
    def align(cue, padding=0):
        key = _digest([cue['start'], cue['end'], cue['text'], language, padding])
        def generate():
            nonlocal model
            from mlx_audio.stt import load
            if model is None:
                with contextlib.redirect_stdout(sys.stderr):
                    model = load(model_path)
            begin = max(0, round((cue['start'] - padding) * SAMPLE_RATE))
            finish = min(frames, round((cue['end'] + padding) * SAMPLE_RATE))
            waveform = aligner_audio(audio, begin, finish)
            emit(phase='align')
            with contextlib.redirect_stdout(sys.stderr):
                response = model.generate(audio=waveform, text=cue['text'], language=language_name(language))
            return [dict(word=item.text, start=float(item.start_time)+begin/SAMPLE_RATE, end=float(item.end_time)+begin/SAMPLE_RATE)
                    for item in getattr(response, 'items', response)]
        return checkpoint(cache / (key + '.json'), generate)
    return align


def repair_transcribed_clocks(document, source, directory, model_path, model=None):
    """Keep ASR text. Retry bad word clocks once against the finalized sentence."""
    from audio_pipeline import SAMPLE_RATE, _wav_frames, normalize_word_clocks, prepare_audio
    for cue in document['segments']:
        normalize_word_clocks(cue)
    pending = [cue for cue in document['segments'] if cue.get('words') and
               (_clock_path(cue, cue['words']) is None or
                ''.join(w['word'] for w in cue['words']) != cue['text'])]
    if not pending:
        return
    cache = directory / 'sentence-clocks-v1'
    cache.mkdir(parents=True, exist_ok=True)
    audio = prepare_audio(source, directory)
    frames = _wav_frames(audio)
    measure = audio_aligner(audio, frames, cache, model_path, document.get('language'), model)
    check = align_document(dict(segments=pending), frames / SAMPLE_RATE, lambda cue: cue['words'],
                           retry=lambda cue: measure(cue, .20))
    for cue, recovered, row in zip(pending, check['document']['segments'], check['alignment_report']['cues']):
        if row['status'] == 'aligned':
            cue.update(words=recovered['words'], alignment_status='complete', timing_basis='word')
        else:
            partial = _partial_word_clocks(cue)
            if partial:
                cue.update(words=partial, alignment_status='needs_review', timing_basis='word_partial')
            else:
                cue.pop('words', None)
                cue.update(alignment_status='needs_review', timing_basis='segment')


def run_alignment(request):
    from audio_pipeline import _digest, _file_digest, _wav_frames, prepare_audio, SAMPLE_RATE
    from transcription import fingerprint, emit
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
                    runtime=version('mlx-audio'), adapter='qwen-existing-v2')
    cache = work / ('alignment-' + _digest(identity))
    cache.mkdir(parents=True, exist_ok=True)
    emit(phase='prepare')
    audio = prepare_audio(source, cache)
    frames = _wav_frames(audio)
    duration = frames / SAMPLE_RATE
    align = audio_aligner(audio, frames, cache, profile['align_model'], document.get('language'))
    result = align_document(document, duration, align, retry=lambda cue: align(cue, .20))
    result['source_sha256'] = request['sha256']
    result['alignment_identity'] = _digest(identity)
    emit(phase='save')
    save_document(result, work / 'result.json')
    emit(phase='done')
