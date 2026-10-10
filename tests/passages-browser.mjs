/** Real Chromium acceptance for skim → continuous reading → listen once.
 * CI runs only authored text, authored translations and a generated tone WAV.
 * No provider, CLI, external API, recording, model or user quota is used. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
import {passageReadingFixture, irregularPassageFixture} from './helpers/passage-reading-fixture.mjs';
import {openCueActions} from './cue-actions-browser.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const checks = [], geometry = [];
let browser, server, directory, activePage, stage = 'setup', external = 0, mutations = 0;
const browserErrors = [];
function check(name, value) {stage = name; assert.ok(value, name); checks.push(name);}
async function settled(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function capture(page, name) {
  if (!process.env.COCONUT_UI_SCREENSHOTS) return;
  await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS, {recursive: true});
  // Preserve the real user-action viewport. Never scroll, hide or resize layout.
  await page.screenshot({path: path.join(process.env.COCONUT_UI_SCREENSHOTS, 'passages-' + name + '.png'), fullPage: false, animations: 'disabled'});
}
async function importFixture(page, fixture, name = 'authored-fragmented-reading.json') {
  await page.locator('#file').setInputFiles({name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture))});
  await page.waitForFunction(title => document.querySelector('#title').textContent === title && !document.querySelector('#passage-workspace').hidden, fixture.title);
  await settled(page);
}
async function stored(page) {
  return page.evaluate(() => {const shelf = JSON.parse(localStorage.getItem('coconut-reader-v1')); return shelf.documents.find(doc => doc.key === shelf.active);});
}
async function attachAudio(page, filename) {
  const previousSource = await page.locator('#source-media audio').count() ? await page.locator('#source-media audio').getAttribute('src') : null;
  if (!await page.locator('#attach-reader-media').isVisible()) await page.locator('#toggle-reader-media').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#attach-reader-media').click()]);
  await chooser.setFiles(filename);
  await page.waitForFunction(previous => {const audio = document.querySelector('#source-media audio'); return audio && audio.getAttribute('src') !== previous && !audio.error && audio.readyState >= 2 && audio.duration >= 179;}, previousSource);
}
async function passageGeometry(page, label) {
  const result = await page.locator('#passage-body .passage').first().evaluate(passage => {
    const rect = node => {const r = node.getBoundingClientRect(); return {top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width};};
    const source = passage.querySelector('.passage-original'), translation = passage.querySelector('.passage-translation');
    return {viewport: {width: innerWidth, height: innerHeight}, scrollY,
      documentWidth: document.documentElement.scrollWidth, passage: rect(passage),
      source: rect(source), translation: translation ? rect(translation) : null,
      sourceIds: [...source.querySelectorAll('.passage-cue')].map(cue => cue.dataset.cueId),
      sourceText: source.textContent, translationText: translation?.textContent || '',
      chrome: {brand: rect(document.querySelector('.brand')), library: rect(document.querySelector('#toggle-library')), add: rect(document.querySelector('#add-content')), notice: rect(document.querySelector('#notice'))}};
  });
  geometry.push({label, ...result});
  console.log(JSON.stringify({suite: 'passage-viewport', label, ...result}));
  return result;
}
function completeFirstViewport(label, view, fixture) {
  const visible = rect => rect && rect.width > 0 && rect.height > 0 && rect.top >= -1 && rect.bottom <= view.viewport.height && rect.left >= 0 && rect.right <= view.viewport.width;
  check(label + '_first_viewport_contains_complete_source_expression', view.sourceIds.slice(0, 4).join(',') === 'split-0,split-1,split-2,split-3' && view.sourceText.includes(fixture.segments.slice(0, 4).map(cue => cue.text).join(' ')) && visible(view.source));
  check(label + '_first_viewport_contains_joined_valid_translation', view.translationText.includes(fixture.segments.slice(0, 4).map(cue => cue.translations.zh.text).join('')) && visible(view.translation));
  check(label + '_has_no_horizontal_overflow', view.documentWidth <= view.viewport.width);
}

try {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coconut-passages-'));
  const audioPath = path.join(directory, 'authored-tone.wav');
  await fs.writeFile(audioPath, authoredAudioFixture());
  server = createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) {mutations++; res.writeHead(405).end(); return;}
    const pathname = new URL(req.url, 'http://localhost').pathname, name = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!/^[a-z-]+\.(html|js|css|png|webmanifest)$/.test(name)) {res.writeHead(404, {'Content-Type': 'application/json'}).end('{"error":"authored static fixture only"}'); return;}
    try {
      const bytes = await fs.readFile(path.join(root, 'reader', name));
      res.writeHead(200, {'Content-Type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'text/html'}).end(bytes);
    } catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true, ...(process.env.COCONUT_CHROMIUM_EXECUTABLE ? {executablePath: process.env.COCONUT_CHROMIUM_EXECUTABLE} : {})});
  async function freshPage(viewport) {
    const context = await browser.newContext({viewport, serviceWorkers: 'block'});
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) {mutations++; await route.abort(); return;}
      if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) await route.continue();
      else {external++; await route.abort();}
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000); page.on('pageerror', error => browserErrors.push(error.message));
    await page.goto(origin); activePage = page;
    return page;
  }
  const fixture = passageReadingFixture();
  for (const [label, viewport] of [['desktop', {width: 1360, height: 1000}], ['mobile', {width: 390, height: 844}]]) {
    stage = label + '_import';
    const page = await freshPage(viewport);
    await importFixture(page, fixture);
    check(label + '_long_fragmented_document_defaults_to_continuous_reading', await page.locator('#mode-passages').getAttribute('aria-pressed') === 'true' && await page.locator('#passage-body .passage').count() <= 8);
    const imported = await passageGeometry(page, label + '-import');
    await capture(page, '01-' + label + '-first-expression');
    completeFirstViewport(label + '_import', imported, fixture);
    if (label === 'mobile') {
      const {brand, library, add} = imported.chrome;
      check('mobile_reader_navigation_stays_on_one_row_with_full_touch_targets', Math.abs(brand.top-library.top) <= 1 && Math.abs(library.top-add.top) <= 1 && library.height >= 44 && library.width >= 44 && add.height >= 44 && add.width >= 44);
      check('mobile_success_status_keeps_complete_import_and_privacy_message', await page.locator('#notice').getAttribute('data-kind') === 'success' && await page.locator('#notice').textContent() === '已导入并保存在本机浏览器。没有向服务器上传文件。');
    }
    check(label + '_passage_joins_original_cues_without_rewriting', await page.locator('.passage-original .passage-cue').evaluateAll(nodes => nodes.map(node => ({id: node.dataset.cueId, text: node.textContent}))).then(cues => cues.every(cue => fixture.segments.find(source => source.id === cue.id)?.text === cue.text)));
    check(label + '_missing_and_stale_translation_are_explicit', await page.locator('.passage-translation-gap[data-cue-id="split-8"][data-state="stale"]').count() === 1 && await page.locator('.passage-translation-gap[data-cue-id="split-10"][data-state="missing"]').count() === 1 && !(await page.locator('.passage-translation').allTextContents()).join('').includes('这句旧译文不应混进连贯译文'));
    check(label + '_reading_does_not_change_original_bookmark_or_existing_note', (await stored(page)).readingPosition === 'split-19' && (await stored(page)).notes['split-2'] === fixture.notes['split-2']);
    await page.locator('#mode-summary').click();
    check(label + '_skim_uses_actual_source', (await page.locator('.overview-segment').first().getAttribute('data-cue-id')) === 'split-0' && (await page.locator('.overview-segment').first().textContent()).includes(fixture.segments[0].text));
    await page.locator('.overview-segment').first().click(); await settled(page);
    const skimmed = await passageGeometry(page, label + '-skim-to-reading');
    await capture(page, '02-' + label + '-skim-to-reading');
    completeFirstViewport(label + '_skim', skimmed, fixture);
    const passage = page.locator('.passage[data-first-cue-id="split-0"]');
    // Record the actual pointerdown position after normal click auto-scrolling.
    // Return must restore the user's observed anchor without any test repair.
    await passage.locator('.passage-details').evaluate(button => button.addEventListener('pointerdown', () => {
      const row = button.closest('.passage'); window.__passageReturnAnchor = {id: row.dataset.passageId, top: row.getBoundingClientRect().top, scrollY};
    }, {once: true, capture: true}));
    await passage.locator('.passage-details').click();
    check(label + '_details_open_exact_original_cue_ids', await page.locator('#passage-return-bar').isVisible() && await page.locator('.segment[data-segment-id="split-0"]').count() === 1 && await page.locator('.segment[data-segment-id="split-2"] .saved-note').textContent() === fixture.notes['split-2']);
    const cue = page.locator('.segment[data-segment-id="split-1"]');
    await cue.locator('.note-button').click(); await page.locator('#note').fill('保留在原始 cue ID 上的 ' + label + ' 笔记。'); await page.locator('#close-note').click();
    await openCueActions(cue); await cue.locator('.bookmark-button').click();
    await cue.locator('.edit-button').click(); await page.locator('#edit-segment').fill('but we had initially left out'); await page.locator('#save-edit').click();
    check(label + '_detail_correction_marks_translation_stale', await cue.locator('.translation.stale').count() === 1);
    await page.locator('#return-to-passages').click(); await settled(page);
    const returned = await page.evaluate(() => {const before = window.__passageReturnAnchor, passage = document.querySelector('.passage[data-passage-id="' + before.id + '"]'); return {before, top: passage?.getBoundingClientRect().top, focusInside: passage?.contains(document.activeElement)};});
    geometry.push({label: label + '-details-return', ...returned});
    await capture(page, '03-' + label + '-details-return');
    check(label + '_details_return_restores_same_passage_and_viewport', Number.isFinite(returned.top) && Math.abs(returned.top - returned.before.top) <= 3 && returned.focusInside);
    check(label + '_edited_original_and_translation_gap_return_to_passage', await passage.locator('.passage-original .passage-cue[data-cue-id="split-1"]').textContent() === 'but we had initially left out' && await passage.locator('.passage-translation-gap[data-cue-id="split-1"][data-state="stale"]').count() === 1);
    const saved = await stored(page);
    check(label + '_all_original_ids_notes_excerpt_and_bookmark_survive', saved.segments.length === 1771 && saved.segments.every((cue, i) => cue.id === fixture.segments[i].id && cue.start === fixture.segments[i].start && cue.end === fixture.segments[i].end) && saved.notes['split-1'].includes(label) && saved.notes['split-2'] === fixture.notes['split-2'] && saved.segments[4].saved_excerpt === true && saved.readingPosition === 'split-1');
    await page.reload(); await page.locator('#passage-workspace').waitFor({state: 'visible'});
    check(label + '_reload_keeps_original_cue_work_without_media_or_autoplay', (await stored(page)).notes['split-1'] === saved.notes['split-1'] && (await stored(page)).readingPosition === 'split-1' && await page.locator('audio,video').count() === 0);
    await page.context().close();
  }

  stage = 'temporal_skim_with_saved_summary';
  const page = await freshPage({width: 1360, height: 1000});
  const irregular = irregularPassageFixture();
  await importFixture(page, irregular, 'authored-irregular-timeline.json');
  await page.locator('#mode-summary').click();
  check('saved_summary_and_source_skim_are_both_available', await page.locator('#summary-body').textContent() === irregular.ai_answers[0].answer && await page.locator('#source-overview').isVisible() && await page.locator('.overview-segment').count() > 0);
  const stops = await page.locator('.overview-segment').evaluateAll(nodes => nodes.map(node => node.dataset.cueId));
  check('source_skim_covers_actual_late_timestamps_not_only_dense_early_cues', stops.some(id => irregular.segments.find(cue => cue.id === id)?.start >= 1200 && irregular.segments.find(cue => cue.id === id)?.start < 3600) && stops.includes('split-35'));
  await page.locator('.overview-segment[data-cue-id="split-35"]').click();
  check('last_skim_stop_opens_its_exact_original_passage', await page.locator('.passage-original .passage-cue[data-cue-id="split-35"]').count() === 1);
  const slider = page.locator('#passage-time-range');
  check('passage_timeline_uses_actual_document_duration', Number(await slider.getAttribute('max')) >= 3600);
  await slider.focus(); await page.keyboard.press('Home'); await slider.focus(); await page.keyboard.press('End');
  await page.waitForFunction(() => !!document.querySelector('.passage-original .passage-cue[data-cue-id="split-35"]'));
  check('keyboard_timeline_end_reaches_real_end_without_autoplay', await page.locator('audio,video').count() === 0);
  await capture(page, '04-temporal-source-map');
  const sourceOnly = {...fixture, title: '只有原文的完整阅读 · 自写验证', translation_view: '',
    segments: fixture.segments.map(({translations, ...cue}) => cue)};
  await importFixture(page, sourceOnly, 'authored-source-only.json');
  check('source_only_passages_do_not_invent_translation', await page.locator('.passage-original .passage-cue').count() > 4 && await page.locator('.passage-translation').count() === 0 && await page.locator('#passage-toggle-translation').isHidden());

  stage = 'bounded_audio_preview';
  await importFixture(page, fixture);
  await attachAudio(page, audioPath);
  check('decoded_local_media_has_no_initial_autoplay', await page.locator('audio').evaluate(player => player.paused && player.currentTime === 0));
  // Use the existing native player to establish an ordinary transport position.
  await page.locator('audio').evaluate(player => {player.currentTime = 30; window.__passagePlayer = player;});
  await page.waitForFunction(() => Math.abs(document.querySelector('audio').currentTime - 30) < .1);
  const firstPassage = page.locator('.passage[data-first-cue-id="split-0"]');
  const firstIds = await firstPassage.locator('.passage-original .passage-cue').evaluateAll(nodes => nodes.map(node => node.dataset.cueId));
  const range = {start: Math.min(...firstIds.map(id => fixture.segments.find(cue => cue.id === id).start)), end: Math.max(...firstIds.map(id => fixture.segments.find(cue => cue.id === id).end))};
  await firstPassage.locator('.passage-listen').click();
  await page.waitForFunction(range => {const player = document.querySelector('audio'); return !player.paused && player.currentTime >= range.start && player.currentTime < range.end;}, range);
  check('listen_once_uses_the_same_decoded_source_player', await page.evaluate(() => document.querySelectorAll('audio,video').length === 1 && document.querySelector('audio') === window.__passagePlayer));
  await page.waitForFunction(range => {const player = document.querySelector('audio'); return player.paused && Math.abs(player.currentTime - range.end) < .15;}, range, {timeout: 15000});
  check('listen_once_stops_at_exact_passage_end', true);
  const stoppedTime = await page.locator('audio').evaluate(player => player.currentTime);
  await page.waitForTimeout(350);
  check('finished_preview_stays_paused_instead_of_advancing', await page.locator('audio').evaluate((player, time) => player.paused && Math.abs(player.currentTime - time) < .02, stoppedTime));
  await capture(page, '05-listen-once-finished');
  await page.locator('#passage-replay').click();
  await page.waitForFunction(range => {const player = document.querySelector('audio'); return !player.paused && player.currentTime >= range.start && player.currentTime < range.end;}, range);
  check('replay_explicitly_restarts_only_this_passage', true);
  await page.locator('#passage-return-playback').click();
  await page.waitForFunction(() => {const player = document.querySelector('audio'); return player.paused && Math.abs(player.currentTime - 30) < .1;});
  check('return_restores_pre_preview_position_and_paused_state', true);
  await firstPassage.locator('.passage-listen').click();
  await page.waitForFunction(range => {const player = document.querySelector('audio'); return player.paused && Math.abs(player.currentTime - range.end) < .15;}, range, {timeout: 15000});
  await page.locator('#passage-continue').click();
  await page.waitForFunction(end => {const player = document.querySelector('audio'); return !player.paused && player.currentTime > end + .15;}, range.end);
  check('explicit_continue_releases_the_passage_boundary', true);
  await page.locator('audio').evaluate(player => player.pause());
  await page.setViewportSize({width: 390, height: 844});
  await firstPassage.locator('.passage-listen').click();
  await page.waitForFunction(range => {const player = document.querySelector('audio'); return player.paused && Math.abs(player.currentTime - range.end) < .15;}, range, {timeout: 15000});
  const controls = await page.locator('#passage-playback-controls').evaluate(node => ({viewport: {width: innerWidth, height: innerHeight}, rect: node.getBoundingClientRect().toJSON(), buttons: [...node.querySelectorAll('button')].filter(button => !button.hidden).map(button => ({id: button.id, rect: button.getBoundingClientRect().toJSON()})), width: document.documentElement.scrollWidth}));
  geometry.push({label: 'mobile-listening-controls', ...controls});
  await capture(page, '06-mobile-listen-once');
  check('mobile_finished_preview_has_operable_return_replay_continue', controls.width <= controls.viewport.width && ['passage-replay', 'passage-continue', 'passage-return-playback'].every(id => controls.buttons.some(button => button.id === id && button.rect.width >= 44 && button.rect.height >= 44 && button.rect.top >= 0 && button.rect.bottom <= controls.viewport.height && button.rect.left >= 0 && button.rect.right <= controls.viewport.width)));
  await page.locator('#passage-replay').click();
  await page.waitForFunction(() => !document.querySelector('audio').paused);
  await attachAudio(page, audioPath);
  check('media_replacement_cancels_previous_range_and_cannot_autoplay', await page.evaluate(() => window.__passagePlayer.paused && document.querySelector('audio') !== window.__passagePlayer && document.querySelector('audio').paused && document.querySelector('audio').currentTime === 0) && await page.locator('#passage-playback-controls').isHidden());
  await firstPassage.locator('.passage-listen').click(); await page.waitForFunction(() => !document.querySelector('audio').paused);
  await page.locator('audio').evaluate(player => {window.__replacedDocumentPlayer = player;});
  await importFixture(page, irregular, 'authored-replacement-document.json');
  check('document_replacement_cancels_old_playback_and_return_target', await page.evaluate(() => window.__replacedDocumentPlayer.paused && [...document.querySelectorAll('audio,video')].every(player => player.paused)) && await page.locator('#passage-playback-controls').isHidden());
  check('passage_journey_has_no_upload_model_external_requests_or_browser_errors', external === 0 && mutations === 0 && browserErrors.length === 0 && await page.evaluate(() => !localStorage.getItem('coconut-reader-v1').includes('blob:')));
  console.log(JSON.stringify({suite: 'authored-passage-reading-listen-once', status: 'passed', checks, geometry}));
} catch (error) {
  if (activePage && !activePage.isClosed()) await capture(activePage, 'failure-' + stage).catch(() => {});
  console.log(JSON.stringify({suite: 'authored-passage-reading-listen-once', status: 'failed', stage, message: error.message, browserErrors, checks, geometry}));
  process.exitCode = 1;
} finally {
  if (process.env.COCONUT_UI_SCREENSHOTS && geometry.length) {
    await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS, {recursive: true});
    await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS, 'passages-geometry.json'), JSON.stringify({checks, geometry, stage}, null, 2));
  }
  await browser?.close();
  await new Promise(resolve => server?.listening ? server.close(resolve) : resolve());
  if (directory) await fs.rm(directory, {recursive: true, force: true});
}
