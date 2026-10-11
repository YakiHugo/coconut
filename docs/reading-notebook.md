# Reading notebook: product decision and verification

Date: 2026-10-04. Base: merged PR #10 (`d5464f1`).

## Evidence and decision

First-party product references checked on this date:

- [Readwise Reader videos](https://docs.readwise.io/reader/docs/faqs/videos): timed transcripts, annotations and precise return to a source moment.
- [Readwise highlights and notes](https://docs.readwise.io/reader/docs/faqs/highlights-tags-notes): lightweight capture and later retrieval of passages, separately from personal notes.
- [Snipd](https://www.snipd.com/): one-tap capture and export of saved podcast insights with transcript and metadata, including Markdown.
- [Ghostreader](https://docs.readwise.io/reader/guides/ghostreader/overview): document- or selection-scoped AI reading with links back to evidence.

The published Coconut reader was inspected in the cloud browser. It supported notes and JSON backup, but a reader could not retain an interesting passage without writing a note, or export a human-readable collection of their reading work.

Chosen improvement: complete the **read → retain → revisit → reuse** flow. Saving a whole cue is useful without a model, paid inference or a server, and preserves Coconut's existing source identity. This iteration does not guess chapter titles, rewrite transcripts or introduce another reading panel.

## Behavior

- `saved_excerpt: true` is an optional segment annotation. Only the literal boolean is accepted when restoring a document. Missing fields remain compatible with existing JSON and subtitle inputs.
- Excerpts, text notes and reading position are independent. Removing an excerpt never deletes a note or source text. Corrections retain the original text and excerpt identity.
- All / Excerpts / Notes are separate views. Existing notes-only semantics remain unchanged. Search, AI filtered reading and subscription-translation selection use the same excerpt filter; changing that selected scope clears consent. No excerpt is automatically sent to any model. Switching AI reading between current-filter and full-document scope immediately revokes consent for both shared AI actions. It also stops already queued subscription batches after the in-flight batch, even if consent is checked again before that batch finishes.
- “Export reading notes” creates a local Markdown download only after a user click. It includes every excerpt or non-empty note in the active document, once and in source order, even when search hides it.
- Export includes stable cue IDs, time ranges, safe supported-platform source links, source text, correction history, personal notes, and the currently displayed translation only if still valid. Translations are explicitly marked as machine-generated. Stale translations are excluded with an explanation.
- Text is escaped before Markdown serialization, including HTML, image syntax and links in untrusted content. Local media paths/job IDs are not exported. The Markdown is for reading and organization; JSON remains the restore format.
- Storage warnings remain visible after conflicting-tab or quota failures. Unsaved excerpts remain recoverable through the existing JSON backup. Download notices only confirm a request, never disk persistence.

## Verification

- 62 JavaScript/core/DOM tests pass, including 10 new notebook regressions and 2 consent-scope regressions. Against the unchanged `d5464f1` reader, the original 50 pass and the first 10 new tests fail. The two additional scope tests reproduced the independent-review finding before the fix and pass afterward.
- 70 Python tests pass, including HTTP/job/source and subscription-policy regressions.
- `git diff --check` passes. Script/style content hashes are refreshed for the static reader.
- New automated cases cover strict schema restoration, reload/JSON round trips, note-only compatibility, independent reading position, edit cancellation, repeated toggles/removal, >100-cue navigation and switching documents, export scope, storage conflict/quota recovery, safe Markdown and stale translations, and exact sparse AI selection.
- Current public reader was inspected in a real cloud browser to verify the pre-change gap. The new code has DOM-level coverage only until publication: local browser access, file-picker and download-record restrictions were not retried or bypassed. New-code browser visual/touch behavior and browser-to-disk download acceptance remain unverified.
- No real subscription inference, paid request, credentials, user-computer operation, private-content publication or deployment was performed for this change.


## Unsaved Web reading changes and reload (2026-10-08)

In ordinary Web browsers, notes still save synchronously on input. If document persistence fails (including a
stale-tab conflict), a best-effort browser leave/reload confirmation is installed
while this page has unsaved document changes. Changed transcript, source-link and
document-details dialogs receive the same protection until saved or canceled.
Merely opening a dialog, selecting a book, or running a background task does not
trigger it. Saving successfully removes the listener; reverting a dialog field to
its stored value also clears its draft protection.

This does not merge tabs or save conflicting content automatically. Keep the
existing export-before-refresh warning and export each changed document first.
[MDN's beforeunload guidance](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event)
requires prior user interaction and allows only browser-provided prompt text.
The event is unreliable on mobile and cannot protect against a killed process.
DOM regressions cover listener lifetime and cancellation; a native Chromium
prompt after real user activation is exercised by `tests/reader-unload-browser.mjs`
in the browser CI workflow. The script checks dirty reload/dismiss, a recovered
clean reload, unchanged/canceled editor drafts and two-tab conflicts. It has not
been launched locally in this environment; CI must establish the browser result.

The desktop Electron preload capability disables this Web-specific listener.
Desktop update/restart checks remain unchanged; this change does not add desktop
close/quit protection. Native close coordination needs a separate lifecycle change
so canceled quit cannot leave the window open after its local services shut down.
The existing Electron CI update test verifies the Web listener stays absent with
both a changed title draft and a failed note save, while update safety still blocks.

## Exact-text excerpts alongside whole-cue annotations

The paragraph quotation preview now has an explicit **保存所选摘录** action.
It saves only the selected text as an immutable historical record, including its
exact composition/range, captured context, corrections and source attribution.
**整段摘录** remains the independent `saved_excerpt` cue annotation and reader
filter; exact records do not silently enter the current transcript's search,
filtered reading or AI scope.

The library notebook includes both record types, clearly labeled. Its existing
cooperative query cancellation, paging and selected-document Markdown export
also apply to exact records. Exact-only documents count as annotated. Details
retain captured text/title/context even when the current source changes or is
removed. Current-source navigation uses only surviving, same-order contiguous captured
cue IDs. Text or title corrections keep a clearly labeled route to the current
corresponding source and a historical-change warning. Missing, reordered or
interrupted cue sequences remain unavailable; no fuzzy reattachment is attempted. Removing an exact record leaves
whole-cue annotations, notes, text and other exact records untouched.

Repeated saves of the same captured snapshot and range share one record. The
quotation action shows saving, saved or unsaved/retry based on its own document
receipt. Closing or selecting newer text retires that operation's focus and
status ownership. Native browser persistence/reload checks are authored in the
CI-only quotation acceptance script; local focused DOM checks are not native
browser evidence. Complete restoration needs JSON and a reader supporting the
new field; see [backup recovery](backup-recovery.md#exact-text-excerpt-snapshots).

## Notebook presentation

Collapsed records show a short, three-line preview. Expanding a record hides that
preview and shows one complete source quotation, with a separate personal note
when present. Preview clipping never changes saved text or exported content.
Exact excerpts label the saved title, source time range, source attribution and
capture time separately; the current shelf title identifies the owning document
without replacing historical attribution. Full historical context and correction
records remain available in their own initially closed disclosure, with bounded
progressive expansion for long snapshots. Document and record identifiers remain
available under optional **技术信息**, rather than taking space in the reading view.

Stable data attributes support automation without relying on visible UUIDs.
Disclosure changes preserve keyboard focus, and notebook selection, paging,
source navigation, removal and complete export semantics remain unchanged.
Native CI screenshots cover ordinary notes, whole-cue excerpts and exact excerpts
in collapsed and expanded layouts. Local DOM coverage is not a browser result.

## Personal notes on saved quotations

An exact quotation can carry a separate personal thought without changing its
saved wording, source attribution, capture time, or historical context. Editing
the thought does not change whether its source is current, stale, or missing.
Saving the same quotation again reuses the record and keeps its note.

Personal thoughts participate in library-notebook search and the note filter.
The quotation remains a single capture under both note and excerpt filters.
Empty or whitespace-only notes are preserved in JSON but do not appear as
nonempty notes. Shelf title search remains unchanged. Shelf notes scope includes
these personal thoughts; full-text scope also includes the selected historical
quotation. Live-transcript search, reader note-only filtering and AI evidence
scopes remain unchanged. Saved shelf previews are a separate bounded group,
with complete record retrieval continuing through the notebook.

### Implementation contract

`exactExcerptNote(doc, id)` is a tolerant own-property string accessor returning
an empty string for an absent note; it does not establish live record ownership.
Editing UI must separately retain the exact document and record objects.
`exactExcerptNotesWith(doc, id, text)` verifies the target exists, validates the
existing sidecar and returns a fresh null-prototype map. It preserves the string
exactly, including an empty string. Assign that map to the existing document's
`exact_excerpt_notes` property, then use the ordinary durable save pipeline.
Never mutate an already-published sidecar map in place.

`exactExcerptRemoval(doc, id)` returns only the two-field patch
`{exact_excerpts, exact_excerpt_notes}`. An undefined value means the field can be
deleted. Apply both fields synchronously to the original live document before
queuing one save. The helper never mutates the input collections or recreates
surviving frozen records. This keeps note cleanup atomic and unrelated
whole-cue notes, bookmarks and quotations intact.

Cooperative notebook search observes sidecar identity; activating a prior
capture also compares its note string. A changed thought retires that result
without making the historical source stale or guessing a replacement location.


### Historical shelf result ownership

Shelf saved-quotation hits carry a typed exact-record capture key, not a cue ID.
The current shelf title identifies the owner; the record keeps its captured
attribution. Search covers only selected saved wording and nonempty personal
notes, never captured surrounding context or prior corrections. Distinct
quotation identities remain distinct even when their wording is identical.

The shelf prepares at most three saved previews per matching document and a
complete total before publishing its selection. Current-source previews retain
their own three slots. A matching quote and personal note appear as one record
with separate snippets. Empty/whitespace-only notes retain their raw stored
strings but cannot produce a note match or snippet. Source correction/deletion
does not remove a saved quotation; deleting the quotation or its owning document
does. See `cooperative-library-search.md` for the identity/freshness API and
measured scheduling limits.
