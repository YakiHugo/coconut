import {largeLibraryFixture} from './large-library-fixture.mjs';

/** Two self-authored 1,000-cue sources. No recordings or model output. */
export function readingViewResumeFixture(label = 'desktop') {
  return largeLibraryFixture(2, {cues: 1000}).map((doc, documentIndex) => {
    const letter = documentIndex ? 'B' : 'A';
    doc.key = 'reading-resume-' + label + '-' + letter;
    doc.title = 'Authored reading ' + letter + ' · ' + label;
    doc.translation_view = 'zh';
    doc.segments.forEach((cue, index) => {
      cue.text = 'Authored ' + letter + ' source ' + index + '. We kept this observation beside its original words.';
      cue.speaker = Math.floor(index / 6) % 2 ? 'Iris' : 'Rowan';
      cue.translations = Object.fromEntries([['zh', '自写对照'], ['fr', 'Observation rédigée']].map(([language, text]) => [language, {
        text: text + ' ' + letter + ' ' + index + '.', source_text: cue.text,
        source_language: 'en', document_language: 'en', provider: 'authored fixture; no model',
      }]));
    });
    doc.readingPosition = doc.segments[19].id;
    doc.notes = {[doc.readingPosition]: 'A manual bookmark and note, independent of the current reading view.'};
    doc.reading_chapters = [{id: 'late-' + letter, title: 'Authored later chapter ' + letter,
      cue_id: doc.segments[840].id, time: doc.segments[840].start, note: ''}];
    return doc;
  });
}
