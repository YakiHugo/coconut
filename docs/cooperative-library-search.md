# Cooperative library selection

Large full-text/note/annotation searches now return from the input event before scanning. The shelf shows “正在查找…” and the number of documents checked; it hides old-query results and pagination until the complete result is known. Nothing is capped or discarded. Title-only browsing and small shelves retain the synchronous path.

Each scheduled slice checks up to 32 documents or a 4 ms CPU budget, whichever comes first. A document remains atomic. Matching still uses the existing source phrase engine, including its continuity, Unicode, notes and title semantics. Title/note matches prepare the same source-query cache in their scheduled slice, preventing a burst of cold index builds for the 40 visible card previews.

A single complete selection snapshot is reused for pagination and unchanged renders. Query/scope/kind/sort changes replace its generation. Save revisions, source invalidation, document identity/order/array changes, imports, removal and Undo invalidate it. Superseded callbacks cannot publish. Results are sorted only after every document has been checked; duration keys are calculated once and title comparison reuses a collator. No storage format or persistence path changes.

## Reproducible validation

- Deterministic injected-scheduler tests cover pending counts, A→B→clear, all late matches, cache reuse, source revision, note revisions, same-key replacement, removal/Undo identity, import, scope/kind/sort equivalence, and focus.
- Focused local checks: 33 tests passed across cooperative search, large library, library search and phrase index suites. No timing assertions are used.
- `tests/large-library-browser.mjs` adds actual-browser pending/cancellation/focus assertions and waits for complete selection before inspecting hits. Authored for CI; not executed locally.
- CPU profile: `flock /tmp/coconut-full-gates.lock node scripts/profile_cooperative_library.mjs`.
- Raw results: `docs/benchmarks/cooperative-library-profile.json`.

## Measured limits, not a frame-time guarantee

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

An earlier run reached 68.23 ms for a cold slice in the 150-document fixture and 76.61 ms for the 50,000-cue outlier. Allocation/GC and runtime variation matter. Cold index creation and matching within one long document can still visibly block. Sorting the final complete result and computing duration keys remain atomic, as does rendering one bounded card page. The 4 ms budget is checked between documents, not a hard cap. Splitting the shared phrase-index builder/search into cooperative units requires a separate engine change and review; this shelf-only change does not claim to solve that limitation.
