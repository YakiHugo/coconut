import {openCueActions} from './cue-actions-browser.mjs';
/**
 * Real Chromium acceptance against a prepared, completed local job.
 * Run after scripts/prepare_browser_acceptance.py; Chromium is installed by CI.
 * Never publish source material: no traces, screenshots, browser/server logs,
 * exception messages, titles, source URLs, or export filenames are reported.
 * All downloaded artifacts and the browser profile are temporary and removed.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const started = Date.now();
const report = {schema_version: 1, suite: 'real-browser-acceptance', status: 'failed', checks: {}, counts: {}};
let stage = 'configuration';
let browser, server, temporary;
let pageErrors = 0, blockedRequests = 0;
process.umask(0o077);
// Debug logging can include selectors or source URLs. This suite is deliberately
// content-free even when invoked by a developer with Playwright debugging set.
delete process.env.DEBUG;
delete process.env.PWDEBUG;

function check(name, condition) {
  stage = name;
  if (!condition) throw new Error('Acceptance check failed');
  report.checks[name] = true;
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const outsideCheckout = filename => {
  const relative = path.relative(root, filename);
  return relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
};

async function startServer(dataDir, port) {
  const child = spawn(process.env.COCONUT_ACCEPTANCE_PYTHON || 'python3',
    ['serve.py', '--port', String(port), '--data-dir', dataDir],
    {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
  server = child;
  // Consume output without forwarding any private path, metadata, or content.
  child.stderr.on('data', () => {});
  return await new Promise((resolve, reject) => {
    let pending = '', settled = false;
    const timer = setTimeout(() => finish(), 30000);
    const finish = origin => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      origin ? resolve(origin) : reject(new Error('Server unavailable'));
    };
    child.on('error', () => finish());
    child.on('exit', () => finish());
    child.stdout.on('data', chunk => {
      pending = (pending + chunk.toString()).slice(-4096);
      const match = pending.match(/Coconut is ready at http:\/\/127\.0\.0\.1:(\d+)\r?\n/);
      if (match) finish('http://127.0.0.1:' + match[1]);
    });
  });
}

async function storedDocument(page) {
  await page.evaluate(()=>libraryStore.flush());
  return await page.evaluate(async () => {
    const library = (await readPersistedLibrary());
    return library?.documents.find(document => document.key === sessionStorage.getItem('coconut-reader-active-v1')) || null;
  });
}

async function waitForDocument(page, count) {
  await page.waitForFunction(async expected => {
    const library = (await readPersistedLibrary());
    const document = library?.documents.find(item => item.key === sessionStorage.getItem('coconut-reader-active-v1'));
    return document?.segments.length === expected && !window.document.getElementById('reader-workspace').hidden;
  }, count);
  await page.locator('#mode-transcript').click();
}

async function importFile(page, filename, count) {
  await page.locator('#add-content').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'), page.locator('#import').click(),
  ]);
  await chooser.setFiles(filename);
  await waitForDocument(page, count);
  await page.waitForFunction(() => document.getElementById('file').value === '');
}

function row(page, id) {
  // IDs come from the transcript. Escape as a CSS string without logging them.
  const escaped = String(id).replace(/[\x00-\x1f\x7f"\\]/g, character => '\\' + character.codePointAt(0).toString(16) + ' ');
  return page.locator('#transcript .segment[data-segment-id="' + escaped + '"]');
}

async function goToSegment(page, document, index) {
  if (await page.locator('#clear-search').isVisible()) await page.locator('#clear-search').click();
  if (!(await page.locator('#reading-settings').evaluate(node => node.open))) {
    await page.locator('#reading-settings > summary').click();
  }
  const segment = document.segments[index];
  await page.locator('#reading-time').fill(segment.start.toFixed(3));
  await page.locator('#time-navigation button[type="submit"]').click();
  // Shared/overlapping timestamps can resolve to an adjacent cue. Navigate by
  // actual page controls if that puts the requested segment over a page edge.
  for (let attempt = 0; attempt <= Math.ceil(document.segments.length / 100); attempt++) {
    if (await row(page, segment.id).count()) return row(page, segment.id);
    const firstId = await page.locator('#transcript .segment').first().getAttribute('data-segment-id');
    const firstIndex = document.segments.findIndex(item => item.id === firstId);
    check('page_navigation_has_known_cues', firstIndex >= 0);
    await page.locator(index < firstIndex ? '#previous-page' : '#next-page').click();
  }
  check('requested_segment_visible', false);
}

async function openExports(page) {
  if (!(await page.locator('#export-menu').evaluate(node => node.open))) {
    await page.locator('#export-menu > summary').click();
  }
}

async function download(page, button, name) {
  await openExports(page);
  const [artifact] = await Promise.all([page.waitForEvent('download'), page.locator(button).click()]);
  const filename = path.join(temporary, name);
  await artifact.saveAs(filename);
  check('download_' + name.replaceAll('.', '_'), await artifact.failure() === null && (await fs.stat(filename)).size > 0);
  report.counts[name.replaceAll('.', '_') + '_bytes'] = (await fs.stat(filename)).size;
  return filename;
}

function parseSubtitle(text, format) {
  const stamp = value => {
    const parts = value.replace(',', '.').split(':').map(Number);
    return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
  };
  const cues = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const index = lines.findIndex(line => line.includes(' --> '));
    if (index < 0) continue;
    const match = lines[index].match(/^(\d{2,}:\d{2}:\d{2}[,.]\d{3}) --> (\d{2,}:\d{2}:\d{2}[,.]\d{3})$/);
    check(format + '_timestamp_format', Boolean(match));
    cues.push({start: stamp(match[1]), end: stamp(match[2]), text: lines.slice(index + 1).join('\n').replace(/\n+$/, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')});
  }
  return cues;
}

const subtitleText = text => text.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim()).join('\n');
const markdownText = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#+.!|~$-]/g, '\\$&').replace(/\r\n?/g, '\n');
const markdownQuote = text => markdownText(text).replace(/\n/g, '\n> ');

async function verifyRestoration(page, expected, indices, marker) {
  const actual = await storedDocument(page);
  check(marker + '_all_cues', actual?.segments.length === expected.segments.length && actual.segments.every((segment, index) => {
    const prior = expected.segments[index];
    return segment.id === prior.id && segment.start === prior.start && segment.end === prior.end &&
      segment.text === prior.text && segment.original_text === prior.original_text && segment.saved_excerpt === prior.saved_excerpt;
  }));
  check(marker + '_notes', JSON.stringify(actual.notes) === JSON.stringify(expected.notes));
  check(marker + '_position', actual.readingPosition === expected.readingPosition);
  check(marker + '_source', actual.source_url === expected.source_url &&
    JSON.stringify(actual.source_media) === JSON.stringify(expected.source_media) &&
    JSON.stringify(actual.provenance) === JSON.stringify(expected.provenance));
  await page.locator('#resume').click();
  check(marker + '_resume_ui', await row(page, expected.segments[indices.last].id).locator('.bookmark-button').getAttribute('aria-pressed') === 'true');
  const editedRow = await goToSegment(page, actual, indices.middle);
  check(marker + '_correction_ui', await editedRow.locator('.words').textContent() === expected.segments[indices.middle].text);
  await editedRow.locator('.note-button').click();
  check(marker + '_note_ui', await page.locator('#note').inputValue() === expected.notes[expected.segments[indices.middle].id]);
  await page.locator('#close-note').click();
  await openCueActions(row(page, expected.segments[indices.middle].id));
  await row(page, expected.segments[indices.middle].id).locator('.edit-button').click();
  await page.locator('#restore-edit').click();
  check(marker + '_original_ui', await page.locator('#edit-segment').inputValue() === expected.segments[indices.middle].original_text);
  await page.locator('#edit-dialog button[value="cancel"]').click();
}

async function mediaAcceptance(page, document, indices) {
  const player = page.locator('#source-media audio, #source-media video');
  stage = 'real_media_metadata';
  await player.waitFor({state: 'visible'});
  await page.waitForFunction(() => {
    const media = document.querySelector('#source-media audio, #source-media video');
    return media && !media.error && Number.isFinite(media.duration) && media.duration > 0 && media.readyState >= 2;
  }, undefined, {timeout: 60000});
  const metadata = await player.evaluate(media => ({duration: media.duration, video: media.tagName === 'VIDEO',
    width: media.videoWidth || 0, height: media.videoHeight || 0}));
  check('real_media_metadata', metadata.duration >= document.segments.at(-1).start);
  check('served_media_association', await player.getAttribute('src') === '/api/jobs/' + document.source_media.job_id + '/media');
  if (metadata.video) check('video_decoded_dimensions', metadata.width > 0 && metadata.height > 0);
  report.counts.media_duration_seconds = Math.round(metadata.duration * 1000) / 1000;
  report.counts.video_width = metadata.width;
  report.counts.video_height = metadata.height;

  for (const [label, index] of Object.entries(indices)) {
    stage = 'media_seek_' + label;
    const segment = document.segments[index];
    const target = await goToSegment(page, document, index);
    if (document.source_url) {
      const expected = new URL(document.source_url);
      expected.searchParams.set('t', String(Math.max(0, Math.floor(segment.start))));
      expected.hash = '';
      check('source_link_' + label + '_timestamp', await target.locator('.original-source').getAttribute('href') === expected.href);
    }
    const beforeFrames = await player.evaluate(media => media.getVideoPlaybackQuality?.().totalVideoFrames || 0);
    await target.locator('.time > button').first().click();
    const advance = Math.min(0.15, (segment.end - segment.start) / 3, (metadata.duration - segment.start) / 3);
    check('seek_' + label + '_has_playable_interval', advance > 0);
    await page.waitForFunction(({start, advance}) => {
      const media = document.querySelector('#source-media audio, #source-media video');
      return media && !media.error && !media.paused && !media.seeking && media.readyState >= 2 && media.currentTime >= start + advance;
    }, {start: segment.start, advance}, {timeout: 30000});
    const observed = await player.evaluate(media => {
      media.pause();
      return {time: media.currentTime, frames: media.getVideoPlaybackQuality?.().totalVideoFrames || 0};
    });
    check('seek_' + label + '_time_progressed', observed.time > segment.start && observed.time < segment.start + 3);
    if (metadata.video) check('seek_' + label + '_frames_decoded', observed.frames > beforeFrames);
    // Pause dispatches a final genuine timeupdate; do not fabricate media events.
    const playing = document.segments.findLast(cue => cue.start <= observed.time && cue.end >= observed.time);
    check('seek_' + label + '_inside_captions', Boolean(playing));
    await page.waitForFunction(id => [...document.querySelectorAll('#transcript .segment.playing')].some(node => node.dataset.segmentId === id), playing.id);
    check('seek_' + label + '_highlight', await row(page, playing.id).evaluate(node => node.classList.contains('playing')));
    // With text deliberately on another page, the UI must find the playing cue.
    await goToSegment(page, document, index === indices.first ? indices.last : indices.first);
    await page.locator('#locate-playback').click();
    check('seek_' + label + '_locate_text', await row(page, playing.id).count() === 1);
  }

  stage = 'media_skip_and_rate_controls';
  const beforeSkip = await player.evaluate(media => media.currentTime);
  await page.locator('#skip-back').click();
  const afterBack = await player.evaluate(media => media.currentTime);
  check('skip_back_ten_seconds', Math.abs(afterBack - Math.max(0, beforeSkip - 10)) < 0.1);
  await page.locator('#skip-forward').click();
  check('skip_forward_ten_seconds', Math.abs(await player.evaluate(media => media.currentTime) - Math.min(metadata.duration, afterBack + 10)) < 0.1);
  check('skip_does_not_start_playback', await player.evaluate(media => media.paused));
  await page.locator('#playback-rate').selectOption('1.5');
  check('native_playback_rate', await player.evaluate(media => media.playbackRate) === 1.5);

  stage = 'native_repeat_playback';
  // A short real cue keeps CI bounded while testing natural end-of-cue looping.
  const loopIndex = document.segments.findIndex(segment => segment.end - segment.start >= 0.5 && segment.end - segment.start <= 5 && segment.end <= metadata.duration);
  check('repeat_has_meaningful_cue', loopIndex >= 0);
  const loopCue = document.segments[loopIndex];
  const loopRow = await goToSegment(page, document, loopIndex);
  await openCueActions(loopRow);
  await loopRow.locator('.repeat-button').click();
  await page.waitForFunction(({start, end}) => {
    const media = document.querySelector('#source-media audio, #source-media video');
    return media && !media.paused && !media.seeking && media.currentTime >= start && media.currentTime < end;
  }, {start: loopCue.start, end: loopCue.end});
  check('repeat_control_active', await row(page, loopCue.id).locator('.repeat-button').getAttribute('aria-pressed') === 'true');
  const repeated = await player.evaluate((media, start) => new Promise(resolve => {
    let previous = media.currentTime;
    const finish = result => {clearTimeout(timer); media.removeEventListener('timeupdate', observe); resolve(result);};
    const observe = () => {
      const current = media.currentTime;
      if (previous > start + 0.2 && current < previous - 0.15 && current < start + 0.4) finish(true);
      previous = current;
    };
    const timer = setTimeout(() => finish(false), 15000);
    media.addEventListener('timeupdate', observe);
  }), loopCue.start);
  check('natural_repeat_rewinds', repeated);
  await page.locator('#stop-repeat').click();
  check('repeat_stops_from_toolbar', await page.locator('#stop-repeat').isHidden() && await row(page, loopCue.id).locator('.repeat-button').getAttribute('aria-pressed') === 'false');
  await player.evaluate(media => media.pause());
  await openCueActions(row(page, loopCue.id));
  await row(page, loopCue.id).locator('.repeat-button').click();
  await page.locator('#skip-forward').click();
  check('skip_cancels_repeat', await page.locator('#stop-repeat').isHidden());
  await player.evaluate(media => media.pause());
}

try {
  const mode = process.env.COCONUT_ACCEPTANCE_MODE || 'synthetic';
  check('known_mode', ['synthetic', 'original'].includes(mode));
  report.mode = mode;
  check('input_environment_set', Boolean(process.env.COCONUT_ACCEPTANCE_DATA_DIR && process.env.COCONUT_ACCEPTANCE_RESULT));
  const dataDir = await fs.realpath(process.env.COCONUT_ACCEPTANCE_DATA_DIR);
  const resultFile = await fs.realpath(process.env.COCONUT_ACCEPTANCE_RESULT);
  check('input_outside_checkout', outsideCheckout(dataDir) && outsideCheckout(resultFile));
  const source = JSON.parse(await fs.readFile(resultFile, 'utf8'));
  check('prepared_transcript', Array.isArray(source.segments) && source.segments.length >= 3);
  check('prepared_completed_job_association', /^[a-f0-9]{32}$/.test(source.source_media?.job_id || ''));
  const port = Number(process.env.COCONUT_ACCEPTANCE_PORT || 0);
  check('loopback_port_valid', Number.isInteger(port) && port >= 0 && port <= 65535);
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'coconut-browser-acceptance-'));
  stage = 'start_local_server';
  const origin = await startServer(dataDir, port);
  const health = await fetch(origin + '/api/health').then(response => response.json());
  check('real_local_worker', health.local_worker === true);
  const jobs = await fetch(origin + '/api/jobs').then(response => response.json());
  check('prepared_job_available', jobs.jobs.filter(job => job.status === 'done').length === 1 && jobs.jobs.some(job => job.id === source.source_media.job_id && job.status === 'done'));

  stage = 'launch_installed_chromium';
  const {chromium} = await import('./helpers/browser-storage.mjs');
  browser = await chromium.launch({headless: true, ...(process.env.COCONUT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE} : {})});
  const newContext = async () => {
    const context = await browser.newContext({acceptDownloads: true, viewport: {width: 1440, height: 1000}, serviceWorkers: 'block'});
    // Prevent accidental navigation, model calls, or data transmission. Requests
    // to the real loopback service and actual media stay entirely unmocked.
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if ((url.origin === origin && ['GET', 'HEAD'].includes(request.method())) || ['blob:', 'data:'].includes(url.protocol)) await route.continue();
      else {blockedRequests++; await route.abort();}
    });
    context.on('page', page => page.on('pageerror', () => {pageErrors++;}));
    return context;
  };
  let context = await newContext();
  let page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(origin, {waitUntil: 'domcontentloaded'});
  stage = 'browser_file_chooser_import';
  await importFile(page, resultFile, source.segments.length);
  let document = await storedDocument(page);
  check('file_import_all_cues', document.segments.every((segment, index) => {
    const original = source.segments[index];
    return segment.text === original.text && segment.start === original.start && segment.end === original.end;
  }));
  report.counts.segments = document.segments.length;
  check('page_size_limited', await page.locator('#transcript .segment').count() === Math.min(100, document.segments.length));

  stage = 'completed_job_open_in_browser';
  await page.locator('#show-jobs').waitFor({state: 'visible'});
  await page.locator('#show-jobs').click();
  const resultResponse = page.waitForResponse(response => response.url() === origin + '/api/jobs/' + source.source_media.job_id + '/result' && response.request().method() === 'GET');
  await page.locator('.job-row[data-job-id="' + source.source_media.job_id + '"] [data-job-action="open"]').click();
  check('completed_job_result_response', (await resultResponse).ok());
  await waitForDocument(page, source.segments.length);
  document = await storedDocument(page);
  check('completed_job_media_association', document.source_media?.job_id === source.source_media.job_id);
  const indices = {first: 0, middle: Math.floor(document.segments.length / 2), last: document.segments.length - 1};

  stage = 'whole_document_search';
  const query = document.segments[indices.last].text.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 48) || '';
  check('source_search_term_available', query.length > 0);
  const matched = document.segments.filter(segment => [segment.text, segment.speaker || '', document.notes[segment.id] || '',
    ...Object.values(segment.translations || {}).filter(item => item.source_text === segment.text && !item.context_id && !item.provider?.endsWith('_subscription_translation')).map(item => item.text)]
    .join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  await page.locator('#search').fill(query);
  check('search_full_document_count', (await page.locator('#search-status').textContent()).startsWith('找到 ' + matched.length + ' 个片段'));
  await page.locator('#previous-match').click();
  check('search_reaches_last_match', await row(page, matched.at(-1).id).count() === 1);
  check('source_search_highlight', await row(page, document.segments[indices.last].id).locator('.words mark').count() > 0);
  await page.locator('#clear-search').click();

  stage = 'notes_excerpts_correction_and_bookmark';
  const noteMarkers = ['CoconutAcceptanceNoteFirst', 'CoconutAcceptanceNoteMiddle', 'CoconutAcceptanceNoteLast'];
  for (const [position, index] of Object.values(indices).entries()) {
    const target = await goToSegment(page, document, index);
    await target.locator('.note-button').click();
    await page.locator('#note').fill(noteMarkers[position]);
    await page.locator('#close-note').click();
    if (position < 2 && await row(page, document.segments[index].id).locator('.excerpt-button').getAttribute('aria-pressed') !== 'true') {
      await openCueActions(row(page, document.segments[index].id));
      await row(page, document.segments[index].id).locator('.excerpt-button').click();
    }
  }
  await openCueActions(row(page, document.segments[indices.last].id));
  await row(page, document.segments[indices.last].id).locator('.bookmark-button').click();
  const middle = await goToSegment(page, document, indices.middle);
  const originalText = document.segments[indices.middle].original_text ?? document.segments[indices.middle].text;
  const correction = document.segments[indices.middle].text + ' CoconutAcceptanceCorrection';
  await openCueActions(middle);
  await middle.locator('.edit-button').click();
  await page.locator('#edit-segment').fill(correction);
  await page.locator('#save-edit').click();
  document = await storedDocument(page);
  check('correction_preserves_original', document.segments[indices.middle].text === correction && document.segments[indices.middle].original_text === originalText);
  check('three_notes_persisted', Object.values(indices).every((index, position) => document.notes[document.segments[index].id] === noteMarkers[position]));
  check('two_excerpts_persisted', document.segments[indices.first].saved_excerpt === true && document.segments[indices.middle].saved_excerpt === true);
  await page.locator('#filter-excerpts').click();
  check('excerpt_filter', await page.locator('#transcript .segment').count() === Math.min(100, document.segments.filter(segment => segment.saved_excerpt).length));
  await page.locator('#filter-notes').click();
  await page.locator('#search').fill(noteMarkers[1]);
  check('note_search', await page.locator('#transcript .segment').count() === 1 && await row(page, document.segments[indices.middle].id).locator('.saved-note mark').count() === 1);

  stage = 'downloads_are_real_files';
  // Export with only one note search result visible. Every export must still
  // contain its whole-document scope, including first/middle/last annotations.
  const jsonFile = await download(page, '#export', 'backup.json');
  const backup = JSON.parse(await fs.readFile(jsonFile, 'utf8'));
  check('downloaded_json_matches_document', JSON.stringify(backup) === JSON.stringify(document));
  for (const format of ['srt', 'vtt']) {
    await openExports(page);
    await page.locator('#subtitle-format').selectOption(format);
    const filename = await download(page, '#export-subtitles', 'captions.' + format);
    const text = await fs.readFile(filename, 'utf8');
    if (format === 'vtt') check('vtt_header', text.startsWith('WEBVTT\n'));
    const cues = parseSubtitle(text, format);
    check(format + '_all_cues_and_timestamps', cues.length === document.segments.length && cues.every((cue, index) => {
      const segment = document.segments[index];
      const start = Math.round(segment.start * 1000);
      return cue.start === start && cue.end === Math.max(start + 1, Math.round(segment.end * 1000)) && cue.text === subtitleText(segment.text);
    }));
    check(format + '_excludes_notes', noteMarkers.every(marker => !text.includes(marker)));
  }
  const markdownFile = await download(page, '#export-notebook', 'notes.md');
  const markdown = await fs.readFile(markdownFile, 'utf8');
  check('markdown_all_notes', noteMarkers.every(marker => markdown.includes(marker)));
  check('markdown_corrected_and_original', markdown.includes(markdownQuote(correction)) && markdown.includes(markdownQuote(originalText)));
  check('markdown_all_annotation_ids', Object.values(indices).every(index => markdown.includes('片段 ID：' + markdownText(document.segments[index].id))));

  stage = 'actual_page_reload';
  await page.reload({waitUntil: 'domcontentloaded'});
  await waitForDocument(page, document.segments.length);
  await verifyRestoration(page, document, indices, 'reload');

  stage = 'fresh_browser_context_reimport';
  await context.close();
  context = await newContext();
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(origin, {waitUntil: 'domcontentloaded'});
  check('fresh_context_empty_library', await storedDocument(page) === null);
  await importFile(page, jsonFile, document.segments.length);
  await verifyRestoration(page, document, indices, 'reimport');
  // Confirm the restored backup reconnects to the actual media endpoint.
  await mediaAcceptance(page, document, indices);
  stage = 'playback_preferences_reload';
  await page.reload({waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => document.querySelector('#source-media audio, #source-media video')?.playbackRate === 1.5);
  check('playback_rate_survives_reload', await page.locator('#playback-rate').inputValue() === '1.5');

  check('no_uncaught_page_errors', pageErrors === 0);
  check('no_external_or_mutating_requests', blockedRequests === 0);
  report.counts.checked_seek_positions = 3;
  report.counts.notes_written = 3;
  report.counts.downloaded_files = 4;
  report.status = 'passed';
} catch {
  // Playwright errors may embed transcript text, source URLs, or private paths.
  // Deliberately report only the last named operation, never the error object.
  report.failure = stage;
  process.exitCode = 1;
} finally {
  try {if (browser) {await browser.close(); report.checks.browser_cleanup = true;}}
  catch {report.checks.browser_cleanup = false; report.status = 'failed'; process.exitCode = 1;}
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    for (let attempt = 0; attempt < 50 && server.exitCode === null && server.signalCode === null; attempt++) await delay(100);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  }
  if (temporary) {
    try {await fs.rm(temporary, {recursive: true, force: true}); report.checks.temporary_exports_removed = true;}
    catch {report.checks.temporary_exports_removed = false; report.status = 'failed'; process.exitCode = 1;}
  }
  report.elapsed_seconds = Math.round((Date.now() - started) / 1000);
  process.stdout.write(JSON.stringify(report) + '\n');
}
