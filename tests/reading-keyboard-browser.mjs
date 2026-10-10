/** CI-only real Chromium keyboard acceptance. All text and translations are
 * authored fixtures; the only audio is a locally generated tone-only WAV.
 * No provider, AI response, CLI session, recording or external service is used. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
import {passageReadingFixture} from './helpers/passage-reading-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const shortcuts = ['j', 'k', 'l', 'g', '/', '?'];
const checks = [], browserErrors = [], requests = [];
let browser, server, directory, page, stage = 'setup', external = 0, mutations = 0, fileChoosers = 0;
const fixture = passageReadingFixture();
fixture.title = '阅读键盘回归 · 自写字幕与合成音调';
fixture.segments = fixture.segments.slice(0, 220);
fixture.source_url = 'https://example.invalid/authored-keyboard-fixture';
fixture.project_note = 'Authored project note kept across keyboard detours.';
fixture.timestamp_bookmarks = [{id: 'keyboard-bookmark', time: 42, note: 'Authored saved bookmark note.'}];
const otherFixture = {title: '键盘弹窗回归 · 另一篇自写稿', language: 'en', readingPosition: 'other-cue',
  notes: {'other-cue': 'Authored note in the removable shelf item.'},
  segments: [{id: 'other-cue', start: 0, end: 4, text: 'A separate authored shelf item for reversible removal.'}]};
const searchIds = ['split-15', 'split-115', 'split-205'];
for (const cue of fixture.segments) {
  if (!searchIds.includes(cue.id)) continue;
  cue.text += ' keyboard-marker';
  if (cue.translations?.zh) cue.translations.zh.source_text = cue.text;
}
function check(name, value) {stage = name; assert.ok(value, name); checks.push(name);}
async function settled() {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function stored() {

 await page.evaluate(()=>libraryStore.flush());
  return page.evaluate(async () => {const shelf = (await readPersistedLibrary()); return shelf.documents.find(doc => doc.key === sessionStorage.getItem('coconut-reader-active-v1'));});
}
async function capture(name) {
  if (!process.env.COCONUT_UI_SCREENSHOTS) return;
  await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS, {recursive: true});
  await page.screenshot({path: path.join(process.env.COCONUT_UI_SCREENSHOTS, 'keyboard-' + name + '.png'), fullPage: false, animations: 'disabled'});
}
async function interactionState() {
  return page.evaluate(() => {
    const player = document.querySelector('#source-media audio, #source-media video');
    return {players: document.querySelectorAll('audio,video').length, time: player?.currentTime ?? null,
      paused: player?.paused ?? null, source: player?.getAttribute('src') ?? null,
      preview: document.querySelector('#passage-playback-controls').dataset.state,
      workspace: document.body.dataset.workspace,
      passages: !document.querySelector('#passage-workspace').hidden,
      transcript: !document.querySelector('#transcript-layout').hidden,
      help: document.querySelector('#keyboard-help').open};
  });
}
function sameInteraction(before, after) {
  return Object.keys(before).every(key => key === 'time'
    ? before.time === after.time || Math.abs(before.time - after.time) < .03
    : before[key] === after[key]);
}
async function resetAudit() {await page.evaluate(() => {window.__readingKeyboardAudit = [];});}
async function ignoredKeys(label, selector, keys = shortcuts) {
  if (selector) await page.locator(selector).focus();
  const before = await interactionState();
  await resetAudit();
  for (const key of keys) await page.keyboard.press(key);
  const audit = await page.evaluate(() => window.__readingKeyboardAudit);
  check(label + '_does_not_capture_character_keys', keys.every(key => audit.some(event => event.key === key && !event.prevented)) && audit.every(event => !event.prevented));
  check(label + '_preserves_media_preview_and_reading_mode', sameInteraction(before, await interactionState()));
}
async function openRemoval(title) {
  const options = page.locator('#library-options, details.library-options');
  if (!await options.evaluate(node => node.open)) await options.locator('summary').click();
  await page.getByRole('button', {name: '从书架移除 ' + title, exact: true}).click();
}
async function ignoredNativeDialog(label, selector) {
  await page.locator(selector).waitFor({state: 'visible'});
  check(label + '_opens_as_a_real_native_modal', await page.locator(selector).evaluate(dialog => dialog instanceof HTMLDialogElement && dialog.open && dialog.matches(':modal')));
  // Blurring the modal's initial button leaves the viewport focused. This
  // isolates the open-dialog guard from the ordinary input/button guard.
  await page.evaluate(() => document.activeElement.blur());
  check(label + '_tests_viewport_focus_instead_of_a_control', await page.evaluate(() => document.activeElement === document.body));
  await ignoredKeys(label, null);
  check(label + '_character_keys_leave_the_same_modal_open', await page.locator(selector).evaluate(dialog => dialog.open && dialog.matches(':modal')));
}
async function seek(time) {
  await page.locator('#source-media audio').evaluate((player, time) => {player.pause(); player.currentTime = time;}, time);
  await page.waitForFunction(time => {const player = document.querySelector('#source-media audio'); return !player.seeking && player.paused && Math.abs(player.currentTime - time) < .03;}, time);
}
async function attachAudio(filename) {
  if (!await page.locator('#attach-reader-media').isVisible()) await page.locator('#toggle-reader-media').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#attach-reader-media').click()]);
  await chooser.setFiles(filename);
  await page.waitForFunction(() => {const player = document.querySelector('#source-media audio'); return player && !player.error && player.readyState >= 2 && player.duration >= 180;});
  await page.locator('#source-media audio').evaluate(player => {window.__readingKeyboardPlayer = player;});
  check('attached_authored_audio_does_not_autoplay', await page.locator('audio').evaluate(player => player.paused && player.currentTime === 0));
  await page.locator('#close-reader-media').click();
}
async function focusIs(selector) {
  await page.waitForFunction(selector => document.querySelector(selector) === document.activeElement, selector);
  return true;
}
async function expectFocusedCue(id) {
  await page.waitForFunction(id => document.activeElement?.classList.contains('segment') && document.activeElement.dataset.segmentId === id, id);
}
async function helpFocusLoop(label) {
  check(label + '_is_a_native_modal_dialog', await page.locator('#keyboard-help').evaluate(node => node instanceof HTMLDialogElement && node.open && node.matches(':modal')));
  const focusableCount = await page.locator('#keyboard-help').evaluate(dialog => [...dialog.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length).length);
  const seen = new Set();
  const focusBoundary = () => page.evaluate(async () => {
    const active = document.activeElement, dialog = document.querySelector('#keyboard-help');
    // Native focus navigation may temporarily visit browser chrome, reporting
    // body/html as the document's active element. That is not a focusable page
    // control escaping the modal. Do not install a synthetic focus trap here.
    return {safe: dialog.contains(active) || active === document.body || active === document.documentElement, id: active?.id};
  });
  for (let index = 0; index < focusableCount * 2 + 2; index++) {
    await page.keyboard.press('Tab');
    const focus = await focusBoundary();
    assert.ok(focus.safe, label + ': Tab focused a background page control');
    seen.add(focus.id);
  }
  for (let index = 0; index < focusableCount * 2 + 2; index++) {
    await page.keyboard.press('Shift+Tab');
    assert.ok((await focusBoundary()).safe, label + ': Shift+Tab focused a background page control');
  }
  check(label + '_tab_and_shift_tab_skip_background_controls_with_both_help_controls_reachable', seen.has('keyboard-help-close') && seen.has('keyboard-shortcuts-enabled'));
  // If the native ring ended in browser chrome, return through the actual
  // dialog's control before the caller exercises Escape or takes a screenshot.
  await page.locator('#keyboard-help-close').focus();
}
async function escapeHelp(label, before) {
  await page.keyboard.press('Escape');
  await page.locator('#keyboard-help').waitFor({state: 'hidden'});
  await page.waitForFunction(() => document.activeElement === window.__readingKeyboardReturnFocus);
  check(label + '_escape_restores_exact_original_focus', await page.evaluate(() => document.activeElement === window.__readingKeyboardReturnFocus));
  check(label + '_escape_preserves_paused_media_and_preview', sameInteraction(before, await interactionState()));
}

try {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coconut-keyboard-'));
  const audioPath = path.join(directory, 'authored-tone.wav');
  await fs.writeFile(audioPath, authoredAudioFixture(180));
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
  const context = await browser.newContext({viewport: {width: 1360, height: 1000}, serviceWorkers: 'block'});
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({method: request.method(), path: url.pathname});
    if (!['GET', 'HEAD'].includes(request.method())) {mutations++; await route.abort(); return;}
    if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) await route.continue();
    else {external++; await route.abort();}
  });
  // Observe bubbling after the product's document key handler. This records
  // actual browser keyboard events; it does not change or prevent them.
  await context.addInitScript(() => {
    window.__readingKeyboardAudit = [];
    window.addEventListener('keydown', event => window.__readingKeyboardAudit.push({key: event.key, prevented: event.defaultPrevented}));
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('filechooser', () => fileChoosers++);
  await page.goto(origin);
  await page.waitForLoadState('networkidle');

  stage = 'unassociated_media_is_inert';
  // Prepare the noncurrent removal target before attaching media. Switching
  // active documents later would legitimately replace the player owner.
  await page.locator('#file').setInputFiles({name: 'authored-keyboard-other.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(otherFixture))});
  await waitForPersistedLibrary(page,async title => {
    const shelf = (await readPersistedLibrary());
    return shelf.documents.some(doc => doc.key === sessionStorage.getItem('coconut-reader-active-v1') && doc.title === title);
  }, otherFixture.title);
  await page.locator('#file').setInputFiles({name: 'authored-keyboard-reading.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture))});
  await page.locator('#passage-workspace').waitFor({state: 'visible'});
  await page.waitForLoadState('networkidle');
  check('both_reading_surfaces_are_keyboard_focusable', await page.locator('#passage-body').getAttribute('tabindex') === '0' && await page.locator('#transcript').getAttribute('tabindex') === '0');
  check('help_button_is_available_in_reading_without_media', await page.locator('#keyboard-help-open').isVisible() && await page.locator('#keyboard-help-open').isEnabled());
  await page.locator('#keyboard-help-open').click();
  check('shortcuts_are_enabled_by_default', await page.locator('#keyboard-shortcuts-enabled').isChecked());
  await helpFocusLoop('button_opened_reader_help');
  await page.keyboard.press('Escape');
  await page.locator('#keyboard-help').waitFor({state: 'hidden'});
  check('button_opened_help_restores_button_focus', await focusIs('#keyboard-help-open'));
  await page.locator('#mode-summary').click();
  check('help_button_remains_available_in_summary_reading', await page.locator('#keyboard-help-open').isVisible());
  await page.locator('#keyboard-help-open').click();
  await page.locator('#keyboard-help-close').click();
  check('summary_help_close_restores_its_open_button', await focusIs('#keyboard-help-open'));
  await page.locator('#mode-passages').click();
  const noMediaRequests = requests.length, noMediaChoosers = fileChoosers, imported = await stored();
  await page.locator('#passage-body').focus();
  for (const key of ['j', 'k', 'l', 'g']) await page.keyboard.press(key);
  await settled();
  check('unassociated_media_keys_create_no_player_or_file_chooser', await page.locator('audio,video').count() === 0 && fileChoosers === noMediaChoosers);
  check('unassociated_media_keys_make_zero_network_requests', requests.length === noMediaRequests);
  check('unassociated_media_keys_do_not_change_notes_or_bookmark', JSON.stringify((await stored()).notes) === JSON.stringify(imported.notes) && (await stored()).readingPosition === imported.readingPosition);
  await page.locator('#passage-body').focus();
  await page.evaluate(() => {window.__readingKeyboardReturnFocus = document.activeElement;});
  const noMediaHelpState = await interactionState();
  await page.keyboard.press('?');
  await helpFocusLoop('reading_surface_help');
  await capture('01-desktop-help');
  await escapeHelp('reading_surface_help', noMediaHelpState);

  stage = 'real_search_to_source_to_playback';
  await attachAudio(audioPath);
  await seek(100.4);
  await page.locator('#passage-body').focus();
  await page.keyboard.press('/');
  check('slash_from_passages_opens_source_search_and_focuses_input', await page.locator('#transcript-layout').isVisible() && await focusIs('#search'));
  await page.keyboard.type('keyboard-marker');
  check('search_typing_preserves_the_query', await page.locator('#search').inputValue() === 'keyboard-marker');
  await page.keyboard.press('Enter'); await expectFocusedCue(searchIds[0]);
  check('search_enter_focuses_first_matching_original_cue', true);
  await page.locator('#search').focus(); await page.keyboard.press('Enter'); await expectFocusedCue(searchIds[1]);
  check('search_enter_advances_to_the_next_match', true);
  await page.locator('#search').focus(); await page.keyboard.press('Shift+Enter'); await expectFocusedCue(searchIds[0]);
  await page.locator('#search').focus(); await page.keyboard.press('Shift+Enter'); await expectFocusedCue(searchIds[2]);
  check('search_shift_enter_uses_previous_match_and_wraps', true);
  await page.keyboard.press('g'); await expectFocusedCue('split-125');
  check('g_from_search_result_locates_current_sound_across_source_pages', await page.locator('#search').inputValue() === '' && await page.locator('.segment[data-segment-id="split-125"]').count() === 1);
  await page.keyboard.press('j');
  check('j_seeks_the_existing_paused_player_back_ten_seconds', await page.locator('audio').evaluate(player => player.paused && Math.abs(player.currentTime - 90.4) < .05));
  await page.keyboard.press('l');
  check('l_seeks_the_existing_paused_player_forward_ten_seconds', await page.locator('audio').evaluate(player => player.paused && Math.abs(player.currentTime - 100.4) < .05));
  await page.keyboard.press('k');
  await page.waitForFunction(() => {const player = document.querySelector('audio'); return !player.paused && player.currentTime > 100.5;});
  await page.evaluate(() => {window.__readingKeyboardReturnFocus = document.activeElement;});
  await page.keyboard.press('?');
  check('opening_help_does_not_pause_ordinary_playback', await page.locator('audio').evaluate(player => !player.paused));
  await page.keyboard.press('Escape');
  await page.locator('#keyboard-help').waitFor({state: 'hidden'});
  check('closing_help_keeps_ordinary_playback_and_original_focus', await page.locator('audio').evaluate(player => !player.paused) && await page.evaluate(() => document.activeElement === window.__readingKeyboardReturnFocus));
  await page.keyboard.press('k');
  check('k_toggles_actual_decoded_playback_from_the_focused_source', await page.locator('audio').evaluate(player => player.paused && player.currentTime > 100.5));
  check('reading_shortcuts_reuse_exactly_one_media_element', await page.evaluate(() => document.querySelectorAll('audio,video').length === 1 && document.querySelector('audio') === window.__readingKeyboardPlayer));
  // A body focus represents the empty reading canvas, not an interactive child.
  await page.evaluate(() => document.activeElement.blur());
  const blankTime = (await interactionState()).time;
  await page.keyboard.press('j');
  check('empty_reading_canvas_accepts_shortcuts', Math.abs((await interactionState()).time - (blankTime - 10)) < .05);
  await page.keyboard.press('l');
  await page.locator('#transcript').focus();
  await page.keyboard.press('/');
  check('slash_from_source_surface_refocuses_search', await focusIs('#search'));

  stage = 'real_input_and_control_guards';
  // Use a deterministic cue after the real clock has advanced during playback.
  await seek(100.4);
  await page.locator('#search').fill('');
  await ignoredKeys('search_input', '#search');
  check('input_receives_all_six_literal_shortcut_characters', await page.locator('#search').inputValue() === 'jklg/?');
  await page.locator('#search').fill('');
  await page.locator('#transcript').focus(); await page.keyboard.press('g'); await expectFocusedCue('split-125');
  await page.locator('.segment[data-segment-id="split-125"] .note-button').click();
  await page.locator('#note').fill('');
  await ignoredKeys('note_textarea', '#note');
  check('note_editor_receives_literal_keys_without_losing_the_note', await page.locator('#note').inputValue() === 'jklg/?');
  await page.locator('#close-note').click();
  check('literal_keyboard_note_is_saved_on_its_original_cue', (await stored()).notes['split-125'] === 'jklg/?');
  await ignoredKeys('focused_button', '#mode-transcript');
  await ignoredKeys('focused_link', '.brand');
  await ignoredKeys('focused_native_select', '#reading-jump');
  await page.locator('#mode-passages').click();
  await ignoredKeys('focused_native_range', '#passage-time-range');
  await page.locator('#toggle-reader-media').click();
  await ignoredKeys('focused_native_media', '#source-media audio');
  await page.locator('#close-reader-media').click();

  // DOM-only interaction probes cover editable nesting and ARIA widgets that
  // imported prose might contain. They never alter app handlers or media APIs.
  await page.locator('#passage-body').evaluate(host => {
    const editable = document.createElement('div'); editable.id = 'authored-keyboard-editable'; editable.contentEditable = 'true';
    const nested = document.createElement('span'); nested.id = 'authored-keyboard-nested'; nested.textContent = 'Authored editable text';
    editable.append(nested); host.append(editable);
    const widget = document.createElement('div'); widget.id = 'authored-keyboard-widget'; widget.tabIndex = 0; widget.setAttribute('role', 'slider'); widget.textContent = 'Authored ARIA control'; host.append(widget);
  });
  await ignoredKeys('contenteditable_host', '#authored-keyboard-editable');
  check('contenteditable_receives_literal_shortcut_characters', (await page.locator('#authored-keyboard-editable').textContent()).includes('jklg/?'));
  await ignoredKeys('aria_widget', '#authored-keyboard-widget');
  // Keep the active surface eligible, isolating the nested event-target guard.
  await page.locator('#passage-body').focus();
  const nestedBefore = await interactionState();
  const nestedGuard = await page.locator('#authored-keyboard-nested').evaluate(node => ['j', 'k', 'l', 'g', '/', '?'].every(key => {
    const event = new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true}); node.dispatchEvent(event); return !event.defaultPrevented;
  }));
  check('nested_contenteditable_target_does_not_capture_keys', nestedGuard);
  check('nested_contenteditable_target_preserves_player_and_reading', sameInteraction(nestedBefore, await interactionState()));
  await page.evaluate(() => {document.querySelector('#authored-keyboard-editable').remove(); document.querySelector('#authored-keyboard-widget').remove();});

  stage = 'modified_composing_and_repeated_keys';
  await page.locator('#passage-body').focus();
  const guardedState = await interactionState();
  const guardedEvents = await page.locator('#passage-body').evaluate(host => {
    const variants = [{ctrlKey: true}, {altKey: true}, {metaKey: true}, {repeat: true}, {isComposing: true}, {keyCode: 229, which: 229}];
    return variants.flatMap(variant => ['j', 'k', 'l', 'g', '/', '?'].map(key => {
      const event = new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true, ...variant}); host.dispatchEvent(event);
      return {key, variant, prevented: event.defaultPrevented};
    }));
  });
  check('modifiers_repeat_ime_and_keycode_229_are_never_captured', guardedEvents.length === 36 && guardedEvents.every(event => !event.prevented));
  check('guarded_events_preserve_media_and_reading_context', sameInteraction(guardedState, await interactionState()));
  await page.locator('#passage-body').dispatchEvent('compositionstart', {data: ''});
  await ignoredKeys('active_ime_composition_session', '#passage-body');
  await page.locator('#passage-body').dispatchEvent('compositionend', {data: '自写'});
  await page.keyboard.press('j');
  check('composition_end_restores_reading_shortcuts', Math.abs((await interactionState()).time - (guardedState.time - 10)) < .05);
  await page.keyboard.press('l');
  // A real held key triggers once, while its second keydown is a repeat.
  const repeatTime = (await interactionState()).time;
  await page.keyboard.down('j'); await page.keyboard.down('j'); await page.keyboard.up('j');
  check('held_j_seeks_once_and_ignores_the_real_repeat', Math.abs((await interactionState()).time - (repeatTime - 10)) < .05);

  stage = 'other_modal_and_add_workspace_guards';
  await page.locator('#details-dialog').evaluate(dialog => dialog.showModal());
  // Focus the modal itself so the guard cannot pass merely because an input is focused.
  await page.locator('#details-dialog').evaluate(dialog => {dialog.tabIndex = -1; dialog.focus();});
  await ignoredKeys('other_native_dialog', null);
  await page.keyboard.press('Escape');
  await page.locator('#details-dialog').evaluate(dialog => dialog.show());
  await ignoredKeys('open_nonmodal_dialog_blocks_background_reading_keys', '#passage-body');
  await page.locator('#details-dialog').evaluate(dialog => dialog.close());
  await page.locator('#passage-body').evaluate(host => {
    const modal = document.createElement('div'); modal.id = 'authored-keyboard-modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.tabIndex = -1; modal.textContent = 'Authored modal boundary'; host.append(modal); modal.focus();
  });
  await ignoredKeys('aria_modal_dialog_blocks_background_reading_keys', '#passage-body');
  await page.locator('#authored-keyboard-modal').evaluate(node => node.remove());
  await page.locator('#add-content').click();
  await ignoredKeys('add_workspace', '#main-content');
  await page.locator('#back-reading').click();
  check('help_button_stays_available_after_returning_to_reading', await page.locator('#keyboard-help-open').isVisible());
  await page.locator('#keyboard-help-open').click();
  await page.locator('#keyboard-help-close').click();
  check('help_close_button_restores_its_open_button', await focusIs('#keyboard-help-open'));

  stage = 'drafts_survive_keyboard_search_locate_and_help';
  await seek(100.4);
  await page.locator('#mode-transcript').click();
  check('combined_draft_journey_starts_with_unfiltered_source_and_visible_annotations', await page.locator('#search').inputValue() === '' && await page.locator('#audio-bookmark-form').isVisible());
  const bookmark = page.locator('#audio-bookmarks [data-bookmark-id="keyboard-bookmark"]');
  const draft = {time: '1:02.5', note: 'Unsubmitted authored bookmark thought.', correction: '1:23.5', glossary: 'keyboard-marker = 自写键盘草稿'};
  const savedBeforeDrafts = JSON.stringify(await stored());
  await page.locator('#audio-bookmark-time').fill(draft.time);
  await page.locator('#audio-bookmark-note').fill(draft.note);
  await bookmark.locator('.edit-bookmark-time').click();
  await bookmark.locator('form input').fill(draft.correction);
  if (!await page.locator('#language-panel').evaluate(panel => panel.open)) await page.locator('#language-panel > summary').click();
  await page.locator('#ai-task').selectOption('translation');
  if (!await page.locator('#translation-options').evaluate(panel => panel.open)) await page.locator('#translation-options > summary').click();
  await page.locator('#translation-glossary').fill(draft.glossary);
  const listeningBeforeDetours = await page.evaluate(async key => localStorage.getItem('coconut-listening-v1:' + key), (await stored()).key);
  check('draft_detours_begin_with_a_real_saved_listening_checkpoint', listeningBeforeDetours !== null && Math.abs(JSON.parse(listeningBeforeDetours).time - 100.4) < .03);
  const detourRequests = requests.length, detourChoosers = fileChoosers;
  const checkDrafts = async label => {
    check(label + '_retains_glossary_new_bookmark_and_time_correction_drafts',
      await page.locator('#translation-glossary').inputValue() === draft.glossary &&
      await page.locator('#audio-bookmark-time').inputValue() === draft.time &&
      await page.locator('#audio-bookmark-note').inputValue() === draft.note &&
      await bookmark.locator('form input').inputValue() === draft.correction &&
      !await bookmark.locator('form').evaluate(form => form.hidden));
    check(label + '_preserves_saved_document_and_project_annotations', JSON.stringify(await stored()) === savedBeforeDrafts &&
      await page.locator('#project-note').inputValue() === fixture.project_note &&
      await bookmark.locator('textarea').inputValue() === fixture.timestamp_bookmarks[0].note);
    check(label + '_preserves_the_same_paused_player_and_listening_checkpoint', await page.evaluate(async ({key, checkpoint}) => {
      const player = document.querySelector('#source-media audio');
      return player === window.__readingKeyboardPlayer && document.querySelectorAll('audio,video').length === 1 &&
        player.paused && Math.abs(player.currentTime - 100.4) < .03 && localStorage.getItem('coconut-listening-v1:' + key) === checkpoint;
    }, {key: (await stored()).key, checkpoint: listeningBeforeDetours}));
  };
  await checkDrafts('unsubmitted_combined_drafts');
  await page.locator('#mode-passages').click();
  await page.locator('#passage-body').focus(); await page.keyboard.press('/');
  check('draft_slash_detour_opens_source_search', await focusIs('#search') && await page.locator('#transcript-layout').isVisible());
  await checkDrafts('draft_slash_detour');
  await page.keyboard.type('keyboard-marker');
  await page.keyboard.press('Enter'); await expectFocusedCue(searchIds[0]);
  await checkDrafts('draft_search_enter_detour');
  await page.keyboard.press('g'); await expectFocusedCue('split-125');
  check('draft_g_detour_clears_search_and_finds_the_current_sound', await page.locator('#search').inputValue() === '');
  await checkDrafts('draft_g_detour');
  await page.evaluate(() => {window.__readingKeyboardReturnFocus = document.activeElement;});
  const draftHelpState = await interactionState();
  await page.keyboard.press('?');
  check('draft_help_detour_opens_the_native_help_modal', await page.locator('#keyboard-help').evaluate(dialog => dialog.open && dialog.matches(':modal')));
  await escapeHelp('draft_help_detour', draftHelpState);
  await checkDrafts('draft_help_detour');

  stage = 'new_native_dialogs_block_keys_with_media_and_drafts';
  await page.evaluate(()=>libraryStore.flush());
  const shelfBeforeDialogs = await page.evaluate(async () => JSON.stringify(await readPersistedLibrary()));
  await openRemoval(fixture.title);
  await ignoredNativeDialog('remove_document_dialog', '#remove-document-dialog');
  await checkDrafts('remove_document_dialog_keys');
  await page.keyboard.press('Escape');
  await page.locator('#remove-document-dialog').waitFor({state: 'hidden'});
  await page.evaluate(()=>libraryStore.flush());
  check('remove_dialog_escape_preserves_the_complete_shelf', await page.evaluate(async () => JSON.stringify(await readPersistedLibrary())) === shelfBeforeDialogs);
  await checkDrafts('remove_document_dialog_escape');

  await openRemoval(otherFixture.title);
  await page.locator('#confirm-removal').click();
  await page.locator('#removal-recovery').waitFor({state: 'visible'});
  await page.evaluate(()=>libraryStore.flush());
  const shelfWithRecovery = await page.evaluate(async () => JSON.stringify(await readPersistedLibrary()));
  check('noncurrent_removal_keeps_the_reading_document_active', (await stored()).title === fixture.title &&
    await page.getByRole('button', {name: '从书架移除 ' + otherFixture.title, exact: true}).count() === 0);
  const recoveryDetails = page.locator('#removal-recovery-details');
  if (!await recoveryDetails.evaluate(details => details.open)) await recoveryDetails.locator(':scope > summary').click();
  await page.locator('#finish-removal').click();
  await ignoredNativeDialog('finish_removal_dialog', '#finish-removal-dialog');
  await checkDrafts('finish_removal_dialog_keys');
  await page.keyboard.press('Escape');
  await page.locator('#finish-removal-dialog').waitFor({state: 'hidden'});
  await page.evaluate(()=>libraryStore.flush());
  check('finish_dialog_escape_keeps_the_recovery_available_and_shelf_unchanged', await page.locator('#removal-recovery').isVisible() &&
    await page.evaluate(async () => JSON.stringify(await readPersistedLibrary())) === shelfWithRecovery);
  await page.locator('#undo-removal').click();
  await page.evaluate(()=>libraryStore.flush());
  check('noncurrent_undo_restores_the_complete_shelf', await page.evaluate(async () => JSON.stringify(await readPersistedLibrary())) === shelfBeforeDialogs && await page.locator('#removal-recovery').isHidden());
  await checkDrafts('finish_removal_cancel_and_undo');

  // A real, valid JSON file crosses the native size review threshold. Padding
  // is JSON whitespace, not a forged File.size or a mocked import response.
  // Full large-backup parsing is covered separately; this journey only cancels.
  const largeBackupPath = path.join(directory, 'authored-keyboard-large-backup.json');
  await fs.writeFile(largeBackupPath, JSON.stringify(fixture));
  await fs.appendFile(largeBackupPath, Buffer.alloc(50 * 1024 * 1024, ' '));
  check('keyboard_backup_fixture_really_exceeds_the_review_threshold', (await fs.stat(largeBackupPath)).size > 50 * 1024 * 1024);
  await page.locator('#file').setInputFiles(largeBackupPath);
  await ignoredNativeDialog('large_backup_dialog', '#large-backup-dialog');
  await checkDrafts('large_backup_dialog_keys');
  await page.locator('#cancel-large-backup').click();
  await page.locator('#large-backup-dialog').waitFor({state: 'hidden'});
  await page.waitForFunction(() => document.querySelector('#file').files.length === 0);
  await page.evaluate(()=>libraryStore.flush());
  check('large_backup_cancel_clears_the_selection_and_preserves_the_complete_shelf', await page.evaluate(async () => JSON.stringify(await readPersistedLibrary())) === shelfBeforeDialogs);
  await checkDrafts('large_backup_dialog_cancel');
  check('combined_drafts_and_dialogs_make_no_network_requests_or_media_chooser', requests.length === detourRequests && fileChoosers === detourChoosers);
  // Explicitly cancel every in-memory draft before the pre-existing reload
  // checks; do not accept or suppress an unexpected beforeunload prompt.
  if (!await page.locator('#language-panel').evaluate(panel => panel.open)) await page.locator('#language-panel > summary').click();
  if (await page.locator('#ai-task').inputValue() !== 'translation') await page.locator('#ai-task').selectOption('translation');
  if (!await page.locator('#translation-options').evaluate(panel => panel.open)) await page.locator('#translation-options > summary').click();
  await page.locator('#cancel-translation-glossary').click();
  await page.locator('#cancel-audio-bookmark').click();
  await bookmark.locator('form button[type="button"]').click();
  check('explicit_draft_cancellation_leaves_saved_notes_and_bookmarks_unchanged', JSON.stringify(await stored()) === savedBeforeDrafts &&
    await page.locator('#audio-bookmark-time').inputValue() === '' && await page.locator('#audio-bookmark-note').inputValue() === '' &&
    await bookmark.locator('form').evaluate(form => form.hidden) && await page.locator('#translation-glossary').inputValue() === '');

  stage = 'preview_pause_help_resume_and_end_boundary';
  await page.locator('#mode-passages').click();
  await seek(50);
  const firstPassage = page.locator('#passage-body .passage').first();
  const ids = await firstPassage.locator('.passage-original .passage-cue').evaluateAll(nodes => nodes.map(node => node.dataset.cueId));
  const range = {start: Math.min(...ids.map(id => fixture.segments.find(cue => cue.id === id).start)), end: Math.max(...ids.map(id => fixture.segments.find(cue => cue.id === id).end))};
  await firstPassage.locator('.passage-listen').click();
  await page.waitForFunction(() => !document.querySelector('audio').paused);
  await page.locator('#passage-body').focus(); await page.keyboard.press('k');
  // paused changes before the queued native pause event publishes preview UI.
  // Await one atomic observation, including ownership of the original range.
  stage = 'waiting_for_bounded_preview_pause';
  const paused = await page.waitForFunction(range => {
    const player = document.querySelector('audio'), preview = document.querySelector('#passage-playback-controls').dataset.state;
    const current = passagePlayback.getState().range;
    return player.paused && preview === 'paused' && current?.start === range.start && current?.end === range.end;
  }, range);
  check('k_pauses_a_bounded_passage_without_cancelling_preview', await paused.jsonValue());
  await paused.dispose();
  await page.evaluate(() => {window.__readingKeyboardReturnFocus = document.activeElement;});
  const pausedPreview = await interactionState();
  await page.keyboard.press('?');
  await helpFocusLoop('paused_preview_help');
  await escapeHelp('paused_preview_help', pausedPreview);
  await page.keyboard.press('k');
  // HTML media properties may advance before the queued native play event
  // updates the bounded-preview UI. Observe both in the same browser turn.
  stage = 'waiting_for_bounded_preview_resume';
  const resumed = await page.waitForFunction(time => {
    const player = document.querySelector('audio'), preview = document.querySelector('#passage-playback-controls').dataset.state;
    return !player.paused && player.currentTime > time && preview === 'playing' ? {preview, time: player.currentTime, paused: player.paused} : false;
  }, pausedPreview.time);
  const resumedState = await resumed.jsonValue(); await resumed.dispose();
  check('k_resumes_the_same_bounded_preview', resumedState.preview === 'playing' && !resumedState.paused && resumedState.time > pausedPreview.time);
  await page.waitForFunction(end => {const player = document.querySelector('audio'); return player.paused && Math.abs(player.currentTime - end) < .15;}, range.end);
  check('resumed_preview_still_stops_at_its_original_passage_end', await page.locator('#passage-playback-controls').getAttribute('data-state') === 'finished');
  const stoppedTime = (await interactionState()).time;
  await page.waitForTimeout(300);
  check('preview_remains_paused_after_the_boundary', Math.abs((await interactionState()).time - stoppedTime) < .03 && (await interactionState()).paused);
  await capture('02-bounded-preview-finished');
  for (const [key, delta] of [['j', -10], ['l', 10]]) {
    await firstPassage.locator('.passage-listen').click();
    await page.waitForFunction(() => !document.querySelector('audio').paused);
    await page.locator('#passage-body').focus(); await page.keyboard.press('k');
    const before = (await interactionState()).time;
    await page.keyboard.press(key);
    check(key + '_leaves_preview_before_ordinary_ten_second_seek', await page.locator('#passage-playback-controls').isHidden() && (await interactionState()).paused && Math.abs((await interactionState()).time - Math.max(0, Math.min(180, before + delta))) < .05);
  }
  await page.keyboard.press('k');
  await page.waitForFunction(end => {const player = document.querySelector('audio'); return !player.paused && player.currentTime > end + .1;}, range.end);
  await page.keyboard.press('k');
  check('ordinary_playback_after_l_is_not_stopped_by_the_old_preview', (await interactionState()).paused && await page.locator('#passage-playback-controls').isHidden());

  stage = 'mobile_help_and_input_focus';
  await page.setViewportSize({width: 390, height: 844});
  await page.locator('#passage-body').focus(); await page.keyboard.press('/');
  await page.locator('#search').fill('');
  await page.keyboard.press('?');
  check('mobile_question_mark_stays_in_focused_search_input', await focusIs('#search') && await page.locator('#search').inputValue() === '?' && await page.locator('#keyboard-help').isHidden());
  await page.locator('#search').fill('');
  await page.locator('#keyboard-help-open').click();
  check('mobile_help_focus_does_not_activate_a_text_input', await page.evaluate(() => {const active = document.activeElement; return document.querySelector('#keyboard-help').contains(active) && !active.matches('textarea,input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])');}));
  await helpFocusLoop('mobile_help');
  check('mobile_help_and_controls_fit_the_narrow_viewport', await page.locator('#keyboard-help').evaluate(dialog => {
    const rect = dialog.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth && ['keyboard-help-close', 'keyboard-shortcuts-enabled'].every(id => {const box = document.getElementById(id).getBoundingClientRect(); return box.width > 0 && box.height > 0 && box.left >= rect.left && box.right <= rect.right && box.top >= rect.top && box.bottom <= rect.bottom;});
  }));
  await capture('03-mobile-help');
  await page.keyboard.press('Escape');
  check('mobile_button_help_restores_its_button_without_focusing_search', await focusIs('#keyboard-help-open'));

  stage = 'persisted_shortcut_opt_out_and_restore';
  await page.locator('#keyboard-help-open').click();
  await page.locator('#keyboard-shortcuts-enabled').uncheck();
  await page.locator('#keyboard-help-close').click();
  await ignoredKeys('disabled_shortcuts_with_associated_media', '#transcript');
  await page.locator('#search').focus(); await page.keyboard.type('keyboard-marker');
  await page.keyboard.press('Enter'); await expectFocusedCue(searchIds[0]);
  check('search_enter_remains_available_with_character_shortcuts_disabled', true);
  const finalDoc = await stored();
  check('keyboard_journey_preserves_prior_notes_excerpt_and_reading_bookmark', finalDoc.notes['split-2'] === fixture.notes['split-2'] && finalDoc.notes['split-125'] === 'jklg/?' && finalDoc.readingPosition === fixture.readingPosition && finalDoc.segments[4].saved_excerpt === true && finalDoc.segments.every((cue, index) => cue.id === fixture.segments[index].id && cue.text === fixture.segments[index].text && cue.start === fixture.segments[index].start && cue.end === fixture.segments[index].end));
  check('keyboard_journey_preserves_project_note_and_saved_timestamp_bookmark', finalDoc.project_note === fixture.project_note && JSON.stringify(finalDoc.timestamp_bookmarks) === JSON.stringify(fixture.timestamp_bookmarks));
  await page.reload(); await page.locator('#passage-workspace').waitFor({state: 'visible'});
  check('reload_does_not_restore_local_media_or_autoplay', await page.locator('audio,video').count() === 0);
  await ignoredKeys('persisted_disabled_shortcuts', '#passage-body');
  await page.locator('#keyboard-help-open').click();
  check('disabled_shortcut_preference_survives_reload_with_help_button_available', !await page.locator('#keyboard-shortcuts-enabled').isChecked());
  await page.locator('#keyboard-shortcuts-enabled').check();
  await page.locator('#keyboard-help-close').click();
  await page.reload(); await page.locator('#passage-workspace').waitFor({state: 'visible'});
  await page.locator('#keyboard-help-open').click();
  check('restored_shortcut_preference_survives_reload', await page.locator('#keyboard-shortcuts-enabled').isChecked());
  await page.keyboard.press('Escape');
  await page.locator('#passage-body').focus(); await page.keyboard.press('/');
  check('restored_shortcuts_work_after_reload', await focusIs('#search'));
  // A genuine native close queues its event. A newer synchronous focus move
  // must survive that later event instead of jumping back to the help opener.
  await page.locator('#mode-passages').click();
  await page.locator('#keyboard-help-open').click();
  await page.evaluate(() => {document.querySelector('#keyboard-help').close();document.querySelector('#passage-body').focus();});
  await settled();
  check('queued_native_help_close_preserves_newer_reader_focus', await focusIs('#passage-body'));
  await page.keyboard.press('/');
  check('search_shortcut_works_after_queued_native_help_close', await focusIs('#search'));
  check('reload_preserves_authored_source_and_keyboard_typed_note', JSON.stringify((await stored()).notes) === JSON.stringify(finalDoc.notes) && (await stored()).readingPosition === fixture.readingPosition);
  check('reload_preserves_project_annotations_without_saving_canceled_drafts', (await stored()).project_note === fixture.project_note && JSON.stringify((await stored()).timestamp_bookmarks) === JSON.stringify(fixture.timestamp_bookmarks) && JSON.stringify((await stored()).translation_glossary) === JSON.stringify(finalDoc.translation_glossary));
  await page.evaluate(()=>libraryStore.flush());
  check('no_external_media_upload_ai_model_or_browser_error', external === 0 && mutations === 0 && browserErrors.length === 0 && fileChoosers === noMediaChoosers + 1 && await page.evaluate(async () => !JSON.stringify(await readPersistedLibrary()).includes('blob:')));
  console.log(JSON.stringify({suite: 'reading-keyboard-authored-media', status: 'passed', checks}));
} catch (error) {
  // Snapshot before taking a screenshot, which can itself span media events.
  const interaction = page && !page.isClosed() ? await interactionState().catch(() => null) : null;
  if (page && !page.isClosed()) await capture('failure-' + stage).catch(() => {});
  console.log(JSON.stringify({suite: 'reading-keyboard-authored-media', status: 'failed', stage, message: error.message, interaction, browserErrors, checks}));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise(resolve => server?.listening ? server.close(resolve) : resolve());
  if (directory) await fs.rm(directory, {recursive: true, force: true});
}
