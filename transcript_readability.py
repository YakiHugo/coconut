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
        # A manually corrected cue carries its own original-text history.
        # Isolate it rather than using model output to touch that correction.
        pending = []
        for cue in chunk:
            if 'original_text' in cue:
                if pending:
                    apply(pending)
                    pending = []
            else:
                pending.append(cue)
        if pending:
            apply(pending)
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
                     segmentation: str = '', embedding: str = '', work_dir: Path | None = None) -> dict:
    """Return a copy; failures cannot leave a half-edited source document."""
    result = copy.deepcopy(document)
    provenance = result.setdefault('provenance', {})
    if not punctuation and not (segmentation and embedding and audio):
        return result
    import sherpa_onnx

    cues = result['segments']
    if segmentation and embedding and audio and provenance.get('speaker_method') != 'recording-acoustic-v1':
        from audio_pipeline import CallableBackend, run_audio_pipeline
        from audio_speakers import SherpaSpeakerBackend, label_segments
        segmentation_path, embedding_path = _model(segmentation), _model(embedding)
        print('[speakers] grouping voices locally', file=sys.stderr, flush=True)
        grouped = run_audio_pipeline(audio,
            CallableBackend({'backend': 'speaker-only'}, lambda _: {'segments': []}),
            speaker_backend=SherpaSpeakerBackend(segmentation_path, embedding_path),
            local_only=True, work_dir=work_dir,
            expected_duration=document.get('media_duration'),
            minimum_duration=max((cue['end'] for cue in cues), default=0),
            progress=lambda index, total: print(f'[speakers] chunk {index + 1}/{total}', file=sys.stderr, flush=True))
        turns = grouped['speaker_turns']
        automatic = [cue for cue in cues if not cue.get('speaker')]
        decisions = {turn['speaker']: {'speaker_id': turn['speaker_id'],
                                      'status': turn['speaker_status']} for turn in turns}
        label_segments(automatic, turns, decisions)
        count = sum(bool(cue.get('speaker_id')) for cue in automatic)
        provenance.update(speaker_method='recording-acoustic-v1', speaker_backend='sherpa-onnx',
                          speaker_model='pyannote-segmentation-3.0 + 3dspeaker-eres2net',
                          speaker_status=f'automatic_unreviewed:{count}/{len(cues)}')
    if punctuation and provenance.get('punctuation_method') != VERSION:
        print('[punctuation] restoring punctuation locally', file=sys.stderr, flush=True)
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
    # The local job runner uses Python's isolated mode. Add only this trusted
    # source directory, never cwd or user-controlled PYTHONPATH.
    if sys.flags.isolated:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('document', type=Path, nargs='?')
    parser.add_argument('--audio', type=Path)
    parser.add_argument('-o', '--output', type=Path)
    parser.add_argument('--stdio', action='store_true', help='Punctuate a JSON document from stdin; never acquire audio')
    parser.add_argument('--punctuation-model', default='')
    parser.add_argument('--segmentation-model', default='')
    parser.add_argument('--embedding-model', default='')
    parser.add_argument('--work-dir', type=Path)
    args = parser.parse_args()
    if args.stdio:
        if args.document or args.output or args.audio or args.segmentation_model or args.embedding_model or args.work_dir or not args.punctuation_model:
            parser.error('stdio requires only --punctuation-model')
        payload = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
        if len(payload) > 8 * 1024 * 1024:
            parser.error('Transcript exceeds the input limit')
        result = enhance_document(json.loads(payload), punctuation=args.punctuation_model)
        print(json.dumps(result, ensure_ascii=False))
        return
    if not args.document or not args.output:
        parser.error('document and --output are required')
    from transcript import save_document
    if args.document.resolve() == args.output.resolve():
        parser.error('Keep the source transcript; choose a separate output')
    original = json.loads(args.document.read_text())
    explicit = bool(args.punctuation_model or args.segmentation_model or args.embedding_model)
    if bool(args.segmentation_model) != bool(args.embedding_model):
        parser.error('Both speaker model paths are required')
    result = (enhance_document(original, args.audio, punctuation=args.punctuation_model,
                              segmentation=args.segmentation_model, embedding=args.embedding_model,
                              work_dir=args.work_dir)
              if explicit else enhance_from_environment(original, args.audio))
    save_document(result, args.output)
    print(json.dumps(result.get('provenance'), ensure_ascii=False))


if __name__ == '__main__':
    main()
