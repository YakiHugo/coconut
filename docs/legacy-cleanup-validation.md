# Single-renderer validation map

This is an explicitly authorized breaking frontend cleanup; the former renderer is no longer supported. The React entry is the only product UI. Old DOM selectors and compatibility HTML are deliberately removed; this cleanup does not promise old-renderer UI parity. No user library/database files are deleted or migrated by this change.

## Required current checks

- `npm test`: retained shared domain contracts plus real HTTP/fake-CLI task execution contracts and pixel/native-receipt helper contracts.
- `npm run test:react`: React stores, mounted components, ownership, drafts, recovery, persistence and native bridge contracts.
- `npm run check:reader-ui` and `python scripts/reader_assets.py --check`: typing, generated bundle and exact asset hash verification.
- Python regression discovery: server, source ingestion, captions-only/ASR guards, subtitle parsing, CLI and workflow contracts remain.
- Desktop Node discovery: SQLite identity/revisions/recovery, ingestion/idempotency, lifecycle ownership, updates, local-media registry, IPC and package integrity remain.
- Browser acceptance: actual default React source-first widths, canonical SQLite/recovery/AI/native lifecycle matrix, and reading palette/system theme transitions. No timeout increase or failure masking.
- macOS: actual default React ZIP nine-check acceptance, real native helper proofs, signature/tamper gate, packaged module-boundary verification and architecture-specific packaging remain.

## Removed renderer paths → retained coverage

| Removed path family | Retained current contract | Scope limit |
| --- | --- | --- |
| Old localStorage/IndexedDB DOM startup, save, rescue, library scripts | shared library-store/indexeddb/canonical suites; React storage-mounted, recovery-import, startup-lifecycle; production matrix with real SQLite | old bootstrap adapter/selector details intentionally gone |
| Old notes, exports, selection, translations, metadata, subtitle DOM suites | shared core/excerpt/metadata/encoding/export/review tests; React reader-workspace, reader-summary-keyboard, AI mounted/workspace, reading preferences | pure source/domain rules retained; no blanket claim that every old UI control exists |
| Old source/podcast/jobs DOM journeys | desktop source/ingestion/task API tests; Python source/ASR tests; React ingestion and source-first browser flows | external acquisition remains separate from authored React UI |
| Old local-media/browser/native packaged duplication | React native-media/controller/receipt tests; actual nine-check React native ZIP suite; desktop-local-media now calls production React inspectFile | old selector-based native media suite removed |
| Old updates UI and lifecycle harness | React native-shell/close suites, ported desktop lifecycle ownership with real React store/controller; native ZIP Cancel/close/quit | mocked host callbacks are controller-level evidence, not mounted browser evidence |
| Old preview/transcript-navigation adapter, styling and compatibility entry | sole-entry architecture/asset tests, React reader and palette/browser suites | no optional old-renderer fallback retained |
| Old test-helper-only observer/watchdog/profiler assertions | current production tests above; unused helper scaffolding removed | old acceptance harness implementation is no longer a product contract |

## Public source evidence

`podcast-public-smoke.mjs` retains real publisher feed/Apple/direct-media/source metadata and real Chromium audio play/seek checks. It now imports Playwright directly rather than waiting for a legacy UI bootstrap on a standalone audio page. Native exact-ZIP caption helper and guarded caption workflows remain.

The old live-public-source → compatibility UI journey is deleted. There is currently no equivalent live-public-source → React UI acceptance claim. The authored source-first browser suite now feeds the real Node publisher parser’s VTT output through React import, save, reload and complete-backup download, verifying source cues, speaker metadata, provenance and notes. This exercises the parser/UI seam offline; upstream network responses remain controlled.

## Shared-domain extraction ledger

The following mixed files retain complete original pure-domain assertion bodies. Only old DOM-dependent test declarations/setup were removed; names remain traceable in Git history.

| File | Original test declarations | Retained declarations |
| --- | ---: | ---: |
| `tests/reader-ai-history.test.mjs` | 17 | 1 |
| `tests/reader-canonical-library.test.mjs` | 44 | 41 |
| `tests/reader-cooperative-notebook.test.mjs` | 11 | 7 |
| `tests/reader-cooperative-search.test.mjs` | 6 | 5 |
| `tests/reader-displayed-translation-exports.test.mjs` | 9 | 3 |
| `tests/reader-empty-cue-navigation.test.mjs` | 5 | 1 |
| `tests/reader-indexeddb-library.test.mjs` | 25 | 20 |
| `tests/reader-library-notebook.test.mjs` | 20 | 2 |
| `tests/reader-library-restore-results.test.mjs` | 12 | 2 |
| `tests/reader-library-translations.test.mjs` | 12 | 5 |
| `tests/reader-local-media-projects.test.mjs` | 19 | 2 |
| `tests/reader-media-timing.test.mjs` | 22 | 1 |
| `tests/reader-metadata.test.mjs` | 8 | 3 |
| `tests/reader-model-selection.test.mjs` | 6 | 1 |
| `tests/reader-offline-translation-batches.test.mjs` | 10 | 3 |
| `tests/reader-passage-question.test.mjs` | 27 | 3 |
| `tests/reader-pasted-subtitles.test.mjs` | 39 | 7 |
| `tests/reader-performance.test.mjs` | 5 | 3 |
| `tests/reader-reading-view-resume.test.mjs` | 14 | 3 |
| `tests/reader-recent-reading.test.mjs` | 9 | 3 |
| `tests/reader-selected-library-backup.test.mjs` | 17 | 3 |
| `tests/reader-subtitle-encoding.test.mjs` | 17 | 2 |
| `tests/reader-text-export.test.mjs` | 7 | 3 |
| `tests/reader-transcript-media-association.test.mjs` | 27 | 2 |
| `tests/reader-translation-review.test.mjs` | 37 | 13 |

One final `reader-passage-playback` assertion tested the deleted browser harness predicate rather than production playback; it is removed while actual pause/range/cancel controller tests remain.

## Deleted compatibility browser executables

These scripts directly loaded the removed renderer. Their current responsibility is mapped above; retaining them as disabled tests would conceal obsolete coverage.

- `tests/browser-acceptance.mjs`
- `tests/compact-library-browser.mjs`
- `tests/long-reading-browser.mjs`
- `tests/read-first-browser.mjs`
- `tests/speaker-correction-browser.mjs`
- `tests/cue-actions-browser.mjs`
- `tests/background-summary-browser.mjs`
- `tests/search-return-browser.mjs`
- `tests/large-library-browser.mjs`
- `tests/backup-roundtrip-browser.mjs`
- `tests/reading-appearance-browser.mjs`
- `tests/import-order-browser.mjs`
- `tests/quotation-browser.mjs`
- `tests/reading-view-resume-browser.mjs`
- `tests/library-notebook-browser.mjs`
- `tests/transcript-media-association-browser.mjs`
- `tests/reader-unload-browser.mjs`
- `tests/window-selection-browser.mjs`
- `tests/reader-provider-errors-browser.mjs`
- `tests/multi-import-browser.mjs`
- `tests/local-media-projects-browser.mjs`
- `tests/ai-history-browser.mjs`
- `tests/canonical-library-browser.mjs`
- `tests/reading-chapters-browser.mjs`
- `tests/podcast-live-browser.mjs`
- `tests/project-continuity-browser.mjs`
- `tests/reading-display-browser.mjs`
- `tests/wide-library-search-browser.mjs`
- `tests/pasted-subtitles-browser.mjs`
- `tests/desktop-caption-ui-proof.mjs`
- `tests/reading-keyboard-browser.mjs`
- `tests/media-timing-browser.mjs`
- `tests/recent-reading-browser.mjs`
- `tests/save-pipeline-browser.mjs`
- `tests/playback-dock-browser.mjs`
- `tests/playback-follow-browser.mjs`
- `tests/bilingual-excerpts-browser.mjs`
- `tests/chapter-markers-browser.mjs`
- `tests/project-caption-paste-browser.mjs`
- `tests/queued-original-browser.mjs`
- `tests/passage-question-browser.mjs`
- `tests/desktop-packaged-acceptance.mjs`
- `tests/indexeddb-library-browser.mjs`
- `tests/ai-recovery-browser.mjs`
- `tests/desktop-local-media-acceptance.mjs`
- `tests/ai-actions-browser.mjs`
- `tests/translation-review-browser.mjs`
- `tests/desktop-updates-ui.mjs`
- `tests/source-corrections-browser.mjs`
- `tests/passages-browser.mjs`
- `tests/reading-collections-browser.mjs`
- `tests/inline-excerpts-browser.mjs`
- `tests/subtitle-import-browser.mjs`
- `tests/listening-progress-browser.mjs`
- `tests/reading-metadata-browser.mjs`
- `tests/library-removal-browser.mjs`
- `tests/transcript-navigator-browser.mjs`
- `tests/podcast-continuity-browser.mjs`
- `tests/library-translations-browser.mjs`
- `tests/summary-browser-acceptance.mjs`
- `tests/library-search-browser.mjs`
- `tests/phrase-search-browser.mjs`
- `tests/web-browser-acceptance.mjs`
- `tests/caption-recovery-browser.mjs`
- `tests/subtitle-encoding-browser.mjs`
- `tests/displayed-translation-exports-browser.mjs`
- `tests/text-export-browser.mjs`
- `tests/podcast-browser-acceptance.mjs`
- `tests/short-reading-layout-browser.mjs`

## Verification boundary

Local Node/Python results are reported against the exact integrated commit. Cloud-local Chromium launch is blocked by the execution sandbox (`socket() failed: Operation not permitted`); browser and macOS acceptance must therefore pass on the final published CI head before merge. No live platform/model requests were made during this cleanup.
