# Keyboard continuity after corrections

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
