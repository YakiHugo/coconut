# Bounded search-preview CPU work

Cross-library searches already reuse completed results and source indexes. On a fixed authored corpus, an unchanged completed query took roughly 0.01 ms at 100 documents; empty selection needed no text scan. The measured extra work was common-query preview construction: all matching cue previews are built, although the shelf displays at most 40 documents and three source previews per document. The 100-document common-query fixture produces 30,000 source previews.

A Node CPU profile identified `rangeSnippet` as the largest `reader/passages.js` self-time hotspot: approximately 925 ms across ten profiled searches, versus 479 ms in the matcher. This profile included fixture creation, index priming and explicit GC outside timed searches; it is hotspot evidence, not a browser latency result.

## Change and correctness

Each preview already limits its three input windows to 72, 242 and 132 UTF-16 units. When a window contains no valid surrogate pair, string slicing gives exactly the same code-point result as `Array.from(...).slice(...).join(...)`, including isolated surrogates. Astral-character windows keep the existing path. Detection never scans the full source, even for multi-million-character fields. Matching, highlights, preview limits, offsets and ellipsis conditions are unchanged.

No persistent state, source/query cache, lazy getter, invalidation rule, storage schema or document ownership rule is added. The existing edit, replacement, restore, remove and cancellation behavior is exercised by the focused search tests. An experimental lazy-preview alternative was not selected: its search savings were comparable, but it moved substantial work into full serialization and added getter state.

## Reproduce

Run the checked-in scripts from the repository root. For the before tree, use a separate checkout at `bef2643cc2f44fe0766210ec33104f68ee270a58`; pass that checkout as the optional final argument. The scripts only use authored in-memory data.

```sh
flock /tmp/coconut-full-gates.lock node --expose-gc benchmarks/library-search.mjs
flock /tmp/coconut-full-gates.lock node --expose-gc benchmarks/snippet-slicing.mjs
# Optional CPU profile of the common-English case:
LIBRARY_PROFILE_COMMON_ONLY=1 node --expose-gc --cpu-prof benchmarks/library-search.mjs
```

Node v24.19.0; seed `0xc0c02026`; five runs per case, with explicit GC outside the measurements. Corpus sizes are 10, 50 and 100 documents, half English and half Chinese, each containing 600 six-second authored cues (about one hour). The 100-document corpus contains 4,607,210 UTF-16 units. Queries cover empty, rare English/Chinese, common English/Chinese and no matches. This corpus has no translations or saved quotations; related functional suites cover those consumers.

The injected scheduler is drained synchronously. `totalMs` is elapsed CPU-side selection work, not actual scheduled wall time. `cpuMs` is process user plus system CPU, which can exceed elapsed time because runtime workers may execute in parallel. Browser rendering, native devices, audio, storage, real timer clamping and input/frame latency were not measured.

All table values are milliseconds and are medians of five observations. Raw observations, hashes and source digests are retained in [library-snippet-profile.json](benchmarks/library-snippet-profile.json). All 18 before/after cases have identical document-result and full-preview hashes, stable across cold and warm samples.

## Common-query results

| Documents | Query | Cold elapsed before → after | Warm elapsed before → after | Warm process CPU before → after |
| --- | --- | ---: | ---: | ---: |
| 10 | common-en | 25.67 → 17.39 | 19.81 → 11.77 | 22.28 → 15.26 |
| 10 | common-zh | 26.61 → 17.47 | 22.15 → 12.93 | 22.74 → 14.50 |
| 50 | common-en | 130.26 → 66.99 | 102.84 → 44.34 | 158.89 → 48.80 |
| 50 | common-zh | 130.89 → 66.20 | 102.91 → 47.82 | 157.68 → 54.12 |
| 100 | common-en | 268.33 → 156.16 | 209.31 → 105.42 | 312.32 → 164.25 |
| 100 | common-zh | 257.75 → 157.44 | 213.99 → 112.13 | 318.19 → 168.54 |

At 100 documents, the common-query warm elapsed reduction was about 48–50%, and process CPU fell about 47%. Empty, rare and absent queries show ordinary small-run variation, without a claimed speedup. For example, rare-English warm search was 42.08 → 41.01 ms, while absent warm search was 40.43 → 42.20 ms. Reused completed results remain approximately 0.01 ms.

## Visible preview cost and scheduling tails

The visible read phase calls the actual `libraryHits` API for at most forty documents and three hits each. The separate serialization phase materializes every preview, including enumerable getters, so deferred work cannot masquerade as removed work. The implementation remains eager.

| 100 documents, warm | Search + visible previews before → after | All-preview serialization before → after | Slice p95 before → after | Slice p99 before → after | Maximum slice before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| common-en | 210.05 → 106.07 | 87.86 → 79.07 | 3.44 → 1.04 | 8.98 → 4.04 | 10.64 → 12.83 |
| common-zh | 215.28 → 112.73 | 86.97 → 77.03 | 4.07 → 1.39 | 8.05 → 4.05 | 9.12 → 13.60 |

Slice percentiles are calculated inside each run, then the five values are summarized. The maximum-slice median actually increased for both 100-document common cases despite lower p95/p99. The single worst recorded slice across all cases was 27.99 ms before and 16.16 ms after. Runtime/GC variability remains; neither this observation nor the cooperative 4 ms budget is a hard scheduling or frame-time guarantee. This is demonstrated CPU work reduction, not a proven UI stutter fix.

## Short versus giant fields

Each row performs 10,000 preview calls, with the same bounded windows and output checksum. Source length grows from 1,000 to 2,000,000 UTF-16 units; the detector has no source-length scaling.

| Content | Source length | Median before → after |
| --- | ---: | ---: |
| bmp | 1,000 | 56.71 → 7.43 |
| bmp | 2,000,000 | 58.93 → 6.80 |
| astral | 1,000 | 64.71 → 58.95 |
| astral | 2,000,000 | 62.17 → 62.92 |

Astral fallback stays on the same code-point path: the giant-field observation was 62.17 → 62.92 ms, with matching checksums. No astral speedup is claimed.

## Focused verification

67 tests passed across `reader-snippet-slicing`, `reader-phrase-index`, `reader-library-search`, `reader-cooperative-search`, `reader-long-document-search`, `reader-saved-library-search` and `reader-library-translations`. The new tests compare the previous implementation directly on explicit Unicode/boundary cases and 4,000 fixed-seed generated strings, and instrument the bounded windows and array allocations without timing thresholds. Reader asset hashes and `git diff --check` passed. No full aggregate, browser, Electron, native device, network or model test was run in this focused stage.
