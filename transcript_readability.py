"""Offline punctuation and acoustic speaker labels, preserving every source cue.

Model files must be provisioned explicitly. This module never downloads anything.
Punctuation output is accepted only when every non-whitespace source character
survives unchanged and in order. It is not an LLM rewrite or factual correction.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import re
import sys
from pathlib import Path

PUNCTUATION = frozenset('，。？！、；：,.?!;:')
VERSION = 'local-reading-v1'


def project_punctuation(cues: list[dict], output: str) -> list[str]:
    """Map insertions back to their exact cue; retain source spelling/whitespace."""
    source = [(char, index, offset) for index, cue in enumerate(cues)
              for offset, char in enumerate(cue['text']) if not char.isspace()]
    inserts: dict[tuple[int, int], str] = {}
    cursor = 0
    for char in output:
        if char.isspace():
            continue
        if cursor < len(source) and char == source[cursor][0]:
            cursor += 1
        elif char in PUNCTUATION and cursor:
            _, index, offset = source[cursor - 1]
            # A model may append a Chinese comma after an existing ASCII comma.
            # Keep the source mark instead of displaying doubled punctuation.
            previous = inserts.get((index, offset), '')
            if source[cursor - 1][0] not in PUNCTUATION and not previous:
                inserts[index, offset] = char
        else:
            raise ValueError('Punctuation model changed source wording')
    if cursor != len(source):
        raise ValueError('Punctuation model omitted source wording')
    texts = []
    for index, cue in enumerate(cues):
        text = ''.join(char + inserts.get((index, offset), '')
                       for offset, char in enumerate(cue['text']))
        # ASR sometimes inserts spaces between Chinese phrases. Only remove
        # those typographic spaces; Latin word boundaries remain untouched.
        text = re.sub(r'(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])', '', text)
        text = re.sub(r'(?<=[，。？！、；：])\s+(?=[\u3400-\u9fff])', '', text)
        texts.append(text)
    return texts


def punctuation_chunks(cues: list[dict]):
    chunk, size = [], 0
    for cue in cues:
        if chunk and (size + len(cue['text']) > 600 or cue['start'] - chunk[0]['start'] > 90
                      or cue['start'] - chunk[-1]['end'] > 2
                      or cue.get('speaker') != chunk[-1].get('speaker')):
            yield chunk
            chunk, size = [], 0
        chunk.append(cue)
        size += len(cue['text'])
    if chunk:
        yield chunk


def punctuate(cues: list[dict], engine) -> tuple[int, int]:
    changed = rejected = 0
    def apply(chunk):
        nonlocal changed, rejected
        # Preserve already punctuated transcripts. Re-running does not add
        # another layer of punctuation or replace a manually corrected text.
        if sum(bool(re.search(r'[。！？.!?][”」』\"]?$', c['text'])) for c in chunk) >= max(1, len(chunk) * .8):
            return
        try:
            texts = project_punctuation(chunk, engine.add_punctuation(' '.join(c['text'] for c in chunk)))
        except ValueError:
            # Mixed-script context can make the model truncate an entire block.
            # Narrow context and revalidate instead of accepting missing words.
            if len(chunk) > 1:
                middle = len(chunk) // 2
                apply(chunk[:middle])
                apply(chunk[middle:])
            else:
                rejected += 1
            return
        for cue, text in zip(chunk, texts):
            if cue['text'] != text:
                cue.setdefault('original_text', cue['text'])
                cue['text'] = text
                changed += 1
    for chunk in punctuation_chunks(cues):
        apply(chunk)
    return changed, rejected


def assign_speakers(cues: list[dict], turns: list[dict]) -> int:
    """Label only a clear majority of a cue; ambiguous overlap stays unknown."""
    turns = sorted(turns, key=lambda item: item['start'])
    names = {}
    used_names = {cue.get('speaker') for cue in cues if cue.get('speaker')}
    next_name = 1
    changed = cursor = 0
    for cue in cues:
        if cue.get('speaker'):
            continue
        while cursor < len(turns) and turns[cursor]['end'] <= cue['start']:
            cursor += 1
        coverage = {}
        for turn in turns[cursor:]:
            if turn['start'] >= cue['end']:
                break
            overlap = max(0, min(cue['end'], turn['end']) - max(cue['start'], turn['start']))
            coverage[turn['speaker']] = coverage.get(turn['speaker'], 0) + overlap
        ranked = sorted(coverage.items(), key=lambda item: item[1], reverse=True)
        duration = cue['end'] - cue['start']
        if not ranked or duration <= 0 or ranked[0][1] / duration < .60:
            continue
        if len(ranked) > 1 and ranked[1][1] > ranked[0][1] * .5:
            continue
        identifier = ranked[0][0]
        if identifier not in names:
            while f'说话人 {next_name}' in used_names:
                next_name += 1
            names[identifier] = f'说话人 {next_name}'
            used_names.add(names[identifier])
            next_name += 1
        cue['speaker'] = names[identifier]
        changed += 1
    return changed


def stabilize_speaker_labels(cues: list[dict], eligible_ids: set[str]) -> tuple[int, bool]:
    """Suppress weakly supported automatic clusters, never rename manual labels.

    Short/background clusters are left unknown instead of being merged into a
    guessed person. This deliberately sacrifices coverage for readable labels.
    """
    durations = {}
    for cue in cues:
        if cue['id'] in eligible_ids and cue.get('speaker'):
            durations[cue['speaker']] = durations.get(cue['speaker'], 0) + cue['end'] - cue['start']
    minimum = max(1, sum(durations.values()) * .03)
    supported = {name for name, duration in durations.items() if duration >= minimum}
    fragmented = len(supported) > 12
    if fragmented:
        supported = set()
    manual = {cue.get('speaker') for cue in cues if cue['id'] not in eligible_ids and cue.get('speaker')}
    names, number, count = {}, 1, 0
    for cue in cues:
        if cue['id'] not in eligible_ids or not cue.get('speaker'):
            continue
        label = cue['speaker']
        if label not in supported:
            cue['speaker'] = cue.get('original_speaker')
            continue
        if label not in names:
            while f'说话人 {number}' in manual:
                number += 1
            names[label] = f'说话人 {number}'
            number += 1
        cue['speaker'] = names[label]
        count += 1
    return count, fragmented


def _model(path: str) -> Path:
    result = Path(path).expanduser().resolve(strict=True)
    if not result.is_file() or result.stat().st_size == 0:
        raise ValueError('Reading model file is missing')
    return result


def enhance_document(document: dict, audio: Path | None = None, *, punctuation: str = '',
                     segmentation: str = '', embedding: str = '') -> dict:
    """Return a copy; failures cannot leave a half-edited source document."""
    result = copy.deepcopy(document)
    provenance = result.setdefault('provenance', {})
    if not punctuation and not (segmentation and embedding and audio):
        return result
    import sherpa_onnx

    cues = result['segments']
    if segmentation and embedding and audio and provenance.get('speaker_method') != VERSION:
        from faster_whisper.audio import decode_audio
        segmentation_path, embedding_path = _model(segmentation), _model(embedding)
        config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(segmentation_path), window_shift_ratio=.5),
                num_threads=2),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(embedding_path), num_threads=2),
            clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=.8),
            min_duration_on=.3, min_duration_off=.5)
        if not config.validate():
            raise ValueError('Invalid local speaker models')
        engine = sherpa_onnx.OfflineSpeakerDiarization(config)
        samples = decode_audio(str(audio), sampling_rate=engine.sample_rate)
        print('[speakers] grouping voices locally', file=sys.stderr, flush=True)
        def progress(done, total):
            if done % 100 == 0 or done == total:
                print(f'[speakers] {done}/{total}', file=sys.stderr, flush=True)
            return 0
        turns = engine.process(samples, callback=progress).sort_by_start_time()
        eligible = {cue['id'] for cue in cues if not cue.get('speaker')}
        assign_speakers(cues, [{'start': t.start, 'end': t.end, 'speaker': t.speaker} for t in turns])
        count, fragmented = stabilize_speaker_labels(cues, eligible)
        provenance.update(speaker_method=VERSION, speaker_backend='sherpa-onnx',
                          speaker_model='pyannote-segmentation-3.0 + 3dspeaker-eres2net',
                          speaker_status='needs_review:fragmented_clusters' if fragmented else f'automatic_unreviewed:{count}/{len(cues)}')
    if punctuation and provenance.get('punctuation_method') != VERSION:
        model = _model(punctuation)
        config = sherpa_onnx.OfflinePunctuationConfig(model=sherpa_onnx.OfflinePunctuationModelConfig(
            ct_transformer=str(model), num_threads=2, provider='cpu'))
        if not config.validate():
            raise ValueError('Invalid local punctuation model')
        changed, rejected = punctuate(cues, sherpa_onnx.OfflinePunctuation(config))
        provenance.update(punctuation_method=VERSION, punctuation_backend='sherpa-onnx',
                          punctuation_model='ct-transformer-zh-en-int8',
                          punctuation_status=f'automatic_unreviewed:{changed};rejected_chunks:{rejected}')
    return result


def enhance_from_environment(document: dict, audio: Path | None = None) -> dict:
    return enhance_document(document, audio,
        punctuation=os.environ.get('COCONUT_PUNCTUATION_MODEL', ''),
        segmentation=os.environ.get('COCONUT_SPEAKER_SEGMENTATION_MODEL', ''),
        embedding=os.environ.get('COCONUT_SPEAKER_EMBEDDING_MODEL', ''))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('document', type=Path)
    parser.add_argument('--audio', type=Path)
    parser.add_argument('-o', '--output', type=Path, required=True)
    args = parser.parse_args()
    from transcript import save_document
    if args.document.resolve() == args.output.resolve():
        parser.error('Keep the source transcript; choose a separate output')
    original = json.loads(args.document.read_text())
    result = enhance_from_environment(original, args.audio)
    save_document(result, args.output)
    print(json.dumps(result.get('provenance'), ensure_ascii=False))


if __name__ == '__main__':
    main()
