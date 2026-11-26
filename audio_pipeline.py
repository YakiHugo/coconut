"""Shared long-audio orchestration. ASR backends only see bounded mono WAV chunks.

Backends return chunk-relative segments/words. Audio clocks, ownership, recovery,
and recording-scoped speaker identities belong to this module, not the provider.
"""
from __future__ import annotations

import copy
from contextlib import contextmanager, ExitStack
import errno
import hashlib
import json
import math
import os
import stat
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


class InvalidWindowClocks(ValueError):
    def __init__(self, message, raw, duration):
        super().__init__(message)
        self.raw, self.duration = raw, duration


def _without_invalid_context(value, chunk):
    core_start = (chunk.core_start_frame - chunk.start_frame) / SAMPLE_RATE
    core_end = (chunk.core_end_frame - chunk.start_frame) / SAMPLE_RATE
    view = copy.deepcopy(value)
    removed = 0
    for segment in view['segments']:
        words = segment.get('words', [])
        first, last = 0, len(words)
        while first < last and core_start > 0 and -.5 <= words[first]['start'] < 0 and words[first]['start'] <= words[first]['end'] < core_start:
            first += 1
        while last > first and core_end < chunk.duration and core_end < words[last-1]['start'] <= words[last-1]['end'] and chunk.duration + .05 < words[last-1]['end'] <= chunk.duration + .5:
            last -= 1
        if first == 0 and last == len(words):
            continue
        if first == last or not bind_word_spans(segment):
            return None
        kept = words[first:last]
        segment['words'] = kept
        segment['text'] = ''.join(word['word'] for word in kept)
        removed += len(words) - len(kept)
    if removed:
        view['discarded_invalid_context_words'] = removed
        return view
    return None


def recognize_window(backend, path, request_id, chunk):
    return validate_window_clocks(lambda: backend.recognize(path, request_id=request_id), chunk)


def validate_window_clocks(observe, chunk):
    try:
        return observe()
    except InvalidWindowClocks as error:
        if error.duration != chunk.duration:
            raise
        view = _without_invalid_context(error.raw, chunk) or error.raw
        # Preserve the text of a timed ASR window even if an individual word
        # falls outside the audio. Ownership can still use its coarse extent.
        segments = []
        for segment in view['segments']:
            try:
                validate_result({'segments': [segment]}, chunk.duration)
            except ValueError:
                segment = dict(segment)
                if not segment.pop('words', None):
                    raise
                segment.update(alignment_status='needs_review', timing_basis='audio_chunk')
            segments.append(segment)
        return validate_result({**view, 'segments': segments}, chunk.duration)


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


def plan_silence_chunks(frames, speech, chunk_seconds=240, context_seconds=5):
    """Place each ownership boundary near the target without discarding audio."""
    fixed = plan_chunks(frames, chunk_seconds, context_seconds)
    target = int(chunk_seconds * SAMPLE_RATE)
    if len(fixed) == 1:
        return fixed, set()
    ends = [0, *(stop for _, stop in speech)]
    starts = [*(start for start, _ in speech), frames]
    silence = [(start+stop)//2 for start, stop in zip(ends, starts) if stop-start >= .45*SAMPLE_RATE]
    radius = min(20*SAMPLE_RATE, target//4)
    boundaries, hard = [0], set()
    from bisect import bisect_left, bisect_right
    while frames - boundaries[-1] > target + radius:
        goal = boundaries[-1] + target
        choices = silence[bisect_left(silence, goal-radius):bisect_right(silence, goal+radius)]
        if choices:
            boundaries.append(min(choices, key=lambda cut: (abs(cut-goal), cut)))
        else:
            boundaries.append(goal)
            hard.add(len(boundaries)-1)
    # A short tail is better than a forced cut. The maximum extent remains bounded.
    boundaries.append(frames)
    context = int(context_seconds*SAMPLE_RATE)
    chunks = [AudioChunk(i, max(0, a-context) if i in hard else a,
                         min(frames, b+context) if i+1 in hard else b, a, b)
              for i, (a, b) in enumerate(zip(boundaries, boundaries[1:]))]
    return chunks, hard


def _wav_frames(path):
    with wave.open(str(path), 'rb') as stream:
        if (stream.getnchannels(), stream.getsampwidth(), stream.getframerate(), stream.getcomptype()) != (
                1, 2, SAMPLE_RATE, 'NONE') or not stream.getnframes():
            raise ValueError('Expected nonempty 16 kHz mono PCM16 audio')
        return stream.getnframes()


def prepare_audio(source, directory, *, max_frames=None):
    cache = os.environ.get('COCONUT_PCM_CACHE')
    # Only server-owned immutable assets enter the shared cache. Ordinary
    # command-line paths retain their own work directory.
    if not cache or not Path(cache).is_absolute() or os.name != 'posix' or Path(source).suffix != '.media':
        return _prepare_audio_local(source, directory, max_frames=max_frames)
    root = Path(cache)
    root.mkdir(mode=0o700, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Unsafe PCM cache directory')
    identity = _file_digest(source)
    if Path(source).stem != identity:
        raise ValueError('Saved audio identity changed')
    entry = root / identity
    entry.mkdir(mode=0o700, exist_ok=True)
    info = entry.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Unsafe PCM cache entry')
    # Per-source lock avoids duplicate decoding. The index lock protects cache
    # hard links across sources; a worker keeps its own link during eviction.
    with _pcm_lock(entry / 'decode.lock'):
        target = entry / 'audio.wav'
        local = Path(directory) / 'audio.wav'
        with _pcm_lock(root / 'cache.lock'):
            if target.is_file():
                try:
                    info = target.lstat()
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                        raise ValueError('Unsafe normalized audio')
                    frames = _wav_frames(target)
                    if info.st_size < frames * 2 + 44:
                        raise ValueError('Truncated normalized audio')
                except (wave.Error, EOFError, ValueError):
                    target.unlink()
                else:
                    if max_frames is not None and frames > max_frames:
                        raise RuntimeError('Decoded PCM frame limit exceeded')
                    if local.exists() and local.samefile(target):
                        return local
                    temporary = local.with_name('audio.cache.partial.wav')
                    temporary.unlink(missing_ok=True)
                    try:
                        os.link(target, temporary)
                        temporary.replace(local)
                        os.utime(target)
                        return local
                    except OSError as error:
                        if error.errno != errno.EXDEV:
                            raise
                    finally:
                        temporary.unlink(missing_ok=True)
        normalized = _prepare_audio_local(source, Path(directory), max_frames=max_frames)
        if normalized != local or target.exists():
            return normalized
        size = local.stat().st_size
        budget = 2 * 1024**3
        if size > budget:
            return normalized
        with _pcm_lock(root / 'cache.lock'):
            entries = [(item.stat(), item) for item in root.glob('*/audio.wav') if item.is_file()]
            usage = sum(info.st_size for info, _ in entries)
            for info, old in sorted(entries, key=lambda entry: entry[0].st_mtime_ns):
                if usage + size <= budget:
                    break
                old.unlink()
                usage -= info.st_size
            try:
                local.chmod(0o600)
                os.link(local, target)
            except OSError as error:
                if error.errno != errno.EXDEV:
                    raise
        return normalized


@contextmanager
def _pcm_lock(path):
    import fcntl
    with os.fdopen(os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), 'rb') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def _prepare_audio_local(source, directory, *, max_frames=None):
    """Stream decode to disk. Neither compressed input nor a 3h PCM is held in RAM."""
    try:
        frames = _wav_frames(source)
        if max_frames is not None and frames > max_frames:
            raise RuntimeError('Decoded PCM frame limit exceeded')
        return source
    except (wave.Error, EOFError, ValueError):
        pass
    import av
    target = directory / 'audio.wav'
    if target.exists():
        frames = _wav_frames(target)
        if max_frames is not None and frames > max_frames:
            raise RuntimeError('Decoded PCM frame limit exceeded')
        return target
    partial = directory / 'audio.partial.wav'
    try:
        with av.open(str(source)) as container, wave.open(str(partial), 'wb') as output:
            output.setparams((1, 2, SAMPLE_RATE, 0, 'NONE', 'not compressed'))
            resampler = av.AudioResampler(format='s16', layout='mono', rate=SAMPLE_RATE)
            decoded_frames = 0
            for frame in container.decode(audio=0):
                for converted in resampler.resample(frame):
                    block = converted.to_ndarray().tobytes()
                    decoded_frames += len(block)//2
                    if max_frames is not None and decoded_frames > max_frames:
                        raise RuntimeError('Decoded PCM frame limit exceeded')
                    output.writeframesraw(block)
            for converted in resampler.resample(None):
                block = converted.to_ndarray().tobytes()
                decoded_frames += len(block)//2
                if max_frames is not None and decoded_frames > max_frames:
                    raise RuntimeError('Decoded PCM frame limit exceeded')
                output.writeframesraw(block)
        _wav_frames(partial)
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    return target


def write_chunk(source, chunk, path):
    pcm = read_pcm_slice(source, chunk.start_frame, chunk.end_frame)
    with wave.open(str(path), 'wb') as output:
        output.setparams((1, 2, SAMPLE_RATE, 0, 'NONE', 'not compressed'))
        output.writeframes(pcm)
    return pcm


def read_pcm_slice(source, start_frame, end_frame):
    frames = end_frame - start_frame
    with wave.open(str(source), 'rb') as stream:
        stream.setpos(start_frame)
        pcm = stream.readframes(frames)
    if len(pcm) != frames * 2:
        raise ValueError('Truncated audio chunk')
    return pcm


def aligner_audio(source, start_frame, end_frame):
    import numpy as np
    waveform = np.frombuffer(read_pcm_slice(source, start_frame, end_frame), dtype='<i2').astype(np.float32)
    waveform /= 32768.0
    return waveform


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
        if segment.get('words'):
            # Timing is evidence about the text, never an alternative transcript.
            # Incomplete aligners must not make boundary cropping delete words.
            if not bind_word_spans(segment):
                segment.pop('words', None)
                segment['alignment_status'] = 'partial_text_preserved'
                value['alignment_warning'] = 'Incomplete word alignment; original text retained with segment timing'
    if value.get('language') is not None and not isinstance(value['language'], str):
        raise ValueError('Invalid ASR language')
    return value


def bind_word_spans(segment):
    """Bind complete lexical alignment to exact source slices, including punctuation."""
    text, words = segment['text'], segment.get('words', [])
    source = [(i, folded) for i, char in enumerate(text) if char.isalnum() for folded in char.casefold()]
    tokens = [''.join(c.casefold() for c in word['word'] if c.isalnum()) for word in words]
    if not source or not tokens or any(not token for token in tokens):
        return False
    if ''.join(char for _, char in source) != ''.join(tokens):
        return False
    cursor, starts = 0, []
    for token in tokens:
        starts.append(source[cursor][0])
        cursor += len(token)
    if len(set(starts)) != len(starts):
        return False
    starts[0] = 0
    for i, word in enumerate(words):
        start, end = starts[i], starts[i + 1] if i + 1 < len(starts) else len(text)
        word.update(word=text[start:end], text_start=start, text_end=end)
    segment['alignment_status'] = 'complete'
    segment['timing_basis'] = 'word'
    return True


WORD_CLOCK_TOLERANCE = .05 + 1e-9


def _rebase_word_spans(words):
    offset = 0
    for word in words:
        end = offset + len(word['word'])
        if 'text_start' in word or 'text_end' in word:
            word.update(text_start=offset, text_end=end)
        offset = end


def trim_word_edges(words):
    """Strip the matching edge tokens whenever a retained source span is cropped."""
    words = [dict(word) for word in words]
    while words:
        words[0]['word'] = words[0]['word'].lstrip()
        if words[0]['word']:
            break
        words.pop(0)
    while words:
        words[-1]['word'] = words[-1]['word'].rstrip()
        if words[-1]['word']:
            break
        words.pop()
    _rebase_word_spans(words)
    return words


def normalize_word_clocks(segment):
    """Repair local boundary jitter using only the observed speech intervals."""
    words = segment.get('words', [])
    if not words or ''.join(word['word'] for word in words) != segment['text']:
        return
    previous = None
    for word in words:
        start, end = word['start'], word['end']
        if segment['start'] - WORD_CLOCK_TOLERANCE <= start < segment['start'] <= end:
            word['start'] = segment['start']
        if start <= segment['end'] < end <= segment['end'] + WORD_CLOCK_TOLERANCE:
            word['end'] = segment['end']
        if previous is not None and 0 < previous['end'] - word['start'] <= WORD_CLOCK_TOLERANCE and word['end'] > word['start']:
            boundary = min(previous['end'], word['end'])
            if boundary >= previous['start']:
                previous['end'] = word['start'] = boundary
        previous = word

    # A collapsed unit can share an adjacent observed interval at its boundary.
    # Isolated collapses retain their zero-length evidence for a contextual retry.
    merged, pending = [], []
    for word in words:
        if word['start'] == word['end']:
            pending.append(word)
            continue
        if pending:
            prefix = ''.join(item['word'] for item in pending)
            left = merged[-1] if merged else None
            left_gap = abs(pending[0]['start'] - left['end']) if left and left['end'] > left['start'] else math.inf
            right_gap = abs(word['start'] - pending[-1]['end'])
            if left_gap <= WORD_CLOCK_TOLERANCE and left_gap <= right_gap:
                left['word'] += prefix
            elif right_gap <= WORD_CLOCK_TOLERANCE:
                word['word'] = prefix + word['word']
            else:
                merged.extend(pending)
            pending = []
        merged.append(word)
    if pending:
        if merged and merged[-1]['end'] > merged[-1]['start'] and abs(pending[0]['start'] - merged[-1]['end']) <= WORD_CLOCK_TOLERANCE:
            merged[-1]['word'] += ''.join(word['word'] for word in pending)
        else:
            merged.extend(pending)
    _rebase_word_spans(merged)
    segment['words'] = merged


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
                selected = trim_word_edges(selected)
                if not selected:
                    continue
                segment['text'] = ''.join(word['word'] for word in selected)
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
                if all('text_start' in word for word in kept):
                    kept = trim_word_edges(kept)
                    if not kept:
                        continue
                segment['words'] = kept
                segment['start'], segment['end'] = kept[0]['start'], kept[-1]['end']
                segment['text'] = _words_text(kept)
        output.append(segment)
    return sorted(output, key=lambda item: (item['start'], item['end']))


def _words_text(words):
    import re
    if all('text_start' in word for word in words):
        return ''.join(word['word'] for word in words).strip()
    if any(word['word'].startswith(' ') for word in words):
        return ''.join(word['word'] for word in words).strip()
    return re.sub(r'(?<=[\u3400-\u9fff]) (?=[\u3400-\u9fff])', '', ' '.join(word['word'] for word in words)).strip()


def run_audio_pipeline(source: Path, backend: ASRBackend, *, work_dir=None, speaker_backend=None,
                       chunk_seconds=600, context_seconds=5, local_only=False,
                       speaker_threshold=.72, speaker_margin=.08, progress=None,
                       expected_duration=None, minimum_duration=None,
                       decode_mode="buffered", cancel_event=None, pcm_queue_capacity=2,
                       max_decoded_frames=None):
    """Run/resume either local ASR or an explicitly selected cloud adapter.

    Atomic ASR and acoustic checkpoints are separate. Completed paid chunks are
    reusable when a later chunk or speaker inference fails. No automatic fallback.
    """
    if local_only and (not backend.local_only or
                       speaker_backend and not getattr(speaker_backend, 'local_only', False)):
        raise ValueError('Local-only processing cannot use a cloud/provider backend')
    if decode_mode == 'pipelined' and (not backend.local_only or
            speaker_backend and not getattr(speaker_backend, 'local_only', False)):
        raise ValueError('Pipelined decoding currently requires local-only backends')
    if decode_mode not in ('buffered', 'pipelined'):
        raise ValueError('Unknown PCM decode mode')
    def check_cancel():
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError('Audio processing cancelled')
    check_cancel()
    registry = SpeakerRegistry(speaker_threshold, speaker_margin)
    with _directory(work_dir) as directory, ExitStack() as resources:
        directory = Path(directory)
        manifest = {'version': VERSION, 'source_sha256': _file_digest(source),
                    'backend': backend.cache_key, 'local_only': local_only,
                    'chunk_seconds': chunk_seconds, 'context_seconds': context_seconds}
        if decode_mode == 'pipelined':
            manifest['decode_mode'] = 'pipelined-pcm-v1'
        marker = directory / 'manifest.json'
        if marker.exists() and json.loads(marker.read_text()) != manifest:
            raise ValueError('Audio work directory belongs to different input/options')
        save_document(manifest, marker)
        def check_duration(frames):
            duration = frames / SAMPLE_RATE
            if expected_duration is not None and abs(duration - expected_duration) > max(3, expected_duration * .005):
                raise ValueError('Audio duration does not match the transcript source')
            if minimum_duration is not None and duration + 1 < minimum_duration:
                raise ValueError('Transcript timing extends beyond the supplied audio')
        producer = None
        if decode_mode == 'pipelined':
            from pcm_producer import PCMProducer
            producer = resources.enter_context(PCMProducer(source, directory, chunk_seconds=chunk_seconds,
                context_seconds=context_seconds, cancel=cancel_event, capacity=pcm_queue_capacity))
            audio, frames, chunks = producer.audio, None, []
            stream = iter(producer)
        else:
            audio = (prepare_audio(source, directory) if max_decoded_frames is None else
                     prepare_audio(source, directory, max_frames=max_decoded_frames))
            frames = _wav_frames(audio)
            check_duration(frames)
            chunks = plan_chunks(frames, chunk_seconds, context_seconds)
            stream = ((chunk, frames) for chunk in chunks)
        output, languages, warnings, speaker_turns = [], [], [], []
        previous = None
        seam_cues, seam_evidence = [], []
        voice_key = _digest(speaker_backend.cache_key)[:16] if speaker_backend else ''
        identity_key = _digest({'voice_key': voice_key, 'threshold': speaker_threshold,
                                'margin': speaker_margin})[:16]
        for chunk, ownership_frames in stream:
            check_cancel()
            if producer:
                chunks.append(chunk)
            if progress:
                progress(chunk.index, None if producer else len(chunks))
            request_id = _digest({'manifest': manifest, 'chunk': asdict(chunk)})
            cache = directory / f'asr-{chunk.index:05d}.json'
            voice_cache = directory / f'voices-{voice_key}-{chunk.index:05d}.json'
            path = directory / f'chunk-{chunk.index:05d}.wav'
            try:
                pcm = True if producer else None
                if producer:
                    identity = {'chunk': asdict(chunk), 'pcm_sha256': _file_digest(path)}
                    identity_path = directory / f'pcm-{chunk.index:05d}.json'
                    if (cache.exists() or voice_cache.exists()) and not identity_path.exists():
                        raise ValueError('Decoded chunk checkpoint has no identity')
                    if identity_path.exists() and json.loads(identity_path.read_text()) != identity:
                        raise ValueError('Decoded chunk identity changed')
                    save_document(identity, identity_path)
                if cache.exists():
                    raw = validate_result(json.loads(cache.read_text()), chunk.duration)
                else:
                    if not producer:
                        pcm = write_chunk(audio, chunk, path)
                    raw = validate_result(recognize_window(backend, path, request_id, chunk), chunk.duration)
                    check_cancel()
                    save_document(raw, cache)
                segments = owned_segments(raw, chunk, ownership_frames)
                if previous:
                    from seam_recovery import recover_seam
                    recovered, evidence = recover_seam(previous[0], previous[1], raw, chunk)
                    seam_cues.extend(recovered)
                    seam_evidence.extend(evidence)
                    save_document({'version': 'seam-consensus-v1', 'decisions': evidence},
                                  directory / f'seam-{previous[1].index:05d}-{chunk.index:05d}.json')
                previous = (raw, chunk)
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
                        check_cancel()
                        save_document(voices, voice_cache)
                    turns = []
                    for turn in voices['turns']:
                        a, b = _time_range(turn, chunk.duration)
                        turns.append({**turn, 'speaker': str(turn['speaker']),
                                      'start': a + chunk.start, 'end': b + chunk.start})
                    decisions = registry.resolve(voices['evidence'], voices['embedding_model'])
                    label_segments(segments, turns, decisions)
                    for turn in turns:
                        decision = decisions.get(turn['speaker'], {})
                        identifier = decision.get('speaker_id')
                        start = max(turn['start'], chunk.core_start_frame / SAMPLE_RATE)
                        end = min(turn['end'], chunk.core_end_frame / SAMPLE_RATE)
                        if end > start:
                            # Unknown competing speech must survive speaker-only
                            # replay too; otherwise overlap becomes false certainty.
                            speaker_turns.append({'start': start, 'end': end,
                                'speaker': identifier or f'unresolved:{chunk.index}:{turn["speaker"]}',
                                'speaker_id': identifier,
                                'speaker_status': decision.get('status', 'insufficient_audio')})
                    save_document({'chunk': asdict(chunk), 'decisions': decisions},
                                  directory / f'identity-{identity_key}-{chunk.index:05d}.json')
                output.extend(segments)
            finally:
                path.unlink(missing_ok=True)
        check_cancel()
        if producer:
            frames = producer.frames
            check_duration(frames)
            if _file_digest(source) != manifest['source_sha256']:
                raise ValueError('Source media changed during decoding')
        output = stitch_segments(output)
        speaker_count = len(registry.voices)
        # Recovered words have unverified clocks: never inherit a neighboring
        # speaker or enter heuristic duplicate removal. Raw ASR caches are intact.
        output = sorted(output + seam_cues, key=lambda item: (item['start'], item['end']))
        for segment in output:
            normalize_word_clocks(segment)
        check_cancel()
        languages = list(dict.fromkeys(languages))
        return {'language': languages[0] if len(languages) == 1 else None, 'languages': languages,
                'segments': output, 'speaker_turns': speaker_turns,
                'seam_recovery': seam_evidence,
                'alignment_warning': '; '.join(dict.fromkeys(warnings)) or None,
                'pipeline': {'version': VERSION, 'chunks': len(chunks), 'duration': frames / SAMPLE_RATE,
                             'speaker_count': speaker_count,
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
