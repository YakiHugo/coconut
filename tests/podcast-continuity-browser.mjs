import {openLibraryTools} from './helpers/library-tools-browser.mjs';
/** Run in Browser acceptance CI: discovery → audio project → same-episode transcript.
 * Publisher responses and 40-second PCM media are authored fixtures.
 * No external sources, credentials, real providers or model quota. */
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from './helpers/browser-storage.mjs';
import {startBridge} from '../desktop/server.mjs';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';

const LIBRARY_KEY = 'coconut-reader-v1';
const ACTIVE_KEY = 'coconut-reader-active-v1';
const PROJECT_NOTE = 'Authored project note: preserve this exact annotation.';
const BOOKMARK_NOTE = 'Authored timestamp note: return here after importing words.';
const checks = [], calls = [], forbiddenRequests = [], providerCalls = [], pageErrors = [], playback = [];
let browser, server, directory, page, stage = 'setup', external = 0;
const check = (name, value) => {assert.ok(value, name); checks.push(name);};

try {
  directory = await mkdtemp(path.join(os.tmpdir(), 'coconut-podcast-continuity-'));
  const body = authoredAudioFixture(40);
  const source = {
    feed_url: 'https://publisher.example/continuity/feed.xml',
    episode_id: 'd'.repeat(64),
    media_url: 'https://publisher.example/continuity/authored.wav',
    media_kind: 'audio',
    transcript_url: 'https://publisher.example/continuity/authored.vtt',
  };
  const episode = {
    id: source.episode_id, title: 'Authored discovery continuity episode',
    source_url: 'https://publisher.example/continuity/episode', language: 'en', duration: 40,
    media: [{url: source.media_url, type: 'audio/wav', kind: 'audio', length: body.length}],
    transcripts: [{url: source.transcript_url, type: 'text/vtt', language: 'en', supported: true}],
  };
  const transcript = {
    title: episode.title, language: 'en', source_url: episode.source_url, podcast_source: source,
    provenance: {kind: 'publisher_transcript', caption_method: 'publisher_provided', review_status: 'unreviewed'},
    segments: [
      {id: 'opening', start: 0, end: 10, text: 'Authored opening words from this episode.'},
      {id: 'middle', start: 10, end: 20, text: 'Authored middle words beside the saved bookmark.'},
      {id: 'ending', start: 20, end: 40, text: 'Authored final words for the continuity proof.'},
    ],
  };
  const forbiddenProvider = name => async () => {
    providerCalls.push(name);
    throw new Error('No provider calls are permitted in the discovery continuity proof');
  };
  server = await startBridge({
    port: 0,
    providers: Object.fromEntries(['status', 'ask', 'structured', 'exclusive'].map(name => [name, forbiddenProvider(name)])),
    podcastSources: {
      discover: async data => {
        calls.push({action: 'discover', data});
        assert.equal(data.url, source.feed_url);
        return {kind: 'feed', title: 'Authored continuity feed', feed_url: source.feed_url, episodes: [episode], warnings: []};
      },
      importEpisode: async data => {
        calls.push({action: 'import', data});
        assert.equal(data.feedUrl, source.feed_url);
        assert.equal(data.episodeId, source.episode_id);
        return {status: 'ready', document: transcript, episode};
      },
      downloadMedia: async data => {
        calls.push({action: 'media', data});
        assert.deepEqual(data, {feedUrl: source.feed_url, episodeId: source.episode_id, mediaUrl: source.media_url});
        return {body, type: 'audio/wav', kind: 'audio', filename: 'authored.wav'};
      },
    },
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true, ...(process.env.COCONUT_CHROMIUM_EXECUTABLE ? {executablePath: process.env.COCONUT_CHROMIUM_EXECUTABLE} : {})});

  async function newPage() {
    const context = await browser.newContext({acceptDownloads: true, serviceWorkers: 'block'});
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (['blob:', 'data:'].includes(url.protocol)) return route.continue();
      if (url.origin !== origin) {external++; return route.abort();}
      // Even an attempted model/status/transcription request is a failure. The
      // injected bridge providers are also fail-closed if routing ever changes.
      if (url.pathname.startsWith('/api/') && !['/api/health', '/api/podcasts/discover', '/api/podcasts/import', '/api/podcasts/media'].includes(url.pathname)) {
        forbiddenRequests.push({method: route.request().method(), pathname: url.pathname});
        return route.abort();
      }
      return route.continue();
    });
    const result = await context.newPage();
    result.setDefaultTimeout(15000);
    result.on('pageerror', error => pageErrors.push(error.message));
    await result.exposeFunction('recordContinuityPlayback', event => playback.push(event));
    await result.addInitScript(() => {
      window.continuityProbe = {created: [], revoked: [], playCalls: 0, playEvents: 0};
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = value => {
        const url = create(value); window.continuityProbe.created.push(url); return url;
      };
      URL.revokeObjectURL = url => {window.continuityProbe.revoked.push(url); return revoke(url);};
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        window.continuityProbe.playCalls++;
        window.recordContinuityPlayback({kind: 'play-call', src: this.getAttribute('src')});
        return play.apply(this, args);
      };
      document.addEventListener('play', event => {
        if (!(event.target instanceof HTMLMediaElement)) return;
        window.continuityProbe.playEvents++;
        window.recordContinuityPlayback({kind: 'play-event', src: event.target.getAttribute('src')});
      }, true);
    });
    await result.goto(origin);
    await result.locator('#podcast-import').waitFor({state: 'visible'});
    return result;
  }
  async function stored(target = page) {
    await target.evaluate(() => libraryStore.flush());
    return target.evaluate(() => readPersistedLibrary());
  }
  async function decoded(selector, target = page) {
    await target.waitForFunction(selector => {
      const player = document.querySelector(selector);
      return player && !player.error && player.readyState >= 2 && player.duration === 40;
    }, selector);
  }
  async function seek(selector, time, target = page) {
    await target.locator(selector).evaluate((player, time) => {player.currentTime = time;}, time);
    await target.waitForFunction(({selector, time}) => {
      const player = document.querySelector(selector);
      return player && !player.seeking && Math.abs(player.currentTime - time) < 0.05 && player.paused;
    }, {selector, time});
  }
  async function discover() {
    await page.locator('#video-url').fill(source.feed_url);
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/podcasts/discover' && response.request().method() === 'POST' && response.ok()),
      page.locator('#process-url').click(),
    ]);
    await page.waitForFunction(() => !document.getElementById('process-url').disabled);
    await page.locator('.podcast-episode').waitFor({state: 'visible'});
    await page.getByRole('button', {name: '保存原声项目', exact: true}).waitFor();
  }
  async function download(id, filename, target = page) {
    if(id==='export-library')await openLibraryTools(target);
    const details = target.locator(id === 'export-library' ? '.library-backup' : '#export-menu');
    if (!await details.isVisible()) {
      const toggle = target.locator('#toggle-library');
      if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    }
    if (!await details.evaluate(node => node.open)) await details.locator(':scope > summary').click();
    const [item] = await Promise.all([target.waitForEvent('download'), target.locator('#' + id).click()]);
    const filenameOnDisk = path.join(directory, filename);
    await item.saveAs(filenameOnDisk);
    assert.equal(await item.failure(), null);
    return {file: filenameOnDisk, value: JSON.parse(await readFile(filenameOnDisk, 'utf8'))};
  }
  const actions = () => calls.map(call => call.action);
  const mediaCount = () => calls.filter(call => call.action === 'media').length;

  page = await newPage();
  check('opening_reader_never_discovers_downloads_or_checks_models', calls.length === 0 && forbiddenRequests.length === 0 && providerCalls.length === 0);
  stage = 'preview_authored_episode';
  await discover();
  assert.deepEqual(actions(), ['discover']);
  await page.getByRole('button', {name: '回听原声（最多200 MiB）', exact: true}).click();
  await decoded('.podcast-preview');
  await seek('.podcast-preview', 8.5);
  const previewURL = await page.locator('.podcast-preview').getAttribute('src');
  check('explicit_discovery_preview_decodes_without_playing', previewURL.startsWith('blob:') && mediaCount() === 1 && playback.length === 0);

  stage = 'save_preview_as_audio_project';
  await page.getByRole('button', {name: '保存原声项目', exact: true}).click();
  await page.locator('#audio-project').waitFor({state: 'visible'});
  await decoded('#source-media audio');
  const originalKey = await page.evaluate(key => sessionStorage.getItem(key), ACTIVE_KEY);
  check('saving_transfers_the_loaded_preview_without_redownload',
    await page.locator('#source-media audio').getAttribute('src') === previewURL && mediaCount() === 1);
  check('saving_preserves_preview_position_and_paused_state',
    await page.locator('#source-media audio').evaluate(player => Math.abs(player.currentTime - 8.5) < 0.05 && player.paused));
  check('transferred_url_has_one_live_reader_owner',
    await page.locator('.podcast-preview').count() === 0 && await page.evaluate(url => !window.continuityProbe.revoked.includes(url), previewURL));
  await page.locator('#project-note').fill(PROJECT_NOTE);
  await page.locator('#audio-bookmark-time').fill('00:12');
  await page.locator('#audio-bookmark-note').fill(BOOKMARK_NOTE);
  await page.locator('#audio-bookmark-form button[type=submit]').click();
  await seek('#source-media audio', 12.75);
  await page.waitForFunction(key => {
    const record = JSON.parse(localStorage.getItem('coconut-listening-v1:' + key));
    return record && Math.abs(record.time - 12.75) < 0.05;
  }, originalKey);
  await page.locator('#source-media audio').evaluate(player => {player.dataset.continuityIdentity = 'original-project-player';});
  const audioSnapshot = await stored();
  assert.equal(audioSnapshot.documents.length, 1);
  const savedAudio = audioSnapshot.documents[0];
  assert.equal(savedAudio.key, originalKey);
  assert.equal(savedAudio.project_kind, 'audio_only');
  assert.equal(savedAudio.project_note, PROJECT_NOTE);
  assert.deepEqual(savedAudio.segments, []);
  assert.equal(savedAudio.timestamp_bookmarks.length, 1);
  const bookmark = savedAudio.timestamp_bookmarks[0];
  assert.equal(bookmark.time, 12);
  assert.equal(bookmark.note, BOOKMARK_NOTE);
  const listeningBefore = await page.evaluate(key => localStorage.getItem('coconut-listening-v1:' + key), originalKey);
  check('audio_project_annotations_and_listening_are_persisted', Boolean(bookmark.id) && savedAudio.ai_answers.length === 0);

  stage = 'rediscover_same_episode_and_attach_transcript';
  await page.locator('#add-content').click();
  // A new discovery renders a fresh picker. It must not revoke a preview URL
  // that has already transferred into the saved project's media ownership.
  await discover();
  check('rediscovery_does_not_revoke_the_saved_projects_media',
    await page.evaluate(url => !window.continuityProbe.revoked.includes(url), previewURL) && mediaCount() === 1);
  await page.getByRole('button', {name: '导入发布者文字稿', exact: true}).click();
  await page.locator('#transcript-layout').waitFor({state: 'visible'});
  const attached = await stored();
  check('discovery_transcript_attaches_to_the_exact_existing_project_key',
    attached.documents.length === 1 && attached.documents[0].key === originalKey &&
    await page.evaluate(key => sessionStorage.getItem(key), ACTIVE_KEY) === originalKey);
  const savedTranscript = attached.documents[0];
  assert.equal(savedTranscript.project_note, PROJECT_NOTE);
  assert.deepEqual(savedTranscript.timestamp_bookmarks, [bookmark]);
  assert.deepEqual(savedTranscript.segments.map(({id, start, end, text}) => ({id, start, end, text})), transcript.segments);
  assert.deepEqual(savedTranscript.podcast_source, source);
  assert.notEqual(savedTranscript.project_kind, 'audio_only');
  check('transcript_keeps_project_annotations_and_exact_bookmark_id',
    await page.locator('#project-note').inputValue() === PROJECT_NOTE && await page.locator('#audio-bookmarks textarea').inputValue() === BOOKMARK_NOTE);
  check('transcript_attachment_retains_player_url_position_and_pause',
    await page.locator('#source-media audio').evaluate((player, url) => player.getAttribute('src') === url && player.dataset.continuityIdentity === 'original-project-player' && Math.abs(player.currentTime - 12.75) < 0.05 && player.paused, previewURL));
  check('transcript_attachment_preserves_listening_record_and_url_lifetime',
    await page.evaluate(({key, raw, url}) => localStorage.getItem('coconut-listening-v1:' + key) === raw && !window.continuityProbe.revoked.includes(url), {key: originalKey, raw: listeningBefore, url: previewURL}));
  assert.deepEqual(actions(), ['discover', 'media', 'discover', 'import']);
  check('entire_discovery_save_attach_journey_uses_one_media_request_and_no_models', mediaCount() === 1 && forbiddenRequests.length === 0 && providerCalls.length === 0 && playback.length === 0);

  stage = 'download_and_inspect_actual_project_and_library_json';
  const projectBackup = await download('export', 'episode-project.coconut.json');
  assert.deepEqual(projectBackup.value, savedTranscript);
  const libraryBackup = await download('export-library', 'episode-library.json');
  assert.equal(libraryBackup.value.format, 'coconut-library');
  assert.equal(libraryBackup.value.active, originalKey);
  assert.deepEqual(libraryBackup.value.documents, [savedTranscript]);
  check('actual_json_downloads_preserve_exact_project_and_annotations_without_blob_urls',
    !JSON.stringify(projectBackup.value).includes('blob:') && !JSON.stringify(libraryBackup.value).includes('blob:'));

  stage = 'reload_saved_project_without_implicit_media_or_playback';
  await page.reload();
  await page.locator('#mode-transcript').click();
  await page.locator('#transcript-layout').waitFor({state: 'visible'});
  const reloaded = await stored();
  assert.deepEqual(reloaded.documents, [savedTranscript]);
  check('reload_retains_exact_project_and_listening_without_redownload',
    await page.evaluate(({key, raw}) => sessionStorage.getItem('coconut-reader-active-v1') === key && localStorage.getItem('coconut-listening-v1:' + key) === raw, {key: originalKey, raw: listeningBefore}) &&
    await page.locator('#source-media audio').count() === 0 && mediaCount() === 1);
  if (!await page.locator('#download-podcast-media').isVisible()) await page.locator('#toggle-reader-media').click();
  await page.locator('#download-podcast-media').click();
  await decoded('#source-media audio');
  await page.locator('#resume-listening').waitFor({state: 'visible'});
  check('explicit_reacquisition_starts_paused_without_automatic_resume',
    await page.locator('#source-media audio').evaluate(player => player.currentTime === 0 && player.paused) && mediaCount() === 2);
  await page.locator('#resume-listening').click();
  await page.waitForFunction(() => {
    const player = document.querySelector('#source-media audio');
    return player && !player.seeking && Math.abs(player.currentTime - 12.75) < 0.05 && player.paused;
  });
  check('explicit_resume_uses_the_same_project_listening_record_without_playing', playback.length === 0);
  const reacquiredURL = await page.locator('#source-media audio').getAttribute('src');
  await page.locator('#detach-reader-media').click();
  check('explicit_detach_releases_only_the_owned_media_url',
    await page.locator('#source-media audio').count() === 0 && await page.evaluate(url => window.continuityProbe.revoked.filter(item => item === url).length === 1, reacquiredURL));

  stage = 'clean_browser_restore_from_actual_downloads';
  for (const [input, backup] of [['#file', projectBackup], ['#library-file', libraryBackup]]) {
    const restored = await newPage();
    await restored.locator(input).setInputFiles(backup.file);
    await restored.locator('#mode-transcript').click();
    await restored.locator('#transcript-layout').waitFor({state: 'visible'});
    const snapshot = await stored(restored);
    assert.equal(snapshot.documents.length, 1);
    // A new profile may derive its own key while importing a single document.
    // Compare every exported user field; in-place upgrade/reload above require
    // the exact original key and do not permit this normalization.
    const {key: restoredKey, ...actual} = snapshot.documents[0];
    const {key: exportedKey, ...expected} = savedTranscript;
    assert.ok(restoredKey);
    assert.equal(exportedKey, originalKey);
    assert.deepEqual(actual, expected);
    check((input === '#file' ? 'single_project' : 'whole_library') + '_download_restores_complete_data_without_media_or_inference',
      await restored.locator('#source-media audio').count() === 0 && mediaCount() === 2 && forbiddenRequests.length === 0 && providerCalls.length === 0);
    await restored.context().close();
  }
  check('no_autoplay_external_requests_or_browser_errors',
    playback.length === 0 && external === 0 && pageErrors.length === 0 && forbiddenRequests.length === 0 && providerCalls.length === 0);
  console.log(JSON.stringify({suite: 'podcast-discovery-project-continuity', status: 'passed', checks}));
} catch (error) {
  const snapshot = page && !page.isClosed() ? await page.evaluate(() => {
    const player = document.querySelector('#source-media audio, .podcast-preview');
    return {
      workspace: document.body.dataset.workspace,
      notice: document.getElementById('notice')?.textContent,
      podcastStatus: document.getElementById('podcast-status')?.textContent,
      activeKey: sessionStorage.getItem('coconut-reader-active-v1'),
      probe: window.continuityProbe,
      player: player ? {src: player.getAttribute('src'), readyState: player.readyState, currentTime: player.currentTime, paused: player.paused, error: player.error?.message} : null,
    };
  }).catch(() => null) : null;
  console.error(JSON.stringify({suite: 'podcast-discovery-project-continuity', status: 'failed', stage, checks, error: error.message, snapshot, calls, forbiddenRequests, providerCalls, pageErrors, playback, external}));
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.shutdown(resolve));
  if (directory) await rm(directory, {recursive: true, force: true});
}
