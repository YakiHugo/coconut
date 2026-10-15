# React application contracts

The frontend migration is complete. The former preview and compatibility documents are removed. This document records the behavior that the React application must preserve; it is not a promise to support the retired DOM interface.

## Ownership and persistence

- The app store owns immutable document identities, revisions and save tickets. Components submit detached changes against an expected key/revision.
- Storage-only notifications do not advance content revisions. Admission checks run before replacing live content; failed saves remain exportable, and queued writes are not shown as durable success.
- Canonical adoption, binding, cancellation and unknown receipts use explicit review, authority checks and recoverable frozen states. Original/raw recovery export stays in React.
- Shared domain validation and lossless unknown-field preservation remain tested. Removing UI compatibility does not remove data integrity checks or erase existing browser/native data.

## Source-first reading

- Podcast discovery, source links and original audio/video are the primary entry paths. Subtitle files/paste and JSON backup restore are secondary recovery tools.
- Source requests and pickers have cancellation/lifecycle ownership; old results cannot replace newer choices. File object URLs are temporary and never persisted.
- React owns playback, summaries, source citations, exact selections, annotations and preferences. Playback and remembered-media restoration never start sound automatically.
- Local ASR jobs require explicit consent and a configured executor. Durable operation identities reconcile lost acknowledgments without filename-only adoption or automatic duplicate submission. Missing dependencies/models are reported rather than downloaded implicitly.

## AI and desktop lifecycle

- AI requests bind consent to exact source/model/identity snapshots. Navigation, mounting and importing do not automatically infer.
- Failed or stale results retain appropriate recovery/export paths; task resume and cancellation retain attempt identity and acknowledgment semantics.
- Native file commands retain real user activation, trusted document ownership and bounded receipts. Pending pickers, drafts and storage work participate in close/update barriers.
- Remembered media is associated only with a complete authoritative owner catalog. Replacement/removal releases the exact old reference without deleting original files.

## Verification

The default source-first Chromium suite covers desktop and compact widths. The production matrix covers actual Node/SQLite restart, CAS, lost acknowledgments, storage adoption/recovery, consent-bound authored AI, subtitle encoding, preferences, keyboard/focus and media layout. The packaged macOS suite covers real native menus, chooser, original media, notes/backups and close/restart. Separate offline Node/Python tests cover ASR operation transport without inference.

Tests solely for the retired renderer are removed rather than counted as React evidence. Shared domain/backend tests remain where they still protect production behavior. Final CI and inspected screenshots must belong to the exact change being merged; prior migration evidence is historical only.

## Podcast catalog

Discovery provides a small publisher catalog rather than a global directory. TED Talks Daily and Lex Fridman publisher feed links were verified on 2026-10-15. Selection initiates source discovery; catalog presence does not guarantee current transcripts, platform access or transcription success.
