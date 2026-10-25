"""Recording-scoped acoustic identities; provider/chunk labels are never identities."""
from __future__ import annotations

import math


def unit_vector(values):
    if not isinstance(values, (list, tuple)) or not values:
        raise ValueError('Speaker embedding must be a nonempty vector')
    vector = [float(value) for value in values]
    norm = math.sqrt(sum(value * value for value in vector))
    if not all(math.isfinite(value) for value in vector) or not math.isfinite(norm) or norm < 1e-8:
        raise ValueError('Invalid speaker embedding')
    return [value / norm for value in vector]


def cosine(left, right):
    if len(left) != len(right):
        raise ValueError('Incompatible speaker embedding dimensions')
    return sum(a * b for a, b in zip(left, right))


class SpeakerRegistry:
    """Conservative, one-to-one block matching against trusted voice prototypes.

    Ambiguous evidence neither creates an identity nor updates its prototypes.
    The registry lives for the whole recording, including gaps and language changes.
    Replaying persisted block evidence reconstructs the same IDs after a crash.
    """
    def __init__(self, threshold=.72, margin=.08, max_speakers=32):
        if not 0 < threshold <= 1 or not 0 < margin < threshold or max_speakers < 1:
            raise ValueError('Invalid speaker matching settings')
        self.threshold, self.margin, self.max_speakers = threshold, margin, max_speakers
        self.voices = {}
        self.embedding_model = None
        self.dimension = None

    def resolve(self, evidence, model):
        """Return local label -> decision. All observations use one embedding model."""
        usable = {}
        decisions = {}
        for label, item in evidence.items():
            decisions[label] = {'speaker_id': None, 'status': 'insufficient_audio'}
            if item.get('embedding') is None or item.get('duration', 0) < 1.5:
                continue
            vector = unit_vector(item['embedding'])
            if not model:
                raise ValueError('Speaker embeddings require a model identity')
            if self.embedding_model not in (None, model) or self.dimension not in (None, len(vector)):
                raise ValueError('Incompatible speaker embedding model')
            self.embedding_model, self.dimension = model, len(vector)
            usable[label] = vector
        # Score only against identities from earlier blocks. Distinct local
        # clusters in one block must never silently collapse onto one identity.
        scores = {label: sorted(((identifier, max(cosine(vector, prototype) for prototype in voice))
                                  for identifier, voice in self.voices.items()),
                                 key=lambda pair: (-pair[1], pair[0]))
                  for label, vector in usable.items()}
        candidates = []
        for label, ranked in scores.items():
            if not ranked:
                continue
            identifier, score = ranked[0]
            second = ranked[1][1] if len(ranked) > 1 else -1
            competitors = [other[0][1] for key, other in scores.items()
                           if key != label and other and other[0][0] == identifier]
            if score >= self.threshold and score - second >= self.margin and (
                    not competitors or score - max(competitors) >= self.margin):
                candidates.append((label, identifier, score))
        for label, identifier, score in candidates:
            decisions[label] = {'speaker_id': identifier, 'status': 'acoustic_match', 'similarity': round(score, 5)}
            # Keep the original anchor plus a bounded recent history; no update
            # on ambiguous matches, so uncertain blocks cannot drift the voice.
            history = self.voices[identifier]
            history.append(usable[label])
            if len(history) > 8:
                del history[1]
        for label, vector in usable.items():
            if decisions[label]['speaker_id']:
                continue
            ranked = scores[label]
            if ranked and ranked[0][1] >= self.threshold - self.margin:
                decisions[label]['status'] = 'ambiguous_match'
            elif len(self.voices) >= self.max_speakers:
                decisions[label]['status'] = 'speaker_limit'
            else:
                identifier = f'speaker-{len(self.voices) + 1:04d}'
                self.voices[identifier] = [vector]
                decisions[label] = {'speaker_id': identifier, 'status': 'new_voice'}
        return decisions


def label_segments(segments, turns, decisions):
    """Assign by union coverage, never double-count duplicate/overlapping turns."""
    turns = sorted(turns, key=lambda turn: turn['start'])
    cursor = 0
    for segment in sorted(segments, key=lambda segment: segment['start']):
        intervals = {}
        statuses = set()
        while cursor < len(turns) and turns[cursor]['end'] <= segment['start']:
            cursor += 1
        for index in range(cursor, len(turns)):
            turn = turns[index]
            if turn['start'] >= segment['end']:
                break
            start, end = max(segment['start'], turn['start']), min(segment['end'], turn['end'])
            if end <= start:
                continue
            decision = decisions.get(str(turn['speaker']), {})
            statuses.add(decision.get('status', 'insufficient_audio'))
            # Unresolved competing speech still counts as a competitor. Dropping
            # it here would turn a known+unknown overlap into false confidence.
            identifier = decision.get('speaker_id') or f'unresolved:{turn["speaker"]}'
            intervals.setdefault(identifier, []).append((start, end))
        coverage = {}
        for identifier, ranges in intervals.items():
            merged = []
            for start, end in sorted(ranges):
                if merged and start <= merged[-1][1]:
                    merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
                else:
                    merged.append((start, end))
            coverage[identifier] = sum(end - start for start, end in merged)
        ranked = sorted(coverage.items(), key=lambda pair: (-pair[1], pair[0]))
        duration = segment['end'] - segment['start']
        identifier = None
        status = 'no_speech_evidence'
        if ranked and not ranked[0][0].startswith('unresolved:') and duration > 0 and ranked[0][1] >= .60 * duration and (
                len(ranked) == 1 or ranked[1][1] <= ranked[0][1] * .5):
            identifier, status = ranked[0][0], 'automatic_unreviewed'
        elif len(ranked) > 1 or ranked and not ranked[0][0].startswith('unresolved:'):
            status = 'overlap_or_boundary'
        elif statuses:
            status = sorted(statuses)[0]
        segment.update(speaker_id=identifier, speaker_status=status,
                       speaker=f'说话人 {int(identifier.split("-")[-1])}' if identifier else None)


class SherpaSpeakerBackend:
    """Bounded local diarization + clean voice samples, reusable by cloud ASR."""
    local_only = True

    def __init__(self, segmentation, embedding):
        import hashlib
        from pathlib import Path
        import sherpa_onnx
        paths = [Path(path).expanduser().resolve(strict=True) for path in (segmentation, embedding)]
        for path in paths:
            if not path.is_file() or not path.stat().st_size:
                raise ValueError('Missing local speaker model')
        self.embedding_model = 'eres2net:' + hashlib.sha256(paths[1].read_bytes()).hexdigest()
        self.cache_key = {'backend': 'sherpa-onnx', 'version': 'chunk-voices-v1',
                          'segmentation': hashlib.sha256(paths[0].read_bytes()).hexdigest(),
                          'embedding': self.embedding_model}
        config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                    model=str(paths[0]), window_shift_ratio=.5), num_threads=2),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(paths[1]), num_threads=2),
            clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=.8),
            min_duration_on=.3, min_duration_off=.5)
        if not config.validate():
            raise ValueError('Invalid local speaker models')
        self.engine = sherpa_onnx.OfflineSpeakerDiarization(config)
        self.extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(paths[1]), num_threads=2))

    def analyze(self, path):
        import wave
        import numpy as np
        with wave.open(str(path), 'rb') as stream:
            samples = np.frombuffer(stream.readframes(stream.getnframes()), dtype='<i2').astype('float32') / 32768
            return self.analyze_samples(samples, stream.getframerate())

    def analyze_samples(self, samples, sample_rate):
        if sample_rate != self.engine.sample_rate:
            raise ValueError('Speaker audio sample rate mismatch')
        turns = [{'start': float(t.start), 'end': float(t.end), 'speaker': str(t.speaker)}
                 for t in self.engine.process(samples).sort_by_start_time()]
        evidence = {}
        for label in dict.fromkeys(turn['speaker'] for turn in turns):
            # Exclude competing voices before embedding. Mixed/short samples
            # may describe two people; they must not become identity anchors.
            windows = []
            for turn in turns:
                if turn['speaker'] != label:
                    continue
                clean = [(turn['start'], turn['end'])]
                for other in turns:
                    if other['speaker'] == label:
                        continue
                    clean = [(a, b) for start, end in clean for a, b in
                             ((start, min(end, other['start'])), (max(start, other['end']), end)) if b > a]
                windows.extend((start + .1, min(end - .1, start + 8.1))
                               for start, end in clean if end - start >= 1.7)
            vectors, duration = [], 0
            for start, end in sorted(windows, key=lambda pair: pair[1] - pair[0], reverse=True)[:4]:
                stream = self.extractor.create_stream()
                stream.accept_waveform(sample_rate, samples[int(start * sample_rate):int(end * sample_rate)])
                stream.input_finished()
                if self.extractor.is_ready(stream):
                    vectors.append(unit_vector(list(self.extractor.compute(stream))))
                    duration += end - start
            if vectors:
                # Reject a local cluster whose clean samples disagree; do not
                # let a diarizer's merged cluster poison recording-level IDs.
                if min(cosine(a, b) for a in vectors for b in vectors) >= .55:
                    vector = unit_vector([sum(items) for items in zip(*vectors)])
                    evidence[label] = {'embedding': vector, 'duration': duration}
        return {'turns': turns, 'evidence': evidence, 'embedding_model': self.embedding_model}
