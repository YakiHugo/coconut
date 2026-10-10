# Bounded long-transcript reading

## Reproduced problem

On main `33bb3a8`, following a bookmark, AI citation, or playback position at cue 1,751 of a 1,771-cue transcript rendered all 1,771 cues. Each subsequent note opening, excerpt toggle, or translation-view update rebuilt those preceding rows. The previous “continue reading” action also kept growing the mounted transcript. A paused player's active-cue highlight disappeared after these renders until another media time event.

## Change

- Keep at most 100 transcript rows mounted. Previous/next controls show the range within the current results and move keyboard focus to the first row of the new page.
- Source jumps go directly to the target's page, preserving precise focus. They still clear filters so citations and bookmarks can always be found.
- Search, excerpt/note filters, exports and model-request scope continue to cover the entire document or full matching set. Merely turning a page does not change consented AI scope.
- When removing the final matching excerpt from a later page, clamp to the last valid page instead of showing an empty reader.
- Reapply current playback highlighting after each render without replacing the player or resetting its time.

## Verification

- 66 JavaScript/core/DOM tests and 70 Python tests pass. Four new DOM regressions cover late bookmarks with paused media, complete bidirectional traversal and saved notes, off-page search/AI scope/citations, and final-page removal with keyboard recovery.
- Before the change, the new 1,771-cue regression failed its maximum-100-row assertion; all existing 62 JavaScript tests passed. Existing cumulative-row assertions were updated for page windows while retaining the same exact cue/backup/navigation assertions.
- A synthetic Happy DOM comparison (same 1,771 cues, bookmark at zero-based index 1,750; one warm-up plus five timed runs) mounted 1,771 rows on main versus 71 on the candidate. Median synchronous resume handler time was 372.49 ms versus 24.05 ms in this container. These are DOM-harness measurements, not browser layout/paint or user-device performance claims. The regression asserts the deterministic row bound rather than a timing threshold.
- JavaScript syntax and whitespace checks pass. Static-reader app/style cache hashes updated.
- No browser actions were retried. Actual browser visual/touch behavior, native media decoding and seek accuracy remain unverified for this change. No model inference or credentials were used, and nothing was published.


## Playback hot paths (2026-10-10)

Baseline: `0db6a8d9fac33a3a4e3a7c774259d6b1f3ed6b6f`. The passage reader was already bounded to eight displayed passages, but each playback-control refresh rebuilt **the complete passage list once for every visible listen button**. A normal first passage render therefore built the full list nine times. Playback highlighting and the media dock also independently searched backward through the entire source for every time event.

### Changes and correctness boundaries

- Each rendered listen button now has its own transient passage-range metadata in a `WeakMap`. Refreshing availability, preview status, or media duration visits only the mounted buttons. A new render replaces the button and its range together. It does not cache authored text, translations, search results, or persisted data.
- Playback lookup uses a source-order interval tree. Right-first traversal preserves the previous last-source-cue winner, inclusive start/end boundaries, zero-duration cues, unsorted timestamps, and overlaps. It deliberately does **not** assume the latest chronological start wins.
- Building the index is O(n), with O(n) extra memory. Normal chronological lookups are O(log n); adversarial interleaved interval bounds may still need O(n). At 50,000 cues, its two timing-bound arrays use 2 MiB, plus the copied reference array.
- Every full reader render invalidates the index, including same-array source edits. Replacing the active source array also forces reconstruction. Source switches, restoration, and annotation re-renders keep the conservative invalidation path. Regular time events reuse the index.
- Literal full-text matching remains an intentional full O(n) scan. This change does not cache matches or alter filters, translation freshness, AI scope, cue order, or source navigation.

### Reproduction and measured evidence

Run `node benchmarks/reader-hotpaths.mjs` after installing the repository's existing dependencies. To compare another checkout's production reader, pass its directory as a trailing file URL, for example `node benchmarks/reader-hotpaths.mjs file:///tmp/coconut-baseline/`. The script reads that checkout's actual production modules. It creates only authored synthetic cues and Happy DOM elements; it does not launch a browser or make model/media requests.

Operation counting uses a separate Proxy-instrumented pass. Timing passes use plain source arrays and report the median of three batches on Node v24.19.0/Linux in this shared container. The cheap passage-build call wrapper remains in both versions. Values below are **batch milliseconds**, not per-cue latency, browser layout/paint, native decoding, seek accuracy, or user-device promises. These timings are observations, not regression thresholds.

| Cues | First eight passages | 20 control refreshes | 60 cue lookups, including cold index | 60 warmed highlights | 20 unchanged full-text scans |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1771 | 35.623 → 7.919 | 512.024 → 4.710 | 0.696 → 0.541 | 61.319 → 21.514 | 67.800 → 24.712 |
| 20000 | 193.441 → 26.297 | 2727.250 → 2.464 | 8.936 → 6.820 | 29.981 → 16.729 | 447.051 → 311.784 |
| 50000 | 677.377 → 59.727 | 9809.587 → 2.476 | 21.605 → 15.676 | 65.087 → 18.312 | 1334.565 → 691.578 |

Each timing cell is baseline → candidate. The unchanged search control also varies substantially, showing shared-container load/JIT/GC noise; its timing difference is **not** a claimed optimization. The deterministic counts are the stronger evidence:

| Cues | Source reads during 20 control refreshes | Source reads during 60 cue lookups | Source reads during 60 warmed highlights |
| ---: | ---: | ---: | ---: |
| 1771 | 566,720 → 0 | 53,160 → 1,771 | 53,160 → 0 |
| 20000 | 6,400,000 → 0 | 600,020 → 20,000 | 600,020 → 0 |
| 50000 | 16,000,000 → 0 | 1,500,020 → 50,000 | 1,500,020 → 0 |

At every size, first-render passage builds fall from 9 to 1; twenty control refreshes fall from 160 complete builds to 0. “Source reads” means indexed reads from the source cue array, not all CPU instructions or tree-node accesses. The lookup batch includes the candidate's one-time snapshot construction; warmed highlights use it without rescanning source timing.

### Verification

- `npm test`: 418 passed, no failures or skips, including five new deterministic regressions. A seeded oracle comparison covers arbitrary cue order, overlap, exact endpoints and zero-duration cues; app tests cover index reuse/invalidation and replacement passage-button bounds.
- `python -m unittest discover -s tests -v`: 139 tests, passed with 3 existing pinned-extractor live-proof skips.
- `python scripts/reader_assets.py --check`, JavaScript syntax checks, and `git diff --check`: passed. Only the affected script cache tokens changed in `reader/index.html`.
- No browser or real-media performance claim is made; this is a production-module/DOM-harness measurement. Remote CI remains a separate check on the published commit.


## Large-library shelf

The separate [large-library rendering record](large-library-rendering.md) covers bounded 40-card pages, complete-library search and backup, card reuse, and authored 100/1,000/5,000-document profiles. Transcript pagination and shelf pagination have independent bounds.
