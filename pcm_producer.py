"""Opt-in bounded PCM decoding; never runs a model or publishes a transcript."""
import queue
import threading
import wave
from pathlib import Path


class PCMProducer:
    def __init__(self, source, directory, *, chunk_seconds, context_seconds, cancel=None, capacity=2):
        from audio_pipeline import SAMPLE_RATE, plan_chunks
        plan_chunks(1, chunk_seconds, context_seconds)
        if capacity not in (1, 2):
            raise ValueError('PCM queue capacity must be 1 or 2')
        self.source, self.directory = Path(source), Path(directory)
        self.size, self.context = int(chunk_seconds*SAMPLE_RATE), int(context_seconds*SAMPLE_RATE)
        self.cancel = cancel
        self.stop = threading.Event()
        self.queue = queue.Queue(capacity)
        self.frames = None
        self.audio = self.directory / 'stream-audio.wav'
        self.error = None
        self.paths = set()
        self.thread = threading.Thread(target=self._run, name='coconut-pcm-producer', daemon=True)

    def check(self):
        if self.stop.is_set() or self.cancel is not None and self.cancel.is_set():
            raise InterruptedError('PCM processing cancelled')

    def _put(self, item):
        while True:
            self.check()
            try:
                self.queue.put(item, timeout=.05)
                return
            except queue.Full:
                pass

    def _blocks(self):
        from audio_pipeline import _wav_frames, SAMPLE_RATE
        try:
            expected_frames = _wav_frames(self.source)
        except (wave.Error, EOFError, ValueError):
            import av
            with av.open(str(self.source)) as container:
                resampler = av.AudioResampler(format='s16', layout='mono', rate=SAMPLE_RATE)
                for frame in container.decode(audio=0):
                    self.check()
                    for converted in resampler.resample(frame):
                        yield converted.to_ndarray().tobytes()
                for converted in resampler.resample(None):
                    yield converted.to_ndarray().tobytes()
        else:
            with wave.open(str(self.source), 'rb') as stream:
                decoded = 0
                while block := stream.readframes(32768):
                    decoded += len(block)//2
                    yield block
                if decoded != expected_frames:
                    raise ValueError('Truncated PCM source')

    def _run(self):
        from audio_pipeline import AudioChunk, SAMPLE_RATE
        raw_path = self.directory / 'stream-pcm.partial'
        partial = self.directory / 'stream-audio.partial.wav'
        count, index = 0, 0
        try:
            with raw_path.open('w+b') as raw:
                def publish(final=False):
                    nonlocal index
                    start = index*self.size
                    chunk = AudioChunk(index, max(0, start-self.context),
                        min(count, start+self.size+self.context), start, min(count, start+self.size))
                    target = self.directory / f'chunk-{index:05d}.wav'
                    self.paths.add(target)
                    raw.flush()
                    with raw_path.open('rb') as read, wave.open(str(target), 'wb') as out:
                        read.seek(chunk.start_frame*2)
                        out.setparams((1, 2, SAMPLE_RATE, 0, 'NONE', 'not compressed'))
                        remaining = (chunk.end_frame-chunk.start_frame)*2
                        while remaining:
                            self.check()
                            block = read.read(min(65536, remaining))
                            if not block:
                                raise ValueError('Truncated PCM spool')
                            out.writeframesraw(block)
                            remaining -= len(block)
                    self._put((chunk, count if final else -1))
                    index += 1
                for block in self._blocks():
                    self.check()
                    if len(block)%2:
                        raise ValueError('Invalid PCM byte count')
                    raw.write(block)
                    count += len(block)//2
                    # Lookahead distinguishes an exact final core boundary.
                    while count > (index+1)*self.size+self.context:
                        publish()
                if not count:
                    raise ValueError('Empty decoded audio')
                raw.flush()
                with raw_path.open('rb') as read, wave.open(str(partial), 'wb') as out:
                    out.setparams((1, 2, SAMPLE_RATE, 0, 'NONE', 'not compressed'))
                    while block := read.read(65536):
                        self.check()
                        out.writeframesraw(block)
                partial.replace(self.audio)
                self.frames = count
                while index*self.size < count:
                    publish(final=True)
            self._put(None)
        except BaseException as error:
            self.error = error
        finally:
            raw_path.unlink(missing_ok=True)
            partial.unlink(missing_ok=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __iter__(self):
        while True:
            self.check()
            if self.error:
                raise self.error
            try:
                item = self.queue.get(timeout=.05)
            except queue.Empty:
                if not self.thread.is_alive():
                    if self.error:
                        raise self.error
                    raise RuntimeError('PCM producer stopped without EOF')
                continue
            if item is None:
                return
            yield item

    def __exit__(self, *_):
        self.stop.set()
        self.thread.join()
        for path in self.paths:
            path.unlink(missing_ok=True)
