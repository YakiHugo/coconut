# Saved-summary evidence DOM audit

Scope: the React-only candidate at `8648ae168b55a42dc538e7df50628be5b91e79f0`. Authored offline fixtures; no model, ASR, remote platform or native-computer calls.

## Reproduction and finding

The summary component rendered every historical source cue inside a closed `details` element. A supported 10,000-cue saved summary mounted 10,000 evidence sections and 30,014 elements even while the evidence disclosure was closed. This unnecessarily allocates and reconciles the full source DOM before the user asks to inspect it.

A production React bundle mounted in happy-dom on Node 24.19.0, x86_64, measured about 601 ms for that mount and 47 ms for a 1,000-cue fixture. The capped process RSS reached about 601 MB. These are diagnostic Node/happy-dom measurements, **not browser interaction latency or a claimed speedup**. Local Chromium could not launch due to execution-environment restrictions; browser acceptance remains a CI check.

The ordinary transcript already mounts 50 source rows at both 10,000 and 100,000 cues. A separate 200-document × 1,000-cue library fixture mounted 100 rows; full-text search returned its pending receipt in 0.54 ms and completed in 233 scheduled slices. No library or transcript rewrite is included.

## Narrow fix and invariants

- Closed evidence renders no source rows; opening mounts at most 50 rows.
- Previous/next buttons expose all source entries in original order with exact historical IDs and text.
- Closing releases source nodes; reopening the same answer retains its page. Replacing the answer closes the view and resets its page.
- Historical snapshots, source revisions, citations, and complete Markdown exports are unchanged.

`node --test tests/react-summary-evidence.test.mjs` builds the production component and verifies a 10,000-cue history, the final page, keyboard-focus continuity, replacement/reopen behavior, absent evidence, immutable data, and byte-equivalent full Markdown export.

The existing production browser matrix additionally checks 10,000 source cues at desktop and phone widths, native summary keyboard toggling, focused paging controls, zero/50 DOM counts, source citation navigation, and a real complete download. Its authored screenshots are included in the CI artifact allowlist. No browser pass is claimed until that gate runs successfully.

The production mounted regression also defers a native disclosure toggle across answer replacement. Each answer lifetime owns a fresh disclosure element, so a queued event from the retired element cannot expand or mount the replacement answer. The independent 0/1/49/50/51/99/100/101/10,001-entry boundary sweep preserves exact historical order and byte-identical exports.
