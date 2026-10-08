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


## Unsaved reading changes and reload (2026-10-08)

Notes still save synchronously on input. If document persistence fails (including a
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
