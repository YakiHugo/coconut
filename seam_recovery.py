"""Conservative recovery of words independently cropped by both sides of a seam.

This does not correct ASR. Both source hypotheses and their clocks remain intact.
Repeated/short/ambiguous matches abstain rather than assigning shared ownership.
"""
import copy
import difflib
import re

VERSION = 'seam-consensus-v1'
MAX_DRIFT = .75
MAX_SEAM_DISTANCE = 1.0


def _token(text):
    return re.sub(r'[\W_]+', '', text).casefold()


def _words(result, chunk, begin, end):
    words = []
    for segment_index, segment in enumerate(result['segments']):
        for word_index, word in enumerate(segment.get('words', [])):
            start, stop = word['start'] + chunk.start, word['end'] + chunk.start
            if start < begin or stop > end or not _token(word['word']):
                continue
            middle = (start + stop) / 2
            words.append(dict(word=word['word'], token=_token(word['word']), start=start, end=stop,
                middle=middle, owned=chunk.core_start_frame / 16000 <= middle < chunk.core_end_frame / 16000,
                chunk_index=chunk.index, segment_index=segment_index, word_index=word_index))
    return words


def recover_seam(left_result, left, right_result, right):
    """Return isolated, speaker-unknown cues and an auditable evidence list.

    Requires exact tokenization and a unique >=3-token, >=4-character anchor,
    bounded alignment drift, and a unique target token in both overlap windows.
    The target must be outside BOTH cores. No one-sided words are invented.
    """
    if left.index + 1 != right.index or left.core_end_frame != right.core_start_frame:
        return [], []
    begin, end = max(left.start, right.start), min(left.end_frame, right.end_frame) / 16000
    seam = left.core_end_frame / 16000
    if begin >= end:
        return [], []
    for result, chunk in ((left_result, left), (right_result, right)):
        if any(not segment.get('words') and segment.get('text', '').strip()
               and segment['start'] + chunk.start < end and segment['end'] + chunk.start > begin
               for segment in result['segments']):
            return [], []
    a, b = _words(left_result, left, begin, end), _words(right_result, right, begin, end)
    at, bt = [w['token'] for w in a], [w['token'] for w in b]
    cues, evidence = [], []
    def coherent_blocks():
        # An unrelated, poorly aligned response later in the overlap must not
        # invalidate a local anchor, nor become part of that anchor.
        for match in difflib.SequenceMatcher(None, at, bt, autojunk=False).get_matching_blocks():
            start = None
            prior = None
            for offset in range(match.size + 1):
                pair = (a[match.a+offset], b[match.b+offset]) if offset < match.size else None
                valid = pair is not None and abs(pair[0]['middle']-pair[1]['middle']) <= MAX_DRIFT
                same_segment = prior is None or pair is not None and all(x['segment_index'] == y['segment_index'] for x, y in zip(prior, pair))
                if start is not None and (not valid or not same_segment):
                    yield difflib.Match(match.a+start, match.b+start, offset-start)
                    start = None
                if valid and start is None:
                    start = offset
                prior = pair if valid else None
    for block in coherent_blocks():
        pattern = at[block.a:block.a + block.size]
        if block.size < 3 or len(''.join(pattern)) < 4 or len(set(pattern)) < 3:
            continue
        def occurrences(tokens):
            return sum(tokens[i:i + len(pattern)] == pattern for i in range(len(tokens)-len(pattern)+1))
        if occurrences(at) != 1 or occurrences(bt) != 1:
            continue
        pairs = list(zip(a[block.a:block.a+block.size], b[block.b:block.b+block.size]))
        for offset, (x, y) in enumerate(pairs):
            if x['owned'] or y['owned'] or at.count(x['token']) != 1 or bt.count(y['token']) != 1:
                continue
            if not (x['middle'] >= seam > y['middle']) or max(abs(x['middle']-seam), abs(y['middle']-seam)) > MAX_SEAM_DISTANCE:
                continue
            # Existing, owned context determines ordering; never move its clocks.
            before = [w['end'] for words, index in ((a, block.a+offset), (b, block.b+offset)) for w in words[:index] if w['owned']]
            after = [w['start'] for words, index in ((a, block.a+offset), (b, block.b+offset)) for w in words[index+1:] if w['owned']]
            low, high = max(before, default=begin), min(after, default=end)
            if cues:
                low = max(low, cues[-1]['end'])
            choices = [w for w in (x, y) if low <= w['start'] <= w['end'] <= high]
            if not choices:
                continue
            chosen = min(choices, key=lambda w: (abs(w['middle']-seam), w['chunk_index']))
            text = chosen['word'].strip()
            word = dict(word=text, start=chosen['start'], end=chosen['end'], text_start=0, text_end=len(text))
            cues.append(dict(text=text, start=word['start'], end=word['end'], words=[word],
                chunk_index=chosen['chunk_index'], speaker=None, speaker_id=None,
                speaker_status='seam_recovered_unknown', boundary_status=VERSION,
                alignment_status='consensus_clock_unverified', timing_basis='word'))
            evidence.append(dict(version=VERSION, seam=seam, anchor=pattern,
                sources=[copy.deepcopy(x), copy.deepcopy(y)], selected_chunk=chosen['chunk_index'],
                decision='both_cropped_unique_consensus', timing_status='unverified'))
    return cues, evidence
