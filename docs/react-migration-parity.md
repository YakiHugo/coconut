# React migration acceptance gate

`reader/react-preview.html` is an integration entry, not the completed migration.
The default mature reader stays available until the gate below passes. This entry
loads no `app.js`, `language.js`, `jobs.js`, `podcasts.js`, `background-summary.js`,
`translation-review.js` or `updates.js`. React exclusively owns its DOM. Domain
validation, canonical storage and save receipts are reused; the existing safe deep projection is also exported for immutable store writes.

## Accepted integration boundaries

- App store owns live immutable document identities, document revisions, and
  save tickets. Components submit detached changes with expected key/revision.
- Storage-only notifications do not advance a document revision.
- Preflight happens before replacing live content. Failed saves remain available
  for backup; queued is never presented as durable success.
- Source requests own AbortControllers and cannot apply after cancellation,
  replacement, or unmount. File object URLs are shell-owned, never persisted.
- Source entry opens media directly; transcript files are a recovery path.
- Reader owns playback effects, transcript rendering and selection ranges.
- AI controller owns single-use consent, exact input snapshots and task receipts.
  No mount, navigation or source import automatically sends inference.

## Gate before replacing the default entry

- [x] Root navigation, title-search library, source URL ingestion and cancellation
- [x] Same storage-provider startup and canonical save pipeline
- [x] Local file player without uploads or automatic playback
- [x] React reader/player/selection and React AI/task/review components integrated
- [x] Mounted React regression: ingestion, save, library reopen, stale cancellation
- [ ] Real Chromium visual and interrupted/repeated-flow acceptance
- [ ] Existing full application acceptance and source-first flow matrix
- [ ] Joint review: implemented publisher catalog and URL/RSS episode selection
- [ ] Joint review: explicit local ASR upload, durable operation-ID reconciliation,
  same-operation replay, result/source verification, cancel/retry and playback
- [ ] Joint review: journal Web Locks, exact prior-value/readback fences and
  transcript attachment preserving project annotations
- [ ] Joint review: complete authoritative native owner catalog, token release,
  failed-retirement retry, close/update barriers and active-ingress retirement
- [ ] Joint review: JSON atomic restore and subtitle paste/file/encoding recovery
- [ ] Joint review: library removal/undo, rescue backup, selected backups,
  historical collections, original/translation/note search and notebook export
- [ ] Joint review: AI archive/export, glossary/offline, retained failed-save
  recovery, exact visible scope and document/language-bound translation review
- [ ] Joint review: explicit identity/duration-checked listening resume and
  existing reading-view preferences without content-revision writes
- [ ] Joint review: React canonical migrate/connect/resume/cancel and raw recovery export
- [ ] Desktop native close/update hooks while storage startup is loading or failed;
  current hooks begin only after the ready application mounts
- [ ] Reading appearance/shortcut preferences and saved-summary view restoration
- [ ] Mobile and desktop accessibility/focus/keyboard layout checks

Do not delete the mature entry or claim full React delivery until each applicable
item is implemented, tested, and independently reviewed. Preserve the compatibility
entry only as an explicit recovery path after default cutover, not as hidden DOM
under the new tree.

## Verification available in this environment

The mechanical integration includes reader `d5b4516`, AI `efeb417`, native
`47f39ca`, recovery `7ba91a0`, storage setup `440e8c9`, backend `f897ec0`,
and the root persistence/admission fixes. The storage/browser candidate passed
166 React/domain/production-mounted tests, including frontend lost-ACK recovery
through real Node/Python transport with inference disabled. This is not final
joint review or visual acceptance.

`npm run check:reader-ui`, `tests/react-app-store.test.mjs`,
`tests/react-app-mounted.test.mjs`, AI and reader component tests pass against the
integration candidate. `tests/react-app-browser.mjs` is a localhost-only mocked
browser fixture. The additional `tests/react-production-matrix-browser.mjs`
uses actual Node/SQLite authority with authored provider/native fixtures and
explicit React storage controls. Both are wired into CI, with exact authored
image/JSON artifact allowlists. Chromium could not launch under this executor's socket sandbox;
escalated launch failed before execution. No visual/browser success is claimed.

## Seed podcast catalog

The React discovery page includes a small searchable publisher catalog, not a
claim of global directory coverage or current episode/transcript availability.
Publisher links verified on 2026-10-15:

- TED Talks Daily: https://shows.acast.com/ttd links its RSS at
  https://feeds.acast.com/public/shows/ttd
- Lex Fridman Podcast: https://lexfridman.com/category/ai/ identifies its public
  RSS at https://lexfridman.com/feed/podcast/

No app-source request is made until the user chooses a show. The local acceptance
fixtures mock ingestion; these source links are not evidence of live app fetching
or transcription success.
