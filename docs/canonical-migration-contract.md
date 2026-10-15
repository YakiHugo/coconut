# Browser adoption contract (dependent implementation)

This is an explicit transfer of authority, never automatic startup migration. See the authored executable fixture in `tests/fixtures/canonical-migration.mjs` and `tests/desktop-library-migration.test.mjs`. All requests obey the foundation origin/JSON/version and byte guards.

## Prepare and freeze

The UI must reject unsubmitted drafts/imports/model work and flush registered saves behind an ingress barrier before beginning. In an IDB transaction touching all existing stores, capture the exact ready snapshot and change `meta/state.status` away from `ready`; existing open tabs already reject commits unless that state is ready. Preserve the original state and every raw row. Generate/persist the UUID values `meta/canonical-source-id` and `meta/desktop-media-library` before capture if absent. Store the chosen server epoch, migration UUID and exact snapshot in a local migration marker; the captured snapshot must retain the original `state.status: "ready"`. Do not delete or rewrite documents, tombstones, catalog, legacy snapshots or original localStorage.

Preflight lossless JSON serialization and byte budgets before freezing; `JSON.stringify` alone is insufficient for arbitrary structured-clone data. Reject unsupported values, holes, lossy numbers and unsupported keys. Store the immutable UTF-8 bytes/digest once and reuse them across retries. Total archive limit 64 MiB and 2,000,000 JSON value nodes; each document 8 MiB. Over-budget or invalid sources remain usable in IDB and explain the blocker. An interrupted frozen migration must resume or cancel, not silently admit a writable reader.

## HTTP contract

- GET `/api/v1/library` advertises `migration:{protocolVersion:1,maxBytes:67108864,chunkBytes:1048576,maxNodes:2000000}` and `batchProtocolVersion:2`.
- POST `/api/v1/library/migration` has `{protocolVersion:1, epoch, migrationId, action}`. `epoch` is the discovered server UUID; migrationId is a client UUID.
- `begin` adds `manifest:{sourceId,mediaLibraryIdentity,sha256,bytes,chunks}`. UUID identities must equal the corresponding raw meta rows. sha256 is lowercase SHA-256 of exact UTF-8 archive bytes; chunks is ceil(bytes/1048576).
- `chunk` adds `{index,data}`. Data is canonical padded base64; each chunk except the last is exactly 1048576 decoded bytes. Response acknowledges index and chunk sha256. Duplicate exact chunks are safe; changed chunks fail.
- `finalize` adds no fields. One SQLite transaction verifies completeness, whole hash, row keys/tokens/catalog/tombstones, every existing-ID collision and all byte limits, then imports. Staging is invisible to normal catalog reads. Conflicts never overwrite existing records. First implementation allows one browser source per PC database. Unknown fields and original identity envelopes stay in the recovery archive and identity provenance.
- `cancel` adds no fields. It creates a permanent cancelled marker even if begin has not arrived, so delayed requests cannot resurrect the session. It removes only staging chunks. A committed migration returns committed instead of cancelling.
- GET `/api/v1/library/migration?protocolVersion=1&migrationId=UUID` returns 404 `{state:"absent",epoch}` or 200 `{protocolVersion:1,epoch,migrationId,state,manifest,receipt}`. State is staging/cancelled/committed. Committed receipt is `{epoch,migrationId,sourceId,sha256,sequence,documents,mediaLibraryIdentity}`. Exact finalize retries return the same receipt.
- Adding `&index=N` to that GET downloads a committed recovery archive chunk `{protocolVersion:1,epoch,migrationId,index,data,sha256}`. Reassemble and verify full manifest sha256 before claiming an export succeeded.

Before changing local authority, verify committed receipt against the local marker and every live document's exact JSON hash plus key/lifetime/order/deletion state. Catalog and GET record expose sha256 over `JSON.stringify(document)` and `identity:{lifetime,position}`; UUID `token:{epoch,revision}` is a distinct transport CAS identity. Imported browser tombstones have `document:null` and cannot be restored without a supplied complete document. Preserve the browser media-library UUID; transport epoch is never a replacement for it.

## Adapter writes

POST `/api/v1/library/batch`: `{protocolVersion:2,epoch,commands:[{action,key,expected,expectedIdentity,receiptKey,document?}]}`; 1–100 distinct keys and at most 16 MiB total. Actions put/delete/restore. expectedIdentity is the loaded `{lifetime,position}` or null for a new key; it fences lifetime separately from the transport token. Each expected token is `{epoch,revision}` or null for a new document; delete with null creates a tombstone for an unsaved removal. Put/restore require complete document snapshots. All commands and receipts commit atomically, so reader dependency groups remain indivisible. Response `{protocolVersion:2,epoch,receipts}` includes original `identity:{lifetime,position}` in each immutable receipt. Exact retries reuse the original request bytes/receipt keys. Put/delete preserve lifetime; restore increments it. Adapter must not adopt receipt state without validating key, generation, action and captured identity.

## Recovery and authority

On final acknowledgement, record the canonical authority marker in IDB, including server epoch and migration receipt; keep source frozen/read-only forever unless an explicit future export/restore workflow is chosen. On restart, inspect that marker before normal IDB readiness. Never fall back to writable IDB when the server is unavailable or a different epoch is served. Surface retry/recovery export instead.

Before finalize, explicit cancellation calls server cancel and waits for a confirmed `cancelled` state for the exact session and epoch before atomically restoring the original IDB state. An absent/unknown response, timeout or network loss is not cancellation; re-query or retry cancel. If the server says committed, finish adoption. After finalize, automatic rollback would create two writers and is forbidden. Both browser archive and server recovery export remain available.
