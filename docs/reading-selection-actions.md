# Contextual reading actions

The existing warm reading palette and transcript-first flow remain. Reading
settings, AI scope previews, summary text and saved annotations use spacing and
single separators instead of nested cards. Inputs and floating surfaces retain
clear boundaries. No fonts, models or external assets are downloaded.

## Select, inspect, confirm

- In continuous reading, select an exact continuous range of original text. A
  small React action bar offers **解释所选** and **翻译所选**. Selecting alone does
  not request a model. Escape and scrolling dismiss the bar.
- Keyboard users can open **引用原文**, select text with Shift + arrow keys, and
  preview it. The same two actions appear inside that existing modal.
- Both actions open the existing single AI composer. The exact target is shown
  separately from the complete containing source cues, which are sent as context.
  This is explicitly disclosed; it is not a selected-characters-only payload.
- Translation is a question about the selected words. The result enters existing
  AI history; it never replaces a saved transcript translation or original text.
- The question editor contains the editable instruction only. The immutable target
  is composed at the request boundary, so native textarea CRLF normalization does
  not alter it. Return to reading/Escape retains this selection draft behind the
  existing return-to-question action; reopening always requires fresh consent.
- Provider, model, scope and consent controls remain owned by the existing
  composer. A source edit, detached paragraph, document switch or invalid range
  cannot reuse the capability. Stale selections require a fresh selection rather
  than silently refreshing the words underneath the original target.
- Existing history records retain the exact target in their question and the
  complete source snapshot in their existing format. No document schema changes.

## Reference review

- https://paper.design/mono was inspected in the cloud browser on 2026-10-14.
  Its strong primary content, shared alignment and restrained hierarchy inform
  the use of whitespace here, without copying its typeface or decorative grid.
- Official Doubao desktop-page indexed documentation describes selected-text
  search, translation and explanation:
  https://www.doubao.com/download/desktop?ug_utm_source=104 . Its live page on
  2026-10-14 instead promotes the new work mode; the old selection UI was not
  presented as a currently verified live screenshot. This implementation adopts
  the documented select-then-act interaction, not an asserted visual replica.

## Verification

`reader-selection-actions.test.mjs` covers exact repeated/unicode text, crossed
cue boundaries, invalid mixed selections, stale snapshots, keyboard fallback,
React portal ownership and explicit-consent-only requests using authored replies.
The static-web browser suite captures contextual actions and request previews at
320, 390 and 1360 pixels. CI screenshots must be reviewed on the final PR head;
DOM checks are not a substitute for those browser results. No live model is used.
