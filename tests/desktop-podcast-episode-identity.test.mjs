import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPodcastSources, parsePodcastFeed, PODCAST_LIMITS } from '../desktop/podcast-sources.mjs';
import { createIngestionService } from '../desktop/ingestion-service.mjs';
import { PublicSourceError } from '../desktop/public-http.mjs';

const showId='699921e13ae08cdf3348fdd6';
const showUrl=`https://www.xiaoyuzhoufm.com/podcast/${showId}`;
const eidA='6ab0922a0916f6f8b4468234',eidB='6ab0922a0916f6f8b4468235';
const episodeUrl=eid=>`https://www.xiaoyuzhoufm.com/episode/${eid}`;
const episodeId=eid=>createHash('sha256').update(eid).digest('hex');
const mediaUrl=eid=>`https://media.example.org/${eid}.m4a`;
const episode=eid=>({eid,pid:showId,title:'Same publisher title',duration:20,status:'NORMAL',payType:'FREE',isPrivateMedia:false,
  media:{size:12,mimeType:'audio/mp4',source:{mode:'PUBLIC',url:mediaUrl(eid)}},enclosure:{url:mediaUrl(eid)}});
const page=pageProps=>'<script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({props:{pageProps}})+'</script>';
const resource=(url,body,type='text/html')=>({url,type,body:Buffer.from(body)});
function harness() {
  const calls=[],state={displayed:[episode(eidA)],permanent:episode(eidA)};
  const sources=createPodcastSources({fetchResource:async(url,options)=>{
    calls.push({url,options});
    if(url===showUrl)return resource(url,page({podcast:{pid:showId,title:'Publisher',episodes:state.displayed}}));
    if(url===episodeUrl(eidA))return resource(url,page({episode:state.permanent}));
    if(url===mediaUrl(eidA))return resource(url,'small media','audio/mp4');
    throw new Error('Unexpected fixture URL: '+url);
  }});
  return {calls,state,sources};
}
const savedRequest={feedUrl:showUrl,episodeId:episodeId(eidA),episodeUrl:episodeUrl(eidA),mediaUrl:mediaUrl(eidA)};

test('a Xiaoyuzhou episode saved from a show keeps its permanent source after the displayed list slides to another episode',async()=>{
  const {calls,state,sources}=harness();
  const found=await sources.discover({url:showUrl});
  assert.equal(found.feed_url,showUrl);
  assert.equal(found.episodes[0].id,episodeId(eidA));
  const service=createIngestionService({podcastSources:sources});
  const {ingestion}=await service.ingest({protocolVersion:1,intent:'media_only',source:{kind:'url',url:showUrl},
    episode:{feed_url:showUrl,episode_id:found.episodes[0].id}});
  const document=ingestion.project.document;
  assert.equal(document.source_url,episodeUrl(eidA));
  assert.equal(document.podcast_source.feed_url,episodeUrl(eidA));
  assert.equal(document.podcast_source.episode_id,episodeId(eidA));
  assert.equal(ingestion.media.download.body.feedUrl,episodeUrl(eidA));
  assert.deepEqual(calls.map(call=>call.url),[showUrl,showUrl]);

  state.displayed=[episode(eidB)];
  assert.equal((await sources.discover({url:showUrl})).episodes[0].id,episodeId(eidB));
  const before=calls.length;
  const media=await sources.downloadMedia(ingestion.media.download.body);
  assert.equal(media.body.toString(),'small media');
  assert.deepEqual(calls.slice(before).map(call=>call.url),[episodeUrl(eidA),mediaUrl(eidA)]);
  assert.equal(calls.at(-1).options.timeoutMs,30*60*1000);
  assert.equal(calls.at(-1).options.idleTimeoutMs,30000);
  assert.equal(calls.at(-1).options.maxBytes,PODCAST_LIMITS.mediaBytes);
});

test('normal Xiaoyuzhou import without a publisher transcript also returns a permanent project feed',async()=>{
  const {sources}=harness();
  const result=await sources.importEpisode({feedUrl:showUrl,episodeId:episodeId(eidA)});
  assert.equal(result.status,'needs_transcription');
  assert.equal(result.feed_url,episodeUrl(eidA));
});

test('official episode share parameters survive discovery and selection while durable identities drop them and credential queries never fetch',async()=>{
  const canonical=episodeUrl(eidA),shareUrl=canonical+'?utm_source=share_page&utm_medium=mobile&source=share';
  const calls=[],sources=createPodcastSources({fetchResource:async url=>{
    calls.push(url);
    if(url===shareUrl||url===canonical)return resource(url,page({episode:episode(eidA)}));
    assert.equal(url,mediaUrl(eidA));
    return resource(url,'small media','audio/mp4');
  }});
  const found=await sources.discover({url:shareUrl});
  assert.equal(found.feed_url,shareUrl);
  const selected={feedUrl:found.feed_url,episodeId:found.episodes[0].id};
  const opened=await sources.openEpisodeMedia(selected),imported=await sources.importEpisode(selected);
  for(const result of [opened,imported]) {
    assert.equal(result.feed_url,canonical);
    assert.equal(result.episode.id,episodeId(eidA));
    assert.equal(result.episode.source_url,canonical);
  }
  assert.equal((await sources.downloadMedia({feedUrl:opened.feed_url,episodeId:selected.episodeId,mediaUrl:mediaUrl(eidA)})).body.toString(),'small media');
  assert.deepEqual(calls,[shareUrl,canonical,canonical,canonical,mediaUrl(eidA)]);
  const before=calls.length;
  for(const query of ['token=secret','signature=secret']) {
    const feedUrl=canonical+'?utm_source=share_page&'+query;
    await assert.rejects(sources.discover({url:feedUrl}),/访问令牌或签名/);
    await assert.rejects(sources.openEpisodeMedia({...selected,feedUrl}),/访问令牌或签名/);
    await assert.rejects(sources.importEpisode({...selected,feedUrl}),/访问令牌或签名/);
    await assert.rejects(sources.downloadMedia({...selected,feedUrl,mediaUrl:mediaUrl(eidA)}),/访问令牌或签名/);
  }
  await assert.rejects(sources.downloadMedia({...savedRequest,episodeUrl:shareUrl}),/标识不一致/);
  assert.equal(calls.length,before);
});

test('an existing show-feed project uses its original episode URL after the show drops it, without consulting the show list',async()=>{
  const {calls,state,sources}=harness();
  state.displayed=[episode(eidB)];
  const media=await sources.downloadMedia(savedRequest);
  assert.equal(media.body.toString(),'small media');
  assert.deepEqual(calls.map(call=>call.url),[episodeUrl(eidA),mediaUrl(eidA)]);
  await sources.downloadMedia(savedRequest);
  assert.deepEqual(calls.map(call=>call.url),[episodeUrl(eidA),mediaUrl(eidA),episodeUrl(eidA),mediaUrl(eidA)]);
});

test('a show URL passed directly for downloading still checks the selected permanent episode page',async()=>{
  const {calls,state,sources}=harness();
  state.permanent={...episode(eidA),payType:'PAID'};
  const {episodeUrl:unused,...request}=savedRequest;
  await assert.rejects(sources.downloadMedia(request),/没有同时明确/);
  assert.deepEqual(calls.map(call=>call.url),[showUrl,episodeUrl(eidA)]);
});

test('saved Xiaoyuzhou episodes recheck free, private, status and PUBLIC gates on the permanent page on every download',async t=>{
  const a=episode(eidA);
  for(const [name,change] of [
    ['paid',{payType:'PAID'}],
    ['unknown payment',{payType:undefined}],
    ['private',{isPrivateMedia:true}],
    ['unknown privacy',{isPrivateMedia:undefined}],
    ['deleted',{status:'DELETED'}],
    ['private media',{media:{...a.media,source:{...a.media.source,mode:'PRIVATE'}}}],
    ['preview enclosure',{enclosure:{url:mediaUrl(eidB)}}],
  ])await t.test(name,async()=>{
    const {calls,state,sources}=harness();
    await sources.downloadMedia(savedRequest);
    state.displayed=[episode(eidB)];
    state.permanent={...a,...change};
    const before=calls.length;
    await assert.rejects(sources.downloadMedia(savedRequest),/没有同时明确/);
    assert.deepEqual(calls.slice(before).map(call=>call.url),[episodeUrl(eidA)]);
  });
});

test('a changed Xiaoyuzhou access gate exposes only a trusted static access diagnostic',async()=>{
  const {calls,state,sources}=harness();
  state.permanent={...episode(eidA),payType:'PAID',title:'Publisher private diagnostic sentinel'};
  await assert.rejects(sources.downloadMedia(savedRequest),error=>{
    assert.ok(error instanceof PublicSourceError);
    assert.equal(error.code,'SOURCE_ACCESS');
    assert.match(error.message,/没有同时明确标记免费、非私有、公开媒体/);
    assert.doesNotMatch(error.message,/sentinel|https?:\/\/|6ab0922/);
    return true;
  });
  assert.deepEqual(calls.map(call=>call.url),[episodeUrl(eidA)]);
});

test('media safety refusals have trusted identity, limit, type and transfer codes while unexpected adapter errors stay untrusted',async t=>{
  const a=episode(eidA);
  for(const [name,current,mediaResponse,code] of [
    ['changed enclosure',{...a,media:{...a.media,source:{mode:'PUBLIC',url:mediaUrl(eidB)}},enclosure:{url:mediaUrl(eidB)}},null,'SOURCE_IDENTITY'],
    ['declared duration',{...a,duration:PODCAST_LIMITS.duration+1},null,'SOURCE_LIMIT'],
    ['declared size',{...a,media:{...a.media,size:PODCAST_LIMITS.mediaBytes+1}},null,'SOURCE_LIMIT'],
    ['media kind',a,resource(mediaUrl(eidA),'small video','video/mp4'),'SOURCE_TYPE'],
    ['empty body',a,resource(mediaUrl(eidA),'','audio/mp4'),'SOURCE_TRANSFER'],
  ])await t.test(name,async()=>{
    const sources=createPodcastSources({fetchResource:async url=>{
      if(url===episodeUrl(eidA))return resource(url,page({episode:current}));
      assert.equal(url,mediaUrl(eidA));
      assert.ok(mediaResponse,'Safety validation must reject before reading media');
      return mediaResponse;
    }});
    await assert.rejects(sources.downloadMedia(savedRequest),error=>{
      assert.ok(error instanceof PublicSourceError);
      assert.equal(error.code,code);
      assert.doesNotMatch(error.message,/https?:\/\/|6ab0922/);
      return true;
    });
  });
  const unexpected=new Error('Untrusted upstream diagnostic https://upstream.example.org/private');
  const sources=createPodcastSources({fetchResource:async()=>{throw unexpected;}});
  await assert.rejects(sources.downloadMedia(savedRequest),error=>{
    assert.equal(error,unexpected);
    assert.equal(error instanceof PublicSourceError,false);
    return true;
  });
});

test('a permanent page cannot replace the saved enclosure or serve another episode with the same title',async()=>{
  for(const changed of [
    {...episode(eidA),media:{...episode(eidA).media,source:{mode:'PUBLIC',url:mediaUrl(eidB)}},enclosure:{url:mediaUrl(eidB)}},
    episode(eidB),
  ]) {
    const {calls,state,sources}=harness();
    state.displayed=[episode(eidB)];
    state.permanent=changed;
    await assert.rejects(sources.downloadMedia(savedRequest),/不在所选单集|与链接匹配/);
    assert.deepEqual(calls.map(call=>call.url),[episodeUrl(eidA)]);
  }
});

test('a permanent episode fetch cannot authorize media through a redirected show page, insecure page or another origin',async()=>{
  for(const response of [
    resource(showUrl,page({podcast:{pid:showId,title:'Publisher',episodes:[episode(eidA)]}})),
    resource(`http://www.xiaoyuzhoufm.com/episode/${eidA}`,page({episode:episode(eidA)})),
    resource(`https://attacker.example.org/episode/${eidA}`,page({episode:episode(eidA)})),
  ]) {
    const calls=[],sources=createPodcastSources({fetchResource:async url=>{calls.push(url);return response;}});
    await assert.rejects(sources.downloadMedia(savedRequest));
    assert.deepEqual(calls,[episodeUrl(eidA)]);
  }
});

test('unbound, nonofficial and unsafe permanent episode addresses are rejected before any resource is read',async()=>{
  for(const address of [
    episodeUrl(eidB),
    `http://www.xiaoyuzhoufm.com/episode/${eidA}`,
    `https://xiaoyuzhoufm.com.attacker.example.org/episode/${eidA}`,
    `https://attacker.example.org/episode/${eidA}`,
    `https://www.xiaoyuzhoufm.com@attacker.example.org/episode/${eidA}`,
    `https://user:password@www.xiaoyuzhoufm.com/episode/${eidA}`,
    `https://www.xiaoyuzhoufm.com:8443/episode/${eidA}`,
    `https://www.xiaoyuzhoufm.com/episode/${eidA}?next=https://attacker.example.org`,
    showUrl,
    `https://www.xiaoyuzhoufm.com/episode/${eidA}/extra`,
    `https://127.0.0.1/episode/${eidA}`,
    null,
  ]) {
    const {calls,sources}=harness();
    await assert.rejects(sources.downloadMedia({...savedRequest,episodeUrl:address}));
    assert.deepEqual(calls,[],String(address));
  }
  const {calls,sources}=harness();
  await assert.rejects(sources.downloadMedia({...savedRequest,feedUrl:episodeUrl(eidB),episodeUrl:undefined}));
  const {episodeUrl:unused,...direct}=savedRequest;
  await assert.rejects(sources.downloadMedia({...direct,feedUrl:episodeUrl(eidB)}),/标识不一致/);
  assert.deepEqual(calls,[]);
});

test('the bare official host is accepted for a hash-bound permanent URL and canonicalized to the official www host',async()=>{
  const {calls,sources}=harness();
  await sources.downloadMedia({...savedRequest,episodeUrl:`https://xiaoyuzhoufm.com/episode/${eidA}/`});
  assert.deepEqual(calls.map(call=>call.url),[episodeUrl(eidA),mediaUrl(eidA)]);
});

test('RSS downloading retains feed membership checks and cannot be replaced with a Xiaoyuzhou episode URL',async()=>{
  const feedUrl='https://publisher.example.org/feed.xml',url='https://media.example.org/rss.mp3';
  const rss=`<rss><channel><title>RSS</title><item><guid>publisher-guid</guid><title>Same publisher title</title><enclosure url="${url}" type="audio/mpeg" length="12"/></item></channel></rss>`;
  const calls=[],sources=createPodcastSources({fetchResource:async(target,options)=>{
    calls.push({url:target,options});
    if(target===feedUrl)return resource(target,rss,'application/rss+xml');
    if(target===url)return resource(target,'small audio','audio/mpeg');
    throw new Error('Unexpected RSS fixture URL');
  }});
  const request={feedUrl,episodeId:parsePodcastFeed(rss,feedUrl).episodes[0].id,mediaUrl:url};
  const opened=await sources.openEpisodeMedia(request);
  assert.equal(opened.feed_url,feedUrl);
  assert.equal((await sources.downloadMedia(request)).body.toString(),'small audio');
  assert.deepEqual(calls.map(call=>call.url),[feedUrl,feedUrl,url]);
  await assert.rejects(sources.downloadMedia({...request,mediaUrl:mediaUrl(eidA)}),/不在所选单集/);
  assert.equal(calls.at(-1).url,feedUrl);
  const before=calls.length;
  await assert.rejects(sources.downloadMedia({...request,episodeUrl:episodeUrl(eidA)}),/仅小宇宙/);
  await assert.rejects(sources.downloadMedia({...savedRequest,feedUrl:'https://xiaoyuzhoufm.com.attacker.example.org/feed.xml'}),/仅小宇宙/);
  assert.equal(calls.length,before);
});
