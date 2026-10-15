# React default-entry cutover candidate

This isolated candidate replaces `reader/index.html` with the React entry. No legacy DOM renderer is loaded beneath its root. The prior page is retained byte-for-byte as `compatibility.html` (apart from subsequent shared-asset cache-token refreshes). Compatibility is explicitly opened through recovery links and never silently selected on startup failure.

## Evidence boundaries

- `test:react`, `test:react-browser`, and `test:react-matrix` exercise the new default entry. The browser matrix uses authored content, real Node/SQLite persistence, and fake model/native receipts. No live model or remote media inference is required.
- Legacy DOM unit tests and legacy browser fixtures explicitly use the compatibility document and retain their assertions. Their green status is compatibility regression evidence, not default React acceptance.
- The existing packaged native reading/media suites explicitly navigate to compatibility after observing the default React application. A separate default packaged acceptance suite must pass before this candidate is releasable.
- Every HTML dependency graph is cache-token checked and verified during packaging. The same-origin native bridge only admits the explicit root, index and compatibility document URLs.

## Outstanding release gates

Native File commands and update controls are now connected to React-owned controls. All three file pickers hold synchronous ownership until cancel or accepted asynchronous work settles; stale inputs and newer source intents cannot import old choices. The separate default packaged suite and real theme browser checks are wired into CI. The candidate is not ready to merge until independent review is clear and all relevant CI passes at the final exact commit. Default-feature review and the current preview repair are separate frozen trees.
