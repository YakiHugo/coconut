# Per-document library storage

Coconut now uses `coconut-reader-library-v1` in IndexedDB by default. The reader
waits for a complete, coherent library snapshot before admitting edits or starting
its classic application scripts. Startup has explicit progress, retry and recovery
exports. Selection and reading/listening preferences remain independent small
storage values; changing selection does not rewrite content.

## Migration and recovery

The first startup copies the complete original `coconut-reader-v1` localStorage
value into an immutable `legacySnapshots` record, including whitespace and unknown
fields, and records a SHA-256 hash over its exact UTF-16 code units. Documents,
catalog and migration manifest commit in one transaction. Readback verifies the
snapshot, manifest, every initial document payload and catalog identity before the
writer becomes available. Invalid, duplicate or quarantined documents never turn
into a silently truncated writable library.

The original localStorage value is never cleared, truncated or rewritten. Its
small cooperative migration fence also remains after failed migration attempts.
This uses additional disk space deliberately. A full legacy quota can prevent
writing that small fence; the visible failure preserves the old library and lets
the user export it. Coconut does not evict unrelated data to make room.

If IndexedDB is absent or access is denied before any fence exists, the reader can
use its existing whole-library localStorage adapter. The UI identifies this as
small-capacity compatibility storage. A blocked open, open timeout, unknown schema,
corruption, or an existing migration fence never silently falls back to legacy
writes. Unknown newer schema versions require an appropriate reader version.

At startup failure, the raw legacy download preserves the exact available string.
A string containing literal lone UTF-16 surrogates is exported in a lossless
JSON-string envelope, visibly labeled for recovery, rather than silently replacing
those code units during Blob text encoding.
When the database can still be opened, a separate complete storage recovery file
preserves every key and value in all stores plus current legacy text. This is a
technical recovery envelope, explicitly labeled as not directly importable as an
ordinary library backup. Application records are JSON-compatible. Arbitrary
non-JSON structured-clone corruption (for example Map, undefined, or cycles) is
rejected visibly instead of producing a lossy file; storage is left intact for
specialized recovery. The normal in-app library and unsaved-document exports
remain full-fidelity additive-restorable `coconut-library` backups.

## Downgrade warning

Retaining the previous application does not provide lossless data downgrade.
After migration, edits are stored in IndexedDB and are not copied back into the
preserved legacy localStorage value. v0.6.0 reads only that legacy value, so it
cannot show new or changed documents saved by this version. Export and verify a
fresh complete library JSON backup in the current version before attempting
recovery. Avoid editing the same library in v0.6.0: it predates the migration-fence
protocol and can change the legacy value, causing the current reader to stop
writes and preserve both stores for explicit recovery. Closing the old application
does not itself reconcile changed legacy data. Do not clear browser storage or
delete the migration fence to retry. Technical raw-storage exports are not
directly importable library backups.

## Writes and concurrent windows

The existing coordinator owns live object identity, generation, mutation ticket,
rollback, AI checkpoints and native close barriers. Its IndexedDB provider captures
only dirty document commands. Request success is not a save: only the transaction's
terminal `complete` event can acknowledge the captured generation and advance the
provider's revision tokens. A late receipt cannot clear a newer note or AI history.
Multi-document restores and structural commands commit atomically.

Each document has an epoch/revision token. A transaction checks expected tokens
before updating the document and catalog together. Different documents can be
edited in different windows without replacing the rest of the library. A stale
same-document edit fails visibly; retry does not silently rebase over newer data.
Conflicts are isolated by connected atomic operation group, as described below;
they do not prevent independent dirty-document groups from committing. The global
unsaved status still includes every unresolved conflict.
Removal writes a small tombstone, Undo checks its identity and restores the prior
catalog position with a new epoch. Tombstones do not retain removed transcripts.
The existing page-owned removal/draft bundle and provisional Undo UI remain intact.

Cooperative legacy clients refuse writes after the fence appears. Old clients
that predate the fence protocol cannot be controlled. Current clients compare the
exact legacy text/fence before and within writes and stop once a discrepancy is
observed. localStorage and IndexedDB cannot provide one atomic cross-API
transaction, so this is not a universal lock over uncooperative older versions.
No automatic merge or conflict overwrite is attempted.

A known document conflict leaves that document's local edits recoverable and
unsaved, but no longer prevents later independent documents from saving.
Explicit multi-document operations stay atomic; operations sharing dirty
documents remain one connected group until acknowledged. A conflict pauses that
whole group. If a mixed transaction aborts, unrelated groups can retry in a new
transaction; they receive success only after their own durable commit. Retry
rechecks the original revision tokens and never overwrites the other window.
The global save warning and close/update checks remain unsuccessful while any
conflicted edits are unresolved, even when an independent document saves.
Export the remaining unsaved documents before refreshing to read remote changes.
Whole-library legacy storage and global storage failures retain their existing
failure behavior. Group bookkeeping is bounded by outstanding dirty keys and
retired after acknowledged writes or structural reconciliation. A cancelled
close keeps its recoverable edits and atomic dependencies until resolved.

`versionchange` immediately closes the old connection and surfaces an error,
including when there is no pending edit. Unsaved content can still be exported.
Startup native quit prevents further script/edit admission, aborts active
migration transactions, and waits for their actual terminal acknowledgement.
Failure before editing can quit safely. The established loaded-reader native
close/update/discard ownership protocol remains the owner after startup.

## Capacity and boundaries

Content no longer needs to fit one localStorage string. IndexedDB quota still
belongs to the browser and available disk; it is not unlimited and is not a
backup against browser-data clearing, eviction, disk failure or profile loss.
Coconut does not request persistent-storage permission, change origin/profile,
call AI, or send library data over the network.

Startup still loads and validates the whole library in memory. This change removes
whole-library serialization from ordinary edits; it does not claim lazy document
loading, an unbounded library, or zero-copy validation. The migration snapshot is
retained intentionally. Existing large-backup review and memory limits still apply.

## Verification

- Deterministic transaction-double tests cover transaction terminals, abort races,
  coherent loads, corruption, schema/fence changes, original bytes, recovery rows,
  cross-window CAS, atomic commands, tombstones and shutdown.
- Provider/HappyDOM tests exercise the actual provider, dirty-only coordinator
  capture, full rescue, retry, large atomic restore and startup/native ownership.
- The browser acceptance workflow runs `indexeddb-library-browser.mjs` with native
  IndexedDB and authored data, including migration, real localStorage capacity
  comparison, large restore/reload, dirty-only writes, two windows and recovery.
- Ordinary product browser journeys and packaged/update/caption native journeys
  use production IndexedDB and read actual database rows after receipts. Four
  explicitly legacy-specific suites retain fallback coverage: save-pipeline,
  backup-roundtrip (legacy quota), window-selection (legacy conflicts), and Web
  unload (legacy quota/conflicts).

Browser/Electron tests are authored for GitHub Actions. Deterministic local success
is not evidence that those native browser or packaged runs have passed. The exact
published commit must pass those workflows before merge.
