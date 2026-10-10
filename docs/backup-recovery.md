# Complete backup recovery

Coconut's complete document JSON and whole-library JSON include source text,
corrections, notes, excerpts, translations, translation context and saved AI
records with their evidence. Local media files and account credentials are not
included. Keep the actual downloaded file: requesting a download is not proof
that the browser saved it, and successful import is not proof of local storage.

## Consistent import budgets

- JSON files up to **50 MiB (52,428,800 UTF-8 bytes)** are read directly, through
  document import, library restore or audio-project transcript attachment.
- Larger JSON backups have one explicit **continue reading** dialog, before
  `File.text()` or parsing. Cancel/Escape, choosing another file, leaving the
  workspace or page teardown retires the request. The same file can be retried.
- The 50 MiB boundary is a **review budget**, not an export or restore size cap.
  Whole-library backups also have no hidden 500-document count cap.
- SRT/VTT source subtitles retain the **15 MiB** input limit. This does not apply
  to the complete JSON produced after annotations, translations and AI evidence
  grow a document, or to a transcript combined with an audio project's notes.
- All existing schema validation still applies. Library restore validates the
  complete incoming collection before merging. It is additive: identical
  snapshots are skipped and conflicting edited versions remain separate.

This deliberately preserves the existing JSON format. It avoids compression
compatibility/decompression-size concerns and missing volumes from browser
multi-download blocking. It does **not** promise unlimited file sizes: parsing,
validation, duplicate detection and serializing temporary state require extra
memory beyond the file's byte count. A file may exceed a device's available
memory or the JavaScript engine's string limit. Catchable read/allocation errors
suggest retaining the original backup and retrying on a more capable device;
a browser process terminated by its OS cannot be recovered by an exception
handler. Streaming parsing remains outside this change. Default local storage now
uses [per-document IndexedDB](indexeddb-library-storage.md); the same large-file
review and memory boundaries still apply.

## When local saving fails

A quota or disabled-storage failure keeps imported content in the current page,
shows the existing unsaved-data warning and leaves the previously stored library
untouched. The reader and complete export remain available. Do not refresh or
close that page until you have confirmed a rescue download. A download never
clears the unsaved warning. Repeated imports/restore use the validated snapshot
identity even when the previous attempt could not be persisted.

## Regression coverage

`tests/reader-backup-budget.test.mjs` covers actual six-million-character Chinese
JSON (over 17 MiB), complete annotations and AI evidence, exact 50 MiB UTF-8
boundaries, cancel/Escape/retry and all three import entry points, stale requests,
more than 500 documents, complete >50 MiB notes, atomic invalid input and quota
failure rescue. Existing import/restore ordering and storage-failure suites run
alongside it. Cross-entry tests cover all nine old/new selections, a file already
awaiting its digest, stale audio-project picker targets, and removal/undo while
oversized-file approval is pending. Existing raw-key/source/canonical-digest
tombstones and stable-revision restore checks remain in force; an explicit new
selection after removal is still allowed. Core attachment tests cover a merged
JSON larger than the old
15 MiB subtitle limit without dropping project notes.

`tests/backup-roundtrip-browser.mjs` is wired into GitHub Browser acceptance.
It uses authored local files, native file selection, real downloads, fresh
browser contexts and real localStorage quota failure in the explicitly selected
legacy fallback. Production IndexedDB capacity and restore/reload are separately
covered by `indexeddb-library-browser.mjs`. It verifies ordinary
large-document restoration, oversized confirmation cancellation and retry,
whole-library >50 MiB recovery, deduplication and rescue exports. It makes no
model calls or remote media requests, removes its temporary files and uploads
no user material. Browser execution is intentionally left to CI.
