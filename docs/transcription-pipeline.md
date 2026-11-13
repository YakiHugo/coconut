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
On Apple Silicon, the default transcription profile is:

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
The MLX requirements include the acoustic runtime. Both model files must still
be prepared and configured explicitly; readiness checks reject an incomplete
configured pair or a missing speaker dependency before admitting a task.

Qwen's aligned words are split at sentence marks and pauses before speaker
assignment. Its coarse audio extents can contain several people, so assigning
one speaker to each whole extent would leave many turns unresolved. Acoustic
analysis then runs as a separate speaker-only pass with its own checkpoints;
retry reuses the completed recognition and alignment. Wording and word timing
are preserved, and incomplete alignments retain their original text.
Existing subtitle-only readability jobs remain usable independently and never
re-run ASR. Qwen output is not automatically sent through another punctuation
model. Text summaries/interview editions are separate downstream actions.

Recognition receives publisher background directly, without a preliminary LLM
call. Xiaoyuzhou supplies the show name, author, publication date and cleaned
Show Notes (falling back to description); Bilibili supplies uploader, publication
date and video description from the existing metadata extraction. The project
stores these separately as `transcription_context`, never as transcript cues.
Descriptions are bounded to 6,000 characters; the binary video response may
retain a shorter excerpt to keep its metadata header within 8 KiB.

Qwen receives simple labeled lines: title, platform, show, publisher, date and
publisher description, followed by a reminder to follow the actual audio.
Existing confirmed names/terms remain available as hotwords. Source tasks freeze
this input at creation; explicit retry keeps it, while creating a task after a
background change uses separate work. Context participates in checkpoint identity; changing it
uses a separate recognition directory while preserving older work. Hints can
still miss rare name characters. Episode-scoped `verified_asr_aliases` in the
participant evidence can therefore correct explicitly reviewed misspellings
after acoustic assignment. Only unambiguous aliases of equal character length
are accepted, word text is updated without moving clocks, and `original_text`
retains the original recognition. This does not infer aliases from similar
pronunciation or replace another known participant's name.

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
The original offline implementation checks used no Qwen weights. A subsequent
local preparation and real inference smoke is recorded below. A controlled
comparison against the cached Whisper baseline, validation on further full
episodes and peak-memory measurement are still outstanding. Qwen is the selected Apple
Silicon default; this choice does not imply a measured error-rate ranking.

### Local Qwen preparation, 2026-11-04

On an Apple M5 Pro with 48 GB unified memory, a separate Python 3.12 environment
was prepared from `requirements-asr-mlx.txt` (`mlx-audio==0.6.4`,
`mlx==0.32.4`, `av==16.1.0`). The following MLX Community weights were downloaded
explicitly and their complete weight-file SHA-256 values verified against Hub
metadata:

- `Qwen3-ASR-1.7B-8bit`, revision
  `a8379a2e2f9e313c9292cdf1af4055ab56d50d55`.
- `Qwen3-ForcedAligner-0.6B-8bit`, revision
  `0e1a68e91d815300c7c9754b2a7639378b23db15`.

The existing Node transcriber launched actual offline Python tasks on two local
podcast windows. Each run included process startup, model fingerprints, audio
preparation, recognition, forced alignment and result saving:

| Source window | Audio | Wall time | Aligned character/word units |
| --- | ---: | ---: | ---: |
| 00:23–00:50 | 27 s | 9.37 s | 108 |
| 00:50–01:22 | 32 s | 9.29 s | 150 |

Both tasks exited normally, retained word timing without alignment warnings and
passed canonical reader validation. These are short functional smokes, not a
quality ranking or a full-episode speed estimate. Technical names still require
review: the second output contains `SGLand` and `Red Sticks Arc` where the source
metadata names SGLang and RadixArk. No human-reference error rate or peak-memory
measurement was produced, and speaker grouping was not enabled.

Local setup receipts, pinned dependency versions, model identities and outputs
are kept in `.coconut/qwen-setup-2026-11-04/` (ignored by Git). Model paths and the
prepared Python executable are configured only in the local `.env`; startup and
normal transcription still never install dependencies or download weights.

### Full-episode run and default selection, 2026-11-04

The same prepared Qwen profile processed the complete 7,823.72-second Liu Yuan
interview (`BV1bPmuBtEan`) through the application's durable source-job queue.
All 33 chunks completed, with no alignment warning. The final aligned word ends
at 7,822.92 seconds. End-to-end wall time through library import was 765.36
seconds on this machine.

For this result, aligned word boundaries were used to derive 1,405 sentence/pause
cues without changing the recognized text. The new transcript and the original
subtitles are separate library documents, both linked to the same verified audio.
Speaker grouping was not enabled. Receipts and the text-preservation check are
kept in `.coconut/qwen-liuyuan-2026-11-04/` (ignored by Git).

After reviewing this transcript, the owner selected Qwen as the normal local
default. The service already resolves an omitted backend to `qwen-mlx`; the
configuration example now makes that selection explicit. `faster-whisper` stays
an explicit CPU alternative, including the Linux CPU container profile. Missing
Qwen files or dependencies leave transcription unavailable rather than silently
switching engines. This run and the owner's qualitative review do not establish
a human-reference CER/WER result or a general speed guarantee.

The owner subsequently requested speaker labels for this Qwen transcript. The
matching audio SHA-256 and the existing local acoustic checkpoints were verified
and replayed without running recognition again. Labels were added to 675 of
1,405 cues; the other 730 remain unresolved. Text, cue IDs, times and aligned
words were checked unchanged before saving to the same Qwen library document.
The five automatic voice groups are not a claim that five distinct people
spoke; fragmented grouping and unknown turns still need review. The local
configuration now enables both acoustic models for subsequent Qwen tasks.

The initial chunk-greedy voice matching fragmented this two-person interview
into five automatic groups and left many turns ambiguous. This was corrected
with whole-recording reconciliation: long clean acoustic evidence anchors the
clusters, local fragments can merge, and brief mixed/outlier evidence remains
unresolved instead of becoming extra people. The independent speaker stage now
uses this reconciliation by default, reusing its existing acoustic checkpoints.
It supports a per-recording verified participant count without forcing low-score
matches; the normal automatic run found the same two groups on this episode.

The publisher's [episode page](https://elsewhere.news/zh/elsewhere/vol001manus)
lists Liu Jing (刘旌) and Liu Yuan (刘元). The opening journalist/interviewer
remarks and the guest's response, cross-checked against later first-person
investment discussion, anchor the voice-to-role assignment. The same Qwen
document now labels 201 cues as `刘旌（主持人）` and 969 as `刘元（嘉宾）`;
235 remain unresolved. Original text, cue IDs, word timing, notes and audio
binding are preserved. These assignments are source-supported automatic labels,
not a diarization error-rate benchmark or a claim that every turn is correct.
The source and role anchors are stored with the document as
`speaker_identity_evidence`, with local receipts in
`.coconut/qwen-liuyuan-2026-11-04/speaker-reconciliation/`.

A local smoke also exercised the new Node → actual Python → cached
faster-whisper path on the existing 23–50 second podcast excerpt: 27 seconds of
audio, eight Chinese segments, about 5.75 seconds including task process/model
startup, canonical reader validation passed. No weights were downloaded; this
single short-window run is neither a Qwen benchmark nor a full-episode speed
promise. It exposed and fixed a CPython shutdown issue caused by a daemon thread
holding stdin's buffered-reader lock; the normal-exit regression now covers it.
