# Window-local reading selection

## Scope and storage contract

Selecting a document in the library changes the current window only. It does not stringify the document array or whole library and does not read or write the shared content library key. It leaves any outstanding save warning, summary persistence evidence and unload protection unchanged.

- Shared `localStorage['coconut-reader-v1']`: new writes contain `{documents}` only. Document contents, notes, bookmarks, AI work and existing display fields still use the existing synchronous whole-library `save()` path. This change does not introduce IndexedDB, promises, partial writes or automatic conflict resolution.
- Window-local `sessionStorage['coconut-reader-active-v1']`: the selected document key as a plain string, with no document content. Same-window reload retains the choice. A browser-created duplicate or opener may initially copy a session, but later changes remain independent.
- Separate lightweight `localStorage['coconut-reader-last-active-v1']`: the most recently opened key as a plain string, used only as a default for a new window or native application relaunch. Existing windows never follow this hint when another window changes it. It is not part of the content library or its conflict comparison.
- Startup chooses a valid session key, then a valid last-open hint, then a valid legacy library `active`, then the first document in saved order, or no document for an empty library. An unknown or removed selection cannot manufacture or remove documents. Startup does not rewrite the content library.
- Session and last-open preference storage read, write and removal errors are independently nonfatal. The in-memory selection still works and content saving retains its independent status. Unavailable session storage is not reported as an unsaved transcript; reload continuity simply cannot be promised.

## Import, recovery and export

Single-document import keeps existing content matching and stable-key behavior, opens the imported or matched document and remembers that choice in this window. An import whose content save fails remains temporary in memory and retains the existing unsaved warning. Writing its selection to session storage does not claim its content was saved.

Whole-library recovery remains additive. The existing `mergeLibraryBackup` mapping resolves `backup.active` to the retained or newly renamed version. The resolved selection explicitly overrides this window's earlier selection; invalid or absent backup selection retains the current valid document or falls back to the first one. No library document is discarded to make a selection valid.

Actual JSON library exports still contain `{format, version, documents, active}`. The `active` value comes from this window's current in-memory choice, including when session storage is unavailable. Export captures all in-memory documents, including unsaved changes. Initiating a download never clears save warnings or proves persistence. Single-document exports retain their existing format.

## Compatibility and honest limits

Old `{documents, active}` libraries are read without an up-front migration write. The next successful content save omits the obsolete shared selection. Existing backup JSON selection semantics are unchanged.

An older application can read the new `{documents}` payload but may initially show no open document; choosing a document in its library opens it. Its document data remains available and can still be exported in full. Its subsequent content or navigation saves may reintroduce `active`.

Mixed-version simultaneous use is **not** made safe by this change: old windows still rewrite the full library on navigation. The existing raw-value comparison conservatively treats any external library difference, including an old client's active-only write, as a conflict. The stale window stops saving, keeps its in-memory work for export and instructs the user to back up before refreshing. We do not ignore unknown fields, parse away differences or use last-writer-wins.

Two modern windows may navigate independently without causing this conflict. A real write in either window still makes the other's next content save stale, even if the documents being edited differ. The pre-existing synchronous read-then-write localStorage check is not an atomic cross-window compare-and-swap; truly overlapping writes are not guaranteed safe. This is not complete multi-window editing support.

## Integration with adjacent features

Library titles and cross-document search hits share the selection-only `openDocument(hit)` path. Content edits retain their saves. Recoverable removal and undo persist the new preferences only after the candidate content save succeeds and only if the active key changed. Failed candidates roll back without touching either preference. Removing or undoing a noncurrent document preserves this window's selection and the shared last-open hint from other windows. Identity, pending-work and recovery-copy protections remain intact.

## Verification

`tests/reader-window-selection.test.mjs` uses independent DOM windows with shared content storage and separate session stores. Every tested navigation asserts zero document/library serialization and zero content-library writes (the small last-open preference write is allowed). It covers actual conflicts, session reload, restart hints, legacy fallback, denied preferences, additive restore, exports, temporary imports, search-result navigation and transactional removal/undo preference changes.

Existing DOM and browser acceptance helpers still inspect real persisted documents; only selection lookup moves to session storage. Library backups continue to test their explicit `active` field. Native relaunch retains automatic selection through the lightweight last-open hint.

`tests/window-selection-browser.mjs` is a CI-only Chromium check using authored fixtures, two same-origin pages, reloads and real downloads. It is wired into Browser acceptance. No local Chromium/Electron, real AI service or new Codex session is used. Local unit/HTTP results and final browser/native CI results must be reported separately.
