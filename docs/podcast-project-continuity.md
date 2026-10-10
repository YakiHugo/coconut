# Discovery keeps an episode in its resolved project

A discovered episode is resolved by normalized feed URL plus episode ID. Direct
media uses its normalized public media URL. Titles, list order, the active reader
and transcript text are never sufficient to choose a project.

- A single matching project is selected in the discovery row. Saving audio then
  returning to discovery to import words attaches the real transcript to that
  exact project key, preserving title, explicit user language overrides, notes, bookmark IDs and media.
  An unedited feed/episode language is only a hint: the selected transcript
  language wins when present. A real language edit in project Details records
  `project_language_override: true`, surviving JSON/reload; title-only edits do
  not create this marker. Explicitly clearing the language records the user’s
  unknown-language choice and preserves the empty value, without a truthy fallback. Legacy projects
  without this evidence also prefer the transcript language.
- If multiple legitimate backups share the source, the row requires an explicit
  version choice. “单独导入” creates a distinct version, including for identical
  transcript bytes. Other versions remain unchanged.
- An existing transcript is reopened without another publisher import or changes
  to its edited words, translations or histories. The row explains that a new
  transcript version requires “单独导入”.
- The local JSON/SRT/VTT attachment path still requires the current reader project.
  Discovery has a separate request/navigation owner, plus the exact captured
  target object and source snapshot. Cancellation, source edits, newer navigation,
  removal/Undo and replacement retire the old operation.
- Publisher words can only attach to matching episode, enclosure URL and media
  kind. Changed media is rejected for attachment; rediscover and save the updated
  audio source explicitly, or import a separate version. Metadata-only refresh
  never replaces transcript segments or silently changes their source.

## Preview ownership and listening

The downloaded preview has its own bounded Blob URL, media identity and sampled
file fingerprint. A successful same-media match moves that URL's sole ownership
to the reader. The preview player is paused and removed; the reader receives the
same URL and a paused position after metadata loads. This performs no new network
request, autoplay, recognition, translation or summary request.

A selected reader attachment, including a local file, always wins. Media and
selection revisions captured at the synchronous project mutation prevent a late
save receipt from overriding a newer file selection, detach or navigation. A new
preview/discovery can only revoke the URL it still owns. Reader removal/detach
continues to own reader URL cleanup. Source URL/type changes invalidate old
publisher attachments; local files remain deliberate user selections.

The original project key keeps the independent listening record and live player
through transcript attachment. Listening identity is still a sampled candidate,
not a cryptographic whole-file identity proof. Reload never downloads or plays
media automatically. Explicit reacquisition followed by explicit Resume is needed;
Blob URLs and bytes are never stored in project or library backups.

## Persistence and verification

Only `receipt.ok` confirms storage. Failed attachment leaves one complete live
project, with annotations and transcript available to retry or export through the
existing recovery controls. A receipt cannot move navigation or preview ownership
after a newer selection. See [save contracts](library-save-pipeline.md).

`tests/reader-podcast-continuity.test.mjs` runs production reader code and the real
legacy adapter in HappyDOM. It covers exact-target version selection, separate
imports, stale owners, URL/type changes, direct media, preview ownership, local
file precedence, delayed and failed writes, listening records and rescue.

`tests/podcast-continuity-browser.mjs` is wired into Browser acceptance CI. It uses
an authored 40-second WAV and injected publisher endpoints, verifies decoding,
paused time retention, one media request, actual project/library JSON downloads,
reload and explicit listening resume. It rejects model endpoints and all autoplay.
No local browser/Electron execution or real model quota is needed for authoring;
real-browser acceptance must pass in CI for the exact published commit.
