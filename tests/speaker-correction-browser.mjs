/** CI-only native Chromium speaker correction proof. Every cue, translation,
 * note and saved answer is an authored fixture. The only network destination is
 * a read-only static loopback server; no media, provider, account or model.
 * node --check validates syntax only, never this real-browser journey. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium, expect, waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {openTranscriptTools} from './helpers/reading-tools-browser.mjs';
import {openCueActions} from './cue-actions-browser.mjs';

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Run the real speaker correction browser journey in GitHub Actions only.');

const root = new URL('../reader/', import.meta.url);
const SOURCE = 'SPEAKER_00', OTHER = 'SPEAKER_01', RENAMED = '主持人 <Guest>', SINGLE = '单句修正', RECOVERED = '恢复保存 <主持>';
const checks = [], errors = [];
let server, browser, page, stage = 'setup', external = 0, mutations = 0;
function check(name, value) {stage = name; assert.ok(value, name); checks.push(name);}
function fixture(label) {
  return {
    schema_version: 1, title: 'Authored speaker correction ' + label, language: 'en', translation_view: 'zh',
    project_note: 'PRIVATE authored project note; never source speech.',
    notes: {'speaker-0': 'PRIVATE source speaker note.', 'speaker-200': 'PRIVATE later speaker note.'},
    readingPosition: 'speaker-0',
    ai_answers: [{purpose: 'question', question: 'Authored saved question.', answer: 'PRIVATE authored answer; no model was called.', citations: ['speaker-0'], provider: 'authored_fixture'}],
    segments: Array.from({length: 207}, (_, i) => {
      const text = i === 205 ? 'Unlabeled authored source. No speaker was identified.' :
        i === 206 ? '[SPEAKER_00] Mixed authored source. [SPEAKER_01] Keep these literal labels.' :
          `Authored source ${String(i).padStart(3, '0')}: SPEAKER_00 is literal source text.`;
      return {
        id: 'speaker-' + i, start: i * 4, end: i * 4 + 2, text,
        speaker: i >= 205 ? null : i % 5 === 1 ? OTHER : SOURCE,
        ...(i === 0 ? {original_text: 'Original authored wording before a separate text edit.'} : {}),
        ...(i === 0 || i === 200 ? {saved_excerpt: true} : {}),
        translations: {zh: {text: '自写译文 ' + i, source_text: text, source_language: 'en', document_language: 'en', provider: 'authored_fixture'}},
      };
    }),
  };
}
// Explicitly compare all non-speaker content against the imported document.
// Imported normalization is not conflated with subsequent correction changes.
function untouched(doc) {
  return {
    segments: doc.segments.map(({id, start, end, text, original_text, translations, saved_excerpt}) => ({id, start, end, text, original_text, translations, saved_excerpt})),
    notes: doc.notes, project_note: doc.project_note, readingPosition: doc.readingPosition,
    ai_answers: doc.ai_answers, exact_excerpts: doc.exact_excerpts, timestamp_bookmarks: doc.timestamp_bookmarks,
    provenance: doc.provenance, summary_runs: doc.summary_runs,
  };
}
function speakerMap(doc) {return doc.segments.map(({id, speaker}) => ({id, speaker}));}
async function activeSaved() {
  return page.evaluate(async () => (await readPersistedLibrary()).documents.find(doc => doc.key === sessionStorage.getItem('coconut-reader-active-v1')));
}
async function savedSpeakers(expected) {
  await waitForPersistedLibrary(page, async expected => {
    const key = sessionStorage.getItem('coconut-reader-active-v1');
    const doc = (await readPersistedLibrary()).documents.find(doc => doc.key === key);
    return JSON.stringify(doc?.segments.map(({id, speaker}) => ({id, speaker}))) === JSON.stringify(expected);
  }, expected);
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved');
  return activeSaved();
}
async function choose(doc) {
  await page.locator('#file').setInputFiles({name: 'authored-speakers.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc))});
  await expect(page.locator('#title')).toHaveText(doc.title);
  await page.waitForFunction(() => document.getElementById('file').value === '');
  await page.locator('#mode-transcript').click();
  await openTranscriptTools(page);
  await page.evaluate(() => libraryStore.flush());
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved');
}
async function search(text) {
  await openTranscriptTools(page);
  if (await page.locator('#clear-search').isVisible()) await page.locator('#clear-search').click();
  await page.locator('#search').fill(text);
  await expect(page.locator('#transcript .segment')).toHaveCount(text ? 1 : 100);
}
async function openEditor(id, {keyboard = false} = {}) {
  const row = page.locator('.segment[data-segment-id="' + id + '"]');
  if (keyboard && await row.locator('.cue-more').count()) {
    if (!await row.locator('.cue-more').evaluate(node => node.open)) {
      await row.locator('.cue-more > summary').focus(); await page.keyboard.press('Enter');
    }
  } else await openCueActions(row);
  const action = row.locator('.speaker-correction-button');
  await expect(action).toBeVisible();
  if (keyboard) {await action.focus(); await page.keyboard.press('Enter');} else await action.click();
  await expect(page.locator('#speaker-dialog')).toBeVisible();
  await expect(page.locator('#speaker-scope')).toHaveValue('cue');
  await expect(page.locator('#speaker-action')).toHaveValue('rename');
  return action;
}
async function closeEditor(method = 'cancel') {
  // If the implementation warns before discarding a changed draft, exercise
  // the native confirmation; a cancel never authorizes a content write.
  const acceptDiscard = dialog => dialog.accept();
  page.on('dialog', acceptDiscard);
  try {
    if (method === 'escape') await page.keyboard.press('Escape');
    else await page.locator('#cancel-speaker').click();
    await expect(page.locator('#speaker-dialog')).toBeHidden();
  } finally {page.off('dialog', acceptDiscard);}
}
async function submit(expected) {
  await expect(page.locator('#save-speaker')).toBeEnabled();
  await page.locator('#save-speaker').click();
  const doc = await savedSpeakers(expected);
  await expect(page.locator('#speaker-dialog')).toBeHidden();
  return doc;
}
async function exportMenu() {
  if (!await page.locator('#export-menu').evaluate(node => node.open)) await page.locator('#export-menu > summary').click();
}
async function download(selector, {menu = true} = {}) {
  if (menu) await exportMenu();
  const [item] = await Promise.all([page.waitForEvent('download'), page.locator(selector).click()]);
  assert.equal(await item.failure(), null);
  const chunks = []; for await (const chunk of await item.createReadStream()) chunks.push(chunk);
  if (menu) await page.locator('#export-menu > summary').click();
  return {name: item.suggestedFilename(), text: Buffer.concat(chunks).toString('utf8')};
}
async function capture(name) {
  if (!process.env.COCONUT_UI_SCREENSHOTS) return;
  await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS, {recursive: true});
  await page.screenshot({path: path.join(process.env.COCONUT_UI_SCREENSHOTS, 'speaker-correction-' + name + '.png'), fullPage: false, animations: 'disabled'});
}
async function geometry(label) {
  check(label + '_native_accessible_modal', await page.locator('#speaker-dialog').evaluate(node => node instanceof HTMLDialogElement && node.open && node.matches(':modal')));
  check(label + '_named_input_and_readonly_original', await page.locator('#speaker-name').evaluate(node => node.labels?.length > 0 || !!node.getAttribute('aria-label')) && await page.locator('#speaker-original').evaluate(node => !node.isContentEditable && (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) || node.readOnly)));
  check(label + '_modal_fits_without_horizontal_overflow', await page.locator('#speaker-dialog').evaluate(node => {
    const rect = node.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && node.scrollWidth <= node.clientWidth && document.documentElement.scrollWidth <= innerWidth;
  }));
  check(label + '_buttons_have_touch_targets', await page.locator('#speaker-dialog button:visible').evaluateAll(nodes => nodes.every(node => {
    const rect = node.getBoundingClientRect(); return rect.width >= 44 && rect.height >= 44;
  })));
  await page.locator('#speaker-name').focus();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    check(label + '_tab_stays_in_modal_' + i, await page.evaluate(() => document.getElementById('speaker-dialog').contains(document.activeElement)));
  }
  await page.locator('#speaker-action').focus();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Shift+Tab');
    check(label + '_reverse_tab_stays_in_modal_' + i, await page.evaluate(() => document.getElementById('speaker-dialog').contains(document.activeElement)));
  }
  // Invalid input disables Apply; the last enabled action must still wrap.
  const unchangedName = await page.locator('#speaker-name').inputValue();
  await page.locator('#speaker-name').fill('   ');
  await expect(page.locator('#save-speaker')).toBeDisabled();
  await page.locator('#cancel-speaker').focus(); await page.keyboard.press('Tab');
  await expect(page.locator('#speaker-action')).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(page.locator('#cancel-speaker')).toBeFocused();
  check(label + '_disabled_apply_preserves_both_tab_boundaries', true);
  await page.locator('#speaker-name').fill(unchangedName);
}

try {
  server = createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) {mutations++; res.writeHead(405).end(); return;}
    const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if (!/^[a-z-]+\.(html|js|css|png|webmanifest)$/.test(name)) {res.writeHead(404, {'Content-Type': 'application/json'}).end('{"error":"authored static fixture only"}'); return;}
    try {
      const bytes = await fs.readFile(new URL(name, root));
      res.writeHead(200, {'Content-Type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'text/html'}).end(req.method === 'HEAD' ? undefined : bytes);
    } catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true});
  for (const [label, viewport] of [['desktop', {width: 1360, height: 1000}], ['mobile', {width: 390, height: 844}]]) {
    stage = label + '_setup';
    const context = await browser.newContext({viewport, acceptDownloads: true, serviceWorkers: 'block'});
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) {mutations++; await route.abort(); return;}
      if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) await route.continue();
      else {external++; await route.abort();}
    });
    await context.addInitScript(() => {
      window.__speakerWrites = 0;
      for (const method of ['put', 'add', 'delete']) {
        const original = IDBObjectStore.prototype[method];
        IDBObjectStore.prototype[method] = function (...args) {
          if (this.transaction.db.name === 'coconut-reader-library-v1' && this.name === 'documents') window.__speakerWrites++;
          return original.apply(this, args);
        };
      }
    });
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(label + ': ' + error.message));
    await page.goto(origin); await choose(fixture(label));
    const baseline = await activeSaved(), initialSpeakers = speakerMap(baseline);
    check(label + '_fixture_really_crosses_three_rendered_pages', baseline.segments.length === 207 && await page.locator('#transcript .segment').count() === 100);

    stage = label + '_keyboard_cancel_and_noop';
    const action = await openEditor('speaker-0', {keyboard: true});
    await expect(page.locator('#speaker-original')).toContainText(SOURCE);
    await expect(page.locator('#speaker-name')).toHaveValue(SOURCE);
    await geometry(label);
    const writesBefore = await page.evaluate(() => window.__speakerWrites);
    await expect(page.locator('#speaker-count')).toContainText('将修改 0 段');
    await page.locator('#save-speaker').click();
    await expect(page.locator('#speaker-dialog')).toBeHidden(); await expect(action).toBeFocused();
    await openEditor('speaker-0', {keyboard: true});
    await page.locator('#speaker-name').fill('   ');
    await expect(page.locator('#save-speaker')).toBeDisabled();
    await expect(page.locator('#speaker-error')).not.toBeEmpty();
    await page.locator('#speaker-name').fill('Discard this authored draft');
    await closeEditor('escape'); await expect(action).toBeFocused();
    await page.evaluate(() => libraryStore.flush());
    assert.deepEqual(await activeSaved(), baseline);
    check(label + '_cancel_escape_and_noop_never_write_content', await page.evaluate(() => window.__speakerWrites) === writesBefore);

    // A group operation begins on page two with only one search result visible.
    // It must still change named cues on pages one and three, outside all filters.
    stage = label + '_filtered_whole_speaker';
    await page.locator('#next-page').click();
    check(label + '_started_on_second_page', await page.locator('.segment[data-segment-id="speaker-100"]').isVisible());
    await search('Authored source 200:');
    await page.locator('#speaker-filter').selectOption(JSON.stringify(SOURCE));
    await expect(page.locator('#transcript .segment')).toHaveCount(1);
    await openEditor('speaker-200', {keyboard: true});
    await page.locator('#speaker-scope').selectOption('speaker');
    await page.locator('#speaker-name').fill(RENAMED);
    const groupPreview = await page.locator('#speaker-preview').textContent();
    const groupSize = initialSpeakers.filter(cue => cue.speaker === SOURCE).length;
    check(label + '_bounded_preview_has_source_time_text_and_target', groupPreview.includes('00:00') && groupPreview.includes(baseline.segments[0].text) && groupPreview.includes(RENAMED) && await page.locator('#speaker-preview > p').count() === 8);
    await expect(page.locator('#speaker-count')).toContainText('范围内 ' + groupSize + ' 段，将修改 ' + groupSize + ' 段');
    check(label + '_speaker_label_is_rendered_as_text_not_markup', await page.locator('#speaker-preview guest').count() === 0);
    await capture(label + '-group-preview');
    const renamedSpeakers = initialSpeakers.map(cue => ({...cue, speaker: cue.speaker === SOURCE ? RENAMED : cue.speaker}));
    const renamed = await submit(renamedSpeakers);
    assert.deepEqual(untouched(renamed), untouched(baseline));
    check(label + '_only_changed_cues_gain_original_speaker_history', renamed.segments.every((cue, i) => initialSpeakers[i].speaker === SOURCE ? cue.original_speaker === SOURCE : !Object.hasOwn(cue, 'original_speaker')));
    check(label + '_group_rename_ignores_filters_and_page_boundaries', renamed.segments[0].speaker === RENAMED && renamed.segments[200].speaker === RENAMED && renamed.segments[204].speaker === RENAMED && renamed.segments[1].speaker === OTHER && renamed.segments[205].speaker === null && renamed.segments[206].speaker === null);

    stage = label + '_single_cue_and_restore';
    await search('Authored source 200:');
    await openEditor('speaker-200');
    await page.locator('#speaker-name').fill(SINGLE);
    const singleSpeakers = renamedSpeakers.map(cue => ({...cue, speaker: cue.id === 'speaker-200' ? SINGLE : cue.speaker}));
    const single = await submit(singleSpeakers);
    assert.deepEqual(untouched(single), untouched(baseline));
    check(label + '_default_scope_changes_exactly_one_cue', single.segments.filter(cue => cue.speaker === SINGLE).length === 1 && single.segments[0].speaker === RENAMED);
    await openEditor('speaker-200');
    await page.locator('#speaker-action').selectOption('restore');
    await expect(page.locator('#speaker-preview')).toContainText(SOURCE);
    const restoredSingleSpeakers = singleSpeakers.map(cue => ({...cue, speaker: cue.id === 'speaker-200' ? SOURCE : cue.speaker}));
    await submit(restoredSingleSpeakers);
    check(label + '_single_restore_uses_imported_label_not_previous_rename', (await activeSaved()).segments[200].speaker === SOURCE);

    // Merge into an existing label only after a preview. Restoring that current
    // group must use each cue's own original label, not the opened cue's label.
    stage = label + '_merge_and_per_cue_restore';
    await search('Authored source 000:');
    await openEditor('speaker-0');
    await page.locator('#speaker-scope').selectOption('speaker');
    await page.locator('#speaker-name').fill(OTHER);
    await expect(page.locator('#speaker-merge')).toBeVisible();
    check(label + '_merge_is_explicit_before_save', (await page.locator('#speaker-merge').textContent()).trim().length > 0);
    await closeEditor();
    assert.deepEqual(speakerMap(await activeSaved()), restoredSingleSpeakers);
    await openEditor('speaker-0'); await page.locator('#speaker-scope').selectOption('speaker'); await page.locator('#speaker-name').fill(OTHER);
    const mergedSpeakers = restoredSingleSpeakers.map(cue => ({...cue, speaker: cue.speaker === RENAMED ? OTHER : cue.speaker}));
    await submit(mergedSpeakers);
    await openEditor('speaker-0'); await page.locator('#speaker-scope').selectOption('speaker'); await page.locator('#speaker-action').selectOption('restore');
    const restorePreview = await page.locator('#speaker-preview').textContent();
    check(label + '_restore_preview_discloses_original_targets', restorePreview.includes(SOURCE) && restorePreview.includes(OTHER));
    const restored = await submit(initialSpeakers);
    assert.deepEqual(untouched(restored), untouched(baseline));
    check(label + '_merged_group_restores_each_original_label', true);

    stage = label + '_unlabeled_and_mixed_cues';
    await search('Unlabeled authored source.');
    check(label + '_unlabeled_cue_has_no_identity_inference_action', await page.locator('#transcript .speaker-correction-button').count() === 0);
    await search('Mixed authored source.');
    check(label + '_mixed_inline_labels_are_not_structural_speakers', await page.locator('#transcript .speaker-correction-button').count() === 0 && await page.locator('#transcript .words').textContent() === baseline.segments[206].text);

    stage = label + '_failed_save_backup_and_global_retry';
    await search('Authored source 000:');
    await page.evaluate(() => failContentWrites());
    await openEditor('speaker-0'); await page.locator('#speaker-name').fill(RECOVERED); await page.locator('#save-speaker').click();
    await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'failed');
    assert.deepEqual(speakerMap(await activeSaved()), initialSpeakers);
    if (await page.locator('#speaker-dialog').isVisible()) await closeEditor();
    await expect(page.locator('#retry-save')).toBeVisible();
    const rescue = JSON.parse((await download('#export-unsaved-documents', {menu: false})).text);
    const rescued = rescue.documents.find(doc => doc.key === baseline.key);
    const recoveredSpeakers = initialSpeakers.map(cue => ({...cue, speaker: cue.id === 'speaker-0' ? RECOVERED : cue.speaker}));
    assert.equal(rescue.format, 'coconut-library'); assert.deepEqual(speakerMap(rescued), recoveredSpeakers);
    assert.deepEqual(untouched(rescued), untouched(baseline));
    check(label + '_failure_keeps_complete_latest_correction_in_backup', await page.locator('#save-status').getAttribute('data-state') === 'failed');
    await page.evaluate(() => restoreContentWrites()); await page.locator('#retry-save').click();
    const recovered = await savedSpeakers(recoveredSpeakers);
    await page.reload(); await page.locator('#mode-transcript').click(); await search('Authored source 000:');
    await expect(page.locator('#transcript .speaker')).toHaveText(RECOVERED);
    assert.deepEqual(speakerMap(await activeSaved()), recoveredSpeakers);
    check(label + '_global_retry_commits_and_real_reload_retains_correction', true);

    stage = label + '_actual_json_vtt_txt_downloads';
    const json = JSON.parse((await download('#export')).text);
    assert.deepEqual(speakerMap(json), recoveredSpeakers); assert.deepEqual(untouched(json), untouched(baseline));
    await exportMenu(); await page.locator('#subtitle-format').selectOption('vtt'); if (await page.locator('#subtitle-bilingual').isChecked()) await page.locator('#subtitle-bilingual').uncheck();
    const vtt = (await download('#export-subtitles')).text;
    check(label + '_actual_vtt_uses_corrected_escaped_voice_and_original_times', vtt.startsWith('WEBVTT') && vtt.includes('<v 恢复保存 &lt;主持&gt;>') && vtt.includes('00:00:00.000 --> 00:00:02.000') && vtt.includes('00:13:44.000 --> 00:13:46.000') && vtt.includes(baseline.segments[200].text));
    await exportMenu(); if (await page.locator('#text-bilingual').isChecked()) await page.locator('#text-bilingual').uncheck();
    const txt = await download('#export-text');
    check(label + '_actual_txt_has_whole_source_and_current_speakers', txt.name.endsWith('.txt') && txt.text.includes('说话人：' + RECOVERED) && txt.text.includes('说话人：' + OTHER) && baseline.segments.every(cue => txt.text.includes(cue.text)) && !txt.text.includes('PRIVATE'));
    assert.deepEqual(untouched(recovered), untouched(baseline));
    check(label + '_exports_ignore_single_result_filter_and_keep_non_speaker_data', json.segments.length === 207);
    // A real reload retained the correction history as well as its displayed name.
    await openEditor('speaker-0'); await page.locator('#speaker-action').selectOption('restore');
    await expect(page.locator('#speaker-preview')).toContainText(SOURCE);
    await submit(initialSpeakers);
    check(label + '_restoration_history_survives_failed_save_retry_and_reload', true);
    stage = label + '_actual_json_reimport';
    await choose({...json, title: 'Restored authored speakers ' + label});
    assert.deepEqual(speakerMap(await activeSaved()), recoveredSpeakers);
    assert.deepEqual(untouched(await activeSaved()), untouched(baseline));
    await search('Authored source 000:');
    await openEditor('speaker-0'); await page.locator('#speaker-action').selectOption('restore');
    await expect(page.locator('#speaker-preview')).toContainText(SOURCE);
    await submit(initialSpeakers);
    check(label + '_actual_json_reimport_preserves_corrected_labels_and_restorable_history', true);
    await context.close();
  }
  check('no_external_requests_mutations_models_or_page_errors', external === 0 && mutations === 0 && errors.length === 0);
  console.log(JSON.stringify({suite: 'speaker-correction', status: 'passed', checks}));
} catch (error) {
  let focus;
  try {focus = await page.evaluate(() => {const active=document.activeElement,dialog=document.getElementById('speaker-dialog');return {activeTag:active?.tagName,activeId:active?.id,activeClass:active?.className,documentHasFocus:document.hasFocus(),dialogOpen:dialog?.open,dialogModal:dialog?.matches(':modal'),inside:dialog?.contains(active),controls:[...dialog.querySelectorAll('input,select,button,[tabindex]')].map(node=>({id:node.id,disabled:node.disabled,tabIndex:node.tabIndex,hidden:node.hidden}))};});} catch {}
  console.error(JSON.stringify({suite: 'speaker-correction', status: 'failed', stage, checks, errors, focus, error: error.message}));
  try {await capture('failure');} catch {}
  process.exitCode = 1;
} finally {await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));}
