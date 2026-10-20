# Public ingestion: implementation and evidence

This document records separate capabilities, not a guarantee that every link is anonymously accessible. Development/Web is the priority; no installer was produced.

## Caption-first, then explicit local transcription

- YouTube/Bilibili: the pinned official yt-dlp extractor checks completed-video identity, access, duration and original-language tracks. Platform and automatic captions keep distinct provenance. Only a completed `no_matching_captions` result can offer the explicit media action.
- Clicking that action rechecks the same source. A newly available caption stops the media action and asks to import captions instead. Login/token/HTTP denial, incomplete metadata, network failures, ambiguous language and caption download/parse failures never become absence.
- The conservative media capability accepts one direct audio-only M4A or one narrowly verified combined MP4 from that same metadata, on a provider-specific CDN. M4A selection requires retained original-language evidence for YouTube and never chooses a lower-bitrate dub or descriptive track. Public combined video records its original/default/unknown audio role and nullable language without claiming original voice. Bilibili's unlabelled single-CID source remains language-unknown. Transport keeps pinned-public-DNS/TLS, no redirects/cookies/token providers/manifests/backup retry, a 200 MiB byte bound and a 130-second helper deadline. CDN signature URLs are transient and never enter a saved document.
- Downloaded media becomes an accurately typed browser File, with a safe bounded filename separate from the original title. The new source project stores the canonical source URL, provider/media ID, duration, caption-check evidence and complete media SHA-256. Unsupported containers are not disguised as MP3.
- Xiaoyuzhou: existing public-page gates require an explicitly FREE, non-private episode with PUBLIC media. The selected episode is revalidated when bytes are requested. Description/show notes are not treated as transcripts.
- The existing optional loopback Python executor owns one durable upload/job queue for all downloaded/local Files. Recognition requires another explicit user action and an already prepared small model. Runtime does not install dependencies, download models, contact paid ASR or use the user's credentials. The frontend retains source binding across reload, then explicitly attaches the result to the original project with notes/bookmarks preserved.

Current video fallback is deliberately narrower than upstream yt-dlp: direct M4A or narrowly verified single-object MP4 only, not every playable stream or platform format. A combined MP4 is labeled public source media, not necessarily original-language audio. YouTube combined support is restricted to the pinned WEB route's public itag18; Bilibili progressive MP4 requires one exact raw durl object, never a first fragment of a multi-part source. A failed/unsupported public route stays a clear error; users may independently provide a legally obtained local file. The explicit caption-proxy mode remains caption-only: media fallback is not advertised or executed there. Pure static hosting cannot proxy platform sources. Packaged executors do not automatically gain this development-only capability.

## Real sample evidence, 2026-10-20

The public GitHub Actions standard runner was checked before optional ASR preparation: 16.7 GB RAM, about 92 GB free disk, four CPUs. The official `Systran/faster-whisper-small` snapshot was explicitly prepared in a disposable directory, then the runtime used offline-only settings. No model was silently installed by Coconut.

### Xiaoyuzhou no-transcript positive

Source: https://www.xiaoyuzhoufm.com/episode/65e7c944d602439838b530aa

[Real proof run, head 242302b](https://github.com/YakiHugo/coconut/actions/runs/39473881990/job/118804702200):
- Declared duration: 92 seconds; publisher transcript count: zero.
- Actual public media: 748,842 bytes, audio/mp4, represented truthfully as M4A.
- Existing executor: faster-whisper 1.2.1, small, CPU/int8; snapshot 536b0662742c02347bc0e980a01041f333bce120.
- Actual inference and queue completion: 13.2 seconds in this runner; 16 Chinese segments, timestamps 3.28–79.7 seconds.
- One upload; frontend controller reload; original URL, title, podcast source, note and timestamp bookmark preserved; canonical SQLite save and reload passed.
- Transcript segment SHA-256: f3d07dcb7cea5939e0a1c71c56f29fe22b63b3db171bd774ca1fd3bddd0b3013.
- Full media/transcript and model weights were temporary, not published as artifacts. Transcript remains unreviewed: this is pipeline evidence, not a language-quality benchmark or a promise about long programs.

Separate [real media/playback proof](https://github.com/YakiHugo/coconut/actions/runs/39473881990/job/118804702764) downloaded an 87,157,198-byte public Xiaoyuzhou episode and checked Chromium decoding/seek. That 5,389-second episode was **not** claimed to have been transcribed.

### YouTube access negative

[Observed source QRS8MkLhQmM](https://github.com/YakiHugo/coconut/actions/runs/39472797430/job/118800931493) returned `login_required` after one request/one response. No caption, media or ASR fallback was attempted. This is not evidence of absent captions or successful YouTube ingestion. No alternate clients, proxy, cookies or token service were used to evade this response.

### Bilibili transport diagnosis

The older sample BV12N4y1M7rh is an upstream subtitle-login-required test, not a suitable anonymous-positive claim. An initial canonical-path 301 was corrected by requesting the exact same BV URL with its canonical trailing slash; redirects remain prohibited. A metadata-only diagnostic then proved HTTP 200 with gzip despite an identity-encoding request. Bounded decoding is tested independently of access handling. With those transport corrections, the real sample reached five requests/five responses and explicitly returned `subtitle_login_required`; no audio was attempted. [Observed run](https://github.com/YakiHugo/coconut/actions/runs/39474535860/job/118806966556). This negative is not re-run as a positive target. Real caption/media success must still be recorded separately; neither transport correction proves platform closure.

### Independent candidate check

An independent official NASA speech sample, [p0W_cxbbTQA](https://www.youtube.com/watch?v=p0W_cxbbTQA), also returned `login_required` after one request/one response in [run 39476785545](https://github.com/YakiHugo/coconut/actions/runs/39476785545/job/118814693363). No media/ASR was attempted and it is not automatically retried.

The independent upstream Bilibili legacy MP4 sample [BV1nx411u79K](https://www.bilibili.com/video/BV1nx411u79K) completed six requests/responses and positively reached `no_matching_captions` / `no_matching_track` in [the same run](https://github.com/YakiHugo/coconut/actions/runs/39476785545/job/118814692812). This proves the caption-absence classification, not a media or ASR pass. The combined-MP4 follow-through is pending separate evidence.

## Reproduce and distinguish test classes

- `npm run test:desktop`, `npm run test:react`, Python unittest discovery and the production browser suite exercise authored failures, identity/mismatch cases, byte limits, cancellation and durable binding. Authored fixtures are never counted as real platform results.
- `tests/react-video-audio-browser.mjs` renders the real React app/HTTP bridge at 1360 and 390 pixels. It verifies absence-only controls, no automatic download, denied recheck/cancellation/source change with no library write, and a successful authored playable M4A through the real HTTP service, File binding, browser decoder and canonical library. Playback and ASR never start automatically. The two-second sine-wave fixture is authored test data, not a platform result. The MP4 expansion adds a real browser metadata/decode check before project creation. Projects persist metadata, not media bytes: the UI explicitly says downloaded media remains in this page until an explicit durable ASR upload. Screenshots are authored UI evidence, not live source evidence.
- `scripts/live_ingestion_proof.mjs --live` uses the real short public episode, actual optional Python executor, actual frontend controller and canonical storage. It needs an explicit absolute `COCONUT_ASR_PROOF_PYTHON`; it neither installs dependencies nor downloads weights.
- `.github/workflows/ingestion-public-proof.yml` separates explicit ephemeral model preparation from offline inference, records versions and metadata, and removes weights afterward. A public accessibility failure remains a failed/unverified live sample, not a fixture success.

## Primary upstream references considered

- [yt-dlp YouTube extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_video.py) and [PO token guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide): subtitle availability and public access are independent of media extraction. This implementation does not obtain PO tokens.
- [yt-dlp Bilibili extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py): AI subtitle tracks and explicit subtitle-login requirements must not be confused with absent original captions.
- [youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api): useful focused transcript API, not an anonymous-access guarantee or a replacement for a guarded media fallback.
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper): existing local CPU/int8 backend, PyAV decoding, lazy segment generation. Inference must actually consume segments before a pass is reported.
- [Podcasting 2.0 transcript specification](https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/tags/transcript.md): prefer publisher-declared timed text; show notes are not full transcript evidence.

No paid model comparison, account setup, private subscription source, user-Mac installation or release upload is part of this proof.
