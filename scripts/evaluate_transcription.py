#!/usr/bin/env python3
"""Compare local transcription runs from a supplied, fixed corpus manifest."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from hashlib import sha256
import json
from pathlib import Path
import re

TERMINAL = re.compile(r'[.!?。！？…][”’」』）)\s]*$')
LETTER_OR_NUMBER = r"[^\W_\u3400-\u9fff]"
TOKEN = re.compile(rf"[\u3400-\u9fff]|{LETTER_OR_NUMBER}+(?:['’]{LETTER_OR_NUMBER}+)*")


def load(path):
    return json.loads(path.read_text())


def tokens(value):
    return TOKEN.findall(value.casefold())



def occupied_seconds(cues):
    end = 0.
    total = 0.
    for cue in cues:
        total += max(0., cue['end'] - max(end, cue['start']))
        end = max(end, cue['end'])
    return total

def owner(cues, target):
    seconds = Counter()
    for cue in cues:
        if cue['end'] <= target['start']:
            continue
        if cue['start'] >= target['end']:
            break
        seconds[cue.get('speaker_id')] += min(cue['end'], target['end'])-max(cue['start'], target['start'])
    if not seconds:
        return None
    identity, overlap = seconds.most_common(1)[0]
    return identity if overlap >= .5 * (target['end']-target['start']) else None


def check_reference(cues, reference):
    """Speaker labels use a disjoint calibration split supplied with the corpus."""
    observations = [(target, owner(cues, target)) for target in reference.get('speaker_samples', ())]
    votes = defaultdict(Counter)
    for row, identity in observations:
        if row.get('split') == 'calibration' and identity:
            votes[identity][row['speaker']] += 1
    mapping = {}
    for identity, counts in votes.items():
        candidate, count = counts.most_common(1)[0]
        if count > sum(counts.values())/2:
            mapping[identity] = candidate
    statuses = Counter()
    for row, identity in observations:
        if row.get('split') != 'check':
            continue
        verdict = 'unassigned' if not identity else 'unmapped' if identity not in mapping else (
            'correct' if mapping[identity] == row['speaker'] else 'incorrect')
        statuses[verdict] += 1

    edits = Counter()
    for span in reference.get('text_samples', ()):
        expected = tokens(span['text'])
        pieces = []
        for cue in cues:
            if cue['start'] >= span['end']:
                break
            if cue['end'] <= span['start']:
                continue
            if cue.get('words'):
                pieces.extend(word['word'] for word in cue['words']
                              if span['start'] <= (word['start']+word['end'])/2 < span['end'])
            elif span['start'] <= (cue['start']+cue['end'])/2 < span['end']:
                pieces.append(cue['text'])
        actual = tokens(''.join(pieces))
        edits['reference_tokens'] += len(expected)
        for op, left, right, begin, end in SequenceMatcher(None,expected,actual,autojunk=False).get_opcodes():
            if op == 'delete':
                edits['omitted_tokens'] += right-left
            elif op == 'insert':
                edits['inserted_tokens'] += end-begin
            elif op == 'replace':
                edits['substituted_tokens'] += min(right-left,end-begin)
                edits['omitted_tokens'] += max(0,(right-left)-(end-begin))
                edits['inserted_tokens'] += max(0,(end-begin)-(right-left))

    score = statuses['correct']+statuses['incorrect']
    return {'speaker_samples':dict(statuses), 'speaker_error_rate':statuses['incorrect']/score if score else None,
            'reference_token_edits':dict(edits) if edits else None, 'source':reference.get('source')}


def measure(root, episode, manifest):
    result = root if root.is_file() else root / episode['id'] / 'result.json'
    if not result.exists():
        return {'status':'missing_result'}
    document = load(result)
    cues = document['segments']
    seams = [(left, right) for left,right in zip(cues,cues[1:])
             if isinstance(left.get('chunk_index'),int) and right.get('chunk_index')!=left['chunk_index']]
    unassigned = [cue for cue in cues if not cue.get('speaker_id')]
    cue_seconds = occupied_seconds(cues)
    speaker_seconds = occupied_seconds(cue for cue in cues if cue.get('speaker_id'))
    text_identity = sha256(''.join(cue['text'] for cue in cues).encode()).hexdigest()
    metrics = {'status':'complete','cues':len(cues),'unassigned':len(unassigned),
               'speaker_coverage':1-len(unassigned)/len(cues) if cues else None,
               'speaker_time_coverage':speaker_seconds/cue_seconds if cue_seconds else None,
               'text_sha256':text_identity,
               'speaker_groups':len({cue['speaker_id'] for cue in cues if cue.get('speaker_id')}),
               'unassigned_10s':sum(cue['end']-cue['start']>=10 for cue in unassigned),
               'unassigned_over_50_chars':sum(len(cue['text'].strip())>50 for cue in unassigned),
               'nonterminal_chunk_transitions':sum(not TERMINAL.search(a['text']) for a,_ in seams),
               'chunk_transitions':len(seams),'clock_needs_review':sum(c.get('alignment_status')=='needs_review' for c in cues),
               'word_partial':sum(c.get('timing_basis')=='word_partial' for c in cues),
               'cues_with_word_clocks':sum(bool(c.get('words')) for c in cues),
               'cues_with_complete_word_clocks':sum(c.get('alignment_status')=='complete' and c.get('timing_basis')=='word' for c in cues),
               'zero_duration_words':sum(w['end']==w['start'] for c in cues for w in c.get('words') or ())}
    provenance = document.get('provenance', {})
    metrics.update(chunking=provenance.get('chunking'), asr=provenance.get('asr_metrics'))
    timing = result.with_name('run-metrics.json')
    metrics['runtime'] = load(timing) if result.name=='result.json' and timing.is_file() else None
    metrics['reference'] = check_reference(cues,load(manifest.parent/episode['reference'])) if episode.get('reference') else None
    return metrics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', type=Path, required=True, help='JSON list of cases with id and optional reference file')
    parser.add_argument('--run', action='append', required=True, metavar='LABEL=PATH',
                        help='Run directory or, for a one-case corpus, a transcript JSON file')
    args = parser.parse_args()
    manifest = args.corpus.resolve()
    corpus = load(manifest)
    if not isinstance(corpus,list) or not corpus:
        parser.error('The corpus must be a nonempty list')
    names = [entry['id'] for entry in corpus]
    if len(set(names)) != len(names) or any(not re.fullmatch(r'[\w.-]+',name) or name in ('.','..') for name in names):
        parser.error('Duplicate or invalid case ID')
    data = {}
    for argument in args.run:
        label,sep,location = argument.partition('=')
        if not sep or not label or not location or label in data:
            parser.error('Each run needs a unique LABEL=PATH')
        root = Path(location)
        if root.is_file() and len(corpus) != 1:
            parser.error('A transcript JSON file requires a one-case corpus')
        data[label] = {entry['id']:measure(root,entry,manifest) for entry in corpus}
    print(json.dumps(data,ensure_ascii=False,indent=2))


if __name__ == '__main__':
    main()
