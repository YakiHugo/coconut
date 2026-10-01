# MVP verification record

Environment: dot cloud Linux, Python 3.12, Node 24. Not the owner's Mac.

## Real ASR smoke runs

- English: `ggml-org/whisper.cpp` public `samples/jfk.wav`, faster-whisper tiny, CPU int8. Produced a source-timed JSON and Markdown result.
- Chinese: FunASR's public `asr_example_zh.wav`, faster-whisper small, CPU int8. Produced a 5-second segment. **The proper noun 达摩院 was recognized as 打磨院.** This is a known accuracy error, not a passing quality benchmark.
- Discovered and fixed a real dependency incompatibility: PyAV19 removes `metadata_errors`, used by faster-whisper1.2.1. Core requirements now pin tested PyAV16.1.0.
- The cloud environment required the httpx SOCKS extra to honor its existing proxy. No proxy/security settings were disabled.

These are short clean samples only. They do not establish long-form, mixed-language, noisy, speaker-diarization, or Mac performance quality.

Sources:
- https://github.com/ggml-org/whisper.cpp/tree/master/samples
- https://github.com/modelscope/FunASR

## Real video URL smoke run

A public YouTube video (`jNQXAC9IVRw`) was fetched through the actual subtitle-first adapter.
Its existing English captions produced six structured segments, labeled `platform_subtitles`.
This exposed and fixed a real yt-dlp discovery/simulation-state leak: separate parameter copies
and an explicit non-simulated subtitle-write stage are required.

The environment already supplies an SSL_CERT_FILE trust store. yt-dlp's bundled certifi roots
did not honor it; the adapter now uses yt-dlp's documented system-trust option when that environment
variable is explicitly present. Certificate verification remains enabled; no trust roots were added.

Bilibili metadata/subtitle gating is covered by regression tests, but a real Bilibili import remains
unverified. Platform-specific login or anti-bot restrictions are not bypassed.

## Browser checks

The published reader was actually opened in the cloud browser. Demo reading, adding a note, searching notes, reload persistence, invalid source rejection, and generated timestamp URLs were checked. Desktop screenshot captured.

File chooser upload attempts could not complete because the browser file-chooser permission step could not complete in this environment. File import/export roundtrip still needs real-browser verification. The new local-job UI is not covered by the earlier browser check. A later browser check exposed a note-editor blur bug that swallowed the next segment-edit click; it has a regression test and a fix that keeps the target mounted.

## Automated coverage

Python regressions exercise real local HTTP upload-to-result, queue restart/retry/cancel, worker ownership, SIGTERM process cleanup, subtitle discovery and parsing, output collision protection, and metadata preflight. JS and DOM regressions exercise notes, backup parsing, corrupt storage preservation and editing another segment while a note is open.

A CI workflow example is included but has not been enabled for this change. Local test results are not a claim that GitHub CI passed.

## Local media job end-to-end smoke

A real HTTP upload of the public Chinese WAV sample ran through the SQLite queue, subprocess importer and faster-whisper small, and returned a readable timed document from `/api/jobs/<id>/result`. This is API-to-ASR integration evidence, not local-server browser evidence. The same 达摩院 recognition error remains.
