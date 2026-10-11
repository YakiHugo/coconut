# Cooperative library selection

Large full-text/note/annotation searches now return from the input event before scanning. The shelf shows “正在查找…” and the number of documents checked; it hides old-query results and pagination until the complete result is known. Nothing is capped or discarded. Title-only browsing and small shelves retain the synchronous path.

Each scheduled slice checks up to 32 completed documents, 32 resumable engine units, or a 4 ms CPU budget, whichever comes first. Large documents now yield internally while collecting languages, validating cues, building spans, scanning notes/annotations, preparing KMP tables, scanning text, mapping Unicode expansion offsets, and assigning source highlights. Matching uses the same phrase engine and synchronous drain wrappers, preserving continuity, Unicode, notes and title semantics. Title/note matches prepare the same source-query cache before completion, preventing a burst of cold index builds for the 40 visible card previews.

Engine units yield every 128 cues/spans or 2,048 characters. They retain the full continuity run and KMP state across checkpoints, so a phrase can cross any number of checkpoints without truncating its exact source IDs. Only completed indexes and query results enter caches. Cancel, new queries and invalidated snapshots close abandoned iterators; document language, translation-context and glossary identities are also fenced. In-place source/translation mutations retain the existing requirement to call `invalidateSearch`, and annotation edits advance the save revision. No partial matches are presented as a result count; a partly scanned long document still counts as zero completed documents.

A single complete selection snapshot is reused for pagination and unchanged renders. Query/scope/kind/sort changes replace its generation. Save revisions, source invalidation, document identity/order/array changes, imports, removal and Undo invalidate it. Superseded callbacks cannot publish. Results are sorted only after every document has been checked; duration keys are calculated once and title comparison reuses a collator. No storage format or persistence path changes.

## Reproducible validation

- Deterministic injected-scheduler tests cover pending counts, A→B→clear, all late matches, cache reuse, source revision, note revisions, same-key replacement, removal/Undo identity, import, scope/kind/sort equivalence, and focus.
- Focused local checks: 33 tests passed across cooperative search, large library, library search and phrase index suites. No timing assertions are used.
- `tests/large-library-browser.mjs` adds actual-browser pending/cancellation/focus assertions and waits for complete selection before inspecting hits. Authored for CI; not executed locally.
- CPU profile: `flock /tmp/coconut-full-gates.lock node scripts/profile_cooperative_library.mjs`.
- Raw results: `docs/benchmarks/cooperative-library-profile.json`.

## Original between-document baseline (historical)

Node v24.19.0, authored fixtures, one run. This measures CPU selection work, not native browser input/audio latency, layout, IndexedDB, rendering, or timer-clamping wall time. The scheduler is drained deterministically. “Input” means the selection request return, separately from the maximum scheduled slice; total is cumulative CPU-side elapsed work.

| Documents × cues | State | Input ms | Total ms | Maximum slice ms |
| --- | --- | ---: | ---: | ---: |
| 5,000 × 8 | Cold indexes | 0.66 | 140.97 | 8.20 |
| 5,000 × 8 | Warm indexes, new query | 0.56 | 71.95 | 3.23 |
| 5,000 × 8 | Reused result | 0.15 | 0.15 | 0 |
| 150 × 2,000 | Cold indexes | 0.03 | 454.26 | 25.82 |
| 150 × 2,000 | Warm indexes, new query | 0.02 | 147.30 | 5.60 |
| 150 × 2,000 | Reused result | 0.01 | 0.01 | 0 |
| 1 × 50,000 | Cold index | 0.01 | 70.62 | 70.60 |
| 1 × 50,000 | Warm index, new query | 0.01 | 21.01 | 20.99 |
| 1 × 50,000 | Reused result | 0.01 | 0.01 | 0 |

Those original numbers measured the between-document implementation. The next-batch engine change is measured below; neither series is a hard frame-time guarantee.

## Within-document checkpoints: measured limits

Same authored fixtures and command, Node v24.19.0. Before tree: `1fab4d03d552b6ad28bbe5390987e7dbd4cbef83`. Raw before/after CPU measurements: `docs/benchmarks/long-document-search-profile.json`. These are single-run observations, not asserted speed ratios or input-latency measurements.

| Documents × cues | State | Before max slice ms | After max slice ms | Before total CPU ms | After total CPU ms |
| --- | --- | ---: | ---: | ---: | ---: |
| 5,000 × 8 | Cold | 10.72 | 7.43 | 221.47 | 208.87 |
| 5,000 × 8 | Warm index | 4.03 | 9.11 | 123.48 | 108.72 |
| 150 × 2,000 | Cold | 46.18 | 10.43 | 636.29 | 442.19 |
| 150 × 2,000 | Warm index | 5.50 | 1.29 | 152.00 | 174.20 |
| 1 × 50,000 | Cold | 141.10 | 11.06 | 141.12 | 77.02 |
| 1 × 50,000 | Warm index | 29.15 | 0.73 | 29.49 | 25.30 |

The long-document cold query now takes 109 scheduled slices and the warm-index query 70; reusing its completed result needs no scheduled slice. The added units trade some scheduler/timer overhead for opportunities to handle input or cancellation. CPU totals do not include real timer clamping, browser layout, audio, IndexedDB, or native rendering. An intermediate after-run had a 54.66 ms cold slice for 150 × 2,000 cues; allocation/GC and runtime variation can still dominate, and the raw observation is retained.

Whole-run string joins and locale lowercasing remain atomic to preserve contextual Unicode casing. Individual oversized cue/note processing, translation-validity dependency checks, query normalization/allocation and lazy exact-ID materialization remain atomic too. Identity validation scans the document list, and final sorting, duration-key calculation and rendering a bounded card page are unchanged. Thus 4 ms is a scheduling budget checked between resumable units, not a maximum blocking-time promise. This change does not virtualize reading results or change synchronous consumers into asynchronous APIs.

Deterministic `reader-long-document-search.test.mjs` coverage asserts actual mid-document yielding, unchanged source-read bounds, cold/warm cache use, no partial result publication, exact long/cross-checkpoint/Unicode phrase IDs and ranges, overlapping phrases, canceled iterators, query replacement/clear, mid-build and mid-query invalidation, document identity/array replacement, live notes and current source/context-backed translations. Existing phrase and UI suites continue exercising shared synchronous consumers. No timing assertions, model usage or local Chromium/Electron are involved.

## Saved quotation retrieval (next batch after 0.7.4)

Shelf title search is unchanged. Notes scope additionally searches nonempty
`exact_excerpt_notes`; full-text scope additionally searches `record.text` and
those personal notes. Captured surrounding context, former titles/URLs and
correction history do not enter shelf matching. Historical evidence remains
separate from the live-transcript phrase engine and AI evidence scopes.

`librarySavedHits(doc, query, scope = 'title', limit = 3)` returns
`{hits, total}`. `total` counts **every** matching exact record, including
identical text captured under distinct identities. `hits` contains at most
three previews (or a smaller requested limit). Empty queries and title scope
return an empty group. Quote/note matches are independent; one record matching
both contributes once, with `matchFields: 'quote' | 'note' | 'both'` and separate
`quoteSnippet`/`noteSnippet` values. These are plain source text, never HTML.

A typed hit has `kind: 'exact-excerpt'`, `captureKey` and its equivalent `key`
(`JSON.stringify([documentKey, 'exact-excerpt', id])`), `documentKey`, record
`id`, observed `text` and `note`, and the snippet/match fields above. None of
these identities are cue navigation IDs. `libraryHits` continues to return only
the existing current-source previews, so its three slots are not displaced.
Continuation into the notebook searches and pages the complete record set;
preview limits never limit retrievable matches.

Completed `createLibrarySearch` selections expose `savedHits`, a Map keyed by
the actual matched document object whose values have the same `{hits, total}`
shape. Pending selections expose an empty map. Matching and preview preparation
happen inside the cooperative job, not during card rendering. The completed map
is reused on unchanged renders and pagination. Cancel/replacement closes the
iterator and discards its unpublished map. Exact-record counts are included in
work admission; more than 65,536 searchable saved-field characters also enter
the scheduler, even for a single giant note with no live cues.

The small `passages.searchSnippetSteps` helper shares the existing KMP,
locale-fold expansion mapping and bounded `rangeSnippet` machinery. It yields
every 2,048 matching/mapping characters and stops at the first occurrence in
each independent field; subsequent records beyond the preview slots skip
snippet construction while retaining complete matching/counts. Long queries
retain KMP state across checkpoints. No saved data is truncated or joined across
fields. Core resolves the passage helper lazily; CommonJS and the existing
classic-script order (summary, core, passages, app) both work without a cycle.

`search.isCurrent(job)` fences generation, content/search revisions, document
ownership/order, exact-record array identity/length and note-sidecar identity.
`librarySavedHitCurrent(hit, documents)` additionally checks current document
and actual record membership, the owned array/map, record ID/text and observed
note. UI activation must check both plus its `pendingStructuralDocuments` fence.
Same-key replacement is not the same owner. Record/sidecar mutators must keep
copy-on-write collections; any in-place mutation must advance content revision
before a new search. Final-click checks also reject in-place record replacement
or changed note values. Replacing/removing a document, import and Undo rebuild
identity-owned results; deleting live cues does not delete historical evidence.

### Measured large-field limits

Reproduce with `flock /tmp/coconut-full-gates.lock node
docs/benchmarks/profile-saved-library-search.mjs`. The retained
`docs/benchmarks/saved-library-search-profile.json` contains single-run Node
v24.19.0 authored CPU observations, not browser/native latency or speed promises.

| Input | Scheduled slices | Maximum slice ms | Total CPU ms | Saved count / previews |
| --- | ---: | ---: | ---: | ---: |
| 2M-character quotation, late match | 31 | 4.15 | 19.50 | 1 / 1 |
| 2M-character personal note, late match | 31 | 2.20 | 14.85 | 1 / 1 |
| 2M-character note with Unicode expansion | 62 | 5.78 | 66.47 | 1 / 1 |
| 2M-character whitespace-only note | 1 | 2.58 | 2.62 | 0 / 0 |
| 5,000 historical records, zero live cues | 2 | 3.10 | 3.99 | 5,000 / 3 |

Whole-string locale lowercasing/allocation remains atomic to retain contextual
Unicode casing. Isolated lowercasing of the Unicode-expansion fixture took
8.61 ms in this run. Query normalization, `hasNoteContent` whitespace testing,
collection admission/identity checks, sorting and existing current-source note
preview work are also atomic. The measured whitespace-only scan was 2.58 ms;
there is no hard 4 ms bound. GC/runtime variation and larger inputs may exceed
the target budget. This change adds resumable saved-field matching and mapping,
not a new general-purpose Unicode engine or a storage index.

Focused validation: 78 tests passed across `reader-saved-library-search`,
`reader-exact-excerpts`, `reader-library-search`, `reader-cooperative-search`,
`reader-long-document-search`, `reader-library-notebook` and
`reader-cooperative-notebook`. No full aggregate, browser, Electron, provider or
native desktop execution was performed for this core-only stage. UI integration
and final asset hashes/aggregate gates belong to the combined final candidate.
