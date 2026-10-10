# Cooperative cross-library notebook

Baseline tree: `83c73549a066a7c47815b4ba0541e9a5e6e43edf` (commit `3132680ec1c0b74cbee1d27daa4c794dca2d0a13`). Previously, opening “我的笔记与摘录”, every typed query, and each page change synchronously scanned every cue, even when only a few cues had notes. Limiting the mounted list to 30 rows did not bound collection work.

## Behavior and boundaries

The production collector now resumes the same capture iterator used by the synchronous `libraryCaptures` API. Large libraries yield through sparse cues, dense captures and audio-only bookmarks; completed same-query results are reused for pagination. No result is truncated. Document order, source cue order, project notes, bookmark array order, note/excerpt coalescing and document-qualified stable keys are unchanged. The complete array and key indexes are built incrementally without a terminal sort/copy.

A query/kind change, close, content enqueue revision, source/translation invalidation or document replacement retires stale work. Partial counts are never presented as complete, and pending rows/navigation controls cannot activate old results. Stable-key return chooses the fresh matching page; a completion does not reclaim focus after the user moved it. Source identity/content and pending structural changes are rechecked before navigation. Exports read every current record from the selected live documents, independently of query results or pending work; selected sources undergoing structural changes must finish first. Existing correction/translation-freshness rules remain in force.

Default steps stop at 32 scan chunks (128 items each), 4,096 emitted captures, or a nominal 4 ms budget. Document snapshot/validity work remains O(document count). GC, scheduling and a single string operation can exceed the nominal budget. Full export and thirty-row rendering are separate synchronous operations. There is no hard 4 ms or browser-frame guarantee.

## Reproduce

The fixed authored fixtures contain at most 1,000,000 cues; each case has five measurements. The probe requires only Node and local production modules, with no browser, model, network or persisted user data. On a shared host run:

```sh
flock -w 300 /tmp/coconut-full-gates.lock timeout 90 node --expose-gc benchmarks/notebook-search.cjs cooperative > /tmp/notebook-cooperative.json
```

To reproduce the pre-change synchronous path, extract its actual production modules and point the same script at them:

```sh
baseline=$(mktemp -d)
git archive 83c73549a066a7c47815b4ba0541e9a5e6e43edf reader/core.js reader/summary.js | tar -x -C "$baseline"
flock -w 300 /tmp/coconut-full-gates.lock timeout 90 node --expose-gc benchmarks/notebook-search.cjs synchronous "$baseline/reader/core.js" > /tmp/notebook-synchronous.json
```

Saved raw samples, including outliers: [baseline](../benchmarks/samples/notebook-synchronous-83c7354.json), [cooperative candidate](../benchmarks/samples/notebook-cooperative.json). These were measured on Node v24.19.0 in a shared Linux container, using the equivalent fixed-fixture probe before its packaging into `benchmarks/notebook-search.cjs`.

| Authored workload | Baseline synchronous median | Candidate initial-request samples | Candidate scheduled steps |
| --- | ---: | ---: | ---: |
| 1M cues, 1,000 notes, open | 25.07 ms | 0.192–2.049 ms | 245–246 |
| Same, missing query | 21.39 ms | 0.176–0.323 ms | 245–246 |
| 100K excerpts, open | 63.57 ms | 0.022–0.084 ms | 27–31 |
| Same, missing query | 129.34 ms | 0.022–0.293 ms | 25–26 |

Completed-query reuse took 0.010–0.061 ms across these cases. All expected captures were retained. Baseline samples reached 313.98 ms; candidate raw slice maxima reached 43.995 ms for dense open, 23.022 ms for sparse open and 17.856 ms for sparse missing search. Candidate total slice CPU ranged 29–178 ms and can exceed a synchronous scan. The improvement is deferred/partitioned work and reuse, not a claim of less total CPU.

These observations measure Node core wall time with a manually drained cooperative scheduler, not browser timer clamping, paint, native input latency or total elapsed browser time. Timing values are evidence, never regression thresholds.

## Verification

The focused Node command passes 31 tests:

```sh
node --test --test-concurrency=1 tests/reader-cooperative-notebook.test.mjs tests/reader-library-notebook.test.mjs tests/reader-cooperative-search.test.mjs
```

It covers independent synchronous parity, giant sparse cues, dense/all-results collection, audio bookmarks, cancellation, revisions/source ownership, same-query reuse, pending controls, stable-key return, moved focus, close/reopen and export independence. `tests/library-notebook-browser.mjs` adds a CI-only native-keyboard replacement and complete 68-match paging journey from 6,148 authored captures. The browser journey checks actual input and final-result behavior; deterministic scheduler tests establish overlapped-job cancellation. It was syntax-checked but not launched locally; browser behavior and aggregate CI remain separate gates.
