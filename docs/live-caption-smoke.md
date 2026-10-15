# Manual live caption import evidence

This is an opt-in, single-attempt smoke test, not a required PR gate. Ordinary
CI remains offline. Run the **Manual live caption import** workflow manually
on the exact commit you want to verify. It uses official Node 22 and Python 3.12
setup actions, read-only repository permissions, no secrets, and hash-locked
runtime dependencies. Inspect the commit in the metadata artifact, not just a
green run on an older revision.

For Linux/macOS local execution, with Node 22+ and Python 3.12 installed:

```sh
python3 -m venv .venv-captions
.venv-captions/bin/python -m pip install --disable-pip-version-check --no-input --require-hashes --only-binary=:all: --no-deps -r desktop/development-caption-requirements.txt
COCONUT_CAPTION_PYTHON="$PWD/.venv-captions/bin/python" node scripts/live_caption_smoke.mjs --live
```

The flag is required; importing the module does not contact a platform. The
script runs the actual development bridge with a temporary task directory and
no persistent library, then sends one same-origin POST to `/api/captions/import`.
The isolated, pinned Python helper obtains subtitle bytes using the real
extractor; the normal caption service parses and validates a Reader document.
There are no fixture overrides in the live CLI. It does not load cookies, log
in, use credential/proxy workarounds, download media, run ASR or call a model.
The helper has its existing 130-second limit, the request a 145-second limit,
and the supervisor kills its whole worker process group at 150 seconds. For
this smoke only, the helper inherits that dedicated worker process group;
normal development/production helpers retain their separate-group default.
The extractor, isolation environment, protocol, API and Reader validation are
unchanged. No unrelated process is targeted. The
workflow job is limited to five minutes. No retries are requested by this tool.

The only sample is YouTube `QRS8MkLhQmM`, requested language `en`, from the pinned
[upstream subtitles test](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/test/test_subtitles.py).
The upstream test expects English VTT among 13 languages; that is a sample
selection rationale, not proof of current anonymous availability. Bilibili's
known upstream subtitle example requires login and is deliberately excluded;
X is also outside this probe's scope. This test cannot establish those
platforms' live availability.

`live-caption-report.json` contains only commit/time/runner, fixed source
identity, Node and expected/verified extractor versions, readiness/import
status, elapsed time, language/method, cue count/range and SHA-256 of normalized
cue JSON. Cue normalization preserves order and maps each cue to `start`, `end`
and NFC text with LF newlines before JSON serialization. No text, title, raw
helper output, base64, exception, HTML or signed URL is printed or uploaded.
The workflow artifact expires after three days. Temporary task data is removed
on normal completion; a hard-killed local run may leave temporary directories
under the OS temp directory. Do not upload those directories.

- `live_pass` and exit 0: a nonempty validated document was returned for this
  sample on this runner at this time, with a digest of its cues.
- `blocked`: the existing API explicitly reported access or network restriction.
- `unverified`: readiness failed, deadline elapsed or the cause is unknown.
  An `unavailable` result remains unknown, not a claim that subtitles are absent.
- `implementation_failure`: malformed helper output or an invalid ready document.

All non-pass outcomes exit nonzero after preserving the report. A dependency
installation failure may leave no report; the workflow is still failed, never
silently passed. Helper `ready` alone verifies dependency/protocol/TLS setup,
not live subtitle access. Offline tests (`node --test tests/desktop-live-caption-smoke.test.mjs`)
exercise the same API using an authored helper and cannot replace a real live run.
