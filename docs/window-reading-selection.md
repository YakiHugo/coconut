# Window-local reading selection

## Scope and storage contract

Selecting a document in the library changes the current window only. It does not stringify the document array or whole library and does not read or write the shared content library key. It leaves any outstanding save warning, summary persistence evidence and unload protection unchanged.

- Content is stored per document in IndexedDB by default; ordinary navigation does not issue content transactions. The original legacy `localStorage['coconut-reader-v1']` remains unchanged after verified migration. The explicitly labeled compatibility fallback writes `{documents}` as one localStorage value. See [storage and migration](indexeddb-library-storage.md).
- Window-local `sessionStorage['coconut-reader-active-v1']`: the selected document key as a plain string, with no document content. Same-window reload retains the choice. A browser-created duplicate or opener may initially copy a session, but later changes remain independent.
- Separate lightweight `localStorage['coconut-reader-last-active-v1']`: the most recently opened key as a plain string, used only as a default for a new window or native application relaunch. Existing windows never follow this hint when another window changes it. It is not part of the content library or its conflict comparison.
- Startup chooses a valid session key, then a valid last-open hint, then a valid legacy library `active`, then the first document in saved order, or no document for an empty library. An unknown or removed selection cannot manufacture or remove documents. Startup does not rewrite the content library.
- Session and last-open preference storage read, write and removal errors are independently nonfatal. The in-memory selection still works and content saving retains its independent status. Unavailable session storage is not reported as an unsaved transcript; reload continuity simply cannot be promised.

## Import, recovery and export

Single-document import keeps existing content matching and stable-key behavior, opens the imported or matched document and remembers that choice in this window. An import whose content save fails remains temporary in memory and retains the existing unsaved warning. Writing its selection to session storage does not claim its content was saved.

Whole-library recovery remains additive. The existing `mergeLibraryBackup` mapping resolves `backup.active` to the retained or newly renamed version. The resolved selection explicitly overrides this window's earlier selection; invalid or absent backup selection retains the current valid document or falls back to the first one. No library document is discarded to make a selection valid.

Actual JSON library exports still contain `{format, version, documents, active}`. The `active` value comes from this window's current in-memory choice, including when session storage is unavailable. Export captures all in-memory documents, including unsaved changes. Initiating a download never clears save warnings or proves persistence. Single-document exports retain their existing format.

## Compatibility and honest limits

Old `{documents, active}` libraries migrate additively with their exact original text retained. In compatibility fallback, the next successful content save omits the obsolete shared selection. Existing backup JSON selection semantics are unchanged.

Two modern IndexedDB windows navigate independently and can commit different documents without overwriting one another. Same-document stale revisions fail atomically and preserve the losing window's edits for rescue. The library is loaded at startup; other windows' new rows do not automatically appear without reload.

Mixed-version simultaneous use is not universally safe. Cooperative legacy clients respect the migration fence; older clients predating it can still rewrite the legacy value. New clients stop once that discrepancy is observed and preserve both stores. They never parse away an active-only difference or use last-writer-wins. The fallback's synchronous read-then-write localStorage comparison remains non-atomic, and any external content-library change conflicts, even for different documents.

## Integration with adjacent features

Library titles and cross-document search hits share the selection-only `openDocument(hit)` path. Content edits retain their saves. Recoverable removal and undo persist the new preferences only after the candidate content save succeeds and only if the active key changed. Failed candidates roll back without touching either preference. Removing or undoing a noncurrent document preserves this window's selection and the shared last-open hint from other windows. Identity, pending-work and recovery-copy protections remain intact.

## Verification

`tests/reader-window-selection.test.mjs` uses independent DOM windows with shared content storage and separate session stores. Every tested navigation asserts zero document/library serialization and zero content-library writes (the small last-open preference write is allowed). It covers actual conflicts, session reload, restart hints, legacy fallback, denied preferences, additive restore, exports, temporary imports, search-result navigation and transactional removal/undo preference changes.

Existing DOM and browser acceptance helpers still inspect real persisted documents; only selection lookup moves to session storage. Library backups continue to test their explicit `active` field. Native relaunch retains automatic selection through the lightweight last-open hint.

`tests/window-selection-browser.mjs` is an explicitly legacy-fallback CI-only Chromium check using authored fixtures, two same-origin pages, reloads and real downloads. The production IndexedDB cross-window path is covered by `indexeddb-library-browser.mjs`. It is wired into Browser acceptance. No local Chromium/Electron, real AI service or new Codex session is used. Local unit/HTTP results and final browser/native CI results must be reported separately.
