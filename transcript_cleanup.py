"""Conservative, offline reading edits. Source text and clocks are never changed.

The policy detects only local filled pauses and mechanical restarts. Ambiguous
discourse words, responses, emphasis and quoted vocabulary remain in the source.
Model suggestions are evidence, not authority to rewrite the transcript.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

POLICY_VERSION = 'conservative-reading-v2'
COMMAS = '，,、'
MARKS = '，,。.!！？?；;：:'
FILLERS = re.compile(r'[嗯呃]+(?:[，,\s]*[嗯呃]+)*')
RESTARTS = re.compile(r'(我|你|他|她|它|这|那|就|在|是|比|都|从|但)\1+')
PHRASES = re.compile(r'(所以|然后|就是|但是|因为|比如|我们|这个|那个|我觉得|我就|他说|其实)(?:[，,\s]*\1)+')
QUOTES = re.compile(r'“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|‘[^’]*’')
LEXICAL_PARTICLES = re.compile(r'嗯[哼呐哪哈]|呃逆|是是非非')
LEXICAL = re.compile(r'[\w\u3400-\u9fff]', re.UNICODE)


def utf16_offset(text, offset):
    return len(text[:offset].encode('utf-16-le')) // 2


def _speaker(cue):
    # Unknown voices are never inferred to be one person merely by adjacency.
    return cue.get('speaker_id') or cue.get('speaker') or None


def decisions(document):
    cues = document['segments']
    edits, issues, protected = [], [], []
    for index, cue in enumerate(cues):
        text = cue['text']
        quotes = [(m.start(), m.end()) for m in QUOTES.finditer(text)]
        compounds = [(m.start(), m.end()) for m in LEXICAL_PARTICLES.finditer(text)]
        lexical_length = len(LEXICAL.findall(text))
        hides = []

        def is_quoted(a, b):
            return any(a < right and b > left for left, right in quotes)

        def protect(a, b, reason):
            protected.append({'cue_id': cue['id'], 'from': utf16_offset(text, a),
                              'to': utf16_offset(text, b), 'text': text[a:b], 'reason': reason})

        def hide(a, b, reason):
            if a >= b:
                return
            hides.append((a, b, reason))

        for match in FILLERS.finditer(text):
            a, b = match.span()
            if any(a < right and b > left for left, right in compounds):
                protect(a, b, 'lexical_particle_or_backchannel')
                continue
            if is_quoted(a, b):
                protect(a, b, 'quoted_expression')
                continue
            cluster = re.sub(r'[，,\s]', '', match.group())
            # A short utterance can be an answer, objection or acknowledgement.
            # Text alone cannot reliably tell which one, even with an aligner.
            if lexical_length <= 5 or re.match(r'\s*[？?!！]', text[b:]):
                protect(a, b, 'short_response_or_exclamation')
                continue
            starts_turn = a == 0 and (index == 0 or not _speaker(cue)
                or _speaker(cues[index - 1]) != _speaker(cue)
                or cue['start'] - cues[index - 1]['end'] > 2)
            if starts_turn and cluster.startswith('嗯'):
                # Keep the first acknowledgement at a turn boundary. Any later
                # hesitation is separately eligible, including an adjacent 呃.
                protect(a, a + 1, 'turn_initial_acknowledgement')
                a += 1
                while a < b and text[a] in '，, \t':
                    a += 1
                if a == b:
                    continue
            # Keep one existing separator. Do not manufacture a sentence mark.
            # At a sentence ending, the terminal mark belongs to the retained text.
            left = text[a - 1] if a else ''
            right = text[b] if b < len(text) else ''
            if right and right in MARKS and left and left in COMMAS:
                a -= 1
            elif right and right in COMMAS and (a == 0 or left in MARKS):
                b += 1
            elif b == len(text) and left and left in COMMAS:
                a -= 1
            hide(a, b, 'filled_pause')

        for pattern in (RESTARTS, PHRASES):
            for match in pattern.finditer(text):
                a, b = match.span()
                if is_quoted(a, b) or lexical_length <= 5 or any(a < right and b > left for left, right in compounds):
                    protect(a, b, 'quoted_or_short_repetition')
                    continue
                # Preserve the final occurrence with its original timing. This
                # is a literal restart mask, not a replacement or word reorder.
                token = match.group(1)
                keep = b - len(token)
                hide(a, keep, 'immediate_restart')

        # Merge overlapping rule spans; decisions submitted to the renderer must
        # form a non-overlapping source mask, including punctuation clean-up.
        merged = []
        for a, b, reason in sorted(hides):
            if merged and a <= merged[-1][1]:
                old_a, old_b, old_reason = merged[-1]
                merged[-1] = (old_a, max(old_b, b), old_reason if old_reason == reason else 'local_disfluency')
            else:
                merged.append((a, b, reason))
        for a, b, reason in merged:
            edits.append({'cue_id': cue['id'], 'from': utf16_offset(text, a),
                          'to': utf16_offset(text, b), 'action': 'hide', 'reason': reason})
    return {'version': 1, 'policyVersion': POLICY_VERSION, 'decisions': edits,
            'issues': issues, 'protected': protected, 'llm_calls': 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('-o', '--output', type=Path, required=True)
    args = parser.parse_args()
    if args.input.resolve() == args.output.resolve():
        parser.error('Output must be a new reading plan, not the source document')
    source = args.input.read_bytes()
    result = decisions(json.loads(source))
    result['input_sha256'] = hashlib.sha256(source).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'output': str(args.output), 'decisions': len(result['decisions']),
                      'protected': len(result['protected']), 'llm_calls': 0}))


if __name__ == '__main__':
    main()
