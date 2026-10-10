# Reading shortcuts and keyboard continuity

## Continuous reading and listening

The reading utility row always includes **快捷键**. Its native modal lists six
character shortcuts and an opt-out setting, saved only in this browser:

| Key | Action |
| --- | --- |
| `/` | Open the existing original-text search, including from passages or summary |
| `J` / `L` | Seek the attached player back / forward 10 seconds |
| `K` | Pause / continue the attached player |
| `G` | Locate its current source cue without starting playback |
| `?` | Open shortcut help |

Within the search field, Enter / Shift+Enter invoke the existing next / previous
match actions and focus the matching cue, including across pages. Empty searches
do not consume Enter. These non-character actions remain available when character
shortcuts are off. The transcript and passage articles are native Tab stops, so
readers can leave control focus and use shortcuts without a mouse.

### Boundaries

- Character keys apply only to the active reading workspace's text or empty page
  focus. Inputs, editable ancestors, buttons, links, native media controls, ARIA
  widgets, sidebars, dialogs, and the Add workspace retain their existing keys.
  Native close/update locks and inert reading roots also reject body/document
  keyboard events without consuming them.
- Composition sessions, `isComposing`, legacy IME key code 229, repeated keydown,
  prevented events, Ctrl / Meta / Alt / AltGraph and unrelated shifted keys are
  ignored. Space, arrows and system combinations are unchanged.
- Help uses native dialog focus containment and Escape dismissal. It restores
  the prior connected focus target, or its visible opener if that target was
  replaced. No input is auto-focused, including on mobile. Help does not pause,
  seek, replace, cancel, or start media.
- The existing skip, play and locate handlers remain the single source of
  playback actions. K retains an unfinished paragraph preview's end boundary;
  J / L release preview / cue-loop ownership just like their existing buttons.
  G only locates a real cue on a loaded, usable player, including off-page cues.
- No attached usable media means media keys are ignored. No key downloads media,
  opens an external source or invokes AI. Saved notes and reading bookmarks are
  unchanged by shortcut navigation.
- Disabled character shortcuts do not cancel browser defaults and their
  `aria-keyshortcuts` hints are removed. Firefox uses `/` for Quick Find; turning
  Coconut shortcuts off returns that key to the browser. The help button remains
  available to re-enable them. Storage failure applies the setting for this page
  and reports that it was not saved.

The design follows [WCAG character-key shortcut guidance](https://www.w3.org/WAI/WCAG22/Understanding/character-key-shortcuts.html).
Browser conflict reference: [Firefox Find and Quick Find](https://support.mozilla.org/en-US/kb/search-contents-current-page-text-or-links).
Event handling reference: [KeyboardEvent](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent).

### Verification boundary

`tests/reader-keyboard.test.mjs` covers the shortcut dispatch, all guarded contexts,
search/page transitions, notes/bookmarks, one-player ownership, bounded preview,
help focus restoration and persisted opt-out with Happy DOM. Combined-stack
regressions also keep unsaved glossary/bookmark drafts across keyboard navigation,
block shortcuts in removal/backup dialogs, separate preview and main listening
checkpoints, and verify native-close flushing before the exit lock. That is not evidence
of native keyboard, screen-reader or media decoding behavior.

`tests/reading-keyboard-browser.mjs` is wired into the existing Browser acceptance
CI job. It uses authored text and WAV audio, real Chromium keyboard operations,
modal Tab / Shift+Tab / Escape, native media and mobile viewport checks. No local
Chromium or Electron is required or claimed for this change; the browser verdict
must come from CI for the final submitted commit. The tests never invoke AI.

## Historical correction focus fix


## Reproduced issue

On the PR #12 tree (`3385bfd8572a140b9eb932e8afbc2aa5e051944d`), saving a text correction closes the dialog and rebuilds the transcript. That removes the original opener and loses the reader's keyboard position. The regression reproduced this both on a later page and when a correction removes the current search match. The dialog also lacked an explicit accessible name.

## Change

- Return keyboard focus to the corrected cue's replacement edit button after saving, without changing the current search or page.
- If the cue no longer matches, use the next remaining cue at that visible position, or the last remaining cue. If there are no results, return focus to search. Existing page clamping still applies when the last page disappears.
- Name the correction dialog with its visible heading and explicitly designate the text editor for initial focus.
- Keep native dialog Cancel/Escape behavior and the existing original-text preservation unchanged. No new controls or styling.

## Verification

- The first three new DOM regressions failed against the unchanged implementation: later-page focus, filtered-result focus, and accessible dialog metadata. They pass after the fix.
- A fourth regression covers final-page collapse, repeated corrections, and empty-text validation.
- All 70 JavaScript/core/DOM tests and 70 Python tests pass; JavaScript syntax and whitespace checks pass. The app cache key is refreshed.
- DOM automation verifies the application-managed focus target and HTML metadata. No browser actions were attempted; native dialog focus restoration, actual Escape/Tab behavior, screen-reader output, and visual behavior remain unverified in a real browser.
