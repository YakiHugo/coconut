# Visible saves and recovery

Ordinary note, bookmark, source, reading-view and transcript edits update the
in-page document immediately. A compact header label shows `保存中` until a real
write receipt acknowledges that generation, then `已保存`. A burst coalesces with
250 ms debounce and a one-second maximum wait. Clean document navigation writes
only the independent window selection preferences, never the document library.

The legacy writer still serializes the **whole library synchronously** and writes
one localStorage value. Queueing reduces writes; it does not solve storage
capacity, make serialization asynchronous, or add IndexedDB. Read-before-write
comparison and the migration fence fail closed but are not an atomic cross-window
compare-and-swap. Unreadable original data is never overwritten by this page.

Failures remain visible with their actual reason: quota, denied access, changed
library, migration fence, unreadable data, cancellation or identity mismatch.
`重试保存` retries current in-memory generations. `导出未保存文档备份` downloads all
dirty identities, with their complete transcripts, notes, translations and AI
histories, as an additive-restorable library backup. This does not acknowledge a
save. Unsubmitted form drafts and the separate one-slot removed-document backup
remain explicitly separate and keep their own close protection.

## Receipt contracts

- `queueDocument(doc)` registers the exact live object and returns an accepted
  ticket with a `committed` Promise. Acceptance is not persistence.
- `commitDocument(doc, kind, options)` forces a flush and returns the ticket's
  structured receipt. Only `receipt.ok` means the captured generation was saved.
- `commitDocuments(documents)` registers all members atomically before any
  subscriber can begin a whole-library snapshot, then awaits their receipts.
- `add(...)` and `attachTranscriptToProject(text, target)` return a receipt whose
  `identity` is the actual inserted/replaced document, including on writer
  failure. Callers must check `.ok` and exact identity after awaiting. They must
  not use Promise/object truthiness or mutate whichever document is now active.
- Transcript attachment still requires the explicit captured project identity,
  source and current read workspace. Reusing it for a new discovery workflow
  requires an explicitly resolved target and its own ownership contract; merely
  enabling same-source metadata refresh does not attach a transcript.

AI count/job evidence is captured before the writer can yield, then applied by
exact document identity. A receipt cannot acknowledge an answer appended later
or clear a newer note/draft. AI plan/batch saves must succeed before the next
request, with identity, scope, source, provider and consent rechecked after every
await. A retired owner cannot restart after removal or native close release.

## Structural operations

A pending removal has its own recovery/draft bundle. It retires old async owners
immediately, while the previous one-slot backup remains untouched until a real
successful receipt. Other documents stay editable. Failure reinstates only that
operation's identity/index and associated drafts; concurrent edits and newer
selection/focus survive. Selection preferences change only after deletion is
persisted, unless the user independently navigates during the wait.

Undo inserts a reserved provisional identity. Its library and search-hit entries
are disabled, and all navigation paths reject it until persistence succeeds.
Failure removes only that provisional identity and retains the existing complete
recovery bundle. Success cannot navigate away from a newer document or input.

The coordinator's optional structural `rollback(receipt)` callback is synchronous
and operation-owned. It runs only on terminal failure/cancellation, before
receipt observers or a successor capture. Returning exactly `true` requests
baseline reconciliation, which additionally checks current identity, generation
and operation ownership after the callback. Throwing or returning a Promise
fails closed. A successful writer is never rolled back or relabeled as failed.

## Close and update

Read-only inspection separates pending content, failed content, unsubmitted
drafts/recovery and active requests. Pending-only native close flushes first,
without asking to discard. Final close/update share a pending-to-locked owner and
its completion Promise. Pending finalization disables page interaction immediately.
Already queued note/input-method events remain draft-protected and resume as new
content generations on release, so an older receipt cannot close over newer text.
Release/timeout retires that attempt synchronously;
late work cannot lock or release a newer attempt. Approved discard waits for the
actual current writer's abort/commit acknowledgement. The final listening clock
is flushed before `readerClosing` becomes true; its independent storage failure
does not masquerade as a transcript failure.

Web visibility/pagehide request an early flush. `beforeunload` is a last-resort
warning, not a promise that asynchronous work will complete at shutdown.

## Verification

Deterministic coordinator, real-adapter HappyDOM and extracted native-main tests
cover delayed writers, failure at each checkpoint, atomic restore, capture/count
races, rollback and newer edits, draft bundles, retry/rescue, provisional Undo,
retired native attempts, late aborts and final listening order. Existing behavior
assertions remain, with persisted-state checks awaiting their actual receipts.

`tests/save-pipeline-browser.mjs` and expanded native update acceptance fixtures
are CI-only. They check actual download bytes and reload storage, rather than
accepting a DOM label as disk evidence. Local test success does not claim these
browser/native executions have run; CI must pass for the exact published commit.
