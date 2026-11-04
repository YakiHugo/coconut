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


def label_aligned_segments(segments, turns, decisions, *, split=False):
    """Use aligned words, excluding pauses, and optionally split fresh ASR cues.

    Existing documents keep their cue IDs/times by default. Splitting is for
    fresh transcripts before annotations are attached. No word clock is invented
    for zero-duration aligner tokens: a small matching window is used only for
    attribution, and competing speech still prevents a confident label.
    """
    import copy
    import re

    label_segments(segments, turns, decisions)
    probes, aligned = [], {}
    for index, cue in enumerate(segments):
        words = cue.get('words') or []
        if not words or ''.join(w['word'] for w in words) != cue.get('text'):
            continue
        group = []
        for word in words:
            start, end = word['start'], word['end']
            if end - start < .08:
                middle = (start + end) / 2
                start, end = max(0, middle - .08), middle + .08
            probe = dict(start=start, end=end)
            probes.append(probe)
            group.append(probe)
        aligned[index] = group
    label_segments(probes, turns, decisions)
    # Alignment and diarization use different frame grids. Bridge only small
    # empty gaps with one unopposed acoustic identity, never unresolved speech.
    ordered_turns = sorted(turns, key=lambda t: t['start'])
    cursor = 0
    for probe in sorted(probes, key=lambda p: p['start']):
        if probe.get('speaker_status') != 'no_speech_evidence':
            continue
        while cursor < len(ordered_turns) and ordered_turns[cursor]['end'] < probe['start'] - .12:
            cursor += 1
        nearby = set()
        for turn in ordered_turns[cursor:]:
            if turn['start'] > probe['end'] + .12:
                break
            if turn['end'] < probe['start'] - .12:
                continue
            nearby.add(decisions.get(str(turn['speaker']), {}).get('speaker_id'))
        if len(nearby) == 1 and None not in nearby:
            probe['speaker_id'] = next(iter(nearby))
    output = []
    for index, cue in enumerate(segments):
        if index not in aligned:
            output.append(cue)
            continue
        words, matches = cue['words'], aligned[index]
        # A zero-length token inside a sentence cannot establish a change of
        # voice. Nor can a few boundary frames: diarization and word alignment
        # can disagree there. Keep such words in the text without manufacturing
        # tiny speaker turns from them. Standalone short replies still use their
        # own local acoustic window above.
        if len(words) > 1:
            for word, match in zip(words, matches):
                if word['end'] <= word['start']:
                    match['speaker_id'] = None
            runs = []
            for j, match in enumerate(matches):
                identifier = match.get('speaker_id')
                if identifier:
                    if runs and runs[-1][0] == identifier:
                        runs[-1][1].append(j)
                    else:
                        runs.append((identifier, [j]))
            if len({identifier for identifier, _ in runs}) > 1:
                for _, indices in runs:
                    if words[indices[-1]]['end'] - words[indices[0]]['start'] < .75:
                        for j in indices:
                            matches[j]['speaker_id'] = None
        # Ignore punctuation-only units in the vote, while preserving every
        # character in output. A competing/unknown voice is never discarded.
        weights = [max(1, len(re.sub(r'\W', '', w['word']))) for w in words]
        votes = {}
        for weight, match in zip(weights, matches):
            if match.get('speaker_id'):
                votes[match['speaker_id']] = votes.get(match['speaker_id'], 0) + weight
        if len(votes) == 1 and next(iter(votes.values())) >= .8 * sum(weights):
            identifier = next(iter(votes))
            cue.update(speaker_id=identifier, speaker_status='automatic_unreviewed',
                       speaker=f'说话人 {int(identifier.split("-")[-1])}')
        elif len(votes) > 1:
            cue.update(speaker_id=None, speaker=None, speaker_status='speaker_change_within_cue')
        if not split or len(votes) < 2:
            output.append(cue)
            continue
        # Unknown alignment tokens do not each become a new tiny cue. Locate
        # changes between trusted words, then assess each resulting part again.
        boundaries, previous, previous_index = [0], None, 0
        for word_index, match in enumerate(matches):
            identifier = match.get('speaker_id')
            if not identifier:
                continue
            if previous is not None and identifier != previous:
                boundaries.append((previous_index + word_index + 1) // 2)
            previous, previous_index = identifier, word_index
        boundaries.append(len(words))
        groups = []
        for a, b in zip(boundaries, boundaries[1:]):
            local_votes = {}
            for weight, match in zip(weights[a:b], matches[a:b]):
                identifier = match.get('speaker_id')
                if identifier:
                    local_votes[identifier] = local_votes.get(identifier, 0) + weight
            identifier = max(local_votes, key=local_votes.get) if local_votes else None
            if identifier and local_votes[identifier] < .8 * sum(weights[a:b]):
                identifier = None
            groups.append((identifier, words[a:b]))
        for part, (identifier, group) in enumerate(groups):
            item = copy.deepcopy(cue)
            item.update(id=cue['id'] if part == 0 else f'{cue["id"]}-voice-{part + 1}',
                        start=cue['start'] if part == 0 else group[0]['start'],
                        end=cue['end'] if part == len(groups) - 1 else max(w['end'] for w in group),
                        text=''.join(w['word'] for w in group), words=copy.deepcopy(group),
                        speaker_id=identifier,
                        speaker=f'说话人 {int(identifier.split("-")[-1])}' if identifier else None,
                        speaker_status='automatic_unreviewed' if identifier else 'overlap_or_boundary')
            # Text offsets, when supplied, are local to the new cue.
            offset = sum(len(w['word']) for _, previous in groups[:part] for w in previous)
            for word in item['words']:
                for key in ('text_start', 'text_end'):
                    if key in word:
                        word[key] -= offset
            output.append(item)
    return output


def reconcile_recording_speakers(blocks, *, expected_speakers=None, threshold=.72, margin=.08):
    """Reconcile local clusters using the whole recording, including split voices.

    Long clean samples anchor average-link clustering. Short samples can match
    those anchors, but brief mixed sounds do not seed extra identities in a long
    interview. A verified participant count is a per-recording hint, not a global
    assumption. Unmatched/overlapping speech remains present and unresolved.
    """
    if expected_speakers is not None and (type(expected_speakers) is not int or not 1 <= expected_speakers <= 32):
        raise ValueError('Expected speaker count must be between 1 and 32')
    samples, model, dimension = [], None, None
    for index, block in enumerate(blocks):
        voices = block['voices']
        for label, item in voices['evidence'].items():
            if item.get('embedding') is None or item.get('duration', 0) < 1.5:
                continue
            vector = unit_vector(item['embedding'])
            identity = voices.get('embedding_model')
            if not identity or model not in (None, identity) or dimension not in (None, len(vector)):
                raise ValueError('Incompatible speaker embedding model')
            model, dimension = identity, len(vector)
            samples.append((index, str(label), float(item['duration']), vector))
    decisions = {}
    if samples:
        import numpy as np
        values = np.asarray([sample[3] for sample in samples], dtype=np.float64)
        anchors = [i for i, sample in enumerate(samples) if sample[2] >= 10]
        if not anchors:
            anchors = list(range(len(samples)))
        vectors = values[anchors]
        similarities = vectors @ vectors.T
        np.fill_diagonal(similarities, -np.inf)
        groups = {i: [i] for i in range(len(anchors))}
        while len(groups) > (expected_speakers or 1):
            left, right = np.unravel_index(np.argmax(similarities), similarities.shape)
            score = similarities[left, right]
            if not np.isfinite(score) or expected_speakers is None and score < threshold:
                break
            a, b = len(groups[left]), len(groups[right])
            # Only active off-diagonal entries participate in the next merge.
            for other in groups:
                if other not in (left, right):
                    value = (similarities[left, other] * a + similarities[right, other] * b) / (a + b)
                    similarities[left, other] = similarities[other, left] = value
            groups[left].extend(groups.pop(right))
            similarities[right, :] = similarities[:, right] = -np.inf
            similarities[left, left] = -np.inf
        centers = []
        for members in groups.values():
            indices = [anchors[i] for i in members]
            weights = np.asarray([min(samples[i][2], 32) for i in indices])
            center = np.average(values[indices], axis=0, weights=weights)
            if np.linalg.norm(center) >= 1e-8:
                centers.append(unit_vector(center.tolist()))
        scores_by_sample = values @ np.asarray(centers).T if centers else []
        for sample, scores in zip(samples, scores_by_sample):
            order = np.argsort(scores)[::-1]
            best = int(order[0])
            second = float(scores[order[1]]) if len(order) > 1 else -1
            accepted = scores[best] >= threshold and scores[best] - second >= margin
            decisions[(sample[0], sample[1])] = best if accepted else None

    exported, first_seen = [], {}
    for index, block in enumerate(blocks):
        for turn in block['voices']['turns']:
            start = max(turn['start'] + block['start'], block['core_start'])
            end = min(turn['end'] + block['start'], block['core_end'])
            if end <= start:
                continue
            group = decisions.get((index, str(turn['speaker'])))
            if group is not None:
                first_seen[group] = min(first_seen.get(group, start), start)
            exported.append((start, end, index, str(turn['speaker']), group))
    identities = {group: f'speaker-{i + 1:04d}' for i, group in
                  enumerate(sorted(first_seen, key=lambda group: (first_seen[group], group)))}
    turns = []
    for start, end, index, local, group in exported:
        identifier = identities.get(group)
        turns.append(dict(start=start, end=end, speaker=identifier or f'unresolved:{index}:{local}',
                          speaker_id=identifier, speaker_status='recording_match' if identifier else 'ambiguous_match'))
    return turns, len(identities)


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

    def refine_turns(self, path, turns):
        """Recover rejected local clusters from individual clean utterances.

        Only existing recording identities are candidates. A failed/mixed local
        cluster does not invalidate every utterance in it. Short interjections
        require stronger acoustic evidence; neighbours never decide their voice.
        """
        import copy
        import wave
        import numpy as np

        def clean_windows(turn):
            clean = [(turn['start'], turn['end'])]
            for other in turns:
                if other['speaker'] == turn['speaker']:
                    continue
                if other['end'] <= turn['start'] or other['start'] >= turn['end']:
                    continue
                clean = [(a, b) for start, end in clean for a, b in
                         ((start, min(end, other['start'])), (max(start, other['end']), end)) if b > a]
            return [(a + .04, b - .04) for a, b in clean if b - a >= .28]

        def extract_ranges(ranges):
            parts = []
            for start, end in ranges:
                stream_audio.setpos(round(start * rate))
                parts.append(np.frombuffer(stream_audio.readframes(round((end - start) * rate)), dtype='<i2'))
            samples = np.concatenate(parts)
            stream = self.extractor.create_stream()
            stream.accept_waveform(rate, samples.astype('float32') / 32768)
            stream.input_finished()
            return unit_vector(list(self.extractor.compute(stream))) if self.extractor.is_ready(stream) else None

        def extract(start, end):
            return extract_ranges([(start, end)])

        def match(vector, threshold=.72, margin=.08):
            if vector is None:
                return None
            ranked = sorted(((key, cosine(vector, center)) for key, center in centers.items()),
                            key=lambda pair: (-pair[1], pair[0]))
            identifier, score = ranked[0]
            second = ranked[1][1] if len(ranked) > 1 else -1
            return (identifier, score) if score >= threshold and score - second >= margin else None

        result = copy.deepcopy(turns)
        with wave.open(str(path), 'rb') as stream_audio:
            rate = stream_audio.getframerate()
            if rate != self.engine.sample_rate or stream_audio.getnchannels() != 1 or stream_audio.getsampwidth() != 2:
                raise ValueError('Speaker refinement requires normalized mono PCM audio')
            windows = [clean_windows(turn) for turn in turns]
            references = {}
            for turn, ranges in zip(turns, windows):
                if turn.get('speaker_id'):
                    references.setdefault(turn['speaker_id'], []).extend((a, min(b, a + 8)) for a, b in ranges if b - a >= 3)
            centers = {}
            for identifier, ranges in references.items():
                vectors = [extract(a, b) for a, b in sorted(ranges, key=lambda r: r[1] - r[0], reverse=True)[:8]]
                vectors = [v for v in vectors if v is not None]
                if len(vectors) >= 2:
                    centers[identifier] = unit_vector([sum(items) for items in zip(*vectors)])
            # A cluster made mostly of short questions can have ample evidence
            # overall although no single utterance satisfies the old 1.7s cut.
            # Require independent batches to agree; mixed clusters fall through
            # to individual utterance matching instead of receiving one label.
            grouped = {}
            for turn, ranges in zip(turns, windows):
                if not turn.get('speaker_id'):
                    grouped.setdefault(turn['speaker'], []).extend(ranges)
            group_matches = {}
            for local, ranges in grouped.items():
                merged = []
                for a, b in sorted(ranges):
                    if merged and a <= merged[-1][1]:
                        merged[-1] = (merged[-1][0], max(b, merged[-1][1]))
                    else:
                        merged.append((a, b))
                batches, batch, duration = [], [], 0
                for a, b in merged:
                    while b - a > 1e-6:
                        end = min(b, a + 4 - duration)
                        batch.append((a, end))
                        duration += end - a
                        a = end
                        if duration >= 4 - 1e-6:
                            batches.append(batch)
                            batch, duration = [], 0
                if duration >= 2:
                    batches.append(batch)
                if len(batches) < 2 or not centers:
                    continue
                selected = sorted(set(round(i) for i in np.linspace(0, len(batches) - 1, min(8, len(batches)))))
                matches = [match(extract_ranges(batches[i])) for i in selected]
                if all(matches) and len({m[0] for m in matches}) == 1:
                    group_matches[local] = (matches[0][0], min(m[1] for m in matches))
            for turn, ranges in zip(result, windows):
                if turn.get('speaker_id') or not ranges or not centers:
                    continue
                if turn['speaker'] in group_matches:
                    identifier, score = group_matches[turn['speaker']]
                    turn.update(speaker=identifier, speaker_id=identifier, speaker_status='cluster_acoustic_match',
                                speaker_similarity=round(score, 5))
                    continue
                start, end = max(ranges, key=lambda r: r[1] - r[0])
                if end - start < .67:
                    continue
                # Sample both ends of long utterances rather than averaging a
                # possible speaker change into one apparently confident vector.
                clips = [(start, min(end, start + 8))]
                if end - start > 10:
                    clips.append((max(start, end - 8), end))
                matches, scores = [], []
                for a, b in clips:
                    vector = extract(a, b)
                    if vector is None:
                        break
                    threshold, margin = (.8, .15) if b - a < 1.5 else (.72, .08)
                    decision = match(vector, threshold, margin)
                    if decision is None:
                        break
                    identifier, score = decision
                    matches.append(identifier)
                    scores.append(score)
                if len(matches) == len(clips) and len(set(matches)) == 1:
                    turn.update(speaker=matches[0], speaker_id=matches[0], speaker_status='turn_acoustic_match',
                                speaker_similarity=round(min(scores), 5))
        return result

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
