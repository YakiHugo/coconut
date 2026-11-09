# Conservative speaker boundaries

Speaker IDs are acoustic hypotheses, not verified people. These guards prevent
known competing evidence from being erased; they do not establish real-audio
accuracy.

- A short lexical response is not discarded just because it lasts under 0.75 s.
- A coarse cue containing multiple voices is left unresolved, rather than assigned
  to its majority voice. Existing cue IDs, text and clocks remain unchanged.
- Aligned lexical units with unknown or conflicting voices cannot be outvoted by
  a longer phrase. Punctuation cannot create a new voice. Fresh ASR cues may split
  at supported lexical boundaries; imported documents are not silently split.
- Simultaneously active, distinct local clusters cannot be merged based solely on
  embedding similarity or an expected participant count. A later refinement pass
  must retain this restriction. Similar but ambiguous voices remain unknown.

Regression tests use authored timings and embeddings. They prove these safeguards,
not model quality. Before claiming better diarization, evaluate fixed audio with
short replies, overlapping speech, similar voices and one cue spanning a speaker
change. Report both wrong attribution and unresolved rates; increasing unknowns
is not by itself an accuracy win. Keep the original audio/text available for audit.

Filler cleanup must occur after speaker attribution and must preserve uncertain
responses: a listener's “嗯” is not automatically a filler in the main speaker's
sentence. This patch does not change the user's uncommitted cleanup code.
