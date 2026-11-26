"""Bounded, offline Silero speech detection with recording-wide recurrent state."""
from __future__ import annotations

import importlib.metadata
import json
import os
import wave
from pathlib import Path

from audio_pipeline import SAMPLE_RATE, _file_digest, _pcm_lock, _wav_frames
from transcript import save_document

VAD_VERSION = 'silero-v6-stream-v1'
WINDOW = 512
BATCH = 256


def silero_model(configured=None):
    path = configured or os.environ.get('COCONUT_VAD_MODEL')
    if not path:
        try:
            distribution = importlib.metadata.distribution('faster-whisper')
            path = distribution.locate_file('faster_whisper/assets/silero_vad_v6.onnx')
        except importlib.metadata.PackageNotFoundError:
            pass
    if not path or not Path(path).is_absolute() or not Path(path).is_file():
        raise ValueError('Configure a local Silero V6 model')
    return Path(path)


def _probabilities(audio, model, check):
    import numpy as np
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.inter_op_num_threads = options.intra_op_num_threads = 1
    options.enable_cpu_mem_arena = False
    session = ort.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider'])
    h = np.zeros((1, 1, 128), dtype=np.float32)
    c = h.copy()
    prior = np.zeros(64, dtype=np.float32)
    with wave.open(str(audio), 'rb') as stream:
        edge = 0
        while block := stream.readframes(WINDOW * BATCH):
            check()
            samples = np.frombuffer(block, dtype='<i2').astype(np.float32) / 32768
            rows = np.pad(samples, (0, -len(samples) % WINDOW)).reshape(-1, WINDOW)
            context = np.vstack((prior, rows[:-1, -64:]))
            prior = rows[-1, -64:].copy()
            output, h, c = session.run(None, {'input': np.concatenate((context, rows), axis=1), 'h': h, 'c': c})
            for probability in output.reshape(-1):
                yield edge, float(probability)
                edge += WINDOW


def _speech_ranges(probabilities, frames):
    speech = []
    start = quiet = None
    for edge, probability in probabilities:
        if probability >= .5:
            quiet = None
            if start is None:
                start = edge
        elif probability < .35 and start is not None:
            if quiet is None:
                quiet = edge
            if edge - quiet >= .08 * SAMPLE_RATE:
                if quiet - start >= .04 * SAMPLE_RATE:
                    speech.append([start, quiet])
                start = quiet = None
    if start is not None and frames - start >= .04 * SAMPLE_RATE:
        speech.append([start, frames])
    return speech


def speech_evidence(audio, source, directory, *, model=None, check=lambda: None):
    """Share VAD between transcription and reading for a verified local asset."""
    model = silero_model(model)
    frames = _wav_frames(audio)
    identity = {'version': VAD_VERSION, 'frames': frames, 'pcm_sha256': _file_digest(audio),
                'model_sha256': _file_digest(model)}
    directory = Path(directory)
    configured = os.environ.get('COCONUT_PCM_CACHE')
    if configured and Path(configured).is_absolute() and Path(source).suffix == '.media':
        shared = Path(configured) / Path(source).stem
        if shared.is_dir():
            directory = shared
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / ('vad-' + identity['model_sha256'] + '.json')
    with _pcm_lock(target.with_suffix('.lock')):
        check()
        if target.exists():
            value = json.loads(target.read_text())
            if value.get('identity') == identity:
                return value
        spans = _speech_ranges(_probabilities(audio, model, check), frames)
        check()
        result = {'identity': identity, 'speech_frames': spans}
        save_document(result, target)
        return result


def energy_windows(audio):
    """Return 10 ms RMS in dB. Float PCM is bounded to a few seconds."""
    import numpy as np

    result = np.empty(_wav_frames(audio) // 160, dtype=np.float32)
    edge = 0
    with wave.open(str(audio), 'rb') as stream:
        while data := stream.readframes(160 * 512):
            count = len(data) // 320
            values = np.frombuffer(data, dtype='<i2', count=count * 160).astype(np.float32)
            values /= 32768
            result[edge:edge+count] = 10 * np.log10(np.mean(values.reshape(-1, 160) ** 2, axis=1) + 1e-12)
            edge += count
    return result
