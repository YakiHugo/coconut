# Local transcription

The standalone single-owner app uses one Node-owned source/transcription ledger:

```text
Browser → Node source job → owned local audio path → Python task
                                   ↓                    ↓
                              SQLite status      recognition checkpoint
                                                 alignment checkpoints
                                                 acoustic checkpoints
                                                        ↓
                                             canonical transcript JSON
                                                        ↓
                          explicit project attachment → reader display
```

`desktop/source-jobs.mjs` queues one source/transcription job at a time. The
source/library lifetime and audio SHA-256 bind the job and result. Browser exit
has no effect; Node shutdown aborts the owned process and marks the task
interrupted. Explicit retry reuses the task's work directory. Results never
silently overwrite the library. Download, recognition and failed stages are not
replayed on status reads. Local files must first be explicitly saved with the
existing source-media control, then use the same project transcription action.

`server/transcription.mjs` launches one `transcription.py` process per task.
stdin carries one server-owned request and remains open as a parent-lifetime
control pipe; stdout carries JSON phase events, stderr is not shown to readers.
The process verifies source bytes, normalizes audio to disk and uses 240-second
owned chunks plus five seconds of context per side. The runtime can subdivide
those chunks. Qwen's aligner never receives a whole multi-hour recording.

## Models and configuration

Nothing installs dependencies or downloads model weights on startup, probe, or
transcription. Paths must point to complete, already prepared local models.
Probes inspect dependencies/files only; they do not establish inference quality.
On Apple Silicon, the initial candidate is:

```dotenv
COCONUT_ASR_PYTHON=/absolute/path/to/prepared/python
COCONUT_ASR_BACKEND=qwen-mlx
COCONUT_ASR_MODEL=/absolute/path/to/Qwen3-ASR-1.7B-8bit
COCONUT_ALIGN_MODEL=/absolute/path/to/Qwen3-ForcedAligner-0.6B-8bit
```

`requirements-asr-mlx.txt` describes the optional MLX environment. It is not
installed automatically or added to the Linux container. Explicit
`faster-whisper` uses the old cached small CPU/int8 baseline, optionally with
`COCONUT_MODEL_DIRECTORY` pointing to its HF cache root. No automatic fallback
uploads audio, selects another model, or downloads missing weights.

Optional `COCONUT_SPEAKER_SEGMENTATION_MODEL` and
`COCONUT_SPEAKER_EMBEDDING_MODEL` enable the existing local acoustic grouping.
Without them, transcription works with unlabeled speakers. Marking speakers is
independent from recognition; labels are automatic/unreviewed, not real names.
Existing subtitle-only readability jobs remain usable independently and never
re-run ASR. Qwen output is not automatically sent through another punctuation
model. Text summaries/interview editions are separate downstream actions.

## Text, timing and recovery

Qwen ASR audio chunk extents are coarse boundaries. Its raw text/segments are
saved before forced alignment. Alignment checkpoints are separate, so a failed
aligner can retry without calling ASR again. Model file fingerprints and runtime
identity participate in work/cache identity. A new configured profile creates a
separate job rather than reusing a different model's result.

Word alignment must cover the complete lexical source in order. Exact source
slices retain punctuation/spacing. Incomplete alignment drops word timing and
keeps all original segment text with an alignment warning; overlap cropping may
use coarse segment ownership, never discard untimed letters. Unknown timing is
not presented as precise word timing. Both legacy and direct runners share this
validation. Acoustic identity and chunk checkpoints retain their existing cache
and ownership rules.

Changing model configuration prevents retrying a direct job under a different
profile. Existing legacy job records are preserved; they are not automatically
adopted or rerun. Old completed results remain in their original Python data
directory, accessible through the legacy tool. Explicit retry can adopt an
interrupted legacy source task. Existing saved library transcripts, revisions,
notes and audio assets remain intact.

## Display language

The reader's Chinese script preference is independent from ASR language:
`system`, `zh-Hans`, `zh-Hant`, or `source`. System mode uses Chinese script/region
from browser language preferences; without a Chinese preference, source text is
kept. OpenCC projects the stored text only for reading/search/TXT/SRT/VTT.
JSON keeps original text and recovery data; notes and corrections keep their
original content. Script conversion is not translation into another language.
Existing translated reading views continue to use saved translations.

Selections over projected text retain canonical source offsets for excerpts and
AI requests when projection preserves character positions. A length-changing
projection refuses exact selection rather than inventing source offsets; switch
to original script to capture that case. IDs, playback times, corrections and
translation freshness are based on the original document.

## Validation boundaries

Offline tests exercise real Node/Python process lifecycle, parent-death cleanup,
source integrity, queue restart/cancel/retry, raw recognition reuse after failed
alignment, partial-timing text preservation, display search/selections/exports,
and existing library attachment. Model stubs are explicitly authored fixtures.
No Qwen weights were downloaded and no real Qwen inference/quality/speed/memory
claim is made. Once networking is available, compare the same real podcast
windows against the cached Whisper baseline, then verify a full episode and
measure actual throughput/peak memory before choosing the default permanently.

A local smoke also exercised the new Node → actual Python → cached
faster-whisper path on the existing 23–50 second podcast excerpt: 27 seconds of
audio, eight Chinese segments, about 5.75 seconds including task process/model
startup, canonical reader validation passed. No weights were downloaded; this
single short-window run is neither a Qwen benchmark nor a full-episode speed
promise. It exposed and fixed a CPython shutdown issue caused by a daemon thread
holding stdin's buffered-reader lock; the normal-exit regression now covers it.
