/** GitHub Actions only: native Chromium, authored source, real IndexedDB receipts.
 * No workspace browser, remote provider, media, model, account, or DOM mock.
 * Failed and delayed writes still use the production save pipeline and adapter.
 * `node --check` validates syntax only; it is not evidence this journey passed. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium, expect, waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {openTranscriptTools} from './helpers/reading-tools-browser.mjs';
import {openCueActions} from './cue-actions-browser.mjs';

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Run the real source correction browser journey in GitHub Actions only.');
const C = createRequire(import.meta.url)('../reader/core.js');
const root = new URL('../reader/', import.meta.url);
const checks = [], errors = [], geometry = [];
const UNSAFE = '<img src="/source-correction-xss" onerror="window.__sourceCorrectionAudit.xss++">';
let browser, server, page, stage = 'setup', external = 0, mutations = 0, xssRequests = 0, failure = null;
const check = (name, value) => {stage = name; assert.ok(value, name); checks.push(name);};
const clone = value => JSON.parse(JSON.stringify(value));
const history = doc => doc.segments.map(cue => ({text: cue.text, ...(Object.hasOwn(cue, 'original_text') ? {original_text: cue.original_text} : {})}));
// These saved records must not be rewritten to pretend they describe the edit.
const untouched = doc => ({
  title: doc.title, language: doc.language, notes: doc.notes, project_note: doc.project_note,
  ai_answers: doc.ai_answers, exact_excerpts: doc.exact_excerpts, exact_excerpt_notes: doc.exact_excerpt_notes,
  summary_runs: doc.summary_runs, translation_contexts: doc.translation_contexts,
  timestamp_bookmarks: doc.timestamp_bookmarks, provenance: doc.provenance, readingPosition: doc.readingPosition,
  segments: doc.segments.map(({text, original_text, ...rest}) => rest),
});
function fixture(label) {
  const segments = Array.from({length: 240}, (_, i) => {
    let text = `Authored source ${String(i).padStart(3, '0')}: teh stays in a real cue.`;
    if (i === 0) text = 'Authored source 000: teh then teh then teh; Teh stays cased.';
    if (i === 235) text = 'Boundary ends CROSS';
    if (i === 236) text = 'CUE starts here.';
    if (i === 237) text = 'REMOVE_ONLY';
    if (i === 238) text = 'Keep REMOVE_ME content.';
    if (i === 239) text = 'Authored final source 239: teh; emoji 👩🏽‍💻; cafe\u0301; dollar $&/$1/$$/\\path; ' + UNSAFE;
    return {id: 'source-' + i, start: i * 3 + 0.125, end: i * 3 + 2.875, text,
      speaker: i % 2 ? 'Other speaker' : 'Source speaker',
      ...(i === 0 ? {original_text: 'Original authored wording before an earlier correction.'} : {}),
      ...(i === 0 || i === 239 ? {saved_excerpt: true} : {}),
      translations: {zh: {text: '自写旧译文 teh ' + i, source_text: text, source_language: 'en', document_language: 'en', provider: 'authored_fixture'}},
    };
  });
  const doc = C.validate({schema_version: 1, title: 'Authored source correction ' + label, language: 'en', translation_view: 'zh', segments,
    notes: {'source-0': 'PRIVATE teh note; leave authored notes intact.', 'source-239': 'PRIVATE later note.'},
    project_note: 'PRIVATE teh project note, never source speech.', readingPosition: 'source-0',
    timestamp_bookmarks: [{id: 'authored-point', time: 15, note: 'PRIVATE teh timestamp note.'}],
    ai_answers: [{purpose: 'summary', question: C.SUMMARY_QUESTION, answer: 'PRIVATE authored teh summary. No model was called.', provider: 'authored_fixture', citations: ['source-0'],
      input_snapshot: {version: 1, segments: segments.map(({id, text}) => ({id, text}))}}],
  });
  doc.key = 'authored-source-' + label;
  doc.exact_excerpts = [C.exactExcerptSnapshot(doc, [doc.segments[0]], [], 0, 30, {id: 'authored-exact', createdAt: '2026-10-11T00:00:00.000Z'})];
  return doc;
}
function literalHits(doc, find) {
  const hits = [];
  for (const cue of doc.segments) for (let from = 0, start; (start = cue.text.indexOf(find, from)) !== -1; from = start + find.length) hits.push({index: hits.length, id: cue.id, start, end: start + find.length});
  return hits;
}
function expectedCorrection(doc, find, replace, selected = null) {
  const result = clone(doc), hits = literalHits(doc, find);
  for (const cue of result.segments) {
    const chosen = hits.filter(hit => hit.id === cue.id && (!selected || selected.has(hit.index)));
    if (!chosen.length) continue;
    let text = cue.text;
    for (const hit of chosen.reverse()) text = text.slice(0, hit.start) + replace + text.slice(hit.end);
    if (text !== cue.text) {if (cue.original_text === undefined) cue.original_text = cue.text; cue.text = text;}
  }
  return result;
}
const disk = () => page.evaluate(() => readPersistedLibrary());
async function activeSaved() {
  const state = await disk(), key = await page.evaluate(() => sessionStorage.getItem('coconut-reader-active-v1'));
  return state.documents.find(doc => doc.key === key);
}
async function settled() {await page.evaluate(() => libraryStore.flush()); return activeSaved();}
async function saved(expected) {
  await waitForPersistedLibrary(page, async expected => {
    const key = sessionStorage.getItem('coconut-reader-active-v1');
    const doc = (await readPersistedLibrary()).documents.find(doc => doc.key === key);
    return JSON.stringify(doc?.segments.map(cue => ({text: cue.text, ...(Object.hasOwn(cue, 'original_text') ? {original_text: cue.original_text} : {})}))) === JSON.stringify(expected);
  }, history(expected));
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved');
  return activeSaved();
}
async function reloadSaved(expected) {
  await page.reload();
  await expect(page.locator('#reader-workspace')).toBeVisible();
  await page.evaluate(() => libraryStore.flush());
  // Bootstrap readiness alone does not establish the active document or a
  // committed save receipt. Poll the actual selected-backend document too.
  return saved(expected);
}
async function choose(file) {
  if (!await page.locator('#import').isVisible()) await page.locator('#add-content').click();
  const [picker] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#import').click()]);
  await picker.setFiles(file); await expect(page.locator('#file')).toHaveValue('');
  await expect(page.locator('#reader-workspace')).toBeVisible(); await settled();
}
async function importFixture(doc) {await choose({name: 'authored-source-corrections.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc))}); await expect(page.locator('#title')).toHaveText(doc.title);}
async function open({keyboard = false} = {}) {
  await page.bringToFront();
  if (await page.locator('#source-correction-dialog').isVisible()) return;
  // Continuous reading reparents the already-open settings into a closed
  // information disclosure and hides its inner summary. Follow the visible
  // native disclosure without changing the user's current reading mode.
  if (await page.locator('#reading-info > summary').isVisible() && !await page.locator('#reading-info').evaluate(node => node.open)) await page.locator('#reading-info > summary').click();
  if (!await page.locator('#reading-settings').evaluate(node => node.open)) await page.locator('#reading-settings > summary').click();
  const opener = page.locator('#open-source-correction'); await expect(opener).toBeVisible();
  if (keyboard) {await opener.focus(); await page.keyboard.press('Enter');} else await opener.click();
  await expect(page.locator('#source-correction-dialog')).toBeVisible();
}
async function close(key = 'Escape') {
  if (key === 'Escape') await page.keyboard.press('Escape'); else await page.locator('#close-source-correction').click();
  await expect(page.locator('#source-correction-dialog')).toBeHidden();
  await expect(page.locator('#open-source-correction')).toBeFocused();
}
async function draft(find, replace) {
  await open(); await page.locator('#source-find').fill(find); await page.locator('#source-replace').fill(replace);
  await expect(page.locator('#apply-source-correction')).toBeDisabled();
}
async function preview(find, replace) {
  await draft(find, replace); await page.locator('#preview-source-correction').click();
}
async function apply(expected) {
  await expect(page.locator('#apply-source-correction')).toBeEnabled();
  await page.locator('#apply-source-correction').click();
  return saved(expected);
}
async function undo(expected) {
  await open(); await expect(page.locator('#undo-source-correction')).toBeEnabled();
  await page.locator('#undo-source-correction').click(); return saved(expected);
}
async function download(selector = '#export') {
  if (selector === '#export') {
    if (await page.locator('#source-correction-dialog').isVisible()) await close('button');
    if (!await page.locator('#export-menu').evaluate(node => node.open)) await page.locator('#export-menu > summary').click();
  }
  const [item] = await Promise.all([page.waitForEvent('download'), page.locator(selector).click()]);
  assert.equal(await item.failure(), null);
  const file = {name: item.suggestedFilename(), mimeType: 'application/json', buffer: await fs.readFile(await item.path())};
  if (selector === '#export') await page.locator('#export-menu > summary').click(); return file;
}
async function clickVisibleReaderControl(selector, label) {
  const control = page.locator(selector); await expect(control).toBeVisible(); await control.scrollIntoViewIfNeeded();
  const data = await control.evaluate(node => {
    const r = node.getBoundingClientRect(), x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
    return {id: node.id, rect: r.toJSON(), viewport: {width: innerWidth, height: innerHeight},
      hits: [[x, y], [r.left + 1, y], [r.right - 1, y], [x, r.top + 1], [x, r.bottom - 1]].map(([x, y]) => {
        const hit = document.elementFromPoint(x, y); return {x, y, clear: hit === node || node.contains(hit), hit: hit?.id || hit?.tagName};
      })};
  });
  geometry.push({label, ...data}); const {rect: r, viewport: v} = data;
  check(label + '_44px_visible_five_clear_pointer_hits', r.width >= 44 && r.height >= 44 && r.left >= 0 && r.right <= v.width && r.top >= 0 && r.bottom <= v.height && data.hits.every(hit => hit.clear));
  await control.click();
}
async function capture(label) {
  if (!process.env.COCONUT_UI_SCREENSHOTS) return;
  await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS, {recursive: true});
  await page.screenshot({path: path.join(process.env.COCONUT_UI_SCREENSHOTS, 'source-corrections-' + label + '.png'), animations: 'disabled'});
}
async function focusedGeometry(label, {opener = false} = {}) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const value = await page.evaluate(opener => {
    const node = document.activeElement, host = document.getElementById('source-correction-dialog');
    const r = node.getBoundingClientRect(), d = host.getBoundingClientRect(), style = getComputedStyle(node);
    const ring = (parseFloat(style.outlineWidth) || 0) + Math.max(0, parseFloat(style.outlineOffset) || 0), x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
    const clips = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const box = parent.getBoundingClientRect(), css = getComputedStyle(parent), clipX = /hidden|clip|scroll|auto/.test(css.overflowX), clipY = /hidden|clip|scroll|auto/.test(css.overflowY);
      if (clipX || clipY) clips.push({id: parent.id || parent.tagName, clear: (!clipX || (r.left - ring >= box.left + parent.clientLeft && r.right + ring <= box.left + parent.clientLeft + parent.clientWidth)) && (!clipY || (r.top - ring >= box.top + parent.clientTop && r.bottom + ring <= box.top + parent.clientTop + parent.clientHeight))});
    }
    return {id: node.id || node.tagName + ':' + node.closest('[data-hit-index]')?.dataset.hitIndex, inside: opener ? node.id === 'open-source-correction' : node.closest('dialog') === host,
      visibleFocus: node.matches(':focus-visible'), disabled: node.disabled, ariaDisabled: node.getAttribute('aria-disabled'), outline: style.outlineStyle, ring, rect: r.toJSON(), dialog: d.toJSON(), clips,
      viewport: {width: innerWidth, height: innerHeight}, pageWidth: document.documentElement.scrollWidth, dialogWidth: host.scrollWidth, dialogClientWidth: host.clientWidth,
      hits: [[x, y], [r.left + 1, y], [r.right - 1, y], [x, r.top + 1], [x, r.bottom - 1]].map(([x, y]) => {const hit = document.elementFromPoint(x, y); return {x, y, clear: hit === node || node.contains(hit), hit: hit?.id || hit?.tagName};}),
    };
  }, opener);
  geometry.push({label, ...value});
  const {rect: r, dialog: d, ring, viewport: v} = value;
  check(label + '_44px_full_focus_ring_five_clear_hits', value.inside && value.visibleFocus && value.outline !== 'none' && ring > 0 && r.width >= 44 && r.height >= 44 &&
    r.left - ring >= (opener ? 0 : Math.max(0, d.left)) && r.right + ring <= (opener ? v.width : Math.min(v.width, d.right)) &&
    r.top - ring >= (opener ? 0 : Math.max(0, d.top)) && r.bottom + ring <= (opener ? v.height : Math.min(v.height, d.bottom)) &&
    value.clips.every(clip => clip.clear) && value.hits.every(hit => hit.clear) && value.pageWidth <= v.width && (opener || value.dialogWidth <= value.dialogClientWidth + 1));
  return value.id;
}
async function tabCircuit(label) {
  check(label + '_native_named_modal', await page.locator('#source-correction-dialog').evaluate(node => node instanceof HTMLDialogElement && node.open && node.matches(':modal') && !!(node.getAttribute('aria-label') || document.getElementById(node.getAttribute('aria-labelledby'))?.textContent.trim())));
  const candidates = await page.locator('#source-correction-dialog').evaluate(host => [...host.querySelectorAll('button,input,textarea,select,summary,[tabindex]')].filter(node => !node.disabled && node.tabIndex >= 0 && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0).map(node => node.id || node.tagName + ':' + node.closest('[data-hit-index]')?.dataset.hitIndex));
  for (const direction of ['Tab', 'Shift+Tab']) {
    await page.locator('#source-find').focus(); const seen = new Set();
    for (let i = 0; i <= candidates.length; i++) {await page.keyboard.press(direction); seen.add(await focusedGeometry(label + '_' + direction + '_' + i));}
    check(label + '_' + direction + '_all_controls_reachable_and_modal_trapped', candidates.every(id => seen.has(id)));
  }
}
// Use native Tab, not target.focus(), to establish keyboard modality on an
// asynchronously disappearing recovery control before activating it.
async function keyboardFocus(selector) {
  await expect(page.locator(selector)).toBeVisible(); await page.locator('#source-find').focus();
  const count = await page.locator('#source-correction-dialog button,#source-correction-dialog input').count();
  for (let index = 0; index <= count; index++) {
    if (await page.locator(selector).evaluate(node => node === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(page.locator(selector)).toBeFocused();
}
async function recoveryFocus(selector, label, {ariaDisabled = null} = {}) {
  await expect(page.locator(selector)).toBeVisible(); await expect(page.locator(selector)).toBeFocused();
  // An inert retry keeps native focusability while exposing aria-disabled=true.
  // Playwright toBeEnabled deliberately includes aria-disabled, so inspect the
  // HTML disabled property separately rather than conflating the two contracts.
  await expect(page.locator(selector)).toHaveJSProperty('disabled', false);
  if (ariaDisabled !== null) await expect(page.locator(selector)).toHaveAttribute('aria-disabled', String(ariaDisabled));
  else await expect(page.locator(selector)).toBeEnabled();
  await focusedGeometry(label);
}
async function keyboardDownload(selector) {
  await keyboardFocus(selector);
  const [item] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  assert.equal(await item.failure(), null);
  return {name: item.suggestedFilename(), mimeType: 'application/json', buffer: await fs.readFile(await item.path())};
}
const hitBox = index => page.locator('#source-correction-results .source-correction-hit[data-hit-index="' + index + '"] input[type="checkbox"]');
async function hold() {await page.evaluate(() => {sourceCorrectionSaveProbe.holdNext = true;});}
async function held() {await page.waitForFunction(() => !!sourceCorrectionSaveProbe.held);}
async function release() {
  const before = await page.evaluate(() => {const before = sourceCorrectionSaveProbe.finished; sourceCorrectionSaveProbe.held.release(); sourceCorrectionSaveProbe.held = null; return before;});
  await page.waitForFunction(before => sourceCorrectionSaveProbe.finished > before, before);
}

try {
  server = createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) {mutations++; res.writeHead(405).end(); return;}
    const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if (name === 'source-correction-xss') xssRequests++;
    if (!/^[a-z-]+\.(html|js|css|png|webmanifest)$/.test(name)) {res.writeHead(404).end(); return;}
    try {res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'text/html'); res.end(await fs.readFile(new URL(name, root)));}
    catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true});
  async function newPage(width) {
    const context = await browser.newContext({viewport: {width, height: width === 390 ? 844 : 1000}, acceptDownloads: true, serviceWorkers: 'block'});
    await context.addInitScript(() => {
      window.__sourceCorrectionAudit = {writes: 0, xss: 0, trustedKeys: 0, trustedChanges: 0};
      addEventListener('keydown', event => {if (event.isTrusted && document.getElementById('source-correction-dialog')?.contains(event.target)) __sourceCorrectionAudit.trustedKeys++;}, true);
      addEventListener('change', event => {if (event.isTrusted && event.target.matches('#source-correction-results input[type="checkbox"]')) __sourceCorrectionAudit.trustedChanges++;}, true);
      for (const method of ['put', 'add', 'delete']) {
        const original = IDBObjectStore.prototype[method];
        IDBObjectStore.prototype[method] = function (...args) {if (this.transaction.db.name === 'coconut-reader-library-v1' && this.name === 'documents') __sourceCorrectionAudit.writes++; return original.apply(this, args);};
      }
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) {mutations++; await route.abort(); return;}
      if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) await route.continue(); else {external++; await route.abort();}
    });
    await context.route('**/storage-provider.js*', async route => {
      const response = await route.fetch(), body = await response.text();
      await route.fulfill({response, body: body + `\n(()=>{const initialize=CoconutStorageProvider.initialize;window.sourceCorrectionSaveProbe={holdNext:false,held:null,finished:0};CoconutStorageProvider.initialize=async function(...args){const result=await initialize.apply(this,args);if(result.ok&&result.backend==='indexeddb'){const write=result.adapter.write.bind(result.adapter);result.adapter.write=async(...args)=>{if(sourceCorrectionSaveProbe.holdNext){sourceCorrectionSaveProbe.holdNext=false;await new Promise(resolve=>{sourceCorrectionSaveProbe.held={release:resolve};});}const receipt=await write(...args);sourceCorrectionSaveProbe.finished++;return receipt;};}return result;};})();`});
    });
    const result = await context.newPage(); result.setDefaultTimeout(15000); result.on('pageerror', error => errors.push(error.message)); await result.goto(origin); return result;
  }

  for (const width of [390, 1360]) {
    stage = 'whole-source fixture ' + width; page = await newPage(width); await importFixture(fixture(String(width)));
    await page.locator('#mode-transcript').click(); await openTranscriptTools(page);
    check('fixture_crosses_three_source_pages_' + width, await page.locator('#transcript .segment').count() === 100);
    await page.locator('#next-page').click(); await page.locator('#search').fill('Authored source 200:');
    await expect(page.locator('#transcript .segment')).toHaveCount(1);
    const baseline = await settled(), hits = literalHits(baseline, 'teh'), writesBefore = await page.evaluate(() => __sourceCorrectionAudit.writes);
    assert.equal(hits.length, 238);
    stage = 'explicit preview and keyboard ' + width; await open({keyboard: true});
    await expect(page.locator('#undo-source-correction')).toBeHidden(); await expect(page.locator('#source-correction-undo-help')).not.toBeEmpty();
    for (const selector of ['#source-find', '#source-replace']) check('input_has_accessible_name_' + selector.slice(1) + '_' + width, await page.locator(selector).evaluate(node => !!node.labels?.length || !!node.getAttribute('aria-label')));
    await draft('teh', 'the');
    check('typing_requires_explicit_preview_' + width, await page.locator('#source-correction-results .source-correction-hit').count() === 0);
    await page.locator('#preview-source-correction').click();
    await expect(page.locator('#source-correction-count')).toContainText('238');
    await expect(page.locator('#source-correction-results .source-correction-hit')).toHaveCount(20);
    check('whole_source_preview_ignores_search_and_current_page_' + width, await page.locator('#source-correction-results .source-correction-hit').first().getAttribute('data-segment-id') === 'source-0' && await hitBox(0).isChecked());
    await expect(page.locator('#source-correction-results')).toContainText('00:00');
    await tabCircuit('preview_' + width); await capture('preview-' + width);
    await close(); await focusedGeometry('Escape_opener_' + width, {opener: true});
    assert.deepEqual(await settled(), baseline);
    check('preview_and_Escape_do_not_write_' + width, await page.evaluate(() => __sourceCorrectionAudit.writes) === writesBefore);

    stage = 'selection across hit pages ' + width; await preview('teh', 'the');
    // Native Space deselects only the middle occurrence in one cue.
    await hitBox(1).focus(); await page.keyboard.press('Space'); await expect(hitBox(1)).not.toBeChecked();
    await expect(hitBox(0)).toBeChecked(); await expect(hitBox(2)).toBeChecked();
    await page.locator('#source-correction-next').click(); await expect(hitBox(20)).toBeVisible();
    await page.locator('#clear-source-page').click();
    check('clear_page_preserves_other_pages_' + width, await page.locator('#source-correction-results input:checked').count() === 0);
    await page.locator('#select-source-page').click();
    check('select_page_selects_twenty_visible_hits_' + width, await page.locator('#source-correction-results input:checked').count() === 20);
    await page.locator('#clear-source-page').click(); await hitBox(20).focus(); await page.keyboard.press('Space');
    const selected = new Set(hits.map(hit => hit.index).filter(index => index !== 1 && !(index >= 21 && index < 40)));
    for (let index = 40; index < hits.length; index += 20) await page.locator('#source-correction-next').click();
    await expect(page.locator('#source-correction-next')).toBeDisabled();
    await expect(page.locator('#source-correction-results .source-correction-hit')).toHaveCount(18);
    check('last_hit_page_reaches_last_source_cue_' + width, await page.locator('#source-correction-results .source-correction-hit').last().getAttribute('data-segment-id') === 'source-239');
    check('preview_renders_authored_HTML_as_text_' + width, await page.locator('#source-correction-results img,#source-correction-results script').count() === 0 && await page.evaluate(() => __sourceCorrectionAudit.xss === 0));
    await capture('last-hit-page-' + width);
    for (let index = 220; index > 0; index -= 20) await page.locator('#source-correction-prev').click();
    await expect(hitBox(1)).not.toBeChecked(); await expect(hitBox(0)).toBeChecked(); await expect(hitBox(2)).toBeChecked();
    await expect(page.locator('#source-correction-count')).toContainText(String(selected.size));
    assert.deepEqual(await settled(), baseline);
    const expected = expectedCorrection(baseline, 'teh', 'the', selected);
    const changed = await apply(expected); assert.deepEqual(untouched(changed), untouched(baseline));
    check('selection_uses_trusted_native_keyboard_events_' + width, await page.evaluate(() => __sourceCorrectionAudit.trustedKeys > 20 && __sourceCorrectionAudit.trustedChanges >= 2));
    check('partial_same_cue_and_global_selection_apply_exactly_' + width, changed.segments[0].text.includes('the then teh then the; Teh') && changed.segments[239].text.includes('the; emoji') && changed.segments[0].original_text === baseline.segments[0].original_text);
    check('historical_dependencies_become_stale_without_rewriting_' + width, C.summaryFreshness(changed.ai_answers[0], changed) === 'stale' && C.exactExcerptFreshness(changed.exact_excerpts[0], changed) === 'stale' && !C.translationCurrent(changed.segments[0], changed, changed.segments[0].translations.zh));
    await undo(baseline); assert.deepEqual(untouched(await activeSaved()), untouched(baseline));
    await expect(page.locator('#undo-source-correction')).toBeHidden();
    check('one_batch_undo_restores_exact_text_and_original_history_' + width, JSON.stringify(history(await activeSaved())) === JSON.stringify(history(baseline)));

    stage = 'literal matching and deletion ' + width;
    for (const [find, replace] of [['CROSS CUE', 'wrong joined cue'], ['TEH', 'wrong case'], ['.*', 'not a regexp'], ['café', 'no implicit Unicode normalization']]) {
      await preview(find, replace); await expect(page.locator('#apply-source-correction')).toBeDisabled();
      await expect(page.locator('#source-correction-results .source-correction-hit')).toHaveCount(0);
    }
    await preview('teh', UNSAFE); await expect(page.locator('#source-correction-results')).toContainText(UNSAFE);
    check('replacement_is_literal_text_never_executable_markup_' + width, await page.locator('#source-correction-results img,#source-correction-results script').count() === 0 && await page.evaluate(() => __sourceCorrectionAudit.xss === 0));
    await preview('teh', 'teh'); await expect(page.locator('#apply-source-correction')).toBeDisabled();
    await preview('', 'anything'); await expect(page.locator('#apply-source-correction')).toBeDisabled();
    await preview('REMOVE_ONLY', ''); await page.locator('#apply-source-correction').click(); await expect(page.locator('#apply-source-correction')).toBeDisabled(); await expect(page.locator('#source-correction-error')).not.toBeEmpty();
    assert.deepEqual(history(await settled()), history(baseline));
    check('literal_case_cue_boundaries_noop_and_empty_cue_guard_' + width, true);
    await preview('REMOVE_ME ', ''); const deleted = expectedCorrection(baseline, 'REMOVE_ME ', ''); await apply(deleted);
    assert.equal((await activeSaved()).segments[238].text, 'Keep content.'); await undo(baseline);
    await preview('👩🏽‍💻', '🧑🏾‍🚀'); const unicode = expectedCorrection(baseline, '👩🏽‍💻', '🧑🏾‍🚀'); await apply(unicode); await undo(baseline);
    await preview('cafe\u0301', 'café ✅'); const combining = expectedCorrection(baseline, 'cafe\u0301', 'café ✅'); await apply(combining); await undo(baseline);
    const dollarFind = '$&/$1/$$/\\path', dollarReplace = '$$ literal $& $1 \\replacement 🥥';
    await preview(dollarFind, dollarReplace); const literal = expectedCorrection(baseline, dollarFind, dollarReplace); await apply(literal); await undo(baseline);
    check('empty_replacement_unicode_dollars_and_backslashes_are_literal_' + width, true);

    stage = 'input invalidation ' + width; await preview('teh', 'the');
    await page.locator('#source-replace').press('End'); await page.locator('#source-replace').pressSequentially(' changed'); await expect(page.locator('#apply-source-correction')).toBeDisabled();
    await page.locator('#preview-source-correction').click(); await expect(page.locator('#apply-source-correction')).toBeEnabled();
    await page.locator('#source-find').press('End'); await page.locator('#source-find').pressSequentially(' absent'); await expect(page.locator('#apply-source-correction')).toBeDisabled();
    await close('button'); assert.deepEqual(history(await settled()), history(baseline));
    check('both_input_changes_invalidate_preview_without_writes_' + width, true);

    stage = 'save receipt and native reload ' + width; await preview('teh', 'the');
    const allChanged = expectedCorrection(baseline, 'teh', 'the'); await hold(); await page.locator('#apply-source-correction').click(); await held();
    assert.deepEqual(history(await activeSaved()), history(baseline));
    check('pending_write_never_claims_saved_' + width, await page.locator('#save-status').getAttribute('data-state') !== 'saved');
    await close(); await preview('REMOVE_ME', 'Keep this newer draft');
    await release(); await saved(allChanged);
    await expect(page.locator('#source-correction-dialog')).toBeVisible(); await expect(page.locator('#source-find')).toHaveValue('REMOVE_ME'); await expect(page.locator('#source-replace')).toHaveValue('Keep this newer draft'); await expect(page.locator('#apply-source-correction')).toBeEnabled();
    check('late_save_receipt_after_Escape_cannot_clear_or_close_new_preview_' + width, true);
    const backup = await download(), payload = JSON.parse(backup.buffer.toString('utf8'));
    assert.deepEqual(history(payload), history(allChanged)); assert.deepEqual(untouched(payload), untouched(baseline));
    const original = page; page = await newPage(width); await choose(backup); await reloadSaved(allChanged);
    assert.deepEqual(history(await activeSaved()), history(allChanged)); assert.deepEqual(untouched(await activeSaved()), untouched(baseline));
    await open(); await expect(page.locator('#undo-source-correction')).toBeHidden(); await page.context().close(); page = original;
    await reloadSaved(allChanged); assert.deepEqual(history(await activeSaved()), history(allChanged)); await open(); await expect(page.locator('#undo-source-correction')).toBeHidden();
    check('real_JSON_download_clean_restore_reload_and_session_only_undo_' + width, true);

    stage = 'failed save and explicit retry ' + width; await preview('the', 'fixed'); const recovered = expectedCorrection(allChanged, 'the', 'fixed');
    await page.evaluate(() => failContentWrites()); await page.locator('#apply-source-correction').click();
    await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'failed'); await open();
    await expect(page.locator('#source-correction-retry')).toBeVisible(); await expect(page.locator('#source-correction-status')).not.toBeEmpty();
    assert.deepEqual(history(await activeSaved()), history(allChanged));
    await tabCircuit('failed_save_' + width); await capture('failed-save-' + width);
    const rescue = await download('#source-correction-export'), rescued = JSON.parse(rescue.buffer.toString('utf8'));
    assert.deepEqual(history(rescued), history(recovered)); assert.deepEqual(untouched(rescued), untouched(baseline));
    const failedPage = page; page = await newPage(width); await choose(rescue); await reloadSaved(recovered);
    assert.deepEqual(history(await activeSaved()), history(recovered)); await page.context().close(); page = failedPage; await page.bringToFront();
    await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'failed');
    check('failed_save_rescue_is_complete_native_JSON_and_clean_context_restorable_' + width, true);
    await page.evaluate(() => restoreContentWrites()); await hold(); await keyboardFocus('#source-correction-retry');
    await recoveryFocus('#source-correction-retry', 'retry_before_activation_' + width, {ariaDisabled: false});
    await page.keyboard.press('Enter'); await held();
    await recoveryFocus('#source-correction-retry', 'retry_pending_receipt_' + width, {ariaDisabled: true});
    // A repeated native activation while pending cannot replay the correction.
    await page.keyboard.press('Enter'); assert.deepEqual(history(await activeSaved()), history(allChanged));
    await release(); await saved(recovered);
    await recoveryFocus('#source-correction-retry', 'retry_saved_receipt_' + width, {ariaDisabled: true}); await capture('retry-focus-saved-' + width);
    const retryWrites = await page.evaluate(() => __sourceCorrectionAudit.writes);
    await page.keyboard.press('Enter'); assert.deepEqual(history(await settled()), history(recovered));
    check('focused_saved_retry_is_inert_without_content_write_' + width, await page.evaluate(() => __sourceCorrectionAudit.writes) === retryWrites);
    await page.keyboard.press('Tab'); await expect(page.locator('#source-correction-retry')).toBeHidden();
    check('focused_retry_survives_pending_and_saved_until_native_focusout_' + width, true);
    await undo(allChanged);

    stage = 'export focus across late save receipt ' + width;
    await preview('the', 'saved with export focus'); const exportChanged = expectedCorrection(allChanged, 'the', 'saved with export focus');
    await hold(); await page.locator('#apply-source-correction').click(); await held(); await keyboardFocus('#source-correction-export');
    await recoveryFocus('#source-correction-export', 'export_pending_receipt_' + width);
    const pendingBackup = await keyboardDownload('#source-correction-export');
    assert.deepEqual(history(JSON.parse(pendingBackup.buffer.toString('utf8'))), history(exportChanged));
    await recoveryFocus('#source-correction-export', 'export_after_native_download_pending_' + width);
    assert.deepEqual(history(await activeSaved()), history(allChanged)); await release(); await saved(exportChanged);
    await recoveryFocus('#source-correction-export', 'export_saved_receipt_' + width); await capture('export-focus-saved-' + width);
    await page.keyboard.press('Tab'); await expect(page.locator('#source-correction-export')).toBeHidden();
    check('focused_export_survives_native_download_and_late_saved_receipt_until_focusout_' + width, true);
    await undo(allChanged); await reloadSaved(allChanged); assert.deepEqual(history(await activeSaved()), history(allChanged));
    check('failed_real_IDB_write_retains_edit_explicit_retry_and_undo_' + width, true);

    stage = 'latest batch and later authored edit ' + width;
    await expect(page.locator('body')).toHaveAttribute('data-reading-mode', 'transcript');
    await expect(page.locator('#reader-options > #reading-settings')).toHaveCount(1);
    check('reload_restores_explicit_transcript_mode_before_settings_journey_' + width, true);
    // Reload preserves the earlier transcript choice. Establish continuous
    // reading explicitly before exercising its settings-modal return path.
    await clickVisibleReaderControl('#mode-passages', 'continuous_reading_before_correction_' + width);
    await expect(page.locator('#mode-passages')).toHaveAttribute('aria-pressed', 'true');
    await preview('REMOVE_ME', 'REPLACED'); const firstBatch = expectedCorrection(allChanged, 'REMOVE_ME', 'REPLACED'); await apply(firstBatch);
    await preview('CUE', 'cue'); const secondBatch = expectedCorrection(firstBatch, 'CUE', 'cue'); await apply(secondBatch);
    await undo(firstBatch); await expect(page.locator('#undo-source-correction')).toBeHidden();
    check('new_batch_replaces_previous_undo_and_only_latest_batch_reverts_' + width, (await activeSaved()).segments[238].text === 'Keep REPLACED content.');
    await preview('CUE', 'cue'); await apply(secondBatch); await close('button');
    // Explicit continuous reading puts correction in its information
    // panel; closing the child modal correctly returns to that still-open panel.
    // Dismiss it through the same visible button a reader uses before reaching
    // the mode tabs behind it. A missing/hidden control remains a hard failure.
    await expect(page.locator('#reading-info-settings > #reading-settings')).toHaveCount(1);
    await expect(page.locator('#reading-info')).toHaveJSProperty('open', true);
    await expect(page.locator('#close-reading-info')).toBeVisible();
    await clickVisibleReaderControl('#close-reading-info', 'close_information_before_transcript_' + width);
    await expect(page.locator('#reading-info')).toHaveJSProperty('open', false);
    await expect(page.locator('#reading-info > summary')).toBeFocused();
    await clickVisibleReaderControl('#mode-transcript', 'transcript_after_information_close_' + width);
    await expect(page.locator('#mode-transcript')).toHaveAttribute('aria-pressed', 'true');
    check('visible_settings_close_allows_normal_transcript_mode_click_' + width, true);
    await capture('settings-closed-transcript-' + width); await openTranscriptTools(page); await page.locator('#search').fill('cue starts here.');
    const row = page.locator('.segment[data-segment-id="source-236"]'); await openCueActions(row); await row.locator('.edit-button').click();
    const later = clone(secondBatch); later.segments[236].text = 'A later authored single-cue edit.';
    await page.locator('#edit-segment').fill(later.segments[236].text); await page.locator('#save-edit').click(); await saved(later);
    await open(); await page.locator('#undo-source-correction').click(); await expect(page.locator('#source-correction-error')).not.toBeEmpty();
    assert.deepEqual(history(await settled()), history(later));
    check('undo_never_overwrites_a_later_single_cue_edit_' + width, true);
    await page.context().close();
  }
  check('no_external_requests_mutations_models_XSS_or_browser_errors', external === 0 && mutations === 0 && xssRequests === 0 && errors.length === 0);
  console.log(JSON.stringify({suite: 'source-corrections', status: 'passed', checks}));
} catch (error) {
  failure = {suite: 'source-corrections', status: 'failed', stage, checks, errors, error: {message: error.message, stack: error.stack}};
  console.error(JSON.stringify(failure)); process.exitCode = 1;
  try {await capture('failure');} catch {}
} finally {
  if (process.env.COCONUT_UI_SCREENSHOTS) {
    await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS, {recursive: true});
    await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS, 'source-corrections-checks.json'), JSON.stringify({...(failure || {suite: 'source-corrections', status: 'passed', checks}), geometry}, null, 2));
  }
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
}
