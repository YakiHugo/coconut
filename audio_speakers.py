"""Recording-scoped acoustic identities; provider/chunk labels are never identities."""
from __future__ import annotations

import math
import re


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
        if segment.get('boundary_status') == 'seam-consensus-v1':
            segment.update(speaker=None, speaker_id=None, speaker_status='seam_recovered_unknown')
            continue
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
        if ranked and not ranked[0][0].startswith('unresolved:') and duration > 0 and ranked[0][1] >= .60 * duration and len(ranked) == 1:
            identifier, status = ranked[0][0], 'automatic_unreviewed'
        elif len(ranked) > 1 or ranked and not ranked[0][0].startswith('unresolved:'):
            status = 'overlap_or_boundary'
        elif statuses:
            status = sorted(statuses)[0]
        segment.update(speaker_id=identifier, speaker_status=status,
                       speaker=f'说话人 {int(identifier.split("-")[-1])}' if identifier else None)


def fuse_speakers(cues, turns, *, split=True, check=lambda: None):
    """Project the acoustic timeline through observed word clocks and safe cuts."""
    from bisect import bisect_left, bisect_right
    from audio_pipeline import _rebase_word_spans
    from transcript_boundaries import _lexeme_crosses

    terminal = re.compile(r'[.?!。？！…]["”’」』）)]*\s*$')
    clause = re.compile(r'[,;:，；：]["”’」』）)]*\s*$')
    starts = [turn['start'] for turn in turns]
    ends, edge = [], 0.
    for turn in turns:
        edge = max(edge, turn['end'])
        ends.append(edge)

    def overlap(start, end, active):
        return [(turn['speaker_id'], max(start, turn['start']), min(end, turn['end']))
                for turn in active if turn['start'] < end and start < turn['end']]

    def assignment(cue, active):
        start, end = cue['start'], cue['end']
        spans = overlap(start, end, active)
        known = {}
        for voice, a, b in spans:
            if voice:
                known[voice] = known.get(voice, 0.) + b-a
        voice = max(known, key=known.get, default=None)
        covered = known.get(voice, 0.)
        duration = end-start
        others = [(a, b) for key, a, b in spans if key != voice]
        status = 'no_speech_evidence' if not spans else 'overlap_or_boundary'
        words = [word for word in cue.get('words', ()) if word['end'] > word['start'] and any(c.isalnum() for c in word['word'])]
        def speech_under(a, b, source):
            return sum(max(0., min(b, y)-max(a, x)) for x, y in source)
        main = [(a, b) for key, a, b in spans if key == voice]
        if voice and not others:
            aligned = (len(words) >= 3 and covered >= .60 * duration and sum(
                speech_under(w['start'],w['end'],main) >= .65*(w['end']-w['start'])
                for w in words) >= .90*len(words))
            if covered >= .70*duration or aligned:
                status = 'automatic_unreviewed'
        elif voice and covered >= .85 * duration:
            competing = sum(b-a for a, b in others)
            if competing <= min(.8, .12 * duration):
                fully_overlapping = all(b-a-speech_under(a,b,main) <= (.15 if words else .02) for a,b in others)
                has_other_words = any(speech_under(w['start'],w['end'],main) < .60*(w['end']-w['start']) and
                    speech_under(w['start'],w['end'],others) >= .50*(w['end']-w['start']) for w in words)
                if fully_overlapping and not has_other_words:
                    status = 'dominant_with_brief_overlap'
        if status not in ('automatic_unreviewed', 'dominant_with_brief_overlap'):
            voice = None
        cue.update(speaker_id=voice, speaker_status=status,
                   speaker=f'说话人 {int(voice.removeprefix("speaker-"))}' if voice else None)
        return cue

    def word_group(word, active):
        begin, end = word['start'], word['end']
        if end <= begin or not any(char.isalnum() for char in word['word']):
            return None
        spans = overlap(begin, end, active)
        voices = {identity for identity, _, _ in spans}
        if len(voices) != 1 or None in voices:
            return None
        return next(iter(voices)) if sum(b-a for _, a, b in spans) >= .60*(end-begin) else None

    def cut_at(words, first, last):
        before, after = words[first]['end'], words[last]['start']
        if after-before > 1.5:
            return None
        center = (before+after)/2
        choices = []
        for at in range(first+1, last+1):
            a, b = words[at-1], words[at]
            gap, point = b['start']-a['end'], (b['start']+a['end'])/2
            if gap < 0 or abs(center-point) > .5:
                continue
            if terminal.search(a['word']):
                priority = 0
            elif gap >= .15 and not _lexeme_crosses(a['word'].rstrip(), b['word'].lstrip()):
                priority = 1
            elif clause.search(a['word']):
                priority = 2
            else:
                continue
            choices.append((priority, abs(center-point), at))
        return min(choices)[-1] if choices else None

    result = []
    for cue in cues:
        check()
        if cue.get('speaker'):
            result.append(cue)
            continue
        if cue.get('boundary_status') == 'seam-consensus-v1':
            result.append({**cue, 'speaker_status':'seam_recovered_unknown'})
            continue
        active = turns[bisect_right(ends, cue['start']):bisect_left(starts, cue['end'])]
        whole = assignment(dict(cue), active)
        words = cue.get('words') or []
        if not split or whole['speaker_id'] or len(words) < 2 or ''.join(w['word'] for w in words) != cue['text']:
            result.append(whole)
            continue
        cuts, previous = [], None
        for index, word in enumerate(words):
            voice = word_group(word, active)
            if voice is None:
                continue
            if previous and previous[1] != voice:
                cut = cut_at(words, previous[0], index)
                if cut is not None:
                    cuts.append(cut)
            previous = index, voice
        if not cuts:
            result.append(whole)
            continue
        for number, (left, right) in enumerate(zip([0, *cuts], [*cuts, len(words)])):
            selected = [dict(w) for w in words[left:right]]
            _rebase_word_spans(selected)
            part = {**cue, 'id':cue['id'] if not number else f'{cue["id"]}-voice-{number}',
                    'start':cue['start'] if not number else selected[0]['start'],
                    'end':cue['end'] if right == len(words) else selected[-1]['end'],
                    'text':''.join(w['word'] for w in selected), 'words':selected}
            result.append(assignment(part, active))
    return result


def _global_clusters(samples, conflicts, expected_speakers, check, continuity=None):
    """Cluster all recording-wide anchors once. Overlapping lanes cannot link."""
    import numpy as np

    similarity, margin = .65, .08
    anchors = [i for i, (duration, vector) in enumerate(samples) if duration >= 1.6 and vector]
    if not anchors:
        return {}
    vectors = np.asarray([samples[i][1] for i in anchors], dtype=np.float32)
    parents = list(range(len(anchors)))
    members = [{i} for i in anchors]
    blocked = [set(conflicts.get(i, ())) for i in anchors]
    sums = vectors.copy()
    centers = vectors.copy()
    edges = []
    neighbors = min(12, len(anchors))
    for start in range(0, len(anchors), 128):
        check()
        scores = vectors[start:start+128] @ vectors.T
        for offset, row in enumerate(scores):
            first = start + offset
            for second in np.argpartition(row, -neighbors)[-neighbors:]:
                if second != first and row[second] >= similarity:
                    edges.append((-float(row[second]), min(first, int(second)), max(first, int(second))))

    def root(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i

    for index, (_, a, b) in enumerate(sorted(set(edges))):
        if index % 128 == 0:
            check()
        a, b = root(a), root(b)
        if (a == b or members[a] & blocked[b] or members[b] & blocked[a] or
                centers[a] @ centers[b] < similarity):
            continue
        if len(members[a]) < len(members[b]):
            a, b = b, a
        parents[b] = a
        members[a].update(members[b])
        blocked[a].update(blocked[b])
        sums[a] += sums[b]
        centers[a] = sums[a] / np.linalg.norm(sums[a])

    groups = [i for i in range(len(anchors)) if parents[i] == i]
    support = {i: sum(samples[j][0] for j in members[i]) for i in groups}
    # Stable prototypes require repeat evidence on long recordings.
    minimum_support = 3. if sum(support.values()) < 30. else 6.
    groups = [i for i in groups if support[i] >= minimum_support]
    groups.sort(key=lambda i: (-support[i], min(members[i])))
    if expected_speakers is not None:
        groups = groups[:expected_speakers]
    groups.sort(key=lambda i: min(members[i]))
    assignments = {index: group for group in groups for index in members[group]}
    continuity = continuity or {}
    for index, (_, vector) in enumerate(samples):
        check()
        if index in assignments:
            continue
        available = [group for group in groups if not members[group] & conflicts.get(index, set())]
        supported = {assignments[i] for i in continuity.get(index, ()) if i in assignments}
        if len(supported) == 1 and supported <= set(available):
            group = next(iter(supported))
        elif vector:
            ranked = sorted(((float(centers[group] @ vector), group) for group in available), reverse=True)
            if not ranked or ranked[0][0] < similarity or (len(ranked)>1 and ranked[0][0]-ranked[1][0]<margin):
                continue
            group = ranked[0][1]
        else:
            continue
        assignments[index] = group
        members[group].add(index)
    names = {group: f'speaker-{i+1:04d}' for i, group in enumerate(groups)}
    return {index:names[group] for index, group in assignments.items()}


def _active_lanes(scores, left, right, origin, hop, receptive_field):
    """Convert pyannote powerset frames into recording-clock activity runs."""
    import numpy as np

    powerset = ((), (0,), (1,), (2,), (0, 1), (0, 2), (1, 2))
    classes = np.argmax(scores, axis=1)
    if not len(classes):
        return
    centers = origin + receptive_field // 2 + np.arange(len(classes)) * hop
    start_index = min(len(classes)-1, int(np.searchsorted(centers + hop // 2, left, side='right')))
    end_index = min(len(classes), int(np.searchsorted(centers - hop // 2, right, side='left')))
    start = left
    previous = int(classes[start_index])
    for index in range(start_index+1, end_index):
        state = int(classes[index])
        if state == previous:
            continue
        end = min(right, int(centers[index]-hop//2))
        if end > start and powerset[previous]:
            yield start, end, powerset[previous]
        start, previous = end, state
    if right > start and powerset[previous]:
        yield start, right, powerset[previous]


def _stable_activity(runs, left, right, sample_rate):
    """Suppress short, isolated activity flutter while retaining overlaps."""
    minimum = round(.12*sample_rate)
    lanes = [[], [], []]
    for start,end,active in runs:
        for lane in active:
            spans = lanes[lane]
            if spans and start-spans[-1][1] <= minimum:
                spans[-1] = (spans[-1][0],end)
            else:
                spans.append((start,end))
    events = []
    for lane,spans in enumerate(lanes):
        for start,end in spans:
            if end-start>=minimum or start==left or end==right:
                events.extend([(start, lane, True),(end, lane, False)])
    active, previous = set(), left
    for point,lane,entering in sorted(events):
        if point>previous and active:
            yield previous,point,tuple(sorted(active))
        if entering:
            active.add(lane)
        else:
            active.discard(lane)
        previous = point


def _continuing_lanes(left, right, rate):
    """Link two local lanes only when their independent views agree in real time."""
    votes = {}
    for a,b,prior in left:
        if len(prior)!=1:
            continue
        for x,y,current in right:
            if len(current)!=1:
                continue
            overlap = min(b,y)-max(a,x)
            if overlap>0:
                key = (prior[0],current[0])
                votes[key] = votes.get(key,0)+overlap
    for (prior,current),duration in votes.items():
        competing = max((value for (p,c),value in votes.items()
                         if (p==prior)!=(c==current)),default=0)
        if duration >= .45*rate and duration-competing >= .30*rate:
            yield prior,current


def _acoustic_windows(audio, directory, segmentation, embedding, check, progress):
    import json
    import numpy as np
    import onnxruntime as ort
    import sherpa_onnx
    from audio_pipeline import SAMPLE_RATE, aligner_audio, _wav_frames
    from transcript import save_document

    options = ort.SessionOptions()
    options.inter_op_num_threads = 1
    options.intra_op_num_threads = 2
    session = ort.InferenceSession(str(segmentation), sess_options=options, providers=['CPUExecutionProvider'])
    metadata = session.get_modelmeta().custom_metadata_map
    if (metadata.get('model_type') != 'pyannote-segmentation-3.0' or
            int(metadata.get('num_classes', 0)) != 7 or int(metadata.get('sample_rate', 0)) != SAMPLE_RATE):
        raise ValueError('Unsupported pyannote segmentation export')
    window = int(metadata['window_size'])
    hop, receptive_field = int(metadata['receptive_field_shift']), int(metadata['receptive_field_size'])
    step = window * 4 // 5
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
        sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(embedding), num_threads=2))
    frames = _wav_frames(audio)
    # A block checkpoint contains only runs and embeddings. Each model input is
    # a ten-second tensor, including when the source runs for several hours.
    core_windows = range(0, frames, step)
    per_block = 24
    blocks = (len(core_windows) + per_block - 1) // per_block
    for block in range(blocks):
        check()
        progress(block+1, blocks)
        cache = directory / f'activity-{block:05d}.json'
        if cache.exists():
            yield json.loads(cache.read_text())['windows']
            continue
        rows = []
        for left in core_windows[block*per_block:(block+1)*per_block]:
            check()
            right = min(frames, left+step)
            origin = min(max(left - (window-step)//2, 0), max(0, frames - window))
            waveform = aligner_audio(audio, origin, min(frames, origin+window))
            model_input = np.pad(waveform, (0, window-len(waveform)))[None, None, :]
            scores, = session.run(None, {session.get_inputs()[0].name:model_input})
            full = list(_active_lanes(scores[0], origin, min(frames,origin+window), origin, hop, receptive_field))
            owned = [(max(a,left),min(b,right),active) for a,b,active in full if a<right and left<b]
            runs = list(_stable_activity(owned, left, right, SAMPLE_RATE))
            compact = {}
            for lane in {lane for _, _, active in runs for lane in active}:
                slices = [waveform[a-origin:b-origin] for a, b, active in runs if active == (lane,)]
                count = sum(len(value) for value in slices)
                vector = None
                if count >= .30 * SAMPLE_RATE:
                    stream = extractor.create_stream()
                    stream.accept_waveform(SAMPLE_RATE, np.concatenate(slices))
                    stream.input_finished()
                    if extractor.is_ready(stream):
                        vector = unit_vector(list(extractor.compute(stream)))
                compact[lane] = (count / SAMPLE_RATE, vector)
            rows.append({'runs':runs,'samples':compact,'view':full})
        check()
        save_document({'windows':rows}, cache)
        yield rows


def diarize_recording(audio, directory, segmentation, embedding, *, expected_speakers=None,
                      check=lambda: None, progress=lambda index, total: None):
    """Detect local activity, embed clean voice once, then cluster the recording."""
    import json
    from pathlib import Path
    from audio_pipeline import SAMPLE_RATE, _digest, _file_digest
    from transcript import save_document

    check()
    models = [Path(segmentation), Path(embedding)]
    identity = {'version':'recording-powerset-v3', 'models':[_file_digest(p) for p in models],
                'pcm_sha256':_file_digest(audio)}
    directory = Path(directory) / _digest(identity)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / ('groups-' + _digest({'expected':expected_speakers, 'grouping':2}) + '.json')
    if target.exists():
        progress(1, 1)
        return json.loads(target.read_text())['turns']
    samples, overlapping, continuity, runs = [], {}, {}, []
    previous = None
    for block in _acoustic_windows(audio, directory, *models, check, progress):
        for row in block:
            indices = {}
            for lane, evidence in row['samples'].items():
                indices[int(lane)] = len(samples)
                samples.append(evidence)
            if previous and 'view' in row:
                earlier_view, earlier_indices = previous
                for left,right in _continuing_lanes(earlier_view, row['view'], SAMPLE_RATE):
                    if left in earlier_indices and right in indices:
                        a,b = earlier_indices[left],indices[right]
                        continuity.setdefault(a,set()).add(b)
                        continuity.setdefault(b,set()).add(a)
            previous = row.get('view',[]),indices
            for start, end, lanes in row['runs']:
                indices_here = [indices[lane] for lane in lanes]
                runs.append((start, end, indices_here))
                for first in indices_here:
                    overlapping.setdefault(first, set()).update(second for second in indices_here if second != first)
    assignments = _global_clusters(samples, overlapping, expected_speakers, check, continuity)
    by_voice = {}
    # Preserve unresolved lane activity and its overlap with resolved tracks.
    for start, end, active in runs:
        for index in active:
            identity = assignments.get(index)
            speaker = identity or f'unresolved:{index}'
            spans = by_voice.setdefault(speaker, [])
            a, b = start / SAMPLE_RATE, end / SAMPLE_RATE
            if spans and spans[-1]['end'] == a:
                spans[-1]['end'] = b
            else:
                spans.append(dict(start=a, end=b, speaker=speaker, speaker_id=identity,
                    speaker_status='automatic_unreviewed' if identity else 'unresolved_acoustic'))
    turns = sorted((span for spans in by_voice.values() for span in spans), key=lambda turn: (turn['start'], turn['end']))
    check()
    save_document({'turns': turns}, target)
    return turns


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
