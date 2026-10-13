/** Narrow DOM contracts for the CI history/settings reload journeys.
 * Native visibility, pointer geometry and downloads remain browser-only checks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryHarness} from './helpers/large-library-harness.mjs';

const CONTENT = 'coconut-reader-v1';
const entries = storage => Array.from({length: storage.length}, (_, index) => {
  const key = storage.key(index); return [key, storage.getItem(key)];
});
function reload(previous) {
  previous.w.dispatchEvent(new previous.w.Event('pagehide'));
  const local = entries(previous.w.localStorage), session = entries(previous.w.sessionStorage);
  return libraryHarness([], {probe: true, configureCore(w) {
    w.localStorage.clear();
    for (const [key, value] of local) w.localStorage.setItem(key, value);
    for (const [key, value] of session) w.sessionStorage.setItem(key, value);
  }});
}
function input(env, id, value) {
  env.$(id).value = value; env.$(id).dispatchEvent(new env.w.Event('input', {bubbles: true}));
}
const mode = env => env.w.document.body.dataset.readingMode;

test('history reload resumes its transcript detour and the explicit summary tab exposes the complete saved history', async () => {
  const segments = Array.from({length: 3}, (_, i) => ({id: 'cue-' + i, start: i * 4, end: i * 4 + 4, text: 'Authored source ' + i}));
  const doc = {key: 'history', title: 'Authored history reload', language: 'en', segments, notes: {},
    ai_answers: Array.from({length: 245}, (_, i) => ({question: 'Question ' + (i + 1), answer: 'Answer ' + (i + 1),
      purpose: i === 24 ? 'summary' : 'question', provider: 'authored_fixture', citations: ['cue-0']}))};
  const first = libraryHarness([doc], {probe: true}); let restored;
  try {
    assert.equal(mode(first), 'summary', 'first entry still uses the short-document summary default');
    assert.equal(first.$('summary-workspace').hidden, false);
    first.$('browse-ai-history').click();
    assert.equal(mode(first), 'transcript');
    first.$('ai-history-oldest').click();
    first.$('search').focus(); input(first, 'search', 'no authored source matches this filter');
    const before = first.w.localStorage.getItem(CONTENT);
    restored = reload(first);
    assert.equal(mode(restored), 'transcript');
    assert.equal(restored.$('summary-workspace').hidden, true, 'the history entry is inside the hidden summary workspace');
    assert.equal(restored.$('summary-workspace').contains(restored.$('browse-ai-history')), true);
    assert.equal(restored.$('search').value, '', 'the temporary filter is not ordinary reading progress');
    assert.equal(restored.$('summary-body').textContent, 'Answer 25');
    assert.equal(restored.w.libraryProbe.documents[0].ai_answers.length, 245);
    assert.equal(restored.w.libraryProbe.documents[0].readingPosition, undefined);
    restored.$('mode-summary').click();
    assert.equal(mode(restored), 'summary');
    assert.equal(restored.$('summary-workspace').hidden, false);
    assert.equal(restored.$('browse-ai-history').hidden, false);
    restored.$('browse-ai-history').click();
    assert.equal(restored.$('ai-answers').children.length, 10);
    assert.equal(restored.$('ai-answers').firstElementChild.dataset.answerNumber, '245');
    assert.equal(restored.w.document.activeElement, restored.$('ai-history-heading'));
    assert.match(restored.$('ai-history-storage').textContent, /245 则均已保存/);
    assert.equal(restored.w.localStorage.getItem(CONTENT), before);
    assert.equal(restored.pipeline.prepares, 0, 'mode restoration never rewrites saved content');
  } finally {await first.w.happyDOM.close(); await restored?.w.happyDOM.close();}
});

test('a restored long transcript enters continuous reading explicitly before the correction settings close journey', async () => {
  const doc = {key: 'source', title: 'Authored settings reload', language: 'en', notes: {}, readingPosition: 'cue-0',
    segments: Array.from({length: 240}, (_, i) => ({id: 'cue-' + i, start: i * 3, end: i * 3 + 2, text: 'Authored CUE ' + i}))};
  const first = libraryHarness([doc], {probe: true}); let restored;
  try {
    assert.equal(mode(first), 'passages', 'first entry retains the long-document default');
    first.$('mode-transcript').click(); first.$('next-page').click();
    first.$('search').focus(); input(first, 'search', 'Authored CUE 200');
    restored = reload(first);
    assert.equal(mode(restored), 'transcript');
    assert.equal(restored.$('transcript').firstElementChild.dataset.segmentId, 'cue-100');
    assert.equal(restored.$('reading-settings').parentElement, restored.$('reader-options'));
    assert.equal(restored.$('reading-info').hidden, true);
    assert.equal(restored.w.libraryProbe.documents[0].readingPosition, 'cue-0');
    restored.$('mode-passages').click();
    assert.equal(mode(restored), 'passages');
    assert.equal(restored.$('reading-settings').parentElement, restored.$('reading-info-settings'));
    assert.equal(restored.$('reading-info').hidden, false);
    restored.$('reading-info').open = true; restored.$('open-source-correction').click();
    input(restored, 'source-find', 'CUE'); input(restored, 'source-replace', 'cue');
    restored.$('preview-source-correction').click(); restored.$('apply-source-correction').click();
    assert.equal((await restored.w.flushContentForTest()).ok, true);
    restored.$('close-source-correction').click();
    assert.equal(restored.$('source-correction-dialog').open, false);
    assert.equal(restored.$('reading-info').open, true);
    assert.equal(restored.w.document.activeElement, restored.$('open-source-correction'));
    restored.$('close-reading-info').click();
    assert.equal(restored.$('reading-info').open, false);
    assert.equal(restored.w.document.activeElement, restored.$('reading-info').querySelector('summary'));
    restored.$('mode-transcript').click();
    assert.equal(mode(restored), 'transcript');
    assert.equal(restored.$('mode-transcript').getAttribute('aria-pressed'), 'true');
    const saved = JSON.parse(restored.w.localStorage.getItem(CONTENT)).documents[0];
    assert.equal(saved.segments[239].text, 'Authored cue 239');
    assert.equal(saved.readingPosition, 'cue-0', 'ordinary progress and correction leave the manual bookmark intact');
  } finally {await first.w.happyDOM.close(); await restored?.w.happyDOM.close();}
});
