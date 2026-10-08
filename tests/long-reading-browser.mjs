import {openCueActions} from './cue-actions-browser.mjs';
/** Real Chromium acceptance of authored long-text reading and recovery.
 * No model, media, third-party text, or external network calls are used.
 * Run in CI or an explicitly permitted browser environment. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {longReadingFixture} from './helpers/long-reading-fixture.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
let server, browser, temporary, stage = 'setup';
const checks = [];
function check(name, passed) {stage = name; assert.ok(passed, name); checks.push(name);}
async function frameSettled(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function capture(page, name) {
  if (!process.env.COCONUT_UI_SCREENSHOTS) return;
  await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS, {recursive: true});
  await page.screenshot({path: path.join(process.env.COCONUT_UI_SCREENSHOTS, 'long-' + name + '.png'), fullPage: false});
}
async function visibleCue(page, id) {
  await page.waitForFunction(id => {
    const element = [...document.querySelectorAll('#transcript .segment')].find(row => row.dataset.segmentId === id);
    if (!element || element !== document.activeElement) return false;
    const r = element.getBoundingClientRect();
    const previous = window.__longReadingAuditPosition;
    const stable = previous?.id === id && Math.abs(previous.top - r.top) < 0.25 ? previous.stable + 1 : 0;
    window.__longReadingAuditPosition = {id, top: r.top, stable};
    return stable >= 4 && r.top < innerHeight && r.bottom > 0;
  }, id);
}
async function jumpToTime(page, seconds) {
  await page.locator('#reading-settings').evaluate(el => {el.open = true;});
  await page.locator('#reading-time').fill(String(seconds));
  await page.locator('#time-navigation button').click();
}
try {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'coconut-long-reading-'));
  server = createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {res.writeHead(405).end(); return;}
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!/^[a-z-]+\.(html|js|css|webmanifest|png)$/.test(name)) {res.writeHead(404).end(); return;}
    try {
      const bytes = await fs.readFile(path.join(root, 'reader', name));
      const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'text/html';
      res.writeHead(200, {'Content-Type': type}).end(bytes);
    } catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true, ...(process.env.COCONUT_CHROMIUM_EXECUTABLE ? {executablePath: process.env.COCONUT_CHROMIUM_EXECUTABLE} : {})});
  let external = 0, mutations = 0, errors = 0;
  async function context() {
    const context = await browser.newContext({acceptDownloads: true, viewport: {width: 1360, height: 1000}, serviceWorkers: 'block'});
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) {mutations++; await route.abort(); return;}
      if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) await route.continue();
      else {external++; await route.abort();}
    });
    return context;
  }
  const first = await context(), page = await first.newPage();
  page.setDefaultTimeout(15000); page.on('pageerror', () => errors++);
  await page.goto(origin);
  const fixture = longReadingFixture();
  await page.locator('#file').setInputFiles({name: 'authored-long-reading.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture))});
  await page.locator('#mode-bilingual').click();
  check('long_import_is_bounded_to_100_visible_cues', await page.locator('#transcript .segment').count() === 100);
  await page.locator('#search').fill('Harbor notebook'); await page.locator('#previous-match').click();
  await visibleCue(page, 'harbor-1770');
  check('last_search_result_is_actually_in_view', await page.locator('#transcript .segment').count() === 71);
  await capture(page, '01-last-search-desktop');
  await page.locator('#next-match').click(); await visibleCue(page, 'harbor-0');
  check('search_wraps_to_first_cue_in_view', true);
  await page.locator('#search').fill('远方灯塔'); await page.locator('#next-match').click(); await visibleCue(page, 'harbor-1668');
  check('translation_only_search_targets_correct_original_cue', await page.locator('#transcript .segment').count() === 1);
  await page.locator('#mode-transcript').click();
  check('source_mode_retains_translation_search_result', await page.locator('.segment[data-segment-id="harbor-1668"]').count() === 1 && await page.locator('.translation').count() === 0);
  await page.locator('#mode-bilingual').click();
  await page.locator('#clear-search').click();
  await jumpToTime(page, 1754 * 4); await visibleCue(page, 'harbor-1754');
  check('variable_height_cue_can_be_reached_on_desktop', true);
  await page.setViewportSize({width: 390, height: 844}); await frameSettled(page);
  check('mobile_long_bilingual_has_no_horizontal_overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await jumpToTime(page, 1754 * 4); await visibleCue(page, 'harbor-1754');
  // A tall cue can exceed the entire viewport: navigation must reveal its beginning.
  const tallCueStartVisible = await page.locator('.segment[data-segment-id="harbor-1754"] .words').evaluate(el => {
    const r = el.getBoundingClientRect(); return r.top >= -2 && r.top < innerHeight * 0.75;
  });
  await capture(page, '02-tall-cue-mobile');
  await page.locator('#search').fill('Harbor notebook 1755.'); await page.locator('#next-match').click();
  await visibleCue(page, 'harbor-1754');
  check('mobile_tall_search_result_reveals_start_of_source', await page.locator('.segment[data-segment-id="harbor-1754"] .words').evaluate(el => {
    const r = el.getBoundingClientRect(); return r.top >= -2 && r.top < innerHeight * 0.75;
  }));
  await page.locator('#reading-jump').selectOption('harbor-1770'); await visibleCue(page, 'harbor-1770');
  const last = page.locator('.segment[data-segment-id="harbor-1770"]');
  await last.locator('.note-button').click();
  await page.locator('#note').fill('A closing note in my own words.\n末段笔记完整保留。');
  check('mobile_note_fits_without_horizontal_overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await capture(page, '03-last-note-mobile'); await page.locator('#close-note').click();
  check('closing_note_returns_keyboard_to_its_cue', await last.locator('.note-button').evaluate(el => el === document.activeElement));
  await openCueActions(last);await last.locator('.excerpt-button').click();
  await last.locator('.bookmark-button').focus(); await page.keyboard.press('Enter');
  check('bookmark_keeps_keyboard_focus_on_last_cue', await last.locator('.bookmark-button').evaluate(el => el === document.activeElement));
  await last.locator('.edit-button').click(); await page.locator('#edit-segment').fill('Corrected closing thought, retained with the original.'); await page.locator('#save-edit').click();
  check('correction_marks_previous_translation_stale', await last.locator('.translation.stale').count() === 1);
  await page.setViewportSize({width: 1360, height: 1000}); await frameSettled(page);
  await page.locator('#export-menu > summary').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export').click()]);
  const backup = path.join(temporary, 'authored-long-reading.coconut.json'); await download.saveAs(backup);
  const exported = JSON.parse(await fs.readFile(backup, 'utf8'));
  check('download_contains_all_1771_cues_and_reading_work', exported.segments.length === 1771 && exported.readingPosition === 'harbor-1770' && exported.segments.at(-1).saved_excerpt === true && exported.notes['harbor-1770'].includes('末段笔记') && exported.segments.at(-1).original_text === fixture.segments.at(-1).text);
  await page.reload(); await page.locator('#mode-bilingual').click(); await page.locator('#resume').click(); await visibleCue(page, 'harbor-1770');
  check('reload_can_resume_last_cue_with_note', (await last.locator('.saved-note').textContent()).includes('末段笔记'));
  await capture(page, '04-restored-desktop');
  const fresh = await context(), restored = await fresh.newPage(); restored.setDefaultTimeout(15000); restored.on('pageerror', () => errors++);
  await restored.goto(origin); await restored.locator('#file').setInputFiles(backup); await restored.locator('#mode-bilingual').click(); await restored.locator('#resume').click(); await visibleCue(restored, 'harbor-1770');
  check('clean_browser_reimport_restores_last_cue_note_and_excerpt', (await restored.locator('.segment[data-segment-id="harbor-1770"] .saved-note').textContent()).includes('末段笔记') && await restored.locator('.segment[data-segment-id="harbor-1770"] .excerpt-button').getAttribute('aria-pressed') === 'true');
  check('long_reading_has_zero_network_mutations_external_requests_or_errors', external === 0 && mutations === 0 && errors === 0);
  check('mobile_tall_cue_jump_reveals_start_of_source', tallCueStartVisible);
  console.log(JSON.stringify({suite: 'authored-long-reading', status: 'passed', checks}));
} catch (error) {
  console.log(JSON.stringify({suite: 'authored-long-reading', status: 'failed', stage, message: error.message, checks})); process.exitCode = 1;
} finally {
  await browser?.close(); await new Promise(resolve => server?.listening ? server.close(resolve) : resolve());
  if (temporary) await fs.rm(temporary, {recursive: true, force: true});
}
