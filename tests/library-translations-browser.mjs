/** Actions-only real Chromium acceptance of current, all-language shelf search.
 * Authored English sources, translations and PCM tones only. Native file input,
 * real IndexedDB and actual keyboard navigation provide the acceptance evidence.
 * No provider, model, user media, external network or browser-storage injection.
 * node --check is syntax evidence only; it does not run this browser journey. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import C from '../reader/core.js';
import {chromium, expect, waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
import {openLibraryTools} from './helpers/library-tools-browser.mjs';

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Run library translation browser acceptance in GitHub Actions only; use node --check locally.');

const languages = {en: '英文', zh: '中文', ja: '日文', ko: '韩文', fr: '法文', de: '德文', es: '西班牙文'};
const query = 'waymark', positions = [108, 112, 116, 120, 124];
const checks = [], errors = [], geometry = [], pagination = [], screenshots = [];
let server, browser, page, stage = 'setup', external = 0, mutations = 0;
function check(name, value) {assert.ok(value, name); checks.push(name);}
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
const entry = (page, key) => page.locator('.library-entry[data-document-key="' + key + '"]');
const group = (page, key, language) => entry(page, key).locator('.library-translation-group[data-language="' + language + '"]');
const hit = (page, key, language) => group(page, key, language).locator('.library-translation-hit');

function authoredFixtures(label) {
  const original = {
    title: 'Authored multilingual walking notes ' + label, language: 'en', translation_view: '', readingPosition: 'cue-139',
    notes: {}, segments: Array.from({length: 140}, (_, i) => ({id: 'cue-' + i, start: i * 2, end: i * 2 + 1.8,
      text: 'Authored main source sentence ' + i + '.', speaker: 'Author', translations: {}})),
  };
  const translation = (cue, text, fields = {}) => ({text, source_text: cue.text, source_language: 'en', document_language: 'en', provider: 'Authored fixture', ...fields});
  const prose = {en: 'waymark beside the garden', zh: 'waymark 花园旁的路标', ja: 'waymark 庭のそばの目印',
    ko: 'waymark 정원 옆 이정표', fr: 'waymark près du jardin', de: 'waymark neben dem Garten', es: 'waymark junto al jardín'};
  for (const [language, text] of Object.entries(prose)) original.segments[108].translations[language] = translation(original.segments[108], text);
  for (const i of positions.slice(1)) original.segments[i].translations.zh = translation(original.segments[i], 'waymark 第 ' + i + ' 处路标' + (i === 116 ? ' <img src=x>' : ''));
  original.segments[110].translations.en = translation(original.segments[110], 'We approached the riverside');
  original.segments[111].translations.en = translation(original.segments[111], 'crossing together.');
  original.segments[126].translations.fr = translation(original.segments[126], 'Nous observons le jardin et les chemins. '.repeat(180) + 'longbeacon au bout du passage.');
  original.segments[130].translations.zh = translation(original.segments[130], 'expiredsource 旧原文译文', {source_text: 'Earlier source before correction.'});
  const contextId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const snapshot = i => ({id: original.segments[i].id, position: i, text: original.segments[i].text, start: original.segments[i].start, end: original.segments[i].end, speaker: 'Author'});
  original.translation_contexts = {[contextId]: [{...snapshot(130), text: 'Earlier neighboring context.'}, snapshot(131)]};
  original.segments[131].translations.ja = translation(original.segments[131], 'expiredcontext 古い文脈', {context_id: contextId});
  original.segments[132].translations.de = translation(original.segments[132], 'incompletelegacy alter Entwurf', {provider: 'authored_subscription_translation'});
  original.segments[133].translations.ko = translation(original.segments[133], 'expiredlanguage 이전 언어', {document_language: 'fr'});
  // A real immutable bilingual record positively controls historical search,
  // while its old translation must never leak into current-translation scope.
  original.segments[5].translations.fr = translation(original.segments[5], 'historicbeacon ancienne traduction');
  const main = C.validate(original), cue = main.segments[5], model = C.translationSelectionModels(main, [cue], 'fr')[0];
  main.exact_excerpts = [C.pairedExactExcerptSnapshot(main, [cue], [], 0, cue.text.length, model, 0, model.text.length,
    {id: 'authored-history', createdAt: '2026-10-11T00:00:00.000Z', confirmedAt: '2026-10-11T00:00:00.000Z'})];
  cue.translations.fr = translation(cue, 'Une nouvelle traduction actuelle.');
  const companion = {
    title: 'Authored companion document ' + label, language: 'en', translation_view: 'fr', readingPosition: 'cue-111',
    segments: Array.from({length: 5}, (_, i) => ({id: 'cue-' + (108 + i), start: i * 2, end: i * 2 + 1.8, text: 'Different companion source sentence ' + i + '.', translations: {}})), notes: {},
  };
  companion.segments[0].translations.fr = translation(companion.segments[0], 'waymark propre au document compagnon');
  const decoy = {title: 'waymark title and source only ' + label, language: 'en', readingPosition: 'source-only',
    segments: [{id: 'source-only', start: 0, end: 2, text: 'waymark in the original only.'}], notes: {'source-only': 'waymark in a personal note only.'}};
  return {main, companion, decoy};
}

async function capture(page, name) {
  if (!process.env.COCONUT_UI_SCREENSHOTS) return;
  await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS, {recursive: true});
  const filename = 'library-translations-' + name + '.png';
  await page.screenshot({path: path.join(process.env.COCONUT_UI_SCREENSHOTS, filename), animations: 'disabled', fullPage: false}); screenshots.push(filename);
}
async function openShelf(page, options = false) {
  if (!await page.locator('#library-search').isVisible()) await page.locator('#toggle-library').click();
  if (options) {
    await openLibraryTools(page);
    if (!await page.locator('#library-scope').isVisible()) await page.locator('#library-options > summary').click();
  }
  await expect(page.locator('#library-search')).toBeVisible();
}
async function search(page, text, scope, keys) {
  await openShelf(page, true);
  await page.locator('#library-scope').selectOption(scope);
  await page.locator('#library-search').fill(text);
  // A previous result being visible is not completion of the new search.
  await page.waitForFunction(({text, scope, keys}) => {
    const host = document.getElementById('library');
    const actual = [...host.querySelectorAll('.library-entry')].map(node => node.dataset.documentKey).sort();
    return document.getElementById('library-search').value === text && document.getElementById('library-scope').value === scope &&
      !host.hidden && host.getAttribute('aria-busy') === 'false' && JSON.stringify(actual) === JSON.stringify(keys.slice().sort());
  }, {text, scope, keys});
}
async function importDocument(page, doc) {
  await page.locator('#file').setInputFiles({name: 'authored-translations.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc))});
  await expect(page.locator('#title')).toHaveText(doc.title);
  await waitForPersistedLibrary(page, async title => (await readPersistedLibrary()).documents.some(doc => doc.title === title), doc.title);
  return page.evaluate(async title => (await readPersistedLibrary()).documents.find(doc => doc.title === title).key, doc.title);
}
async function positionsSnapshot(page) {
  return page.evaluate(async () => {
    const positions = docs => docs.map(doc => ({key: doc.key, present: Object.hasOwn(doc, 'readingPosition'), value: doc.readingPosition ?? null})).sort((a,b) => a.key.localeCompare(b.key));
    return {live: positions(state.documents), durable: positions((await readPersistedLibrary()).documents)};
  });
}
async function ownership(page) {
  return page.evaluate(() => ({key: state.active, selected: sessionStorage.getItem('coconut-reader-active-v1'),
    title: document.getElementById('title').textContent, view: active().translation_view,
    focusedCue: document.activeElement?.closest('.segment')?.dataset.segmentId || null}));
}
async function walkTo(page, target, label, key = 'Tab') {
  const route = [];
  for (let i = 0; i < 100 && !await target.evaluate(node => node === document.activeElement); i++) {
    await page.keyboard.press(key); await settle(page);
    route.push(await page.evaluate(() => ({id: document.activeElement?.id, classes: document.activeElement?.className,
      language: document.activeElement?.dataset.language, hitId: document.activeElement?.dataset.hitId})));
  }
  console.log(JSON.stringify({suite: 'library-translations-keyboard-path', label, key, route}));
  check(label + '_reached_by_real_tab_order', await target.evaluate(node => node === document.activeElement));
}
async function keyboardGeometry(page, target, label) {
  await settle(page);
  const measurement = await target.evaluate(node => {
    const r = node.getBoundingClientRect(), style = getComputedStyle(node);
    const ring = (parseFloat(style.outlineWidth) || 0) + Math.max(0, parseFloat(style.outlineOffset) || 0);
    const x = (r.left+r.right)/2, y = (r.top+r.bottom)/2;
    const points = [[x,y],[r.left+1,y],[r.right-1,y],[x,r.top+1],[x,r.bottom-1]].map(([x,y]) => {
      const found = document.elementFromPoint(x,y); return {x,y,clear: found === node || node.contains(found), hit: found?.id || found?.className};
    });
    const clips = [];
    for (let ancestor = node.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      const s = getComputedStyle(ancestor), box = ancestor.getBoundingClientRect();
      const clipX = /auto|scroll|hidden|clip/.test(s.overflowX), clipY = /auto|scroll|hidden|clip/.test(s.overflowY);
      if (clipX || clipY) clips.push({id: ancestor.id, clipX, clipY, left: box.left+ancestor.clientLeft, top: box.top+ancestor.clientTop,
        right: box.left+ancestor.clientLeft+ancestor.clientWidth, bottom: box.top+ancestor.clientTop+ancestor.clientHeight});
    }
    const overlays = ['reading-feedback','notice-shell','passage-playback-controls','media-dock'].flatMap(id => {
      const overlay = document.getElementById(id); if (!overlay) return [];
      const box = overlay.getBoundingClientRect(), s = getComputedStyle(overlay);
      return [{id, rect: box.toJSON(), visible: !overlay.hidden && s.display !== 'none' && s.visibility !== 'hidden' && box.width > 0 && box.height > 0}];
    });
    return {rect: r.toJSON(), ring, outlineStyle: style.outlineStyle, outlineColor: style.outlineColor,
      focused: node === document.activeElement, focusVisible: node.matches(':focus-visible'), width: innerWidth, height: innerHeight,
      points, clips, overlays, notice: document.getElementById('notice').textContent};
  });
  geometry.push({label, ...measurement}); console.log(JSON.stringify({suite: 'library-translations-keyboard-geometry', label, ...measurement}));
  const m = measurement, r = m.rect, ring = m.ring;
  const clear = m.focused && m.focusVisible && m.outlineStyle !== 'none' && m.outlineColor !== 'rgba(0, 0, 0, 0)' && ring > 0 &&
    r.width >= 44 && r.height >= 44 && r.left-ring >= 0 && r.top-ring >= 0 && r.right+ring <= m.width && r.bottom+ring <= m.height &&
    m.points.every(p => p.clear) && m.clips.every(c => (!c.clipX || r.left-ring >= c.left && r.right+ring <= c.right) && (!c.clipY || r.top-ring >= c.top && r.bottom+ring <= c.bottom)) &&
    m.overlays.every(o => !o.visible || o.rect.right <= r.left-ring || o.rect.left >= r.right+ring || o.rect.top >= r.bottom+ring || o.rect.bottom <= r.top-ring);
  if (!clear) await capture(page, label + '-geometry-failure');
  check(label + '_44px_full_focus_ring_five_points_and_overlays_clear', clear);
}
async function paginationLayout(page, region, label) {
  const data = await region.evaluate(node => {
    const controls = node.querySelector('.library-translation-pagination'), status = node.querySelector('.library-translation-status');
    const previous = node.querySelector('.library-translation-previous'), next = node.querySelector('.library-translation-next');
    const range = document.createRange(); range.selectNodeContents(status);
    const clips = [];
    for (let ancestor = status.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), rect = ancestor.getBoundingClientRect();
      const clipX = /auto|scroll|hidden|clip/.test(style.overflowX), clipY = /auto|scroll|hidden|clip/.test(style.overflowY);
      if (clipX || clipY) clips.push({id: ancestor.id, clipX, clipY, left: rect.left+ancestor.clientLeft, top: rect.top+ancestor.clientTop,
        right: rect.left+ancestor.clientLeft+ancestor.clientWidth, bottom: rect.top+ancestor.clientTop+ancestor.clientHeight});
    }
    const textRects = [...range.getClientRects()].map(r => r.toJSON());
    const textClear = textRects.every(r => {const found = document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2); return found === status || status.contains(found);});
    return {controls: controls.getBoundingClientRect().toJSON(), status: status.getBoundingClientRect().toJSON(), clips, textClear,
      textRects, text: status.textContent, accessibleCount: status.getAttribute('aria-label'),
      previous: previous.getBoundingClientRect().toJSON(), next: next.getBoundingClientRect().toJSON(), viewport: {width: innerWidth, height: innerHeight}};
  });
  pagination.push({label, ...data}); console.log(JSON.stringify({suite: 'library-translations-pagination-layout', label, ...data}));
  const {status, controls, previous, next, textRects, viewport, clips, textClear} = data;
  check(label + '_count_has_its_own_full_width_single_line_above_two_44px_controls',
    textRects.length === 1 && textClear && clips.every(c => (!c.clipX || status.left >= c.left && status.right <= c.right) && (!c.clipY || status.top >= c.top && status.bottom <= c.bottom)) && textRects[0].left >= status.left && textRects[0].right <= status.right &&
    status.left === controls.left && status.right === controls.right && status.bottom <= previous.top && status.bottom <= next.top &&
    previous.top === next.top && previous.right <= next.left && previous.width >= 44 && previous.height >= 44 && next.width >= 44 && next.height >= 44 &&
    status.top >= 0 && status.bottom <= viewport.height && status.left >= 0 && status.right <= viewport.width && /第 \d+ \/ 5 个匹配片段/.test(data.accessibleCount));
}
async function visibleBilingualCue(page, key, id, language, source, translation, label, shelfQuery = query) {
  await page.waitForFunction(({key,id,source,translation}) => {
    const row = [...document.querySelectorAll('#transcript .segment')].find(node => node.dataset.segmentId === id);
    if (state.active !== key || document.activeElement !== row) return false;
    const original = row.querySelector('.words'), translated = row.querySelector('.translation:not(.stale)');
    const visible = node => {const r = node?.getBoundingClientRect(); return r && r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;};
    return original?.textContent === source && translated?.textContent === translation && visible(original) && visible(translated);
  }, {key,id,source,translation});
  await waitForPersistedLibrary(page, async ({key,language}) => (await readPersistedLibrary()).documents.find(doc => doc.key === key)?.translation_view === language, {key,language});
  check(label + '_real_original_and_selected_language_are_visible_and_persisted', await page.evaluate(({key,language}) => state.active === key && active().translation_view === language, {key,language}));
  check(label + '_shelf_scope_and_query_survive_navigation', await page.locator('#library-search').inputValue() === shelfQuery && await page.locator('#library-scope').inputValue() === 'translations');
  check(label + '_no_horizontal_overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await capture(page, label + '-bilingual-reader');
}
async function attachPausedTone(page, name) {
  if (!await page.locator('#attach-reader-media').isVisible()) await page.locator('#toggle-reader-media').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#attach-reader-media').click()]);
  await chooser.setFiles({name: 'authored-' + name + '.wav', mimeType: 'audio/wav', buffer: authoredAudioFixture(40)});
  await page.waitForFunction(() => {const player = document.querySelector('#source-media audio'); return player && !player.error && player.readyState >= 2 && player.duration === 40;});
  // Set a nonzero baseline only during fixture setup. From the next line of
  // audit onward every production seek setter and play call is observable.
  await page.locator('#source-media audio').evaluate(async player => {
    player.pause(); await new Promise(resolve => {player.addEventListener('seeked', resolve, {once:true}); player.currentTime = 6;});
    window.__translationPlayer = player; window.__translationAudit = {plays: 0, seeks: []};
    if (!window.__translationAuditInstalled) {
      window.__translationAuditInstalled = true;
      const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime'), play = HTMLMediaElement.prototype.play;
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {...descriptor, set(value) {window.__translationAudit.seeks.push(value); return descriptor.set.call(this,value);}});
      HTMLMediaElement.prototype.play = function(...args) {window.__translationAudit.plays++; return play.apply(this,args);};
    }
  });
  if (await page.locator('#close-reader-media').isVisible()) await page.locator('#close-reader-media').click();
  await waitForPersistedLibrary(page, async () => (await readPersistedLibrary()).documents.find(doc => doc.key === state.active)?.local_media_source?.name === document.getElementById('reader-media-status').textContent.split(' · ')[0]);
}
async function unchangedMedia(page, label, mounted) {
  const audit = await page.evaluate(() => ({...window.__translationAudit, time: window.__translationPlayer.currentTime,
    paused: window.__translationPlayer.paused, mounted: document.querySelector('#source-media audio') === window.__translationPlayer}));
  check(label + '_never_seeks_or_plays_and_retains_nonzero_media_position', audit.plays === 0 && audit.seeks.length === 0 && audit.time === 6 && audit.paused && audit.mounted === mounted);
}

try {
  const reader = new URL('../reader/', import.meta.url);
  server = createServer(async (req,res) => {
    if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405).end(); return;}
    const name = new URL(req.url,'http://localhost').pathname.slice(1) || 'index.html';
    if (!/^[a-z-]+\.(html|js|css|webmanifest|png)$/.test(name)) {res.writeHead(404).end(); return;}
    try {const bytes = await fs.readFile(new URL(name,reader)); res.writeHead(200, {'Content-Type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'text/html'}).end(bytes);}
    catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless:true, ...(process.env.COCONUT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE} : {})});
  for (const [label,viewport] of [['desktop',{width:1360,height:1000}],['390',{width:390,height:844}]]) {
    stage = label + ' import authored translations';
    const context = await browser.newContext({viewport,acceptDownloads:true,serviceWorkers:'block'});
    await context.route('**/*',async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET','HEAD'].includes(request.method())) {mutations++; await route.abort();}
      else if (url.origin === origin || ['blob:','data:'].includes(url.protocol)) await route.continue();
      else {external++; await route.abort();}
    });
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror',error => errors.push(error.message)); await page.goto(origin);
    const fixture = authoredFixtures(label);
    const mainKey = await importDocument(page,fixture.main), decoyKey = await importDocument(page,fixture.decoy), companionKey = await importDocument(page,fixture.companion);
    const markers = await positionsSnapshot(page);
    check(label + '_explicit_markers_are_durable_before_search', markers.live.length >= 3 && JSON.stringify(markers.live) === JSON.stringify(markers.durable));
    for (const [key,value] of [[mainKey,'cue-139'],[companionKey,'cue-111'],[decoyKey,'source-only']]) check(label + '_imported_reading_marker_' + value,markers.durable.some(marker => marker.key === key && marker.present && marker.value === value));
    await attachPausedTone(page,label + '-companion');
    stage = label + ' exclusive current-translation scope';
    await search(page,query,'text',[decoyKey]);
    check(label + '_existing_original_scope_does_not_include_current_translations', await page.locator('.library-translation-group').count() === 0);
    await search(page,'historicbeacon','text',[mainKey]);
    check(label + '_historical_bilingual_record_is_a_real_positive_control', await page.locator('.library-saved-hit').count() === 1);
    for (const absent of ['expiredsource','expiredcontext','incompletelegacy','expiredlanguage','historicbeacon']) {
      await search(page,absent,'translations',[]);
      check(label + '_' + absent + '_excluded_from_current_scope', await page.locator('.library-translation-hit').count() === 0 && await page.locator('#library-empty').isVisible());
    }
    await search(page,query,'translations',[mainKey,companionKey]);
    check(label + '_translated_scope_is_explicit_and_explains_all_current_languages', await page.locator('#library-scope option[value="translations"]').textContent() === '译文' && /全部语言/.test(await page.locator('#library-scope-hint').textContent()) && /当前有效/.test(await page.locator('#library-scope-hint').textContent()) && await page.locator('#library-scope-hint').isVisible());
    assert.deepEqual((await entry(page,mainKey).locator('.library-translation-group').evaluateAll(nodes => nodes.map(node => node.dataset.language))).sort(),Object.keys(languages).sort());
    check(label + '_all_seven_stored_languages_match_when_translation_view_is_empty', await page.evaluate(key => state.documents.find(doc => doc.key === key).translation_view === '',mainKey));
    check(label + '_same_cue_id_in_another_document_remains_a_separate_result', await hit(page,companionKey,'fr').getAttribute('data-hit-id') === 'cue-108' && (await hit(page,companionKey,'fr').textContent()).includes(fixture.companion.segments[0].text));
    stage = label + ' genuine keyboard focus and all-language previews';
    const order = await entry(page,mainKey).locator('.library-translation-group').evaluateAll(nodes => nodes.map(node => node.dataset.language));
    check(label + '_keyboard_journey_starts_at_filled_search', await page.locator('#library-search').evaluate(node => node === document.activeElement));
    for (const language of order) {
      const target = hit(page,mainKey,language);
      check(label + '_' + language + '_preview_has_language_time_literal_translation_and_first_original', await target.getAttribute('data-hit-id') === 'cue-108' && (await target.locator('small').textContent()).includes(languages[language]) && (await target.locator('small').textContent()).includes(C.time(216)) && (await target.locator('.library-hit-preview').textContent()).includes(fixture.main.segments[108].translations[language].text) && (await target.locator('.library-hit-source').textContent()).includes(fixture.main.segments[108].text));
      await walkTo(page,target,label + '-' + language); await keyboardGeometry(page,target,label + '-' + language); await capture(page,label + '-' + language + '-shelf');
      if (language !== 'zh') check(label + '_' + language + '_single_hit_has_no_dead_pagination_controls', !await group(page,mainKey,language).locator('.library-translation-next').isVisible());
    }
    stage = label + ' group pagination reaches every saved Chinese match';
    const zh = group(page,mainKey,'zh'), zhHit = hit(page,mainKey,'zh');
    // Return within the shelf rather than wrapping past every reader control.
    await walkTo(page,zhHit,label + '-zh-pagination-start','Shift+Tab');
    await expect(zh.locator('.library-translation-status')).toHaveText('第 1 / 5 处');
    check(label + '_first_chinese_match_has_disabled_previous',await zh.locator('.library-translation-previous').isDisabled());
    for (let i = 1; i < positions.length; i++) {
      await walkTo(page,zh.locator('.library-translation-next'),label + '-next-' + i);
      await keyboardGeometry(page,zh.locator('.library-translation-next'),label + '-next-' + i);
      await paginationLayout(page,zh,label + '-pagination-' + i);
      if (i === 1) await capture(page,label + '-pagination-count-row');
      await page.keyboard.press('Enter'); await expect(zhHit).toHaveAttribute('data-hit-id','cue-' + positions[i]);
      await expect(zh.locator('.library-translation-status')).toHaveText('第 ' + (i+1) + ' / 5 处');
      await keyboardGeometry(page,zhHit,label + '-page-' + (i+1));
      check(label + '_group_page_' + (i+1) + '_does_not_open_or_change_reader', (await ownership(page)).key === companionKey);
      if (i === 2) check(label + '_translation_snippet_is_literal_not_html', (await zhHit.textContent()).includes('<img src=x>') && await zhHit.locator('img').count() === 0);
    }
    check(label + '_last_chinese_match_has_disabled_next',await zh.locator('.library-translation-next').isDisabled());
    await walkTo(page,zh.locator('.library-translation-previous'),label + '-previous'); await keyboardGeometry(page,zh.locator('.library-translation-previous'),label + '-previous');
    await page.keyboard.press('Enter'); await expect(zhHit).toHaveAttribute('data-hit-id','cue-120');
    await keyboardGeometry(page,zhHit,label + '-previous-return');
    await page.keyboard.press('Shift+Tab'); check(label + '_reverse_tab_leaves_current_hit', !await zhHit.evaluate(node => node === document.activeElement));
    await page.keyboard.press('Tab'); await keyboardGeometry(page,zhHit,label + '-reverse-return');
    await walkTo(page,zh.locator('.library-translation-next'),label + '-last-again'); await page.keyboard.press('Enter');
    await expect(zhHit).toHaveAttribute('data-hit-id','cue-124'); await keyboardGeometry(page,zhHit,label + '-last-before-open');
    await unchangedMedia(page,label + '-search-and-paging',true);
    stage = label + ' cross-document exact bilingual destination';
    await page.keyboard.press('Enter');
    await visibleBilingualCue(page,mainKey,'cue-124','zh',fixture.main.segments[124].text,fixture.main.segments[124].translations.zh.text,label + '-cross-document');
    check(label + '_late_cue_opens_real_neighbors_with_bounded_dom',await page.locator('.segment[data-segment-id="cue-123"]').count() === 1 && await page.locator('.segment[data-segment-id="cue-125"]').count() === 1 && await page.locator('#transcript .segment').count() <= 100);
    check(label + '_shelf_closes_at_destination',await page.locator('#toggle-library').getAttribute('aria-expanded') === 'false');
    await unchangedMedia(page,label + '-cross-document',false);
    assert.deepEqual(await positionsSnapshot(page),markers,label + ' cross-document navigation preserves every live and durable reading marker');
    check(label + '_cross_document_keeps_all_explicit_reading_positions',true);
    stage = label + ' same-document language switch preserves real paused media';
    await attachPausedTone(page,label + '-main');
    await search(page,query,'translations',[mainKey,companionKey]);
    const japanese = hit(page,mainKey,'ja'); await walkTo(page,japanese,label + '-same-document-japanese');
    await keyboardGeometry(page,japanese,label + '-same-document-japanese'); await page.keyboard.press('Enter');
    await visibleBilingualCue(page,mainKey,'cue-108','ja',fixture.main.segments[108].text,fixture.main.segments[108].translations.ja.text,label + '-same-document');
    await unchangedMedia(page,label + '-same-document',true);
    assert.deepEqual(await positionsSnapshot(page),markers,label + ' changing displayed language preserves all live and durable reading markers');
    check(label + '_same_document_language_switch_keeps_all_explicit_reading_positions',true);
    stage = label + ' cross-cue translated phrase keeps exact first contributor';
    await search(page,'riverside crossing','translations',[mainKey]);
    const across = hit(page,mainKey,'en');
    check(label + '_cross_cue_phrase_labels_both_contributors_and_first_original',await across.getAttribute('data-hit-id') === 'cue-110' && /跨 2 段/.test(await across.locator('small').textContent()) && await across.locator('.library-hit-preview mark').textContent() === 'riverside crossing' && (await across.locator('.library-hit-source').textContent()).includes(fixture.main.segments[110].text));
    await walkTo(page,across,label + '-cross-cue'); await keyboardGeometry(page,across,label + '-cross-cue'); await page.keyboard.press('Enter');
    await visibleBilingualCue(page,mainKey,'cue-110','en',fixture.main.segments[110].text,fixture.main.segments[110].translations.en.text,label + '-cross-cue','riverside crossing');
    check(label + '_cross_cue_navigation_highlights_real_first_range_and_keeps_next_translation',await page.locator('.segment[data-segment-id="cue-110"] .translation mark').textContent() === 'riverside' && await page.locator('.segment[data-segment-id="cue-111"] .translation').textContent() === fixture.main.segments[111].translations.en.text);
    await unchangedMedia(page,label + '-cross-cue',true);
    stage = label + ' long translation lands on its actual late match';
    await search(page,'longbeacon','translations',[mainKey]);
    const longHit = hit(page,mainKey,'fr');
    await walkTo(page,longHit,label + '-long-translation'); await keyboardGeometry(page,longHit,label + '-long-translation'); await page.keyboard.press('Enter');
    await page.waitForFunction(({key,source,translation}) => {
      const row = document.querySelector('.segment[data-segment-id="cue-126"]'), translated = row?.querySelector('.translation:not(.stale)'), mark = translated?.querySelector('mark');
      const r = mark?.getBoundingClientRect(), full = translated?.getBoundingClientRect();
      return state.active === key && active().translation_view === 'fr' && document.activeElement === row &&
        row.querySelector('.words')?.textContent === source && translated.textContent === translation && mark?.textContent === 'longbeacon' &&
        full.height > innerHeight && r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    },{key:mainKey,source:fixture.main.segments[126].text,translation:fixture.main.segments[126].translations.fr.text});
    // Only the actual late match must fit. Requiring this oversized row, or its
    // distant original paragraph, to fit would defeat the long-cue regression.
    check(label + '_late_mark_in_real_oversized_translation_is_visible_with_cue_focus',true);
    await capture(page,label + '-long-translation-late-mark'); await unchangedMedia(page,label + '-long-translation',true);
    await waitForPersistedLibrary(page,async key => (await readPersistedLibrary()).documents.find(doc => doc.key === key)?.translation_view === 'fr',mainKey);
    assert.deepEqual(await positionsSnapshot(page),markers,label + ' cross-cue and long-translation navigation preserve every marker');
    check(label + '_cross_cue_and_long_translation_keep_explicit_reading_positions',true);
    stage = label + ' stale and detached result ownership guards';
    await search(page,query,'translations',[mainKey,companionKey]);
    const oldHandle = await hit(page,companionKey,'fr').elementHandle();
    await search(page,'never-matching-current-translation','translations',[]);
    const beforeOld = await ownership(page);
    await oldHandle.evaluate(node => node.click()); await settle(page);
    assert.deepEqual(await ownership(page),beforeOld,label + ' previous query result cannot navigate'); await oldHandle.dispose();
    check(label + '_old_query_button_cannot_take_over_reader',true);
    // These three adversarial lifetime checks deliberately retain a real DOM
    // handler while its owner changes. They do not fake the successful journey,
    // persistence, focus geometry or scroll behavior tested above.
    for (const kind of ['detached','owner','snapshot']) {
      await search(page,query,'translations',[mainKey,companionKey]);
      const before = await ownership(page);
      await hit(page,companionKey,'fr').evaluate((node,{kind,key}) => {
        const index = state.documents.findIndex(doc => doc.key === key), owner = state.documents[index];
        const cue = owner.segments.find(cue => cue.id === node.dataset.hitId), prior = cue.translations.fr;
        try {
          if (kind === 'detached') node.remove();
          if (kind === 'owner') state.documents[index] = {...owner};
          if (kind === 'snapshot') cue.translations.fr = {...prior,text: prior.text + ' changed after the result was rendered'};
          node.click();
        } finally {
          if (kind === 'owner') state.documents[index] = owner;
          if (kind === 'snapshot') cue.translations.fr = prior;
        }
      },{kind,key:companionKey});
      await settle(page); assert.deepEqual(await ownership(page),before,label + ' ' + kind + ' result cannot navigate');
      check(label + '_' + kind + '_result_cannot_take_over_reader',true);
      // Change the actual search input to rebuild the shelf after the probe.
      await search(page,'never-matching-current-translation','translations',[]);
    }
    await unchangedMedia(page,label + '-rejected-obsolete-results',true);
    assert.deepEqual(await positionsSnapshot(page),markers,label + ' rejected obsolete results preserve durable reading positions');
    check(label + '_rejected_obsolete_results_leave_every_marker_unchanged',true);
    stage = label + ' reload real durable selection and markers';
    await page.reload(); await expect(page.locator('#title')).toHaveText(fixture.main.title);
    await waitForPersistedLibrary(page,async key => (await readPersistedLibrary()).documents.find(doc => doc.key === key)?.translation_view === 'fr',mainKey);
    assert.deepEqual(await positionsSnapshot(page),markers,label + ' real IndexedDB reload preserves all markers');
    await search(page,query,'translations',[mainKey,companionKey]);
    check(label + '_reload_keeps_all_languages_searchable_independent_of_saved_display',await entry(page,mainKey).locator('.library-translation-group').count() === 7);
    await context.close(); page = null;
  }
  check('no_external_requests_mutating_http_or_uncaught_browser_errors',external === 0 && mutations === 0 && errors.length === 0);
  console.log(JSON.stringify({suite:'library-translations-browser',status:'passed',checks,geometry,pagination,screenshots,external,mutations,errors}));
} catch (error) {
  if (page && !page.isClosed()) await capture(page,'failure').catch(() => {});
  console.error(JSON.stringify({suite:'library-translations-browser',status:'failed',stage,error:{name:error.name,message:error.message,stack:error.stack},checks,geometry,pagination,screenshots,external,mutations,errors})); process.exitCode = 1;
} finally {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
}
