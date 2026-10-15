// Compatibility renderer regression; this suite is not default React acceptance.
/** CI-only real Chromium acceptance for pasted captions on an original-media project.
 * Native files contain authored PCM tones only; captions are authored below and
 * enter through trusted keyboard paste. Persistence evidence comes from production
 * IndexedDB. The delayed writer delegates to its actual transaction; quota failures
 * use the shared production-storage fault seam. No player or DOM mock, clipboard-
 * read permission, AI provider/model, personal media, or external API is used.
 * node --check is a syntax check, never browser acceptance evidence. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium, expect} from './helpers/browser-storage.mjs';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';

if (!process.env.CI) throw new Error('Project caption paste browser acceptance is CI-only; use node --check locally.');

const reader = new URL('../reader/', import.meta.url);
const checks = [], errors = [], apiRequests = [];
const unsafe = '<img src="/project-paste-xss-probe" onerror="window.__projectPasteAudit.xss++">';
const cues = [
  {id: 'segment-1', start: 1.25, end: 3.75, text: '你好 & hello.\nAn authored second line.', speaker: null},
  {id: 'segment-2', start: 8, end: 10.5, text: unsafe, speaker: null},
  {id: 'segment-3', start: 18, end: 20.25, text: 'The third authored source cue.', speaker: null},
  {id: 'segment-4', start: 26, end: 28.5, text: 'The final authored source cue remains complete.', speaker: null},
];
const srt = '\uFEFF1\r\n00:00:01,250 --> 00:00:03,750\r\n你好 &amp; hello.\r\nAn authored second line.\r\n\r\n' +
  '2\r\n00:00:08,000 --> 00:00:10,500\r\n' + unsafe + '\r\n\r\n' +
  '3\r\n00:00:18,000 --> 00:00:20,250\r\nThe third authored source cue.\r\n\r\n' +
  '4\r\n00:00:26,000 --> 00:00:28,500\r\nThe final authored source cue remains complete.\r\n';
const vtt = '\uFEFFWEBVTT\r\n\r\nNOTE Authored metadata is not transcript evidence.\r\n\r\n' +
  'voice-one\r\n00:01.250 --> 00:03.750 align:start\r\n<v Narrator>你好 &amp; hello.\r\nAn authored second line.</v>\r\n\r\n' +
  'voice-two\r\n00:08.000 --> 00:10.500\r\n&lt;img src="/project-paste-xss-probe" onerror="window.__projectPasteAudit.xss++"&gt;\r\n\r\n' +
  'voice-three\r\n00:18.000 --> 00:20.250\r\nThe third authored source cue.\r\n\r\n' +
  'voice-four\r\n00:26.000 --> 00:28.500\r\nThe final authored source cue remains complete.\r\n';
const broken = '\r\n5\r\n00:00:30,000 - 00:00:32,000\r\nAn authored malformed block must be reported.';
const standaloneText = '1\n00:00:02,000 --> 00:00:04,000\nIndependent authored standalone transcript.';
const normalized = value => value.replace(/\r\n?/g, '\n');
const snapshot = doc => doc.segments.map(({id, start, end, text, speaker}) => ({id, start, end, text, speaker: speaker ?? null}));
const preserved = doc => ({key: doc.key, title: doc.title, source_url: doc.source_url,
  local_media_source: doc.local_media_source, media_duration: doc.media_duration,
  project_note: doc.project_note, timestamp_bookmarks: doc.timestamp_bookmarks});
let browser, server, directory, stage = 'setup', external = 0, mutations = 0, xssRequests = 0;
const check = (name, value) => {assert.ok(value, name); checks.push(name);};
const disk = page => page.evaluate(() => readPersistedLibrary());
async function stored(page) {await page.evaluate(() => libraryStore.flush()); return disk(page);}
async function current(page) {
  const data = await stored(page), key = await page.evaluate(() => sessionStorage.getItem('coconut-reader-active-v1'));
  const doc = data.documents.find(doc => doc.key === key); assert.ok(doc, 'Active project is actually committed'); return doc;
}
async function choose(page, selector, file) {
  const [picker] = await Promise.all([page.waitForEvent('filechooser'), page.locator(selector).click()]);
  await picker.setFiles(file);
}
async function ready(page) {
  await page.waitForFunction(() => {
    const player = document.querySelector('#source-media audio');
    return player && !player.error && player.readyState >= 2 && Math.abs(player.duration - 40) < .01;
  });
}
async function showMedia(page) {
  if (!await page.locator('#attach-reader-media').isVisible()) await page.locator('#toggle-reader-media').click();
}
async function paste(page, value) {
  await page.bringToFront(); await page.locator('#paste-subtitle-text').focus();
  await page.keyboard.press('ControlOrMeta+A');
  // Only author-controlled text is written. No clipboard-read permission or
  // synthetic ClipboardEvent is installed; Chromium supplies the native paste.
  await page.evaluate(value => navigator.clipboard.writeText(value), value);
  await page.keyboard.press('ControlOrMeta+V');
  await expect(page.locator('#paste-subtitle-text')).toHaveValue(normalized(value));
}
async function preview(page) {
  await page.locator('#preview-paste-subtitle').click();
  await expect(page.locator('#confirm-paste-subtitle')).toBeEnabled();
}
async function openProjectPaste(page, original) {
  await page.locator('#paste-project-subtitles').click();
  await expect(page.locator('#paste-subtitle-dialog')).toBeVisible();
  await expect(page.locator('#paste-subtitle-destination')).toContainText(original.title);
  await expect(page.locator('#paste-subtitle-title')).toBeHidden();
  await expect(page.locator('#confirm-paste-subtitle')).toBeDisabled();
}
async function manualClock(page, time = 15.5) {
  await page.locator('#source-media audio').evaluate(async (player, time) => {
    player.pause();
    await new Promise(resolve => {player.addEventListener('seeked', resolve, {once: true}); player.currentTime = time;});
  }, time);
  await page.evaluate(() => {
    const audit = window.__projectPasteAudit, player = document.querySelector('#source-media audio');
    audit.player = player; audit.src = player.getAttribute('src'); audit.time = player.currentTime;
    audit.rate = player.playbackRate; audit.mediaEvents = [];
    audit.consent = document.getElementById('ai-consent').checked;
    audit.remember = document.getElementById('remember-local-media-choice').checked;
    for (const name of ['play', 'seeking', 'emptied', 'loadstart']) player.addEventListener(name, () => audit.mediaEvents.push(name));
  });
}
async function unmoved(page, label) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const result = await page.evaluate(() => {
    const audit = window.__projectPasteAudit, player = document.querySelector('#source-media audio');
    return {same: player === audit.player, src: player?.getAttribute('src') === audit.src,
      paused: player?.paused, time: player?.currentTime, expected: audit.time,
      rate: player?.playbackRate === audit.rate, events: audit.mediaEvents,
      consent: document.getElementById('ai-consent').checked === audit.consent,
      remember: document.getElementById('remember-local-media-choice').checked === audit.remember};
  });
  check(label + '_retains_player_source_paused_clock_rate_and_manual_consent_without_extra_seek',
    result.same && result.src && result.paused && Math.abs(result.time - result.expected) < .01 &&
    result.rate && result.events.length === 0 && result.consent && result.remember);
}
async function capture(page, label) {
  if (!process.env.COCONUT_UI_SCREENSHOTS) return;
  await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS, {recursive: true});
  await page.screenshot({path: path.join(process.env.COCONUT_UI_SCREENSHOTS, 'project-caption-paste-' + label + '.png'), animations: 'disabled'});
}
async function assertProject(page, original, expected, label) {
  const data = await stored(page), doc = data.documents.find(doc => doc.key === original.key);
  assert.deepEqual(preserved(doc), preserved(original)); assert.deepEqual(snapshot(doc), expected);
  check(label + '_is_one_original_key_title_source_duration_note_and_bookmark', data.documents.length === 1);
  check(label + '_no_blob_or_media_bytes_in_durable_metadata', !JSON.stringify(doc).includes('blob:') && JSON.stringify(doc).length < 10000);
  return doc;
}
async function hold(page) {await page.evaluate(() => {projectPasteSaveProbe.holdNext = true;});}
async function held(page) {await page.waitForFunction(() => !!projectPasteSaveProbe.held);}
async function release(page) {
  const before = await page.evaluate(() => {
    const before = projectPasteSaveProbe.finished;
    projectPasteSaveProbe.held.release(); projectPasteSaveProbe.held = null; return before;
  });
  await page.waitForFunction(before => projectPasteSaveProbe.finished > before, before);
}

try {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coconut-project-paste-'));
  const audio = path.join(directory, 'authored-project-original.wav');
  await fs.writeFile(audio, authoredAudioFixture(40));
  server = createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) {mutations++; res.writeHead(405).end(); return;}
    const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'compatibility.html';
    if (name.startsWith('api/')) apiRequests.push(name);
    if (name === 'project-paste-xss-probe') xssRequests++;
    if (!/^[a-z-]+\.(html|js|css|png|webmanifest)$/.test(name)) {res.writeHead(404).end(); return;}
    try {
      res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'text/html');
      res.end(await fs.readFile(new URL(name, reader)));
    } catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true});
  async function newPage(width = 390) {
    const context = await browser.newContext({acceptDownloads: true, serviceWorkers: 'block', viewport: {width, height: 844}});
    await context.grantPermissions(['clipboard-write'], {origin});
    await context.addInitScript(() => {
      window.__projectPasteAudit = {pastes: [], xss: 0};
      addEventListener('paste', event => {
        if (event.target.id === 'paste-subtitle-text') __projectPasteAudit.pastes.push(event.isTrusted);
      }, true);
    });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
      external++; return route.abort();
    });
    await context.route('**/storage-provider.js*', async route => {
      const response = await route.fetch(), body = await response.text();
      await route.fulfill({response, body: body + `\n(() => {
        const initialize = CoconutStorageProvider.initialize;
        window.projectPasteSaveProbe = {holdNext: false, held: null, finished: 0};
        CoconutStorageProvider.initialize = async function(...args) {
          const result = await initialize.apply(this, args);
          if (result.ok && result.backend === 'indexeddb') {
            const write = result.adapter.write.bind(result.adapter);
            result.adapter.write = async (...args) => {
              if (projectPasteSaveProbe.holdNext) {
                projectPasteSaveProbe.holdNext = false;
                await new Promise(resolve => {projectPasteSaveProbe.held = {release: resolve};});
              }
              try {return await write(...args);} finally {projectPasteSaveProbe.finished++;}
            };
          }
          return result;
        };
      })();`});
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message)); await page.goto(origin); return page;
  }
  async function originalProject(page) {
    await choose(page, '#open-local-media', audio); await ready(page);
    await expect(page.locator('#audio-project')).toBeVisible();
    await expect(page.locator('#local-media-file')).toHaveValue('');
    await page.locator('#project-note').fill('Authored project note: keep this with the original sound.');
    await page.locator('#audio-bookmark-time').fill('12.25');
    await page.locator('#audio-bookmark-note').fill('Authored original-media bookmark.');
    await page.locator('#audio-bookmark-form button[type=submit]').click();
    await page.locator('#playback-rate').selectOption('1.25');
    const original = await current(page);
    check('native_WAV_creates_audio_only_project_' + checks.length, original.project_kind === 'audio_only' &&
      original.segments.length === 0 && original.local_media_source.name === path.basename(audio) &&
      original.timestamp_bookmarks[0].time === 12.25 && original.media_duration === 40);
    await manualClock(page); return original;
  }

  for (const [width, text, format, expected] of [[390, srt, 'srt', cues], [1280, vtt, 'vtt', [{...cues[0], speaker: 'Narrator'}, ...cues.slice(1)]]]) {
    stage = 'original local audio and native ' + format + ' paste ' + width;
    const page = await newPage(width), original = await originalProject(page), before = JSON.stringify(await disk(page));
    check('project_paste_opener_has_native_touch_target_' + width, await page.locator('#paste-project-subtitles').evaluate(node => {
      const rect = node.getBoundingClientRect(); return rect.width >= 44 && rect.height >= 44;
    }));
    await page.locator('#audio-bookmark-time').fill('24.5');
    await page.locator('#audio-bookmark-note').fill('Keep the unsubmitted bookmark draft.');
    await openProjectPaste(page, original);
    for (const invalid of ['', 'Authored prose without timestamps.', '1\n00:00:04,000 --> 00:00:01,000\nBackwards authored timing.']) {
      await paste(page, invalid); await page.locator('#preview-paste-subtitle').click();
      await expect(page.locator('#confirm-paste-subtitle')).toBeDisabled();
      await expect(page.locator('#paste-subtitle-status')).toContainText('无法预览');
      check('invalid_input_never_fabricates_or_saves_' + width + '_' + checks.length, JSON.stringify(await disk(page)) === before);
    }
    await paste(page, text + broken); await preview(page);
    await expect(page.locator('#paste-subtitle-status')).toContainText('4 段');
    await expect(page.locator('#paste-subtitle-status')).toContainText('00:01.250–00:28.500');
    await expect(page.locator('#paste-subtitle-status')).toContainText('跳过 1 个字幕块');
    await expect(page.locator('#paste-subtitle-preview > li')).toHaveCount(3);
    await expect(page.locator('#paste-subtitle-preview')).toContainText(cues[0].text);
    await expect(page.locator('#paste-subtitle-preview')).toContainText(unsafe);
    await page.locator('#paste-subtitle-diagnostics summary').first().click();
    await expect(page.locator('#paste-subtitle-diagnostics')).toContainText('An authored malformed block must be reported.');
    check('preview_is_bounded_safe_and_does_not_mutate_project_' + width,
      await page.locator('#paste-subtitle-preview img, #paste-subtitle-preview script').count() === 0 &&
      !(await page.locator('#paste-subtitle-preview').textContent()).includes(cues[3].text) && JSON.stringify(await disk(page)) === before);
    await capture(page, 'preview-' + width); await unmoved(page, 'preview_' + width);
    await page.keyboard.press('Escape');
    await expect(page.locator('#paste-subtitle-dialog')).toBeHidden();
    await expect(page.locator('#paste-project-subtitles')).toBeFocused();
    await openProjectPaste(page, original);
    await expect(page.locator('#paste-subtitle-text')).toHaveValue(normalized(text + broken));
    check('Escape_preserves_target_draft_and_original_project_' + width, JSON.stringify(await disk(page)) === before);
    await preview(page); await page.locator('#paste-subtitle-format').selectOption(format);
    await expect(page.locator('#confirm-paste-subtitle')).toBeDisabled();
    await preview(page); await paste(page, text);
    await expect(page.locator('#confirm-paste-subtitle')).toBeDisabled(); await preview(page);
    check('changed_format_and_text_require_fresh_preview_' + width, JSON.stringify(await disk(page)) === before);
    await hold(page); await page.locator('#confirm-paste-subtitle').click(); await held(page);
    await expect(page.locator('#paste-subtitle-dialog')).toBeVisible();
    check('attachment_waits_for_real_commit_receipt_' + width, JSON.stringify(await disk(page)) === before);
    await unmoved(page, 'pending_attachment_' + width);
    await release(page); await expect(page.locator('#paste-subtitle-dialog')).toBeHidden();
    await expect(page.locator('#title')).toHaveText(original.title);
    await assertProject(page, original, expected, 'saved_' + format + '_' + width);
    await unmoved(page, 'saved_attachment_' + width);
    await expect(page.locator('#paste-project-subtitles')).toBeHidden();
    await expect(page.locator('#audio-bookmark-time')).toHaveValue('24.5');
    await expect(page.locator('#audio-bookmark-note')).toHaveValue('Keep the unsubmitted bookmark draft.');
    check('attachment_preserves_unsubmitted_bookmark_draft_' + width, true);
    await page.locator('#cancel-audio-bookmark').click();
    await expect(page.locator('#mode-transcript')).toHaveAttribute('aria-pressed', 'true');
    assert.deepEqual(await page.locator('.words').allTextContents(), expected.map(cue => cue.text));

    // An audio-only project has no timing editor. Calibrate after words arrive
    // through the actual UI, then prove source-cue seeking uses that offset.
    stage = 'manual timing and original-source controls ' + width;
    await showMedia(page); await page.locator('#media-timing-offset').fill('2');
    await page.locator('#media-timing-save').click();
    await expect(page.locator('#media-timing-status')).toContainText('已保存偏移 2');
    await unmoved(page, 'manual_timing_save_' + width);
    const calibrated = await assertProject(page, original, expected, 'calibrated_' + width);
    check('offset_is_durable_without_rewriting_source_cues_' + width, calibrated.media_timing.offset === 2 && calibrated.segments[0].start === 1.25);
    await page.locator('.segment .time button').first().click();
    await page.waitForFunction(() => {
      const player = document.querySelector('#source-media audio'); return player && player.currentTime >= 3.25 && player.currentTime < 5;
    });
    await page.locator('#source-media audio').evaluate(player => player.pause());
    check('explicit_source_cue_uses_same_original_player_and_saved_offset_' + width,
      await page.evaluate(() => document.querySelector('#source-media audio') === __projectPasteAudit.player));
    await showMedia(page); await page.locator('#playback-rate').selectOption('1.5');
    const pausedTime = await page.locator('#source-media audio').evaluate(player => player.currentTime);
    await page.locator('#skip-forward').click();
    await expect.poll(() => page.locator('#source-media audio').evaluate(player => player.currentTime)).toBeCloseTo(pausedTime + 10, 1);
    check('media_controls_remain_explicit_and_paused_' + width,
      await page.locator('#source-media audio').evaluate(player => player.paused && player.playbackRate === 1.5) &&
      await page.locator('#follow-playback').getAttribute('aria-pressed') === 'false');
    await capture(page, 'reading-' + width);
    check('keyboard_paste_is_native_and_trusted_' + width,
      await page.evaluate(() => __projectPasteAudit.pastes.length > 0 && __projectPasteAudit.pastes.every(Boolean) && __projectPasteAudit.xss === 0));
    await stored(page); await page.reload();
    await expect(page.locator('#source-media audio')).toHaveCount(0);
    const reloaded = await assertProject(page, original, expected, 'reloaded_' + width);
    assert.deepEqual(reloaded.media_timing, calibrated.media_timing);
    await showMedia(page); await choose(page, '#attach-reader-media', audio); await ready(page);
    await expect(page.locator('#media-timing-offset')).toHaveValue('2');
    check('reload_needs_explicit_reselection_and_never_autoplays_' + width,
      await page.locator('#source-media audio').evaluate(player => player.paused && player.currentTime === 0));
    await page.context().close();
  }

  stage = 'failed real project commit and retry';
  const failed = await newPage(), original = await originalProject(failed), beforeFailure = JSON.stringify(await disk(failed));
  await openProjectPaste(failed, original); await paste(failed, srt); await preview(failed);
  await failed.evaluate(() => failContentWrites()); await failed.locator('#confirm-paste-subtitle').click();
  for (const selector of ['#retry-paste-subtitle', '#read-paste-subtitle', '#export-paste-subtitle']) await expect(failed.locator(selector)).toBeVisible();
  await expect(failed.locator('#paste-subtitle-dialog')).toBeVisible();
  await expect(failed.locator('#paste-subtitle-text')).toHaveValue(normalized(srt));
  check('failed_attachment_does_not_claim_durable_transcript_or_duplicate_project', JSON.stringify(await disk(failed)) === beforeFailure);
  await unmoved(failed, 'failed_attachment'); await capture(failed, 'failed-save');
  const [rescue] = await Promise.all([failed.waitForEvent('download'), failed.locator('#export-paste-subtitle').click()]);
  assert.equal(await rescue.failure(), null);
  const rescued = JSON.parse(await fs.readFile(await rescue.path(), 'utf8'));
  assert.deepEqual(snapshot(rescued), cues);
  check('actual_rescue_download_keeps_original_media_and_project_annotations', rescued.title === original.title &&
    rescued.local_media_source.fingerprint === original.local_media_source.fingerprint && rescued.project_note === original.project_note &&
    JSON.stringify(rescued.timestamp_bookmarks) === JSON.stringify(original.timestamp_bookmarks) && !JSON.stringify(rescued).includes('blob:'));
  check('rescue_download_does_not_fake_save_success', JSON.stringify(await disk(failed)) === beforeFailure);
  await failed.evaluate(() => restoreContentWrites()); await failed.locator('#retry-paste-subtitle').click();
  await expect(failed.locator('#paste-subtitle-dialog')).toBeHidden();
  await assertProject(failed, original, cues, 'retried'); await unmoved(failed, 'retried_attachment');
  await failed.reload(); await assertProject(failed, original, cues, 'retried_reloaded'); await failed.context().close();

  stage = 'cancelled late receipt cannot take over standalone paste';
  const changed = await newPage(), pendingOriginal = await originalProject(changed);
  await openProjectPaste(changed, pendingOriginal); await paste(changed, srt); await preview(changed);
  await hold(changed); await changed.locator('#confirm-paste-subtitle').click(); await held(changed);
  await changed.locator('#close-paste-subtitle').click(); await expect(changed.locator('#paste-subtitle-dialog')).toBeHidden();
  await changed.locator('#add-content').click(); await changed.locator('#paste-subtitles').click();
  await expect(changed.locator('#paste-subtitle-title')).toBeVisible();
  await changed.locator('#paste-subtitle-title').fill('Authored independent standalone'); await paste(changed, standaloneText);
  await release(changed); await stored(changed);
  await expect(changed.locator('#paste-subtitle-dialog')).toBeVisible();
  await expect(changed.locator('#paste-subtitle-title')).toHaveValue('Authored independent standalone');
  await expect(changed.locator('#paste-subtitle-text')).toHaveValue(standaloneText);
  await expect(changed.locator('#confirm-paste-subtitle')).toBeDisabled();
  await expect(changed.locator('#add-workspace')).toBeVisible();
  await assertProject(changed, pendingOriginal, cues, 'late_cancelled_receipt');
  check('late_receipt_cannot_close_new_dialog_clear_new_draft_or_steal_navigation', true);
  await preview(changed); await changed.locator('#confirm-paste-subtitle').click();
  await expect(changed.locator('#paste-subtitle-dialog')).toBeHidden();
  await expect(changed.locator('#title')).toHaveText('Authored independent standalone');
  const both = await stored(changed), independent = await current(changed);
  assert.deepEqual(preserved(both.documents.find(doc => doc.key === pendingOriginal.key)), preserved(pendingOriginal));
  check('independent_standalone_paste_still_creates_separate_text_without_retargeting_original', both.documents.length === 2 &&
    independent.key !== pendingOriginal.key && independent.segments[0].text === 'Independent authored standalone transcript.' && !independent.local_media_source);
  await changed.context().close();

  check('no_uploads_models_external_requests_XSS_or_page_errors', external === 0 && mutations === 0 && xssRequests === 0 &&
    apiRequests.every(url => url === 'api/health') && errors.length === 0);
  console.log(JSON.stringify({suite: 'project-caption-paste', status: 'passed', checks}));
} catch (error) {
  if (browser && process.env.COCONUT_UI_SCREENSHOTS) {
    let index = 0;
    for (const context of browser.contexts()) for (const page of context.pages()) if (!page.isClosed()) {
      try {await capture(page, 'failure-' + (++index) + '-' + (page.viewportSize()?.width || 'unknown'));}
      catch {/* Evidence capture must not mask the original assertion. */}
    }
  }
  console.error(JSON.stringify({suite: 'project-caption-paste', status: 'failed', stage, checks, errors, external, mutations, apiRequests, error: error.stack}));
  process.exitCode = 1;
} finally {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  if (directory) await fs.rm(directory, {recursive: true, force: true});
}
