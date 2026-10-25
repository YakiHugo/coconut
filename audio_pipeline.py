"""Shared long-audio orchestration. ASR backends only see bounded mono WAV chunks.

Backends return chunk-relative segments/words. Audio clocks, ownership, recovery,
and recording-scoped speaker identities belong to this module, not the provider.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import subprocess
import tempfile
import wave
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol

from audio_speakers import SpeakerRegistry, label_segments, unit_vector
from transcript import save_document

VERSION = 'audio-pipeline-v1'
SAMPLE_RATE = 16000


class ASRBackend(Protocol):
    cache_key: dict
    local_only: bool

    def recognize(self, path: Path, *, request_id: str) -> dict:
        """Return {language, segments:[{start,end,text,words?}], ...}."""
        ...


class SpeakerBackend(Protocol):
    cache_key: dict
    local_only: bool

    def analyze(self, path: Path) -> dict:
        """Return chunk-relative turns, clean embedding evidence, embedding_model."""
        ...


@dataclass
class CallableBackend:
    cache_key: dict
    callback: object
    local_only: bool = True

    def recognize(self, path, *, request_id):
        return self.callback(path)


class JsonCommandBackend:
    """Explicit provider bridge, including cloud SDKs; no provider auto-selection.

    A trusted executable reads a JSON request from stdin and emits one JSON ASR
    result. Credentials stay in its environment, never checkpoints or documents.
    request_id is stable across retries, available for provider idempotency keys.
    """
    local_only = False

    def __init__(self, command, *, identity, language=None, timeout=1800):
        if not command or not identity or timeout <= 0:
            raise ValueError('A provider command and versioned identity are required')
        self.command, self.timeout = list(command), timeout
        self.language = language
        self.cache_key = {'backend': identity, 'command_sha256': _digest(self.command), 'language': language}

    def recognize(self, path, *, request_id):
        process = subprocess.run(self.command, input=json.dumps({
            'schema_version': 1, 'audio_path': str(path.resolve()),
            'sample_rate': SAMPLE_RATE, 'request_id': request_id,
            'language_hint': self.language,
            'timestamp_origin': 'chunk'}), text=True, capture_output=True, timeout=self.timeout)
        if process.returncode:
            # Provider stderr can contain authorization headers / signed URLs.
            raise RuntimeError(f'ASR provider command failed (exit {process.returncode})')
        return json.loads(process.stdout)


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _file_digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


@dataclass(frozen=True)
class AudioChunk:
    index: int
    start_frame: int
    end_frame: int
    core_start_frame: int
    core_end_frame: int

    @property
    def start(self):
        return self.start_frame / SAMPLE_RATE

    @property
    def duration(self):
        return (self.end_frame - self.start_frame) / SAMPLE_RATE


def plan_chunks(frames, chunk_seconds=600, context_seconds=5):
    if not all(math.isfinite(value) for value in (frames, chunk_seconds, context_seconds)) or (
            frames <= 0 or chunk_seconds <= 0 or context_seconds < 0 or context_seconds * 2 >= chunk_seconds):
        raise ValueError('Invalid audio chunk settings')
    size, context = int(chunk_seconds * SAMPLE_RATE), int(context_seconds * SAMPLE_RATE)
    if size < 1:
        raise ValueError('Audio chunk is too short')
    return [AudioChunk(index, max(0, start - context), min(frames, start + size + context),
                       start, min(frames, start + size))
            for index, start in enumerate(range(0, frames, size))]


def _wav_frames(path):
    with wave.open(str(path), 'rb') as stream:
        if (stream.getnchannels(), stream.getsampwidth(), stream.getframerate(), stream.getcomptype()) != (
                1, 2, SAMPLE_RATE, 'NONE') or not stream.getnframes():
            raise ValueError('Expected nonempty 16 kHz mono PCM16 audio')
        return stream.getnframes()


def prepare_audio(source, directory):
    """Stream decode to disk. Neither compressed input nor a 3h PCM is held in RAM."""
    try:
        _wav_frames(source)
        return source
    except (wave.Error, EOFError, ValueError):
        pass
    import av
    target = directory / 'audio.wav'
    if target.exists():
        _wav_frames(target)
        return target
    partial = directory / 'audio.partial.wav'
    try:
        with av.open(str(source)) as container, wave.open(str(partial), 'wb') as output:
            output.setparams((1, 2, SAMPLE_RATE, 0, 'NONE', 'not compressed'))
            resampler = av.AudioResampler(format='s16', layout='mono', rate=SAMPLE_RATE)
            for frame in container.decode(audio=0):
                for converted in resampler.resample(frame):
                    output.writeframesraw(converted.to_ndarray().tobytes())
            for converted in resampler.resample(None):
                output.writeframesraw(converted.to_ndarray().tobytes())
        _wav_frames(partial)
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    return target


def write_chunk(source, chunk, path):
    with wave.open(str(source), 'rb') as stream, wave.open(str(path), 'wb') as output:
        stream.setpos(chunk.start_frame)
        pcm = stream.readframes(chunk.end_frame - chunk.start_frame)
        if len(pcm) != (chunk.end_frame - chunk.start_frame) * 2:
            raise ValueError('Truncated audio chunk')
        output.setparams((1, 2, SAMPLE_RATE, 0, 'NONE', 'not compressed'))
        output.writeframes(pcm)
    return pcm


def _time_range(item, duration):
    start, end = float(item['start']), float(item['end'])
    if not math.isfinite(start) or not math.isfinite(end) or not 0 <= start <= end <= duration + .05:
        raise ValueError('Invalid chunk-relative timestamps')
    return min(start, duration), min(end, duration)


def validate_result(result, duration):
    if not isinstance(result, dict) or not isinstance(result.get('segments'), list):
        raise ValueError('ASR backend must return segments')
    value = copy.deepcopy(result)
    previous = -1
    for segment in value['segments']:
        segment['start'], segment['end'] = _time_range(segment, duration)
        if segment['start'] < previous or not isinstance(segment.get('text'), str):
            raise ValueError('ASR segments must be ordered with text')
        previous = segment['start']
        word_start = segment['start']
        for word in segment.get('words', []):
            word['start'], word['end'] = _time_range(word, duration)
            if word['start'] < word_start - .05 or word['end'] > segment['end'] + .05 or not isinstance(word.get('word'), str):
                raise ValueError('Invalid ASR word timestamps')
            word_start = word['start']
    if value.get('language') is not None and not isinstance(value['language'], str):
        raise ValueError('Invalid ASR language')
    return value


def validate_voices(result, duration):
    if not isinstance(result, dict) or not isinstance(result.get('turns'), list) or not isinstance(result.get('evidence'), dict):
        raise ValueError('Invalid acoustic result')
    result = copy.deepcopy(result)
    result.setdefault('embedding_model', None)
    labels = set()
    for turn in result['turns']:
        turn['start'], turn['end'] = _time_range(turn, duration)
        turn['speaker'] = str(turn['speaker'])
        labels.add(turn['speaker'])
    for label, item in result['evidence'].items():
        if label not in labels or not isinstance(item, dict):
            raise ValueError('Acoustic evidence has no matching turn')
        length = float(item.get('duration', 0))
        if not math.isfinite(length) or not 0 <= length <= duration + .05:
            raise ValueError('Invalid clean voice duration')
        item['duration'] = length
        if item.get('embedding') is not None:
            item['embedding'] = unit_vector(item['embedding'])
            if not isinstance(result.get('embedding_model'), str) or not result['embedding_model']:
                raise ValueError('Acoustic evidence needs an embedding model identity')
    return result


def owned_segments(result, chunk, total_frames):
    start, end = chunk.core_start_frame / SAMPLE_RATE, chunk.core_end_frame / SAMPLE_RATE
    def owns(a, b):
        middle = (a + b) / 2 + chunk.start
        return start <= middle < end or middle == end and chunk.core_end_frame == total_frames
    output = []
    for raw in result['segments']:
        segment = copy.deepcopy(raw)
        # A provider's local speaker_0 has no recording-wide identity.
        local_label = segment.pop('speaker', None)
        segment.pop('speaker_id', None)
        words = segment.get('words')
        if words:
            selected = [word for word in words if owns(word['start'], word['end'])]
            if not selected:
                continue
            if len(selected) != len(words):
                segment['text'] = _words_text(selected)
                segment['start'], segment['end'] = selected[0]['start'], selected[-1]['end']
            segment['words'] = [{**word, 'start': word['start'] + chunk.start,
                                 'end': word['end'] + chunk.start} for word in selected]
        elif not owns(segment['start'], segment['end']):
            continue
        elif segment['start'] + chunk.start < start or segment['end'] + chunk.start > end:
            segment['boundary_status'] = 'segment_timing_only'
        if not segment['text'].strip():
            continue
        segment.update(start=segment['start'] + chunk.start, end=segment['end'] + chunk.start,
                       chunk_index=chunk.index, speaker=None, speaker_id=None,
                       speaker_status='no_acoustic_identity')
        if local_label is not None:
            segment['provider_speaker'] = f'{chunk.index}:{local_label}'
        output.append(segment)
    return output


def stitch_segments(segments):
    """Remove only same-word, same-time duplicates produced across a seam.

    Ownership handles ordinary context. Decoder jitter can move a word midpoint
    across the ownership boundary in both results. Temporal overlap distinguishes
    that duplicate from a genuine repetition/stutter at adjacent timestamps.
    """
    import re
    recent = []
    output = []
    for segment in sorted(segments, key=lambda item: (item['start'], item['end'])):
        words = segment.get('words')
        if words:
            kept = []
            for word in words:
                token = re.sub(r'[\W_]+', '', word['word']).casefold()
                duplicate = False
                for prior, chunk, identity in recent:
                    if chunk == segment['chunk_index'] or not token:
                        continue
                    if identity and segment.get('speaker_id') and identity != segment['speaker_id']:
                        continue
                    overlap = min(word['end'], prior['end']) - max(word['start'], prior['start'])
                    shortest = min(word['end'] - word['start'], prior['end'] - prior['start'])
                    if shortest > 0 and overlap >= shortest * .5 and token == re.sub(r'[\W_]+', '', prior['word']).casefold():
                        duplicate = True
                        break
                if not duplicate:
                    kept.append(word)
                    recent.append((word, segment['chunk_index'], segment.get('speaker_id')))
                    recent = recent[-64:]
            if not kept:
                continue
            if len(kept) != len(words):
                segment['words'] = kept
                segment['start'], segment['end'] = kept[0]['start'], kept[-1]['end']
                segment['text'] = _words_text(kept)
        output.append(segment)
    return sorted(output, key=lambda item: (item['start'], item['end']))


def _words_text(words):
    import re
    if any(word['word'].startswith(' ') for word in words):
        return ''.join(word['word'] for word in words).strip()
    return re.sub(r'(?<=[\u3400-\u9fff]) (?=[\u3400-\u9fff])', '', ' '.join(word['word'] for word in words)).strip()


def run_audio_pipeline(source: Path, backend: ASRBackend, *, work_dir=None, speaker_backend=None,
                       chunk_seconds=600, context_seconds=5, local_only=False,
                       speaker_threshold=.72, speaker_margin=.08, progress=None):
    """Run/resume either local ASR or an explicitly selected cloud adapter.

    Atomic ASR and acoustic checkpoints are separate. Completed paid chunks are
    reusable when a later chunk or speaker inference fails. No automatic fallback.
    """
    if local_only and (not backend.local_only or
                       speaker_backend and not getattr(speaker_backend, 'local_only', False)):
        raise ValueError('Local-only processing cannot use a cloud/provider backend')
    registry = SpeakerRegistry(speaker_threshold, speaker_margin)
    with _directory(work_dir) as directory:
        directory = Path(directory)
        manifest = {'version': VERSION, 'source_sha256': _file_digest(source),
                    'backend': backend.cache_key, 'local_only': local_only,
                    'chunk_seconds': chunk_seconds, 'context_seconds': context_seconds}
        marker = directory / 'manifest.json'
        if marker.exists() and json.loads(marker.read_text()) != manifest:
            raise ValueError('Audio work directory belongs to different input/options')
        save_document(manifest, marker)
        audio = prepare_audio(source, directory)
        frames = _wav_frames(audio)
        chunks = plan_chunks(frames, chunk_seconds, context_seconds)
        output, languages, warnings, speaker_turns = [], [], [], []
        voice_key = _digest(speaker_backend.cache_key)[:16] if speaker_backend else ''
        identity_key = _digest({'voice_key': voice_key, 'threshold': speaker_threshold,
                                'margin': speaker_margin})[:16]
        for chunk in chunks:
            if progress:
                progress(chunk.index, len(chunks))
            request_id = _digest({'manifest': manifest, 'chunk': asdict(chunk)})
            cache = directory / f'asr-{chunk.index:05d}.json'
            voice_cache = directory / f'voices-{voice_key}-{chunk.index:05d}.json'
            path = directory / f'chunk-{chunk.index:05d}.wav'
            try:
                pcm = None
                if cache.exists():
                    raw = validate_result(json.loads(cache.read_text()), chunk.duration)
                else:
                    pcm = write_chunk(audio, chunk, path)
                    raw = validate_result(backend.recognize(path, request_id=request_id), chunk.duration)
                    save_document(raw, cache)
                segments = owned_segments(raw, chunk, frames)
                if raw.get('language'):
                    languages.append(raw['language'])
                if raw.get('alignment_warning'):
                    warnings.append(raw['alignment_warning'])
                if speaker_backend:
                    if voice_cache.exists():
                        voices = validate_voices(json.loads(voice_cache.read_text()), chunk.duration)
                    else:
                        if pcm is None:
                            write_chunk(audio, chunk, path)
                        voices = validate_voices(speaker_backend.analyze(path), chunk.duration)
                        save_document(voices, voice_cache)
                    turns = []
                    for turn in voices['turns']:
                        a, b = _time_range(turn, chunk.duration)
                        turns.append({**turn, 'speaker': str(turn['speaker']),
                                      'start': a + chunk.start, 'end': b + chunk.start})
                    decisions = registry.resolve(voices['evidence'], voices['embedding_model'])
                    label_segments(segments, turns, decisions)
                    for turn in turns:
                        identifier = decisions.get(turn['speaker'], {}).get('speaker_id')
                        start = max(turn['start'], chunk.core_start_frame / SAMPLE_RATE)
                        end = min(turn['end'], chunk.core_end_frame / SAMPLE_RATE)
                        if identifier and end > start:
                            speaker_turns.append({'start': start, 'end': end, 'speaker': identifier})
                    save_document({'chunk': asdict(chunk), 'decisions': decisions},
                                  directory / f'identity-{identity_key}-{chunk.index:05d}.json')
                output.extend(segments)
            finally:
                path.unlink(missing_ok=True)
        output = stitch_segments(output)
        languages = list(dict.fromkeys(languages))
        return {'language': languages[0] if len(languages) == 1 else None, 'languages': languages,
                'segments': output, 'speaker_turns': speaker_turns,
                'alignment_warning': '; '.join(dict.fromkeys(warnings)) or None,
                'pipeline': {'version': VERSION, 'chunks': len(chunks), 'duration': frames / SAMPLE_RATE,
                             'speaker_count': len(registry.voices),
                             'speaker_method': 'recording-acoustic-v1' if speaker_backend else 'unavailable'}}


class _directory:
    def __init__(self, path):
        self.temporary = tempfile.TemporaryDirectory() if path is None else None
        self.path = Path(self.temporary.name if self.temporary else path)
        self.lock = None

    def __enter__(self):
        import fcntl
        self.path.mkdir(parents=True, exist_ok=True)
        self.lock = (self.path / 'pipeline.lock').open('a')
        try:
            fcntl.flock(self.lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.lock.close()
            if self.temporary:
                self.temporary.cleanup()
            raise RuntimeError('Another worker owns this audio work directory')
        return self.path

    def __exit__(self, *_):
        self.lock.close()
        if self.temporary:
            self.temporary.cleanup()
        return False
