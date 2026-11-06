"""Offline MOSS recipe: native segment clocks and scoped anonymous people.

MOSS has no word clocks with which to crop overlapping context safely. Decode
bounded, disjoint audio blocks and retain every native nonempty segment instead
of applying midpoint ownership. A cut can still affect recognition at the audio
boundary; this recipe does not claim otherwise or infer cross-block identity.
Importing this module neither imports MLX nor loads/downloads model weights.
"""
from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timezone
import contextlib
import copy
import hashlib
from importlib.metadata import version
import json
import math
import os
from pathlib import Path
import re
import sys

from audio_pipeline import (_directory, _file_digest, _wav_frames, plan_chunks,
                            prepare_audio, write_chunk)
from transcript import save_document

VERSION = 'moss-native-disjoint-v1'
CHUNK_SECONDS = 1800
DEFAULT_PROMPT = (
    'Transcribe the audio into text. Start each segment with the start '
    'timestamp and speaker label ([S01], [S02], [S03], ...), write the '
    'corresponding spoken content, and end each segment with the ending '
    'timestamp to clearly mark the segment range.'
)
STRUCTURED = re.compile(
    r'\[(?P<start>\d+(?:\.\d+)?)\]\[(?P<speaker>S\d+)\]'
    r'(?P<text>.*?)\[(?P<end>\d+(?:\.\d+)?)\]', re.S)


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     allow_nan=False).encode()).hexdigest()


def _prompt(title, hotwords):
    if not isinstance(title, str) or len(title) > 1000:
        raise ValueError('Invalid transcription title context')
    if hotwords is None:
        hotwords = []
    if (not isinstance(hotwords, list) or len(hotwords) > 64 or any(
            not isinstance(word, str) or not word.strip() or len(word) > 80
            for word in hotwords)):
        raise ValueError('Invalid transcription vocabulary')
    result = DEFAULT_PROMPT
    if title.strip():
        result += '\n节目标题（仅供识别参考，不要添加未说出的内容）：' + title.strip()
    vocabulary = list(dict.fromkeys(word.strip() for word in hotwords))
    if vocabulary:
        result += '\n热词提示：' + ', '.join(vocabulary)
    return result


def _runtime_identity(model_path):
    # Use the same complete-local-model guard as the Qwen worker. Include the
    # chat template too: tokenizer/prompt changes must invalidate old work.
    from transcription import model_files
    config = json.loads((model_path / 'config.json').read_text())
    if config.get('model_type') != 'moss_transcribe_diarize':
        raise ValueError('Expected a local MOSS transcription model')
    files = sorted(set(model_files(model_path) + list(model_path.glob('*.jinja'))))
    return {'model_path': str(model_path),
            'model_files': [{'name': p.name, 'sha256': _file_digest(p)} for p in files],
            'runtime': {name: version(name) for name in ('mlx', 'mlx-audio', 'av')},
            'adapter_sha256': _file_digest(Path(__file__)),
            'audio_pipeline_sha256': _file_digest(Path(__file__).with_name('audio_pipeline.py'))}


def _load_model(model_path):
    # A validated absolute directory is passed, never a Hub repository name.
    # The worker sets offline flags before loading any provider dependencies.
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                      HF_HUB_DISABLE_IMPLICIT_TOKEN='1')
    from mlx_audio.stt import load
    with contextlib.redirect_stdout(sys.stderr):
        return load(str(model_path), lazy=False, strict=True)


def _budget(duration):
    return min(65536, max(4096, math.ceil(duration * 16) + 1024))


def normalize_native(raw_text, native_segments, duration, generation_tokens, budget):
    """Reject partial/fallback parses and retain exact native text and clocks.

    MLX's adapter prepends ``[Sxx] `` to each displayed text and omits empty
    native cues. The raw markup is checked independently so its permissive
    fallback (untimed free text or a truncated final cue) cannot pass as success.
    """
    if not isinstance(raw_text, str) or not isinstance(native_segments, list):
        raise ValueError('MOSS output must contain raw text and native segments')
    if (type(generation_tokens) is not int or generation_tokens < 0 or
            generation_tokens >= budget):
        raise ValueError('MOSS generation limit reached or token count missing')
    if not raw_text.strip():
        if any(not isinstance(s, dict) or not isinstance(s.get('text'), str) or
               s['text'].strip() for s in native_segments):
            raise ValueError('Empty MOSS raw text with nonempty native output')
        return []
    matches = list(STRUCTURED.finditer(raw_text))
    cursor = 0
    for match in matches:
        if raw_text[cursor:match.start()].strip():
            raise ValueError('MOSS output outside timestamped segments')
        cursor = match.end()
    if not matches or raw_text[cursor:].strip():
        raise ValueError('MOSS transcript is unparsed or truncated')
    nonempty = [m for m in matches if m['text'].strip()]
    if len(nonempty) != len(native_segments):
        raise ValueError('MOSS raw/native segment counts differ')
    previous = -1.0
    result = []
    for index, (match, segment) in enumerate(zip(nonempty, native_segments)):
        if not isinstance(segment, dict):
            raise ValueError('Invalid MOSS native segment')
        label = match['speaker']
        text = segment.get('text')
        if isinstance(text, str) and text.startswith(f'[{label}] '):
            text = text[len(label) + 3:]
        start, end = segment.get('start'), segment.get('end')
        if (segment.get('speaker_id') != label or text != match['text'].strip() or
                start != float(match['start']) or end != float(match['end'])):
            raise ValueError(f'MOSS raw/native fields differ at segment {index}')
        if (any(type(v) not in (int, float) or not math.isfinite(v) for v in (start, end)) or
                not 0 <= start < end <= duration + .05 or start < previous):
            raise ValueError(f'Invalid MOSS native clock at segment {index}')
        previous = start
        result.append({'start': start, 'end': end, 'text': text,
                       'local_speaker_id': label, 'timing_basis': 'native_segment',
                       'alignment_status': 'not_requested'})
    return result


def _capture(generated, budget, identity):
    return {'identity': identity, 'status': 'captured', 'max_tokens': budget,
            'raw_text': getattr(generated, 'text', None),
            'native_segments': copy.deepcopy(getattr(generated, 'segments', None)),
            'generation_tokens': getattr(generated, 'generation_tokens', None),
            'metrics': {name: getattr(generated, name, None) for name in (
                'prompt_tokens', 'generation_tokens', 'total_tokens', 'total_time',
                'prompt_tps', 'generation_tps')}}


def run_moss_pipeline(source: Path, *, model_path: str | Path, work_dir: Path,
                      title: str = '', hotwords: list | None = None,
                      progress=None, chunk_seconds: float = CHUNK_SECONDS):
    """Run/resume one complete local recipe without external speaker/alignment.

    ``progress(index, total)`` uses zero-based indexes, like run_audio_pipeline.
    ``speaker_count`` counts scoped groups; for multiple blocks it is not the
    recording's true number of people. No result is returned after a failed or
    truncated block. Completed raw checkpoints remain reusable on explicit retry.
    """
    source, model_path, work_dir = Path(source), Path(model_path), Path(work_dir)
    if not all(p.is_absolute() for p in (source, model_path, work_dir)):
        raise ValueError('Absolute owned input, work and local model paths required')
    if not source.is_file() or not model_path.is_dir():
        raise ValueError('Missing input or local MOSS model directory')
    if (type(chunk_seconds) not in (int, float) or not math.isfinite(chunk_seconds) or
            not 0 < chunk_seconds <= CHUNK_SECONDS):
        raise ValueError('MOSS processing blocks must be positive and at most 30 minutes')
    prompt = _prompt(title, hotwords)
    runtime = _runtime_identity(model_path)
    source_hash = _file_digest(source)
    manifest = {'version': VERSION, 'source_sha256': source_hash, 'runtime': runtime,
                'chunk_seconds': chunk_seconds, 'context_seconds': 0, 'prompt': prompt,
                'generation': {'max_tokens': 'min(65536,max(4096,ceil(duration*16)+1024))',
                               'temperature': 0.0, 'top_p': 1.0, 'top_k': 0,
                               'min_p': 0.0, 'repetition_penalty': None,
                               'prefill_step_size': 4096}}
    with _directory(work_dir) as directory:
        directory = Path(directory)
        marker = directory / 'manifest.json'
        if marker.exists() and json.loads(marker.read_text()) != manifest:
            raise ValueError('MOSS work directory belongs to different input/options')
        save_document(manifest, marker)
        audio = prepare_audio(source, directory)
        frames = _wav_frames(audio)
        audio_identity = {'sha256': _file_digest(audio), 'frames': frames, 'sample_rate': 16000}
        audio_marker = directory / 'prepared-audio.json'
        if audio_marker.exists() and json.loads(audio_marker.read_text()) != audio_identity:
            raise ValueError('Prepared MOSS audio changed')
        save_document(audio_identity, audio_marker)
        chunks = plan_chunks(frames, chunk_seconds, context_seconds=0)
        output, summaries, identities = [], [], {}
        model = None
        for chunk in chunks:
            if progress:
                progress(chunk.index, len(chunks))
            identity = {'manifest_sha256': _digest(manifest), 'chunk': asdict(chunk)}
            cache = directory / f'native-{chunk.index:05d}.json'
            clip = directory / f'chunk-{chunk.index:05d}.wav'
            record = json.loads(cache.read_text()) if cache.exists() else None
            if record is not None and record.get('identity') != identity:
                raise ValueError('MOSS checkpoint identity differs')
            reused = bool(record and record.get('status') in ('captured', 'complete'))
            try:
                if not reused:
                    if record is not None:
                        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
                        save_document(record, directory / 'attempts' / f'{chunk.index:05d}-{stamp}.json')
                    write_chunk(audio, chunk, clip)
                    if model is None:
                        model = _load_model(model_path)
                    budget = _budget(chunk.duration)
                    # Build one complete prompt ourselves. Some installed MLX
                    # releases merge hotwords twice; no provider hotwords kwarg
                    # is needed and metadata is never copied into the output.
                    with contextlib.redirect_stdout(sys.stderr):
                        generated = model.generate(str(clip), max_tokens=budget,
                            prompt=prompt, temperature=0.0, top_p=1.0, top_k=0,
                            min_p=0.0, repetition_penalty=None,
                            prefill_step_size=4096, verbose=False, stream=False)
                    record = _capture(generated, budget, identity)
                    save_document(record, cache)
                if record.get('max_tokens') != _budget(chunk.duration):
                    raise ValueError('MOSS checkpoint generation budget differs')
                segments = normalize_native(record['raw_text'], record['native_segments'],
                                            chunk.duration, record.get('generation_tokens'),
                                            _budget(chunk.duration))
                record['status'] = 'complete'
                save_document(record, cache)
                scope = 'recording' if len(chunks) == 1 else 'chunk'
                for segment in segments:
                    label = segment.pop('local_speaker_id')
                    key = (chunk.index, label)
                    identifier = identities.setdefault(key, f'speaker-{len(identities) + 1:04d}')
                    output.append({**segment, 'start': segment['start'] + chunk.start,
                        'end': segment['end'] + chunk.start, 'chunk_index': chunk.index,
                        'speaker_id': identifier, 'provider_speaker': f'{chunk.index}:{label}',
                        'speaker': label if scope == 'recording' else f'第{chunk.index + 1}块 · {label}',
                        'speaker_scope': scope,
                        'speaker_status': 'native_recording' if scope == 'recording' else 'native_chunk_local'})
                summaries.append({'index': chunk.index, 'segments': len(segments),
                                  'reused': reused, 'empty_output': not segments})
            except Exception as exc:
                # Keep captured malformed or exhausted output as diagnostics;
                # it must not become a complete checkpoint or a partial success.
                failure = dict(record or {'identity': identity})
                failure.update(status='failed', error={'type': type(exc).__name__, 'message': str(exc)})
                save_document(failure, cache)
                raise
            finally:
                clip.unlink(missing_ok=True)
        if _file_digest(source) != source_hash:
            raise ValueError('Source media changed during MOSS transcription')
        return {'language': None, 'languages': [], 'segments': output,
                'alignment_warning': None,
                'pipeline': {'version': VERSION, 'chunks': len(chunks),
                    'duration': frames / 16000, 'speaker_method': 'moss-native-v1',
                    'speaker_count': len(identities),
                    'recording_speaker_count': len(identities) if len(chunks) == 1 else None,
                    'speaker_scope': 'recording' if len(chunks) == 1 else 'chunk',
                    'boundary_method': 'disjoint-native-segments-v1',
                    'chunk_summaries': summaries}}
