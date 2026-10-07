# Bounded public X caption proof

This acceptance script investigates the historical public sample without enabling
a desktop provider or downloading its video. It is distinct from the earlier
original-video browser acceptance and from the unsigned syndication probe.

## Audited pinned route

The official `yt-dlp==2026.8.19` [Twitter extractor](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/extractor/twitter.py)
defaults to GraphQL. Without an account cookie it uses the upstream public
application bearer value to obtain an anonymous guest token, then queries the
post. These are application guest mechanisms, not a user's account credentials.
Coconut does not copy either token value into its source or logs.

The same extractor can fall back after HTTP 429 to syndication, including a
computed syndication token and a Googlebot user agent. This proof prevents that
fallback before token generation or a network request. Stock CLI execution is
therefore not equivalent to this guarded route.

## Exact CI invocation

Run only for an explicitly scoped acceptance change or manually requested proof;
do not add this live source to every ordinary PR. A clean Ubuntu Python 3.12 job
needs no browser, ffmpeg, project requirements, ASR package or model:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-python@v5
  with:
    python-version: '3.12'
- name: Install only the pinned official extractor
  run: python -m pip install --disable-pip-version-check --no-input --no-deps yt-dlp==2026.8.19
- name: Verify public guest captions without media or ASR
  timeout-minutes: 3
  env:
    TMPDIR: ${{ runner.temp }}
    PYTHONNOUSERSITE: '1'
    YTDLP_NO_PLUGINS: '1'
    HF_HUB_OFFLINE: '1'
    TRANSFORMERS_OFFLINE: '1'
  run: timeout 150s python -B scripts/prove_public_x_captions.py
- name: Remove ephemeral caption output even after termination
  if: always()
  run: rm -rf -- "$RUNNER_TEMP"/coconut-public-caption-*
```

No artifact-upload step is appropriate. The script emits one JSON summary with
counts, timestamps, provenance category and a bounded outcome code. It never
prints source text, signed URLs, tokens, upstream errors or headers. Exit zero
requires a real successful caption result; an unavailable route exits nonzero
and cannot be described as proof that captions are absent.

## Limits and assertions

- Calls the actual `subtitle_import.fetch_subtitle_document`, existing language
  selection, VTT parser, provenance builder and source-link logic
- Uses official extractor logic with a narrow stdlib HTTPS transport: one guest
  activation, one selected-post GraphQL request, and only `video.twimg.com`
  `.m3u8` manifests / `.vtt` captions thereafter
- At most 12 requests, 15-second socket timeout, 120-second wall-clock alarm,
  4 MiB per response and 12 MiB total admitted response data
- No redirect following, environment proxy, cookies, account login, netrc,
  plugins, alternate identity, attestation, retries or access-denial fallback
- Stops immediately on HTTP 401/403/429, API errors, unavailable posts, login
  requests, unexpected destinations or non-caption content
- Rejects media/thumbnail/model destinations before requests; retains exactly one
  VTT temporarily, then checks finite monotonic timestamps, declared duration,
  source/provenance, full cue equivalence and lossless JSON roundtrip
- Original VTT text and timestamps must exactly match the resulting document;
  first/middle/last source links must retain expected second offsets
- Caption provenance remains unreviewed. A pass is not human transcription
  accuracy, browser playback, product adapter readiness, or native packaging proof

`public_x_caption_guard.py` is independently importable for a future isolated
source-built helper. Its caller must supply a validated post ID, enforce the
wall-clock deadline, silence raw upstream output and clean temporary data. The
current proof's scope is the one historical sample. The guard is process-local,
uses a temporary Python API patch and is not a concurrent server adapter.

Offline guard tests (no external requests):

```bash
python -m unittest discover -s tests -p test_public_x_caption_proof.py -v
```

The authoring environment had no installed yt-dlp. Offline tests and the explicit
`pinned_dependency_missing` outcome were checked locally; current source
availability remains unverified until the CI invocation above passes.
