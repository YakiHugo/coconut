/**
 * Public original URL → browser submit → real production queue → caption result
 * → native Chromium playback. No seeded jobs, provider mocks, cookies or ASR.
 * Source media, captions, database, browser profile and exports stay ephemeral.
 * stdout contains bounded check names/counts only; never print source errors.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const report = {schema_version: 1, suite: 'queued-original-browser', status: 'failed', checks: {}, counts: {}};
let stage = 'configuration', browser, server, temporary;
let errors = 0, blocked = 0, submissions = 0, cancellations = 0, retries = 0;
let admittedId = '';
const started = Date.now();
process.umask(0o077);
delete process.env.DEBUG;
delete process.env.PWDEBUG;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, value) {
  stage = name;
  if (!value) throw new Error('Acceptance check failed');
  report.checks[name] = true;
}

async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  for (let attempt = 0; attempt < 80 && server.exitCode === null && server.signalCode === null; attempt++) await delay(100);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL');
    await new Promise(resolve => server.once('exit', resolve));
  }
}

async function startServer(directory) {
  server = spawn(process.env.COCONUT_ACCEPTANCE_PYTHON || 'python3', ['serve.py', '--port', '0', '--data-dir', directory], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, HF_HOME: path.join(temporary, 'recognition-cache'), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1'},
  });
  server.stderr.on('data', () => {});
  return await new Promise((resolve, reject) => {
    let output = '', settled = false;
    const finish = origin => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      origin ? resolve(origin) : reject(new Error('Local service unavailable'));
    };
    const timer = setTimeout(() => finish(), 30000);
    server.on('error', () => finish()); server.on('exit', () => finish());
    server.stdout.on('data', chunk => {
      output = (output + chunk.toString()).slice(-4096);
      const match = output.match(/Coconut is ready at http:\/\/127\.0\.0\.1:(\d+)\r?\n/);
      if (match) finish('http://127.0.0.1:' + match[1]);
    });
  });
}

async function fullReadingAcceptance(directory, resultFile) {
  // The existing complete reader suite now receives the actual queued result,
  // never the old preparation helper's synthetic completed-job insertion.
  const child = spawn(process.execPath, ['tests/browser-acceptance.mjs'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, COCONUT_ACCEPTANCE_MODE: 'original', COCONUT_ACCEPTANCE_DATA_DIR: directory,
      COCONUT_ACCEPTANCE_RESULT: resultFile},
  });
  child.stderr.on('data', () => {});
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-128000); });
  const timer = setTimeout(() => child.kill('SIGTERM'), 240000);
  try {
    const code = await new Promise(resolve => {child.on('error', () => resolve(-1)); child.on('exit', resolve);});
    let result;
    try { result = JSON.parse(output.trim()); } catch {}
    if (typeof result?.failure === 'string' && /^[a-z0-9_]+$/.test(result.failure)) report.reader_failure = result.failure;
    check('full_original_reading_and_export_suite', code === 0 && result?.status === 'passed');
    report.counts.reader_checks = Object.keys(result.checks).length;
  } finally { clearTimeout(timer); }
}

try {
  const sourceUrl = process.env.COCONUT_ORIGINAL_URL || '';
  const url = new URL(sourceUrl);
  check('public_source_configured', url.protocol === 'https:' && !url.username && !url.password);
  temporary = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'coconut-queued-original-'));
  const directory = path.join(temporary, 'jobs');
  stage = 'start_actual_production_server';
  const origin = await startServer(directory);
  const health = await fetch(origin + '/api/health').then(response => response.json());
  const initial = await fetch(origin + '/api/jobs').then(response => response.json());
  check('fresh_real_queue_has_no_seeded_jobs', health.local_worker === true && initial.jobs.length === 0);

  stage = 'launch_chromium';
  const {chromium} = await import('@playwright/test');
  browser = await chromium.launch({headless: true, ...(process.env.COCONUT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE} : {})});
  const context = await browser.newContext({serviceWorkers: 'block', viewport: {width: 1440, height: 1000}});
  await context.route('**/*', async route => {
    const request = route.request(), target = new URL(request.url());
    if (['blob:', 'data:'].includes(target.protocol)) return route.continue();
    const local = target.origin === origin;
    const reading = ['GET', 'HEAD'].includes(request.method()) &&
      (!target.pathname.startsWith('/api/') || target.pathname === '/api/health' ||
       target.pathname === '/api/jobs' || /^\/api\/jobs\/[a-f0-9]{32}(?:\/result|\/media)?$/.test(target.pathname));
    if (local && reading) return route.continue();
    if (local && target.pathname === '/api/jobs' && request.method() === 'POST' && submissions === 0) {
      const body = request.postDataJSON();
      if (body?.url === sourceUrl && body.options?.captions_only === true && body.options?.force_transcribe === false &&
          body.options?.keep_media === true && body.options?.language === 'en') {
        submissions++;
        return route.continue();
      }
    }
    if (local && admittedId && request.method() === 'POST' && request.postData() === '{}') {
      if (target.pathname === '/api/jobs/' + admittedId + '/cancel' && cancellations === 0 && retries === 0) {
        cancellations++;
        return route.continue();
      }
      if (target.pathname === '/api/jobs/' + admittedId + '/retry' && cancellations === 1 && retries === 0) {
        retries++;
        return route.continue();
      }
    }
    blocked++;
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', () => { errors++; });
  page.setDefaultTimeout(20000);
  await page.goto(origin, {waitUntil: 'domcontentloaded'});
  await page.locator('#url-form').waitFor({state: 'visible'});
  check('blank_reader_before_real_submission', await page.locator('#library button').count() === 0);
  await page.locator('.import-settings > summary').click();
  check('safe_caption_only_default', await page.locator('#captions-only').isChecked() &&
    !(await page.locator('#force-asr').isChecked()) && await page.locator('#force-asr').isDisabled());
  await page.locator('#import-language').selectOption('en');
  await page.locator('#keep-media').check();
  await page.locator('#video-url').fill(sourceUrl);
  stage = 'browser_submits_original_url';
  const admission = page.waitForResponse(response => response.url() === origin + '/api/jobs' && response.request().method() === 'POST');
  await page.locator('#process-url').click();
  const accepted = await admission;
  check('production_queue_accepted_browser_submission', accepted.status() === 201);
  const job = await accepted.json();
  check('queued_with_explicit_no_asr_permission', /^[a-f0-9]{32}$/.test(job.id) &&
    ['queued', 'running'].includes(job.status) && job.options.captions_only === true && job.options.force_transcribe === false);
  admittedId = job.id;
  const selector = '.job-row[data-job-id="' + job.id + '"]';
  await page.locator(selector).waitFor({state: 'visible'});
  // Exercise the genuine in-flight queue, without delaying or replacing its
  // responses. A very fast completion is reported as a missed cancel window,
  // never silently counted as cancellation coverage.
  check('initial_job_still_cancellable', await page.locator(selector + ' [data-job-action="cancel"]').count() === 1);
  stage = 'cancel_actual_inflight_job';
  const cancelRequest = page.waitForResponse(response => response.url() === origin + '/api/jobs/' + job.id + '/cancel' && response.request().method() === 'POST');
  await page.locator(selector + ' [data-job-action="cancel"]').click();
  const cancelledResponse = await cancelRequest;
  check('cancel_won_initial_completion_race', cancelledResponse.status() === 200);
  const cancelled = await cancelledResponse.json();
  check('actual_job_cancelled_without_changing_permission', cancelled.id === job.id && cancelled.status === 'cancelled' &&
    JSON.stringify(cancelled.options) === JSON.stringify(job.options));
  await page.locator(selector + ' [data-job-action="retry"]').waitFor({state: 'visible'});
  check('cancelled_state_visible_in_real_queue', (await page.locator(selector).textContent()).includes('已取消'));
  stage = 'retry_same_cancelled_job_in_browser';
  const retryRequest = page.waitForResponse(response => response.url() === origin + '/api/jobs/' + job.id + '/retry' && response.request().method() === 'POST');
  await page.locator(selector + ' [data-job-action="retry"]').click();
  const retriedResponse = await retryRequest;
  check('real_retry_accepted', retriedResponse.status() === 200);
  const retried = await retriedResponse.json();
  check('retry_preserves_same_job_and_caption_only_permission', retried.id === job.id &&
    ['queued', 'running'].includes(retried.status) && JSON.stringify(retried.options) === JSON.stringify(job.options));
  stage = 'reload_preserves_processing_queue';
  await page.reload({waitUntil: 'domcontentloaded'});
  await page.locator(selector).waitFor({state: 'visible'});
  check('reload_does_not_resubmit_original', submissions === 1 && cancellations === 1 && retries === 1);

  stage = 'production_worker_caption_and_media_completion';
  await page.waitForFunction(selector => {
    const row = document.querySelector(selector);
    return row?.querySelector('[data-job-action="open"], [data-job-action="retry"]');
  }, selector, {timeout: 720000});
  const finalJob = await fetch(origin + '/api/jobs/' + job.id).then(response => response.json());
  check('real_queue_completed_without_playback_failure', finalJob.status === 'done' && finalJob.playback_retryable === false);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, job.id, 'cache', 'manifest.json'), 'utf8'));
  check('actual_subprocess_preserved_caption_only_fingerprint', manifest.captions_only === true && manifest.force === false && manifest.keep_media === true);
  const cacheNames = await fs.readdir(path.join(directory, job.id, 'cache'));
  check('no_recognition_audio_stage', !cacheNames.includes('audio.json') && !cacheNames.some(name => /\.(wav|flac)$/.test(name)));
  check('no_recognition_model_cache', !(await fs.stat(path.join(temporary, 'recognition-cache')).catch(() => null)));

  stage = 'open_actual_completed_job_in_reader';
  const resultRequest = page.waitForResponse(response => response.url() === origin + '/api/jobs/' + job.id + '/result');
  await page.locator(selector + ' [data-job-action="open"]').click();
  const received = await resultRequest;
  check('queued_result_opened_by_browser', received.ok());
  const document = await received.json();
  check('original_caption_provenance_and_source', document.source_url === sourceUrl && document.source_media?.job_id === job.id &&
    ['platform_subtitles', 'automatic_subtitles'].includes(document.provenance?.kind) &&
    document.provenance?.subtitle_check === 'found' && document.provenance?.language?.startsWith('en') && document.segments?.length >= 3);
  await page.locator('#reader-workspace').waitFor({state: 'visible'});
  check('real_result_has_no_invented_summary', await page.locator('#summary-state').textContent() === '未生成');
  await page.locator('#mode-transcript').click();
  const player = page.locator('#source-media video');
  stage = 'actual_original_video_decodes';
  await player.waitFor({state: 'visible'});
  await page.waitForFunction(() => {
    const media = document.querySelector('#source-media video');
    return media && !media.error && media.readyState >= 2 && Number.isFinite(media.duration) && media.duration > 0 && media.videoWidth > 0;
  }, null, {timeout: 60000});
  const duration = await player.evaluate(media => media.duration);
  check('playable_original_video_matches_caption_duration', duration > document.segments.at(-1).start && duration <= 21600);
  const first = page.locator('#transcript .segment').first();
  const firstId = await first.getAttribute('data-segment-id');
  const cue = document.segments.find(segment => segment.id === firstId);
  check('reader_displays_real_queued_caption', (await first.locator('.words').textContent()) === cue?.text);
  stage = 'real_timestamp_control_plays_original';
  await first.locator('.time > button').first().click();
  await page.waitForFunction(start => {
    const media = document.querySelector('#source-media video');
    return media && !media.error && !media.paused && media.currentTime > start + .1 && media.getVideoPlaybackQuality().totalVideoFrames > 0;
  }, cue.start);
  await player.evaluate(media => media.pause());
  check('production_queue_result_plays_from_real_timestamp', await player.evaluate(media => media.currentTime) < cue.start + 3);
  check('one_submission_and_same_job_retry_without_inference_or_page_errors', submissions === 1 && cancellations === 1 && retries === 1 && errors === 0 && blocked === 0);
  report.counts.segments = document.segments.length;
  report.counts.media_duration_seconds = Math.round(duration);
  report.counts.queue_submissions = submissions;
  report.counts.queue_cancellations = cancellations;
  report.counts.queue_retries = retries;
  const resultFile = path.join(temporary, 'actual-queue-result.json');
  await fs.writeFile(resultFile, JSON.stringify(document));
  await browser.close(); browser = undefined;
  await stopServer(); server = undefined;
  stage = 'full_original_reading_and_export_suite';
  await fullReadingAcceptance(directory, resultFile);
  report.status = 'passed';
} catch {
  report.failure = stage;
  process.exitCode = 1;
} finally {
  try { await browser?.close(); await stopServer(); }
  catch { report.status = 'failed'; process.exitCode = 1; report.checks.process_cleanup = false; }
  if (temporary) {
    try { await fs.rm(temporary, {recursive: true, force: true}); report.checks.private_source_cleanup = true; }
    catch { report.status = 'failed'; process.exitCode = 1; report.checks.private_source_cleanup = false; }
  }
  report.elapsed_seconds = Math.round((Date.now() - started) / 1000);
  process.stdout.write(JSON.stringify(report) + '\n');
}
