# Saved AI answer freshness

## Behavior

Saved answers now retain a versioned `input_snapshot` of the exact ordered
`{id, text}` list sent in that successful request. Citation buttons are navigation,
not the complete set of evidence used by the model. Editing or removing any sent
cue, even an uncited one, shows a stale-evidence warning. Reordering sent cues also
invalidates the answer. Changes to unsent cues, notes, translations, timestamps,
current filters, and the visible reader page do not change this historical input.
No freshness check sends a request or bypasses the existing per-request consent.

JSON backup and reload preserve the complete input, including IDs no longer in
the document. Old answers' `source_snapshot` only contained cited cues, so those
answers remain readable with an explicit unknown-freshness warning; they are never
silently promoted to verified complete evidence. Malformed or unsupported snapshot
versions also remain unverified. This checks source correspondence, not answer
accuracy or factual correctness.

## Bounds and storage

The server already limits a request to 5,000 cues and 250,000 Unicode characters
for the complete serialized request. The snapshot validator allows at most 5,000
unique IDs, 400 UTF-16 code units per ID, and 500,000 combined ID/text code units
(the UTF-16 upper bound of a valid request). Only the existing latest 20 answers
are kept. No excluded source text, translation, or note is added to the snapshot.

This exact-text evidence can add up to roughly 10 million UTF-16 code units over
20 maximum-size requests, before JSON overhead; browser storage quotas can be
reached earlier. Existing save-failure warnings honestly say that the answer is
only in the current page and direct the reader to export a JSON backup. That
backup includes complete evidence. The change does not silently discard evidence
or answers to fit a quota. A compact digest representation could be a later storage
improvement, but would need compatible async verification and migration.

## Verification

- Original actual reader/Happy DOM reproduction: model reads three demo cues,
  cites only the first, then the second cue is corrected. The new regression fails
  on the previous implementation and passes after this change.
- Automated coverage includes no citations, uncited edits, source removal and
  same-ID changes through JSON, legacy and malformed evidence, ordered scope,
  103 sparse excerpt-selected cues beyond the first page, excluded edits, notes
  and translation-only changes, in-flight source edits, quota failure and backup.
- All verification uses local automated tests and mocked providers. No browser
  access, live subscription inference, paid API requests or credential use.
