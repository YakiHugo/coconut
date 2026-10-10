import {openLibraryTools} from './helpers/library-tools-browser.mjs';
/** Real-browser acceptance, intended for CI or an explicitly approved browser
 * environment. Authored files and injected answers only; no model, CLI, media,
 * provider, external request or account is used. This file may be syntax-checked
 * in constrained environments without launching Chromium. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from './helpers/browser-storage.mjs';
import {startBridge} from '../desktop/server.mjs';
import {openCueActions} from './cue-actions-browser.mjs';
import {phraseSearchFixture, phraseContributorIds, SOURCE_PHRASE, TRANSLATED_PHRASE} from './helpers/phrase-search-fixture.mjs';

let server, browser, currentLabel, stage = 'setup', external = 0, mutations = 0;
const checks = [], errors = [], injected = [];
const check = (name, value) => {stage = name;assert.ok(value, name);checks.push(name);};
const cue = (page, id) => page.locator('.segment[data-segment-id="' + id + '"]');
const renderedIds = page => page.locator('#transcript .segment').evaluateAll(nodes => nodes.map(node => node.dataset.segmentId));
const stored = async page => {await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');return page.evaluate(async () => (await readPersistedLibrary()).documents.find(doc => doc.key === sessionStorage.getItem('coconut-reader-active-v1')));};
async function importDocument(page, fixture) {
  await page.locator('#file').setInputFiles({name: 'authored-phrase-search.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture))});
  await page.waitForFunction(title => document.querySelector('#title').textContent === title, fixture.title);
  if (await page.locator('#passage-search').isVisible()) await page.locator('#passage-search').click();
  else await page.locator('#mode-bilingual').click();
  await page.locator('#search').waitFor({state: 'visible'});
}
async function enter(page, query) {await page.locator('#search').fill(query);}
async function screenshot(page, label) {
  if (!process.env.COCONUT_UI_SCREENSHOTS) return;
  await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS, {recursive: true});
  await page.screenshot({path: path.join(process.env.COCONUT_UI_SCREENSHOTS, 'phrase-search-' + label + '.png'), fullPage: false, animations: 'disabled'});
}
async function openLibrary(page, options = false) {
  if (!await page.locator('#library-search').isVisible()) await page.locator('#toggle-library').click();
  if(options)await openLibraryTools(page);
  if (options && !await page.locator('#library-scope').isVisible()) await page.locator('.library-options > summary').click();
}
async function showLanguageTools(page) {
  if (!await page.locator('#language-panel').evaluate(node => node.open)) await page.locator('#language-panel > summary').click();
}
try {
  // Exercise the real health/capability lifecycle. A static server leaves the
  // reader disconnected even when language-tools and ask routes are stubbed.
  server = await startBridge({port: 0, providers: {
    status: async () => ({ready: true, reason: 'Authored fixture; no real CLI'}),
    exclusive: async action => action(),
    structured: async () => {throw new Error('Unexpected translation request');},
    ask: async body => {
      injected.push({label: currentLabel, body});
      return {answer: 'Authored injected answer; no model call.', citations: [body.segments[0].id], provider: 'fixture'};
    },
  }});
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true, ...(process.env.COCONUT_CHROMIUM_EXECUTABLE ? {executablePath: process.env.COCONUT_CHROMIUM_EXECUTABLE} : {})});
  for (const [label, viewport] of [['desktop', {width: 1360, height: 1000}], ['mobile', {width: 390, height: 844}]]) {
    stage = label + '_setup';currentLabel = label;
    const context = await browser.newContext({viewport, acceptDownloads: true, serviceWorkers: 'block'});
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin && url.pathname === '/api/ask' && request.method() === 'POST') {
        await route.continue();return;
      }
      if (!['GET', 'HEAD'].includes(request.method())) {mutations++;await route.abort();return;}
      if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) await route.continue();
      else {external++;await route.abort();}
    });
    const page = await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror', error => errors.push(error.message));await page.goto(origin);
    await page.waitForFunction(() => !document.querySelector('#check-ai').disabled);
    const fixture = phraseSearchFixture(1771);fixture.title += ' · ' + label;fixture.segments[0].text = SOURCE_PHRASE + '.';
    await importDocument(page, fixture);const before = await stored(page);await enter(page, SOURCE_PHRASE);
    const all = ['split-0', ...phraseContributorIds(1771)];
    check(label + '_source_phrase_has_591_contributing_cues_with_100_dom_rows', JSON.stringify(await renderedIds(page)) === JSON.stringify(all.slice(0, 100)) && (await page.locator('#search-status').textContent()).includes('找到 591 个片段'));
    check(label + '_both_contributing_sources_are_verbatim_highlighted', await cue(page, 'split-1').locator('.words mark').textContent() === 'left out' && await cue(page, 'split-2').locator('.words mark').textContent() === 'the time');
    check(label + '_joined_preview_exposes_exact_ids', JSON.stringify(JSON.parse(await cue(page, 'split-2').locator('.phrase-match').getAttribute('data-cue-ids'))) === JSON.stringify(['split-1', 'split-2']) && await cue(page, 'split-2').locator('.phrase-match mark').textContent() === SOURCE_PHRASE);
    await page.locator('#next-match').click();await page.locator('#next-match').click();
    check(label + '_next_match_focuses_real_cue', await cue(page, 'split-1').evaluate(node => node === document.activeElement));
    await screenshot(page, label + '-source');
    check(label + '_preview_does_not_overflow_mobile_or_desktop', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.locator('#next-page').click();
    check(label + '_second_half_at_page_boundary_keeps_full_phrase', (await renderedIds(page))[0] === 'split-296' && await cue(page, 'split-296').locator('.phrase-match mark').textContent() === SOURCE_PHRASE);
    await openCueActions(cue(page, 'split-296'));await cue(page, 'split-296').locator('.context-button').click();
    check(label + '_context_keeps_real_neighbors_and_bounded_dom', await cue(page, 'split-295').count() === 1 && await cue(page, 'split-297').count() === 1 && (await renderedIds(page)).length <= 100);
    await page.locator('#return-reading-results').click();
    check(label + '_context_return_preserves_query_page_and_focus', await page.locator('#search').inputValue() === SOURCE_PHRASE && (await renderedIds(page))[0] === 'split-296' && await cue(page, 'split-296').locator('.context-button').evaluate(node => node === document.activeElement));
    await page.locator('#previous-match').click();check(label + '_match_navigation_crosses_page_boundary', await cue(page, 'split-295').evaluate(node => node === document.activeElement));
    check(label + '_search_and_context_leave_source_and_reading_work_unchanged', JSON.stringify(await stored(page)) === JSON.stringify(before));

    await enter(page, TRANSLATED_PHRASE);
    check(label + '_chinese_phrase_counts_590_cues_and_joins_without_spaces', (await page.locator('#search-status').textContent()).includes('找到 590 个片段') && await cue(page, 'split-1').locator('.phrase-match mark').textContent() === TRANSLATED_PHRASE);
    check(label + '_chinese_marks_keep_exact_original_translation_substrings', await cue(page, 'split-1').locator('.translation mark').textContent() === '但我们忽略了' && await cue(page, 'split-2').locator('.translation mark').textContent() === '人们所需的时间');
    await page.locator('#mode-transcript').click();
    check(label + '_source_only_still_finds_saved_translation_with_labeled_preview', await page.locator('.translation').count() === 0 && await cue(page, 'split-1').locator('.phrase-match').getAttribute('data-language') === 'zh' && await cue(page, 'split-1').locator('.phrase-match mark').textContent() === TRANSLATED_PHRASE);
    const reveal = cue(page, 'split-1').locator('.phrase-show-translation');await reveal.focus();await page.keyboard.press('Enter');
    check(label + '_keyboard_reveal_opens_the_matched_translation', await cue(page, 'split-1').locator('.translation mark').textContent() === '但我们忽略了' && (await stored(page)).translation_view === 'zh' && await cue(page, 'split-1').evaluate(node => node === document.activeElement));
    await screenshot(page, label + '-translation');

    // A short second document verifies same-ID isolation, live annotation filters,
    // exact approved question scope and source correction without provider work.
    const small = phraseSearchFixture(6);small.title = 'Short authored phrase · ' + label;small.notes['split-1'] = 'Local private note';small.segments[2].saved_excerpt = true;
    await importDocument(page, small);await enter(page, SOURCE_PHRASE);
    await page.locator('#filter-notes').click();check(label + '_notes_filter_intersects_phrase_contributors', JSON.stringify(await renderedIds(page)) === JSON.stringify(['split-1']));
    await cue(page, 'split-1').locator('.note-button').click();await page.locator('#note').fill('');
    check(label + '_note_removal_refreshes_search_membership', (await renderedIds(page)).length === 0);await page.locator('#close-note').click();
    await page.locator('#filter-excerpts').click();check(label + '_excerpt_filter_intersects_phrase_contributors', JSON.stringify(await renderedIds(page)) === JSON.stringify(['split-2']));
    check(label + '_lone_second_contributor_has_joined_preview', await cue(page, 'split-2').locator('.phrase-match mark').textContent() === SOURCE_PHRASE);
    await page.locator('#filter-all').click();await showLanguageTools(page);await page.locator('#ai-task').selectOption('question');
    await page.locator('#ai-filtered').check();await page.locator('#ai-question').fill('Explain this exact phrase.');await page.locator('#check-ai').click();
    await page.waitForFunction(() => !document.querySelector('#ask-ai').disabled);
    const count = injected.length;await page.locator('#ask-ai').click();check(label + '_unconfirmed_question_sends_nothing', injected.length === count);
    await page.locator('#ai-consent').check();await page.locator('#ask-ai').click();
    await page.waitForFunction(() => !document.querySelector('#ask-ai').disabled);
    check(label + '_approved_question_contains_only_two_original_contributors', injected.length === count + 1 && JSON.stringify(injected.at(-1).body.segments) === JSON.stringify([{id: 'split-1', text: 'but we had left out'}, {id: 'split-2', text: 'the time people needed'}]));
    check(label + '_question_contains_no_private_annotation', !JSON.stringify(injected).includes('Local private note'));
    await page.locator('#language-panel > summary').click();
    await openCueActions(cue(page, 'split-1'));await cue(page, 'split-1').locator('.edit-button').click();
    await page.locator('#edit-segment').fill('but we included');await page.locator('#save-edit').click();
    check(label + '_source_edit_removes_both_old_phrase_contributors', (await renderedIds(page)).length === 0);
    await enter(page, TRANSLATED_PHRASE);check(label + '_stale_translation_never_satisfies_joined_phrase', (await renderedIds(page)).length === 0);
    await enter(page, 'included the time');check(label + '_new_source_phrase_is_immediately_searchable', JSON.stringify(await renderedIds(page)) === JSON.stringify(['split-1', 'split-2']));

    await openLibrary(page, true);await page.locator('#library-scope').selectOption('text');await page.locator('#library-search').fill(TRANSLATED_PHRASE);
    check(label + '_library_original_plus_note_scope_excludes_translations', await page.locator('.library-hit').count() === 0);
    await page.locator('#library-search').fill(SOURCE_PHRASE);
    check(label + '_library_cross_cue_preview_is_source_backed', await page.locator('.library-hit').first().locator('mark').textContent() === SOURCE_PHRASE);
    await page.locator('.library-hit').first().click();
    check(label + '_library_hit_returns_to_exact_original_contributor', await cue(page, 'split-0').evaluate(node => node === document.activeElement));
    await page.locator('#library-file').setInputFiles({name: 'authored-phrase-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({format: 'coconut-library', version: 1, documents: [before], active: before.key}))});
    await page.waitForFunction(title => document.querySelector('#title').textContent === title && document.querySelector('#library-file').value === '' && document.querySelector('#save-status').dataset.state === 'saved', fixture.title);
    if (await page.locator('#passage-search').isVisible()) await page.locator('#passage-search').click();
    await enter(page, SOURCE_PHRASE);
    check(label + '_native_backup_restore_rebuilds_the_original_phrase_results', (await page.locator('#search-status').textContent()).includes('找到 591 个片段'));
    await page.reload();await page.locator('#title').waitFor();
    if (await page.locator('#passage-search').isVisible()) await page.locator('#passage-search').click();
    else await page.locator('#mode-bilingual').click();
    await enter(page, TRANSLATED_PHRASE);
    check(label + '_reload_preserves_fresh_saved_translation_phrase_results', (await page.locator('#search-status').textContent()).includes('找到 590 个片段') && await cue(page, 'split-2').locator('.phrase-match mark').textContent() === TRANSLATED_PHRASE);
    check(label + '_only_local_injected_requests_have_occurred', mutations === 0 && external === 0 && errors.length === 0);
    await context.close();
  }
  check('no_external_requests_unexpected_writes_or_browser_errors', external === 0 && mutations === 0 && errors.length === 0);
  console.log(JSON.stringify({suite: 'cross-cue-phrase-search', status: 'passed', checks, injectedQuestions: injected.length}));
} catch (error) {
  console.error(JSON.stringify({suite: 'cross-cue-phrase-search', status: 'failed', stage, checks, errors, error: error.message}));process.exitCode = 1;
} finally {
  await browser?.close();await new Promise(resolve => server?.listening ? server.shutdown(resolve) : resolve());
}
