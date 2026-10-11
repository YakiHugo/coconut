/** CI-only real Chromium acceptance for inline exact-excerpt recall.
 * Sources, paired translations, notes and the local PCM tone are authored
 * fixtures. Only loopback reads are permitted; no model, account, external
 * source, recording, user's browser or host clipboard is used. Local runners
 * may use node --check; a syntax check is not browser acceptance evidence.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {chromium, expect, waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
import {startBridge} from '../desktop/server.mjs';

if (!process.env.CI) throw new Error('Inline excerpt browser acceptance is CI-only; use node --check locally.');

const require = createRequire(import.meta.url), C = require('../reader/core.js'), P = require('../reader/passages.js');
const checks = [], errors = [], geometry = [], screenshots = [];
let server, browser, diagnosticPage, stage = 'setup', external = 0, mutations = 0, providers = 0;
const check = (name, passed) => {assert.ok(passed, name); checks.push(name);};
const cueSelector = id => '#transcript .segment[data-segment-id="' + id + '"]';
const passageSelector = id => '#passage-body .passage[data-first-cue-id="' + id + '"]';
const itemSelector = id => '#reading-excerpts-list .reading-excerpt-item[data-excerpt-id="' + id + '"]';
const createdAt = '2026-10-11T01:00:00.000Z';

function fixture(label) {
  const fragments = ['We kept each exact observation in the notebook,',
    'then compared the old words with a translation,', 'while unrelated sentences stayed untouched,',
    'and personal notes belonged to each saved choice,', 'so opening a small reminder beside the text,',
    'could return us to the same reading place.'];
  const doc = {...C.validate({schema_version: 1, title: 'Inline recall · authored fixture · ' + label,
    language: 'en', translation_view: 'zh', readingPosition: 'cue-3',
    notes: {'cue-3': 'An existing whole-cue note must stay independent.'},
    segments: Array.from({length: 36}, (_, index) => {
      const text = fragments[index % fragments.length];
      return {id: 'cue-' + index, text, start: index * 2, end: index * 2 + 1.8,
        speaker: Math.floor(index / 6) % 2 ? 'Rowan' : 'Iris', ...(index === 2 ? {saved_excerpt: true} : {}),
        translations: {zh: {text: '自行撰写的对照文字，第' + index + '段。', source_text: text,
          source_language: 'en', document_language: 'en', provider: 'Authored fixture; no model'}}};
    })}), key: 'authored-inline-' + label};
  const cues = doc.segments.slice(0, 2), separators = [P.separator(cues[0].text, cues[1].text)];
  const model = C.translationSelectionModels(doc, cues, 'zh')[0];
  const paired = C.pairedExactExcerptSnapshot(doc, cues, separators, 3, cues[0].text.length + separators[0].length + 9,
    model, 2, model.text.length - 2, {id: 'paired', createdAt, confirmedAt: createdAt});
  const originals = Array.from({length: 9}, (_, index) => C.exactExcerptSnapshot(doc, [doc.segments[0]], [],
    index + 1, doc.segments[0].text.length - index, {id: 'original-' + index, createdAt}));
  const other = C.exactExcerptSnapshot(doc, [doc.segments[18]], [], 0, 12, {id: 'other-paragraph', createdAt});
  doc.exact_excerpts = [paired, ...originals, other];
  doc.exact_excerpt_notes = {paired: 'My saved thought about the independently selected bilingual words.'};
  return doc;
}

async function frames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function capture(page, label) {
  if (!process.env.COCONUT_UI_SCREENSHOTS) return;
  await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS, {recursive: true});
  const name = 'inline-excerpts-' + label + '.png';
  await page.screenshot({path: path.join(process.env.COCONUT_UI_SCREENSHOTS, name), fullPage: false, animations: 'disabled'});
  screenshots.push(name);
}
async function report(status, error) {
  const value = {suite: 'inline-excerpts', status, stage, checks, geometry, screenshots,
    external, mutations, providers, errors, ...(error ? {error: {message: error.message, stack: error.stack}} : {})};
  if (process.env.COCONUT_UI_SCREENSHOTS) {
    await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS, {recursive: true});
    await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS, 'inline-excerpts-checks.json'), JSON.stringify(value, null, 2));
  }
  (error ? console.error : console.log)(JSON.stringify(value));
}
async function disk(page, key) {
  return page.evaluate(async key => (await readPersistedLibrary()).documents.find(doc => doc.key === key), key);
}
async function saved(page, key) {
  await page.evaluate(() => libraryStore.flush());
  await page.waitForFunction(() => document.getElementById('save-status').dataset.state === 'saved');
  return disk(page, key);
}
// Focus is set without a driver-induced page scroll; activation remains a real
// Chromium key event. This is important for a reading-position assertion.
async function activate(page, selector) {
  const node = page.locator(selector); await node.waitFor({state: 'visible'});
  await node.evaluate(node => node.focus({preventScroll: true}));
  await page.keyboard.press('Enter'); await frames(page);
}
async function position(page, selector) {
  await page.locator(selector).evaluate(node => window.scrollBy({top: node.getBoundingClientRect().top - 120, behavior: 'instant'}));
  await page.waitForFunction(selector => {
    const node = document.querySelector(selector); if (!node) return false;
    const top = node.getBoundingClientRect().top, previous = window.__inlineStable;
    const count = previous?.selector === selector && Math.abs(previous.top - top) < .1 && Math.abs(previous.y - scrollY) < .1 ? previous.count + 1 : 0;
    window.__inlineStable = {selector, top, y: scrollY, count}; return count >= 4;
  }, selector);
}
async function rememberSurface(page, selector) {
  await frames(page);
  return page.evaluate(selector => {
    const entry = document.querySelector(selector);
    const source = entry.closest('.passage')?.querySelector('.passage-original') || entry.closest('.segment')?.querySelector('.words');
    window.__inlineSurface = {entry, source, html: source.innerHTML, player: document.querySelector('#source-media audio'),
      focus: document.activeElement, y: scrollY, top: entry.getBoundingClientRect().top};
    window.__inlineAudit.scroll = [];
    return {top: window.__inlineSurface.top, scrollY, mode: document.body.dataset.readingMode, source: source.textContent};
  }, selector);
}
async function unchangedSurface(page, label, {focused = false, noScrollCalls = false} = {}) {
  await frames(page);
  const value = await page.evaluate(() => {
    const proof = window.__inlineSurface, player = document.querySelector('#source-media audio');
    return {entryConnected: proof.entry.isConnected, sourceConnected: proof.source.isConnected,
      sourceUnchanged: proof.source.innerHTML === proof.html, playerSame: player === proof.player,
      paused: player.paused, time: player.currentTime, focusSame: document.activeElement === proof.focus,
      entryFocused: document.activeElement === proof.entry, top: proof.entry.getBoundingClientRect().top,
      beforeTop: proof.top, y: scrollY, beforeY: proof.y, mode: document.body.dataset.readingMode,
      scrollCalls: window.__inlineAudit.scroll, plays: window.__inlineAudit.plays, seeks: window.__inlineAudit.seeks};
  });
  geometry.push({label, ...value});
  check(label + '_preserves_original_dom_player_and_reading_position', value.entryConnected && value.sourceConnected &&
    value.sourceUnchanged && value.playerSame && value.paused && value.time === 0 && value.plays === 0 && value.seeks === 0 &&
    Math.abs(value.top - value.beforeTop) < 3 && Math.abs(value.y - value.beforeY) < 3);
  if (focused) check(label + '_restores_the_same_inline_control', value.entryFocused);
  if (noScrollCalls) check(label + '_receipt_does_not_scroll_or_steal_focus', value.scrollCalls.length === 0 && value.focusSame);
}
async function modalGeometry(page, label) {
  const value = await page.locator('#reading-excerpts-dialog').evaluate(dialog => {
    const rect = dialog.getBoundingClientRect();
    const controls = [...dialog.querySelectorAll('button, summary')].filter(node => node.getClientRects().length && !node.closest('[hidden]'));
    return {modal: dialog instanceof HTMLDialogElement && dialog.open && dialog.matches(':modal'), rect: rect.toJSON(),
      viewport: {width: innerWidth, height: innerHeight}, scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth,
      documentWidth: document.documentElement.scrollWidth, rows: dialog.querySelectorAll('.reading-excerpt-item').length,
      controls: controls.map(node => ({id: node.id, className: node.className, ...node.getBoundingClientRect().toJSON()}))};
  });
  geometry.push({label, ...value});
  check(label + '_native_modal_is_bounded_and_has_no_horizontal_overflow', value.modal && value.rows <= 8 &&
    value.rect.left >= 0 && value.rect.right <= value.viewport.width && value.rect.top >= 0 && value.rect.bottom <= value.viewport.height + 1 &&
    value.scrollWidth <= value.clientWidth && value.documentWidth <= value.viewport.width);
  check(label + '_dialog_controls_have_touch_targets', value.controls.every(control => control.height >= 44));
}
async function keyboardGeometry(page, selector, label) {
  // Native Tab/Shift+Tab supplies :focus-visible and scrolls the focused control
  // into the modal's own scrollport, rather than artificially positioning it.
  const value = await page.locator(selector).evaluate(node => {
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    const dialog = node.closest('dialog')?.getBoundingClientRect() || new DOMRect(0, 0, innerWidth, innerHeight);
    const ring = (parseFloat(style.outlineWidth) || 0) + Math.max(0, parseFloat(style.outlineOffset) || 0);
    return {focused: document.activeElement === node, focusVisible: node.matches(':focus-visible'), ring, rect: rect.toJSON(),
      dialog: dialog.toJSON(), viewport: {width: innerWidth, height: innerHeight},
      hits: [[rect.x + rect.width / 2, rect.y + rect.height / 2], [rect.left + 1, rect.y + rect.height / 2],
        [rect.right - 1, rect.y + rect.height / 2], [rect.x + rect.width / 2, rect.top + 1], [rect.x + rect.width / 2, rect.bottom - 1]]
        .map(([x, y]) => {const hit = document.elementFromPoint(x, y); return hit === node || node.contains(hit);})};
  });
  geometry.push({label, ...value});
  check(label + '_keyboard_focus_ring_and_five_hit_points_are_visible', value.focused && value.focusVisible && value.ring > 0 &&
    value.rect.height >= 44 && value.rect.width >= 44 && value.rect.left - value.ring >= Math.max(0, value.dialog.left) &&
    value.rect.right + value.ring <= Math.min(value.viewport.width, value.dialog.right) &&
    value.rect.top - value.ring >= Math.max(0, value.dialog.top) &&
    value.rect.bottom + value.ring <= Math.min(value.viewport.height, value.dialog.bottom) && value.hits.every(Boolean));
}
async function openInline(page, selector, auditLabel = null) {
  await position(page, selector); await page.locator(selector).focus();
  if (auditLabel) {
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab'); await frames(page);
    await keyboardGeometry(page, selector, auditLabel); await capture(page, auditLabel);
  }
  await rememberSurface(page, selector); await page.keyboard.press('Enter');
  await expect(page.locator('#reading-excerpts-dialog')).toBeVisible();
  await expect(page.locator('#reading-excerpts-heading')).toBeFocused();
}
async function closeInline(page, label, escape = false) {
  if (escape === true) await page.keyboard.press('Escape');
  else await page.locator(escape === 'top' ? '#reading-excerpts-dismiss' : '#reading-excerpts-close').click();
  await expect(page.locator('#reading-excerpts-dialog')).toBeHidden();
  await unchangedSurface(page, label, {focused: true});
}
async function installAudit(page) {
  await page.evaluate(() => {
    const audit = window.__inlineAudit;
    for (const name of ['scrollBy', 'scrollTo']) {
      const original = window[name]; window[name] = function (...args) {audit.scroll.push(name); return original.apply(this, args);};
    }
    const scroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...args) {audit.scroll.push('scrollIntoView'); return scroll.apply(this, args);};
    const adapter = CoconutStorageBootstrap.result.adapter, write = adapter.write.bind(adapter);
    audit.hold = false; audit.pending = [];
    adapter.write = (...args) => !audit.hold ? write(...args) : new Promise((resolve, reject) => {
      // Release always calls the real selected IndexedDB adapter. Pending data
      // is checked against a separate committed IDB read before release.
      audit.pending.push(() => write(...args).then(resolve, reject));
    });
    window.__releaseInlineWrites = async () => {audit.hold = false; await Promise.all(audit.pending.splice(0).map(release => release()));};
  });
}

try {
  server = await startBridge({port: 0, providers: {
    status: async () => ({ready: false, reason: 'Authored inline recall fixture; no CLI or model'}), exclusive: async action => action(),
    structured: async () => {providers++; throw new Error('Unexpected model invocation');},
    ask: async () => {providers++; throw new Error('Unexpected model invocation');},
  }});
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true, ...(process.env.COCONUT_CHROMIUM_EXECUTABLE ? {executablePath: process.env.COCONUT_CHROMIUM_EXECUTABLE} : {})});
  for (const [label, viewport] of [['desktop', {width: 1360, height: 1000}], ['390', {width: 390, height: 844}]]) {
    stage = label + '_setup';
    const context = await browser.newContext({viewport, acceptDownloads: true, serviceWorkers: 'block'});
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) {mutations++; return route.abort();}
      if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
      external++; return route.abort();
    });
    await context.addInitScript(() => {
      window.__inlineAudit = {plays: 0, seeks: 0, scroll: []};
      document.addEventListener('play', () => window.__inlineAudit.plays++, true);
      document.addEventListener('seeking', () => window.__inlineAudit.seeks++, true);
    });
    const page = await context.newPage(); diagnosticPage = page; page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push({label, message: error.message, stack: error.stack}));
    await page.goto(origin); await page.waitForLoadState('networkidle'); await installAudit(page);
    const authored = fixture(label), key = authored.key, pair = authored.exact_excerpts[0];
    await page.locator('#library-file').setInputFiles({name: 'authored-inline-excerpts.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({format: 'coconut-library', version: 1, documents: [authored], active: key}))});
    await page.waitForFunction(title => document.getElementById('title').textContent === title && document.getElementById('library-file').value === '', authored.title);
    await saved(page, key);
    if (!await page.locator('#attach-reader-media').isVisible()) await page.locator('#toggle-reader-media').click();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#attach-reader-media').click()]);
    await chooser.setFiles({name: 'authored-inline-tone.wav', mimeType: 'audio/wav', buffer: authoredAudioFixture(90)});
    await page.waitForFunction(() => {const player = document.querySelector('#source-media audio'); return player && !player.error && player.readyState >= 2;});
    await page.locator('#close-reader-media').click();
    await activate(page, '#mode-passages');
    const baseline = await saved(page, key), passage = passageSelector('cue-0'), passageOpen = passage + ' .reading-excerpt-open';
    check(label + '_uses_real_indexeddb', await page.evaluate(() => CoconutStorageBootstrap.result.backend === 'indexeddb'));
    await expect(page.locator(passageOpen)).toHaveText('摘录 10');
    await expect(page.locator(passageSelector('cue-6') + ' .reading-excerpt-open')).toBeHidden();
    await expect(page.locator(passageSelector('cue-18') + ' .reading-excerpt-open')).toHaveText('摘录 1');
    check(label + '_continuous_reading_shows_only_related_records_without_highlight_wrappers', await page.locator(passage + ' .passage-original .passage-cue').evaluateAll(nodes => nodes.every(node => node.childElementCount === 0)));

    stage = label + '_bounded_modal_and_native_keyboard';
    await openInline(page, passageOpen, label + '_passage_entry'); await modalGeometry(page, label + '_collapsed');
    await expect(page.locator('#reading-excerpts-list .reading-excerpt-item')).toHaveCount(8);
    await expect(page.locator('#reading-excerpts-position')).toHaveText('1–8 / 10 条');
    await expect(page.locator('#reading-excerpts-previous')).toBeDisabled();
    await expect(page.locator(itemSelector('other-paragraph'))).toHaveCount(0);
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-history')).toContainText('来源仍一致');
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-preview')).toHaveText(pair.text);
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-translation')).toHaveText(pair.translation.text);
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-note')).toContainText(authored.exact_excerpt_notes.paired);
    check(label + '_collapsed_rows_do_not_mount_full_snapshots', await page.locator('.reading-excerpt-content').count() === 0);
    await capture(page, label + '-continuous-collapsed');
    await page.keyboard.press('Tab');
    await expect(page.locator('#reading-excerpts-dismiss')).toBeFocused();
    await keyboardGeometry(page, '#reading-excerpts-dismiss', label + '_first_modal_action');
    await page.keyboard.press('Shift+Tab'); await expect(page.locator('#reading-excerpts-close')).toBeFocused();
    await keyboardGeometry(page, '#reading-excerpts-close', label + '_last_modal_action');
    await capture(page, label + '-last-action-keyboard');
    await page.keyboard.press('Tab'); await expect(page.locator('#reading-excerpts-dismiss')).toBeFocused();
    check(label + '_native_modal_tab_wraps_between_first_and_last_controls', true);
    await page.keyboard.press('Tab');
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-details > summary')).toBeFocused();
    await keyboardGeometry(page, itemSelector('paired') + ' .reading-excerpt-details > summary', label + '_disclosure');
    await page.keyboard.press('Enter');
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-content').first()).toHaveText(pair.text);
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-content').nth(1)).toContainText(pair.translation.text);
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-details')).toContainText(authored.title);
    await capture(page, label + '-paired-evidence');
    await page.keyboard.press('Enter'); await page.keyboard.press('Tab');
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-edit')).toBeFocused();
    await keyboardGeometry(page, itemSelector('paired') + ' .reading-excerpt-edit', label + '_edit');
    await page.locator('#reading-excerpts-next').click();
    await expect(page.locator('#reading-excerpts-list .reading-excerpt-item')).toHaveCount(2);
    await expect(page.locator('#reading-excerpts-position')).toHaveText('9–10 / 10 条');
    await expect(page.locator('#reading-excerpts-next')).toBeDisabled();
    await expect(page.locator('#reading-excerpts-heading')).toBeFocused();
    await page.locator('#reading-excerpts-previous').click();
    check(label + '_pagination_remounts_at_most_eight_and_resets_details', await page.locator('.reading-excerpt-content').count() === 0);
    await closeInline(page, label + '_continuous_escape', true);
    assert.deepEqual(await saved(page, key), baseline);
    check(label + '_recall_and_pagination_are_read_only', true);

    stage = label + '_nested_note_late_real_receipt';
    await openInline(page, passageOpen);
    const edit = itemSelector('paired') + ' .reading-excerpt-edit';
    await page.locator(edit).click();
    await expect(page.locator('#exact-note-dialog')).toBeVisible();
    await expect(page.locator('#exact-note-text')).toBeFocused();
    check(label + '_nested_note_shows_immutable_both_language_evidence', (await page.locator('#exact-note-quote').inputValue()).includes(pair.text) && (await page.locator('#exact-note-quote').inputValue()).includes(pair.translation.text));
    await page.keyboard.press('Shift+Tab'); await expect(page.locator('#exact-note-quote')).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(page.locator('#exact-note-backup')).toBeFocused();
    await keyboardGeometry(page, '#exact-note-backup', label + '_nested_last_action');
    await page.keyboard.press('Tab'); await expect(page.locator('#exact-note-quote')).toBeFocused();
    await page.keyboard.press('Tab'); await expect(page.locator('#exact-note-text')).toBeFocused();
    check(label + '_nested_native_dialog_keeps_its_own_tab_boundary', true);
    const submitted = 'Authored delayed note receipt · ' + label, newerDraft = 'A newer unsubmitted thought must retain focus · ' + label;
    await page.locator('#exact-note-text').fill(submitted);
    await page.evaluate(() => {window.__inlineAudit.hold = true;});
    await page.locator('#exact-note-save').click();
    await page.waitForFunction(() => window.__inlineAudit.pending.length > 0);
    check(label + '_note_receipt_is_pending_against_committed_indexeddb', (await disk(page, key)).exact_excerpt_notes.paired === baseline.exact_excerpt_notes.paired && await page.locator('#save-status').getAttribute('data-state') === 'pending');
    await page.locator('#exact-note-text').fill(newerDraft);
    await rememberSurface(page, passageOpen);
    await page.evaluate(() => window.__releaseInlineWrites());
    await waitForPersistedLibrary(page, async ({key, submitted}) => (await readPersistedLibrary()).documents.find(doc => doc.key === key)?.exact_excerpt_notes?.paired === submitted, {key, submitted});
    await expect(page.locator('#exact-note-text')).toHaveValue(newerDraft);
    await expect(page.locator('#exact-note-status')).toContainText('尚未提交');
    await unchangedSurface(page, label + '_late_note_receipt', {noScrollCalls: true});
    await page.keyboard.press('Escape');
    await expect(page.locator('#exact-note-dialog')).toBeVisible();
    await page.locator('#exact-note-cancel').click();
    await expect(page.locator(edit)).toBeFocused();
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-note')).toContainText(submitted);
    await capture(page, label + '-note-saved-in-place');
    await closeInline(page, label + '_nested_note_return');

    stage = label + '_note_failure_retention_and_retry';
    await openInline(page, passageOpen); await page.locator(edit).click();
    const failedNote = 'Authored note retained locally during quota failure · ' + label;
    await page.locator('#exact-note-text').fill(failedNote); await page.evaluate(() => failContentWrites());
    await page.locator('#exact-note-save').click();
    await expect(page.locator('#exact-note-status')).toContainText('保存未成功');
    await expect(page.locator('#exact-note-text')).toHaveValue(failedNote);
    check(label + '_failed_note_never_claims_committed_storage', (await disk(page, key)).exact_excerpt_notes.paired === submitted);
    await capture(page, label + '-note-write-failure');
    await page.locator('#exact-note-close').click(); await expect(page.locator(edit)).toBeFocused();
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-note')).toContainText(failedNote);
    await expect(page.locator('#reading-excerpts-save-status')).toContainText('尚未保存');
    await page.locator(edit).click(); await expect(page.locator('#exact-note-text')).toHaveValue(failedNote);
    await page.evaluate(() => restoreContentWrites()); await page.locator('#exact-note-save').click();
    await expect(page.locator('#exact-note-status')).toHaveText('已保存到本机');
    await page.locator('#exact-note-close').click(); await expect(page.locator(edit)).toBeFocused();
    await expect(page.locator('#reading-excerpts-save-status')).toHaveText('已保存到本机');
    await closeInline(page, label + '_failed_note_retry_return');
    const afterNote = await saved(page, key);
    assert.deepEqual(afterNote.exact_excerpts, baseline.exact_excerpts);
    assert.deepEqual(afterNote.segments, baseline.segments); assert.deepEqual(afterNote.notes, baseline.notes);
    assert.equal(afterNote.readingPosition, baseline.readingPosition); assert.equal(afterNote.exact_excerpt_notes.paired, failedNote);
    check(label + '_only_exact_note_sidecar_changes_after_retry', true);

    stage = label + '_sentence_and_bilingual_recall';
    for (const mode of ['transcript', 'bilingual']) {
      await activate(page, '#mode-' + mode);
      const open = cueSelector('cue-0') + ' .reading-excerpt-open';
      await expect(page.locator(open)).toHaveText('摘录 10');
      await expect(page.locator(cueSelector('cue-1') + ' .reading-excerpt-open')).toHaveText('摘录 1');
      await expect(page.locator(cueSelector('cue-2') + ' .reading-excerpt-open')).toBeHidden();
      await expect(page.locator(cueSelector('cue-3') + ' .reading-excerpt-open')).toBeHidden();
      check(label + '_' + mode + '_whole_cue_annotations_do_not_create_exact_badges_or_source_highlights', await page.locator(cueSelector('cue-0') + ' .words').evaluate(node => node.childElementCount === 0));
      await openInline(page, open, label + '_' + mode + '_entry'); await modalGeometry(page, label + '_' + mode);
      await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-note')).toContainText(failedNote);
      await capture(page, label + '-' + mode + '-recall');
      await closeInline(page, label + '_' + mode + '_return', mode === 'bilingual' ? true : 'top');
    }

    stage = label + '_new_capture_failure_and_receipt_without_reader_rebuild';
    await activate(page, '#mode-passages');
    await page.locator(passage + ' .passage-quote').click();
    await page.locator('#quotation-source').focus(); await page.keyboard.press('Control+Home');
    await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight');
    await page.locator('#quotation-preview-selection').click(); await page.evaluate(() => failContentWrites());
    await page.locator('#quotation-save').click();
    await expect(page.locator('#quotation-save-status')).toContainText('尚未保存');
    await page.locator('#quotation-close').click();
    await expect(page.locator(passageOpen)).toHaveText('摘录 11');
    check(label + '_failed_new_capture_is_not_falsely_committed', (await disk(page, key)).exact_excerpts.length === baseline.exact_excerpts.length);
    await openInline(page, passageOpen);
    await expect(page.locator('#reading-excerpts-save-status')).toContainText('尚未保存');
    await page.locator('#reading-excerpts-next').click();
    const retained = page.locator('#reading-excerpts-list .reading-excerpt-item').last();
    await expect(retained.locator('.reading-excerpt-preview')).toHaveText('We');
    const newId = await retained.getAttribute('data-excerpt-id');
    await capture(page, label + '-capture-retained-locally');
    await page.evaluate(() => {restoreContentWrites(); window.__inlineAudit.hold = true;});
    await retained.locator('.reading-excerpt-edit').click();
    await page.locator('#exact-note-text').fill('Retry the retained capture with its own note.');
    await page.locator('#exact-note-save').click(); await page.waitForFunction(() => window.__inlineAudit.pending.length > 0);
    await page.locator('#exact-note-close').click();
    await closeInline(page, label + '_pending_capture_return');
    await rememberSurface(page, passageOpen);
    await page.evaluate(() => window.__releaseInlineWrites());
    await waitForPersistedLibrary(page, async ({key, id}) => (await readPersistedLibrary()).documents.find(doc => doc.key === key)?.exact_excerpts.some(record => record.id === id), {key, id: newId});
    await page.waitForFunction(() => document.getElementById('save-status').dataset.state === 'saved');
    await unchangedSurface(page, label + '_capture_receipt_after_return', {focused: true, noScrollCalls: true});
    check(label + '_late_receipt_does_not_reopen_any_dialog', await page.locator('dialog[open]').count() === 0);

    stage = label + '_same_id_source_and_record_replacement_guards';
    // Authored in-memory source changes deliberately exercise ownership guards;
    // navigation, note edits, save attempts and modal dismissal use real UI.
    await page.evaluate(key => {const doc = state.documents.find(doc => doc.key === key); doc.segments[0] = {...doc.segments[0]}; queueDocument(doc); render();}, key);
    await saved(page, key); await openInline(page, passageOpen);
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-history')).toContainText('已替换');
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-preview')).toHaveText(pair.text);
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-translation')).toHaveText(pair.translation.text);
    await capture(page, label + '-same-id-source-replacement');
    await page.locator(edit).click(); const rejectedDraft = 'This must not be attached to a replacement with the same ID.';
    await page.locator('#exact-note-text').fill(rejectedDraft);
    const replacement = await page.evaluate(key => {
      const doc = state.documents.find(doc => doc.key === key), replacement = Coconut.exactExcerptSnapshot(doc, [doc.segments[0]], [], 0, 7,
        {id: 'paired', createdAt: '2026-10-11T02:00:00.000Z'});
      doc.exact_excerpts = doc.exact_excerpts.map(record => record.id === 'paired' ? replacement : record);
      queueDocument(doc); refreshReadingExcerpts(doc); return replacement;
    }, key);
    await saved(page, key); await page.locator('#exact-note-save').click();
    await expect(page.locator('#exact-note-status')).toContainText('更换或移除');
    await expect(page.locator('#exact-note-text')).toHaveValue(rejectedDraft);
    await page.locator('#exact-note-cancel').click(); await expect(page.locator(edit)).toBeDisabled();
    await expect(page.locator('#reading-excerpts-heading')).toBeFocused();
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-preview')).toHaveText(pair.text);
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-note')).toContainText(failedNote);
    assert.deepEqual((await disk(page, key)).exact_excerpts.find(record => record.id === 'paired'), replacement);
    assert.equal((await disk(page, key)).exact_excerpt_notes.paired, failedNote);
    check(label + '_same_id_replacement_does_not_rebind_snapshot_or_apply_stale_note', true);
    await closeInline(page, label + '_replaced_record_return');

    stage = label + '_stale_and_missing_historical_snapshots';
    // Restore the original immutable records as an authored source-state fixture,
    // then revise current text/translation and finally remove a cited cue.
    await page.evaluate(({key, records}) => {
      const doc = state.documents.find(doc => doc.key === key);
      doc.exact_excerpts = Coconut.validate({...doc, exact_excerpts: records, exact_excerpt_notes: {paired: doc.exact_excerpt_notes.paired}}).exact_excerpts;
      doc.exact_excerpt_notes = {paired: doc.exact_excerpt_notes.paired};
      doc.segments[0].text = 'A deliberately revised current source, unlike the saved historical words.';
      doc.segments[0].translations.zh.text = '已经变化的当前译文';
      queueDocument(doc); render();
    }, {key, records: baseline.exact_excerpts});
    await saved(page, key); await openInline(page, passageOpen);
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-history')).toContainText('历史关联');
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-preview')).toHaveText(pair.text);
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-translation')).toHaveText(pair.translation.text);
    await page.locator(itemSelector('paired') + ' .reading-excerpt-details > summary').click();
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-content').first()).toHaveText(pair.text);
    await expect(page.locator(itemSelector('paired') + ' .reading-excerpt-content').nth(1)).toContainText(pair.translation.text);
    await capture(page, label + '-historical-paired-snapshot');
    await closeInline(page, label + '_stale_snapshot_return');
    await page.evaluate(key => {const doc = state.documents.find(doc => doc.key === key); doc.segments.splice(1, 1); queueDocument(doc); render();}, key);
    await saved(page, key); await expect(page.locator(passageOpen)).toHaveText('摘录 9');
    await openInline(page, passageOpen); await expect(page.locator(itemSelector('paired'))).toHaveCount(0);
    check(label + '_missing_cue_is_not_guessed_from_remaining_text_or_times', (await disk(page, key)).exact_excerpts.some(record => record.id === 'paired') &&
      await page.evaluate(key => Coconut.exactExcerptState(state.documents.find(doc => doc.key === key).exact_excerpts[0], state.documents.find(doc => doc.key === key)).freshness, key) === 'missing');
    await closeInline(page, label + '_missing_snapshot_return');
    assert.deepEqual((await saved(page, key)).exact_excerpts, baseline.exact_excerpts);
    check(label + '_historical_snapshot_bytes_survive_source_changes', true);
    stage = label + '_rerender_fallback_remains_keyboard_reachable';
    await openInline(page, passageOpen);
    await page.evaluate(() => render());
    await page.locator('#reading-excerpts-close').click();
    await expect(page.locator('#reading-excerpts-dialog')).toBeHidden();
    const fallback = page.locator(passage + ' .passage-original .passage-cue[data-cue-id="cue-0"]');
    await expect(fallback).toBeFocused();
    check(label + '_rerendered_reader_returns_to_a_focusable_original_cue', await fallback.evaluate(node => node.tabIndex === -1 && node.childElementCount === 0));
    check(label + '_no_playback_model_external_requests_or_browser_errors', await page.evaluate(() => window.__inlineAudit.plays === 0 && window.__inlineAudit.seeks === 0) && external === 0 && mutations === 0 && providers === 0 && errors.length === 0);
    await context.close(); diagnosticPage = null;
  }
  await report('passed');
} catch (error) {
  if (diagnosticPage && !diagnosticPage.isClosed()) await capture(diagnosticPage, 'failure-' + stage).catch(() => {});
  await report('failed', error); process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise(resolve => server?.listening ? server.shutdown(resolve) : resolve());
}
