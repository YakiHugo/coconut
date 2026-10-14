import {navigateReadingTime} from './helpers/transcript-navigation-browser.mjs';
/** CI-only real Chromium acceptance for a temporary reading/search session.
 * All source, translations, corrections and notes are authored fixtures. No
 * model, provider, CLI, recording, external site, or user's computer is used.
 * In constrained environments use node --check only; CI runs the actual browser.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium, waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {openTranscriptTools} from './helpers/reading-tools-browser.mjs';
import {openCueActions} from './cue-actions-browser.mjs';
import {startBridge} from '../desktop/server.mjs';
import {searchReturnFixture, SEARCH_RETURN_MARKER, SEARCH_RETURN_DESTINATION,
  SEARCH_RETURN_INNER_DESTINATION, SEARCH_RETURN_ORIGIN} from './helpers/search-return-fixture.mjs';

const checks = [], errors = [], geometry = [], screenshots = [];
let server, browser, diagnosticPage, stage = 'setup', external = 0, mutations = 0, providers = 0;
const check = (name, passed) => {assert.ok(passed, name); checks.push(name);};
const cueSelector = id => '#transcript .segment[data-segment-id="' + id + '"]';
const passageCueSelector = id => '#passage-body .passage-original .passage-cue[data-cue-id="' + id + '"]';
const cue = (page, id) => page.locator(cueSelector(id));
const passage = (page, id) => page.locator('#passage-body .passage').filter({has: page.locator('.passage-original .passage-cue[data-cue-id="' + id + '"]')});
const renderedIds = page => page.locator('#transcript .segment').evaluateAll(rows => rows.map(row => row.dataset.segmentId));

async function frames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function stable(page, selector) {
  await page.waitForFunction(selector => {
    const node = document.querySelector(selector); if (!node) return false;
    const r = node.getBoundingClientRect(), previous = window.__searchReturnStable;
    const same = previous?.selector === selector && Math.abs(previous.y - scrollY) < .1 && Math.abs(previous.top - r.top) < .1;
    const count = same ? previous.count + 1 : 0;
    window.__searchReturnStable = {selector, y: scrollY, top: r.top, count};
    return count >= 4;
  }, selector);
}
async function capture(page, label) {
  if (!process.env.COCONUT_UI_SCREENSHOTS) return;
  await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS, {recursive: true});
  const name = 'search-return-' + label + '.png';
  await page.screenshot({path: path.join(process.env.COCONUT_UI_SCREENSHOTS, name), fullPage: false, animations: 'disabled'});
  screenshots.push(name);
}
// Prevent the test driver from scrolling the header into view before the real
// key event captures the source being read. No handler is called directly.
async function activate(page, selector) {
  const node = page.locator(selector);
  await node.waitFor({state: 'visible'});
  await node.evaluate(node => node.focus({preventScroll: true}));
  await page.keyboard.press('Enter');
}
async function stored(page) {
  await page.evaluate(() => libraryStore.flush());
  await page.waitForFunction(() => document.getElementById('save-status').dataset.state === 'saved');
  return page.evaluate(async () => (await readPersistedLibrary()).documents.find(doc => doc.key === sessionStorage.getItem('coconut-reader-active-v1')));
}
async function position(page, selector, top = 96) {
  await page.locator(selector).evaluate((node, top) => {
    window.scrollBy({top: node.getBoundingClientRect().top - top, left: 0, behavior: 'instant'});
  }, top);
  await stable(page, selector);
  return measure(page, selector);
}
async function measure(page, selector) {
  return page.locator(selector).evaluate(node => {
    const r = node.getBoundingClientRect();
    return {id: node.dataset.cueId || node.dataset.segmentId, top: r.top, bottom: r.bottom,
      scrollY, width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
      mode: document.body.dataset.readingMode};
  });
}
async function inView(page, selector) {
  await stable(page, selector);
  return page.locator(selector).evaluate(node => {
    const r = node.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0;
  });
}
async function restoreGeometry(page, selector, before, label) {
  await page.waitForFunction(({selector, top}) => {
    const node = document.querySelector(selector); if (!node) return false;
    const r = node.getBoundingClientRect();
    return Math.abs(r.top - top) < 3 && r.bottom > 0 && r.top < innerHeight;
  }, {selector, top: before.top});
  await stable(page, selector);
  const after = await measure(page, selector);
  geometry.push({label, before, after});
  check(label + '_restores_same_source_and_relative_viewport', after.id === before.id && Math.abs(after.top - before.top) < 3 && after.mode === before.mode);
}
async function importFixture(page, fixture) {
  await page.locator('#file').setInputFiles({name: 'authored-search-return.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture))});
  await page.waitForFunction(title => document.getElementById('title').textContent === title && document.getElementById('file').value === '', fixture.title);
  await stored(page);
  await page.locator('#passage-workspace').waitFor({state: 'visible'});
}
async function originalPassage(page, id = SEARCH_RETURN_ORIGIN) {
  if (!await page.locator('#passage-workspace').isVisible()) await activate(page, '#mode-passages');
  // Drive the real navigation dialog; only the source IDs/layout come from the
  // product. Six-cue speaker boundaries make cue-282 an unambiguous paragraph.
  await navigateReadingTime(page,Number(id.slice(4))*2);
  const selector = passageCueSelector(id), before = await position(page, selector);
  await page.locator('#passage-body').evaluate(node => node.focus({preventScroll: true}));
  const firstVisible = await page.locator('#passage-body .passage-original .passage-cue').evaluateAll(nodes => nodes.find(node => {
    const r = node.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight;
  })?.dataset.cueId);
  assert.equal(firstVisible, id, 'Fixture must put the intended original source first in the viewport');
  return before;
}
async function startSearch(page, shortcut = null) {
  if (shortcut) await page.keyboard.press(shortcut);
  else await activate(page, '#passage-search');
  await openTranscriptTools(page);
  await page.waitForFunction(() => document.activeElement === document.getElementById('search'));
  await page.locator('#reading-search-session').waitFor({state: 'visible'});
}
async function findDestination(page) {
  await page.locator('#search').fill(SEARCH_RETURN_DESTINATION);
  await page.waitForFunction(() => document.querySelectorAll('#transcript .segment').length === 1 && document.querySelector('#transcript .segment').dataset.segmentId === 'cue-900');
  await activate(page, '#next-match');
  await stable(page, cueSelector('cue-900'));
}
async function readingState(page) {
  return page.evaluate(() => ({mode: document.body.dataset.readingMode,
    bilingual: document.getElementById('mode-bilingual').getAttribute('aria-pressed'),
    query: document.getElementById('search').value, speaker: document.getElementById('speaker-filter').value,
    excerpts: document.getElementById('filter-excerpts').getAttribute('aria-pressed'),
    notes: document.getElementById('filter-notes').getAttribute('aria-pressed'),
    page: document.getElementById('reading-page-status').textContent,
    rows: [...document.querySelectorAll('#transcript .segment')].map(node => node.dataset.segmentId)}));
}
async function firstVisibleTranscriptCue(page) {
  return page.locator('#transcript .segment').evaluateAll(nodes => nodes.find(node => {
    const r = node.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight;
  })?.dataset.segmentId);
}
async function selectReadingLayout(page, value) {
  // Follow every real native disclosure from the outside in. The layout is a
  // product setting, not test-injected CSS or a synthetic browser zoom.
  const control = page.locator('#reading-layout');
  const owners = await control.evaluate(node => {
    const ids = []; for (let owner = node.parentElement; owner; owner = owner.parentElement) if (owner.tagName === 'DETAILS') ids.unshift(owner.id);
    return ids;
  });
  for (const id of owners) {
    assert.ok(id, 'Reading layout disclosure must have an accessible stable ID');
    if (!await page.locator('#' + id).evaluate(node => node.open)) await page.locator('#' + id + ' > summary').click();
  }
  await control.selectOption(value);
  for (const id of [...owners].reverse()) if (await page.locator('#' + id).evaluate(node => node.open)) await page.locator('#' + id + ' > summary').click();
  await frames(page);
}
async function exactContinuedCue(page, id, label) {
  const selector = passageCueSelector(id);
  await stable(page, selector);
  const evidence = await page.locator(selector).evaluate(node => {
    const rect = node.getBoundingClientRect(), source = node.closest('.passage-original'), sourceRect = source.getBoundingClientRect();
    return {id: node.dataset.cueId, focused: node === document.activeElement, targeted: node.classList.contains('search-return-target'),
      top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight, viewportWidth: innerWidth,
      sourceHeight: sourceRect.height, sourceTop: sourceRect.top, fontSize: parseFloat(getComputedStyle(source).fontSize),
      paragraphIds: [...source.querySelectorAll('.passage-cue')].map(cue => cue.dataset.cueId),
      documentWidth: document.documentElement.scrollWidth};
  });
  geometry.push({label, ...evidence});
  check(label + '_focuses_and_reveals_the_exact_original_span', evidence.focused && evidence.targeted && evidence.top >= -1 && evidence.bottom <= evidence.viewportHeight + 1 && evidence.documentWidth <= evidence.viewportWidth);
  return evidence;
}
async function firstSearchResult(page) {
  await originalPassage(page);
  await startSearch(page);
  await page.locator('#search').fill(SEARCH_RETURN_MARKER);
  await activate(page, '#next-match');
  await page.waitForFunction(() => document.activeElement?.dataset.segmentId === 'cue-0');
}
async function installAudit(page) {
  await page.evaluate(() => {
    window.__searchReturnScroll = [];
    for (const method of ['scrollTo', 'scrollBy']) {
      const original = window[method];
      window[method] = function (...args) {window.__searchReturnScroll.push({method}); return original.apply(this, args);};
    }
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...args) {
      window.__searchReturnScroll.push({method: 'scrollIntoView', id: this.id || this.dataset.cueId || this.dataset.segmentId});
      return original.apply(this, args);
    };
    const adapter = CoconutStorageBootstrap.result.adapter, write = adapter.write.bind(adapter);
    // A held receipt still delegates to the actual IndexedDB writer when
    // released. It never substitutes an in-memory fake save success.
    window.__searchReturnWrites = {hold: false, pending: []};
    adapter.write = (...args) => {
      if (!window.__searchReturnWrites.hold) return write(...args);
      return new Promise((resolve, reject) => window.__searchReturnWrites.pending.push(() => write(...args).then(resolve, reject)));
    };
    window.__releaseSearchReturnWrites = async () => {
      window.__searchReturnWrites.hold = false;
      await Promise.all(window.__searchReturnWrites.pending.splice(0).map(release => release()));
    };
  });
}
async function ordinaryRenderDoesNotScroll(page, selector, label) {
  await stable(page, selector);
  const before = await measure(page, selector);
  await page.evaluate(() => {window.__searchReturnScroll = []; render();});
  await frames(page);
  const after = await measure(page, selector), calls = await page.evaluate(() => window.__searchReturnScroll);
  geometry.push({label, before, after, calls});
  check(label + '_has_no_automatic_scroll_or_viewport_drift', calls.length === 0 && Math.abs(after.scrollY - before.scrollY) < 3 && Math.abs(after.top - before.top) < 3);
}

try {
  server = await startBridge({port: 0, providers: {
    status: async () => ({ready: false, reason: 'Self-authored navigation fixture; no CLI or model'}),
    exclusive: async action => action(),
    structured: async () => {providers++; throw new Error('Unexpected model invocation');},
    ask: async () => {providers++; throw new Error('Unexpected model invocation');},
  }});
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true, ...(process.env.COCONUT_CHROMIUM_EXECUTABLE ? {executablePath: process.env.COCONUT_CHROMIUM_EXECUTABLE} : {})});
  for (const [label, viewport] of [['desktop', {width: 1360, height: 1000}], ['mobile', {width: 390, height: 844}]]) {
    stage = label + '_setup';
    const context = await browser.newContext({viewport, serviceWorkers: 'block'});
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) {mutations++; await route.abort(); return;}
      if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) await route.continue();
      else {external++; await route.abort();}
    });
    const page = await context.newPage(); diagnosticPage = page; page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push({label, message: error.message}));
    await page.goto(origin); await page.waitForLoadState('networkidle');
    await installAudit(page);
    const fixture = searchReturnFixture(label);
    await importFixture(page, fixture);
    const imported = await stored(page), key = imported.key;
    check(label + '_uses_real_indexeddb', await page.evaluate(() => CoconutStorageBootstrap.result.backend === 'indexeddb'));

    stage = label + '_passage_search_context_note_return';
    const originBefore = await originalPassage(page);
    await startSearch(page);
    check(label + '_search_entry_keeps_cue_282_page_instead_of_cue_0', await cue(page, SEARCH_RETURN_ORIGIN).count() === 1 && (await renderedIds(page))[0] === 'cue-200');
    check(label + '_session_actions_are_in_transcript_tools_with_explicit_labels', await page.locator('#reading-search-session').evaluate(node => document.getElementById('transcript-reading-tools').contains(node)) &&
      (await page.locator('#return-before-search').textContent()).trim() === '返回搜索前的阅读' &&
      await page.locator('#continue-search-reading').isVisible());
    check(label + '_entering_search_does_not_write_a_bookmark', (await stored(page)).readingPosition === imported.readingPosition);
    await page.locator('#search').fill(SEARCH_RETURN_MARKER);
    check(label + '_matching_results_offer_continue_reading', (await page.locator('#continue-search-reading').textContent()).trim() === '从当前结果继续读');
    await page.locator('#filter-excerpts').click();
    await page.locator('#speaker-filter').selectOption(JSON.stringify('Iris'));
    await page.locator('#next-page').click();
    const matches = fixture.segments.filter(segment => segment.saved_excerpt && segment.speaker === 'Iris');
    const resultId = matches.find((segment, index) => index >= 100 && Number(segment.id.slice(4)) % 6 === 0).id;
    const resultRow = cue(page, resultId);
    check(label + '_search_retains_bounded_second_result_page', (await renderedIds(page)).length === 100 && (await renderedIds(page))[0] === matches[100].id);
    await openCueActions(resultRow);
    await resultRow.locator('.context-button').focus();
    await stable(page, cueSelector(resultId));
    const resultBefore = await measure(page, cueSelector(resultId)), resultState = await readingState(page);
    await page.keyboard.press('Enter');
    check(label + '_context_opens_true_source_neighbors', await cue(page, 'cue-' + (Number(resultId.slice(4)) - 1)).count() === 1 && await page.locator('#reading-context').isVisible());
    await activate(page, '#mode-passages');
    await passage(page, resultId).locator('.passage-details').click();
    await cue(page, resultId).locator('.note-button').click();
    const note = 'Self-authored note written during the search detour · ' + label;
    await page.locator('#note').fill(note);
    await page.locator('#close-note').click();
    await openCueActions(cue(page, resultId));
    await cue(page, resultId).locator('.bookmark-button').click();
    await openCueActions(cue(page, resultId));
    const correctedText = fixture.segments.find(segment => segment.id === resultId).text + ' Authored correction is retained.';
    await cue(page, resultId).locator('.edit-button').click();
    await page.locator('#edit-segment').fill(correctedText);
    await page.locator('#save-edit').click();
    await activate(page, '#return-to-passages');
    check(label + '_inner_note_return_keeps_outer_results_route', await page.locator('#reading-context').isVisible() && await page.locator('#passage-return-bar').isHidden());
    await activate(page, '#return-reading-results');
    assert.deepEqual(await readingState(page), resultState);
    await restoreGeometry(page, cueSelector(resultId), resultBefore, label + '_context_results');
    check(label + '_context_return_restores_result_button_focus', await resultRow.locator('.context-button').evaluate(node => node === document.activeElement));
    check(label + '_results_have_no_horizontal_overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await capture(page, label + '-results');
    await activate(page, '#return-before-search');
    await restoreGeometry(page, passageCueSelector(SEARCH_RETURN_ORIGIN), originBefore, label + '_original_reading');
    check(label + '_original_return_focuses_the_exact_source_span', await page.locator(passageCueSelector(SEARCH_RETURN_ORIGIN)).evaluate(node => node === document.activeElement));
    check(label + '_return_retires_search_and_context_routes', await page.locator('#reading-search-session').isHidden() && await page.locator('#reading-context').isHidden() && await page.locator('#passage-return-bar').isHidden());
    await capture(page, label + '-returned');
    const retained = await stored(page);
    check(label + '_return_preserves_new_note_correction_and_explicit_bookmark', retained.notes[resultId] === note && retained.segments.find(segment => segment.id === resultId).text === correctedText && retained.readingPosition === resultId);
    assert.deepEqual(retained.segments.filter(segment => segment.id !== resultId), imported.segments.filter(segment => segment.id !== resultId));
    await ordinaryRenderDoesNotScroll(page, passageCueSelector(SEARCH_RETURN_ORIGIN), label + '_returned_passage_render');

    stage = label + '_clear_and_continue_from_destination';
    await page.locator('#passage-body').evaluate(node => node.focus({preventScroll: true}));
    await startSearch(page, 'Control+f');
    await findDestination(page);
    const matchBefore = await measure(page, cueSelector('cue-900'));
    await activate(page, '#clear-search');
    check(label + '_clear_retains_cue_900_not_page_zero', await page.locator('#search').inputValue() === '' && (await renderedIds(page))[0] === 'cue-900' && await inView(page, cueSelector('cue-900')));
    check(label + '_clear_keeps_original_reading_return_available', await page.locator('#reading-search-session').isVisible() &&
      (await page.locator('#continue-search-reading').textContent()).trim() === '从当前位置继续读');
    geometry.push({label: label + '_clear_destination', before: matchBefore, after: await measure(page, cueSelector('cue-900'))});
    await ordinaryRenderDoesNotScroll(page, cueSelector('cue-900'), label + '_cleared_results_render');
    await activate(page, '#continue-search-reading');
    check(label + '_continue_reads_the_same_destination_in_passages', await page.locator('#passage-workspace').isVisible() && await inView(page, passageCueSelector('cue-900')));
    check(label + '_continue_ends_session_without_rewriting_explicit_bookmark', await page.locator('#reading-search-session').isHidden() && await page.locator('#reading-context').isHidden() && (await stored(page)).readingPosition === resultId);
    await capture(page, label + '-continued');

    stage = label + '_stale_match_cannot_override_a_new_page';
    await firstSearchResult(page);
    await page.locator('#next-page').click();
    await stable(page, cueSelector('cue-100'));
    check(label + '_paged_results_really_show_cue_100_after_focusing_cue_0', (await renderedIds(page))[0] === 'cue-100' && await firstVisibleTranscriptCue(page) === 'cue-100');
    await activate(page, '#clear-search');
    check(label + '_clear_uses_current_page_instead_of_old_focused_result', (await renderedIds(page))[0] === 'cue-100' && await inView(page, cueSelector('cue-100')));
    await activate(page, '#return-before-search');
    await firstSearchResult(page);
    await page.locator('#next-page').click();
    await stable(page, cueSelector('cue-100'));
    await activate(page, '#continue-search-reading');
    await exactContinuedCue(page, 'cue-100', label + '_continue_current_result_page');
    check(label + '_page_continue_retires_session_and_keeps_bookmark', await page.locator('#reading-search-session').isHidden() && (await stored(page)).readingPosition === resultId);

    stage = label + '_stale_match_cannot_override_same_page_scrolling';
    await firstSearchResult(page);
    await position(page, cueSelector('cue-48'), 0);
    check(label + '_old_focused_cue_is_now_offscreen_on_the_same_result_page', await cue(page, 'cue-0').evaluate(node => node.getBoundingClientRect().bottom <= 0) && await firstVisibleTranscriptCue(page) === 'cue-48');
    await activate(page, '#continue-search-reading');
    await exactContinuedCue(page, 'cue-48', label + '_continue_current_visible_result');
    check(label + '_scrolled_continue_keeps_explicit_bookmark', (await stored(page)).readingPosition === resultId);

    stage = label + '_large_type_exact_late_cue_inside_a_tall_passage';
    await originalPassage(page);
    await startSearch(page);
    await selectReadingLayout(page, 'spacious');
    await page.locator('#search').fill(SEARCH_RETURN_INNER_DESTINATION);
    await page.waitForFunction(() => document.querySelectorAll('#transcript .segment').length === 1 && document.querySelector('#transcript .segment').dataset.segmentId === 'cue-905');
    await activate(page, '#next-match');
    await stable(page, cueSelector('cue-905'));
    await activate(page, '#continue-search-reading');
    const lateCue = await exactContinuedCue(page, 'cue-905', label + '_large_type_inner_cue');
    check(label + '_late_cue_fixture_is_inside_the_same_long_original_paragraph', lateCue.paragraphIds[0] === 'cue-900' && lateCue.paragraphIds.at(-1) === 'cue-905' && lateCue.paragraphIds.length === 6 && lateCue.fontSize >= 20);
    if (label === 'mobile') check('mobile_late_cue_would_be_below_the_fold_if_only_the_paragraph_start_were_revealed', lateCue.sourceHeight > viewport.height && lateCue.top - lateCue.sourceTop > viewport.height * .8);
    check(label + '_large_type_continue_keeps_bookmark_and_ends_session', (await stored(page)).readingPosition === resultId && await page.locator('#reading-search-session').isHidden());
    await capture(page, label + '-large-type-inner-cue');
    await activate(page, '#mode-bilingual');
    await selectReadingLayout(page, 'standard');

    stage = label + '_control_meta_find_and_zero_results_cancel';
    const zeroBefore = await originalPassage(page);
    await startSearch(page, 'Control+f');
    await findDestination(page);
    // Re-entering Find must not replace the first cue-282 origin with cue-900.
    await startSearch(page, 'Meta+f');
    await page.locator('#search').fill('authored-no-such-result-183740');
    await page.waitForFunction(() => document.querySelectorAll('#transcript .segment').length === 0);
    check(label + '_zero_matches_keep_cancel_available', await page.locator('#return-before-search').isVisible() && await page.locator('#next-match').isDisabled());
    // Escape belongs to the focused search field, including zero-match input.
    await page.keyboard.press('Escape');
    await restoreGeometry(page, passageCueSelector(SEARCH_RETURN_ORIGIN), zeroBefore, label + '_zero_result_cancel');
    check(label + '_escape_return_focuses_the_exact_original_source_span', await page.locator(passageCueSelector(SEARCH_RETURN_ORIGIN)).evaluate(node => node === document.activeElement));
    check(label + '_repeated_find_keeps_first_origin_and_bookmark', await page.locator('#reading-search-session').isHidden() && (await stored(page)).readingPosition === resultId);

    stage = label + '_filtered_bilingual_origin_and_late_real_save';
    await activate(page, '#mode-bilingual');
    await openTranscriptTools(page);
    await page.locator('#search').fill(SEARCH_RETURN_MARKER);
    await page.locator('#filter-excerpts').click();
    await page.locator('#speaker-filter').selectOption(JSON.stringify('Iris'));
    await page.locator('#next-page').click();
    // Summary explicitly ends any earlier session. Returning to the same
    // transcript leaves a real, pre-existing filtered page as the next origin.
    await activate(page, '#mode-summary');
    await activate(page, '#mode-bilingual');
    await position(page, cueSelector(resultId));
    await cue(page, resultId).evaluate(node => node.focus({preventScroll: true}));
    const filteredBefore = await measure(page, cueSelector(resultId)), filteredState = await readingState(page);
    check(label + '_filtered_origin_has_query_speaker_excerpts_and_second_page', filteredState.query === SEARCH_RETURN_MARKER && filteredState.speaker === JSON.stringify('Iris') && filteredState.excerpts === 'true' && filteredState.rows[0] === matches[100].id);
    await startSearch(page, 'Control+f');
    await page.locator('#filter-all').click();
    await findDestination(page);
    await openCueActions(cue(page, 'cue-900'));
    await cue(page, 'cue-900').locator('.context-button').click();
    await cue(page, 'cue-900').locator('.note-button').click();
    await page.evaluate(() => {window.__searchReturnWrites.hold = true;});
    const lateNote = 'Self-authored note committed after returning to the original filtered page · ' + label;
    await page.locator('#note').fill(lateNote);
    await page.waitForFunction(() => window.__searchReturnWrites.pending.length > 0);
    const diskWhileHeld = await page.evaluate(async key => (await readPersistedLibrary()).documents.find(doc => doc.key === key), key);
    check(label + '_late_save_is_truly_pending_in_real_indexeddb', diskWhileHeld.notes['cue-900'] !== lateNote && await page.locator('#save-status').getAttribute('data-state') === 'pending');
    await page.locator('#close-note').click();
    await activate(page, '#return-reading-results');
    await activate(page, '#return-before-search');
    assert.deepEqual(await readingState(page), filteredState);
    await restoreGeometry(page, cueSelector(resultId), filteredBefore, label + '_filtered_origin');
    const beforeReceipt = await measure(page, cueSelector(resultId));
    await page.evaluate(() => {window.__searchReturnScroll = []; return window.__releaseSearchReturnWrites();});
    await waitForPersistedLibrary(page, async ({key, note, bookmark}) => {
      const doc = (await readPersistedLibrary()).documents.find(doc => doc.key === key);
      return doc?.notes['cue-900'] === note && doc.readingPosition === bookmark;
    }, {key, note: lateNote, bookmark: resultId});
    await page.waitForFunction(() => document.getElementById('save-status').dataset.state === 'saved');
    await frames(page);
    const afterReceipt = await measure(page, cueSelector(resultId)), receiptCalls = await page.evaluate(() => window.__searchReturnScroll);
    geometry.push({label: label + '_late_indexeddb_receipt', before: beforeReceipt, after: afterReceipt, calls: receiptCalls});
    check(label + '_late_save_never_scrolls_or_reopens_the_search_session', receiptCalls.length === 0 && Math.abs(beforeReceipt.top - afterReceipt.top) < 3 && Math.abs(beforeReceipt.scrollY - afterReceipt.scrollY) < 3 && await page.locator('#reading-search-session').isHidden());
    await ordinaryRenderDoesNotScroll(page, cueSelector(resultId), label + '_filtered_origin_render');
    const finalOriginal = await stored(page);
    check(label + '_both_new_notes_source_edit_and_explicit_bookmark_are_durable', finalOriginal.notes[resultId] === note && finalOriginal.notes['cue-900'] === lateNote && finalOriginal.segments.find(segment => segment.id === resultId).text === correctedText && finalOriginal.readingPosition === resultId);

    stage = label + '_session_lifetime_boundaries';
    await cue(page, resultId).evaluate(node => node.focus({preventScroll: true}));
    await startSearch(page, 'Control+f');
    await activate(page, '#mode-summary');
    await activate(page, '#mode-bilingual');
    check(label + '_summary_ends_session_even_after_returning_to_transcript', await page.locator('#reading-search-session').isHidden());
    await page.locator('#transcript').evaluate(node => node.focus({preventScroll: true}));
    await startSearch(page, 'Control+f');
    await page.locator('#add-content').click();
    await page.locator('#back-reading').click();
    check(label + '_add_content_ends_session_even_after_back_reading', await page.locator('#reading-search-session').isHidden());
    await page.locator('#transcript').evaluate(node => node.focus({preventScroll: true}));
    await startSearch(page, 'Control+f');
    const other = searchReturnFixture(label + '-same-cue-ids', 36);
    other.segments[19].text = 'A different authored document owns this cue-19.';
    other.segments[19].translations.zh.source_text = other.segments[19].text;
    await importFixture(page, other);
    await activate(page, '#mode-bilingual');
    check(label + '_document_switch_with_reused_cue_ids_retires_old_origin', await page.locator('#reading-search-session').isHidden() && (await stored(page)).title === other.title);
    const allSaved = await page.evaluate(() => readPersistedLibrary());
    assert.deepEqual(allSaved.documents.find(doc => doc.key === key), finalOriginal);
    check(label + '_no_media_model_external_requests_or_unexpected_writes', await page.locator('audio,video').count() === 0 && providers === 0 && mutations === 0 && external === 0 && errors.length === 0);
    await context.close(); diagnosticPage = null;
  }
  check('no_external_requests_unexpected_writes_providers_or_browser_errors', external === 0 && mutations === 0 && providers === 0 && errors.length === 0);
  const report = {suite: 'reading-search-return', status: 'passed', checks, geometry, screenshots, external, mutations, providers, errors};
  if (process.env.COCONUT_UI_SCREENSHOTS) {
    await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS, {recursive: true});
    await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS, 'search-return-checks.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report));
} catch (error) {
  if (diagnosticPage && !diagnosticPage.isClosed()) {
    try {await capture(diagnosticPage, 'failure-' + stage);} catch {}
  }
  const report = {suite: 'reading-search-return', status: 'failed', stage, checks, geometry, screenshots, external, mutations, providers, errors, error: error.message};
  if (process.env.COCONUT_UI_SCREENSHOTS) {
    await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS, {recursive: true});
    await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS, 'search-return-checks.json'), JSON.stringify(report, null, 2));
  }
  console.error(JSON.stringify(report)); process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise(resolve => server?.listening ? server.shutdown(resolve) : resolve());
}
