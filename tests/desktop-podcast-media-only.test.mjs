import test from 'node:test';
import assert from 'node:assert/strict';
import { createPodcastSources, parsePodcastFeed, PODCAST_LIMITS } from '../desktop/podcast-sources.mjs';
import { createIngestionService } from '../desktop/ingestion-service.mjs';
import { startBridge } from '../desktop/server.mjs';

// Authored publisher metadata; only transport and time are controlled. No
// transcript or media request is needed to prepare an explicitly chosen player.
const feedUrl = 'https://publisher.example.org/feed.xml';
const mediaUrl = 'https://media.example.org/episode.mp3';
const transcriptUrl = 'https://publisher.example.org/episode.vtt';
const enclosure = `<enclosure url="${mediaUrl}" type="audio/mpeg" length="12"/>`;
const timedText = `<podcast:transcript url="${transcriptUrl}" type="text/vtt" language="en"/>`;
const rss = ({ media = enclosure, transcript = timedText, guid = 'episode', duration = '00:01:00', title = 'Publisher episode' } = {}) =>
  `<rss xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Publisher</title><language>en</language><item><guid>${guid}</guid><title>${title}</title><itunes:duration>${duration}</itunes:duration>${media}${transcript}</item></channel></rss>`;
const resource = (url, body, type = 'application/rss+xml') => ({ url, type, body: Buffer.from(body) });
const episodeId = parsePodcastFeed(rss(), feedUrl).episodes[0].id;
const selected = { feedUrl, episodeId };
const request = { protocolVersion: 1, source: { kind: 'url', url: feedUrl }, episode: { feed_url: feedUrl, episode_id: episodeId } };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness({ feed = url => resource(url, rss()), transcript, now } = {}) {
  const calls = [];
  const sources = createPodcastSources({ now, fetchResource: async (url, options) => {
    calls.push({ url, options });
    if (url === transcriptUrl) {
      if (transcript) return transcript(url, options);
      throw new Error('Advertised transcript is unavailable');
    }
    if (url === mediaUrl) throw new Error('Media bytes must not be fetched during preparation');
    return feed(url, options);
  } });
  return { sources, calls, service: createIngestionService({ podcastSources: sources }) };
}

test('explicit media_only opens a publisher episode with a broken transcript without fetching text or media', async () => {
  const { sources, service, calls } = harness({ now: () => 1000 });
  const discovered = await sources.discover({ url: feedUrl });
  const { ingestion } = await service.ingest({ ...request, intent: 'media_only' });
  assert.equal(ingestion.state, 'needs_transcription');
  assert.equal(ingestion.transcript, null);
  assert.equal(ingestion.selection, null);
  assert.equal(ingestion.source.episode_id, episodeId);
  assert.equal(ingestion.source.feed_checked_at, discovered.feed_checked_at);
  assert.equal(ingestion.source.feed_reused, true);
  assert.equal(ingestion.project.document.project_kind, 'audio_only');
  assert.equal(ingestion.project.document.transcript_status, 'not_imported');
  assert.deepEqual(ingestion.project.document.segments, []);
  assert.equal(ingestion.project.document.title, 'Publisher episode');
  assert.equal(ingestion.project.document.podcast_source.episode_id, episodeId);
  assert.equal(ingestion.project.document.podcast_source.media_url, mediaUrl);
  assert.equal(ingestion.project.document.podcast_source.transcript_url, undefined);
  assert.equal(ingestion.media.availability, 'remote');
  assert.equal(ingestion.media.url, mediaUrl);
  assert.deepEqual(ingestion.media.download, { endpoint: '/api/podcasts/media', body: { feedUrl, episodeId, mediaUrl } });
  assert.equal(ingestion.transcription.automatic, false);
  assert.equal(ingestion.transcription.model_download, false);
  assert.deepEqual(calls.map(call => call.url), [feedUrl]);
});

test('normal transcript import failures stay errors, and a later explicit media-only choice remains independent', async () => {
  for (const transcript of [undefined, url => resource(url, 'broken VTT', 'text/vtt')]) {
    const { service, calls } = harness({ transcript });
    await assert.rejects(service.ingest(request), /Advertised transcript|不是 WebVTT/);
    assert.deepEqual(calls.map(call => call.url), [feedUrl, transcriptUrl]);
    const { ingestion } = await service.ingest({ ...request, intent: 'media_only' });
    assert.equal(ingestion.state, 'needs_transcription');
    assert.equal(ingestion.transcript, null);
    assert.deepEqual(calls.map(call => call.url), [feedUrl, transcriptUrl]);
  }
});

test('media-only preparation does not require or guess a transcript language', async () => {
  const { service, calls } = harness({ feed: url => resource(url, rss({ transcript: timedText.replace('language="en"', 'language="fr"') })) });
  await assert.rejects(service.ingest(request), /明确选择.*文字稿语言/);
  assert.equal((await service.ingest({ ...request, intent: 'media_only' })).ingestion.state, 'needs_transcription');
  assert.deepEqual(calls.map(call => call.url), [feedUrl]);
});

test('invalid intents, missing selections, non-podcast sources and conflicting transcript choices never reach adapters', async () => {
  let calls = 0;
  const unexpected = async () => { calls++; throw new Error('Unexpected adapter'); };
  const service = createIngestionService({ podcastSources: { discover: unexpected, importEpisode: unexpected, openEpisodeMedia: unexpected }, captionService: { available: true, importCaption: unexpected } });
  for (const intent of [null, '', false, 0, 'transcript', 'MEDIA_ONLY', {}, ['media_only']]) {
    await assert.rejects(service.ingest({ ...request, intent }), /导入意图无效/);
  }
  for (const input of [
    { ...request, episode: undefined },
    { ...request, episode: null },
    { ...request, episode: [] },
    { ...request, episode: 'episode' },
    { ...request, source: { kind: 'file', name: 'audio.mp3', size: 12 } },
    { ...request, source: { kind: 'url', url: 'https://youtu.be/abcdefghijk' } },
    { ...request, source: { kind: 'url', url: mediaUrl }, episode: undefined },
    { ...request, source: { kind: 'url', url: 'https://open.spotify.com/episode/one' }, episode: undefined },
    { ...request, episode: { ...request.episode, feed_url: 'https://other.example.org/feed.xml' } },
  ]) await assert.rejects(service.ingest({ ...input, intent: 'media_only' }));
  for (const transcript_url of [transcriptUrl, '', null, false, undefined]) {
    await assert.rejects(service.ingest({ ...request, intent: 'media_only', episode: { ...request.episode, transcript_url } }), /不能指定文字稿/);
    await assert.rejects(service.ingest({ ...request, intent: 'media_only', transcript_url }), /不能指定文字稿/);
  }
  assert.equal(calls, 0);
});

test('media-only adapter validates the selected ID and refuses a transcript selector before fetching', async () => {
  const { sources, calls } = harness();
  for (const data of [undefined, {}, { ...selected, episodeId: 'forged' }, { ...selected, episodeId: [episodeId] }, { ...selected, transcriptUrl }]) {
    await assert.rejects(sources.openEpisodeMedia(data));
  }
  assert.deepEqual(calls, []);
  await assert.rejects(sources.openEpisodeMedia({ ...selected, episodeId: 'a'.repeat(64) }), /不在当前公开源/);
  assert.deepEqual(calls.map(call => call.url), [feedUrl]);
});

test('client episode metadata cannot replace the server-validated media or cached identity', async () => {
  const { sources, service, calls } = harness();
  const found = await sources.discover({ url: feedUrl });
  found.episodes[0].title = 'Forged title';
  found.episodes[0].media[0].url = 'https://attacker.example.org/audio.mp3';
  const { ingestion } = await service.ingest({ ...request, intent: 'media_only', episode: { ...request.episode, title: 'Forged', media: found.episodes[0].media } });
  assert.equal(ingestion.project.document.title, 'Publisher episode');
  assert.equal(ingestion.media.url, mediaUrl);
  const opened = await sources.openEpisodeMedia(selected);
  opened.episode.media[0].url = 'https://attacker.example.org/changed.mp3';
  assert.equal((await sources.openEpisodeMedia(selected)).episode.media[0].url, mediaUrl);
  assert.deepEqual(calls.map(call => call.url), [feedUrl]);
});

test('media-only rejects absent, non-public, unsupported, oversized and overlong declared media without fetching a transcript', async () => {
  for (const options of [
    { media: '' },
    { media: enclosure.replace(mediaUrl, 'http://127.0.0.1/private.mp3') },
    { media: enclosure.replace(mediaUrl, 'https://media.example.org/private.mp3?token=private') },
    { media: enclosure.replace('audio/mpeg', 'text/html') },
    { media: enclosure.replace('length="12"', `length="${PODCAST_LIMITS.mediaBytes + 1}"`) },
    { duration: '06:00:01' },
  ]) {
    const { service, calls } = harness({ feed: url => resource(url, rss(options)) });
    await assert.rejects(service.ingest({ ...request, intent: 'media_only' }), /没有可用|大小上限|超过6小时/);
    assert.deepEqual(calls.map(call => call.url), [feedUrl]);
  }
});

test('cold media-only preparation seeds the same bounded cache, expires exactly at 60 seconds and never extends TTL', async () => {
  let time = 1000, current = rss();
  const { sources, calls } = harness({ now: () => time, feed: url => resource(url, current) });
  const first = await sources.openEpisodeMedia(selected);
  assert.equal(first.feed_reused, false);
  assert.equal(first.feed_checked_at, new Date(1000).toISOString());
  time = 60999;
  assert.equal((await sources.openEpisodeMedia(selected)).feed_reused, true);
  current = rss({ guid: 'different-episode' });
  time = 61000;
  await assert.rejects(sources.openEpisodeMedia(selected), /不在当前公开源/);
  assert.deepEqual(calls.map(call => call.url), [feedUrl, feedUrl]);
});

test('explicit refresh and failed refresh prevent media-only preparation from reusing stale authorization', async () => {
  let current = rss();
  const { sources, calls } = harness({ feed: url => {
    if (current instanceof Error) throw current;
    return resource(url, current);
  } });
  await sources.discover({ url: feedUrl });
  current = new Error('Publisher unavailable');
  await assert.rejects(sources.discover({ url: feedUrl }), /Publisher unavailable/);
  await assert.rejects(sources.openEpisodeMedia(selected), /Publisher unavailable/);
  current = rss({ media: '' });
  await sources.discover({ url: feedUrl });
  await assert.rejects(sources.openEpisodeMedia(selected), /没有可用/);
  assert.deepEqual(calls.map(call => call.url), [feedUrl, feedUrl, feedUrl, feedUrl]);
});

test('media acquisition revalidates the feed after media-only preparation instead of trusting its cached descriptor', async () => {
  let current = rss();
  const { sources, service, calls } = harness({ feed: url => resource(url, current) });
  const { ingestion } = await service.ingest({ ...request, intent: 'media_only' });
  current = rss({ media: '' });
  await assert.rejects(sources.downloadMedia(ingestion.media.download.body), /不在所选单集/);
  assert.deepEqual(calls.map(call => call.url), [feedUrl, feedUrl]);
});

test('already cancelled and late cancelled media-only requests produce no project or reusable cancelled snapshot', async () => {
  const gate = deferred();
  let reads = 0;
  const { sources, service, calls } = harness({ feed: url => ++reads === 1 ? gate.promise : resource(url, rss({ title: 'Current episode' })) });
  const controller = new AbortController();
  const pending = service.ingest({ ...request, intent: 'media_only' }, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  gate.resolve(resource(feedUrl, rss({ title: 'Cancelled episode' })));
  await rejected;
  const current = await sources.openEpisodeMedia(selected);
  assert.equal(current.feed_reused, false);
  assert.equal(current.episode.title, 'Current episode');
  await assert.rejects(sources.openEpisodeMedia(selected, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(service.ingest({ ...request, intent: 'media_only' }, { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(calls.map(call => call.url), [feedUrl, feedUrl]);
});

test('cancellation after media-only adapter completion discards the late project', async () => {
  const controller = new AbortController();
  const service = createIngestionService({ podcastSources: { openEpisodeMedia: async () => {
    controller.abort();
    return { status: 'needs_transcription', feed_url: feedUrl, episode: parsePodcastFeed(rss(), feedUrl).episodes[0] };
  } } });
  await assert.rejects(service.ingest({ ...request, intent: 'media_only' }, { signal: controller.signal }), { name: 'AbortError' });
});

test('media-only work shares the existing two-request admission limit', async () => {
  const gate = deferred();
  const { sources, calls } = harness({ feed: () => gate.promise });
  const one = sources.openEpisodeMedia(selected), two = sources.openEpisodeMedia(selected);
  await assert.rejects(sources.openEpisodeMedia(selected), /最多同时/);
  gate.resolve(resource(feedUrl, rss()));
  assert.equal((await one).status, 'needs_transcription');
  assert.equal((await two).status, 'needs_transcription');
  assert.equal((await sources.openEpisodeMedia(selected)).feed_reused, true);
  assert.deepEqual(calls.map(call => call.url), [feedUrl, feedUrl]);
});

test('Xiaoyuzhou media-only preparation rechecks free/nonprivate/public gates instead of caching page authorization', async () => {
  const id = '6ab0922a0916f6f8b4468234', url = 'https://www.xiaoyuzhoufm.com/episode/' + id;
  let payType = 'FREE';
  const { sources, calls } = harness({ feed: () => resource(url, '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ props: { pageProps: { episode: {
    eid: id, title: 'Public episode', duration: 20, status: 'NORMAL', payType, isPrivateMedia: false,
    media: { size: 12, mimeType: 'audio/mpeg', source: { mode: 'PUBLIC', url: mediaUrl } }, enclosure: { url: mediaUrl },
  } } } }) + '</script>', 'text/html') });
  const found = await sources.discover({ url });
  const selection = { feedUrl: url, episodeId: found.episodes[0].id };
  assert.equal((await sources.openEpisodeMedia(selection)).status, 'needs_transcription');
  payType = 'PAID';
  await assert.rejects(sources.openEpisodeMedia(selection), /没有同时明确/);
  assert.deepEqual(calls.map(call => call.url), [url, url, url]);
});

test('same-origin HTTP accepts explicit media-only preparation and keeps normal transcript failures visible', async t => {
  const { sources, calls } = harness();
  const server = await startBridge({ port: 0, podcastSources: sources });
  t.after(() => server.shutdown());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(origin + '/api/v1/ingestions', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const media = await post({ ...request, intent: 'media_only' });
  assert.equal(media.status, 200);
  const { ingestion } = await media.json();
  assert.equal(ingestion.project.document.project_kind, 'audio_only');
  assert.equal(ingestion.transcript, null);
  assert.deepEqual(calls.map(call => call.url), [feedUrl]);
  const normal = await post(request);
  assert.equal(normal.status, 400);
  assert.match((await normal.json()).error, /Advertised transcript/);
  const conflict = await post({ ...request, intent: 'media_only', episode: { ...request.episode, transcript_url: transcriptUrl } });
  assert.equal(conflict.status, 400);
  assert.deepEqual(calls.map(call => call.url), [feedUrl, transcriptUrl]);
});
