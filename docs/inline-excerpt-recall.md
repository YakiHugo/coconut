# Recall saved quotations while reading

When a passage or source cue contains saved exact selections, **摘录 N** opens
those quotations beside the reading journey. Continuous reading and transcript
rows use the same immutable records as the library notebook. Overlapping or
cross-cue captures appear once in each relevant paragraph; a transcript row only
shows captures whose selected original actually includes that cue. Whole-cue
stars and cue notes keep their separate behavior.

The dialog shows up to eight records at a time, short original/paired-translation
previews, source-history status and personal notes. **查看完整摘录与来源** explicitly
expands the selected original and, for v2 records, the saved translation,
provenance and user-confirmed pairing information. Long text is expanded in
4,000-code-unit increments without splitting surrogate pairs. The existing
personal-note editor handles drafts, conflict checks, persistence retry and
exports. An unsaved quotation or note is labeled as such; merely seeing an
entry does not claim it has reached local storage.

**返回阅读** restores focus to the opening control with no page, filter, bookmark,
selection, player or reading-mode change. Nested personal-note editing returns
to the same record. If the opening control was rebuilt, a surviving original
cue provides a same-document fallback. A newer document never receives stale
return focus. Save receipts update control/status text, not source DOM or media. The recall
and personal-note dialogs explicitly contain first/last Tab navigation, skip
collapsed evidence, and leave interior keyboard movement native.

## Historical fidelity

No character ranges are painted over the live source. The lightweight entry
indicates an association with a capture, not a claim that the whole paragraph
was saved. Source freshness uses the existing batch comparison of captured
source metadata, context cues, adjacency, original text and v2 translation
provenance. Changed source is explicitly labeled **历史关联**. Missing or reordered
context has no inline anchor; its record remains in the library notebook.

While the page is open, observed cue object replacements are also historical,
even if the new cue happens to reuse an ID and equal text. A restored JSON
backup establishes ownership afresh and may be current when its full saved
source agrees. Reinstating the original live cue restores that original
ownership. These references are transient and add no schema, persisted anchor,
model call, network request or quota use.

Freshness is rebuilt in one batch per synchronous render or exact-record
addition/removal. Each mounted row looks up only its relevant cue IDs. Save
receipts and note typing do not rescan document content or replace expanded
record details. The dialog retains its explicitly opened record set; later
removal or replacement disables editing that old snapshot.

## Verification boundary

`tests/reader-inline-excerpts.test.mjs` exercises exact/bilingual snapshots,
history, restored data, missing and replaced cues, overlap, bounded pages,
progressive expansion, save errors, note ownership, source/player identity,
search and long-document continuity in Happy DOM. The existing CI browser
workflow runs `tests/inline-excerpts-browser.mjs` at desktop and 390px using
authored data and real IndexedDB. Screenshots and `inline-excerpts-checks.json`
are retained in its authored UI artifact. Local DOM checks or syntax checks
alone do not establish native-browser geometry, media or model quality.
