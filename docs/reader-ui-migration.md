# Incremental reader UI migration

The first React + TypeScript boundary is **transcript navigation**, replacing the
passage time slider and the transcript's sampled native select with one compact
“浏览全文” entry. The dialog presents 40 source previews per page, exact time jumps,
and routes to the existing full-text search and chapter directory. It does not
introduce another search engine, summary requirement or always-open side panel.

## Ownership

- `frontend/transcript-navigator` owns only its dialog, pagination and error text.
- `window.CoconutTranscriptNavigation` is an intent adapter in `reader/app.js`.
  It returns frozen bounded previews, never live documents or database handles.
- Existing reader functions own navigation, view memory, chapter editing, search,
  media, content ingress, IndexedDB, save receipts and recovery.
- A session is fenced by exact document identity, segment-array identity and the
  active-selection revision. Preview jumps also verify cue identity/text/times.
  Navigation does not play media or change explicit saved reading bookmarks.

A rewrite would simultaneously replace the proven persistence and selection
boundaries. This island establishes a typed boundary and modern build checks
without taking that risk. Later surfaces can migrate behind similarly narrow
adapters; do not lift the document store into component state as a shortcut.

## Build and distribution

`npm ci --ignore-scripts`, `npm run build:reader-ui`, then
`python scripts/reader_assets.py` generate the self-contained production bundle
and content-hash token. React, React DOM and Scheduler MIT notices are embedded.
`npm run check:reader-ui` checks strict types and byte-for-byte build parity.
Dependencies are locked; the browser needs no npm, module resolution or CDN.

The checked-in bundle is loaded independently of storage admission. Only a
successful component mount enables replacement CSS. If it fails to load, the
existing slider/select remain usable and storage bootstrap can still finish.
The Python server, lightweight server, static preview and desktop resource
staging all include the same bundle.

## Acceptance

- `tests/reader-transcript-navigator.test.mjs`: adapter ownership/fencing,
  bounded snapshots, same-mode navigation, search/chapter routing, production
  React DOM mount and fallback markup.
- `tests/transcript-navigator-browser.mjs`: production IndexedDB startup, narrow
  and wide layouts, time errors, exact source jumps, focus/Escape, existing
  search/chapter ownership, and failed-bundle fallback.
- Existing browser journeys now navigate through the visible dialog instead of
  steering hidden legacy controls. Their media/selection/save assertions remain.
- Browser screenshots are authored fixtures only and are uploaded by the existing
  browser acceptance workflow. Real browser acceptance must pass before merge;
  DOM replay is not evidence of geometry or browser focus behavior.
