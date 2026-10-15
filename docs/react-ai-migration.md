# React AI workspace migration

## Ownership

`frontend/ai-workspace/workspace.tsx` owns AI controls, consent, task rows,
manual translation review, glossary, retained evidence and archive review DOM.
`controller.ts` owns immutable document drafts, identity admission, asynchronous
operations, durable task intent and transient diagnostic state. It contains no
DOM queries, listeners, global rendering events or legacy renderer calls.

The React entry must not load `reader/language.js`,
`reader/background-summary.js`, or `reader/translation-review.js`. They remain
legacy-route implementations until the application-level migration gate is met.
This component batch does not itself switch or retire the production entry.

## Retained pure services

- `reader/core.js`: source/evidence validation, manual translation review,
  contextual/offline batching, glossary normalization and history export.
- `reader/summary.js`: bounded summary plan, checkpoint and result validation.
- `reader/task-client.js`: original submission/resume/cancel/archive transport
  and independent result receipt validation.
- `reader/client-capabilities.js`: identity/capability admission only.

## Migrated behavior

| Behavior | React owner / verification |
| --- | --- |
| Question with one-shot consent | Controller; mounted React interaction test |
| Exact selection and source provenance | Validated passage scope plus exact UTF-16 selection, round-trip test |
| Foreground summary checkpoints | Controller; persist each batch before next request |
| Explicit checkpoint reset | React action clears checkpoint and revokes consent |
| Background submit and lost acknowledgement | Durable original key, query-only recovery test |
| Explicit resume | Captured task/attempt/input/model and remaining scope; durable resume intent before send |
| Cancellation racing success | Local abandonment blocks acceptance regardless of server outcome |
| Receive result once | Task receipt ID in document; duplicate-click test |
| Independent executor result | Read-only list/lookup, validated JSON recovery export; never attaches unknown task to manuscript |
| Archive and restore | Individual actions and bounded reviewed batch; exact identity and connection generation |
| Archived lookup | Paged archive query and explicit task-ID lookup |
| Subscription translation | Bounded pure-core plan, glossary/context and manual-edit guards |
| Offline translation | Capability-gated, explicit model-download checkbox, no inferred download permission |
| Manual translation review | Current source/context/version verification with detached immutable commit |
| Glossary | Per-document/language drafts, explicit local save, consent revocation |
| AI history | Full export, ten-record UI pages, lazy evidence, twenty-cue pages and 4,000-character slices |
| Local diagnostic details | Explicit reveal, memory-only, no journal/document fields |
| Connection ABA and stale callbacks | Generation checks, source identity, detached commit revision and adversarial tests |

## Shell integration contract

Provide `createAiController` with authoritative document accessors,
`getRevision`, detached conditional commit, pure services, capability access,
JSON request, browser download, navigation and the existing task journal key
`coconut-background-summary-v1`. Do not wrap old DOM script handlers.

Subscribe React with `useSyncExternalStore`. Call `setDocument` on authoritative
source/selection changes. An own conditional commit temporarily defers sync and
adopts the new identity only if the revision increased exactly once. The shell
must retain exact selection until a real source/selection change; storage status
notifications must not manufacture a new scope. Explicit null selection means no
question/translation scope; undefined alone permits the default full source.
Use `snapshot.hasDirtyDrafts` for retained closed review/glossary draft guards.

Use a React-owned, cleaned-up four-second read-only polling effect while tasks
are pending. On connection lifecycle changes call `connectionChanged`; on
pagehide retire the owner with `connectionChanged` and clear transient error details. Dispose the
controller on unmount. No lifecycle event may submit or resume inference.

## Tests and remaining integration gate

- `tests/react-ai-workspace.test.mjs`: deterministic mocked domain/transport tests.
- `tests/react-ai-mounted.test.mjs`: actual React DOM lifecycle and controls.
- Affected existing passage/history tests exercise core persistence compatibility.

These are not a substitute for production-entry browser acceptance, full
aggregate checks or independent review. Final shell/reader integration must
verify navigation, stale-source selection, own-write revision adoption, polling
cleanup, task journal restoration and failed persistence under the actual store.
No real provider, platform or model requests are used by this batch's tests.

## Failed-save recovery

Conditional rejection and accepted-but-not-durable writes retain a detached
recovery snapshot, expose `unsavedContent`, and participate in `hasDirtyDrafts`.
Retry is an explicit local save only while the same authoritative source and
revision still own that snapshot. It never reruns inference. After an external
source edit or document replacement, recovery remains downloadable separately
and cannot overwrite the newer source. Exporting does not silently discard the
recovery; explicit discard is available after the user has kept needed files.
