# Bounded long-transcript reading

## Reproduced problem

On main `33bb3a8`, following a bookmark, AI citation, or playback position at cue 1,751 of a 1,771-cue transcript rendered all 1,771 cues. Each subsequent note opening, excerpt toggle, or translation-view update rebuilt those preceding rows. The previous “continue reading” action also kept growing the mounted transcript. A paused player's active-cue highlight disappeared after these renders until another media time event.

## Change

- Keep at most 100 transcript rows mounted. Previous/next controls show the range within the current results and move keyboard focus to the first row of the new page.
- Source jumps go directly to the target's page, preserving precise focus. They still clear filters so citations and bookmarks can always be found.
- Search, excerpt/note filters, exports and model-request scope continue to cover the entire document or full matching set. Merely turning a page does not change consented AI scope.
- When removing the final matching excerpt from a later page, clamp to the last valid page instead of showing an empty reader.
- Reapply current playback highlighting after each render without replacing the player or resetting its time.

## Verification

- 66 JavaScript/core/DOM tests and 70 Python tests pass. Four new DOM regressions cover late bookmarks with paused media, complete bidirectional traversal and saved notes, off-page search/AI scope/citations, and final-page removal with keyboard recovery.
- Before the change, the new 1,771-cue regression failed its maximum-100-row assertion; all existing 62 JavaScript tests passed. Existing cumulative-row assertions were updated for page windows while retaining the same exact cue/backup/navigation assertions.
- A synthetic Happy DOM comparison (same 1,771 cues, bookmark at zero-based index 1,750; one warm-up plus five timed runs) mounted 1,771 rows on main versus 71 on the candidate. Median synchronous resume handler time was 372.49 ms versus 24.05 ms in this container. These are DOM-harness measurements, not browser layout/paint or user-device performance claims. The regression asserts the deterministic row bound rather than a timing threshold.
- JavaScript syntax and whitespace checks pass. Static-reader app/style cache hashes updated.
- No browser actions were retried. Actual browser visual/touch behavior, native media decoding and seek accuracy remain unverified for this change. No model inference or credentials were used, and nothing was published.
