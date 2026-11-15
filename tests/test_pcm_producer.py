"""Decoder/queue contracts, not recognition quality tests."""
import importlib.util
import json
import tempfile
import threading
import unittest
import wave
from pathlib import Path
from unittest.mock import patch
from audio_pipeline import CallableBackend, SAMPLE_RATE, run_audio_pipeline, _file_digest, _wav_frames
from pcm_producer import PCMProducer


def wav(path, seconds=7):
    with wave.open(str(path), 'wb') as out:
        out.setparams((1, 2, SAMPLE_RATE, 0, 'NONE', 'not compressed'))
        for second in range(seconds):
            out.writeframesraw(bytes([second, 0])*SAMPLE_RATE)


class PCMTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root/'source.wav'
        wav(self.source)

    def run_pipeline(self, callback, work='work', **options):
        return run_audio_pipeline(self.source, CallableBackend({'test': 1}, callback),
            work_dir=self.root/work, chunk_seconds=2, context_seconds=.5,
            decode_mode='pipelined', **options)

    def test_same_chunks_and_output_as_buffered_and_resume(self):
        hashes = []
        def backend(path):
            hashes.append(_file_digest(path))
            return {'segments': [{'start': .5, 'end': 1, 'text': 'word'}]}
        result = self.run_pipeline(backend)
        first = list(hashes)
        hashes.clear()
        buffered = run_audio_pipeline(self.source, CallableBackend({'test': 1}, backend),
            work_dir=self.root/'buffered', chunk_seconds=2, context_seconds=.5)
        self.assertEqual(hashes, first)
        self.assertEqual(result, buffered)
        self.assertEqual(result, self.run_pipeline(lambda _: self.fail('cached ASR called')))
        self.assertFalse(list((self.root/'work').glob('chunk-*.wav')))

    def test_recognition_starts_before_decoder_eof(self):
        recognized = threading.Event()
        seen = []
        def blocks(_):
            yield b'\0' * SAMPLE_RATE * 6
            self.assertTrue(recognized.wait(2), 'decoder blocked recognition until EOF')
            yield b'\0' * SAMPLE_RATE * 8
        def backend(path):
            recognized.set()
            seen.append(path)
            return {'segments': []}
        with patch.object(PCMProducer, '_blocks', blocks):
            self.run_pipeline(backend, pcm_queue_capacity=1)
        self.assertEqual(len(seen), 4)

    def test_backend_failure_stops_blocked_producer_then_resume(self):
        calls = []
        def backend(path):
            calls.append(path.name)
            if len(calls) == 2:
                raise RuntimeError('model unavailable')
            return {'segments': []}
        with self.assertRaisesRegex(RuntimeError, 'model unavailable'):
            self.run_pipeline(backend)
        self.assertFalse(any(t.name == 'coconut-pcm-producer' for t in threading.enumerate()))
        self.assertFalse(list((self.root/'work').glob('chunk-*.wav')))
        calls.clear()
        self.run_pipeline(lambda path: calls.append(path.name) or {'segments': []})
        self.assertEqual(calls, ['chunk-00001.wav', 'chunk-00002.wav', 'chunk-00003.wav'])

    def test_cancel_after_backend_does_not_commit_result(self):
        cancel = threading.Event()
        def backend(_):
            cancel.set()
            return {'segments': []}
        with self.assertRaises(InterruptedError):
            self.run_pipeline(backend, cancel_event=cancel)
        self.assertFalse(list((self.root/'work').glob('asr-*.json')))
        self.assertFalse(any(t.name == 'coconut-pcm-producer' for t in threading.enumerate()))

    def test_decode_failure_is_not_success_or_silent_fallback(self):
        def blocks(_):
            yield b'\0' * SAMPLE_RATE * 6
            raise ValueError('truncated decoder')
        with patch.object(PCMProducer, '_blocks', blocks), self.assertRaisesRegex(ValueError, 'truncated decoder'):
            self.run_pipeline(lambda _: {'segments': []})
        self.assertFalse((self.root/'work'/'stream-audio.wav').exists())

    def test_final_duration_and_source_identity_are_checked(self):
        with self.assertRaisesRegex(ValueError, 'duration'):
            self.run_pipeline(lambda _: {'segments': []}, expected_duration=30)
        changed = False
        def backend(_):
            nonlocal changed
            if not changed:
                with self.source.open('ab') as out:
                    out.write(b'changed')
                changed = True
            return {'segments': []}
        with self.assertRaisesRegex(ValueError, 'Source media changed'):
            self.run_pipeline(backend, work='changed')

    def test_changed_pcm_checkpoint_rejected(self):
        self.run_pipeline(lambda _: {'segments': []})
        marker = self.root/'work'/'pcm-00000.json'
        value = json.loads(marker.read_text())
        value['pcm_sha256'] = '0'*64
        marker.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'chunk identity'):
            self.run_pipeline(lambda _: {'segments': []})

    def test_default_manifest_unchanged_and_mode_switch_requires_separate_cache(self):
        run_audio_pipeline(self.source, CallableBackend({'test': 1}, lambda _: {'segments': []}),
            work_dir=self.root/'work', chunk_seconds=2, context_seconds=.5)
        self.assertNotIn('decode_mode', json.loads((self.root/'work'/'manifest.json').read_text()))
        with self.assertRaisesRegex(ValueError, 'different input/options'):
            self.run_pipeline(lambda _: {'segments': []})

    def test_queue_backpressure_and_cancel_while_producer_waits(self):
        reached = threading.Event()
        count = 0
        def blocks(_):
            nonlocal count
            for _ in range(100):
                count += 1
                if count == 5:
                    reached.set()
                yield b'\0' * SAMPLE_RATE * 2
        cancel = threading.Event()
        with patch.object(PCMProducer, '_blocks', blocks):
            with PCMProducer(self.source, self.root, chunk_seconds=2, context_seconds=.5,
                             capacity=1, cancel=cancel) as producer:
                self.assertTrue(reached.wait(2))
                self.assertEqual(count, 5)
                self.assertEqual(producer.queue.qsize(), 1)
                cancel.set()
                with self.assertRaises(InterruptedError):
                    next(iter(producer))
            self.assertFalse(producer.thread.is_alive())
        self.assertFalse(list(self.root.glob('chunk-*.wav')))

    def test_missing_checkpoint_identity_cannot_rebind_cached_asr(self):
        self.run_pipeline(lambda _: {'segments': []})
        (self.root/'work'/'pcm-00000.json').unlink()
        with self.assertRaisesRegex(ValueError, 'no identity'):
            self.run_pipeline(lambda _: {'segments': []})

    def test_remote_backend_is_not_started_speculatively(self):
        backend = CallableBackend({'remote': 1}, lambda _: self.fail('remote called'), local_only=False)
        with self.assertRaisesRegex(ValueError, 'local-only'):
            run_audio_pipeline(self.source, backend, decode_mode='pipelined')

    def test_speaker_finalization_uses_complete_recording_after_all_chunks(self):
        calls = []
        class Voices:
            local_only = True
            cache_key = {'voice': 'fixture'}
            def analyze(self, path):
                duration = _wav_frames(path)/SAMPLE_RATE
                calls.append('voice')
                return {'turns': [{'start': 0, 'end': duration, 'speaker': 'a'}],
                        'evidence': {'a': {'embedding': [1, 0], 'duration': duration}},
                        'embedding_model': 'fixture'}
            def refine_turns(self, path, turns):
                calls.append('final')
                if _wav_frames(path) != 7*SAMPLE_RATE:
                    raise AssertionError('finalization before full PCM')
                return turns
        self.run_pipeline(lambda _: {'segments': []}, speaker_backend=Voices(), reconcile_speakers=True)
        self.assertEqual(calls, ['voice']*4 + ['final'])

    def test_truncated_native_wav_is_not_accepted_as_shorter_recording(self):
        self.source.write_bytes(self.source.read_bytes()[:-100])
        with self.assertRaisesRegex(ValueError, 'Truncated PCM'):
            self.run_pipeline(lambda _: {'segments': []})

    def test_real_aac_decoder_matches_buffered_chunks(self):
        if importlib.util.find_spec('av') is None:
            self.skipTest('PyAV optional codec test dependency unavailable')
        source = Path(__file__).parent/'fixtures'/'authored-video-audio.m4a'
        captures = []
        def backend(path):
            captures.append(_file_digest(path))
            return {'segments': []}
        engine = CallableBackend({'codec-contract': 1}, backend)
        buffered = run_audio_pipeline(source, engine, work_dir=self.root/'codec-buffered',
                                      chunk_seconds=.5, context_seconds=.1)
        expected = list(captures)
        captures.clear()
        pipelined = run_audio_pipeline(source, engine, work_dir=self.root/'codec-stream',
                                       chunk_seconds=.5, context_seconds=.1, decode_mode='pipelined')
        self.assertEqual(captures, expected)
        self.assertEqual(pipelined, buffered)


if __name__ == '__main__':
    unittest.main()
