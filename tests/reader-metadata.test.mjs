// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import C from '../reader/core.js';

import {blankNote, writtenNote, readingMetadataFixture, audioMetadataFixture} from './helpers/reading-metadata-fixture.mjs';

test('duration uses the latest end, never sums overlaps or rewrites source ordering and times', () => {
 const doc = C.validate(readingMetadataFixture()), before = JSON.stringify(doc);
 assert.equal(C.documentDuration(doc), 125.75);
 assert.equal(C.time(C.documentDuration(doc)), '02:05');
 assert.equal(C.documentDuration({...doc, segments: [...doc.segments].reverse()}), 125.75);
 assert.equal(C.documentDuration({...doc, segments: [{start: 0, end: 0}]}), 0);
 assert.equal(C.documentDuration({...doc, segments: []}), 0);
 const shorter = C.validate({title: 'Shorter', segments: [{start: 0, end: 90, text: 'Shorter source.'}]});
 assert.deepEqual(C.sortedLibrary([doc, shorter], 'duration'), [shorter, doc]);
 assert.equal(JSON.stringify(doc), before);
 assert.throws(() => C.validate({...doc, segments: [...doc.segments].reverse()}), /时间戳无效/);
 const audio = C.validate(audioMetadataFixture());
 assert.equal(C.documentDuration(audio), 190);
 delete audio.media_duration;
 assert.equal(C.documentDuration(audio), 0);
 const attached = C.attachProjectTranscript(C.validate(audioMetadataFixture()), doc);
 assert.equal(C.documentDuration(attached), 125.75, 'Transcript metadata describes its cue coverage, not its separately known media duration');
});

test('one non-mutating presence rule handles Unicode whitespace and preserves meaningful Unicode', () => {
 for (const value of ['', blankNote, '\n\r\t', null, undefined, 0, {}]) assert.equal(C.hasNoteContent(value), false);
 for (const value of [writtenNote, '0', '\u200b', '\u200d', '\u0301', '👩‍💻']) assert.equal(C.hasNoteContent(value), true);
 const doc = C.validate(readingMetadataFixture()), before = JSON.stringify(doc);
 doc.notes.orphan = 'Not attached to a source cue';
 assert.equal(C.segmentNoteCount(doc), 1);
 assert.deepEqual(doc.segments.filter(s => C.matchesSegment(s, doc, '', true)).map(s => s.id), ['noted']);
 assert.deepEqual(C.notebookSegments(doc).map(s => s.id), ['noted', 'excerpt']);
 assert.equal(C.libraryMatches(doc, 'Not attached', 'all', 'notes'), false);
 assert.deepEqual(C.libraryHits(doc, '\u0085', 'notes'), [], 'Whitespace-only notes do not produce search previews');
 assert.deepEqual(C.libraryHits(doc, 'Not attached', 'notes'), [], 'Orphan notes do not become search previews');
 delete doc.notes.orphan;
 assert.equal(JSON.stringify(doc), before);
 assert.equal(doc.notes.wide, blankNote);
 assert.equal(doc.notes.noted, writtenNote);
 const markdown = C.notebookMarkdown(doc);
 assert.match(markdown, /Coconut 阅读笔记 · 2 个片段/);
 assert.equal((markdown.match(/我的笔记：/g) || []).length, 1);
 assert.equal(markdown.includes(blankNote), false);
 assert.match(markdown, />   Café e\u0301 中文 👩‍💻\n>   A saved observation\\\.  /u);
 assert.deepEqual(C.validate(JSON.parse(JSON.stringify(doc))).notes, doc.notes);
});

test('project notes and untitled timestamp bookmarks stay distinct annotation items in audio and attached transcripts', () => {
 const audio = C.validate(audioMetadataFixture());
 assert.equal(C.segmentNoteCount(audio), 0);
 assert.equal(C.projectAnnotationCount(audio), 2);
 assert.equal(C.libraryMatches(audio, '', 'annotated'), true);
 const markdown = C.notebookMarkdown(audio);
 assert.equal((markdown.match(/时间书签（未填写笔记）/g) || []).length, 1);
 assert.doesNotMatch(markdown, /## 项目笔记/);
 assert.equal(audio.timestamp_bookmarks[0].note, blankNote);
 audio.project_note = writtenNote;
 assert.equal(C.projectAnnotationCount(audio), 3);
 assert.match(C.notebookMarkdown(audio), /## 项目笔记/);
 const attached = C.attachProjectTranscript(audio, readingMetadataFixture());
 assert.equal(C.segmentNoteCount(attached), 1);
 assert.equal(C.projectAnnotationCount(attached), 3);
 const combined = C.notebookMarkdown(attached);
 assert.match(combined, /2 个片段/);
 assert.match(combined, /### 项目笔记/);
 assert.equal((combined.match(/时间书签（未填写笔记）/g) || []).length, 1);
 assert.equal(attached.project_note, writtenNote);
 assert.equal(attached.timestamp_bookmarks[0].note, blankNote);
 const unannotated = C.validate({...readingMetadataFixture(), segments: readingMetadataFixture().segments.map(({saved_excerpt, ...cue}) => cue), notes: {wide: blankNote}});
 assert.equal(C.libraryMatches(unannotated, '', 'annotated'), false);
 assert.equal(C.notebookSegments(unannotated).length, 0);
});
