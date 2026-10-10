import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import C from '../reader/core.js';
import {blankNote, writtenNote, readingMetadataFixture, audioMetadataFixture} from './helpers/reading-metadata-fixture.mjs';
const root = new URL('../', import.meta.url), KEY = 'coconut-reader-v1';
function setup(saved) {
 const w = new Window({url: 'https://coconut.example/'});
 w.document.body.innerHTML = fs.readFileSync(new URL('reader/index.html', root), 'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w, 'crypto', {value: webcrypto});
 if (saved) w.localStorage.setItem(KEY, saved);
 const calls = [];
 w.fetch = async (...args) => { calls.push(args); throw new Error('Unexpected request'); };
 for (const name of ['summary', 'core', 'passages', 'passage-playback']) w.eval(fs.readFileSync(new URL('reader/' + name + '.js', root), 'utf8'));
 w.eval(['app', 'language', 'podcasts'].map(name => fs.readFileSync(new URL('reader/' + name + '.js', root), 'utf8')).join('\n'));
 w.HTMLElement.prototype.scrollIntoView = function () {};
 return {w, $: id => w.document.getElementById(id), calls, close: async () => {w.dispatchEvent(new w.Event('pagehide')); await w.happyDOM.close();}};
}
async function load(env, fixture) {
 const text = JSON.stringify(fixture);
 Object.defineProperty(env.$('file'), 'files', {configurable: true, value: [{name: 'authored.json', size: Buffer.byteLength(text), text: async () => text}]});
 await env.$('file').onchange();
}
const rows = env => [...env.$('transcript').querySelectorAll('.segment')];
const row = (env, id) => rows(env).find(node => node.dataset.segmentId === id);
const saved = env => {const state = JSON.parse(env.w.localStorage.getItem(KEY)); return state.documents.find(doc => doc.key === state.active);};
const type = (env, id, value) => {env.$(id).value = value; env.$(id).oninput();};

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

test('shelf, header, overview, passages, filters and notebook agree without changing saved source data', async () => {
 const env = setup();
 try {
  const fixture = readingMetadataFixture(); await load(env, fixture);
  const {$, w} = env, before = w.localStorage.getItem(KEY);
  assert.match($('library').textContent, /02:05 · 1 则片段笔记/);
  assert.match($('subtitle').textContent, /4 个片段 · 02:05/);
  assert.equal($('overview-duration').textContent, '02:05 · 4 段');
  assert.equal($('passage-total-time').textContent, '02:05');
  assert.equal($('passage-time-range').max, '126');
  assert.match($('passage-time-range').getAttribute('aria-valuetext'), /共 02:05/);
  assert.equal($('note-count').textContent, '1');
  assert.equal($('export-notebook').textContent, '导出阅读笔记（2 段）');
  assert.equal($('passage-body').querySelectorAll('.passage-annotation').length, 2);
  assert.match($('passage-body').querySelector('[data-cue-id="excerpt"].passage-annotation').textContent, /已摘录原文/);
  $('mode-transcript').click();
  assert.equal(row(env, 'wide').querySelector('.saved-note'), null);
  assert.equal(row(env, 'wide').querySelector('.note-button').textContent, '＋ 记一笔');
  assert.equal(row(env, 'noted').querySelector('.saved-note').textContent, writtenNote);
  $('filter-notes').click();
  assert.deepEqual(rows(env).map(node => node.dataset.segmentId), ['noted']);
  assert.match($('search-status').textContent, /找到 1 个片段/);
  type(env, 'search', 'does not occur');
  assert.equal(rows(env).length, 0);
  assert.equal($('note-count').textContent, '1', 'The badge is the full-document total');
  assert.equal($('export-notebook').textContent, '导出阅读笔记（2 段）');
  $('clear-search').click();
  assert.equal(rows(env).length, 4);
  assert.match($('search-status').textContent, /共 4 个片段/);
  assert.equal(w.localStorage.getItem(KEY), before);
  assert.deepEqual(saved(env).notes, fixture.notes);
  assert.equal(env.calls.length, 0);
 } finally { await env.close(); }
});

test('note membership updates while typing, retaining the editor and raw whitespace through repeated transitions and reload', async () => {
 const env = setup(); let stored;
 try {
  await load(env, {title: 'Live counts', segments: [{id: 'a', start: 0, end: 1, text: 'First cue'}, {id: 'b', start: 1, end: 2, text: 'Second cue'}], notes: {a: 'needle'}});
  const {$, w} = env;
  $('mode-transcript').click(); $('filter-notes').click(); row(env, 'a').querySelector('.note-button').click();
  const editor = $('note'), close = $('close-note');
  for (let i = 0; i < 2; i++) {
   type(env, 'note', blankNote);
   assert.equal($('note'), editor); assert.equal($('close-note'), close);
   assert.equal(w.document.activeElement, editor); assert.equal($('notes-panel').hidden, false);
   assert.equal(rows(env).length, 0); assert.equal($('note-count').textContent, '0');
   assert.match($('search-status').textContent, /找到 0 个片段/);
   assert.equal($('export-notebook').disabled, true);
   assert.equal(saved(env).notes.a, blankNote);
   type(env, 'note', 'needle again');
   assert.equal(rows(env).length, 1); assert.equal($('note-count').textContent, '1');
   assert.equal(w.document.activeElement, editor);
   assert.equal($('export-notebook').disabled, false);
  }
  type(env, 'search', 'needle'); row(env, 'a').querySelector('.note-button').click();
  type(env, 'note', 'Different written content');
  assert.equal(rows(env).length, 0); assert.equal($('note-count').textContent, '1');
  assert.match($('search-status').textContent, /找到 0 个片段/);
  assert.equal($('notes-panel').hidden, false);
  $('return-excerpt').click();
  assert.equal(rows(env).length, 2); assert.equal($('search').value, '');
  row(env, 'a').querySelector('.note-button').click(); type(env, 'note', blankNote);
  assert.equal(row(env, 'a').querySelector('.saved-note'), null);
  $('filter-notes').click();
  assert.equal(rows(env).length, 0);
  $('filter-all').click(); row(env, 'a').querySelector('.note-button').click();
  assert.equal($('note').value, blankNote, 'Opening the editor keeps its stored whitespace');
  $('close-note').click(); stored = w.localStorage.getItem(KEY);
  assert.equal(saved(env).notes.a, blankNote, 'Opening an editor never rewrites saved bytes');
 } finally { await env.close(); }
 const restored = setup(stored);
 try {
  assert.equal(restored.$('note-count').textContent, '0');
  assert.equal(restored.$('export-notebook').disabled, true);
  assert.equal(saved(restored).notes.a, blankNote);
 } finally { await restored.close(); }
});

test('audio and attached-project shelf metadata and annotated filtering update from project and bookmark edits', async () => {
 const env = setup();
 try {
  const {$} = env; await load(env, audioMetadataFixture());
  assert.match($('library').textContent, /03:10 · 0 则项目笔记 · 2 个时间书签/);
  assert.match($('subtitle').textContent, /03:10/);
  assert.equal($('export-notebook').textContent, '导出原声项目笔记（2 项）');
  type(env, 'project-note', writtenNote);
  assert.match($('library').textContent, /1 则项目笔记 · 2 个时间书签/);
  assert.equal($('export-notebook').textContent, '导出原声项目笔记（3 项）');
  type(env, 'project-note', blankNote);
  assert.match($('library').textContent, /0 则项目笔记/);
  const doc = saved(env); const attached = C.attachProjectTranscript(doc, readingMetadataFixture());
  await load(env, attached);
  assert.match($('library').lastElementChild.textContent, /02:05 · 1 则片段笔记 · 0 则项目笔记 · 2 个时间书签/);
  assert.equal($('note-count').textContent, '1');
  assert.equal($('export-notebook').textContent, '导出阅读笔记（4 项）');
  const unknown = audioMetadataFixture(); delete unknown.media_duration; unknown.title = 'Unknown length'; unknown.timestamp_bookmarks = [];
  await load(env, unknown);
  assert.match($('library').lastElementChild.textContent, /时长待确认/);
  assert.match($('subtitle').textContent, /时长待确认/);
  $('library-kind').value = 'annotated'; $('library-kind').onchange();
  assert.equal($('library').children.length, 2);
  type(env, 'project-note', 'A new project note');
  assert.equal($('library').children.length, 3);
  type(env, 'project-note', blankNote);
  assert.equal($('library').children.length, 2);
  assert.equal(env.calls.length, 0);
 } finally { await env.close(); }
});

test('duration sorting in the shelf agrees with displayed totals and leaves persisted order alone', async () => {
 const env = setup();
 try {
  await load(env, readingMetadataFixture());
  await load(env, {title: 'Shorter source', segments: [{id: 'short', start: 0, end: 90, text: 'A shorter source'}]});
  const before = env.w.localStorage.getItem(KEY), {$} = env;
  $('library-sort').value = 'duration'; $('library-sort').onchange();
  assert.deepEqual([...$('library').querySelectorAll('.library-title')].map(node => node.textContent), ['Shorter source', readingMetadataFixture().title]);
  assert.match($('library').firstElementChild.textContent, /01:30/);
  assert.match($('library').lastElementChild.textContent, /02:05/);
  assert.equal(env.w.localStorage.getItem(KEY), before);
 } finally { await env.close(); }
});

test('removing the final note on a later result page clamps counts while keeping a writable editor', async () => {
 const env = setup();
 try {
  const segments = Array.from({length: 101}, (_, i) => ({id: 'cue-' + i, start: i, end: i + 1, text: 'Source ' + i}));
  const notes = Object.fromEntries(segments.map(cue => [cue.id, 'Written note']));
  await load(env, {title: 'Many notes', segments, notes});
  const {$, w} = env;
  $('mode-transcript').click(); $('filter-notes').click(); $('next-page').click();
  row(env, 'cue-100').querySelector('.note-button').click();
  type(env, 'note', blankNote);
  assert.equal(rows(env).length, 100);
  assert.equal($('reading-page-status').textContent, '1–100 / 100 段');
  assert.equal($('note-count').textContent, '100');
  assert.equal(w.document.activeElement, $('note'));
  assert.equal($('notes-panel').hidden, false);
  type(env, 'note', 'A restored late note');
  assert.equal($('note-count').textContent, '101');
  assert.match($('search-status').textContent, /找到 101 个片段/);
  $('close-note').click();
  assert.equal(w.document.activeElement, $('filter-notes'));
  $('next-page').click();
  assert.equal(row(env, 'cue-100').querySelector('.saved-note').textContent, 'A restored late note');
 } finally { await env.close(); }
});
