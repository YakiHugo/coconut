# Local incremental acquisition acceptance (2026-11-15)

## Scope

Executed on an Apple Silicon Mac against source commit `58860849b7d71a119dbfd45dfc2f25eb291e45a0`, in an isolated worktree. No application installation, paid API, model download, or edits to the user's original worktree. This is real local inference and transport-lifecycle acceptance, **not ASR or speaker accuracy acceptance**.

The existing public AISHELL-4 S reference recording (`S_R003S04C01.channel0.wav`, 302.42625 seconds) was reused. WAV SHA256: `2e87924179890964c73c79f9f6be749a67b9b7822229afc0da2d7eaa5ffd4e61`. This is a previously used developer sample, not a new held-out test set.

Models were already installed: Qwen3-ASR-1.7B-8bit, Qwen3-ForcedAligner-0.6B-8bit, and the existing Sherpa segmentation/embedding models. Both trials used the unmodified 240-second core / 5-second context defaults and the normal Qwen final speaker-enhancement path. Model output was not replaced by a fixture and human reference text was not supplied to inference.

## Actual acquisition path

`createPodcastSources.downloadMedia` → slow HTTP response → `createSourceJobs` / `createSourceMediaStore` → Node incremental adapter → inherited read-only FD 3 / NDJSON → Python / PyAV / real Qwen → sealed fingerprint → canonical validation → normal speaker enhancement → durable result.

Only the public HTTP transport dependency was injected to map an authored public URL to an isolated loopback HTTP server. Production SSRF/public-source validation was not changed, and this test does not verify a real platform's network availability. The server delivered 16 KiB chunks at 10 ms intervals and held the final 5% of compressed bytes until the first complete candidate appeared. This deliberately proves a pre-EOF candidate; it is not a realistic network throughput benchmark. The first candidate requires the initial 245 seconds of decoded speech, so a gate sized for a much longer fixture would be inappropriate here.

Before releasing EOF, both tests asserted `mediaReady === false` and that the final result endpoint rejected access. After completion, both asserted final `ready`, media/result availability, receipt byte size and SHA256, and the published result's source fingerprint.

| Container | Bytes | First candidate | HTTP EOF | Ready | Reused / recomputed chunks |
| --- | ---: | ---: | ---: | ---: | --- |
| FLAC | 4,497,257 | 13.58 s | 13.73 s | 27.11 s | 2 / 0 |
| MP3 | 4,840,749 | 12.97 s | 13.13 s | 28.91 s | 1 / 1 |

FLAC SHA256: `307938623b1ccc53f7a091f99d859877af8adeda47c6b645d907f7c0e8720cd8`.

MP3 SHA256: `f29d870d5a91f0870217f4f8b55ac62cd40a09e17b4f4f1dbe1edafa7f445aa9` (derived with local FFmpeg, 128 kbit/s).

MP3 reported `canonical_pcm_mismatch` and recomputed one chunk, rather than trusting the streaming candidate. FLAC reported no fallback. Results contained 66 and 67 cues respectively, with `automatic_unreviewed` speaker provenance. Container outputs were not asserted identical. These timings are one sequential run per container, affected by caches, startup, and an artificial EOF gate; they do not establish speed or memory superiority over the buffered path.

## Browser acceptance

Real Chromium, generated frontend, real service, SQLite, and local model capability probe verified:

- Explicit **获取原声并转录** submits one `download_transcribe` task with `localOnly: true`, consent, and the experimental acquisition mode.
- Reload while downloading restores the active task without submitting a duplicate.
- Cancel aborts the server-side download; reload retains cancelled state.
- No **将文字稿接入原项目** action appears for the cancelled incomplete task.
- No uncaught page errors occurred; running/cancelled screenshots were inspected.

This browser interruption trial deliberately held transport before audio arrived, so it did not perform another model run. Actual model execution and final publication were verified by the two source-job trials above, not by clicking through final transcript acceptance in the browser. Browser evidence and real inference evidence must not be conflated.

## Verification boundary

`build:reader-ui` and `check:reader-ui` passed. Generated JS/HTML matched the independent cloud build byte-for-byte. Local reports, screenshots, raw recognition artifacts, and the test audio remain in the isolated validation directory; no audio or transcript was committed. This experiment does not measure CER, DER, speaker identity accuracy, multi-hour resource behavior, or platform availability, and does not justify changing the default chunk size.

The existing `react-video-audio-browser.mjs` and `service-source-browser.mjs` regressions also passed (their recognition fixtures are simulated, unlike the two trials above).
