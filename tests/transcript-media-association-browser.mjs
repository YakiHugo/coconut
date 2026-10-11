/** CI-only real Chromium acceptance for transcript-first local-media association.
 * Native files contain authored SRT and PCM tones only. All persistence evidence
 * is read from production IndexedDB; media/files stay in a temporary directory.
 * No workspace browser, user browser, real API, model or uploaded media is used.
 * node --check validates syntax only and is not browser acceptance evidence. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium, expect} from './helpers/browser-storage.mjs';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
import {openCueActions} from './cue-actions-browser.mjs';

if (!process.env.CI) throw new Error('Transcript media association browser acceptance is CI-only; use node --check locally.');

const artifacts = process.env.COCONUT_UI_ARTIFACT_DIR || process.env.COCONUT_UI_SCREENSHOTS;
const checks = [], errors = [], geometry = [], screenshots = [], apiRequests = [];
let browser, server, directory, diagnosticPage, stage = 'setup', external = 0, mutations = 0, failure = null;
const check = (name, value) => {assert.ok(value, name); checks.push(name);};
const choice = (page, key) => page.locator('#local-media-project-options button[data-document-key="' + key + '"]');
const preserved = doc => ({source_url: doc.source_url, segments: doc.segments, notes: doc.notes, project_note: doc.project_note,
  timestamp_bookmarks: doc.timestamp_bookmarks, exact_excerpts: doc.exact_excerpts, exact_excerpt_notes: doc.exact_excerpt_notes});
async function disk(page) {await page.evaluate(() => libraryStore.flush()); return page.evaluate(() => readPersistedLibrary());}
async function active(page) {
  const saved = await disk(page), key = await page.evaluate(() => sessionStorage.getItem('coconut-reader-active-v1'));
  const doc = saved.documents.find(doc => doc.key === key); assert.ok(doc, 'Active document is committed to IndexedDB'); return doc;
}
async function choose(page, selector, file) {
  const [picker] = await Promise.all([page.waitForEvent('filechooser'), page.locator(selector).click()]);
  await picker.setFiles(file);
}
async function finished(page, id) {await expect(page.locator('#' + id)).toHaveValue('');}
async function ready(page, duration = 40) {
  await page.waitForFunction(duration => {
    const player = document.querySelector('#source-media audio');
    return player && !player.error && player.readyState >= 2 && Math.abs(player.duration - duration) < .01;
  }, duration);
}
async function showMedia(page) {if (!await page.locator('#attach-reader-media').isVisible()) await page.locator('#toggle-reader-media').click();}
async function homePick(page, file) {
  if (!await page.locator('#add-workspace').isVisible()) await page.locator('#add-content').click();
  await choose(page, '#open-local-media', file); await expect(page.locator('#local-media-project-dialog')).toBeVisible();
}
async function saveOffset(page, offset) {
  await showMedia(page); await page.locator('#media-timing-offset').fill(String(offset)); await page.locator('#media-timing-save').click();
  await expect(page.locator('#media-timing-status')).toContainText('已保存偏移 ' + offset); return active(page);
}
async function checkpoint(page, time) {
  await page.locator('#source-media audio').evaluate(async (player, time) => {
    player.pause(); await new Promise(resolve => {player.addEventListener('seeked', resolve, {once: true}); player.currentTime = time;});
    await player.play(); player.pause();
  }, time);
  const key = (await active(page)).key;
  await page.waitForFunction(({key, time}) => JSON.parse(localStorage.getItem('coconut-listening-v1:' + key) || 'null')?.time >= time, {key, time});
}
async function capture(page, label) {
  if (!artifacts) return;
  await fs.mkdir(artifacts, {recursive: true}); const name = 'transcript-media-association-' + label + '.png';
  await page.screenshot({path: path.join(artifacts, name), fullPage: false, animations: 'disabled'}); screenshots.push(name);
}
async function visibleFocus(page, selector, label) {
  await expect(page.locator(selector)).toBeFocused(); await expect(page.locator(selector)).toBeVisible();
  const data = await page.locator(selector).evaluate(node => {
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    return {id: node.id, activeId: document.activeElement?.id || document.activeElement?.tagName,
      focused: document.activeElement === node, body: document.activeElement === document.body,
      hiddenAncestor: !!node.closest('[hidden]'), display: style.display, visibility: style.visibility,
      rect: rect.toJSON(), viewport: {width: innerWidth, height: innerHeight}};
  });
  geometry.push({label, ...data}); const {rect: r, viewport: v} = data;
  check(label + '_focus_lands_on_visible_target_not_body_or_hidden_opener', data.focused && !data.body && !data.hiddenAncestor &&
    data.display !== 'none' && data.visibility === 'visible' && r.width > 0 && r.height > 0 &&
    r.left >= 0 && r.right <= v.width + 1 && r.top >= -1 && r.bottom <= v.height + 1);
}
async function captureAbsentMedia(page, label, filename = null) {
  for (const width of [390, 1280]) {
    await page.setViewportSize({width, height: 844}); await showMedia(page);
    await expect(page.locator('#source-media audio, #source-media video')).toHaveCount(0);
    if (filename) await expect(page.locator('#reader-media-status')).toContainText(filename);
    await page.locator('#reader-media-status').scrollIntoViewIfNeeded();
    check(label + '_' + width + '_absent_media_controls_are_visible_without_overflow', await page.locator('#attach-reader-media').isVisible() &&
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await capture(page, width + '-' + label);
  }
  await page.setViewportSize({width: 390, height: 844});
}
async function dialogGeometry(page, label) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const data = await page.locator('#local-media-project-dialog').evaluate(dialog => {
    const rect = dialog.getBoundingClientRect();
    return {modal: dialog.open && dialog.matches(':modal'), rect: rect.toJSON(), viewport: {width: innerWidth, height: innerHeight},
      pageWidth: document.documentElement.scrollWidth, scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth,
      controls: [...dialog.querySelectorAll('button')].filter(node => node.getClientRects().length && !node.closest('[hidden]'))
        .map(node => ({id: node.id, documentKey: node.dataset.documentKey || null, ...node.getBoundingClientRect().toJSON()}))};
  });
  geometry.push({label, ...data});
  check(label + '_modal_fits_without_horizontal_overflow', data.modal && data.rect.left >= 0 && data.rect.right <= data.viewport.width &&
    data.rect.top >= 0 && data.rect.bottom <= data.viewport.height + 1 && data.pageWidth <= data.viewport.width && data.scrollWidth <= data.clientWidth + 1);
  check(label + '_controls_have_44px_touch_targets', data.controls.length >= 3 && data.controls.every(rect => rect.height >= 44 && rect.width >= 44));
}
async function keyboardGeometry(page, label) {
  const data = await page.evaluate(() => {
    const node = document.activeElement, dialog = document.getElementById('local-media-project-dialog'), rect = node.getBoundingClientRect(), d = dialog.getBoundingClientRect();
    const style = getComputedStyle(node), ring = (parseFloat(style.outlineWidth) || 0) + Math.max(0, parseFloat(style.outlineOffset) || 0);
    const x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2;
    return {id: node.id, inside: node.closest('dialog') === dialog, focusVisible: node.matches(':focus-visible'), outline: style.outlineStyle, ring,
      rect: rect.toJSON(), dialog: d.toJSON(), viewport: {width: innerWidth, height: innerHeight},
      hits: [[x,y],[rect.left+1,y],[rect.right-1,y],[x,rect.top+1],[x,rect.bottom-1]].map(([x,y]) => {
        const hit = document.elementFromPoint(x,y); return {x,y,clear: hit === node || node.contains(hit), hit: hit?.id || hit?.tagName};
      })};
  });
  geometry.push({label, ...data}); const {rect: r, dialog: d, viewport: v, ring} = data;
  check(label + '_keyboard_ring_and_five_hit_points', data.inside && data.focusVisible && data.outline !== 'none' && ring > 0 &&
    r.width >= 44 && r.height >= 44 && r.left-ring >= Math.max(0,d.left) && r.right+ring <= Math.min(v.width,d.right) &&
    r.top-ring >= Math.max(0,d.top) && r.bottom+ring <= Math.min(v.height,d.bottom) && data.hits.every(hit => hit.clear));
}
async function warning(page, label) {
  const text = await page.locator('#local-media-project-dialog').innerText();
  check(label + '_explains_cleared_timing_duration_listening_and_retained_annotations',
    /偏移|校准/.test(text) && /时长/.test(text) && /收听/.test(text) && /保留/.test(text) && /笔记/.test(text) && /摘录/.test(text));
}

try {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coconut-transcript-media-association-'));
  const audio = path.join(directory, 'authored-local.wav'), collisionDir = path.join(directory, 'unsampled-change');
  await fs.mkdir(collisionDir); const collision = path.join(collisionDir, path.basename(audio));
  const originalBytes = authoredAudioFixture(40), collisionBytes = Buffer.from(originalBytes), unsampledOffset = 100000, sampleSize = 64 * 1024;
  collisionBytes[unsampledOffset] ^= 1;
  const offsets = [0, Math.floor((originalBytes.length - sampleSize) / 2), originalBytes.length - sampleSize];
  assert.ok(offsets.every(offset => unsampledOffset < offset || unsampledOffset >= offset + sampleSize));
  assert.ok(!originalBytes.equals(collisionBytes));
  for (const offset of offsets) assert.ok(originalBytes.subarray(offset, offset + sampleSize).equals(collisionBytes.subarray(offset, offset + sampleSize)));
  const fixedMtime = new Date('2026-01-01T00:00:00.000Z');
  for (const [file, bytes] of [[audio, originalBytes], [collision, collisionBytes]]) {await fs.writeFile(file, bytes); await fs.utimes(file, fixedMtime, fixedMtime);}
  const originalStat = await fs.stat(audio), collisionStat = await fs.stat(collision);
  check('authored_native_collision_has_same_name_size_mtime_and_samples_but_different_bytes', path.basename(audio) === path.basename(collision) &&
    originalStat.size === collisionStat.size && originalStat.mtimeMs === collisionStat.mtimeMs);
  const replacement = path.join(directory, 'authored-replacement.wav'); await fs.writeFile(replacement, authoredAudioFixture(44));
  const subtitles = path.join(directory, 'transcript-first.srt');
  await fs.writeFile(subtitles, Array.from({length: 16}, (_, index) => `${index+1}\n00:00:${String(index*2).padStart(2,'0')},000 --> 00:00:${String(index*2+2).padStart(2,'0')},000\nAuthored sentence ${index+1} keeps its original words and source timestamps.\n`).join('\n'));
  const reader = new URL('../reader/', import.meta.url);
  server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if (!['GET','HEAD'].includes(req.method)) {mutations++; res.writeHead(405).end(); return;}
    if (name.startsWith('api/')) apiRequests.push(name);
    if (!/^[a-z-]+\.(html|js|css|png)$/.test(name)) {res.writeHead(404).end(); return;}
    try {res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'text/html'); res.end(await fs.readFile(new URL(name, reader)));}
    catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true});
  async function newPage(width = 390) {
    const context = await browser.newContext({acceptDownloads: true, serviceWorkers: 'block', viewport: {width, height: 844}});
    await context.route('**/*', route => {const url = new URL(route.request().url()); if (url.origin === origin || ['blob:','data:'].includes(url.protocol)) return route.continue(); external++; return route.abort();});
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message)); await page.goto(origin); return page;
  }
  const page = diagnosticPage = await newPage(); stage = 'native SRT before any local media';
  await choose(page, '#import', subtitles); await finished(page, 'file');
  const imported = await active(page), key = imported.key;
  check('plain_SRT_creates_one_unhosted_transcript', imported.segments.length === 16 && !imported.local_media_source && !imported.source_media && !imported.podcast_source);
  // Existing source editor accepts supported video hosts, including this
  // nonstandard YouTube port. Save the raw authored value; never open its link.
  const rawSourceURL = 'https://www.youtube.com:8443/watch?v=authored&Case=X#part';
  if (!await page.locator('#source').isVisible()) {
    const information = page.locator('#reading-info > summary');
    await (await information.isVisible() ? information : page.locator('#reading-settings > summary')).click();
  }
  await page.locator('#source').click(); await page.locator('#source-url').fill(rawSourceURL); await page.locator('#save-source').click();
  await expect(page.locator('#source-dialog')).toBeHidden();
  const sourceEdited = await active(page);
  check('source_editor_commits_raw_port_query_and_fragment_without_opening_the_URL', sourceEdited.key === key && sourceEdited.source_url === rawSourceURL && external === 0);
  if (await page.locator('#reading-info').evaluate(node => node.open)) await page.locator('#close-reading-info').click();
  await showMedia(page); await choose(page, '#attach-reader-media', audio); await finished(page, 'reader-media-file'); await ready(page);
  const associated = await active(page);
  check('first_native_attachment_persists_bounded_metadata_on_same_transcript_key', associated.key === key && associated.local_media_source.version === 1 &&
    associated.local_media_source.name === path.basename(audio) && associated.local_media_source.size === originalBytes.length &&
    JSON.stringify(associated.local_media_source).length < 1000 && (await disk(page)).documents.length === 1);
  assert.deepEqual(associated.segments, imported.segments);
  check('first_binding_preserves_exact_preexisting_source_URL_in_IndexedDB', associated.source_url === rawSourceURL);
  stage = 'native note, calibration and historical exact excerpt';
  await page.locator('#mode-transcript').click(); const firstCue = page.locator('.segment').first(); await openCueActions(firstCue);
  await firstCue.locator('.note-button').click(); await page.locator('#note').fill('Authored transcript-first note survives every association choice.'); await page.locator('#close-note').click();
  await showMedia(page); await page.locator('#source-media audio').evaluate(player => {player.pause(); player.currentTime = 2;}); await page.locator('#media-timing-align').click();
  await expect(page.locator('#media-timing-offset')).toHaveValue('2'); await page.locator('#media-timing-save').click(); await expect(page.locator('#media-timing-status')).toContainText('已保存偏移 2');
  await page.locator('#mode-passages').click(); await page.locator('.passage-quote').first().click(); await page.locator('#quotation-source').focus();
  await page.keyboard.press('Control+Home'); for (let index = 0; index < 18; index++) await page.keyboard.press('Shift+ArrowRight');
  await page.locator('#quotation-preview-selection').click(); await page.locator('#quotation-save').click();
  await expect.poll(async () => (await active(page)).exact_excerpts?.length).toBe(1); await page.locator('#quotation-close').click();
  await checkpoint(page, 15); const annotated = await active(page), annotations = preserved(annotated);
  check('notes_and_excerpt_saved_with_original_time_and_old_media_snapshot', annotated.notes['segment-1'].includes('transcript-first note') &&
    annotated.media_timing.offset === 2 && annotated.segments[0].start === 0 && annotated.source_url === rawSourceURL &&
    annotated.exact_excerpts[0].snapshot.source.source_url === rawSourceURL && annotated.exact_excerpts[0].snapshot.source.local_media_source.name === path.basename(audio));
  stage = 'IndexedDB reload and singleton transcript choice';
  await page.reload(); const reloaded = await active(page);
  check('real_IndexedDB_reload_keeps_key_text_notes_and_calibration_without_media', reloaded.key === key && reloaded.media_timing.offset === 2 && await page.locator('#source-media audio').count() === 0);
  assert.deepEqual(preserved(reloaded), annotations);
  await captureAbsentMedia(page, 'reloaded-bound-no-media', path.basename(audio));
  await homePick(page, audio); await expect(choice(page, key)).toBeVisible();
  check('one_transcript_candidate_still_requires_explicit_choice', await page.locator('#local-media-project-options button').count() === 1 &&
    await page.locator('#source-media audio').count() === 0 && (await disk(page)).documents.length === 1);
  const candidateText = await choice(page, key).innerText(), explanation = await page.locator('#local-media-project-dialog').innerText();
  check('candidate_discloses_partial_content_and_saved_offset', /文件信息/.test(explanation) && /部分内容/.test(explanation) && /候选/.test(explanation) && /2\s*秒/.test(candidateText));
  for (const width of [390, 1280]) {
    await page.setViewportSize({width, height: 844}); await dialogGeometry(page, 'candidate_' + width);
    await page.locator('#cancel-local-media-project').focus();
    for (const direction of ['Tab','Shift+Tab']) for (let index = 0; index < 4; index++) {await page.keyboard.press(direction); await keyboardGeometry(page, 'candidate_' + width + '_' + direction + '_' + index);}
    await capture(page, width + '-candidate');
  }
  await page.setViewportSize({width: 390, height: 844}); await choice(page, key).click(); await finished(page, 'local-media-file'); await ready(page);
  await visibleFocus(page, '#title', 'home_candidate_confirm');
  check('chosen_transcript_reopens_same_key_paused_with_saved_offset_and_controls_expanded', (await active(page)).key === key &&
    await page.locator('#source-media audio').evaluate(player => player.paused && player.currentTime === 0) &&
    await page.locator('#toggle-reader-media').getAttribute('aria-expanded') === 'true' && await page.locator('#media-timing-offset').inputValue() === '2');
  assert.deepEqual(preserved(await active(page)), annotations); await capture(page, '390-reused-transcript');
  stage = 'cancel and real same-metadata partial-content collision';
  await homePick(page, audio); const beforeCancel = await disk(page); await page.locator('#cancel-local-media-project').click(); await finished(page, 'local-media-file');
  assert.deepEqual(await disk(page), beforeCancel); check('cancel_leaves_existing_transcript_and_home_unchanged', await page.locator('#add-workspace').isVisible());
  await visibleFocus(page, '#open-local-media', 'home_candidate_cancel');
  await homePick(page, collision); await expect(choice(page, key)).toBeVisible();
  check('native_unsampled_byte_change_remains_only_a_candidate_and_requires_choice', await page.locator('#local-media-project-options button').count() === 1 &&
    /候选/.test(await page.locator('#local-media-project-dialog').innerText()) && (await active(page)).local_media_source.fingerprint === annotated.local_media_source.fingerprint);
  await page.locator('#cancel-local-media-project').click(); await finished(page, 'local-media-file'); assert.deepEqual(preserved(await active(page)), annotations);
  await visibleFocus(page, '#open-local-media', 'collision_candidate_cancel');
  stage = 'separate new audio project leaves original transcript untouched';
  await homePick(page, audio); await page.locator('#new-local-media-project').click(); await finished(page, 'local-media-file'); await ready(page);
  await visibleFocus(page, '#title', 'home_separate_new_confirm');
  const separate = await active(page);
  check('explicit_separate_branch_creates_audio_only_with_a_new_key', separate.key !== key && separate.project_kind === 'audio_only' && separate.segments.length === 0 && (await disk(page)).documents.length === 2);
  await page.locator('#project-note').fill('A separate authored audio-only note.'); await disk(page);
  assert.deepEqual(preserved((await disk(page)).documents.find(doc => doc.key === key)), annotations);
  await homePick(page, audio); await expect(page.locator('#local-media-project-options button')).toHaveCount(2); await choice(page, key).click(); await finished(page, 'local-media-file'); await ready(page);
  stage = 'current metadata-only JSON download and clean restore';
  if (!await page.locator('#export-menu').evaluate(node => node.open)) await page.locator('#export-menu > summary').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export').click()]);
  const backupPath = path.join(directory, 'transcript-current.json'); await download.saveAs(backupPath); const backupBytes = await fs.readFile(backupPath), backup = JSON.parse(backupBytes);
  assert.deepEqual(preserved(backup), annotations);
  check('actual_current_backup_contains_only_bounded_media_metadata', backup.local_media_source.fingerprint === annotated.local_media_source.fingerprint && backup.media_timing.offset === 2 &&
    backupBytes.length < 25000 && !/blob:|data:audio|base64|\/tmp\/|file:\/\//.test(backupBytes.toString('utf8')) &&
    Object.keys(backup.local_media_source).sort().join(',') === 'fingerprint,kind,last_modified,name,size,type,version');
  const restored = diagnosticPage = await newPage(); await choose(restored, '#import', backupPath); await finished(restored, 'file'); await restored.reload();
  const restoredKey = (await active(restored)).key; assert.deepEqual(preserved(await active(restored)), annotations);
  check('clean_context_restore_reloads_annotations_but_requires_native_media_reselection', await restored.locator('#source-media audio').count() === 0 &&
    (await active(restored)).media_timing.offset === 2 && (await disk(restored)).documents.length === 1);
  await homePick(restored, audio); await choice(restored, restoredKey).click(); await finished(restored, 'local-media-file'); await ready(restored);
  check('clean_restore_home_choice_keeps_its_committed_key_paused', (await active(restored)).key === restoredKey && await restored.locator('#source-media audio').evaluate(player => player.paused && player.currentTime === 0));
  await restored.locator('#media-timing-reset').click(); await restored.locator('#media-timing-save').click(); await expect(restored.locator('#media-timing-status')).toContainText('已保存偏移 0');
  check('explicit_reset_changes_only_timing_and_keeps_source_timestamps', (await active(restored)).media_timing.offset === 0); assert.deepEqual(preserved(await active(restored)), annotations);
  stage = 'explicit replacement cancellation and confirmation';
  await saveOffset(restored, 3); await checkpoint(restored, 17); const beforeReplace = await active(restored);
  await choose(restored, '#replace-reader-media', replacement); await expect(restored.locator('#local-media-project-dialog')).toBeVisible(); await warning(restored, 'replacement');
  await restored.locator('#cancel-local-media-project').click(); await finished(restored, 'reader-media-file'); assert.deepEqual(await active(restored), beforeReplace);
  await visibleFocus(restored, '#replace-reader-media', 'replacement_cancel');
  await choose(restored, '#replace-reader-media', replacement); await expect(restored.locator('#local-media-project-dialog')).toBeVisible();
  await restored.locator('#local-media-current-project').click(); await finished(restored, 'reader-media-file'); await ready(restored, 44); const replaced = await active(restored);
  check('replacement_keeps_key_but_clears_old_timing_duration_and_listening', replaced.key === restoredKey && replaced.local_media_source.name === path.basename(replacement) &&
    replaced.local_media_source.fingerprint !== annotated.local_media_source.fingerprint && !replaced.media_timing && replaced.media_duration === 44 &&
    await restored.evaluate(key => localStorage.getItem('coconut-listening-v1:' + key) === null, restoredKey) &&
    await restored.locator('#source-media audio').evaluate(player => player.paused && player.currentTime === 0));
  assert.deepEqual(preserved(replaced), annotations);
  stage = 'temporary detach retains durable association';
  await saveOffset(restored, 1); await checkpoint(restored, 19); const beforeDetach = await active(restored);
  await restored.locator('#detach-reader-media').click(); await expect(restored.locator('#source-media audio')).toHaveCount(0);
  assert.deepEqual(await active(restored), beforeDetach);
  check('temporary_detach_does_not_unlink_or_clear_saved_timing', (await active(restored)).local_media_source.name === path.basename(replacement) && (await active(restored)).media_timing.offset === 1);
  await choose(restored, '#attach-reader-media', replacement); await finished(restored, 'reader-media-file'); await ready(restored, 44);
  stage = 'explicit unlink cancellation, confirmation and reload';
  const beforeUnlink = await active(restored); await restored.locator('#unlink-reader-media').click(); await expect(restored.locator('#local-media-project-dialog')).toBeVisible(); await warning(restored, 'unlink');
  await restored.locator('#cancel-local-media-project').click(); assert.deepEqual(await active(restored), beforeUnlink);
  await visibleFocus(restored, '#unlink-reader-media', 'unlink_cancel');
  await restored.locator('#unlink-reader-media').click(); await expect(restored.locator('#local-media-project-dialog')).toBeVisible(); await restored.locator('#local-media-current-project').click();
  await expect(restored.locator('#source-media audio')).toHaveCount(0); const unlinked = await active(restored);
  await visibleFocus(restored, '#attach-reader-media', 'unlink_confirm');
  check('confirmed_unlink_clears_only_association_timing_duration_and_listening', unlinked.key === restoredKey && !unlinked.local_media_source && !unlinked.media_timing && !unlinked.media_duration &&
    await restored.evaluate(key => localStorage.getItem('coconut-listening-v1:' + key) === null, restoredKey));
  assert.deepEqual(preserved(unlinked), annotations); await captureAbsentMedia(restored, 'unlinked-no-media');
  await restored.reload(); assert.deepEqual(preserved(await active(restored)), annotations);
  check('unlink_reload_preserves_historical_excerpt_notes_and_raw_source_URL', (await active(restored)).key === restoredKey && !(await active(restored)).local_media_source &&
    (await active(restored)).source_url === rawSourceURL &&
    (await active(restored)).exact_excerpts[0].snapshot.source.local_media_source.name === path.basename(audio) && await restored.locator('#source-media audio').count() === 0);
  stage = 'sole audio-only match keeps the existing immediate reopen behavior';
  const audioOnly = diagnosticPage = await newPage(); await choose(audioOnly, '#open-local-media', audio); await finished(audioOnly, 'local-media-file'); await ready(audioOnly);
  await audioOnly.locator('#project-note').fill('Existing audio-only project note.'); const audioOnlyKey = (await active(audioOnly)).key;
  await audioOnly.locator('#add-content').click(); await choose(audioOnly, '#open-local-media', audio); await finished(audioOnly, 'local-media-file'); await ready(audioOnly);
  check('sole_audio_only_candidate_reopens_same_key_without_new_transcript_prompt', !await audioOnly.locator('#local-media-project-dialog').isVisible() &&
    (await active(audioOnly)).key === audioOnlyKey && (await disk(audioOnly)).documents.length === 1 &&
    await audioOnly.locator('#project-note').inputValue() === 'Existing audio-only project note.' &&
    await audioOnly.locator('#source-media audio').evaluate(player => player.paused && player.currentTime === 0));
  check('no_external_requests_models_uploads_or_page_errors', external === 0 && mutations === 0 && apiRequests.every(url => url === 'api/health') && errors.length === 0);
  console.log(JSON.stringify({suite: 'transcript-media-association', status: 'passed', checks}));
} catch (error) {
  failure = {stage, message: error.message}; process.exitCode = 1;
  if (diagnosticPage) await capture(diagnosticPage, 'failure').catch(() => {});
  console.error(JSON.stringify({suite: 'transcript-media-association', status: 'failed', stage, checks, errors, error: error.message}));
} finally {
  if (artifacts) {
    await fs.mkdir(artifacts, {recursive: true});
    await fs.writeFile(path.join(artifacts, 'transcript-media-association-checks.json'), JSON.stringify({suite: 'transcript-media-association',
      status: failure ? 'failed' : 'passed', stage, failure, checks, errors, geometry, screenshots, external, mutations, apiRequests}, null, 2));
  }
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); if (directory) await fs.rm(directory, {recursive: true, force: true});
}
