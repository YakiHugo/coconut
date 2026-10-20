# Link-first ingestion and optional local transcription

The reader has one same-origin API. Existing caption and podcast adapters retain responsibility for fetching, identity validation, and transcript provenance. This coordinator does not write to the canonical library, alter source text/segment IDs, or reuse the summary-task ledger.

## URL and local-file preparation

`POST /api/v1/ingestions`, JSON:

```json
{"protocolVersion":1,"source":{"kind":"url","url":"https://publisher.example/feed"}}
```

A local file can instead be described as `source: {kind:"file", name, size, type, last_modified}`. This only validates metadata: the browser owns the File/blob URL and can immediately open its player. No bytes are uploaded, model started, or transcript fabricated.

The envelope is `{protocolVersion:1, ingestion:{id,state,source,media,transcript,selection,transcription,...}}`. These initial receipts are **request-scoped**, not durable jobs. Aborting fetch aborts the existing adapters; reloading cannot resume an in-flight URL request. Preserve the user's original link in UI state; do not automatically retry an uncertain upload.

States:

- `ready`: `transcript.document` is the original adapter document, with unchanged provenance and segment identity.
- `awaiting_selection`: `selection` is the existing podcast discovery result. Explicitly choose the feed/episode; never assume the latest episode is the shared one.
- `needs_transcription`: media exists independently of text. Remote media includes `project.document`, a validated audio-only project retaining direct-media or episode source identity; this is not `transcript.document`. Local-file project construction remains client-owned because it requires the file fingerprint. Its player may open; transcription is an explicit separate action.
- `blocked`: `error:{code,message,diagnostic?}` distinguishes caption access/network/extractor failure. Failure never silently triggers ASR or an alternate fetch path.

For a chosen episode submit `source.url = selection.feed_url` plus `episode:{feed_url,episode_id,transcript_url?}`. The adapter validates membership against its own completed RSS snapshot for at most 60 seconds, or fetches the feed again; explicit discovery refresh invalidates the old snapshot even on failure. The original share URL can remain separately visible in the UI. Supplying a different episode feed than source URL is rejected.

The episode action “先听原声” sends the same chosen episode with top-level `intent:"media_only"` and no `transcript_url`. The server resolves the publisher feed/episode, requires a supported public enclosure within the existing declared size/duration limits, and returns the existing `needs_transcription` audio-only project plus guarded media descriptor. It does not fetch any advertised transcript or media bytes. This is an explicit alternative; normal transcript imports still expose parsing/network errors and never silently fall back to audio. Unsupported intents, missing episode selection, and conflicting transcript selectors are rejected.

The project retains its canonical feed/episode identity. A repeated source offers existing-project selection or an explicit independent copy; it cannot downgrade an existing transcript. Later publisher-track import offers a preview and explicit in-place attachment, preserving the original project key, media source, project notes and bookmarks. Media download and playback remain separate explicit actions, including after reload; listening resume seeks without autoplay.

Remote media descriptors contain `{kind,url,name,mimeType,availability:"remote",download:{endpoint,body}}`. Fetch the descriptor's same-origin `/api/podcasts/media` with its JSON body and use the returned blob; do not turn `media.url` into an unrestricted direct player request. Local files use `availability:"local_session"` and have no server URL. Captions alone do not promise downloadable video.

Development video fallback: when the original-caption check positively finishes with `no_matching_captions` and the configured development helper advertises support, the blocked receipt may include `error.audio_fallback`. The UI offers a separate explicit `POST /api/videos/media` with `{url,language,consent:true}`. The server rechecks access, identity and captions before fetching one eligible direct M4A 或经过核对的单文件 MP4 audio format. Newly available captions, access/network/parse errors, or ambiguous language stop this action. No redirect, cookie, PO-token provider, alternate client or manifest fallback is used. The bounded binary response carries only canonical source metadata in `X-Coconut-Media-Source`; transient CDN URLs never persist. The browser creates a new File-backed audio-only project with canonical source URL and `media_provenance`, then uses the same explicit local-ASR flow described below. This is not a generic video downloader or a promise that every video exposes anonymous M4A 或经过核对的单文件 MP4.

## One user-visible task, existing Python execution backend

The process owner may explicitly set `COCONUT_ASR_EXECUTOR_URL=http://127.0.0.1:<existing-python-port>` before starting the Node bridge. Only numeric 127.0.0.1 HTTP roots are accepted; localhost/DNS targets are rejected. This does not start Python, install dependencies, download models, or enable a proxy. Browser requests cannot configure an executor address. The UI never needs a different port or a direct Python API URL.

`GET /api/v1/ingestions/capabilities` reports preparation properties and actual read-only `transcription` status. Missing configuration, unavailable/incompatible executor, missing dependencies, and missing cached model have distinct codes/messages. Presence checks are **not inference validation**. The optional Python backend exposes `/api/ingestion-executor/status`; its local-only path uses the existing small faster-whisper cache, never WhisperX/diarization/alignment fallback. Preparation receipts needing transcription also include this current status.

After an explicit request to generate text, upload the original File to:

`POST /api/v1/ingestions/upload?filename=recording.mp3&language=zh&operation_id=<uuid>&fingerprint=<64hex>&last_modified=<milliseconds>`

Persist the operation UUID and exact file identity in the client journal before sending. The fingerprint is the existing bounded sampled file fingerprint, not proof of full contents. Use `Content-Type: application/octet-stream`, body File (maximum 200 MiB; supported MP3/MP4/WAV/M4A 或经过核对的单文件 MP4/WebM/OGG/FLAC). Language is optional. The bridge rechecks readiness and forwards to the existing `/api/uploads?local_only=true`, whose Python preflight also checks readiness before enqueueing. The source bytes stay on the configured local executor. The existing `jobs.sqlite3` owns persistence; no second queue is introduced.

Response: HTTP 201, `{protocolVersion:1,ingestion:{id,persistent:true,state,source:{kind:"file",name},stage,created,updated,error,transcript,media}}`.

Durable states are `queued`, `running`, `ready`, `failed`, `interrupted`, `cancelled`. Only a real running job should be described as processing. Closing the browser does not cancel a persisted job; explicit cancellation does. A lost submission response must be reconciled using the exact operation lookup below; listing a matching filename is not sufficient. It must not be automatically uploaded again.

- `GET /api/v1/ingestions/jobs`: list only local-only ingestion jobs.
- `GET /api/v1/ingestions/jobs/:id`: status.
- `GET /api/v1/ingestions/jobs/:id/result`: completed original `transcript.document`.
- `GET|HEAD /api/v1/ingestions/jobs/:id/media`: same-origin original-file playback, supporting Range in every admitted task state, including failed/interrupted/cancelled. The current browser File remains playable before upload completes.
- `POST /api/v1/ingestions/jobs/:id/cancel` or `/retry`, JSON `{protocolVersion:1}`: existing queue operations; retry rechecks local-only readiness and reuses the same job ID.

All durable task receipts provide `media.url` (with `availability:"executor"`, kind, name, and MIME type) on the unified route. Use it rather than constructing the legacy Python `/api/jobs/.../media` route from document metadata. Do not change the original document to manufacture a new identity. Existing canonical library CAS and source-binding logic still own committing the result into the intended project; stale task output must not replace a newer project.

## Verification boundaries

Offline tests exercise source routing, explicit selection, unchanged transcript data, caption failures, abort handling, unavailable configuration/models, guarded local-only uploads, durable status/action mapping, and a real loopback fixture transport with range playback. They do not contact content platforms, activate the user's proxy, load a model, test transcription quality, or confirm a user's local service installation. A real public Xiaoyuzhou no-transcript sample has now passed the optional local executor, frontend job-controller reload, original-project attachment and canonical save/reload. The exact source, versions, timings and remaining YouTube/Bilibili live-access limitations are recorded in [public ingestion evidence](public-ingestion-evidence.md). That sample does not establish transcription accuracy or universal platform availability.

Executor responses are checked against the requested job ID and uploaded filename. Only boolean local_only:true jobs are admitted. Result documents must preserve explicit segment IDs and the matching original-media job/kind, and pass reader schema validation without rewriting the evidence. Media playback requires the original MIME, bounded declared/actual bytes, and exact requested range semantics; incomplete streams are terminated rather than returned as successful playback.

## Lost upload acknowledgement and explicit recovery

The unified Node upload API requires a lowercase canonical UUID `operation_id`, the 64-character lowercase hexadecimal sampled `fingerprint`, integer `last_modified`, filename, and byte count from Content-Length. Optional language defaults to an empty string. Python persists this exact metadata and the operation-to-job mapping in the existing jobs SQLite database, in the same transaction as enqueueing. The source bytes are complete before admission. The job's `source` receipt includes `operation_id`, `size`, `fingerprint`, `last_modified`, and `language` alongside its filename (`name`). Legacy Python-only uploads without operations remain compatible, but cannot be claimed through this recovery protocol.

`GET /api/v1/ingestions/operations/:operation_id?filename=...&size=...&fingerprint=...&last_modified=...&language=...`

- 200: `{protocolVersion:1,ingestion}` with all identity fields matched to the persisted operation.
- 404: `{code:"ingestion_operation_not_found",error:...}`. This does not by itself authorize resubmission or changing the key.
- 409: `{code:"ingestion_operation_conflict",error:...}`. The operation exists with different request metadata or submitted bytes.
- Transport/backend errors remain errors, never a fabricated not-found result.

After an uncertain upload acknowledgement, query this operation first. The UI must validate the complete binding and current project identity before adopting its job/result. A user may explicitly resend the original File with the same operation and exact metadata after reconciliation; never invent a new operation to escape uncertainty. Repeated same-operation POSTs still consume and hash the full upload: the persisted full SHA-256 must match, so changed bytes cannot be accepted merely by repeating a sampled fingerprint. Matching replay returns the original job without another queue admission or inference. Metadata mismatches, full-byte mismatches, concurrent duplicates and restart replays cannot create another job for the operation. Existing matching operations remain recoverable even if the local model later becomes unavailable. No replay implicitly retries a failed/cancelled job; the separate explicit retry action remains required.
