import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from audio_pipeline import SAMPLE_RATE, plan_silence_chunks
from audio_vad import energy_windows, speech_evidence


class SilenceWindowsTest(unittest.TestCase):
    def test_uses_silence_and_reserves_overlap_for_forced_cut(self):
        rate = SAMPLE_RATE
        frames = 35 * rate
        speech = [(0, 11 * rate), (12 * rate, frames)]
        chunks, hard = plan_silence_chunks(frames, speech, chunk_seconds=10, context_seconds=1)
        self.assertEqual(chunks[0].end_frame, int(11.5 * rate))
        self.assertEqual(chunks[1].start_frame, chunks[0].end_frame)
        self.assertIn(2, hard)
        self.assertEqual(chunks[2].start_frame, chunks[2].core_start_frame - rate)
        self.assertEqual(chunks[-1].core_end_frame, frames)
        self.assertEqual(sum(chunk.core_end_frame - chunk.core_start_frame for chunk in chunks), frames)

    def test_vad_state_and_energy_use_one_immutable_evidence_record(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio, model = root/'pcm.wav', root/'model.onnx'
            model.write_bytes(b'authored')
            with wave.open(str(audio), 'wb') as stream:
                stream.setparams((1, 2, SAMPLE_RATE, 0, 'NONE', 'not compressed'))
                stream.writeframes(bytes(512 * 9 * 2))
            with patch('audio_vad._probabilities', return_value=iter((i*512,p)
                       for i,p in enumerate([0., .9, .9, .4, 0., 0., 0., 0., 0.]))) as infer:
                first = speech_evidence(audio, audio, root, model=model)
                second = speech_evidence(audio, audio, root, model=model)
                infer.assert_called_once()
            self.assertEqual(first, second)
            self.assertEqual(first['speech_frames'], [[512, 2048]])
            self.assertEqual(len(energy_windows(audio)), 28)
