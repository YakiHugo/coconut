/** Authored overlap and Unicode notes only; no external media or model output. */
export const blankNote = ' \t\r\n\u0085\u00a0\u2003\u2028\u2029\u3000\ufeff ';
export const writtenNote = '  Café e\u0301 中文 👩‍💻\n  A saved observation.  ';
export function readingMetadataFixture() {
 return {
  title: '重叠字幕 · 阅读元数据', language: 'en',
  segments: [
   {id: 'wide', start: 0, end: 125.75, text: 'An early cue remains active after the final cue.', speaker: 'A'},
   {id: 'noted', start: 10, end: 15, text: 'A shorter overlapping cue has a written note.', speaker: 'B'},
   {id: 'excerpt', start: 12, end: 14, text: 'This excerpt is useful without a written note.', speaker: 'A', saved_excerpt: true},
   {id: 'last', start: 20, end: 21, text: 'The final cue does not determine the total duration.', speaker: 'B'},
  ],
  notes: {wide: blankNote, noted: writtenNote, excerpt: blankNote, last: ''},
 };
}
export function audioMetadataFixture(duration = 190) {
 return {
  project_kind: 'audio_only', title: '原声元数据', segments: [],
  podcast_source: {kind: 'direct_media', media_url: 'https://example.com/authored.wav', media_kind: 'audio'},
  ...(duration === undefined ? {} : {media_duration: duration}),
  project_note: blankNote,
  timestamp_bookmarks: [{id: 'empty', time: 5, note: blankNote}, {id: 'written', time: 10, note: writtenNote}],
 };
}
