# Incremental local worker protocol v1

Implemented internal Python entry point; not a change to default transcription.
Only an explicitly authorized combined Node task should invoke it. Only local
Qwen and actual MP3/FLAC demuxers can run speculative recognition; other containers
wait for complete media and use the normal buffered path. No review API is called.

## Request and controls

Spawn `transcription.py` with a private **read-only regular-file FD at 3**. Stdin
remains a parent-lifetime/control channel. Its first NDJSON record (<=64 KiB):

```json
{"operation":"transcribe_incremental","protocol_version":1,"attempt_id":"UUID",
 "media_fd":3,"local_only":true,"work":"/private/attempt-work",
 "source_snapshot":{},"profile":{"backend":"qwen-mlx"}}
```

Optional frozen context: `title`, `context`, `hotwords`, `name_corrections`,
`speaker_count`. The initial request must contain no `review` operation. The probe
uses `--probe` with `operation: "probe_incremental"` and the same local profile.

Subsequent records have matching `attempt_id` and one of:

- `{type:"append", available_bytes:N}`: nondecreasing, <= actual FD length and
  <=200 MiB. Only actual growth resets the spool-wait clock.
- `{type:"seal", size:N, sha256:"64 lowercase hex"}`: N equals the final watermark
  and actual FD length. Node sends it only after durable media receipt validation.
- `{type:"abort"}`: fail and stop. A watermark is not EOF; only seal allows EOF.

Keep stdin open after seal. EOF at any time during processing means parent loss,
not a successful transfer. Invalid controls terminate the worker. Waiting at a
watermark has a 120-second inactivity limit; Node retains its independent request
and process timeouts. Cancellation is not a fallback condition.

## Finalization

Candidate files are raw ASR results, never stitched, speaker-labeled or exposed.
Their identity includes exact chunk/core clocks, WAV SHA and backend cache key
(including model/runtime/context). Decoder queue capacity is 1. The decoder has a
hard limit of 6 hours' actual mono 16 kHz PCM frames, independent of metadata.

After seal, Python recomputes full compressed SHA from the same descriptor while
creating a bounded private sealed copy. Provisional full PCM is removed first.
The canonical pipeline uses normal seekable decoding with an actual-frame limit.
Only exact canonical chunk/PCM/backend matches can reuse candidates. A changed
MP3 tail is re-recognized, not trimmed. Final speaker reconciliation and document
creation are the ordinary buffered pipeline; defaults and chunk size stay intact.

The worker refuses an existing final `work/result.json` or reused private attempt
directory. Node should provide a new work directory for each physical attempt.
Checkpoint reuse across separately downloaded objects is not assumed.

On success, `work/result.json` is the ordinary transcript document, accompanied by
`work/incremental_receipt.json`:

```text
protocol_version: 1
attempt_id, source_sha256, size
source_snapshot: original request object
profile: original request object
frozen_context: {title, context, hotwords, name_corrections, speaker_count}
reused_chunks, recomputed_chunks: integers
fallback_reason: null | stream_decode_unavailable | canonical_pcm_mismatch
```

Missing frozen-context fields become `null`. Node must compare this receipt to its
frozen operation and canonical media receipt before reporting ready or exposing
result. Child exit success alone does not validate ownership in the Node ledger.
Stdout uses ordinary safe progress phases plus `fallback` with the above reason
allowlist. SHA/size mismatch, truncation, resource limit and cancellation fail the
operation instead of falling back.

## Resources and verification boundary

The worker admission-reserves its worst-case two PCM copies, two compressed-media
copies and checkpoint headroom against a 2 GiB work budget. It also checks storage
before candidate commits and source copying. This is **not an OS disk quota** on
arbitrary model-library scratch files: Node must retain aggregate admission limits
and monitor/retire attempt storage. Actual decode frame and compressed-input byte
limits are enforced in the data path. Model allocator memory is not bounded by
queue capacity.

Normal exit/failure removes transient PCM and sealed copies but preserves private
JSON checkpoints. SIGKILL cannot run Python cleanup: Node crash recovery must
retire only known files under its own attempt directory and mark the attempt
interrupted, never automatically restart or delete canonical media.

Tests cover actual MP3 decoding and tail cache rejection, capped canonical and
streaming decoders, FD3/NDJSON in a real child process, sealed SHA, parent loss,
watermark waiting and blocked-decoder shutdown. Recognition in these tests is a
deterministic local fixture. No real-model recognition quality or runtime/memory
improvement is claimed.
