# Contextual transcript translation

## Why a cue is not a translation unit

ASR chunks and display subtitles often end halfway through a sentence. Treating
those fragments as independent sentences loses subjects, negation, pronouns and
terminology. Passing 32 independent strings to OPUS in one CPU batch does not
supply cross-string attention or make that model document-aware.

The no-additional-API-fee implementation uses the user's explicitly selected,
already-authenticated local Codex/Claude CLI. It consumes that subscription's
allowance only after the existing per-request consent. It does not install a
model, buy allowance, add an account grant, or fall back to an API.

## Practices adapted from localization teams

- [Godot's gettext workflow](https://docs.godotengine.org/en/stable/tutorials/i18n/localization_using_gettext.html)
  distinguishes meanings by context, carries translator comments and flags
  source-changed translations for review. Coconut retains exact source/context
  snapshots and marks affected translations stale rather than silently reusing
  them.
- [Weblate's glossary](https://docs.weblate.org/en/latest/user/glossary.html)
  keeps preferred terms and names consistent. Coconut stores a per-document,
  per-target-language term sheet, sends only terms matching the selected context,
  and checks whether the output follows them. It never guesses a person's name.
- [Weblate translation memory](https://docs.weblate.org/en/latest/admin/memory.html)
  distinguishes scoped translation reuse and reviewed/pending states. Coconut
  reuses only current, warning-free translations of explicitly selected context
  cues as **unreviewed suggestions**. It does not share a global memory or assume
  automatic checks make a translation approved.
- [Netflix's timed-text guidance](https://partnerhelp.netflixstudios.com/hc/en-us/articles/215758617-Timed-Text-Style-Guide-General-Requirements)
  treats names/formality consistently and places line breaks at meaningful
  boundaries. Coconut prefers sentence/turn/pause boundaries for request windows
  but keeps the original cue identities and time ranges untouched.
- [Netflix's Simplified Chinese guide](https://partnerhelp.netflixstudios.com/hc/en-us/articles/215986007-Chinese-Simplified-Timed-Text-Style-Guide)
  gives a 9-character/second adult subtitle target. Coconut's advisory reading-speed
  threshold uses 9 for Chinese/Japanese/Korean and 20 for other supported languages
  as product heuristics; this is not a claim of compliance with every language's
  delivery specification. It never condenses speech or changes timing automatically.
- [Context-aware translation research](https://aclanthology.org/P19-1116/)
  evaluates discourse phenomena such as deixis, ellipsis and lexical cohesion.
  This supports testing cross-sentence meaning, not claiming that batching or
  segmentation alone repairs a weak model.

## Implemented request contract

`POST /api/translate-subscription` still requires `consent: true` and the selected
provider. `segments` contains 1–32 target cues, each with stable `id` and source
`text`. The contextual path also supplies original `position`, `start`, `end`,
and a nullable `speaker` label. Targets plus read-only `context` are bounded to
36 cues and 40,000 source characters; each source cue has 1–4,000 characters.
Speaker labels are bounded to 120 characters and are never treated as verified
identities. The legacy no-context path remains compatible, but unpositioned cues
are never asserted to be adjacent.

The planner keeps disjoint selections separate, prefers nearby sentence ends,
turn changes or pauses, and adds at most two selected neighbors on each side.
Semantic-unit hints group contiguous fragments into bounded spans (at most eight
cues / approximately 1,800 source characters, except an individually longer cue).
They help the model read connected speech; they do not rewrite source artifacts.
The model must return precisely the target IDs, in order, without moving meaning
between them. This is cue-level association, not translated-word forced alignment.

Optional fields:

- `glossary`: up to 100 `{source, target}` entries; each term 1–120 characters,
  unique source ignoring case, no control characters, 8,000 total characters
- `memory`: up to 36 `{id, source_text, text}` entries. IDs must be context-only,
  source text must match exactly, target text is nonempty and at most 12,000
  characters each / 24,000 total. No outside-selected-document material is added

The model sees separate `target_ids`, ordered `cues`, `semantic_units`, matching
`glossary` and `translation_memory`. All remain untrusted quoted data. Instructions
require preserving actors, modality, negation, numbers, uncertainty and every
proposition; the model is told to review the whole passage before returning.

The response retains `id`, `text`, `source_text`, `provider`, and adds:

- `context_version: 2`
- `input_revision`: opaque 64-hex request fingerprint, stable within a runtime.
  Consumers must not expect Python and Node JSON number serialization to produce
  identical hashes; exact saved evidence is the freshness authority
- `quality_warnings`: allowlisted advisory codes for digit/sign/percentage
  changes, glossary mismatches, unchanged text, repeated phrases, extreme length
  changes and high estimated reading speed

Missing/duplicate/reordered/unknown IDs or empty/oversized outputs reject the
entire batch. Quality warnings do not silently delete a translation. They prompt
human checking and block that translation from becoming a memory suggestion.
Localized/spelled-out numbers and valid short/long translations can trigger false
positives. Missing facts without surface signals, factual hallucination, tone,
pronoun correctness and overall semantics are **not** proven by these checks.

## Revisions, storage and user controls

Schema version 1 source documents remain readable. New optional
`translation_glossary`, per-translation `glossary_snapshot`, `context_version`,
`input_revision`, `document_language` and `quality_warnings` survive JSON backup.
Existing `translation_contexts` arrays now also retain exact speaker labels and,
when used, prior memory text. Input/context edits, timing or ordering changes,
speaker changes, relevant term changes, and transitive memory-source changes
invalidate affected translations. The explicitly chosen source language is
separate from the captured document-language revision.

The glossary editor accepts `source = target` lines. Saved entries are displayed
as JSON-quoted strings so terms containing `=`, quotes or backslashes round-trip
without corruption. Unsaved edits cannot accidentally be used for a translation.
Changing task, provider, language, glossary or explicit reading scope during a
request stops later batches even if the shared consent checkbox is rechecked.
The running request may finish; revised evidence is checked before any write.

Translation work is tied to the document and source selection that the user
confirmed. Collapsing the AI panel (including its parent demo tools), leaving
reading, switching documents, or changing the selected source scope latches a
stop for later batches. Reopening the panel or checking consent for another
document cannot revive that plan. A new explicit request and fresh subscription
consent are required to continue; already completed targets remain saved.

A valid in-flight response can still finish and be saved to its original document
while the page remains alive. Closing or reloading the actual page can interrupt
that response, so receiving or saving its result is not guaranteed. Requests
already sent may have consumed quota. Progress and errors stay with their source
document, and another document explains when it is waiting for the current call.

Within the same confirmed scope, jumping to another source passage or switching
between original and bilingual views does not stop translation. The confirmed
target list stays fixed even when new translations change which search results
are visible; a result never authorizes adding new targets to the request plan.

The offline OPUS/Argos path remains labeled a **per-cue rough draft**. Joining its
output and arbitrarily repartitioning it into timestamps would invent alignment,
so this increment deliberately does not do that. A stronger local document model
or a reviewed block-alignment workflow would be a separate, measured improvement.

## Verification

`tests/fixtures/translation-context.json` is a portable synthetic contract fixture
for both Python and the lightweight Node bridge. Tests cover bounded input,
semantic selection gaps, glossary/memory scope, exact ID validation, revision
invalidation, transitive dependencies, malformed input, consent interruption,
backup round trips, warnings and source-language overrides. DOM tests also cover
whole-document summary scope and explicit consent.

No real provider inference, model download or quality benchmark is part of these
contract tests. Before calling output quality verified, run an authorized bilingual
evaluation with fragmented negation, pronouns, named entities, numbers and topic
changes, review against audio, and distinguish omissions from fluent wording.
