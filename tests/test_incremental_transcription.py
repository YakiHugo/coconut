"""Private stream protocol and real codec oracle contracts; no model calls."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
import uuid
from unittest.mock import patch
from audio_pipeline import CallableBackend, run_audio_pipeline, prepare_audio
from incremental_transcription import (Control, LiveReader, StreamFailure, copy_sealed,
    collect_candidates, CanonicalBackend, bounded_blocks, initial_request, probe_incremental,
    run_incremental)


class InitialRequestTests(unittest.TestCase):
    def test_large_ordinary_alignment_request_preserves_document_and_next_byte(self):
        request = {'operation': 'align_existing', 'document': {'segments': [{'text': '词' * 30000}]}}
        with tempfile.TemporaryFile() as stream:
            stream.write(json.dumps(request, ensure_ascii=False).encode() + b'\nNEXT'); stream.seek(0)
            self.assertEqual(initial_request(stream.fileno()), request)
            self.assertEqual(os.read(stream.fileno(), 4), b'NEXT')

    def test_incremental_initial_request_stays_bounded(self):
        with tempfile.TemporaryFile() as stream:
            stream.write(json.dumps({'operation': 'transcribe_incremental', 'context': 'x' * 65536}).encode() + b'\n'); stream.seek(0)
            with self.assertRaisesRegex(ValueError, 'exceeds limit'):
                initial_request(stream.fileno())


class MediaWaitTests(unittest.TestCase):
    def request(self, work, **extra):
        return {'operation': 'transcribe_incremental', 'protocol_version': 1,
                'attempt_id': str(uuid.uuid4()), 'media_fd': 3, 'local_only': True,
                'work': str(work), 'source_snapshot': {'key': 'authored'},
                'profile': {'backend': 'qwen-mlx', 'asr_model': '/fixture/model'}, **extra}

    def test_media_wait_default_and_bounds_are_passed_to_control_without_models(self):
        class ReachedControl(Exception):
            pass
        with tempfile.TemporaryDirectory() as directory:
            for index, extra in enumerate([{}, {'media_wait_seconds': 1},
                                          {'media_wait_seconds': 180}, {'media_wait_seconds': 660}]):
                with self.subTest(extra=extra):
                    request = self.request(Path(directory)/str(index), **extra)
                    with patch('incremental_transcription.probe_incremental', return_value={'available': True}), \
                         patch('incremental_transcription.Control', side_effect=ReachedControl) as control, \
                         patch('transcription.QwenBackend') as backend:
                        with self.assertRaises(ReachedControl):
                            run_incremental(request)
                        control.assert_called_once_with(3, request['attempt_id'],
                                                        wait_seconds=extra.get('media_wait_seconds', 180))
                        backend.assert_not_called()

    def test_invalid_media_wait_fails_before_probe_control_or_models(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)/'work'
            for value in [None, True, False, 0, -1, 661, 1.5, 180.0, '180', [], {},
                          float('nan'), float('inf'), -float('inf')]:
                with self.subTest(value=value), \
                     patch('incremental_transcription.probe_incremental') as probe, \
                     patch('incremental_transcription.Control') as control, \
                     patch('transcription.QwenBackend') as backend:
                    with self.assertRaisesRegex(StreamFailure, 'media wait'):
                        run_incremental(self.request(work, media_wait_seconds=value))
                    probe.assert_not_called()
                    control.assert_not_called()
                    backend.assert_not_called()
                    self.assertFalse(work.exists())


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root/'source'
        self.source.write_bytes(b'abcdefgh')
        self.fd = os.open(self.source, os.O_RDONLY)
        self.addCleanup(os.close, self.fd)
        self.control = Control(self.fd, 'attempt', wait_seconds=.1)
        self.addCleanup(self.control.close)

    def accept(self, **data):
        self.control.accept({'attempt_id': 'attempt', **data})

    def test_watermark_is_not_eof_and_seal_requires_full_size(self):
        self.accept(type='append', available_bytes=4)
        reader = LiveReader(self.control)
        self.assertEqual(reader.read(100), b'abcd')
        with self.assertRaisesRegex(StreamFailure, 'timed out'):
            reader.read(100)

    def test_valid_seal_and_copy_hash(self):
        self.accept(type='append', available_bytes=8)
        digest = hashlib.sha256(b'abcdefgh').hexdigest()
        self.accept(type='seal', size=8, sha256=digest)
        reader = LiveReader(self.control)
        self.assertEqual(reader.read(), b'abcdefgh')
        self.assertEqual(reader.read(), b'')
        self.assertEqual(copy_sealed(self.control, self.root/'copy')['sha256'], digest)
        self.assertEqual((self.root/'copy').read_bytes(), b'abcdefgh')

    def test_watermark_identity_and_length_fail_closed(self):
        for value in [dict(type='append', available_bytes=9), dict(type='append', available_bytes=True),
                      dict(type='seal', size=8, sha256='a'*64)]:
            with self.assertRaises(StreamFailure):
                self.accept(**value)
        self.accept(type='append', available_bytes=8)
        with self.assertRaises(StreamFailure):
            self.accept(type='append', available_bytes=4)
        with self.assertRaises(StreamFailure):
            self.control.accept({'attempt_id': 'other', 'type': 'append', 'available_bytes': 8})

    def test_hash_mismatch_never_creates_sealed_file(self):
        self.accept(type='append', available_bytes=8)
        self.accept(type='seal', size=8, sha256='a'*64)
        with self.assertRaisesRegex(StreamFailure, 'digest'):
            copy_sealed(self.control, self.root/'copy')
        self.assertFalse((self.root/'copy').exists())
        self.assertFalse((self.root/'copy.partial').exists())

    def test_parent_eof_and_abort_unblock_wait(self):
        read, write = os.pipe()
        self.addCleanup(os.close, read)
        self.control.start(read)
        os.close(write)
        with self.assertRaises(StreamFailure):
            LiveReader(self.control).read()
        self.control.close()
        other = Control(self.fd, 'other')
        other.accept({'attempt_id': 'other', 'type': 'abort'})
        with self.assertRaises(StreamFailure):
            LiveReader(other).read()

    def test_request_read_does_not_steal_control_records(self):
        read, write = os.pipe()
        try:
            os.write(write, b'{"operation":"test"}\n{"type":"append"}\n')
            self.assertEqual(initial_request(read), {'operation': 'test'})
            self.assertEqual(os.read(read, 100), b'{"type":"append"}\n')
        finally:
            os.close(read)
            os.close(write)

    def test_nonlocal_backend_probe_is_unavailable(self):
        self.assertFalse(probe_incremental({'backend': 'moss-mlx'})['available'])


@unittest.skipUnless(importlib.util.find_spec('av') and shutil.which('ffmpeg'), 'Requires PyAV and ffmpeg')
class CodecTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.mp3 = cls.root/'authored.mp3'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                        'anoisesrc=duration=20:sample_rate=44100:seed=123',
                        '-c:a', 'libmp3lame', '-b:a', '128k', str(cls.mp3)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.directory = Path(self.work.name)
        self.spool = self.directory/'spool'
        self.spool.touch()
        self.fd = os.open(self.spool, os.O_RDONLY)
        self.addCleanup(os.close, self.fd)
        self.control = Control(self.fd, 'codec', wait_seconds=3)
        self.addCleanup(self.control.close)

    def append(self, count):
        self.control.accept({'attempt_id': 'codec', 'type': 'append', 'available_bytes': count})

    def seal(self, data):
        self.control.accept({'attempt_id': 'codec', 'type': 'seal', 'size': len(data),
                             'sha256': hashlib.sha256(data).hexdigest()})

    def test_real_mp3_early_candidates_and_tail_oracle_recompute(self):
        data = self.mp3.read_bytes()
        early = threading.Event()
        failures = []
        def produce():
            try:
                cut = len(data)*3//4
                with self.spool.open('wb') as out:
                    out.write(data[:cut]); out.flush()
                    self.append(cut)
                    if not early.wait(3):
                        raise AssertionError('No candidate ASR before network EOF')
                    out.write(data[cut:]); out.flush()
                    self.append(len(data))
                    self.seal(data)
            except BaseException as error:
                failures.append(error)
                self.control.fail('Producer failed')
        producer = threading.Thread(target=produce)
        producer.start()
        def recognize(path):
            early.set()
            return {'segments': [{'start': .1, 'end': .2, 'text': hashlib.sha256(path.read_bytes()).hexdigest()}]}
        backend = CallableBackend({'fixture': 1}, recognize)
        candidates, reason = collect_candidates(self.control, backend, self.directory/'candidates',
                                                 chunk_seconds=2, context_seconds=.5)
        producer.join(3)
        self.assertFalse(failures)
        self.assertIsNone(reason)
        source = self.directory/'sealed.mp3'
        copy_sealed(self.control, source)
        wrapper = CanonicalBackend(backend, candidates, source, chunk_seconds=2, context_seconds=.5)
        actual = run_audio_pipeline(source, wrapper, work_dir=self.directory/'oracle',
                                    chunk_seconds=2, context_seconds=.5, max_decoded_frames=6*3600*16000)
        expected = run_audio_pipeline(source, backend, work_dir=self.directory/'baseline',
                                      chunk_seconds=2, context_seconds=.5)
        self.assertEqual(actual, expected)
        self.assertGreater(wrapper.reused, 0)
        self.assertGreater(wrapper.recomputed, 0)
        self.assertTrue(wrapper.mismatch)
        self.assertFalse((self.directory/'candidates'/'stream-audio.wav').exists())

    def test_decoded_frame_cap_is_hard_failure_not_fallback(self):
        data = self.mp3.read_bytes()
        self.spool.write_bytes(data)
        self.append(len(data)); self.seal(data)
        with self.assertRaisesRegex(StreamFailure, 'frame limit'):
            list(bounded_blocks(self.control, maximum=1000))
        target = self.directory/'canonical'
        target.mkdir()
        with self.assertRaisesRegex(RuntimeError, 'frame limit'):
            prepare_audio(self.mp3, target, max_frames=1000)
        self.assertFalse((target/'audio.wav').exists())
        self.assertFalse((target/'audio.partial.wav').exists())

    def test_corrupt_candidate_identity_cannot_reuse_asr(self):
        source = self.mp3
        oracle = self.directory/'oracle'
        oracle.mkdir()
        from audio_pipeline import _wav_frames, plan_chunks, write_chunk
        audio = prepare_audio(source, oracle)
        chunk = plan_chunks(_wav_frames(audio), 2, .5)[0]
        path = oracle/'chunk-00000.wav'
        write_chunk(audio, chunk, path)
        candidate = self.directory/'candidate.json'
        candidate.write_text(json.dumps({'identity': {}, 'raw': {'segments': []}}))
        calls = []
        backend = CallableBackend({'fixture': 1}, lambda _: calls.append(1) or {'segments': []})
        wrapper = CanonicalBackend(backend, {0: candidate}, source, chunk_seconds=2, context_seconds=.5)
        wrapper.recognize(path, request_id='fixed')
        self.assertEqual(calls, [1])
        self.assertTrue(wrapper.mismatch)

    def test_worker_fd3_protocol_publishes_only_after_verified_seal(self):
        import sys
        import uuid
        data = self.mp3.read_bytes()
        self.spool.write_bytes(data)
        work = self.directory/'worker'
        request = {'operation': 'transcribe_incremental', 'protocol_version': 1,
                   'attempt_id': str(uuid.uuid4()), 'media_fd': 3, 'local_only': True,
                   'work': str(work), 'source_snapshot': {'key': 'fixture'},
                   'profile': {'backend': 'qwen-mlx', 'asr_model': '/fixture/model'}}
        # An actual worker process + fd3/control protocol; only recognition is fake.
        program = '''
import os, sys
os.dup2(int(sys.argv[1]), 3)
sys.argv = [sys.argv[0]]
import transcription
from audio_pipeline import CallableBackend
transcription.probe = lambda p: {'available': True}
transcription.QwenBackend = lambda *a, **k: CallableBackend({'fixture': 1}, lambda p: {'segments': [{'start': .1, 'end': .2, 'text': 'fixture'}]})
transcription.main()
'''
        child = subprocess.Popen([sys.executable, '-c', program, str(self.fd)],
                                 pass_fds=(self.fd,), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: child.poll() is None and child.kill())
        def send(value):
            child.stdin.write((json.dumps(value)+'\n').encode()); child.stdin.flush()
        send(request)
        send({'type': 'append', 'attempt_id': request['attempt_id'], 'available_bytes': len(data)})
        time.sleep(.15)
        if child.poll() is not None:
            self.fail(child.stderr.read().decode())
        self.assertFalse((work/'result.json').exists())
        send({'type': 'seal', 'attempt_id': request['attempt_id'], 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        child.wait(timeout=15)
        stderr = child.stderr.read().decode()
        self.assertEqual(child.returncode, 0, stderr)
        result = json.loads((work/'result.json').read_text())
        receipt = json.loads((work/'incremental_receipt.json').read_text())
        self.assertEqual(result['provenance']['source_sha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual(receipt['source_snapshot'], request['source_snapshot'])
        self.assertEqual(receipt['frozen_context']['context'], None)
        self.assertEqual(receipt['profile'], request['profile'])
        child.stdin.close(); child.stdout.close(); child.stderr.close()

    def test_faststart_m4a_decodes_audio_before_seal_and_matches_canonical_output(self):
        source = self.directory/'faststart.m4a'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                        'anoisesrc=duration=20:sample_rate=44100:seed=456',
                        '-c:a', 'aac', '-movflags', '+faststart', str(source)], check=True)
        data = source.read_bytes()
        cut = len(data)*3//4
        self.spool.write_bytes(data[:cut])
        self.append(cut)
        early = []

        def recognize(path):
            if self.control.seal is None:
                early.append(True)
                with self.spool.open('ab') as output:
                    output.write(data[cut:])
                self.append(len(data))
                self.seal(data)
            return {'segments': [{'start': .1, 'end': .2, 'text': hashlib.sha256(path.read_bytes()).hexdigest()}]}

        backend = CallableBackend({'fixture': 1}, recognize)
        candidates, reason = collect_candidates(self.control, backend, self.directory/'m4a-candidates',
                                                chunk_seconds=2, context_seconds=.5)
        self.assertIsNone(reason)
        self.assertEqual(early, [True])
        self.assertTrue(candidates)
        sealed = self.directory/'sealed.m4a'
        copy_sealed(self.control, sealed)
        check = CanonicalBackend(backend, candidates, sealed, chunk_seconds=2, context_seconds=.5)
        result = run_audio_pipeline(sealed, check, work_dir=self.directory/'m4a-oracle',
                                    chunk_seconds=2, context_seconds=.5)
        expected = run_audio_pipeline(sealed, backend, work_dir=self.directory/'m4a-baseline',
                                      chunk_seconds=2, context_seconds=.5)
        self.assertEqual(result, expected)

    def test_mp4_falls_back_without_speculative_model_and_still_checks_seal(self):
        source = Path(__file__).parent/'fixtures'/'authored-video-audio.m4a'
        data = source.read_bytes()
        self.spool.write_bytes(data)
        self.append(len(data)); self.seal(data)
        backend = CallableBackend({'fixture': 1}, lambda _: self.fail('MP4 speculated'))
        candidates, reason = collect_candidates(self.control, backend, self.directory/'candidates')
        self.assertEqual(candidates, {})
        self.assertEqual(reason, 'stream_decode_unavailable')
        copied = self.directory/'sealed.mp4'
        copy_sealed(self.control, copied)
        result = run_audio_pipeline(copied, CallableBackend({'fixture': 1}, lambda _: {'segments': []}),
                                    work_dir=self.directory/'buffered', max_decoded_frames=6*3600*16000)
        self.assertTrue(result['pipeline']['duration'] > 0)

    def test_model_failure_stops_decoder_waiting_for_unsealed_network(self):
        data = self.mp3.read_bytes()
        prefix = data[:len(data)//2]
        self.spool.write_bytes(prefix)
        self.append(len(prefix))
        self.control.wait_seconds = 10
        def fail(_):
            raise RuntimeError('model failed')
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, 'model failed'):
            collect_candidates(self.control, CallableBackend({'fixture': 1}, fail),
                               self.directory/'candidates', chunk_seconds=2, context_seconds=.5)
        self.assertLess(time.monotonic()-started, 2)
        self.assertFalse(any(t.name == 'coconut-pcm-producer' for t in threading.enumerate()))

    def test_worker_parent_eof_without_seal_never_publishes_and_cleans_pcm(self):
        import sys
        import uuid
        data = self.mp3.read_bytes()
        self.spool.write_bytes(data[:len(data)//2])
        work = self.directory/'lost-parent'
        attempt = str(uuid.uuid4())
        request = {'operation': 'transcribe_incremental', 'protocol_version': 1,
                   'attempt_id': attempt, 'media_fd': 3, 'local_only': True,
                   'work': str(work), 'source_snapshot': {},
                   'profile': {'backend': 'qwen-mlx', 'asr_model': '/fixture/model'}}
        program = '''
import os, sys
os.dup2(int(sys.argv[1]), 3)
sys.argv = [sys.argv[0]]
import transcription
from audio_pipeline import CallableBackend
transcription.probe = lambda p: {'available': True}
transcription.QwenBackend = lambda *a, **k: CallableBackend({'fixture': 1}, lambda p: {'segments': []})
transcription.main()
'''
        child = subprocess.Popen([sys.executable, '-c', program, str(self.fd)],
                                 pass_fds=(self.fd,), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            child.stdin.write((json.dumps(request)+'\n'+json.dumps({'type': 'append', 'attempt_id': attempt,
                                 'available_bytes': self.spool.stat().st_size})+'\n').encode())
            child.stdin.flush()
            # Wait until the worker is actually staging PCM before simulating death.
            end = time.monotonic()+5
            while not list(work.rglob('stream-pcm.partial')) and time.monotonic() < end and child.poll() is None:
                time.sleep(.01)
            child.stdin.close()
            child.wait(timeout=5)
            self.assertNotEqual(child.returncode, 0)
            self.assertFalse((work/'result.json').exists())
            self.assertFalse((work/'incremental_receipt.json').exists())
            self.assertFalse(list(work.rglob('*.partial')))
            self.assertFalse(list(work.rglob('*.wav')))
        finally:
            if child.poll() is None:
                child.kill(); child.wait()
            child.stdout.close(); child.stderr.close()
