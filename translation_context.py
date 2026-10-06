"""Dependency-free, bounded context and review checks for transcript translation.

These checks detect suspicious surface changes, not semantic correctness. No model,
network access, or fabricated word alignment is used here.
"""
from __future__ import annotations
from collections import Counter
import hashlib
import json
import math
import re
import unicodedata

QUALITY_CODES = {'numbers_changed', 'glossary_missing', 'unchanged_translation',
                 'repeated_phrase', 'length_outlier', 'reading_speed'}


def term_present(text, term):
    # ASCII word edges avoid matching "AI" in "chair"; CJK terms may be substrings.
    edge_start = r'(?<![A-Za-z0-9_])' if re.match(r'[A-Za-z0-9_]', term) else ''
    edge_end = r'(?![A-Za-z0-9_])' if re.search(r'[A-Za-z0-9_]$', term) else ''
    return re.search(edge_start + re.escape(term) + edge_end, text, re.IGNORECASE) is not None


def validate_glossary(value):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 100:
        raise ValueError('Glossary must contain at most 100 terms')
    result = []
    seen = set()
    for entry in value:
        if not isinstance(entry, dict) or any(not isinstance(entry.get(k), str) or
                not 1 <= len(entry[k].strip()) <= 120 or re.search(r'[\x00-\x1f\x7f]', entry[k])
                for k in ('source', 'target')):
            raise ValueError('Glossary terms must be 1–120 characters without control characters')
        source, target = entry['source'].strip(), entry['target'].strip()
        if source.lower() in seen:
            raise ValueError('Glossary source terms must be unique')
        seen.add(source.lower())
        result.append({'source': source, 'target': target})
    if sum(len(e['source']) + len(e['target']) for e in result) > 8000:
        raise ValueError('Glossary exceeds the 8000-character limit')
    return result


def semantic_units(cues):
    """Conservative hints for reading fragments together, never new source cues."""
    units, current, chars = [], [], 0
    for cue in cues:
        previous = current[-1] if current else None
        boundary = previous and (
            ('position' not in cue or 'position' not in previous or cue['position'] != previous['position'] + 1) or
            cue.get('speaker') != previous.get('speaker') or
            cue.get('start', 0) - previous.get('end', 0) > 2 or
            len(current) >= 8 or chars + len(cue['text']) > 1800 or
            bool(re.search(r'[.!?。！？][\s\"\'”’）)]*$', previous['text']))
        )
        if boundary:
            units.append({'ids': [c['id'] for c in current]})
            current, chars = [], 0
        current.append(cue)
        chars += len(cue['text'])
    if current:
        units.append({'ids': [c['id'] for c in current]})
    return units


def prepare_context(segments, context=None, glossary=None, memory=None):
    from language_tools import validate_segments
    validate_segments(segments)
    cues = [{'id': s['id'], 'text': s['text']} for s in segments]
    if context is not None:
        if not isinstance(context, list):
            raise ValueError('Context must be a list of selected source cues')
        combined = segments + context
        validate_segments(combined, maximum=36)
        positions = set()
        for cue in combined:
            position, start, end = cue.get('position'), cue.get('start'), cue.get('end')
            if isinstance(position, bool) or not isinstance(position, int) or not 0 <= position <= 99999 or position in positions:
                raise ValueError('Context positions must be unique original document indices')
            if any(isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t) for t in (start, end)) or start < 0 or end < start:
                raise ValueError('Context timestamps are invalid')
            speaker = cue.get('speaker')
            if speaker is not None and (not isinstance(speaker, str) or len(speaker) > 120):
                raise ValueError('Speaker labels must contain at most 120 characters')
            positions.add(position)
        if [s['position'] for s in segments] != sorted(s['position'] for s in segments):
            raise ValueError('Targets must follow original document order')
        cues = sorted(({**{k: c[k] for k in ('id', 'text', 'position', 'start', 'end')},
                        **({'speaker': c.get('speaker')} if 'speaker' in c else {})}
                       for c in combined), key=lambda c: c['position'])
        if any(b['start'] < a['start'] for a, b in zip(cues, cues[1:])):
            raise ValueError('Context timestamps must follow document order')
    terms = validate_glossary(glossary)
    # Never forward an unrelated term merely because it is in the project glossary.
    terms = [t for t in terms if any(term_present(c['text'], t['source']) for c in cues)]
    if memory is None:
        memory = []
    if not isinstance(memory, list) or len(memory) > 36:
        raise ValueError('Translation memory must contain at most 36 selected context cues')
    targets = {s['id'] for s in segments}
    context_by_id = {c['id']: c for c in cues if c['id'] not in targets}
    seen, examples = set(), []
    for entry in memory:
        if not isinstance(entry, dict) or not isinstance(entry.get('id'), str) or entry['id'] in seen:
            raise ValueError('Translation memory IDs must be unique selected context cues')
        cue = context_by_id.get(entry['id'])
        if cue is None or entry.get('source_text') != cue['text'] or not isinstance(entry.get('text'), str) or not 1 <= len(entry['text'].strip()) <= 12000:
            raise ValueError('Translation memory must match a context-only source cue')
        seen.add(entry['id'])
        examples.append({k: entry[k] for k in ('id', 'source_text', 'text')})
    if sum(len(e['text']) for e in examples) > 24000:
        raise ValueError('Translation memory exceeds the 24000-character limit')
    return cues, terms, examples


def input_revision(payload):
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode()).hexdigest()


def quality_warnings(source, translated, target, glossary=()):
    warnings = []
    def numbers(text):
        text = unicodedata.normalize('NFKC', text)
        # This deliberately flags localized/spelled-out numbers for human review.
        return Counter(re.findall(r'[+-]?\d+(?:[.,]\d+)*%?', text))
    if numbers(source['text']) != numbers(translated):
        warnings.append('numbers_changed')
    if any(term_present(source['text'], e['source']) and not term_present(translated, e['target']) for e in glossary):
        warnings.append('glossary_missing')
    if len(source['text']) >= 30 and source['text'].strip().casefold() == translated.strip().casefold():
        warnings.append('unchanged_translation')
    if re.search(r'(.{2,40}?)(?:\s*\1){3,}', translated):
        warnings.append('repeated_phrase')
    if len(translated) > max(80, len(source['text']) * 5) or (len(source['text']) >= 100 and len(translated) < len(source['text']) * .12):
        warnings.append('length_outlier')
    duration = source.get('end', 0) - source.get('start', 0)
    if duration > 0 and len(re.sub(r'\s', '', translated)) / duration > (9 if target in {'zh', 'ja', 'ko'} else 20):
        warnings.append('reading_speed')
    return warnings
