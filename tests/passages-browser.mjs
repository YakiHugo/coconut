/** Real Chromium acceptance for skim → continuous reading → listen once.
 * CI runs only authored text, authored translations and a generated tone WAV.
 * No provider, CLI, external API, recording, model or user quota is used. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, expect} from '@playwright/test';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
import {passageReadingFixture, irregularPassageFixture} from './helpers/passage-reading-fixture.mjs';
import {openCueActions} from './cue-actions-browser.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const checks = [], geometry = [];
const FIRST_SOURCE_MAX_Y = 350;
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
async function feedbackState(page, label) {
  const state = await page.evaluate(() => ({
    paused: document.querySelector('audio')?.paused,
    mediaTime: document.querySelector('audio')?.currentTime,
    previewState: document.querySelector('#passage-playback-controls')?.dataset.state,
    feedbackDisplay: getComputedStyle(document.querySelector('#reading-feedback')).display,
    noteHidden: document.querySelector('#notes-panel')?.hidden,
    noticeKind: document.querySelector('#notice')?.dataset.kind,
    noticeHidden: document.querySelector('#notice')?.hidden,
    noticeText: document.querySelector('#notice')?.textContent,
  }));
  geometry.push({label, ...state});
  console.log(JSON.stringify({suite: 'compact-feedback-state', label, ...state}));
  return state;
}
async function importFixture(page, fixture, name = 'authored-fragmented-reading.json') {
  await page.locator('#file').setInputFiles({name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture))});
  await page.waitForFunction(title => document.querySelector('#title').textContent === title && !document.querySelector('#passage-workspace').hidden, fixture.title);
  await settled(page);
}
async function stored(page) {

 await page.evaluate(()=>libraryStore.flush());
  return page.evaluate(() => {const shelf = JSON.parse(localStorage.getItem('coconut-reader-v1')); return shelf.documents.find(doc => doc.key === sessionStorage.getItem('coconut-reader-active-v1'));});
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
      sourceFontSize: Number.parseFloat(getComputedStyle(source).fontSize), translationFontSize: translation ? Number.parseFloat(getComputedStyle(translation).fontSize) : null,
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
  check(label + '_body_copy_keeps_readable_type_size', view.sourceFontSize >= 17 && view.translationFontSize >= 17);
  check(label + '_reading_starts_within_first_350_pixels', view.source.top >= -1 && view.source.top <= FIRST_SOURCE_MAX_Y);
  check(label + '_first_viewport_contains_complete_source_expression', view.sourceIds.slice(0, 4).join(',') === 'split-0,split-1,split-2,split-3' && view.sourceText.includes(fixture.segments.slice(0, 4).map(cue => cue.text).join(' ')) && visible(view.source));
  check(label + '_first_viewport_contains_joined_valid_translation', view.translationText.includes(fixture.segments.slice(0, 4).map(cue => cue.translations.zh.text).join('')) && visible(view.translation));
  check(label + '_has_no_horizontal_overflow', view.documentWidth <= view.viewport.width);
}


async function controlsGeometry(page, label, selectors) {
  const result = await page.evaluate(selectors => {
    const controls = selectors.map(selector => {
      const element = document.querySelector(selector);
      if (!element) return {selector, missing: true};
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {selector, rect: rect.toJSON(), visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
        hit: hit === element || element.contains(hit), disabled: element.disabled === true};
    });
    return {viewport: {width: innerWidth, height: innerHeight}, controls, documentWidth: document.documentElement.scrollWidth};
  }, selectors);
  geometry.push({label, ...result});
  console.log(JSON.stringify({suite: 'reader-controls-viewport', label, ...result}));
  check(label + '_key_controls_are_visible_and_uncovered', result.documentWidth <= result.viewport.width && result.controls.every(control => !control.missing && control.visible && control.hit && !control.disabled && control.rect.top >= 0 && control.rect.bottom <= result.viewport.height && control.rect.left >= 0 && control.rect.right <= result.viewport.width));
  if (result.viewport.width <= 650) check(label + '_key_controls_keep_touch_height', result.controls.every(control => control.rect.height >= 44));
  return result;
}
async function readingInfoRoundTrip(page, label, title) {
  const summary = page.locator('#reading-info > summary');
  const beforeDocument = await stored(page);
  check(label + '_reading_details_start_closed', !await page.locator('#reading-info').evaluate(node => node.open));
  await summary.evaluate(node => node.addEventListener('pointerdown', () => {
    const source = document.querySelector('#passage-body .passage-original');
    window.__readingInfoOrigin = {id: source.closest('.passage').dataset.firstCueId, top: source.getBoundingClientRect().top, scrollY};
  }, {once: true, capture: true}));
  await summary.click();
  check(label + '_details_show_complete_title_and_source_information', await page.locator('#reading-info').evaluate(node => node.open) && await page.locator('#reading-info-title').textContent() === title && await page.locator('#reading-info-title').evaluate(node => node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1) && await page.locator('#provenance').isVisible() && await page.locator('#subtitle').isVisible());
  await capture(page, label + '-details-expanded');
  await page.locator('#close-reading-info').click(); await settled(page);
  const returned = await page.evaluate(() => {
    const before = window.__readingInfoOrigin, source = document.querySelector('#passage-body .passage-original');
    return {before, id: source.closest('.passage').dataset.firstCueId, top: source.getBoundingClientRect().top, scrollY, focused: document.activeElement === document.querySelector('#reading-info > summary')};
  });
  geometry.push({label: label + '-details-collapsed', ...returned});
  check(label + '_details_roundtrip_keeps_reading_anchor_and_keyboard_focus', returned.id === returned.before.id && Math.abs(returned.top - returned.before.top) <= 3 && returned.focused && (await stored(page)).readingPosition === beforeDocument.readingPosition);
}
async function assertUnhiddenWarning(page, label, selector) {
  const warning = await page.locator(selector).evaluate(node => {
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    return {text: node.textContent, hidden: node.hidden, kind: node.dataset.kind, rect: rect.toJSON(),
      opacity: style.opacity, display: style.display, visibility: style.visibility, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight,
      viewport: {width: innerWidth, height: innerHeight}};
  });
  geometry.push({label, warning});
  check(label + '_warning_is_fully_visible_not_success_styled_or_clipped', !warning.hidden && warning.kind !== 'success' && warning.text.trim().length > 0 && warning.display !== 'none' && warning.visibility !== 'hidden' && Number(warning.opacity) === 1 && warning.rect.height > 0 && warning.rect.top >= 0 && warning.rect.bottom <= warning.viewport.height && warning.rect.left >= 0 && warning.rect.right <= warning.viewport.width && warning.scrollHeight <= warning.clientHeight + 1);
  await capture(page, label);
  if (label.startsWith('mobile')) {
    await page.waitForTimeout(5500);
    check(label + '_warning_outlives_the_success_toast_timer', await page.locator(selector).isVisible() && await page.locator(selector).getAttribute('data-kind') !== 'success');
  }
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
  async function freshPage(viewport, {controlledClock = false} = {}) {
    const context = await browser.newContext({viewport, acceptDownloads: true, serviceWorkers: 'block'});
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) {mutations++; await route.abort(); return;}
      if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) await route.continue();
      else {external++; await route.abort();}
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000); page.on('pageerror', error => browserErrors.push(error.message));
    if (controlledClock) await page.clock.install({time: new Date('2026-10-10T10:00:00Z')});
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
    const toolbar = await controlsGeometry(page, label + '-default-reading-toolbar', ['#keyboard-help-open', '#reading-info > summary', '#toggle-reader-media', '#passage-search', '#passage-toggle-translation', '#export-menu > summary']);
    const help = toolbar.controls.find(control => control.selector === '#keyboard-help-open');
    check(label + '_compact_toolbar_keeps_help_and_reading_actions_on_one_row', toolbar.controls.filter(control => control.selector !== '#export-menu > summary').every(control => Math.abs(control.rect.top - help.rect.top) <= 1));
    check(label + '_keyboard_help_keeps_a_full_label_and_44_pixel_target', help.rect.width >= 44 && help.rect.height >= 44 && await page.locator('#keyboard-help-open').evaluate(button => button.textContent.includes('快捷键') && button.scrollWidth <= button.clientWidth && button.scrollHeight <= button.clientHeight));
    await page.locator('#keyboard-help-open').click();
    check(label + '_toolbar_help_opens_the_real_modal', await page.locator('#keyboard-help').evaluate(dialog => dialog.open && dialog.matches(':modal')));
    await page.keyboard.press('Escape');
    await page.locator('#keyboard-help').waitFor({state: 'hidden'}); await settled(page);
    check(label + '_toolbar_help_returns_focus_without_moving_first_source', await page.locator('#keyboard-help-open').evaluate(button => document.activeElement === button) && await page.locator('.passage-original').first().evaluate((source, top) => Math.abs(source.getBoundingClientRect().top - top) <= 1, imported.source.top) && (await stored(page)).readingPosition === 'split-19');
    await readingInfoRoundTrip(page, label + '-default-reading', fixture.title);
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


  // Repeat the real long document, not a shorter easy-to-fit fixture, under a
  // deliberately long mixed-script title. The first viewport must stay useful.
  const longTitle = '路口观察与真实证据：从行人的等待时间、原始访谈和现场笔记，重新理解一个交通方案为什么需要改变。' +
    ' Reading the complete thought before trusting a quick interpretation: original observations, translation checks, and a careful return to the source. '.repeat(2);
  for (const [label, viewport] of [['desktop', {width: 1360, height: 1000}], ['mobile', {width: 390, height: 844}]]) {
    stage = label + '_long_title_reader';
    const page = await freshPage(viewport), longDocument = {...fixture, title: longTitle};
    await importFixture(page, longDocument, 'authored-long-title-reading.json');
    const initial = await passageGeometry(page, label + '-long-title-first-viewport');
    await capture(page, '07-' + label + '-long-title-first-viewport');
    completeFirstViewport(label + '_long_title', initial, longDocument);
    check(label + '_long_title_fixture_retains_all_original_cues', (await stored(page)).segments.length === 1771);
    await controlsGeometry(page, label + '-long-title-toolbar', ['#reading-info > summary', '#toggle-reader-media', '#passage-search', '#passage-toggle-translation', '#export-menu > summary']);
    await readingInfoRoundTrip(page, label + '-long-title', longTitle);
    await attachAudio(page, audioPath);
    check(label + '_long_title_attachment_never_autoplays', await page.locator('audio').evaluate(player => player.paused && player.currentTime === 0));
    await page.locator('audio').evaluate(player => {window.__headerPlayer = player;});
    // The product's own disclosure returns to reading without hiding or moving
    // anything from test code. Collapsing must preserve the same decoded player.
    await page.locator('#close-reader-media').click(); await settled(page);
    check(label + '_attached_media_settings_can_close_without_replacing_player', await page.locator('#episode-media').isHidden() && await page.locator('audio').evaluate(player => player === window.__headerPlayer && player.paused));
    const attached = await passageGeometry(page, label + '-long-title-attached-media');
    await capture(page, '08-' + label + '-attached-media-reading');
    completeFirstViewport(label + '_attached_media', attached, longDocument);
    await controlsGeometry(page, label + '-attached-media-toolbar', ['#reading-info > summary', '#toggle-reader-media', '#passage-search', '#export-menu > summary', '.passage[data-first-cue-id="split-0"] .passage-listen']);
    // Produce fresh feedback through a real download, then immediately listen.
    // Waiting for the success timer or forcing a covered click would miss PR58's bug.
    await page.locator('#export-menu > summary').click();
    await Promise.all([page.waitForEvent('download'), page.locator('#export').click()]);
    await page.locator('#export-menu > summary').click();
    const firstPassage = page.locator('.passage[data-first-cue-id="split-0"]');
    await firstPassage.locator('.passage-listen').click();
    await page.waitForFunction(() => {const player = document.querySelector('audio'); return !player.paused && player.currentTime > .05;});
    check(label + '_collapsed_media_preserves_real_playback', await page.locator('audio').evaluate(player => player === window.__headerPlayer && player.currentTime > 0));
    check(label + '_success_feedback_remains_visible_during_actual_playback', await page.locator('#notice').isVisible() && await page.locator('#notice').getAttribute('data-kind') === 'success');
    await controlsGeometry(page, label + '-success-feedback-playing', ['#passage-stop', '#dismiss-notice', '#dock-play', '#dock-return']);
    check(label + '_success_feedback_does_not_overlap_listening_or_dock', await page.evaluate(() => {
      const notice = document.querySelector('#notice-shell').getBoundingClientRect();
      return ['#passage-playback-controls', '#media-dock'].every(selector => {const box = document.querySelector(selector).getBoundingClientRect(); return notice.bottom <= box.top || notice.top >= box.bottom || notice.right <= box.left || notice.left >= box.right;});
    }));
    await capture(page, '10-' + label + '-success-feedback-playing');
    await page.locator('#passage-stop').click();
    check(label + '_playback_stop_remains_operable_after_header_changes', await page.locator('audio').evaluate(player => player.paused));
    await page.locator('#dismiss-notice').click();
    check(label + '_success_feedback_can_be_closed_without_waiting', await page.locator('#notice').isHidden());
    await page.locator('#export-menu > summary').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export').click()]);
    const exportedPath = path.join(directory, label + '-long-title-reader.json');
    await download.saveAs(exportedPath);
    const exported = JSON.parse(await fs.readFile(exportedPath, 'utf8'));
    check(label + '_compact_header_export_preserves_full_title_source_notes_and_bookmark', exported.title === longTitle && exported.segments.length === 1771 && exported.segments.every((cue, i) => cue.id === fixture.segments[i].id && cue.text === fixture.segments[i].text) && exported.notes['split-2'] === fixture.notes['split-2'] && exported.readingPosition === 'split-19');
    if (await page.locator('#export-menu').evaluate(node => node.open)) await page.locator('#export-menu > summary').click();
    await page.context().close();

    const sourcePage = await freshPage(viewport), sourceDocument = {...longDocument, translation_view: '', segments: longDocument.segments.map(({translations, ...cue}) => cue)};
    await importFixture(sourcePage, sourceDocument, 'authored-long-title-source-only.json');
    const sourceView = await passageGeometry(sourcePage, label + '-long-title-source-only');
    await capture(sourcePage, '09-' + label + '-source-only-reading');
    check(label + '_source_only_long_document_starts_above_350_without_fake_translation', sourceView.sourceFontSize >= 17 && sourceView.source.top >= 0 && sourceView.source.top <= FIRST_SOURCE_MAX_Y && sourceView.source.bottom <= viewport.height && sourceView.sourceIds.slice(0, 4).join(',') === 'split-0,split-1,split-2,split-3' && sourceView.translation === null && await sourcePage.locator('#passage-toggle-translation').isHidden() && (await stored(sourcePage)).segments.length === 1771);
    await controlsGeometry(sourcePage, label + '-source-only-toolbar', ['#reading-info > summary', '#toggle-reader-media', '#passage-search', '#export-menu > summary']);
    await sourcePage.locator('#file').setInputFiles({name: 'authored-invalid.json', mimeType: 'application/json', buffer: Buffer.from('{invalid JSON')});
    await sourcePage.waitForFunction(() => document.querySelector('#notice').textContent.includes('导入失败'));
    await assertUnhiddenWarning(sourcePage, label + '-import-warning', '#notice');
    check(label + '_failed_import_preserves_full_active_reading', (await stored(sourcePage)).title === longTitle && (await stored(sourcePage)).segments.length === 1771 && await sourcePage.locator('#passage-workspace').isVisible());
    await sourcePage.context().close();

    const blockedPage = await freshPage(viewport);
    // Inject only a normal persistence failure, never CSS, geometry or product
    // layout changes. Import must expose the real unsaved-work warning.
    await blockedPage.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'coconut-reader-v1') throw new DOMException('Authored acceptance storage quota failure', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    await importFixture(blockedPage, longDocument, 'authored-unsaved-reading.json');
    await assertUnhiddenWarning(blockedPage, label + '-unsaved-work-warning', '#save-status');
    check(label + '_unsaved_work_never_claims_import_success', await blockedPage.locator('#notice').getAttribute('data-kind') !== 'success' && await blockedPage.locator('#passage-workspace').isVisible());
    await blockedPage.context().close();
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

  stage = 'compact_success_feedback_note';
  const compactPage = await freshPage({width: 390, height: 480}, {controlledClock: true});
  await importFixture(compactPage, fixture);
  await attachAudio(compactPage, audioPath);
  await compactPage.locator('#close-reader-media').click();
  await compactPage.locator('#dismiss-notice').click();
  // Hold only this scenario's application clock so slow download delivery or
  // screenshots cannot consume the success notice's real five-second lifetime.
  // Native media decoding/events and all keyboard/pointer actions remain real.
  await compactPage.clock.pauseAt(new Date('2026-10-10T12:00:00Z'));
  const compactPassage = compactPage.locator('.passage[data-first-cue-id="split-0"]');
  await compactPage.locator('#export-menu > summary').click();
  await Promise.all([compactPage.waitForEvent('download'), compactPage.locator('#export').click()]);
  await compactPage.locator('#export-menu > summary').click();
  // Start the bounded preview after the download has completed, rather than
  // spending its short source range waiting on an unrelated download event.
  await compactPassage.locator('.passage-listen').press('Enter');
  await expect(compactPage.locator('#passage-playback-controls')).toHaveAttribute('data-state', 'playing');
  await expect(compactPage.locator('audio')).toHaveJSProperty('paused', false);
  // Keyboard activation is a supported route into the cue editor while the
  // transport is present; note Close and dock controls below use real pointers.
  await compactPassage.locator('.passage-details').press('Enter');
  await compactPage.locator('.segment[data-segment-id="split-0"] .note-button').press('Enter');
  // pause() changes the native paused property before the browser dispatches
  // its pause event. Await the observable controller update, not an extra sleep.
  stage = 'compact_note_waits_for_async_preview_pause';
  await expect(compactPage.locator('audio')).toHaveJSProperty('paused', true);
  await expect(compactPage.locator('#passage-playback-controls')).toHaveAttribute('data-state', 'paused');
  await compactPage.clock.runFor(32); // Flush the product's queued dock frame.
  const compactNote = await feedbackState(compactPage, 'compact-note-paused');
  check('compact_note_pauses_the_native_media', compactNote.paused);
  check('compact_note_retains_a_paused_bounded_preview', compactNote.previewState === 'paused');
  check('compact_note_temporarily_yields_the_feedback_stack', compactNote.feedbackDisplay === 'none');
  check('compact_note_preserves_the_unexpired_success_notice', compactNote.noticeKind === 'success' && !compactNote.noticeHidden);
  check('compact_note_pauses_preview_and_temporarily_yields_the_feedback_stack', compactNote.paused && compactNote.previewState === 'paused' && compactNote.feedbackDisplay === 'none' && compactNote.noticeKind === 'success');
  await controlsGeometry(compactPage, 'compact-success-feedback-note', ['#close-note', '#dock-play', '#dock-return']);
  await capture(compactPage, '11-compact-note-feedback-yields');
  await compactPage.locator('#close-note').click();
  await compactPage.clock.runFor(32);
  check('closing_compact_note_restores_the_live_success_message_and_paused_preview', await compactPage.locator('#reading-feedback').isVisible() && await compactPage.locator('#notice').isVisible() && await compactPage.locator('#passage-playback-controls').getAttribute('data-state') === 'paused');
  await controlsGeometry(compactPage, 'compact-success-feedback-restored', ['#dismiss-notice', '#passage-replay', '#passage-stop', '#dock-play']);
  await compactPage.locator('#dismiss-notice').click();
  await compactPage.locator('#passage-return-playback').click();
  check('compact_feedback_dismiss_and_playback_return_are_operable', await compactPage.locator('#notice').isHidden() && await compactPage.locator('#passage-playback-controls').isHidden() && await compactPage.locator('audio').evaluate(player => player.paused));
  // Independently prove natural expiry, including the legitimate case where a
  // user spends longer than five seconds editing before closing the note.
  await compactPage.locator('#export-menu > summary').click();
  await Promise.all([compactPage.waitForEvent('download'), compactPage.locator('#export').click()]);
  await compactPage.locator('#export-menu > summary').click();
  await compactPage.locator('.segment[data-segment-id="split-0"] .note-button').press('Enter');
  await compactPage.clock.runFor(4999);
  check('compact_note_success_remains_live_before_its_five_second_deadline', await compactPage.locator('#notice').getAttribute('data-kind') === 'success' && !await compactPage.locator('#notice').evaluate(node => node.hidden));
  await compactPage.clock.runFor(1);
  check('compact_note_success_expires_at_its_five_second_deadline', await compactPage.locator('#notice').evaluate(node => node.hidden && node.dataset.kind === '') && await compactPage.locator('#notes-panel').isVisible());
  await compactPage.locator('#close-note').click();
  check('closing_compact_note_does_not_resurrect_expired_success', await compactPage.locator('#notice').isHidden());
  await compactPage.context().close();
  activePage = page;

  stage = 'bounded_audio_preview';
  await importFixture(page, fixture);
  await attachAudio(page, audioPath);
  await page.locator('#close-reader-media').click();
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
  await page.locator('#close-reader-media').click();
  check('media_replacement_cancels_previous_range_and_cannot_autoplay', await page.evaluate(() => window.__passagePlayer.paused && document.querySelector('audio') !== window.__passagePlayer && document.querySelector('audio').paused && document.querySelector('audio').currentTime === 0) && await page.locator('#passage-playback-controls').isHidden());
  await firstPassage.locator('.passage-listen').click(); await page.waitForFunction(() => !document.querySelector('audio').paused);
  await page.locator('audio').evaluate(player => {window.__replacedDocumentPlayer = player;});
  await importFixture(page, irregular, 'authored-replacement-document.json');
  check('document_replacement_cancels_old_playback_and_return_target', await page.evaluate(() => window.__replacedDocumentPlayer.paused && [...document.querySelectorAll('audio,video')].every(player => player.paused)) && await page.locator('#passage-playback-controls').isHidden());
  await page.evaluate(()=>libraryStore.flush());
  check('passage_journey_has_no_upload_model_external_requests_or_browser_errors', external === 0 && mutations === 0 && browserErrors.length === 0 && await page.evaluate(() => !localStorage.getItem('coconut-reader-v1').includes('blob:')));
  console.log(JSON.stringify({suite: 'authored-passage-reading-listen-once', status: 'passed', checks, geometry}));
} catch (error) {
  if (stage.includes('compact_') && activePage && !activePage.isClosed()) await feedbackState(activePage, 'failure-' + stage).catch(() => {});
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
