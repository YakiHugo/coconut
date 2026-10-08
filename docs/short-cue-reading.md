# Short subtitle reading density

The actual `e9c5100` mobile CI capture showed three 0.8-second bilingual cues
occupying almost an entire 844px viewport. Repeated block language labels,
secondary actions, wrapping loop controls and row padding dominated the text.
The existing reading-notebook and keyboard-continuity decisions require exact
source identity, lightweight annotations and restored keyboard position.

This change preserves every cue and timestamp. Only cues no longer than three
seconds with short source AND displayed translation receive compact spacing and
inline language labels. Text must be single-line, at most 160 characters and at
most 100 estimated width units (characters above Latin-1 count double). This
conservatively excludes long Chinese paragraphs as well as long English or
translated text. Stale translations and translation-quality warnings retain the
full existing treatment; text font sizes and reading comfort settings remain.

A visible note action stays beside a native `details` disclosure labelled 更多.
Correction, excerpt, bookmark and loop remain per-cue actions inside it. Saved
excerpt and active loop states are visible in the disclosure label. A timestamp
still seeks directly; source links and saved notes remain visible. Mobile touch
targets remain at least 44px high. Open disclosures survive same-document renders;
secondary-action focus restoration opens the corresponding disclosure. No cue
merging, source mutation, AI scope or new persisted data is introduced.

Verification: 267 JS/core/DOM tests pass, including seven dedicated regressions
for cue identity and language boundaries, disclosures and keyboard continuity,
precise seek/loop range, filter/document isolation, CR/LF/Unicode line breaks,
and available-action ARIA labels. The first two dedicated
regressions fail against the original app. Asset-token and JS syntax checks pass.
Browser acceptance now opens real visible disclosures before secondary actions,
and the dock scenario checks three-cue density, touch targets and keyboard
operation and captures an expanded-action mobile screenshot.

No local browser was launched. New pixel layout and the added browser assertions
await GitHub CI and independent inspection of its actual screenshots. Passing
DOM tests alone is not visual acceptance.

## Actual CI and viewport follow-up

The c76702b GitHub CI capture demonstrates the denser bilingual mobile layout
and passes the real touch/keyboard checks. It also exposes a viewport jump after
saving an excerpt: only the current cue's lower actions remain visible. Rebuilding
the transcript permits browser scroll anchoring to change the cue's position;
focus restoration alone does not preserve the source context.

Short-cue excerpt/bookmark actions now retain the surviving original cue's
pre-render viewport position. Filtered-out cues keep the prior replacement-focus
behavior. This is local to those actions, with no global scrolling changes. The
browser scenario records geometry before/after opening and saving, including the
actual click target, then asserts the original, translation, disclosure and
action remain above the dock after two animation frames. It captures before
asserting and does not scroll to repair the screenshot. The correction awaits
new CI pixels; no local browser was launched.
