import test from 'node:test';
import assert from 'node:assert/strict';
import { createPodcastSources, parsePodcastFeed, PODCAST_LIMITS } from '../desktop/podcast-sources.mjs';

// Authored fixtures exercise the production XML parser; only transport and time
// are controlled. Gates settle explicitly, so race tests need no timer sleeps.
const feedUrl = 'https://publisher.example.org/feed.xml';
const feedType = 'application/rss+xml';
const transcript = 'WEBVTT\n\n00:00.000 --> 00:01.000\nOriginal publisher words.\n';
const resource = (url, text, type = feedType) => ({ url, type, body: Buffer.from(text) });
const episode = (number, version = 'original') => `<item><guid>episode-${number}</guid><title>${version} ${number}</title><enclosure url="https://media.example.org/${version}-${number}.mp3" type="audio/mpeg" length="12"/><podcast:transcript url="https://publisher.example.org/${version}-${number}.vtt" type="text/vtt" language="en"/></item>`;
const rss = (version = 'original', count = 3) => `<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>${version}</title><language>en</language>${Array.from({ length: count }, (_, index) => episode(index + 1, version)).join('')}</channel></rss>`;
const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:podcast="https://podcastindex.org/namespace/1.0" xml:lang="en"><title>Atom</title>${[1, 2, 3].map(number => `<entry><id>episode-${number}</id><title>Atom ${number}</title><link rel="enclosure" href="https://media.example.org/atom-${number}.mp3" type="audio/mpeg"/><podcast:transcript url="https://publisher.example.org/atom-${number}.vtt" type="text/vtt" language="en"/></entry>`).join('')}</feed>`;
const ids = parsePodcastFeed(rss(), feedUrl).episodes.map(item => item.id);
const selection = (index = 0, url = feedUrl) => ({ feedUrl: url, episodeId: ids[index] });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function service({ source = () => resource(feedUrl, rss()), timedText, now } = {}) {
  const calls = [];
  const sources = createPodcastSources({ now, fetchResource: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('.vtt')) return timedText ? timedText(url, options) : resource(url, transcript, 'text/vtt');
    if (url.endsWith('.mp3')) return resource(url, 'media bytes', 'audio/mpeg');
    return source(url, options);
  } });
  return { sources, calls, reads: url => calls.filter(call => call.url === url).length };
}

for (const [format, body, type] of [['RSS', rss(), feedType], ['Atom', atom, 'application/atom+xml']]) {
  test(`${format} discovery shares one completed source with sibling imports, never timed text`, async () => {
    const { sources, calls, reads } = service({ source: url => resource(url, body, type), now: () => 1000 });
    const found = await sources.discover({ url: feedUrl });
    assert.equal(found.feed_reused, false);
    assert.equal(found.feed_checked_at, new Date(1000).toISOString());
    for (const item of found.episodes) {
      const imported = await sources.importEpisode({ feedUrl, episodeId: item.id });
      assert.equal(imported.status, 'ready');
      assert.equal(imported.feed_reused, true);
      assert.equal(imported.feed_checked_at, found.feed_checked_at);
      assert.equal(imported.document.segments[0].text, 'Original publisher words.');
    }
    await sources.importEpisode({ feedUrl, episodeId: found.episodes[0].id });
    assert.equal(reads(feedUrl), 1);
    assert.equal(calls.filter(call => call.url.endsWith('.vtt')).length, 4);
    assert.equal(calls.some(call => call.url.endsWith('.mp3')), false);
    assert.equal(calls[0].options.maxBytes, PODCAST_LIMITS.metadataBytes);
  });
}

test('a cold import seeds a completed snapshot, and service instances do not share it', async () => {
  const one = service(), two = service();
  assert.equal((await one.sources.importEpisode(selection())).feed_reused, false);
  assert.equal((await one.sources.importEpisode(selection(1))).feed_reused, true);
  assert.equal(one.reads(feedUrl), 1);
  assert.equal((await two.sources.importEpisode(selection(1))).feed_reused, false);
  assert.equal(two.reads(feedUrl), 1);
});

test('snapshot TTL starts on completion, expires at 60 seconds, and cache reads do not extend it', async () => {
  let time = 1000;
  const gate = deferred();
  let count = 0;
  const { sources, reads } = service({ now: () => time, source: async url => {
    if (++count === 1) await gate.promise;
    return resource(url, rss());
  } });
  const pending = sources.discover({ url: feedUrl });
  time = 20000;
  gate.resolve();
  const found = await pending;
  assert.equal(found.feed_checked_at, new Date(20000).toISOString());
  time = 79999;
  assert.equal((await sources.importEpisode(selection())).feed_reused, true);
  assert.equal(reads(feedUrl), 1);
  time = 80000;
  const refreshed = await sources.importEpisode(selection(1));
  assert.equal(refreshed.feed_reused, false);
  assert.equal(refreshed.feed_checked_at, new Date(80000).toISOString());
  assert.equal(reads(feedUrl), 2);
});

test('a backwards clock cannot keep a completed snapshot indefinitely', async () => {
  let time = 1000;
  const { sources, reads } = service({ now: () => time });
  await sources.discover({ url: feedUrl });
  time = 999;
  assert.equal((await sources.importEpisode(selection())).feed_reused, false);
  assert.equal(reads(feedUrl), 2);
});

test('returned discovery and import objects cannot mutate the private source snapshot', async () => {
  const { sources, reads } = service();
  const found = await sources.discover({ url: feedUrl });
  found.title = 'tampered';
  found.episodes[0].title = 'tampered';
  found.episodes[0].media[0].url = 'https://attacker.example.org/replaced.mp3';
  found.episodes[0].transcripts[0].url = 'https://attacker.example.org/replaced.vtt';
  found.episodes[0].transcripts[0].supported = false;
  found.episodes.splice(1);
  found.warnings.push('tampered');
  for (const key of Object.getOwnPropertySymbols(found)) {
    const index = found[key];
    index.ids?.clear();
    index.mediaOwners?.clear();
    index.ambiguous?.add(ids[0]);
  }
  const first = await sources.importEpisode(selection());
  assert.equal(first.status, 'ready');
  assert.equal(first.episode.title, 'original 1');
  assert.equal(first.document.podcast_source.media_url, 'https://media.example.org/original-1.mp3');
  assert.equal(first.document.podcast_source.transcript_url, 'https://publisher.example.org/original-1.vtt');
  first.episode.title = 'mutated import';
  first.episode.transcripts[0].url = 'https://attacker.example.org/import.vtt';
  first.document.segments[0].text = 'mutated transcript';
  assert.equal((await sources.importEpisode(selection())).episode.title, 'original 1');
  assert.equal((await sources.importEpisode(selection(1))).episode.title, 'original 2');
  assert.equal(reads(feedUrl), 1);
});

test('explicit discovery always refreshes and replaces cached publisher metadata', async () => {
  let version = 'original';
  const { sources, reads } = service({ source: url => resource(url, rss(version)) });
  await sources.discover({ url: feedUrl });
  version = 'updated';
  const refreshed = await sources.discover({ url: feedUrl });
  assert.equal(refreshed.title, 'updated');
  assert.equal(refreshed.feed_reused, false);
  const imported = await sources.importEpisode(selection());
  assert.equal(imported.episode.title, 'updated 1');
  assert.equal(imported.feed_reused, true);
  assert.equal(reads(feedUrl), 2);
});

test('a failed explicit refresh invalidates the previous snapshot before transport completes', async () => {
  const gate = deferred();
  let count = 0;
  const { sources, reads } = service({ source: async url => {
    if (++count === 2) await gate.promise;
    return resource(url, rss(count === 1 ? 'original' : 'updated'));
  } });
  await sources.discover({ url: feedUrl });
  const refresh = sources.discover({ url: feedUrl });
  const rejected = assert.rejects(refresh, /refresh unavailable/);
  const imported = await sources.importEpisode(selection());
  assert.equal(imported.episode.title, 'updated 1');
  assert.equal(imported.feed_reused, false);
  assert.equal(reads(feedUrl), 3, 'an in-progress refresh must not serve the invalidated snapshot');
  gate.reject(new Error('refresh unavailable'));
  await rejected;
  assert.equal((await sources.importEpisode(selection(1))).feed_reused, true);
});

test('failed or malformed feed refreshes cannot fall back to a previous completed snapshot', async () => {
  for (const failure of [new Error('offline'), '<rss><channel>broken']) {
    let count = 0;
    const { sources, reads } = service({ source: url => {
      if (++count === 2) {
        if (failure instanceof Error) throw failure;
        return resource(url, failure);
      }
      return resource(url, rss(count === 1 ? 'original' : 'updated'));
    } });
    await sources.discover({ url: feedUrl });
    await assert.rejects(sources.discover({ url: feedUrl }));
    const imported = await sources.importEpisode(selection());
    assert.equal(imported.episode.title, 'updated 1');
    assert.equal(imported.feed_reused, false);
    assert.equal(reads(feedUrl), 3);
  }
});

test('a transcript failure leaves the independently completed feed available for a retry', async () => {
  let attempts = 0;
  const { sources, reads } = service({ timedText: url => {
    if (++attempts === 1) throw new Error('transcript temporarily unavailable');
    return resource(url, transcript, 'text/vtt');
  } });
  await assert.rejects(sources.importEpisode(selection()), /transcript temporarily unavailable/);
  assert.equal((await sources.importEpisode(selection())).feed_reused, true);
  assert.equal(reads(feedUrl), 1);
  assert.equal(attempts, 2);
});

test('later-started refresh wins when an older request completes after it', async () => {
  const first = deferred(), second = deferred();
  let count = 0;
  const { sources, reads } = service({ source: url => ++count === 1 ? first.promise : second.promise });
  const older = sources.discover({ url: feedUrl });
  const newer = sources.discover({ url: feedUrl });
  second.resolve(resource(feedUrl, rss('newer')));
  assert.equal((await newer).title, 'newer');
  first.resolve(resource(feedUrl, rss('older')));
  assert.equal((await older).title, 'older');
  assert.equal((await sources.importEpisode(selection())).episode.title, 'newer 1');
  assert.equal(reads(feedUrl), 2);
});

test('a later failed refresh prevents an older late completion from repopulating the cache', async () => {
  const first = deferred(), second = deferred();
  let count = 0;
  const { sources, reads } = service({ source: url => {
    ++count;
    return count === 1 ? first.promise : count === 2 ? second.promise : resource(url, rss('current'));
  } });
  const older = sources.discover({ url: feedUrl });
  const newer = sources.discover({ url: feedUrl });
  const failed = assert.rejects(newer, /newer failed/);
  second.reject(new Error('newer failed'));
  await failed;
  first.resolve(resource(feedUrl, rss('older')));
  await older;
  const imported = await sources.importEpisode(selection());
  assert.equal(imported.episode.title, 'current 1');
  assert.equal(imported.feed_reused, false);
  assert.equal(reads(feedUrl), 3);
});

test('cold imports never share in-flight fetches or one caller’s cancellation', async () => {
  const requests = [];
  const { sources, reads } = service({ source: (url, { signal }) => {
    const gate = deferred();
    const abort = () => gate.reject(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    requests.push({ url, gate, signal });
    return gate.promise.finally(() => signal?.removeEventListener('abort', abort));
  } });
  const controller = new AbortController();
  const one = sources.importEpisode(selection(), { signal: controller.signal });
  const cancelled = assert.rejects(one, /first caller cancelled/);
  const two = sources.importEpisode(selection(1));
  assert.equal(requests.length, 2);
  assert.equal(reads(feedUrl), 2);
  controller.abort(new Error('first caller cancelled'));
  await cancelled;
  requests[1].gate.resolve(resource(feedUrl, rss()));
  assert.equal((await two).status, 'ready');
  assert.equal((await sources.importEpisode(selection(2))).feed_reused, true);
  assert.equal(reads(feedUrl), 2);
});

test('an aborted request is not cached even when transport ignores its signal and returns a valid feed', async () => {
  const gate = deferred();
  let count = 0;
  const { sources, reads } = service({ source: url => ++count === 1 ? gate.promise : resource(url, rss('current')) });
  const controller = new AbortController();
  const pending = sources.importEpisode(selection(), { signal: controller.signal });
  const cancelled = assert.rejects(pending, /cancelled before completion/);
  controller.abort(new Error('cancelled before completion'));
  gate.resolve(resource(feedUrl, rss('cancelled')));
  await cancelled;
  const imported = await sources.importEpisode(selection());
  assert.equal(imported.feed_reused, false);
  assert.equal(imported.episode.title, 'current 1');
  assert.equal(reads(feedUrl), 2);
});

test('an already cancelled cache hit starts no transcript request and leaves another caller independent', async () => {
  const { sources, calls, reads } = service();
  await sources.discover({ url: feedUrl });
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  await assert.rejects(sources.importEpisode(selection(), { signal: controller.signal }), /already cancelled/);
  assert.equal(calls.length, 1);
  assert.equal((await sources.importEpisode(selection(1))).status, 'ready');
  assert.equal(reads(feedUrl), 1);
});

test('at most two completed feed snapshots survive; the oldest insertion is evicted', async () => {
  const urls = ['one', 'two', 'three'].map(name => `https://publisher.example.org/${name}.xml`);
  const { sources, reads } = service({ source: url => resource(url, rss()) });
  for (const url of urls) await sources.importEpisode(selection(0,url));
  for (const url of urls.slice(1)) {
    assert.equal((await sources.importEpisode(selection(0, url))).feed_reused, true);
    assert.equal(reads(url), 1);
  }
  assert.equal((await sources.importEpisode(selection(0, urls[0]))).feed_reused, false);
  assert.equal(reads(urls[0]), 2);
});

test('requested and final public feed URLs address one snapshot after a redirect', async () => {
  const finalUrl = 'https://publisher.example.org/canonical.xml';
  const { sources, reads } = service({ source: () => resource(finalUrl, rss()) });
  const found = await sources.discover({ url: feedUrl });
  assert.equal(found.feed_url, finalUrl);
  assert.equal((await sources.importEpisode(selection(0, finalUrl))).feed_reused, true);
  assert.equal((await sources.importEpisode(selection(1, feedUrl))).feed_reused, true);
  assert.equal(reads(feedUrl), 1);
  assert.equal(reads(finalUrl), 0);
});

test('a failed refresh through the canonical URL invalidates a known redirect alias', async () => {
  const finalUrl = 'https://publisher.example.org/canonical.xml';
  let count = 0;
  const { sources, reads } = service({ source: () => {
    if (++count === 2) throw new Error('canonical refresh failed');
    return resource(finalUrl, rss(count === 1 ? 'original' : 'updated'));
  } });
  await sources.discover({ url: feedUrl });
  await assert.rejects(sources.discover({ url: finalUrl }), /canonical refresh failed/);
  const imported = await sources.importEpisode(selection());
  assert.equal(imported.episode.title, 'updated 1');
  assert.equal(imported.feed_reused, false);
  assert.equal(reads(feedUrl), 2);
  assert.equal(reads(finalUrl), 1);
});

test('a newer failed canonical refresh fences off an older not-yet-known redirect alias', async () => {
  const finalUrl = 'https://publisher.example.org/canonical.xml';
  const gate = deferred();
  let count = 0;
  const { sources, reads } = service({ source: () => {
    if (++count === 1) return gate.promise;
    if (count === 2) throw new Error('newer canonical refresh failed');
    return resource(finalUrl, rss('current'));
  } });
  const older = sources.discover({ url: feedUrl });
  await assert.rejects(sources.discover({ url: finalUrl }), /newer canonical refresh failed/);
  gate.resolve(resource(finalUrl, rss('older')));
  assert.equal((await older).title, 'older');
  const imported = await sources.importEpisode(selection(0, finalUrl));
  assert.equal(imported.episode.title, 'current 1');
  assert.equal(imported.feed_reused, false);
  assert.equal(reads(feedUrl), 1);
  assert.equal(reads(finalUrl), 2);
});

test('two previously unknown redirect aliases cannot let older completion replace the newer snapshot', async () => {
  const secondUrl = 'https://publisher.example.org/alternate.xml';
  const finalUrl = 'https://publisher.example.org/canonical.xml';
  const first = deferred(), second = deferred();
  const { sources, reads } = service({ source: url => url === feedUrl ? first.promise : second.promise });
  const older = sources.discover({ url: feedUrl });
  const newer = sources.discover({ url: secondUrl });
  second.resolve(resource(finalUrl, rss('newer')));
  await newer;
  first.resolve(resource(finalUrl, rss('older')));
  await older;
  const imported = await sources.importEpisode(selection(0, finalUrl));
  assert.equal(imported.episode.title, 'newer 1');
  assert.equal(imported.feed_reused, true);
  assert.equal(reads(finalUrl), 0);
});

test('media downloads always revalidate the current enclosure rather than trusting a snapshot', async () => {
  let version = 'original';
  const { sources, calls, reads } = service({ source: url => resource(url, rss(version)) });
  const found = await sources.discover({ url: feedUrl });
  version = 'updated';
  await assert.rejects(sources.downloadMedia({ ...selection(), mediaUrl: found.episodes[0].media[0].url }), /当前的公开 enclosure/);
  assert.equal(calls.filter(call => call.url.endsWith('.mp3')).length, 0);
  const request = { ...selection(), mediaUrl: 'https://media.example.org/updated-1.mp3' };
  assert.equal((await sources.downloadMedia(request)).kind, 'audio');
  assert.equal((await sources.downloadMedia(request)).kind, 'audio');
  assert.equal(reads(feedUrl), 4);
  assert.equal(reads(request.mediaUrl), 2);
});

test('Xiaoyuzhou public access gates remain fresh for every import and media download', async () => {
  const eid = '6ab0922a0916f6f8b4468234';
  const url = `https://www.xiaoyuzhoufm.com/episode/${eid}`;
  let payType = 'FREE';
  const { sources, reads } = service({ source: () => resource(url, `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { episode: {
    eid, title: 'Public fixture', status: 'NORMAL', payType, isPrivateMedia: false,
    media: { size: 12, mimeType: 'audio/mpeg', source: { mode: 'PUBLIC', url: 'https://media.example.org/public.mp3' } },
    enclosure: { url: 'https://media.example.org/public.mp3' },
  } } } })}</script>`, 'text/html') });
  const found = await sources.discover({ url });
  const selected = { feedUrl: url, episodeId: found.episodes[0].id };
  assert.equal((await sources.importEpisode(selected)).status, 'needs_transcription');
  assert.equal((await sources.importEpisode(selected)).status, 'needs_transcription');
  assert.equal(reads(url), 3);
  payType = 'PAID';
  await assert.rejects(sources.importEpisode(selected), /没有同时明确/);
  await assert.rejects(sources.downloadMedia({ ...selected, mediaUrl: found.episodes[0].media[0].url }), /没有同时明确/);
  assert.equal(reads(url), 5);
  assert.equal(reads('https://media.example.org/public.mp3'), 0);
});

test('Apple single-episode presentation cannot narrow the cached publisher snapshot', async () => {
  const { sources, reads } = service({ source: url => url.startsWith('https://itunes.apple.com/') ? resource(url, JSON.stringify({ results: url.includes('entity=podcastEpisode') ? [{
    kind: 'podcast-episode', collectionId: 12345, trackId: 67890, episodeGuid: 'episode-1',
  }] : [{ kind: 'podcast', collectionId: 12345, feedUrl }] }), 'application/json') : resource(url, rss()) });
  const found = await sources.discover({ url: 'https://podcasts.apple.com/us/podcast/show/id12345?i=67890' });
  assert.equal(found.episode_selection.status, 'matched');
  assert.equal(found.episodes.length, 1);
  const sibling = await sources.importEpisode(selection(1));
  assert.equal(sibling.episode.title, 'original 2');
  assert.equal(sibling.feed_reused, true);
  assert.equal(reads(feedUrl), 1);
});

test('Apple matching retains the private identity index for conflicting episodes beyond the display limit', async () => {
  const body = rss('original', PODCAST_LIMITS.episodes + 1);
  const { sources, reads } = service({ source: url => url.startsWith('https://itunes.apple.com/') ? resource(url, JSON.stringify({ results: url.includes('entity=podcastEpisode') ? [{
    kind: 'podcast-episode', collectionId: 12345, trackId: 67890, episodeGuid: 'episode-1',
    episodeUrl: `https://media.example.org/original-${PODCAST_LIMITS.episodes + 1}.mp3`,
  }] : [{ kind: 'podcast', collectionId: 12345, feedUrl }] }), 'application/json') : resource(url, body) });
  const found = await sources.discover({ url: 'https://podcasts.apple.com/us/podcast/show/id12345?i=67890' });
  assert.equal(found.episode_selection.status, 'choice_required');
  assert.equal(found.episodes.length, PODCAST_LIMITS.episodes);
  assert.equal(found.truncated, true);
  assert.equal(JSON.stringify(found).includes('mediaOwners'), false);
  assert.equal((await sources.importEpisode(selection())).feed_reused, true);
  assert.equal(reads(feedUrl), 1);
});


test('redirect retargeting never transfers a previously verified canonical identity to the new destination', async () => {
  const oldUrl='https://publisher.example.org/old.xml',newUrl='https://publisher.example.org/new.xml';
  let redirected=oldUrl;
  const {sources,reads}=service({source:url=>resource(url===feedUrl?redirected:url,rss((url===feedUrl?redirected:url)===oldUrl?'old':'new'))});
  const old=await sources.discover({url:feedUrl});
  redirected=newUrl;
  const fresh=await sources.discover({url:feedUrl});
  assert.equal(fresh.feed_url,newUrl);
  assert.equal((await sources.importEpisode(selection(0,feedUrl))).feed_url,newUrl);
  const reopened=await sources.importEpisode({feedUrl:old.feed_url,episodeId:old.episodes[0].id});
  assert.equal(reopened.feed_url,oldUrl);
  assert.equal(reopened.episode.title,'old 1');
  assert.equal(reopened.feed_reused,false);
  assert.equal(reads(oldUrl),1);
  assert.equal(reads(feedUrl),2);
});


test('explicit refresh invalidates a source even when the request admission bound rejects it', async () => {
  const gate=deferred();
  const {sources,reads}=service({timedText:async url=>{await gate.promise;return resource(url,transcript,'text/vtt');}});
  await sources.discover({url:feedUrl});
  const first=sources.importEpisode(selection()),second=sources.importEpisode(selection(1));
  await assert.rejects(sources.discover({url:feedUrl}),/最多同时处理两个/);
  gate.resolve();await Promise.all([first,second]);
  assert.equal((await sources.importEpisode(selection(2))).feed_reused,false);
  assert.equal(reads(feedUrl),2);
});


test('an old redirect alias still invalidates after canonical discovery no longer exposes that alias', async () => {
  const canonical='https://publisher.example.org/canonical.xml';let fail=false;
  const {sources,reads}=service({source:()=>{if(fail)throw Error('publisher unavailable');return resource(canonical,rss());}});
  await sources.discover({url:feedUrl});
  await sources.discover({url:canonical});
  fail=true;
  await assert.rejects(sources.discover({url:feedUrl}),/publisher unavailable/);
  await assert.rejects(sources.importEpisode(selection(0,canonical)),/publisher unavailable/);
  assert.equal(reads(feedUrl),2);assert.equal(reads(canonical),2);
});

test('an already cancelled explicit discovery discards completed snapshots without a fetch', async () => {
  const {sources,reads}=service();
  await sources.discover({url:feedUrl});
  const controller=new AbortController();controller.abort(new Error('refresh cancelled'));
  await assert.rejects(sources.discover({url:feedUrl},{signal:controller.signal}),/refresh cancelled/);
  assert.equal(reads(feedUrl),1);
  assert.equal((await sources.importEpisode(selection())).feed_reused,false);
  assert.equal(reads(feedUrl),2);
});

test('an invalid discovery URL cannot discard a valid completed source snapshot', async () => {
  const {sources,reads}=service();
  await sources.discover({url:feedUrl});
  await assert.rejects(sources.discover({url:'file:///private/feed.xml'}));
  assert.equal((await sources.importEpisode(selection())).feed_reused,true);
  assert.equal(reads(feedUrl),1);
});
