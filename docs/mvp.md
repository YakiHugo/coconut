# Coconut MVP acceptance scope

Approved direction: long audio/video becomes a readable, source-linked article.

## Required user flow
1. Supply a supported public video URL, local media, or subtitle file.
2. See provenance and processing state; useful original text remains available if an enhancement fails.
3. Read, search, return to the correct source time, correct text, and write notes.
4. Export and restore a portable document without losing notes or source mappings.

## Processing policy
- Prefer usable original-language subtitles before starting speech recognition.
- Label human/platform/automatic transcription sources; never imply subtitles were independently checked.
- Keep recognition, optional time alignment, optional speaker diarization, and polishing separate.
- Preserve source text and timestamps. Polished paragraphs reference source segment IDs.
- No guessed speaker identities. No silent switch to paid cloud processing.
- A static reader publication is a preview, not a complete hosted transcription product.

## Verification before MVP completion
- Actual browser tests of import/read/search/edit/notes/reload/export/reimport and invalid inputs.
- Real audio fixtures covering Chinese, English, mixed technical vocabulary, multiple speakers, and noise; report timing and text errors separately.
- Interrupted/repeated jobs and bounded retry behavior.
- Measure runtime and resource use on the actual target hardware; do not repeat vendor throughput as our own.
- Any external paid processing, new credentials, or paid deployment requires the user's approval.
