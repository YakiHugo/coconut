"""Private FD/watermark local-ASR protocol. Provisional output is never a document."""
from __future__ import annotations
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import select
import signal
import stat
import threading
import time
from dataclasses import asdict

MAX_MEDIA = 200 * 1024 * 1024
MAX_FRAMES = 6 * 3600 * 16000
MAX_WORK = 2 * 1024 * 1024 * 1024
MAX_CONTROL = 65536
MAX_INITIAL_REQUEST = 64 * 1024 * 1024  # Ordinary alignment includes the full document.
FALLBACK_REASONS = {'stream_decode_unavailable', 'canonical_pcm_mismatch'}


def initial_request(fd=0):
    # Do not prefetch append/seal into TextIOWrapper's buffer before raw control IO.
    data = bytearray()
    while len(data) <= MAX_INITIAL_REQUEST:
        byte = os.read(fd, 1)
        if not byte:
            raise ValueError('Missing worker request')
        if byte == b'\n':
            request = json.loads(data)
            if request.get('operation') in ('transcribe_incremental', 'probe_incremental') and len(data) + 1 > MAX_CONTROL:
                raise ValueError('Incremental worker request exceeds limit')
            return request
        data.extend(byte)
    raise ValueError('Worker request exceeds limit')


class StreamFailure(RuntimeError):
    """Hard transport/identity/limit failure, never a format fallback."""


class StreamCapability(RuntimeError):
    pass


class Control:
    def __init__(self, media_fd, attempt_id, *, wait_seconds=120):
        import fcntl
        info = os.fstat(media_fd)
        if not stat.S_ISREG(info.st_mode) or fcntl.fcntl(media_fd, fcntl.F_GETFL) & os.O_ACCMODE != os.O_RDONLY:
            raise StreamFailure('Incremental media descriptor must be read-only and regular')
        self.fd, self.attempt_id = media_fd, attempt_id
        self.available, self.seal = 0, None
        self.condition = threading.Condition()
        self.cancel = threading.Event()
        self.error = None
        self.wait_seconds = wait_seconds
        self.updated = time.monotonic()
        self.finished = threading.Event()
        self.thread = None

    def fail(self, message):
        with self.condition:
            self.error = self.error or StreamFailure(message)
            self.cancel.set()
            self.condition.notify_all()

    def check(self):
        if self.error:
            raise self.error

    def accept(self, value):
        with self.condition:
            self.check()
            if not isinstance(value, dict) or value.get('attempt_id') != self.attempt_id:
                raise StreamFailure('Incremental attempt identity changed')
            kind = value.get('type')
            if kind == 'abort':
                self.fail('Incremental processing cancelled')
                return
            if self.seal is not None:
                raise StreamFailure('Control received after media seal')
            previous = self.available
            if kind == 'append':
                size = value.get('available_bytes')
                if type(size) is not int or not self.available <= size <= MAX_MEDIA or size > os.fstat(self.fd).st_size:
                    raise StreamFailure('Invalid media watermark')
                self.available = size
            elif kind == 'seal':
                size, digest = value.get('size'), value.get('sha256')
                if type(size) is not int or not 0 < size == self.available <= MAX_MEDIA or size != os.fstat(self.fd).st_size:
                    raise StreamFailure('Invalid sealed media size')
                if not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest):
                    raise StreamFailure('Invalid sealed media digest')
                self.seal = {'size': size, 'sha256': digest}
            else:
                raise StreamFailure('Invalid incremental control type')
            if kind == 'seal' or self.available > previous:
                self.updated = time.monotonic()
            self.condition.notify_all()

    def start(self, fd=0, *, terminate_on_failure=False):
        def read():
            buffer = bytearray()
            try:
                while not self.finished.is_set():
                    self.check()
                    ready, _, _ = select.select([fd], [], [], .1)
                    if not ready:
                        continue
                    block = os.read(fd, 4096)
                    if not block:
                        raise StreamFailure('Parent control channel closed')
                    buffer.extend(block)
                    while b'\n' in buffer:
                        line, _, rest = buffer.partition(b'\n')
                        buffer = bytearray(rest)
                        if not line or len(line) > MAX_CONTROL:
                            raise StreamFailure('Invalid incremental control record')
                        self.accept(json.loads(line))
                    if len(buffer) > MAX_CONTROL:
                        raise StreamFailure('Incremental control record exceeds limit')
            except Exception:
                if not self.finished.is_set():
                    self.fail('Incremental control failed')
                    if terminate_on_failure:
                        os.kill(os.getpid(), signal.SIGTERM)
        self.thread = threading.Thread(target=read, name='coconut-spool-control', daemon=True)
        self.thread.start()

    def wait(self, predicate, cancel_event=None):
        with self.condition:
            while not predicate():
                if cancel_event is not None and cancel_event.is_set():
                    raise InterruptedError('Provisional decoder stopped')
                self.check()
                remaining = self.wait_seconds - (time.monotonic() - self.updated)
                if remaining <= 0:
                    self.fail('Incremental spool wait timed out')
                    self.check()
                self.condition.wait(min(.1, remaining))
            self.check()

    def close(self):
        self.finished.set()
        if self.thread:
            self.thread.join(1)


class LiveReader(io.RawIOBase):
    def __init__(self, control, stop=None):
        self.control, self.position, self.stop = control, 0, stop

    def readable(self):
        return True

    def seekable(self):
        return False

    def read(self, size=-1):
        if size == 0:
            return b''
        control = self.control
        control.wait(lambda: self.position < control.available or control.seal is not None, self.stop)
        count = min(control.available-self.position, 32768 if size < 0 else size)
        if not count:
            return b''  # Only a successful explicit seal permits EOF.
        data = os.pread(control.fd, count, self.position)
        if len(data) != count:
            control.fail('Media spool changed below published watermark')
            control.check()
        self.position += len(data)
        return data


def bounded_blocks(control, maximum=MAX_FRAMES, stop=None):
    import av
    frames = 0
    with av.open(LiveReader(control, stop), buffer_size=32768) as container:
        if container.format.name not in {'mp3', 'flac'}:
            raise StreamCapability('Stream format is not enabled')
        resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
        for frame in container.decode(audio=0):
            control.check()
            for converted in resampler.resample(frame):
                block = converted.to_ndarray().tobytes()
                frames += len(block)//2
                if frames > maximum:
                    raise StreamFailure('Decoded PCM frame limit exceeded')
                yield block
        for converted in resampler.resample(None):
            block = converted.to_ndarray().tobytes()
            frames += len(block)//2
            if frames > maximum:
                raise StreamFailure('Decoded PCM frame limit exceeded')
            yield block
    control.check()


def work_budget(root, extra=0):
    total = sum(path.stat().st_size for path in root.rglob('*') if path.is_file())
    if total + extra > MAX_WORK:
        raise StreamFailure('Incremental work storage limit exceeded')


def copy_sealed(control, target):
    control.wait(lambda: control.seal is not None)
    seal = control.seal
    if os.fstat(control.fd).st_size != seal['size']:
        raise StreamFailure('Sealed media size changed')
    digest = hashlib.sha256()
    partial = target.with_suffix('.partial')
    try:
        with partial.open('xb') as output:
            offset = 0
            while offset < seal['size']:
                control.check()
                block = os.pread(control.fd, min(65536, seal['size']-offset), offset)
                if not block:
                    raise StreamFailure('Sealed media truncated')
                output.write(block)
                digest.update(block)
                offset += len(block)
            output.flush()
            os.fsync(output.fileno())
        if digest.hexdigest() != seal['sha256'] or os.fstat(control.fd).st_size != seal['size']:
            raise StreamFailure('Sealed media digest mismatch')
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    return copy.deepcopy(seal)


def collect_candidates(control, backend, directory, *, chunk_seconds=240, context_seconds=5, emit=lambda **_: None):
    import av
    from pcm_producer import PCMProducer
    from audio_pipeline import _file_digest, _digest, validate_result
    from transcript import save_document
    if not getattr(backend, 'local_only', False):
        raise StreamFailure('Incremental recognition requires a local backend')
    directory.mkdir(parents=True, exist_ok=False)
    control.wait(lambda: control.available >= 4 or control.seal is not None)
    prefix = os.pread(control.fd, min(10, control.available), 0)
    supported = prefix.startswith((b'fLaC', b'ID3')) or (len(prefix) >= 2 and prefix[0] == 255 and prefix[1] & 224 == 224 and prefix[1] & 6 != 0)
    if not supported:
        emit(phase='fallback', reason='stream_decode_unavailable')
        return {}, 'stream_decode_unavailable'
    class LiveProducer(PCMProducer):
        def _blocks(self):
            yield from bounded_blocks(control, stop=self.stop)
        def check(self):
            control.check()
            super().check()
    candidates, reason = {}, None
    try:
        with LiveProducer(directory/'unused', directory, chunk_seconds=chunk_seconds,
                          context_seconds=context_seconds, cancel=control.cancel, capacity=1) as producer:
            for chunk, _ in producer:
                control.check()
                path = directory/f'chunk-{chunk.index:05d}.wav'
                identity = {'chunk': asdict(chunk), 'pcm_sha256': _file_digest(path), 'backend': backend.cache_key}
                request_id = _digest({'attempt_id': control.attempt_id, **identity})
                raw = validate_result(backend.recognize(path, request_id=request_id), chunk.duration)
                control.check()
                record = {'identity': identity, 'raw': raw}
                encoded = json.dumps(record, allow_nan=False).encode()
                work_budget(directory.parent, len(encoded)*2)
                saved = directory/f'candidate-{chunk.index:05d}.json'
                save_document(record, saved)
                candidates[chunk.index] = saved
                path.unlink(missing_ok=True)
    except (av.error.FFmpegError, StreamCapability):
        control.check()  # Protocol/identity failures must not become codec fallback.
        reason = 'stream_decode_unavailable'
        emit(phase='fallback', reason=reason)
    finally:
        # No provisional full-PCM copy survives into canonical decoding.
        for name in ('stream-audio.wav', 'stream-audio.partial.wav', 'stream-pcm.partial'):
            (directory/name).unlink(missing_ok=True)
    return candidates, reason


class CanonicalBackend:
    local_only = True
    def __init__(self, backend, candidates, source, *, chunk_seconds=240, context_seconds=5, emit=lambda **_: None):
        self.backend, self.candidates, self.source = backend, candidates, source
        self.cache_key, self.hints = backend.cache_key, getattr(backend, 'hints', {})
        self.chunk_seconds, self.context_seconds = chunk_seconds, context_seconds
        self.reused = self.recomputed = 0
        self.mismatch = False
        self.chunks = None
        self.emit = emit

    def recognize(self, path, *, request_id):
        from audio_pipeline import prepare_audio, _wav_frames, plan_chunks, _file_digest, validate_result
        index = int(path.stem.removeprefix('chunk-'))
        if self.chunks is None:
            frames = _wav_frames(prepare_audio(self.source, path.parent, max_frames=MAX_FRAMES))
            self.chunks = plan_chunks(frames, self.chunk_seconds, self.context_seconds)
        chunk = self.chunks[index]
        expected = {'chunk': asdict(chunk), 'pcm_sha256': _file_digest(path), 'backend': self.backend.cache_key}
        candidate = self.candidates.get(index)
        if candidate:
            record = json.loads(candidate.read_text())
            if record.get('identity') == expected:
                self.reused += 1
                return validate_result(record['raw'], chunk.duration)
            if not self.mismatch:
                self.emit(phase='fallback', reason='canonical_pcm_mismatch')
            self.mismatch = True
        self.recomputed += 1
        return self.backend.recognize(path, request_id=request_id)


def frozen_context(request):
    return {key: copy.deepcopy(request.get(key)) for key in ('title', 'context', 'hotwords', 'name_corrections', 'speaker_count')}


def probe_incremental(profile):
    from transcription import probe
    base = dict(local_only=True, model_download=False, backend='qwen-mlx', incremental_protocol=1,
                supported_containers=['flac', 'mp3'])
    if profile.get('backend') != 'qwen-mlx':
        return {**base, 'available': False, 'code': 'incremental_backend_unsupported', 'message': '增量本地识别暂仅支持 Qwen。'}
    result = probe(profile)
    if result.get('available'):
        import importlib.util
        if importlib.util.find_spec('av') is None:
            result = dict(available=False, code='incremental_decoder_unavailable', message='增量解码依赖未准备。')
    return {**base, **result}


def run_incremental(request, *, control_fd=0):
    from transcription import QwenBackend, run, emit
    from transcript import save_document
    import uuid
    if request.get('protocol_version') != 1 or request.get('media_fd') != 3 or request.get('local_only') is not True or request.get('review'):
        raise StreamFailure('Invalid incremental worker contract')
    attempt = request.get('attempt_id')
    if not isinstance(attempt, str) or str(uuid.UUID(attempt)) != attempt:
        raise StreamFailure('Invalid incremental attempt')
    if not isinstance(request.get('source_snapshot'), dict):
        raise StreamFailure('Source snapshot required')
    profile = request['profile']
    status = probe_incremental(profile)
    if not status['available']:
        raise StreamFailure(status['code'])
    work = Path(request['work'])
    if not work.is_absolute():
        raise StreamFailure('Owned absolute work directory required')
    work.mkdir(parents=True, exist_ok=True)
    # Never overwrite an earlier official result or adopt an unsealed attempt.
    if (work/'result.json').exists():
        raise StreamFailure('Existing result requires a separate incremental attempt')
    attempt_dir = work/'incremental'/attempt
    attempt_dir.mkdir(parents=True, exist_ok=False)
    work_budget(work, 2*MAX_FRAMES*2 + 2*MAX_MEDIA + 64*1024*1024)
    control = Control(3, attempt)
    previous_term = signal.getsignal(signal.SIGTERM)
    terminating = False
    def terminate(_signum, _frame):
        nonlocal terminating
        if terminating:
            return
        terminating = True
        control.fail('Incremental processing terminated')
        raise InterruptedError('Incremental processing terminated')
    signal.signal(signal.SIGTERM, terminate)
    control.start(control_fd, terminate_on_failure=True)
    sealed_source = attempt_dir/'sealed-source.media'
    try:
        backend = QwenBackend(profile, attempt_dir, title=request.get('title', ''),
                              context=request.get('context'), hotwords=request.get('hotwords'))
        candidates, reason = collect_candidates(control, backend, attempt_dir/'candidates', emit=emit)
        work_budget(work, MAX_MEDIA)
        seal = copy_sealed(control, sealed_source)
        sealed_source = sealed_source.rename(attempt_dir / (seal['sha256'] + '.media'))
        wrapper = CanonicalBackend(backend, candidates, sealed_source, emit=emit)
        canonical_request = {**request, 'input': str(sealed_source), 'sha256': seal['sha256'], 'work': str(attempt_dir/'canonical')}
        # Normal document creation/speakers run only after canonical chunk checks.
        run(canonical_request, qwen_backend=wrapper, pipeline_options={'max_decoded_frames': MAX_FRAMES, 'cancel_event': control.cancel})
        control.check()
        receipt = {'protocol_version': 1, 'attempt_id': attempt, 'source_sha256': seal['sha256'],
                   'size': seal['size'], 'source_snapshot': request['source_snapshot'], 'profile': profile,
                   'frozen_context': frozen_context(request), 'reused_chunks': wrapper.reused,
                   'recomputed_chunks': wrapper.recomputed,
                   'fallback_reason': reason or ('canonical_pcm_mismatch' if wrapper.mismatch else None)}
        save_document(receipt, work/'incremental_receipt.json')
        control.check()
        (attempt_dir/'canonical'/'result.json').replace(work/'result.json')
    finally:
        control.close()
        signal.signal(signal.SIGTERM, previous_term)
        sealed_source.unlink(missing_ok=True)
        # Keep identity-bound JSON checkpoints, not large transient PCM copies.
        # SIGKILL cannot run finally; Node must retire these owned artifacts on recovery.
        for path in attempt_dir.rglob('*'):
            if path.is_file() and (path.name in {'audio.wav', 'audio.partial.wav', 'stream-audio.wav',
                    'stream-audio.partial.wav', 'stream-pcm.partial', 'sealed-source.partial'} or
                    re.fullmatch(r'chunk-[0-9]+\.wav', path.name)):
                path.unlink(missing_ok=True)
