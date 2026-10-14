# Explicit subscription model selection

## User contract

Ask, translation and every stage of a summary can request a model ID or alias supported by the user's installed official CLI. Blank means the CLI's default under Coconut's isolated configuration, not necessarily the user's normal terminal configuration. Coconut does not fetch a model catalog, prove subscription access, or make a billable test request when checking the connection.

The optional request field is `model`. It is a single ASCII token, 1–120 characters: a letter/digit followed by letters, digits, dots, underscores or hyphens. Missing, null and empty mean default. Whitespace, paths, URLs, CLI options and other values fail before discovery/inference. The adapter passes the value as a separate `--model` argument, never through a shell. A valid spelling is not proof that the provider offers that model.

Successful answers and translation items retain `requested_model` only for an explicit choice. This records the user's request, not an invented claim about the concrete model behind a mutable alias. Default requests do not invent a resolved model name. The model is not inserted into transcript content or translated as source material.

A selected model is immutable summary task input: it participates in the idempotency digest, reaches each chunk and synthesis request, survives restart/export, and is recorded in the final result. Reusing the same submission key with another model is a conflict, not a second model call. Existing records with no model retain their prior digest. Restart still interrupts unfinished work without automatically spending quota again.

Unavailable models, authentication errors, quota failures and malformed results stop the request. Coconut does not initiate provider/model retries, buy credits or fall back to API credentials. Subscription authentication does not guarantee that the request is included in the plan: existing provider usage-credit/extra-usage settings may charge the account, including for explicit models. The send confirmation must disclose this for default as well as explicit requests. Coconut cannot verify the bill or remaining allowance. Source content, citations, translation IDs and existing persistence/consent boundaries remain unchanged.

## Audit and official evidence (2026-10-14)

The existing bridge had two usable protocols (`codex exec --json` and Claude print JSON) but discarded model choices. Adding an unverified third protocol or moving to a persistent app server was unnecessary for this bounded improvement.

- [Codex CLI source](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs) exposes global model selection and isolated ephemeral execution; [CLI reference](https://developers.openai.com/codex/cli/reference/) documents `--model` as a per-run override. `--ignore-user-config` intentionally excludes user model configuration while preserving official authentication. Existing feature denials, read-only sandbox and ChatGPT-only authentication remain in place.
- [Codex event definitions](https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts) distinguish completed turns from errors. Coconut still rejects tool events, unknown item types and incomplete turns; Python now matches the Node unknown-item rejection and rule-file isolation.
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) documents model aliases/full IDs, safe mode, print and tool restrictions. Readiness now checks required flags before reporting ready, rather than discovering incompatible print options after sending source text. This is capability detection, not an arbitrary version lock.
- [Claude programmatic output](https://code.claude.com/docs/en/headless) documents schema output; [official SDK result types](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py) distinguish errors and interrupted terminal reasons. Coconut requires a successful result envelope and rejects interrupted output even if it contains a plausible structured answer.

Claude invocation settings request `switchModelsOnFlag:false` and an empty `fallbackModel` chain. The [official model configuration guide](https://code.claude.com/docs/en/model-config) documents refusal rather than model switching in non-interactive mode with that setting, and documents that print-mode Fable requests can consume usage credits without an interactive prompt. This does not establish an included-quota-only mode. `DISABLE_EXTRA_USAGE_COMMAND` only hides a purchase command and is not used as a billing guard.

Managed enterprise policy can still apply to official CLIs. A help/auth probe cannot certify the contents of managed settings or subscription quota. This change does not claim otherwise and does not disable or bypass managed policies.

## Verification boundaries

Fake-CLI subprocess tests exercise actual argument/stdin/environment transport without invoking an installed CLI. Unit/contract tests cover both providers, both language backends, invalid model values, default compatibility, unavailable-model no-fallback, Claude capability/result failures, and summary digest/restart/multistage behavior. No real account or model quota is used. Successful contract tests are not evidence of live provider availability or answer quality.
