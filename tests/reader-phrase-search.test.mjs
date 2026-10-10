import {installSavePipeline, settle} from './helpers/save-pipeline.mjs';
/** Exercise the actual reader handlers in HappyDOM. Every fetch is denied unless
 * an individual test injects a local authored response; no real network/model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {phraseSearchFixture, phraseContributorIds, SOURCE_PHRASE, TRANSLATED_PHRASE} from './helpers/phrase-search-fixture.mjs';

const root = new URL('../', import.meta.url), KEY = 'coconut-reader-v1';
function setup(saved) {
  const w = new Window({url: 'http://127.0.0.1:8080/'});
  w.document.body.innerHTML = fs.readFileSync(new URL('reader/index.html', root), 'utf8').split('<body>')[1].split('</body>')[0];
  Object.defineProperty(w, 'crypto', {value: webcrypto});
  if (saved) {w.localStorage.setItem(KEY, saved);w.sessionStorage.setItem('coconut-reader-active-v1', JSON.parse(saved).documents[0].key);}
  const calls = [];
  w.fetch = async (...args) => {calls.push(args);throw new Error('Unexpected network request');};
  w.HTMLElement.prototype.scrollIntoView = function(options) {w.lastScrolled = {id: this.dataset.segmentId, options};};
  w.eval(['summary', 'core', 'passages', 'passage-playback'].map(name => fs.readFileSync(new URL('reader/' + name + '.js', root), 'utf8')).join('\n'));
  const pipeline=installSavePipeline(w);
  w.eval(['app', 'language', 'translation-review', 'podcasts'].map(name => fs.readFileSync(new URL('reader/' + name + '.js', root), 'utf8')).join('\n'));
  const $ = id => w.document.getElementById(id);
  const close = async () => {w.dispatchEvent(new w.Event('pagehide'));await w.happyDOM.close();};
  return {w, $, calls, close, pipeline};
}
async function choose(env, id, value) {
  const text = JSON.stringify(value);
  Object.defineProperty(env.$(id), 'files', {configurable: true, value: [{name: id + '.json', size: Buffer.byteLength(text), text: async () => text}]});
  await env.$(id).onchange();
}
async function load(env, doc = phraseSearchFixture()) {await choose(env, 'file', doc);env.$('mode-bilingual').click();return doc;}
const rows = env => [...env.$('transcript').querySelectorAll('.segment')];
const ids = env => rows(env).map(row => row.dataset.segmentId);
const row = (env, id) => rows(env).find(row => row.dataset.segmentId === id);
const search = (env, query) => {env.$('search').value = query;env.$('search').oninput();};
const saved = async env => {await env.w.flushContentForTest();return JSON.parse(env.w.localStorage.getItem(KEY)).documents.find(doc => doc.key === env.w.sessionStorage.getItem('coconut-reader-active-v1'));};
const marks = (node, selector) => [...node.querySelectorAll(selector + ' mark')].map(mark => mark.textContent);
const task = (env, value) => {env.$('ai-task').value = value;env.$('ai-task').onchange();};
function injectAI(env) {
  const requests = [];
  env.w.fetch = async (url, options) => {
    if (url.endsWith('language-tools')) return {ok: true, json: async () => ({ai: {codex: {ready: true}}})};
    const body = JSON.parse(options.body);requests.push({url, body});
    if (url.endsWith('translate-subscription')) return {ok: true, json: async () => ({translations: body.segments.map(cue => ({id: cue.id, source_text: cue.text, text: 'Authored injected translation.'}))})};
    assert.ok(url.endsWith('ask'));
    return {ok: true, json: async () => ({answer: 'Authored injected answer.', citations: [body.segments[0].id], provider: 'fixture'})};
  };
  return requests;
}

test('English phrase highlights each real contributing cue, counts cues and adds a source-backed joined preview', async () => {
  const env = setup();try {
    const fixture = await load(env), before = (await saved(env));search(env, SOURCE_PHRASE);
    assert.deepEqual(ids(env), phraseContributorIds());
    assert.match(env.$('search-status').textContent, /找到 8 个片段/);
    assert.equal(env.$('match-position').textContent, '0 / 8 个匹配片段');
    assert.deepEqual(marks(row(env, 'split-1'), '.words'), ['left out']);
    assert.deepEqual(marks(row(env, 'split-2'), '.words'), ['the time']);
    const preview = row(env, 'split-1').querySelector('.phrase-match');
    assert.equal(preview.dataset.field, 'text');assert.deepEqual(JSON.parse(preview.dataset.cueIds), ['split-1', 'split-2']);
    assert.equal(preview.querySelector('mark').textContent, SOURCE_PHRASE);
    assert.match(preview.textContent, /原文.*跨 2 个片段/);assert.equal(env.$('transcript').querySelectorAll('.phrase-match').length, 8);
    for (const node of rows(env)) assert.equal(node.querySelector('.words').textContent, fixture.segments.find(cue => cue.id === node.dataset.segmentId).text);
    env.$('next-match').click();assert.equal(env.w.document.activeElement.dataset.segmentId, 'split-1');
    env.$('next-match').click();assert.equal(env.w.document.activeElement.dataset.segmentId, 'split-2');
    assert.equal(env.$('match-position').textContent, '2 / 8 个匹配片段');
    assert.deepEqual((await saved(env)), before);assert.equal(env.calls.length, 0);
  } finally {await env.close();}
});

test('Chinese phrase joins without spaces and all valid saved languages remain searchable in source-only view', async () => {
  const env = setup();try {
    const doc = phraseSearchFixture();
    for (const cue of doc.segments) cue.translations.ja = {...cue.translations.zh, text: '非表示語'};
    await load(env, doc);search(env, TRANSLATED_PHRASE);
    assert.deepEqual(ids(env), phraseContributorIds());
    assert.deepEqual(marks(row(env, 'split-1'), '.translation'), ['但我们忽略了']);
    assert.deepEqual(marks(row(env, 'split-2'), '.translation'), ['人们所需的时间']);
    const preview = row(env, 'split-1').querySelector('.phrase-match');
    assert.equal(preview.dataset.field, 'translation');assert.equal(preview.dataset.language, 'zh');
    assert.equal(preview.querySelector('mark').textContent, TRANSLATED_PHRASE);
    assert.equal(env.$('transcript').querySelectorAll('.words mark').length, 0);
    search(env, '非表示語');assert.equal(ids(env).length, 24);
    assert.equal(row(env, 'split-1').querySelector('.phrase-match').dataset.language, 'ja');
    assert.match(row(env, 'split-1').querySelector('.phrase-match').textContent, /日文译文/);
    env.$('translation-view').value = '';env.$('translation-view').onchange();
    assert.equal(ids(env).length, 24);assert.equal(env.$('transcript').querySelectorAll('.translation').length, 0);
    row(env, 'split-1').querySelector('.phrase-show-translation').click();
    assert.equal(env.$('translation-view').value, 'ja');assert.equal((await saved(env)).translation_view, 'ja');
    assert.equal(env.w.document.activeElement.dataset.segmentId, 'split-1');
    assert.deepEqual(marks(row(env, 'split-1'), '.translation'), ['非表示語']);
    search(env, TRANSLATED_PHRASE);assert.deepEqual(ids(env), phraseContributorIds());
    assert.match(row(env, 'split-1').querySelector('.phrase-match').textContent, /中文译文.*跨 2 个片段/);
    env.$('translation-view').value = '';env.$('translation-view').onchange();
    assert.deepEqual(ids(env), phraseContributorIds());assert.equal(env.$('transcript').querySelectorAll('.translation').length, 0);
    assert.equal(row(env, 'split-1').querySelector('.phrase-match mark').textContent, TRANSLATED_PHRASE);
    search(env, SOURCE_PHRASE);assert.deepEqual(ids(env), phraseContributorIds());assert.equal(env.calls.length, 0);
  } finally {await env.close();}
});

test('source, speaker and notes never manufacture a phrase across fields, and previews render literal text safely', async () => {
  const env = setup();try {
    const doc = phraseSearchFixture(6);doc.segments[0].text = 'left out';doc.segments[0].speaker = 'the time';doc.notes['split-0'] = 'the time';
    doc.segments[1].text = '<img src=x onerror=alert(1)>';doc.segments[2].text = 'literal payload';
    await load(env, doc);search(env, SOURCE_PHRASE);assert.deepEqual(ids(env), []);
    search(env, '<img src=x onerror=alert(1)> literal');assert.deepEqual(ids(env), ['split-1', 'split-2']);
    assert.equal(env.$('transcript').querySelector('img,script'), null);
    assert.equal(row(env, 'split-1').querySelector('.phrase-match mark').textContent, '<img src=x onerror=alert(1)> literal');
    assert.equal(env.calls.length, 0);
  } finally {await env.close();}
});

test('note, excerpt and speaker filters intersect contributing IDs while note membership stays live', async () => {
  const env = setup();try {
    const doc = phraseSearchFixture();doc.notes['split-1'] = 'A note';doc.notes['split-4'] = SOURCE_PHRASE;
    doc.segments[2].saved_excerpt = true;doc.segments[8].saved_excerpt = true;
    await load(env, doc);search(env, SOURCE_PHRASE);
    assert.deepEqual(ids(env), ['split-1', 'split-2', 'split-4', ...phraseContributorIds().slice(2)]);
    env.$('filter-notes').click();assert.deepEqual(ids(env), ['split-1', 'split-4']);
    row(env, 'split-4').querySelector('.note-button').click();env.$('note').value = 'Removed the match';env.$('note').oninput();
    assert.deepEqual(ids(env), ['split-1']);assert.equal(env.$('notes-panel').hidden, false);
    env.$('filter-excerpts').click();assert.deepEqual(ids(env), ['split-2', 'split-8']);
    row(env, 'split-2').querySelector('.excerpt-button').click();assert.deepEqual(ids(env), ['split-8']);
    env.$('filter-all').click();env.$('speaker-filter').value = '"Mina"';env.$('speaker-filter').onchange();
    assert.deepEqual(ids(env), ['split-1', 'split-2', 'split-13', 'split-14']);
    assert.equal((await saved(env)).notes['split-4'], 'Removed the match');assert.equal((await saved(env)).segments[2].saved_excerpt, undefined);
    assert.equal(env.calls.length, 0);
  } finally {await env.close();}
});

test('cross-page result navigation and context detours retain cue IDs, exact highlights and the prior search', async () => {
  const env = setup();try {
    const doc = phraseSearchFixture(1771);doc.segments[0].text = SOURCE_PHRASE + '.';
    await load(env, doc);const before = (await saved(env));search(env, SOURCE_PHRASE);
    const all = ['split-0', ...phraseContributorIds(1771)];assert.equal(all.length, 591);
    assert.deepEqual(ids(env), all.slice(0, 100));assert.equal(ids(env).at(-1), 'split-295');
    env.$('next-page').click();assert.deepEqual(ids(env), all.slice(100, 200));assert.equal(ids(env)[0], 'split-296');
    assert.deepEqual(marks(row(env, 'split-296'), '.words'), ['the time']);
    assert.equal(row(env, 'split-296').querySelector('.phrase-match mark').textContent, SOURCE_PHRASE);
    assert.deepEqual(JSON.parse(row(env, 'split-296').querySelector('.phrase-match').dataset.cueIds), ['split-295', 'split-296']);
    row(env, 'split-296').querySelector('.context-button').click();
    assert.ok(row(env, 'split-295'));assert.ok(row(env, 'split-297'));assert.ok(rows(env).length <= 100);
    assert.equal(env.w.document.activeElement.dataset.segmentId, 'split-296');assert.equal(env.$('search').value, '');
    env.$('return-reading-results').click();assert.deepEqual(ids(env), all.slice(100, 200));
    assert.equal(env.$('search').value, SOURCE_PHRASE);assert.equal(env.w.document.activeElement.closest('.segment').dataset.segmentId, 'split-296');
    assert.equal(env.$('match-position').textContent, '101 / 591 个匹配片段');
    env.$('previous-match').click();assert.equal(env.w.document.activeElement.dataset.segmentId, 'split-295');
    env.$('next-match').click();assert.equal(env.w.document.activeElement.dataset.segmentId, 'split-296');
    assert.deepEqual((await saved(env)), before);assert.equal(env.calls.length, 0);
  } finally {await env.close();}
});

test('source correction invalidates both halves of a phrase and excludes its now-stale translation', async () => {
  const env = setup();try {
    await load(env, phraseSearchFixture(6));search(env, SOURCE_PHRASE);
    row(env, 'split-1').querySelector('.context-button').click();row(env, 'split-1').querySelector('.edit-button').click();
    env.$('edit-segment').value = 'but we included';env.$('save-edit').click();env.$('return-reading-results').click();
    assert.deepEqual(ids(env), []);search(env, TRANSLATED_PHRASE);assert.deepEqual(ids(env), []);
    search(env, 'included the time');assert.deepEqual(ids(env), ['split-1', 'split-2']);
    assert.ok(row(env, 'split-1').querySelector('.translation.stale'));
    assert.doesNotMatch(row(env, 'split-1').querySelector('.translation').textContent, /但我们忽略了/);
    assert.equal((await saved(env)).segments[1].translations.zh.text, '但我们忽略了');assert.equal(env.calls.length, 0);
  } finally {await env.close();}
});

test('manual translation correction refreshes the cached Chinese phrase without changing original text', async () => {
  const env = setup();try {
    await load(env, phraseSearchFixture(6));search(env, TRANSLATED_PHRASE);
    row(env, 'split-1').querySelector('.review-translation-button').click();
    env.$('translation-edit-text').value = '我们考虑了';env.$('translation-edit-text').oninput();env.$('save-translation-edit').click();
    search(env, TRANSLATED_PHRASE);assert.deepEqual(ids(env), []);
    search(env, '我们考虑了人们所需的时间');assert.deepEqual(ids(env), ['split-1', 'split-2']);
    assert.equal(row(env, 'split-1').querySelector('.phrase-match mark').textContent, '我们考虑了人们所需的时间');
    assert.equal((await saved(env)).segments[1].text, 'but we had left out');assert.equal(env.calls.length, 0);
  } finally {await env.close();}
});

test('import, same-ID document switch and backup restore never reuse another document search index', async () => {
  const env = setup();let shelf;try {
    await load(env, phraseSearchFixture(6));search(env, SOURCE_PHRASE);assert.deepEqual(ids(env), ['split-1', 'split-2']);
    const old = (await saved(env)), replacement = phraseSearchFixture(6);replacement.title = 'Different document, same cue IDs';replacement.segments[1].text = 'but we included';
    await load(env, replacement);search(env, SOURCE_PHRASE);assert.deepEqual(ids(env), []);
    await choose(env, 'library-file', {format: 'coconut-library', version: 1, documents: [old], active: old.key});
    env.$('mode-bilingual').click();search(env, SOURCE_PHRASE);assert.deepEqual(ids(env), ['split-1', 'split-2']);
    assert.equal((await saved(env)).title, old.title);shelf = JSON.stringify({documents: [(await saved(env))]});assert.equal(env.calls.length, 0);
  } finally {await env.close();}
  const reopened = setup(shelf);try {
    reopened.$('mode-bilingual').click();search(reopened, TRANSLATED_PHRASE);assert.deepEqual(ids(reopened), ['split-1', 'split-2']);
    assert.equal(reopened.calls.length, 0);
  } finally {await reopened.close();}
});

test('library original-plus-note scope finds cross-cue source previews but does not search translations', async () => {
  const env = setup();try {
    await load(env, phraseSearchFixture(6));env.$('library-scope').value = 'text';
    env.$('library-search').value = TRANSLATED_PHRASE;env.$('library-search').oninput();assert.equal(env.$('library').children.length, 0);
    env.$('library-search').value = SOURCE_PHRASE;env.$('library-search').oninput();
    assert.equal(env.$('library').querySelectorAll('.library-hit').length, 1);assert.equal(env.$('library').querySelector('.library-hit mark').textContent, SOURCE_PHRASE);
    env.$('library').querySelector('.library-hit').click();assert.equal(env.w.document.activeElement.dataset.segmentId, 'split-1');
    assert.ok(row(env, 'split-2'));assert.equal(env.$('library-search').value, SOURCE_PHRASE);
    env.$('library-scope').value = 'notes';env.$('library-scope').onchange();assert.equal(env.$('library').children.length, 0);
    assert.equal(env.calls.length, 0);
  } finally {await env.close();}
});

for (const query of [SOURCE_PHRASE, TRANSLATED_PHRASE]) test('filtered AI question sends only original contributing cues for ' + query, async () => {
  const env = setup();try {
    await load(env, phraseSearchFixture(6));search(env, query);const requests = injectAI(env);await env.$('check-ai').onclick();task(env, 'question');
    env.$('ai-filtered').checked = true;env.$('ai-filtered').onchange();env.$('ai-question').value = 'Explain this phrase.';env.$('ai-question').oninput();
    assert.equal(env.$('question-scope').dataset.segmentCount, '2');assert.equal(requests.length, 0);
    await env.$('ask-ai').onclick();assert.equal(requests.length, 0, 'unconfirmed handler remains inert');
    env.$('ai-consent').checked = true;await env.$('ask-ai').onclick();assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body.segments, [{id: 'split-1', text: 'but we had left out'}, {id: 'split-2', text: 'the time people needed'}]);
    assert.ok(!JSON.stringify(requests).includes('车站'));assert.equal(env.calls.length, 0);
  } finally {await env.close();}
});

test('approved phrase-filtered translation keeps targets and context strictly inside matched cues', async () => {
  const env = setup();try {
    await load(env, phraseSearchFixture(12));search(env, SOURCE_PHRASE);const requests = injectAI(env);await env.$('check-ai').onclick();task(env, 'translation');
    assert.equal(env.$('subscription-translation-scope').dataset.segmentCount, '4');
    env.$('ai-consent').checked = true;await env.$('subscription-translate').onclick();assert.ok(requests.length > 0);
    const allowed = new Set(phraseContributorIds(12));
    assert.deepEqual([...new Set(requests.flatMap(({body}) => body.segments.map(cue => cue.id)))], [...allowed]);
    for (const {body} of requests) for (const cue of [...body.segments, ...body.context, ...(body.memory || [])]) assert.ok(allowed.has(cue.id), cue.id);
    assert.equal(env.calls.length, 0);
  } finally {await env.close();}
});

test('continuous phrases cross the sixteen-cue reading paragraph cap in both original and Chinese', async () => {
  const env = setup();try {
    const doc = phraseSearchFixture(40);
    for (const cue of doc.segments) {cue.speaker = 'Author';cue.text = 'Authored filler';cue.translations.zh = {...cue.translations.zh, text: '作者填充文字', source_text: cue.text};}
    for (const [i, source, translation] of [[15, 'left out', '但我们忽略了'], [16, 'the time', '人们所需的时间']]) {
      doc.segments[i].text = source;doc.segments[i].translations.zh.text = translation;doc.segments[i].translations.zh.source_text = source;
    }
    assert.equal(env.w.CoconutPassages.build(doc.segments)[0].cues.at(-1).id, 'split-15');
    await load(env, doc);
    for (const query of [SOURCE_PHRASE, TRANSLATED_PHRASE]) {
      search(env, query);assert.deepEqual(ids(env), ['split-15', 'split-16']);
      for (const node of rows(env)) {
        assert.equal(node.querySelector('.phrase-match mark').textContent, query);
        assert.deepEqual(JSON.parse(node.querySelector('.phrase-match').dataset.cueIds), ['split-15', 'split-16']);
      }
    }
    assert.equal(env.calls.length, 0);
  } finally {await env.close();}
});

test('source-context correction and saved glossary changes invalidate translated cross-cue evidence immediately', async () => {
  for (const change of ['context', 'glossary']) {
    const env = setup();try {
      const doc = phraseSearchFixture(6), contextId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      doc.translation_contexts = {[contextId]: doc.segments.slice(0, 3).map((cue, position) => ({id: cue.id, position, text: cue.text, start: cue.start, end: cue.end, speaker: cue.speaker}))};
      for (const i of [1, 2]) Object.assign(doc.segments[i].translations.zh, {context_id: contextId, context_version: 2, target_language: 'zh', glossary_snapshot: []});
      await load(env, doc);search(env, TRANSLATED_PHRASE);assert.deepEqual(ids(env), ['split-1', 'split-2']);
      let pending;
      if (change === 'context') {
        row(env, 'split-1').querySelector('.context-button').click();row(env, 'split-0').querySelector('.edit-button').click();
        env.$('edit-segment').value = 'Changed contextual evidence.';env.$('save-edit').click();env.$('return-reading-results').click();
      } else {
        env.$('translation-glossary').value = 'time = 时长';env.$('translation-glossary').oninput();pending=env.$('save-translation-glossary').onclick();
      }
      assert.deepEqual(ids(env), [], change);search(env, SOURCE_PHRASE);assert.deepEqual(ids(env), ['split-1', 'split-2']);
      assert.equal(env.$('transcript').querySelectorAll('.translation.stale').length, 2);assert.equal(env.calls.length, 0);await pending;
    } finally {await env.close();}
  }
});

test('a context detour cannot restart a pending phrase-selected translation plan after rechecking consent', async () => {
  const env = setup();let release, pending;try {
    await load(env, phraseSearchFixture(24));search(env, SOURCE_PHRASE);const requests = [];
    env.w.fetch = async (url, options) => {
      if (url.endsWith('language-tools')) return {ok: true, json: async () => ({ai: {codex: {ready: true}}})};
      const body = JSON.parse(options.body);requests.push(body);await new Promise(resolve => {release = resolve;});
      return {ok: true, json: async () => ({translations: body.segments.map(cue => ({id: cue.id, source_text: cue.text, text: 'Injected translation.'}))})};
    };
    task(env, 'translation');await env.$('check-ai').onclick();env.$('ai-consent').checked = true;pending = env.$('subscription-translate').onclick();
    assert.equal(requests.length, 1);row(env, 'split-1').querySelector('.context-button').click();env.$('return-reading-results').click();
    env.$('ai-consent').checked = true;release();await pending;assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].segments.map(cue => cue.id), ['split-1', 'split-2']);assert.equal(env.calls.length, 0);
  } finally {release?.();await pending;await env.close();}
});

test('all-language phrase results deduplicate source cues and never join different language fields', async () => {
  const env = setup();try {
    const doc = phraseSearchFixture(6);doc.translation_view = '';
    for (const cue of doc.segments) {cue.text = 'Neutral authored source';cue.translations = {};}
    const item = (cue, text) => ({text, source_text: cue.text, source_language: 'en', document_language: 'en', provider: 'Authored fixture'});
    doc.segments[1].translations.zh = item(doc.segments[1], 'shared');doc.segments[2].translations.zh = item(doc.segments[2], 'phrase');
    doc.segments[1].translations.ja = item(doc.segments[1], 'shared');doc.segments[2].translations.ja = item(doc.segments[2], 'phrase');
    doc.segments[1].translations.fr = item(doc.segments[1], 'shared phrase');
    doc.segments[3].translations.zh = item(doc.segments[3], 'cross-language');doc.segments[4].translations.ja = item(doc.segments[4], 'fabrication');
    doc.segments[5].translations.ja = {...item(doc.segments[5], 'stale-only-phrase'), source_text: 'Old source'};
    await load(env, doc);env.$('mode-transcript').click();search(env, 'shared phrase');
    assert.deepEqual(ids(env), ['split-1', 'split-2']);assert.match(env.$('search-status').textContent, /找到 2 个片段/);
    assert.deepEqual([...row(env, 'split-1').querySelectorAll('.phrase-match')].map(node => node.dataset.language), ['zh', 'ja', 'fr']);
    assert.equal(env.$('transcript').querySelectorAll('.translation').length, 0);
    search(env, 'cross-language fabrication');assert.deepEqual(ids(env), []);
    search(env, 'stale-only-phrase');assert.deepEqual(ids(env), []);assert.equal(env.calls.length, 0);
  } finally {await env.close();}
});

test('long overlapping phrases keep full cue membership while visible results and DOM metadata remain bounded', async () => {
  const env = setup();try {
    const doc = phraseSearchFixture(240), query = Array(121).fill('a').join(' ');
    for (const cue of doc.segments) {cue.text = 'a';cue.speaker = 'Author';cue.translations = {};}
    await load(env, doc);const before = (await saved(env));search(env, query);
    const allIds = doc.segments.map(cue => cue.id);
    assert.deepEqual(ids(env), allIds.slice(0, 100));
    assert.equal(env.$('match-position').textContent, '0 / 240 个匹配片段');
    assert.match(env.$('search-status').textContent, /找到 240 个片段/);
    const checkPage = () => {
      for (const node of rows(env)) {
        assert.equal(node.querySelector('.words').textContent, 'a');assert.deepEqual(marks(node, '.words'), ['a']);
        const preview = node.querySelector('.phrase-match');
        assert.equal(preview.dataset.cueCount, '121');assert.equal(preview.hasAttribute('data-cue-ids'), false);
        const first = Number(preview.dataset.firstCueId.slice(6)), last = Number(preview.dataset.lastCueId.slice(6));
        assert.equal(last - first + 1, 121);assert.ok(first <= Number(node.dataset.segmentId.slice(6)) && last >= Number(node.dataset.segmentId.slice(6)));
        assert.ok(JSON.stringify({...preview.dataset}).length < 200, 'metadata contains endpoints and count, not 121 repeated IDs');
        assert.ok(preview.textContent.length < 350);assert.ok(preview.outerHTML.length < 650);
        assert.match(preview.textContent, /跨 121 个片段/);
      }
    };
    checkPage();env.$('next-page').click();assert.deepEqual(ids(env), allIds.slice(100, 200));checkPage();
    env.$('next-page').click();assert.deepEqual(ids(env), allIds.slice(200));checkPage();
    const result = env.w.Coconut.searchDocument(before, query);
    assert.equal(result.byCue.size, 240);assert.deepEqual(Array.from(result.byCue.keys()), allIds);
    assert.deepEqual(Array.from(result.previews.get('text:split-0').ids), allIds.slice(0, 121));
    assert.deepEqual(Array.from(result.byCue.get('split-239').phrases.text.ids), allIds.slice(119));
    assert.equal(result.byCue.get('split-239').phrases.text.ids.length, 121);
    assert.deepEqual((await saved(env)), before);assert.equal(env.calls.length, 0);
  } finally {await env.close();}
});

 test('translation reveal obeys the native ingress barrier, queues an accepted view, and ignores a retired view owner',async()=>{
 const env=setup();try{
  await load(env,phraseSearchFixture(6));env.$('mode-transcript').click();await saved(env);search(env,TRANSLATED_PHRASE);
  const reveal=row(env,'split-1').querySelector('.phrase-show-translation'),before=env.pipeline.store.status().generation,disk=env.w.localStorage.getItem(KEY);
  const token=env.pipeline.store.acquireBarrier();assert.ok(token);reveal.onclick();
  assert.equal(env.pipeline.store.status().generation,before);assert.equal(env.$('translation-view').value,'');assert.equal(env.w.localStorage.getItem(KEY),disk);
  assert.equal(env.$('transcript').querySelectorAll('.translation').length,0);assert.equal(env.pipeline.store.releaseBarrier(token),true);
  reveal.onclick();assert.equal(env.$('translation-view').value,'zh');assert.equal(env.w.document.activeElement.dataset.segmentId,'split-1');
  assert.ok(env.pipeline.store.status().generation>before);assert.equal((await saved(env)).translation_view,'zh');
  const next=phraseSearchFixture(6);next.title='Different active view owner';await load(env,next);const nextGeneration=env.pipeline.store.status().generation;
  reveal.onclick();assert.equal(env.pipeline.store.status().generation,nextGeneration);assert.equal(env.$('title').textContent,next.title);assert.equal(env.calls.length,0);
 }finally{await env.close();}
});
