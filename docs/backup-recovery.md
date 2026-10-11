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

## Selecting several transcript files

The transcript picker accepts multiple JSON, SRT and VTT files. It reads and
commits one file at a time, with no total batch byte/count cap. Individual format
limits and the full-JSON review still apply. The Add workspace lists each file's
actual outcome; a malformed file, a duplicate or a declined large-file review
does not roll back earlier successes or prevent a later valid file from importing.
The batch review labels its choices explicitly: skip this file, stop remaining
files, or continue reading. Escape stops the batch.
Whole-library JSON is explicitly rejected here with directions to the distinct
single-file **Restore library backup** action. Even a library envelope containing
an extra `segments` field cannot masquerade as a transcript.

A save is acknowledged only by its durable receipt. A storage failure retains
that complete document in the page, stops further reads and exposes the existing
retry/rescue controls; successful retry updates its outcome. Stop, newer file
selection, page teardown or reader navigation retires remaining files. A write
already in progress still receives its real success/failure outcome; cancellation
never deletes saved documents. Opening a result uses that exact live identity and
its existing reading bookmark. The result list stays out of the reader.

The progress list belongs to this page, not the saved library. Reload preserves
saved documents; it does not resume unstarted imports or restore the old result
list. Re-selecting files remains duplicate-safe. Only ordinary transcript files
are batched; project subtitle attachment and whole-library restore remain separate.

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

`tests/reader-multi-import.test.mjs` covers mixed formats, partial failure,
deduplication, explicit library separation, large-file review, receipt ordering,
cancellation, newer navigation, source/note edits and exact result identities. Its
production-provider test uses a deterministic transaction double, not a browser.
`tests/multi-import-browser.mjs` is CI-only actual multiple-file selection,
partial failure, cancellation, newer note/navigation, quota/retry and IndexedDB
reload proof. No local browser execution is claimed.

## Exact-text excerpt snapshots

Complete document and library JSON now preserve optional `exact_excerpts`
(version 1 records), separately from legacy `segment.saved_excerpt` whole-cue
annotations. Each exact record stores the original paragraph composition,
separators and selected range, captured cue text/corrections, capture-time source
metadata, and capture time. Restoring does not reattach by similar wording or
replace missing source cues. Stale and missing-source records remain historical
evidence available in the notebook and Markdown export.

Use a reader that supports exact excerpts to view, manage or restore these
libraries and backups. Older readers' ordinary library load/save paths may retain
unknown top-level fields, but their JSON document import and library restore
rebuild validated documents and discard `exact_excerpts`. Use a compatible reader
to restore these backups, and retain an untouched original JSON when moving
between versions. Preservation by ordinary load/save does not imply full downgrade
compatibility. This is an optional document-
field addition, not an IndexedDB schema/database or backup-protocol migration. Existing
backups without the field retain their behavior. Unsupported or malformed exact
records reject validation rather than being silently dropped; keep the original
backup. Markdown and subtitles are not complete restoration formats.

Saving an excerpt is complete only when its document's durable receipt succeeds.
Failed saves remain in the current page, with retry and unsaved-document export.
A rescue download request alone does not prove the file reached disk. No source
media, credential, word-level timing or guessed source association is created.

### Personal notes on exact excerpts

Supporting readers retain optional document-level `exact_excerpt_notes`, an
object mapping exact-excerpt IDs to personal-note strings. This sidecar is not
part of the immutable quotation snapshot. JSON restoration preserves every
string exactly, including empty strings, whitespace and line endings. An omitted
field or an object with zero keys normalizes to the same legacy document. There
is no new note-size limit or database/schema/backup-version migration.

Validation rejects malformed containers, non-string values, and IDs absent from
`exact_excerpts`, including orphaned empty notes. Audio-only projects reject this
field, even when empty. Unsupported data is not silently discarded. Removing an
excerpt removes its own sidecar entry in the same document save. Complete JSON
and library recovery retain notes, while transcript/subtitle exports and AI
reading text exclude them. Notebook Markdown includes nonempty notes separately
under “我的笔记”; it remains a reading export rather than a restorable backup.

Version 0.7.4's validation projection, JSON document import and library restore
discard `exact_excerpt_notes`, while retaining valid `exact_excerpts`. Its ordinary
IndexedDB and legacy library load/save paths can retain unknown fields, but cannot
view or manage these personal notes. Readers predating exact-excerpt support also
discard `exact_excerpts` on JSON import/restore, as described above. Ordinary
preservation does not imply full downgrade compatibility. Keep an untouched JSON
backup and restore with a supporting reader when moving between versions.

### Selected library backups

Selected-document export uses the existing `coconut-library` version 1 envelope
and the ordinary additive library restore. It includes the selected documents'
accepted source text, corrections, annotations, translations and saved AI history
with evidence, including accepted changes still awaiting local persistence. It
excludes media files, credentials and unsubmitted editor drafts. A selected subset
is not a complete library backup; use whole-library export before upgrading.
Selection is session-only and is not restored on reload. Requesting a download
does not prove that it saved to disk or clear an unsaved-data warning.

### Version 0.7.6: collections, speaker provenance and manual chapters

Before upgrading, export a complete library JSON backup and verify that it reached
disk. Keep that original. Do not clear browser storage to make an older reader
open a library.

A reading collection is an explicit `reading_collection` library entry, using
the existing version 1 backup envelope and document store. Version 0.7.5 rejects
collection-only and mixed collection backups. Its legacy and IndexedDB startup
can fail closed for the entire same-profile library when a collection is present.
The verified refusal does not erase the library; a supporting reader can reopen
it. This is not bidirectional compatibility. Restore with a supporting version.

Version 0.7.5 validation, JSON import and library restore discard
`original_speaker` and `reading_chapters`, while retaining current `speaker`
labels, valid `exact_excerpts` and `exact_excerpt_notes`. In a library without
collections, ordinary older-provider load/save can preserve unknown top-level
chapter data, but normalizes each segment and drops nested original-speaker
provenance. A retained current label is not the recoverable initial label.
The earlier 0.7.4 personal-note limitations above still apply.

Chapters are live exact-cue navigation, not historical quotes. Missing cue anchors
remain explicit, and replacement transcripts do not silently inherit chapters.
Collections retain selected immutable snapshots even after a source is removed.
Their rescue/backup downloads use the ordinary library envelope and are restored
with Restore Library Backup. Markdown, TXT and subtitle exports are not recovery
formats. No database or backup-version migration is introduced by these fields.
