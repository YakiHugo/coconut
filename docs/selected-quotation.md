# Copy a selected quotation with attribution

The paragraph reader's **引用原文** action creates a local, transient quotation preview. Select continuous original text in one paragraph, including across its cue boundaries, then open the action. Without a selection, use the readonly original-text field and Shift + left/right arrow keys, then **预览所选引用**. A separate explicit copy button writes the complete quotation and attribution to the clipboard. No clipboard reads occur.

## Accuracy and boundaries

- Only original text within one currently rendered paragraph is supported. Mixed translations, notes, controls, separate paragraphs and unrelated selections are rejected, never silently trimmed into a supported range. A newer selection replaces a pointer-down snapshot; snapshots only bridge the focus-induced collapse on the same click.
- Exact selected cue substrings and display separators are preserved, including repeated phrases and CJK text. UTF-16 boundaries cannot split a surrogate pair. No word repair, ellipsis, translation or neighboring unselected content is added.
- Copied attribution includes the document title and original cue time range. The preview explains that time is cue-based; internal cue IDs and repetitive warnings are not part of copied text. Overlapping cues use the greatest included end time. Local playback calibration is not substituted for source timestamps.
- Supported source links use Coconut's existing source policy. Podcast origins are labeled for manual time positioning. Missing source/media and authored demos have explicit explanations; no guessed link, local file path, blob URL or job ID is included.
- Source corrections and document ownership are checked at preview and copy. A changed/replaced source cannot silently become the earlier quote's source. Late clipboard results do not reopen a dialog or steal focus from newer work.
- Browser textarea offsets are mapped back to original CRLF offsets. The automatic clipboard write receives the original CRLF text; this does not promise operating-system byte-level behavior. For CRLF quotations, a short preview hint explains that manual copying uses the preview’s line endings. A selected isolated CR (not a CRLF pair) is explicitly rejected rather than rewritten; the original remains available for another selection.
- Metadata line breaks in titles are displayed as escaped `\r`/`\n` so they cannot masquerade as extra attribution lines.

## Local state and recovery

The feature does not create a saved excerpt, modify notes, alter reading position or change JSON/subtitle exports. It neither changes AI scope nor invokes AI. The existing whole-cue excerpt action remains independent. Closing returns focus to the paragraph action when it still exists, without starting or pausing audio. Clipboard failure preserves a selectable readonly preview for manual copying.

## Integration and verification

`reader/quotation.js` owns composition, selection mapping, attribution and modal state. `app.js` registers each rendered original paragraph and its source identity. The module is declared before app startup, included in Python/desktop static asset whitelists and desktop staging, and covered by reader asset hashes. Packaged asset verification now compares page cache tokens with actual asset bytes, including the quotation module.

Focused Node/HappyDOM tests cover exact text, Unicode, source links, overlapping timing, keyboard/DOM equivalence, invalid and newer selections, CRLF offsets, copy success/failure, repeated clicks, stale source, focus and unchanged document state. Package tests check staging, startup order and rejection of corrupt quotation bytes. Python static-server coverage verifies the new asset is served without model calls.

`tests/quotation-browser.mjs` runs only in CI. It exercises native Range selection followed by real pointer clicks, readonly keyboard selection, modal focus, both viewport sizes, audited clipboard success/failure, and full stored-document equality. Its clipboard methods are fixture-controlled: no host clipboard is read. A syntax check or DOM test is not a successful Chromium run. No browser or Electron execution is part of local verification in the restricted task environment.

This is quotation reuse, not persistent exact-text annotation. That separate feature requires versioned snapshots plus notebook and backup/restore work; this change deliberately adds no storage field.

Readonly selection compatibility: Chromium may focus readonly text controls without moving their native selection on arrow keys ([Chromium issue 40903304](https://issues.chromium.org/issues/40903304), comments 7 and 12, and its linked follow-up 382291453). The official issue identifies this as form-control selection behavior; the CI failure is consistent with it, not a local browser reproduction. The original-text picker handles only unmodified Left/Right, Shift+Left/Right and Ctrl/Meta+Home/End, moving selection over grapheme boundaries without editing text. Other shortcuts retain browser behavior. Native CI still drives real keyboard events and checks the exact selected source before preview.
