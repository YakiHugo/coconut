import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {longReadingFixture} from './helpers/long-reading-fixture.mjs';
const root = new URL('../', import.meta.url);
const key = 'coconut-reader-v1';
function setup(saved) {
  const w = new Window({url: 'https://coconut.example/'});
  w.document.body.innerHTML = fs.readFileSync(new URL('reader/index.html', root), 'utf8').split('<body>')[1].split('</body>')[0];
  Object.defineProperty(w, 'crypto', {value: webcrypto});
  if (saved) w.localStorage.setItem(key, saved);
  w.eval(fs.readFileSync(new URL('reader/summary.js', root), 'utf8'));
  w.eval(fs.readFileSync(new URL('reader/core.js', root), 'utf8'));
  w.eval(['app', 'language', 'podcasts'].map(name => fs.readFileSync(new URL('reader/' + name + '.js', root), 'utf8')).join('\n'));
  const calls = [];
  w.fetch = async (...args) => {calls.push(args); throw new Error('Unexpected network request');};
  w.HTMLElement.prototype.scrollIntoView = function () {w.lastScrolledSegment = this.dataset.segmentId;};
  return {w, $: id => w.document.getElementById(id), calls};
}
async function importDocument($, value) {
  const text = JSON.stringify(value);
  Object.defineProperty($('file'), 'files', {configurable: true, value: [{name: 'harbor.json', size: Buffer.byteLength(text), text: async () => text}]});
  await $('file').onchange();
}
const rows = w => [...w.document.querySelectorAll('#transcript .segment')];
const persisted = w => JSON.parse(w.localStorage.getItem(key));
const activeDoc = w => {const saved = persisted(w); return saved.documents.find(d => d.key === saved.active);};
function search($, query) {$('search').value = query; $('search').oninput();}
async function captureExport(w, $, id) {
  let blob;
  w.URL.createObjectURL = value => {blob = value; return 'blob:audit-fixture';};
  w.URL.revokeObjectURL = () => {};
  $('' + id).click();
  assert.ok(blob, 'An export blob was created');
  return await blob.text();
}

test('1,771 authored bilingual cues search and jump across all pages with no network', async () => {
  const {w, $, calls} = setup();
  try {
    const fixture = longReadingFixture();
    await importDocument($, fixture); $('mode-bilingual').click();
    assert.equal(rows(w).length, 100);
    assert.equal(w.document.querySelectorAll('.translation').length, 100);
    search($, '远方灯塔');
    assert.deepEqual(rows(w).map(row => row.dataset.segmentId), ['harbor-1668']);
    $('next-match').click();
    assert.equal(w.document.activeElement.dataset.segmentId, 'harbor-1668');
    assert.equal(w.lastScrolledSegment, 'harbor-1668');
    // Search includes valid saved translations even while only source text is displayed.
    $('mode-transcript').click(); assert.equal(rows(w)[0].dataset.segmentId, 'harbor-1668');
    assert.equal(w.document.querySelectorAll('.translation').length, 0);
    $('mode-bilingual').click(); assert.equal(w.document.querySelectorAll('.translation').length, 1);
    search($, 'Harbor notebook'); $('previous-match').click();
    assert.equal(w.document.activeElement.dataset.segmentId, 'harbor-1770');
    assert.equal(rows(w).length, 71); assert.match($('match-position').textContent, /^1771 \/ 1771/);
    $('next-match').click(); assert.equal(w.document.activeElement.dataset.segmentId, 'harbor-0');
    assert.equal(rows(w).length, 100); assert.match($('match-position').textContent, /^1 \/ 1771/);
    search($, 'no match'); $('reading-jump').value = 'harbor-1770'; $('reading-jump').onchange();
    assert.equal($('search').value, ''); assert.equal(w.document.activeElement.dataset.segmentId, 'harbor-1770');
    assert.equal(rows(w).length, 71); assert.equal(calls.length, 0);
  } finally {await w.happyDOM.close();}
});

test('last-page note, edit, excerpt and resume survive reload and both JSON recovery paths', async () => {
  const {w, $, calls} = setup(); let saved, singleBackup, libraryBackup;
  try {
    await importDocument($, longReadingFixture());
    $('overview-segments').lastElementChild.click();
    let last = rows(w).at(-1); assert.equal(last.dataset.segmentId, 'harbor-1770');
    last.querySelector('.note-button').click();
    $('note').value = 'My own closing thought.\n第二行：这份笔记应随备份完整保留。'; $('note').oninput();
    $('close-note').click(); last = rows(w).at(-1);
    last.querySelector('.excerpt-button').click();
    last = rows(w).at(-1); last.querySelector('.bookmark-button').click();
    last = rows(w).at(-1); last.querySelector('.edit-button').click();
    $('edit-segment').value = 'Corrected closing thought. The quiet-window remains open.'; $('save-edit').click();
    assert.equal(rows(w).at(-1).querySelector('.translation').classList.contains('stale'), true);
    assert.equal(w.document.activeElement.className, 'edit-button');
    search($, 'no matching words');
    singleBackup = await captureExport(w, $, 'export');
    libraryBackup = await captureExport(w, $, 'export-library');
    const markdown = await captureExport(w, $, 'export-notebook');
    assert.match(markdown, /第二行：这份笔记应随备份完整保留/);
    assert.match(markdown, /Corrected closing thought/); assert.match(markdown, /Harbor notebook 1771/);
    assert.doesNotMatch(markdown, /末段保留一扇安静的窗/, 'Stale translated wording is not exported as current');
    assert.equal(calls.length, 0); saved = w.localStorage.getItem(key);
  } finally {await w.happyDOM.close();}
  for (const recovery of ['reload', 'document-import', 'library-restore']) {
    const env = setup(recovery === 'reload' ? saved : undefined);
    try {
      if (recovery === 'document-import') await importDocument(env.$, JSON.parse(singleBackup));
      if (recovery === 'library-restore') {
        Object.defineProperty(env.$('library-file'), 'files', {configurable: true, value: [{size: Buffer.byteLength(libraryBackup), text: async () => libraryBackup}]});
        await env.$('library-file').onchange();
      }
      const doc = activeDoc(env.w); assert.equal(doc.segments.length, 1771, recovery);
      assert.equal(doc.readingPosition, 'harbor-1770', recovery); assert.equal(doc.segments.at(-1).saved_excerpt, true, recovery);
      assert.match(doc.notes['harbor-1770'], /第二行/); assert.match(doc.segments.at(-1).original_text, /Harbor notebook 1771/);
      env.$('resume').click(); assert.equal(env.w.document.activeElement.dataset.segmentId, 'harbor-1770', recovery);
      assert.equal(rows(env.w).length, 71); assert.equal(env.calls.length, 0);
    } finally {await env.w.happyDOM.close();}
  }
});

test('long-document content state survives layout changes, note edits and literal searches', async () => {
  const {w, $, calls} = setup();
  try {
    await importDocument($, longReadingFixture());
    search($, 'compass-marker'); $('previous-match').click();
    assert.equal(w.document.activeElement.dataset.segmentId, 'harbor-1746');
    const before = rows(w).map(row => row.dataset.segmentId);
    for (const layout of ['large', 'spacious', 'standard']) {
      $('reading-layout').value = layout; $('reading-layout').onchange();
      assert.deepEqual(rows(w).map(row => row.dataset.segmentId), before);
    }
    // Happy DOM verifies state only; it cannot prove anchoring after a viewport resize.
    w.happyDOM.setViewport({width: 390, height: 844}); w.dispatchEvent(new w.Event('resize'));
    assert.deepEqual(rows(w).map(row => row.dataset.segmentId), before);
    $('mode-transcript').click(); $('mode-bilingual').click(); assert.deepEqual(rows(w).map(row => row.dataset.segmentId), before);
    rows(w).at(-1).querySelector('.note-button').click(); $('note').value = '[a.*] literal text <tag>'; $('note').oninput(); $('close-note').click();
    search($, '[a.*]'); assert.equal(rows(w).length, 1); assert.equal(w.document.querySelector('tag'), null);
    assert.equal(w.document.querySelector('.saved-note mark').textContent, '[a.*]');
    assert.equal(calls.length, 0);
  } finally {await w.happyDOM.close();}
});

test('bookmark activation should keep keyboard focus on the replacement bookmark control', async () => {
  const {w, $} = setup();
  try {
    await importDocument($, longReadingFixture()); $('overview-segments').lastElementChild.click();
    const button = rows(w).at(-1).querySelector('.bookmark-button');
    button.focus(); button.click();
    assert.equal(w.document.activeElement.closest('.segment')?.dataset.segmentId, 'harbor-1770');
    assert.equal(w.document.activeElement.className, 'bookmark-button');
  } finally {await w.happyDOM.close();}
});
