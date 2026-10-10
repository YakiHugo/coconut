# Consistent reading metadata

## Reproduction

Original reproduction baseline: `f2c877b6d838aeb08d1daee466308288f8569dcf`. Integration also preserves the recoverable-removal bookmark identity guard and excludes blank-only note previews from library search.

A valid transcript with an early cue spanning 0–120 seconds and a later cue spanning 10–20 seconds had a 120-second domain duration, but the shelf, page header and source overview displayed 20 seconds. Validation already requires nondecreasing cue starts; overlapping cues with decreasing ends are supported. This change does not relax validation or reorder cues.

A whitespace-only note and a written note produced two notes in the shelf, reader badge and notes-only filter, but one noted segment in Markdown. Blank annotations also produced empty-looking passage buttons. A whitespace-only timestamp-bookmark note exported an empty quote rather than the existing “未填写笔记” explanation.

## Rules and consumers

- `Coconut.documentDuration(document)` remains the sole document-duration rule. Transcripts use the maximum cue end, not a sum of overlapping intervals or the final cue end. Audio-only projects use known `media_duration`; unknown length is labeled “时长待确认”. Attaching a transcript makes the displayed transcript length describe its cue coverage, even when a separate media duration is retained in the backup. The shelf, duration sort, page header, source overview and passage timeline all use this helper. Actual playback controls continue to display the loaded media element's duration.
- `Coconut.hasNoteContent(value)` determines whether a string contains anything beyond Unicode `White_Space` and BOM (`U+FEFF`). Spaces, tabs, line breaks, NEL, NBSP and ideographic spaces alone do not count. Zero-width characters, joiners, combining marks, emoji and other non-whitespace characters are preserved and are not arbitrarily declared empty.
- `Coconut.segmentNoteCount(document)` counts only source cues with effective notes. Orphan object keys do not become phantom notes. The shelf and full-document note badge use it. The badge explicitly says “片段笔记”; its help text explains that search does not change the total and that project notes/bookmarks are separate.
- Notes-only filtering, shelf annotated filtering and note search, per-cue note buttons/previews, passage annotations, notebook segment selection and Markdown note blocks use the same presence rule. Search-result counts describe matching source cues; notebook export still covers the entire document, independent of the current filter.
- `projectAnnotationCount` counts a nonblank project note once and every timestamp bookmark once. An empty bookmark note does not erase its time anchor. Shelf metadata separately lists project notes and timestamp bookmarks, including after attaching a transcript. Markdown emits a plain “时间书签（未填写笔记）” label for whitespace-only bookmark notes. Blank-only project-note sections are omitted.
- Presence checks never trim or normalize stored note text. JSON exports, restored notes, cue order, cue times and original Unicode bytes remain unchanged. Markdown retains its existing escaping and line-ending formatting for effective notes.

## Editing and bounded rendering

Editing a note updates badge, shelf and export availability immediately. When that edit changes whether the source cue matches the current filter, results and pagination are reconciled immediately while the existing note textarea, caret and close/return controls remain mounted. Typing can restore a disappearing result. Closing returns focus to the note button when still visible, or to the notes filter otherwise. There is no blur-time render that could swallow the next click.

Aggregate metadata scans happen outside individual cue rendering. Ordinary input keeps the existing incremental update unless result membership changes. The transcript remains limited to 100 mounted source rows, including after removing the last note on a later results page.

## Verification

- `tests/reader-metadata.test.mjs`: domain and Happy DOM regressions for legal overlaps, source-order/byte preservation, zero/unknown duration, sort/display agreement, Unicode presence, orphan note keys, project/bookmark distinctions, empty-note transitions, search-result reconciliation, pagination, close/return, export counts and reload.
- `tests/helpers/reading-metadata-fixture.mjs`: authored synthetic fixtures shared with browser coverage. No source downloads or model output.
- `tests/reading-metadata-browser.mjs`: registered in the existing Browser acceptance workflow. Checks native file selection, real JSON/Markdown downloads, imported-byte preservation, desktop/mobile note editing and focus, empty-result transitions, passage annotations, refresh and audio-project metadata. It permits only the local static server and rejects external requests and mutations. Browser execution is delegated to CI; local syntax checks are not a browser pass.

Local and CI verification results are recorded with the exact integration candidate. Browser execution remains CI-only; a local syntax check is not a browser pass.
