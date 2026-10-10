# Bounded large-library shelf

The shelf mounts at most 40 document cards. Its previous/next controls and direct page-number form make every matching document reachable, including the last document. The visible range distinguishes the current page, matching count, and full-library count. Titles remain complete and wrap on narrow screens.

This is a view bound, not a storage or search limit. IndexedDB/legacy persistence, the complete backup format, ordering, all title/source/note searches, and content filters still operate on every saved document. Existing three-item source-backed preview limits are unchanged. No storage schema or API changed.

## Navigation and incremental updates

- Changing a query, scope, sort, or content filter returns to the first matching page. Selecting another document reveals its page when it matches the current shelf filters. A “定位正在阅读” action returns from another page without clearing filters.
- Page navigation focuses the first card. Source and note matches retain their exact destination, even in a late document and a late source cue. Ordinary document opens focus the heading or saved reading position rather than leaving focus inside the collapsed mobile shelf.
- Removing the sole final-page item clamps to the preceding page. Successful Undo reveals and focuses the restored card when existing ownership rules allow it; delayed receipts do not steal a newer input's focus.
- A bounded keyed card cache retains only the current page. Unchanged refreshes create no card elements. Metadata updates keep open/remove buttons mounted; changed previews restore the matching action when it still exists. Source identity replacement invalidates the cached card.
- Ordinary title browsing no longer scans every document's cues for an annotation filter that is not selected. Full source searches intentionally still inspect the complete library; this does not claim constant-time full-text search.

## Reproduction

Run `node scripts/profile_library.mjs` after installing the existing dependencies. A second checkout can be profiled with `node scripts/profile_library.mjs file:///path/to/checkout/`. Only authored synthetic documents are used; the script runs production reader code in HappyDOM without a browser, media, or model requests.

The fixed fixture has 8 cues per document. Warm medians use five refresh/title-query samples and three full-text samples. Both search phrases match every document, avoiding a misleading benchmark of only a few results. Timing is Node/HappyDOM CPU and DOM evidence, not layout, paint, native-browser latency, or a user-device promise. Regression tests assert cardinality, node bounds, identity, and focus rather than timing thresholds.

Baseline tree: `dda05ab4c5a19a7712f3108cd555515833108176`, Node v24.19.0 and HappyDOM 20.11.1, shared Linux container. At 100 / 1,000 / 5,000 documents, baseline refresh medians were 10.13 / 92.64 / 518.74 ms; all-results title queries 8.11 / 87.21 / 482.02 ms; all-results full-text queries 59.87 / 442.03 / 2,096.28 ms. The baseline mounted every document and lost the focused card on an unchanged refresh.

Initial paged candidate (same harness and fixture):

| Saved documents | Mounted cards | Refresh median | All-results title query | All-results full-text query |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 40 | 3.05 ms | 2.65 ms | 39.21 ms |
| 1,000 | 40 | 3.14 ms | 4.49 ms | 122.99 ms |
| 5,000 | 40 | 8.53 ms | 12.09 ms | 496.09 ms |

Unchanged cards and their keyboard focus survived at every size. Timings vary with shared-container load; the deterministic bound and zero-construction regression are the stronger guarantees. Full-text matching remains proportional to the complete searchable content.

## Verification boundaries

`tests/reader-large-library.test.mjs` separately verifies saved cardinality and mounted cards, 1,001-document full backups, the full last title, complete sorting and filters, late-page source/note hits, final-page removal/Undo, direct page validation, stable focus, zero newly constructed cards on unchanged refresh, and no source-cue scan for inactive annotation filters.

`tests/large-library-browser.mjs` is authored for CI. It uses the actual IndexedDB backend, keyboard page submission, mobile geometry and 44px targets, exact native focus, durable removal and Undo, actual backup download, and clean-browser recovery of all 1,001 documents. It blocks external and mutation network requests. It has not been run locally; no browser, mobile visual, or native-layout pass is implied by the HappyDOM checks.
