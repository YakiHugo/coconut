# Owner-local video sources (no transcription)

## One production adapter, upstream transport

`Discover` → `/api/v1/ingestions` → caption service → isolated JSON helper →
`scripts/owner_video_source.py` uses the pinned **official YouTube/Bilibili
extractors**, `YoutubeDL.urlopen` / RequestDirector / native request handlers,
and **HttpFD** for media. Coconut no longer replaces DNS, CONNECT, TLS or the
HTTP Range download loop in this production video path. The old public guard
remains for X and historical narrow proof scripts, not as a second video mode.

Coconut retains canonical single-video identity, no automatic account/browser
credential discovery, no plugins/user config/external downloader, TLS validation,
original-track selection, a 1 MiB caption budget, 200 MiB media budget (enforced
before each write), bounded time/process/output and explicit failure receipts.
The pinned native urllib handler eagerly decompresses encoded responses before
returning them. Coconut therefore requests `Accept-Encoding: identity` and adds
a small opener response policy **before** that decoder. Metadata/captions accept
one standard gzip or zlib-deflate member with bounded raw reads and bounded
`decompressobj.decompress(..., max_length)` output; malformed/truncated/stacked
or unsupported encodings fail. Compressed media remains rejected so Range offsets
stay byte-exact. Raw and expanded bytes (including redirect bodies) share the
24 MiB metadata budget; per-response limits are 4 MiB metadata / 1 MiB captions.
DNS, proxy matching/CONNECT, TLS and HttpFD remain upstream implementations.
HTTPS redirects cannot downgrade to HTTP/FTP. These are response/body and
file-write limits, **not** an OS memory sandbox or a claim that TCP/TLS/header
buffers and total process memory have a hard bound. No unbounded decoder/flush
is used; a small compressed text body is held only within the response limits.

Only direct original M4A or supported single MP4 is accepted. This is not general
HLS/DASH merging, ffmpeg conversion, JS challenges, PO-token provisioning or ASR.

Native yt-dlp is **not an SSRF sandbox**. Local metadata redirects use upstream
semantics rather than Coconut's old per-hop public-IP pinning. This is confined
to the owner at the loopback bridge: Host/socket/Origin/forwarding checks happen
before routing; private remote-owner requests cannot call this helper through
captions, media or ingestion/short-link routes. A JSON `ownerLocal`/`network` flag
cannot grant permission. Tests exercise actual HTTP requests, not just booleans.

## Startup network configuration

Default is unchanged: **direct**, ignoring ordinary ambient proxy variables.
Network configuration is only read at process startup, never from import JSON.

| Setting | Meaning |
| --- | --- |
| `COCONUT_SOURCE_NETWORK=direct` | Direct upstream requests; no inherited proxy |
| `COCONUT_SOURCE_NETWORK=environment` | Explicitly snapshot only `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and lowercase equivalents |
| `COCONUT_SOURCE_NETWORK=custom` + `COCONUT_SOURCE_PROXY=http://127.0.0.1:7897` | Explicit credential-free numeric-loopback HTTP proxy; `[::1]` also accepted |

When the new settings are absent, the old `COCONUT_CAPTION_PROXY` loopback HTTP
setting is still accepted. Conflicting/incomplete new settings fail closed.
Environment mode follows upstream/stdlib lowercase precedence and `NO_PROXY`
matching. It is **not** automatic macOS system proxy or PAC discovery. Supported
environment proxy schemes for the pinned minimal runtime are HTTP and
SOCKS4/4a/5/5h; authenticated proxy URLs and HTTPS-to-proxy are deliberately
rejected. HTTP CONNECT has an end-to-end authored TLS test; SOCKS schemes are
accepted by the pinned upstream handler but have not been integration-tested here. Only the validated proxy-variable snapshot enters the helper, never the
full parent environment. Proxy addresses and credentials are not returned in
HTTP diagnostics or logs. The proxy operator can see destination metadata;
configure only an owner-trusted proxy. This configuration does not grant network
permission in an execution environment that restricts outbound access.

This PR does not change podcast or X networking. A unified naming convention is
not a claim that their different adapters already share the native video path.

## Subtitles and media are distinct resources

Caption import prefers existing original-language tracks. Failure or incomplete
metadata is never reported as “no captions”. HTTP denial/rate limiting and
platform login/access requirements are terminal; there is no alternative client
or proxy retry. Bilibili's `need_login_subtitle` is explicitly a subtitle-only
flag in upstream [`_get_subtitles`](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/extractor/bilibili.py#L255-L275).

An explicit **source media** action uses `writesubtitles=False` /
`writeautomaticsub=False` and does not fetch subtitles. Coconut does not need
extractor chapters, so it omits the duplicate chapter request to the same
subtitle API. Its receipt says `subtitle_check=not_requested`, never “absent”.
The UI may offer this independent action after that specific Bilibili subtitle
flag, but not after general login, media denial or unknown extraction failures.
Media itself still requires valid source/playback metadata, no exclusive or
preview content, and a successful bounded transfer. No subtitle restriction is
retried and no media restriction is bypassed.

## Validation levels

- Deterministic tests use authored platform metadata with the real upstream
  extractor and RequestDirector, not claims of current platform availability.
- An additional authored cross-layer test uses the actual isolated Python helper
  process, official extractors/HttpFD, same-origin Node API and persisted media
  after a full restart. Only RequestDirector responses are fixtures; Python
  network sockets are forbidden. It does not prove public-platform access.
- Loopback TLS/CONNECT integration covers native TLS chain/hostname checks,
  explicit proxy/NO_PROXY, denial without direct fallback, and read budgets.
- Manual opt-in source CI exercises the exact production same-origin APIs with
  pinned dependencies, direct network, no platform credentials and no model.
  It keeps per-stage failures; a provider outage is not required baseline CI.
- Saved source bytes use the canonical local source-media store. Reopening a
  document reads its saved resource, not the expiring provider URL. Live tests
  distinguish acquisition, persistence/restart/integrity and actual playback.

The development helper uses this code immediately. Immutable older packaged
helper artifacts remain on their older supported contract. Packaged media is
only enabled when a freshly built, integrity-checked helper advertises
`ownerLocalVideoProtocol=1`; this source change does not update an already
installed Mac application or publish release artifacts.

## Subtitle PO-token observations are not whole-video access denials

The pinned yt-dlp extractor can detect a subtitle PO-token requirement while
parsing a player response, before requesting any subtitle bytes. Coconut keeps
that immediate stop (including an explicit media action whose extraction reaches
this observation), but reports `subtitle_token_required`, not `access_restricted`.
The owner API emits only these conservative availability observations:

```json
{"metadata":"unverified","captions":"token_required","media":"unknown"}
```

This is not proof that all metadata was validated, that the video needs account
login, that captions are absent, or that its media can or cannot be downloaded.
A login/HTTP denial still retains its separate access-restricted status. No
subtitle request, media fallback, token generation, alternate client, or automatic
retry is enabled by this status. The reader offers the original site and existing
subtitle-file import rather than login or repeated-request advice. Reports remain
failed/blocked with persistence and restart unattempted. Authored `xpe`/`xpv`
fixtures cover human/automatic subtitles and caption/media actions; they are not
live-source availability evidence. This state-only fix does not retry any earlier
restricted sample or change the opt-in live-source / manual-ASR workflow gates.
