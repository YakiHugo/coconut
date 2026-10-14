# Connect an existing computer library

The reader now keeps two explicit choices in Library → backup tools:

- **Migrate this browser library** copies the frozen browser source to the
  computer database and verifies the original migration hash and receipt.
- **Connect an existing computer library** opens an already populated computer
  database without importing, merging, overwriting, or deleting either library.

A new browser or cleared site starts with its own browser library. It does not
silently adopt a discovered server. Choose **连接已有电脑书架** once and confirm the
explanation. Any current drafts or imports must finish first. Local changes are
flushed before connection. The connection reads and verifies the computer's
catalog, then atomically preserves and fences the original browser records.
There is no second migration and no account, token, or remote-server setup.

After connecting, edits use the computer database's revision checks. Reload the
other browser to read those edits. An already-open stale editor cannot overwrite
a newer revision. Original local-only documents are not merged into the computer
library. **导出连接前浏览器恢复文件** downloads their complete original storage
records. This recovery archive is not a normal importable library backup; export
a normal backup before connecting if you want to import selected local content
later. Local audio/video must be selected again; connection does not grant new
native media permissions or silently restore access to local files.

Failures before the local connection transaction commits leave the browser
library usable. Once committed, a lost acknowledgement, offline server, changed
server identity, or invalid connection must not fall back to browser writes.
The reader stays blocked with retry and recovery export. Restore the original
computer service and retry/reload. Do not interpret missing acknowledgement as
cancellation. The original migration path still validates its migration receipt.

## Storage compatibility and verification

SQLite schema 3 adds one stable random media namespace for API-created libraries.
An empty library's first migration initializes that namespace from the verified
browser source. Schema-2 libraries initialize it from their validated committed
receipt. Once any API content has been committed, that namespace never changes,
even if a later compatible migration preserves a different original source identity. An empty, never-migrated database cannot
be connected yet: migrate a browser library or add the first API document.
Schema 1/2 upgrades are transactional and preserve the epoch, documents, ordering,
receipts, and migration archives. Failed upgrades roll back the version and new
table. Earlier binaries reject schema 3; downgrading a binary is not a supported
rollback. Keep a filesystem backup before intentionally downgrading, and use a
schema-3-capable version to reopen this database.

Coverage includes unit tests with real SQLite, independent browser storage
instances, failed connection reads, lost connection acknowledgement, preserved
source corruption, revision conflicts, schema upgrade rollback, stable namespaces,
and corrupt migration manifests. The authored Chromium suite exercises native
IndexedDB and multiple isolated browser contexts against real SQLite, including
nonempty local sources and their recovery downloads, old-tab fencing, restart,
offline service, and replaced server identity. CI must pass on the final commit
before this change is considered verified for merge.
