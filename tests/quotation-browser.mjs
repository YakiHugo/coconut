/** CI-only native Chromium selection and clipboard acceptance. All text,
 * translations, annotations and URLs are authored fixtures. A static loopback
 * server is the only allowed network destination; there is no model or account.
 * Clipboard methods are injected and audited, never read from the host system.
 * A syntax check is not evidence that this browser journey passed. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, expect} from './helpers/browser-storage.mjs';
import {openLibraryTools} from './helpers/library-tools-browser.mjs';
import {openCueActions} from './cue-actions-browser.mjs';
import {passageReadingFixture} from './helpers/passage-reading-fixture.mjs';

if (!process.env.CI) throw new Error('Quotation browser acceptance is CI-only; use the authored Node/HappyDOM suite locally.');

const root = fileURLToPath(new URL('../', import.meta.url));
const checks = [], errors = [];
let server, browser, page, stage = 'setup', external = 0, mutations = 0;
function check(name, value) {stage = name; assert.ok(value, name); checks.push(name);}
async function settled() {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function saved() {
  await page.evaluate(() => libraryStore.flush());
  return page.evaluate(() => readPersistedLibrary());
}
async function clipboardAudit() {return page.evaluate(() => window.__quotationClipboard);}
async function clearSelection() {
  await page.evaluate(() => getSelection().removeAllRanges());
  await settled();
}
async function capture(name) {
  if (!process.env.COCONUT_UI_SCREENSHOTS) return;
  await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS, {recursive: true});
  await page.screenshot({path: path.join(process.env.COCONUT_UI_SCREENSHOTS, 'quotation-' + name + '.png'), fullPage: false, animations: 'disabled'});
}
async function closeQuotation(action, method = 'escape') {
  if (method === 'escape') await page.keyboard.press('Escape');
  else await page.locator('#quotation-close').click();
  await expect(page.locator('#quotation-dialog')).toBeHidden();
  await expect(action).toBeFocused();
}
async function nativeSelection(kind = 'original') {
  const selected = await page.evaluate(kind => {
    const passages = document.querySelectorAll('#passage-body .passage');
    const source = passages[0].querySelectorAll('.passage-original .passage-cue');
    let start = source[0].firstChild, end = source[2].firstChild;
    let startOffset = 4, endOffset = 8;
    if (kind === 'translation') {
      end = passages[0].querySelector('.passage-translation .passage-cue').firstChild;
      endOffset = 3;
    } else if (kind === 'ui') {
      end = passages[0].querySelector('.passage-quote').firstChild;
      endOffset = end.textContent.length;
    } else if (kind === 'paragraphs') {
      end = passages[1].querySelector('.passage-original .passage-cue').firstChild;
      endOffset = 8;
    } else if (kind === 'translation-only') {
      start = end = passages[0].querySelector('.passage-translation .passage-cue').firstChild;
      startOffset = 0; endOffset = 4;
    }
    const range = document.createRange();
    range.setStart(start, startOffset); range.setEnd(end, endOffset);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return selection.toString();
  }, kind);
  await settled();
  return selected;
}
async function noReadyPreview(label) {
  check(label + '_has_no_quote_and_cannot_copy', await page.locator('#quotation-preview').inputValue() === '' && await page.locator('#quotation-copy').isDisabled());
  check(label + '_explains_source_selection', (await page.locator('#quotation-status').textContent()).trim().length > 0);
}
async function modalGeometry(label) {
  check(label + '_is_a_real_native_modal', await page.locator('#quotation-dialog').evaluate(node => node instanceof HTMLDialogElement && node.open && node.matches(':modal')));
  check(label + '_visible_dialog_actions_have_touch_targets', await page.locator('#quotation-dialog button:visible').evaluateAll(nodes => nodes.every(node => {const rect=node.getBoundingClientRect();return rect.height>=44&&rect.width>=44;})));
  check(label + '_dialog_fits_the_viewport', await page.locator('#quotation-dialog').evaluate(node => {
    const rect = node.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && node.scrollWidth <= node.clientWidth && document.documentElement.scrollWidth <= innerWidth;
  }));
}
async function readyQuotationLayout(label) {
  await expect(page.locator('#quotation-selector')).toBeHidden();
  await expect(page.locator('#quotation-reselect')).toBeVisible();
  check(label + '_preview_and_primary_actions_are_in_first_view', await page.locator('#quotation-dialog').evaluate(dialog => {
    const preview=dialog.querySelector('#quotation-preview').getBoundingClientRect();
    const actions=['quotation-save','quotation-copy','quotation-close'].map(id=>document.getElementById(id).getBoundingClientRect());
    return dialog.scrollTop===0&&preview.top>=0&&preview.bottom<=innerHeight&&actions.every(rect=>rect.top>=preview.bottom&&rect.bottom<=innerHeight&&rect.left>=0&&rect.right<=innerWidth);
  }));
  await expect(page.locator('#quotation-preview')).toBeFocused();
}
async function assertPreview(label, selected, fixture) {
  const preview = await page.locator('#quotation-preview').inputValue();
  const expected = selected + '\n\n—— ' + fixture.title +
    ' · 00:00:00.000–00:00:02.400\n来源：' + fixture.source_url + '?t=0';
  check(label + '_retains_the_exact_selected_text', preview.startsWith(selected + '\n\n'));
  check(label + '_has_complete_exact_source_attribution', preview === expected);
  check(label + '_excludes_translations_notes_and_other_cues', !preview.includes(fixture.segments[0].translations.zh.text) && !preview.includes(fixture.notes['split-2']) && !preview.includes(fixture.project_note) && !preview.includes(fixture.segments[3].text));
  check(label + '_preview_is_readonly_and_copy_is_explicit', await page.locator('#quotation-preview').evaluate(node => node instanceof HTMLTextAreaElement && node.readOnly) && await page.locator('#quotation-copy').isEnabled());
  return preview;
}
async function keyboardSelectSource(from, length) {
  const source = page.locator('#quotation-source'), phases=[];
  const observe=async phase=>{const value=await source.evaluate(node=>({start:node.selectionStart,end:node.selectionEnd,direction:node.selectionDirection,activeElement:document.activeElement?.id,text:node.value.slice(node.selectionStart,node.selectionEnd)}));phases.push({phase,...value});return value;};
  await source.focus(); await observe('focused');
  await page.keyboard.press('Control+Home'); await observe('home');
  for (let i = 0; i < from; i++) await page.keyboard.press('ArrowRight');
  await observe('moved-to-start');
  for (let i = 0; i < length; i++) await page.keyboard.press('Shift+ArrowRight');
  const result=await observe('extended-selection');
  console.log(JSON.stringify({keyboardSelection:{requestedFrom:from,requestedLength:length,phases}}));
  return result.text;
}
async function previewKeyboardSelection() {
  await page.locator('#quotation-preview-selection').focus(); await page.keyboard.press('Enter');
}
async function newlineDisclosure(label) {
  const visibleText = await page.locator('#quotation-dialog').innerText();
  check(label + '_discloses_manual_copy_newline_normalization', /手动复制采用预览中的换行格式/.test(visibleText));
}

try {
  server = createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) {mutations++; res.writeHead(405).end(); return;}
    const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if (!/^[a-z-]+\.(html|js|css|png|webmanifest)$/.test(name)) {
      res.writeHead(404, {'Content-Type': 'application/json'}).end('{"error":"authored static fixture only"}'); return;
    }
    try {
      const bytes = await fs.readFile(path.join(root, 'reader', name));
      res.writeHead(200, {'Content-Type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'text/html'}).end(bytes);
    } catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true});
  for (const [label, viewport] of [['desktop', {width: 1360, height: 1000}], ['mobile', {width: 390, height: 844}]]) {
    stage = label + '_setup';
    const context = await browser.newContext({viewport, serviceWorkers: 'block'});
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) {mutations++; await route.abort(); return;}
      if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) await route.continue();
      else {external++; await route.abort();}
    });
    await context.addInitScript(() => {
      const audit = window.__quotationClipboard = {writes: [], reads: 0, legacyWrites: 0, reject: false};
      Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {
        async writeText(value) {
          audit.writes.push(String(value));
          if (audit.reject) throw new DOMException('Authored clipboard rejection', 'NotAllowedError');
        },
        async readText() {audit.reads++; throw new Error('The quote flow must not read the clipboard');},
        async read() {audit.reads++; throw new Error('The quote flow must not read the clipboard');},
      }});
      const original = document.execCommand.bind(document);
      document.execCommand = (command, ...args) => {
        if (String(command).toLowerCase() === 'copy') {audit.legacyWrites++; return false;}
        return original(command, ...args);
      };
    });
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message)); await page.goto(origin);
    const fixture = passageReadingFixture();
    fixture.title = '引用原文 · 自写跨片段验收 ' + label;
    fixture.segments = fixture.segments.slice(0, 120);
    // An authored identifier exercises supported timestamp-link formatting.
    // The link is never opened, and the route guard blocks every external host.
    fixture.source_url = 'https://youtu.be/authored-quotation';
    fixture.project_note = 'Authored private project note excluded from quotations.';
    fixture.timestamp_bookmarks = [{id: 'quotation-bookmark', time: 42, note: 'Authored private time bookmark.'}];
    fixture.ai_answers = [{purpose: 'question', question: 'Authored existing question.', answer: 'Authored saved answer; no model was called.', citations: ['split-2'], provider: 'Authored fixture'}];
    await page.locator('#file').setInputFiles({name: 'authored-quotation.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture))});
    await page.waitForFunction(title => document.querySelector('#title').textContent === title, fixture.title);
    await expect(page.locator('#passage-workspace')).toBeVisible();
    const before = await saved();
    const originalProse = await page.locator('#passage-body').textContent();
    const action = page.locator('.passage-quote').first();
    check(label + '_has_a_labeled_touch_target', await action.textContent() === '引用原文' && await action.evaluate(node => {const rect = node.getBoundingClientRect(); return rect.height >= 44 && rect.width >= 44;}));
    await action.evaluate(node => {
      window.__quotationPointer = [];
      for (const type of ['pointerdown', 'click']) node.addEventListener(type, event => {
        window.__quotationPointer.push({type, trusted: event.isTrusted, detail: event.detail});
      }, {once: true});
    });

    // Real DOM Range boundaries cross three original cue text nodes and their
    // separator nodes. The pointer action must retain the current selection.
    stage = label + '_native_range';
    const expectedSelected = fixture.segments[0].text.slice(4) + ' ' + fixture.segments[1].text + ' ' + fixture.segments[2].text.slice(0, 8);
    check(label + '_native_range_crosses_contiguous_original_cues', await nativeSelection() === expectedSelected);
    await action.click(); await expect(page.locator('#quotation-dialog')).toBeVisible();
    check(label + '_opens_with_a_real_pointer_gesture', await page.evaluate(() => {
      const events = window.__quotationPointer;
      return events.length === 2 && events.every(event => event.trusted) && events[0].type === 'pointerdown' && events[1].type === 'click' && events[1].detail === 1;
    }));
    await modalGeometry(label + '_native');
    const preview = await assertPreview(label + '_native', expectedSelected, fixture);
    await readyQuotationLayout(label + '_native');
    check(label + '_opening_and_preview_do_not_touch_clipboard', (await clipboardAudit()).writes.length === 0);
    await capture(label + '-native-preview');
    await page.locator('#quotation-copy').click();
    await expect.poll(async () => (await clipboardAudit()).writes.length).toBe(1);
    check(label + '_explicit_copy_writes_the_complete_visible_preview', (await clipboardAudit()).writes[0] === preview);
    await page.locator('#quotation-reselect').click();
    await expect(page.locator('#quotation-source')).toBeFocused();
    await noReadyPreview(label + '_explicit_reselect');
    check(label + '_explicit_reselect_is_keyboard_usable', await keyboardSelectSource(4,expectedSelected.length)===expectedSelected);
    await previewKeyboardSelection();
    check(label + '_reselection_keeps_exact_quote', await page.locator('#quotation-preview').inputValue()===preview);
    await readyQuotationLayout(label + '_reselected');
    await closeQuotation(action);

    // A cleared current selection must never reuse the previous quote.
    stage = label + '_no_stale_selection';
    await clearSelection(); await action.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#quotation-dialog')).toBeVisible();
    await noReadyPreview(label + '_cleared_selection');
    const source = page.locator('#quotation-source');
    const completeParagraph = fixture.segments.slice(0, 6).map(cue => cue.text).join(' ');
    check(label + '_source_picker_is_readonly_verbatim_original', await source.evaluate(node => node instanceof HTMLTextAreaElement && node.readOnly) && await source.inputValue() === completeParagraph);
    check(label + '_keyboard_selects_exact_cross_cue_source', await keyboardSelectSource(4, expectedSelected.length) === expectedSelected);
    await previewKeyboardSelection();
    const keyboardPreview = await assertPreview(label + '_keyboard', expectedSelected, fixture);
    check(label + '_keyboard_and_native_ranges_have_identical_quote_attribution', keyboardPreview === preview);
    check(label + '_keyboard_preview_does_not_write_clipboard', (await clipboardAudit()).writes.length === 1);

    // Rejected permission preserves every byte in a selectable readonly field.
    // No clipboard permission is granted and no system clipboard read occurs.
    await page.evaluate(() => {window.__quotationClipboard.reject = true;});
    await page.locator('#quotation-copy').click();
    await expect.poll(async () => (await clipboardAudit()).writes.length).toBe(2);
    await expect(page.locator('#quotation-status')).toContainText(/手动|无法|失败|不支持|拒绝/);
    check(label + '_clipboard_failure_retains_complete_preview', await page.locator('#quotation-preview').inputValue() === preview && (await clipboardAudit()).writes[1] === preview);
    await page.locator('#quotation-preview').focus(); await page.keyboard.press('Control+a');
    check(label + '_failed_copy_leaves_all_text_available_for_manual_copy', await page.locator('#quotation-preview').evaluate(node => node.readOnly && node.selectionStart === 0 && node.selectionEnd === node.value.length));
    await page.keyboard.press('x');
    check(label + '_manual_copy_preview_cannot_be_overwritten', await page.locator('#quotation-preview').inputValue() === preview);
    await capture(label + '-clipboard-fallback');
    await closeQuotation(action, 'button');

    // Mixed source/translation, translated-only, UI and multi-paragraph ranges
    // cannot silently become source quotes or revive a previously valid range.
    for (const kind of ['translation', 'translation-only', 'ui', 'paragraphs']) {
      stage = label + '_reject_' + kind;
      check(label + '_' + kind + '_fixture_has_an_actual_native_selection', (await nativeSelection(kind)).length > 0);
      await action.click(); await expect(page.locator('#quotation-dialog')).toBeVisible();
      await noReadyPreview(label + '_reject_' + kind);
      await expect(page.locator('#quotation-status')).toContainText('请只选择同一段原文中的连续文字');
      check(label + '_' + kind + '_does_not_copy_stale_text', (await clipboardAudit()).writes.length === 2);
      await closeQuotation(action);
    }

    // A valid selection in one paragraph does not authorize another paragraph's
    // action. Then a fresh range must still work after all rejection paths.
    stage = label + '_different_paragraph_action';
    await nativeSelection();
    const otherAction = page.locator('.passage-quote').nth(1);
    await otherAction.click(); await expect(page.locator('#quotation-dialog')).toBeVisible();
    await noReadyPreview(label + '_different_paragraph');
    await expect(page.locator('#quotation-status')).toContainText('请只选择同一段原文中的连续文字');
    await closeQuotation(otherAction);
    await nativeSelection(); await action.click();
    check(label + '_fresh_selection_recovers_after_rejections', await page.locator('#quotation-preview').inputValue() === preview);
    if (label === 'mobile') {
      await page.setViewportSize({width: 320, height: 700});
      await modalGeometry(label + '_320px'); await readyQuotationLayout(label + '_320px'); await capture(label + '-320px');
    }
    await closeQuotation(action);
    check(label + '_complete_document_is_unchanged', JSON.stringify(await saved()) === JSON.stringify(before));
    check(label + '_displayed_originals_translations_and_annotations_are_unchanged', await page.locator('#passage-body').textContent() === originalProse);
    const audit = await clipboardAudit();
    check(label + '_clipboard_is_never_read_or_written_implicitly', audit.reads === 0 && audit.legacyWrites === 0 && audit.writes.length === 2);

    // Textarea.value exposes CRLF as LF. Keyboard offsets must map back to the
    // untouched source string, and the explicit clipboard write must use that
    // original string rather than copying the browser-normalized preview.
    stage = label + '_crlf_keyboard_mapping';
    const newlines = passageReadingFixture(); newlines.segments = newlines.segments.slice(0, 120);
    newlines.title = '原始换行引用 · 自写验收 ' + label;
    newlines.source_url = 'https://youtu.be/authored-newlines';
    newlines.segments[0].text = 'before\r\nafter';
    newlines.segments[0].translations.zh.source_text = newlines.segments[0].text;
    await page.locator('#file').setInputFiles({name: 'authored-quotation-newlines.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(newlines))});
    await page.waitForFunction(title => document.querySelector('#title').textContent === title, newlines.title);
    await expect(page.locator('#passage-workspace')).toBeVisible();
    const newlineBefore = await saved();
    const newlineAction = page.locator('.passage-quote').first();
    check(label + '_native_source_retains_original_crlf', await page.locator('.passage-original .passage-cue').first().textContent() === 'before\r\nafter');
    await clearSelection(); await newlineAction.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#quotation-dialog')).toBeVisible();
    check(label + '_textarea_normalizes_crlf_to_lf', (await page.locator('#quotation-source').inputValue()).startsWith('before\nafter ') && !(await page.locator('#quotation-source').inputValue()).includes('\r'));
    const suffix = '\n\n—— ' + newlines.title +
      ' · 00:00:00.000–00:00:00.800\n来源：' + newlines.source_url + '?t=0';
    check(label + '_keyboard_selects_text_after_normalized_newline', await keyboardSelectSource(7, 5) === 'after');
    await previewKeyboardSelection();
    check(label + '_after_newline_maps_back_to_exact_source_offsets', await page.locator('#quotation-preview').inputValue() === 'after' + suffix);
    check(label + '_newline_preview_never_writes_clipboard', (await clipboardAudit()).writes.length === 2);

    await page.locator('#quotation-reselect').click();
    await expect(page.locator('#quotation-source')).toBeFocused();
    await noReadyPreview(label + '_crlf_reselect');
    check(label + '_keyboard_selects_across_normalized_newline', await keyboardSelectSource(0, 12) === 'before\nafter');
    await previewKeyboardSelection();
    const normalizedPreview = 'before\nafter' + suffix, originalPayload = 'before\r\nafter' + suffix;
    check(label + '_cross_crlf_preview_is_browser_normalized', await page.locator('#quotation-preview').inputValue() === normalizedPreview && await page.locator('#quotation-copy').isEnabled());
    await newlineDisclosure(label + '_crlf_preview');
    await page.evaluate(() => {window.__quotationClipboard.reject = false;});
    await page.locator('#quotation-copy').click();
    await expect.poll(async () => (await clipboardAudit()).writes.length).toBe(3);
    check(label + '_explicit_copy_preserves_the_original_crlf', (await clipboardAudit()).writes[2] === originalPayload && await page.locator('#quotation-preview').inputValue() === normalizedPreview);
    await page.evaluate(() => {window.__quotationClipboard.reject = true;});
    await page.locator('#quotation-copy').click();
    await expect.poll(async () => (await clipboardAudit()).writes.length).toBe(4);
    await expect(page.locator('#quotation-status')).toContainText(/手动|无法|失败|不支持|拒绝/);
    await newlineDisclosure(label + '_crlf_manual_fallback');
    check(label + '_crlf_failure_keeps_complete_selectable_preview', (await clipboardAudit()).writes[3] === originalPayload && await page.locator('#quotation-preview').inputValue() === normalizedPreview && await page.locator('#quotation-preview').evaluate(node => node.readOnly && node.selectionStart === 0 && node.selectionEnd === node.value.length));
    await capture(label + '-crlf-fallback'); await closeQuotation(newlineAction);
    check(label + '_both_complete_documents_remain_unchanged_after_crlf_flows', JSON.stringify(await saved()) === JSON.stringify(newlineBefore));
    const newlineAudit = await clipboardAudit();
    check(label + '_crlf_flow_never_reads_or_implicitly_writes_clipboard', newlineAudit.reads === 0 && newlineAudit.legacyWrites === 0 && newlineAudit.writes.length === 4);
    // Exact persistence is a separate, explicit user action after the copy-only invariants.
    await clearSelection(); await newlineAction.click();
    await page.locator('#quotation-source').evaluate(node => node.setSelectionRange(0,6));
    await page.locator('#quotation-preview-selection').click();
    const exactText = (await page.locator('#quotation-preview').inputValue()).split('\n\n—— ')[0];
    await page.locator('#quotation-save').click();
    await expect(page.locator('#quotation-save-status')).toContainText('已保存到本机');
    const exactLibrary = await saved();
    check(label + '_explicit_save_retains_exact_snapshot', exactLibrary.documents.some(doc => doc.exact_excerpts?.some(record => record.text === exactText && record.snapshot && record.created_at)));
    await closeQuotation(newlineAction);
    await clearSelection(); await newlineAction.click();
    await page.locator('#quotation-source').evaluate(node => node.setSelectionRange(0,6));
    await page.locator('#quotation-preview-selection').click(); await page.locator('#quotation-save').click();
    await expect(page.locator('#quotation-save-status')).toContainText('已保存到本机');
    check(label + '_same_snapshot_range_deduplicates', JSON.stringify(await saved()) === JSON.stringify(exactLibrary));
    await closeQuotation(newlineAction);
    await page.reload(); await expect(page.locator('#title')).toBeVisible();
    await openLibraryTools(page);
    await page.locator('#open-library-notebook').click();
    await expect(page.locator('#notebook-captures')).toContainText('所选文字摘录');
    await expect(page.locator('#notebook-captures')).toContainText(exactText);
    check(label + '_exact_excerpt_survives_reload_and_notebook', true);

    // Exercise historical evidence through actual reader controls, not storage mutation.
    const excerptDocument = exactLibrary.documents.find(doc => doc.title === newlines.title);
    const originalExcerpt = excerptDocument.exact_excerpts.find(record => record.text === exactText);
    const excerptRow = id => page.locator('#notebook-captures .notebook-capture').filter({hasText: id});
    const retainedRow = excerptRow(originalExcerpt.id);
    await expect(retainedRow).toHaveCount(1);
    await retainedRow.locator('details > summary').click();
    await expect(retainedRow.locator('.notebook-content').last()).toContainText('摘录时上下文');
    const historicalContent = await retainedRow.locator('.notebook-content').allTextContents();
    check(label + '_history_initial_attribution_is_capture_time_source', historicalContent.some(text => text.includes(newlines.title) && text.includes('https://youtu.be/authored-newlines?t=0')));
    await retainedRow.locator('.notebook-open').click();
    await expect(page.locator('#library-notebook')).toBeHidden();

    // A second explicitly saved range must survive removing the first later.
    await page.locator('#mode-passages').click();
    await clearSelection(); await newlineAction.click();
    check(label + '_second_excerpt_uses_actual_source_picker', await keyboardSelectSource(7,5) === 'after');
    await previewKeyboardSelection(); await page.locator('#quotation-save').click();
    await expect(page.locator('#quotation-save-status')).toContainText('已保存到本机');
    await closeQuotation(newlineAction);
    const beforeCorrection = await saved();
    const beforeDocument = beforeCorrection.documents.find(doc => doc.key === excerptDocument.key);
    const otherExcerpt = beforeDocument.exact_excerpts.find(record => record.id !== originalExcerpt.id);
    check(label + '_independent_annotations_and_second_excerpt_exist', beforeDocument.exact_excerpts.length === 2 && otherExcerpt.text === 'after' && Object.keys(beforeDocument.notes).length > 0 && beforeDocument.segments.some(cue => cue.saved_excerpt === true));

    stage = label + '_historical_excerpt_after_source_correction';
    await page.locator('#mode-transcript').click();
    const cueId = newlines.segments[0].id;
    const correctedCue = page.locator('#transcript .segment').filter({has: page.locator('.words', {hasText: /^before\s+after$/})});
    await expect(correctedCue).toHaveCount(1);
    await openCueActions(correctedCue);await correctedCue.locator('.edit-button').click();
    await expect(page.locator('#edit-dialog')).toBeVisible();
    const correctedText = 'Authored corrected source for retained quotation history ' + label + '.';
    await page.locator('#edit-segment').fill(correctedText);await page.locator('#save-edit').click();
    await expect(page.locator('#edit-dialog')).toBeHidden();
    const afterCorrection = await saved();
    const correctedDocument = afterCorrection.documents.find(doc => doc.key === excerptDocument.key);
    const currentCue = correctedDocument.segments.find(cue => cue.id === cueId);
    check(label + '_source_correction_is_durable_and_preserves_original', currentCue.text === correctedText && currentCue.original_text === 'before\r\nafter');
    check(label + '_source_correction_keeps_exact_snapshot_and_independent_annotations', JSON.stringify(correctedDocument.exact_excerpts) === JSON.stringify(beforeDocument.exact_excerpts) && JSON.stringify(correctedDocument.notes) === JSON.stringify(beforeDocument.notes) && JSON.stringify(correctedDocument.segments.map(cue => [cue.id, cue.saved_excerpt])) === JSON.stringify(beforeDocument.segments.map(cue => [cue.id, cue.saved_excerpt])));
    await openLibraryTools(page);await page.locator('#open-library-notebook').click();
    await retainedRow.locator('details > summary').click();
    await expect(retainedRow).toContainText('原文或出处已变化；保留摘录时快照');
    await expect(retainedRow.locator('.notebook-content').last()).toContainText('摘录时上下文');
    check(label + '_historical_text_attribution_and_context_remain_exact_after_correction', JSON.stringify(await retainedRow.locator('.notebook-content').allTextContents()) === JSON.stringify(historicalContent));
    await expect(retainedRow.locator('.notebook-open')).toHaveText('查看当前对应原文');
    await expect(retainedRow.locator('.notebook-open')).toBeEnabled();
    await capture(label + '-historical-correction');
    await retainedRow.locator('.notebook-open').click();
    await expect(page.locator('#library-notebook')).toBeHidden();
    await expect(page.locator('#transcript .segment[data-segment-id="' + cueId + '"] .words')).toHaveText(correctedText);
    check(label + '_historical_record_navigates_to_current_corresponding_cue', await page.evaluate(id => document.activeElement.closest('.segment')?.dataset.segmentId === id, cueId));

    await page.locator('#return-library-notebook').click();await expect(retainedRow).toHaveCount(1);
    const beforeRemoval = await saved(), expectedAfterRemoval = structuredClone(beforeRemoval);
    expectedAfterRemoval.documents.find(doc => doc.key === excerptDocument.key).exact_excerpts = beforeDocument.exact_excerpts.filter(record => record.id !== originalExcerpt.id);
    await retainedRow.locator('.notebook-remove').click();
    await expect(retainedRow).toHaveCount(0);await expect(excerptRow(otherExcerpt.id)).toHaveCount(1);
    check(label + '_removal_changes_only_the_chosen_exact_record_on_disk', JSON.stringify(await saved()) === JSON.stringify(expectedAfterRemoval));
    await page.locator('#notebook-close').click();await page.reload();
    await page.waitForFunction(() => window.CoconutStorageBootstrap?.phase === 'ready');
    check(label + '_reload_preserves_correction_notes_whole_cue_and_other_excerpt', JSON.stringify(await saved()) === JSON.stringify(expectedAfterRemoval));
    await openLibraryTools(page);await page.locator('#open-library-notebook').click();
    await expect(retainedRow).toHaveCount(0);await expect(excerptRow(otherExcerpt.id)).toHaveCount(1);
    await excerptRow(otherExcerpt.id).locator('details > summary').click();
    await expect(excerptRow(otherExcerpt.id)).toContainText('原文或出处已变化；保留摘录时快照');
    await capture(label + '-historical-removal-reload');
    await context.close(); page = null;
  }
  check('no_external_requests_or_server_mutations', external === 0 && mutations === 0);
  check('no_browser_errors', errors.length === 0);
  console.log(JSON.stringify({suite: 'passage-quotation', status: 'passed', checks, external, mutations, errors}, null, 2));
} catch (error) {
  console.error(JSON.stringify({suite: 'passage-quotation', status: 'failed', stage, checks, error: error.message, external, mutations, errors}, null, 2));
  if (page) await capture('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise(resolve => server?.listening ? server.close(resolve) : resolve());
}
