# Canonical computer library: the default storage authority

The React product loads and writes the connected computer's SQLite library by
default, including on a fresh browser and an empty library. Dev, light-service
and Electron entrypoints open their configured library automatically. No browser
migration or connection confirmation is needed. This is a shared library on one
service, not cross-device synchronization.

`COCONUT_LIBRARY_DIRECTORY=/absolute/private/directory` selects a library for the
light-service or development entry. Embedders can pass `libraryDirectory` to
`startBridge`. Paths must be absolute, private and locally owned. Unsafe existing
permissions, symlinks and hard links are rejected without changing them. The
directory contains `library.sqlite` and SQLite journal files. Use a local
filesystem, not a network-mounted or cloud-synchronized live database. Stop the
service before copying the complete directory for backup.

The writable product requires Node 22.13.0+ with built-in `node:sqlite`. A missing,
unavailable or corrupt server library causes an explicit startup failure or an
unsaved-edit error; it never creates a new IndexedDB/localStorage authority.
Existing browser content is detected without opening its database at startup.
Only explicit recovery export opens existing browser stores, in readonly mode.
Original rows, malformed legacy bytes and interrupted migration markers remain
untouched. Migration POSTs return 410; historical migration status, receipts and
committed archives remain available through versioned GETs. Recovery never
changes the persisted library namespace or automatically imports browser rows.

Native media reconciliation is scoped to the fully loaded current library UUID.
Even an empty canonical catalog preserves remembered bindings belonging to a
retained browser library. Identical document keys in different libraries do not
overwrite each other's private bindings. Source media files are never deleted.

## Protocol 1

All endpoints inherit the existing bridge's loopback host, origin, Fetch Metadata and no-cache controls. Mutations additionally require an exact Origin and `application/json`. There is no remote submission endpoint.

- `GET /api/v1/library`: discovery, enabled status, immutable library epoch, catalog sequence, byte limits and `browserMigration: "not_started"`.
- `GET /api/v1/library/catalog?protocolVersion=1&limit=50`: key-sorted metadata (including tombstones), at most 100 entries and a 256 KiB entry budget. No document bodies. Continue with returned `next` as `after`, plus the page's `epoch` and `sequence`. A changed sequence/epoch returns 409: restart pagination instead of accepting a mixed snapshot.
- `GET /api/v1/library/document?protocolVersion=1&key=...`: exact stored JSON snapshot and revision token, including recoverably deleted snapshots. 404 means no record. URL-encode keys.
- `POST /api/v1/library/commit`: `{protocolVersion:1, epoch, receiptKey, action, key, expected, document?}`. `action` is `put`, `delete` or `restore`. First creation uses `expected:null`; subsequent writes require the returned `{epoch, revision}` token. `document` is mandatory only for `put`, and `document.key` must match `key`. Maximum snapshot is 8 MiB, maximum request 16 MiB. Keys/receipt keys are at most 1024 UTF-8 bytes. JSON snapshot fields, including unknown fields, notes, translations, result provenance, media references and progress, survive unchanged. This service does not resolve local file paths or reopen media.

The receipt, snapshot/tombstone, catalog metadata and global sequence commit in one SQLite transaction with FULL synchronous durability. CAS checks occur inside the write transaction, including across connections. A successful response is issued only after COMMIT. If a response is lost, retry the **identical JSON envelope** and receipt key: the durable receipt is returned without another write. Reusing a receipt key with different serialized JSON returns 409. Old replay receipts describe the original write, not the current record; fetch the document before editing. Retry does not revive a later-deleted record.

Delete retains the full payload and a higher revision; only explicit restore with the current tombstone token revives it. No purge API exists. Existing keys cannot be silently recreated or replaced after deletion. There is no last-writer-wins fallback. Database/schema failures never reset or overwrite existing data. Startup verifies stored payload identities, byte counts and receipt shapes; later reads and writes also refuse corrupt records while preserving their original bytes. Discovery does not imply browser data was imported, and these receipts do not impersonate existing browser save receipts.

## Client save contract

The default client uses `POST /api/v1/library/batch` protocol 2 with captured
revision and logical identity preconditions, atomic document groups and durable
receipt keys. It advances saved state and native owner lifetimes only after a
validated receipt. A server or connection identity change cannot apply a stale
response. Lost acknowledgements retain their exact retry bytes; a later edit
cannot silently strand an earlier uncertain write.

Discovery includes a stable media-library binding even at sequence zero. The
library epoch, media namespace, document lifetime and revision have separate
roles and must not be substituted for one another. Multi-client startup does not
create or migrate content and does not change any of these identities.
