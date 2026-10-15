// Compatibility renderer regression; this suite is not default React acceptance.
import {navigateReadingStop,navigateReadingTime} from './helpers/transcript-navigation-browser.mjs';
/** CI-only Chromium acceptance for cue + mode resume. Authored sources only.
 * Native IndexedDB, real viewport geometry and keyboard actions are evidence.
 * No media, Electron, CLI, providers, user files or external sites are used.
 * Local node --check validates syntax only; it is not browser proof. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium, expect, waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {readingViewResumeFixture} from './helpers/reading-view-resume-fixture.mjs';

if (process.env.GITHUB_ACTIONS !== 'true') throw Error('Run reading-view resume in GitHub Actions only; local syntax is not browser evidence.');

const root = new URL('../reader/', import.meta.url);
const VIEW = 'coconut-reading-view-v1', DEFAULTS = 'coconut-reading-view-defaults-v1';
const checks = [], geometry = [], screenshots = [], errors = [];
let server, browser, page, stage = 'setup', external = 0, mutations = 0, operationRequests = 0, observing = false;
const check = (name, value) => {assert.ok(value, name); checks.push(name);};
const cueSelector = (doc, index, mode = 'transcript') => mode === 'passages'
  ? '#passage-body .passage-original .passage-cue[data-cue-id="' + doc.segments[index].id + '"]'
  : '#transcript .segment[data-segment-id="' + doc.segments[index].id + '"]';

function installAudit() {
  window.__resumeAudit = {plays: 0, seeks: 0, contentWrites: 0};
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {window.__resumeAudit.plays++; return play.apply(this, args);};
  const time = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {...time,
    set(value) {window.__resumeAudit.seeks++; return time.set.call(this, value);},
  });
  for (const name of ['put', 'add', 'delete', 'clear']) {
    const original = IDBObjectStore.prototype[name];
    IDBObjectStore.prototype[name] = function (...args) {
      if (this.transaction.db.name === 'coconut-reader-library-v1' && this.name === 'documents') window.__resumeAudit.contentWrites++;
      return original.apply(this, args);
    };
  }
}

// Serializable measurements use painted geometry, including the actual sticky
// return bars. A mounted offscreen cue does not satisfy this proof.
function cueGeometry(selector) {
  const node = document.querySelector(selector); if (!node) return null;
  const mode = document.body.dataset.readingMode;
  const edge = [...document.querySelectorAll('#reading-mode-toolbar, #reader-workspace > .reading-context')].reduce((edge, bar) => {
    const r = bar.getBoundingClientRect(), css = getComputedStyle(bar);
    return !bar.hidden && r.height > 0 && r.top <= (parseFloat(css.top) || 0) ? Math.max(edge, r.bottom) : edge;
  }, 0);
  const r = node.getBoundingClientRect();
  const line = [...node.getClientRects()].find(line => line.width > 0 && line.bottom > edge && line.top < innerHeight);
  const sampleY = line && (Math.max(line.top, edge + 1) + Math.min(line.bottom, innerHeight - 1)) / 2;
  const sampleX = line && Math.max(1, Math.min(innerWidth - 1, (line.left + line.right) / 2));
  const hit = line && document.elementFromPoint(sampleX, sampleY);
  const nodes = [...document.querySelectorAll(mode === 'passages' ? '#passage-body .passage-original .passage-cue' : '#transcript .segment')];
  const first = nodes.find(cue => {const box = cue.getBoundingClientRect(); return box.width > 0 && box.bottom > edge && box.top < innerHeight;});
  return {id: node.dataset.cueId || node.dataset.segmentId, mode, rect: r.toJSON(), edge,
    first: first?.dataset.cueId || first?.dataset.segmentId, scrollY,
    focused: document.activeElement === node,
    focusInside: node.contains(document.activeElement),
    hit: !!hit && (hit === node || node.contains(hit)),
    width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth};
}
async function stable(selector) {
  await page.waitForFunction(selector => {
    const node = document.querySelector(selector); if (!node) return false;
    const r = node.getBoundingClientRect(), prior = window.__resumeStable;
    const count = prior?.selector === selector && Math.abs(prior.y - scrollY) < .1 && Math.abs(prior.top - r.top) < .1 ? prior.count + 1 : 0;
    window.__resumeStable = {selector, y: scrollY, top: r.top, count};
    return count >= 4;
  }, selector);
}
async function activate(selector) {
  const node = page.locator(selector);
  await node.waitFor({state: 'visible'});
  // Keep the source visible while an offscreen header/sidebar control takes
  // keyboard focus. The trusted Enter key invokes the actual product handler.
  await node.evaluate(node => node.focus({preventScroll: true}));
  await page.keyboard.press('Enter');
}
async function capture(label) {
  if (!process.env.COCONUT_UI_SCREENSHOTS) return;
  await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS, {recursive: true});
  const filename = 'reading-view-resume-' + label + '.png';
  await page.screenshot({path: path.join(process.env.COCONUT_UI_SCREENSHOTS, filename), animations: 'disabled'});
  screenshots.push(filename);
}
async function expectMode(mode) {
  await expect(page.locator('body')).toHaveAttribute('data-reading-mode', mode);
  await expect(page.locator(mode === 'passages' ? '#passage-workspace' : mode === 'summary' ? '#summary-workspace' : '#transcript-layout')).toBeVisible();
}
async function landed(doc, index, mode, label, {focus = true} = {}) {
  await expectMode(mode);
  const selector = cueSelector(doc, index, mode);
  await stable(selector);
  const result = await page.evaluate(cueGeometry, selector); geometry.push({label, ...result});
  check(label + '_actual_cue_is_visible_above_overlays', result?.id === doc.segments[index].id && result.rect.top < result.height && result.rect.bottom > result.edge && result.hit && result.documentWidth <= result.width);
  if (focus) check(label + '_keyboard_focus_belongs_to_exact_cue', result.focused);
  return result;
}
async function position(doc, index, mode, label) {
  const selector = cueSelector(doc, index, mode);
  await stable(selector);
  const edge = (await page.evaluate(cueGeometry, selector)).edge;
  // A transcript section includes trailing padding and a border. Put its source
  // text at the reading edge so the preceding section is genuinely out of view;
  // the independent first-cue assertion below must still name this exact cue.
  await page.locator(selector).evaluate((node, top) => {
    const source = node.matches('.segment') ? node.querySelector('.words') : node;
    window.scrollBy({top: source.getBoundingClientRect().top - top, left: 0, behavior: 'instant'});
  }, edge + 2);
  const result = await landed(doc, index, mode, label, {focus: false});
  check(label + '_fixture_really_reads_this_cue_first', result.first === doc.segments[index].id);
  return result;
}
async function transcriptAt(doc, index, label) {
  await activate('#mode-bilingual');
  // Navigate with a real existing time stop on this 100-cue page, then scroll
  // to a later source. The old focused time stop must not win over that scroll.
  const stop = await page.locator('#reading-jump').evaluate((select, index) => [...select.options].find(option => {
    const cue = Number(option.value.split('-cue-')[1]); return option.value && Math.floor(cue / 100) === Math.floor(index / 100);
  })?.value, index);
  assert.ok(stop, 'Authored page has a public time-stop control');
  await navigateReadingStop(page,stop);
  return position(doc, index, 'transcript', label);
}
async function passagesAt(doc, index, label) {
  await activate('#mode-passages');
  await navigateReadingTime(page,doc.segments[index].start);
  return position(doc, index, 'passages', label);
}
async function documents() {
  await page.evaluate(() => libraryStore.flush());
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved');
  return page.evaluate(async () => JSON.stringify((await readPersistedLibrary()).documents));
}
async function unchanged(baseline, label) {
  assert.equal(await documents(), baseline, label + ': real IndexedDB documents must remain byte-identical');
  const audit = await page.evaluate(() => window.__resumeAudit);
  check(label + '_no_content_writes_autoplay_or_seeks', audit.contentWrites === 0 && audit.plays === 0 && audit.seeks === 0 && await page.locator('audio,video').count() === 0);
  check(label + '_no_navigation_network_or_provider_requests', operationRequests === 0 && mutations === 0 && external === 0);
}
async function tuple(doc, index, mode, label) {
  const result = await page.evaluate(({view, defaults}) => [sessionStorage.getItem(view), localStorage.getItem(defaults)].map(raw => JSON.parse(raw)), {view: VIEW, defaults: DEFAULTS});
  for (const [indexOfStore, payload] of result.entries()) {
    assert.deepEqual(Object.keys(payload).sort(), ['version', 'views']);
    assert.equal(payload.version, 1); assert.ok(payload.views.length <= 512);
    assert.ok(payload.views.every(row => Array.isArray(row) && row.length === 3 && row.every(value => typeof value === 'string') && ['transcript', 'passages', 'summary'].includes(row[2])));
    assert.deepEqual(payload.views.find(row => row[0] === doc.key), [doc.key, doc.segments[index].id, mode], label + ': ' + (indexOfStore ? 'restart default' : 'window view'));
  }
  check(label + '_bounded_cue_mode_preferences_contain_no_language_or_document_snapshot', true);
}
async function libraryTarget(selector, label) {
  const node = page.locator(selector);
  await node.scrollIntoViewIfNeeded();
  await node.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  const result = await node.evaluate(node => {
    const r = node.getBoundingClientRect(), style = getComputedStyle(node);
    const ring = (parseFloat(style.outlineWidth) || 0) + Math.max(0, parseFloat(style.outlineOffset) || 0);
    const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
    const points = [[x, y], [r.left + 1, y], [r.right - 1, y], [x, r.top + 1], [x, r.bottom - 1]].map(([x, y]) => {
      const hit = document.elementFromPoint(x, y); return !!hit && (hit === node || node.contains(hit));
    });
    return {rect: r.toJSON(), ring, outline: style.outlineStyle, focused: node === document.activeElement,
      focusVisible: node.matches(':focus-visible'), points, width: innerWidth, height: innerHeight, pageWidth: document.documentElement.scrollWidth};
  });
  geometry.push({label, ...result});
  const r = result.rect;
  check(label + '_44px_keyboard_target_and_five_hit_points_visible', result.focused && result.focusVisible && result.outline !== 'none' && result.ring > 0 && r.width >= 44 && r.height >= 44 && r.left >= 0 && r.right <= result.width && r.top >= 0 && r.bottom <= result.height && result.points.every(Boolean) && result.pageWidth <= result.width);
}
async function openDocument(doc, label) {
  if (await page.locator('#library-search-dialog').evaluate(node => node.open)) await activate('#close-library-search');
  const selector = '.library-entry[data-document-key="' + doc.key + '"] .library-open';
  if (await page.evaluate(() => matchMedia('(max-width: 650px)').matches)) {
    if (await page.locator('#toggle-library').getAttribute('aria-expanded') !== 'true') await activate('#toggle-library');
    await libraryTarget(selector, label + '_mobile_library');
    await page.keyboard.press('Enter');
  } else await activate(selector);
  await expect(page.locator('#title')).toHaveText(doc.title);
  await expect(page.locator('#toggle-library')).toHaveAttribute('aria-expanded', 'false');
}
async function reload(doc) {
  const audit = await page.evaluate(() => window.__resumeAudit);
  assert.deepEqual(audit, {plays: 0, seeks: 0, contentWrites: 0}, 'Reload must not discard evidence of earlier automatic media or content work');
  const dialogs = [];
  const onDialog = async dialog => {dialogs.push(dialog.type()); await dialog.dismiss();};
  page.on('dialog', onDialog); observing = false;
  try {await page.reload(); await page.waitForLoadState('networkidle');}
  finally {page.off('dialog', onDialog); observing = true;}
  assert.deepEqual(dialogs, [], 'Reading preferences must not create an unsaved-content warning');
  await expect(page.locator('#title')).toHaveText(doc.title);
}
async function revealOwners(selector) {
  const ids = await page.locator(selector).evaluate(node => {
    const ids = []; for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') ids.unshift(parent.id); return ids;
  });
  for (const id of ids) {
    assert.ok(id, 'Each native disclosure has an accessible stable ID');
    if (!await page.locator('#' + id).evaluate(node => node.open)) await activate('#' + id + ' > summary');
  }
}
async function report(status, error = null) {
  const result = {suite: 'reading-view-resume', status, stage, checks, geometry, screenshots, external, mutations, operationRequests, errors, error};
  if (process.env.COCONUT_UI_SCREENSHOTS) {
    await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS, {recursive: true});
    await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS, 'reading-view-resume-checks.json'), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result));
}

try {
  // Static files only. Even an accidental provider route cannot reach a CLI.
  server = createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) {mutations++; res.writeHead(405).end(); return;}
    const pathname = new URL(req.url, 'http://localhost').pathname, filename = pathname === '/' ? 'compatibility.html' : pathname.slice(1);
    if (!/^[a-z-]+\.(html|js|css|webmanifest|png)$/.test(filename)) {res.writeHead(404, {'Content-Type': 'application/json'}).end('{}'); return;}
    try {
      const body = await fs.readFile(new URL(filename, root));
      res.writeHead(200, {'Content-Type': filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.png') ? 'image/png' : 'text/html'}).end(body);
    } catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true});
  for (const [label, viewport] of [['desktop', {width: 1360, height: 1000}], ['mobile', {width: 320, height: 568}]]) {
    stage = label + '_import'; observing = false;
    const context = await browser.newContext({viewport, serviceWorkers: 'block'});
    await context.addInitScript(installAudit);
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) {mutations++; await route.abort(); return;}
      if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) {if (observing && url.origin === origin) operationRequests++; await route.continue();}
      else {external++; await route.abort();}
    });
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push({label, message: error.message}));
    await page.goto(origin); await page.waitForLoadState('networkidle');
    const [a, b] = readingViewResumeFixture(label);
    await page.locator('#library-file').setInputFiles({name: 'authored-reading-resume.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({format: 'coconut-library', version: 1, active: a.key, documents: [a, b]}))});
    await waitForPersistedLibrary(page, async () => (await readPersistedLibrary()).documents.length === 2);
    await expect(page.locator('#title')).toHaveText(a.title);
    if (await page.locator('#dismiss-notice').isVisible()) await page.locator('#dismiss-notice').click();
    const baseline = await documents();
    check(label + '_production_indexeddb_import_is_really_written', await page.evaluate(() => CoconutStorageBootstrap.result.backend === 'indexeddb' && window.__resumeAudit.contentWrites >= 2));
    await page.evaluate(() => {window.__resumeAudit.contentWrites = 0;}); observing = true;

    stage = label + '_independent_long_document_views';
    await transcriptAt(a, 742, label + '_a_read_742');
    await openDocument(b, label + '_open_b');
    await tuple(a, 742, 'transcript', label + '_a_saved_after_switch');
    await passagesAt(b, 486, label + '_b_read_486');
    await openDocument(a, label + '_return_a');
    await landed(a, 742, 'transcript', label + '_a_ordinary_resume');
    await tuple(b, 486, 'passages', label + '_b_saved_after_switch');
    await capture(label + '-transcript-resumed');
    await openDocument(b, label + '_return_b');
    await landed(b, 486, 'passages', label + '_b_ordinary_resume');
    await reload(b);
    await landed(b, 486, 'passages', label + '_b_reload_resume', {focus: false});
    await capture(label + '-passages-reloaded');
    await openDocument(a, label + '_a_before_reload'); await reload(a);
    await landed(a, 742, 'transcript', label + '_a_reload_resume', {focus: false});
    await position(a, 747, 'transcript', label + '_a_same_page_scroll'); await reload(a);
    await landed(a, 747, 'transcript', label + '_reload_uses_latest_visible_cue_not_old_focus', {focus: false});
    await unchanged(baseline, label + '_ordinary_switches_and_reload');

    stage = label + '_summary_mode';
    await activate('#mode-summary'); await expectMode('summary');
    await openDocument(b, label + '_leave_summary');
    await tuple(a, 747, 'summary', label + '_summary_remembers_source_anchor');
    await openDocument(a, label + '_return_summary'); await expectMode('summary'); await reload(a); await expectMode('summary');
    check(label + '_summary_reopens_without_generating_any_answer', (await page.locator('#summary-body').textContent()).trim() === '');
    await unchanged(baseline, label + '_summary_restore');

    stage = label + '_explicit_bookmark_and_goto';
    await transcriptAt(a, 742, label + '_before_explicit_bookmark');
    await activate('#resume'); await landed(a, 19, 'transcript', label + '_manual_bookmark_wins');
    await navigateReadingStop(page,a.segments[999].id);
    await landed(a, 999, 'transcript', label + '_explicit_goto_wins');

    stage = label + '_chapter_and_return';
    await transcriptAt(a, 742, label + '_before_chapter');
    await revealOwners('#open-chapters');
    const chapterOrigin = await position(a, 742, 'transcript', label + '_chapter_origin');
    await activate('#open-chapters');
    await page.locator('.chapter-entry[data-chapter-id="late-A"] .chapter-open').click();
    await landed(a, 840, 'transcript', label + '_chapter_destination_wins');
    await activate('#return-from-chapter');
    const chapterReturn = await landed(a, 742, 'transcript', label + '_chapter_return_wins');
    check(label + '_chapter_return_retains_measured_viewport', Math.abs(chapterReturn.rect.top - chapterOrigin.rect.top) < 3);

    stage = label + '_search_and_return';
    await position(a, 742, 'transcript', label + '_search_origin');
    await page.locator(cueSelector(a, 742)).evaluate(node => node.focus({preventScroll: true}));
    await page.keyboard.press('Control+f');
    await expect(page.locator('#search')).toBeFocused();
    await page.locator('#search').fill('Authored A source 917.');
    await expect(page.locator('#transcript .segment')).toHaveCount(1);
    await activate('#next-match'); await landed(a, 917, 'transcript', label + '_search_destination_wins');
    await activate('#return-before-search'); await landed(a, 742, 'transcript', label + '_search_return_wins');
    await unchanged(baseline, label + '_explicit_routes_preserve_manual_bookmarks_and_all_content');

    stage = label + '_cross_document_exact_search';
    await activate('#open-library-search');
    await page.locator('#library-scope').selectOption('text');
    await page.locator('#library-search').fill('Authored B source 905.');
    await expect(page.locator('.library-hit')).toHaveCount(1);
    await libraryTarget('.library-hit', label + '_exact_library_hit'); await page.keyboard.press('Enter');
    await expect(page.locator('#title')).toHaveText(b.title);
    await landed(b, 905, 'transcript', label + '_library_result_overrides_remembered_passage486');
    await activate('#return-library-search');
    await expect(page.locator('#library-search-dialog')).toBeVisible();
    await expect(page.locator('.library-hit')).toBeFocused();
    await page.locator('#library-search').fill(''); await page.locator('#library-scope').selectOption('title');
    await activate('#close-library-search');
    await landed(b, 905, 'transcript', label + '_library_return_does_not_restore_stale_saved_view', {focus: false});
    await unchanged(baseline, label + '_explicit_cross_document_search');

    stage = label + '_display_language_keeps_existing_ownership';
    await passagesAt(b, 486, label + '_language_origin');
    await page.locator('#translation-view').selectOption('fr');
    await waitForPersistedLibrary(page, async key => (await readPersistedLibrary()).documents.find(doc => doc.key === key)?.translation_view === 'fr', b.key);
    const french = await documents(); await page.evaluate(() => {window.__resumeAudit.contentWrites = 0;});
    await openDocument(a, label + '_leave_french'); await openDocument(b, label + '_return_french');
    await expect(page.locator('#translation-view')).toHaveValue('fr');
    await unchanged(french, label + '_resume_uses_live_saved_language');
    await page.locator('#translation-view').selectOption('');
    await expect(page.locator('.passage-translation')).toHaveCount(0);
    const sourceOnly = await documents(); await page.evaluate(() => {window.__resumeAudit.contentWrites = 0;});
    await openDocument(a, label + '_leave_source_only'); await openDocument(b, label + '_return_source_only');
    await expectMode('passages');
    await expect(page.locator('#translation-view')).toHaveValue('zh');
    await expect(page.locator('.passage-translation').first()).toHaveAttribute('lang', 'zh');
    await reload(b);
    await expect(page.locator('#translation-view')).toHaveValue('zh');
    await unchanged(sourceOnly, label + '_page_local_source_only_still_resets_without_persisting_fallback');
    const expected = JSON.parse(baseline); expected.find(doc => doc.key === b.key).translation_view = '';
    assert.deepEqual(JSON.parse(sourceOnly), expected, 'Only the explicitly selected display language may change document data');
    await tuple(b, 486, 'passages', label + '_language_never_enters_view_snapshot');
    check(label + '_manual_reading_positions_remain_independent', JSON.parse(sourceOnly).every(doc => doc.readingPosition === doc.segments[19].id));
    await context.close(); page = null; observing = false;
  }
  check('no_browser_errors_external_requests_unexpected_network_or_writes', errors.length === 0 && external === 0 && mutations === 0 && operationRequests === 0);
  await report('passed');
} catch (error) {
  if (page && !page.isClosed()) await capture('failure-' + stage).catch(() => {});
  await report('failed', {message: error.message, stack: error.stack}); process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise(resolve => server?.listening ? server.close(resolve) : resolve());
}
