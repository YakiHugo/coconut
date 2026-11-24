import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_PODCAST_DOWNLOAD_POLICY,podcastDownloadPolicyFromEnvironment} from '../desktop/podcast-download-policy.mjs';
import {createPodcastSources} from '../desktop/podcast-sources.mjs';
import {serviceConfig} from '../server/config.mjs';

const total='COCONUT_PODCAST_DOWNLOAD_TIMEOUT_SECONDS',idle='COCONUT_PODCAST_DOWNLOAD_IDLE_TIMEOUT_SECONDS';
test('download settings are bounded startup seconds and standalone uses its supplied environment',()=>{
 assert.deepEqual(podcastDownloadPolicyFromEnvironment({}),{timeoutMs:7200000,idleTimeoutMs:120000});
 const env={[total]:'3600',[idle]:'180'};
 assert.deepEqual(serviceConfig(env).podcastDownloadPolicy,{timeoutMs:3600000,idleTimeoutMs:180000});
 for(const key of [total,idle])for(const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '1e3', '9007199254740992'])
  assert.throws(()=>podcastDownloadPolicyFromEnvironment({[key]:value}));
 for(const env of [{[total]:'86401'},{[idle]:'601'},{[total]:'60',[idle]:'61'}])
  assert.throws(()=>podcastDownloadPolicyFromEnvironment(env));
 assert.deepEqual(podcastDownloadPolicyFromEnvironment({[total]:'86400',[idle]:'600'}),{timeoutMs:86400000,idleTimeoutMs:600000});
 assert.deepEqual(DEFAULT_PODCAST_DOWNLOAD_POLICY,{timeoutMs:7200000,idleTimeoutMs:120000});
});
test('media downloads use a frozen startup policy while metadata and HTTP input cannot extend it',async()=>{
 const feedUrl='https://publisher.example.org/feed',mediaUrl='https://publisher.example.org/episode.mp3';
 const calls=[],input={timeoutMs:3600000,idleTimeoutMs:180000};
 const sources=createPodcastSources({downloadPolicy:input,fetchResource:async(url,options)=>{
  calls.push({url,options});
  return {url,type:url===feedUrl?'application/rss+xml':'audio/mpeg',body:Buffer.from(url===feedUrl
   ?`<rss><channel><item><guid>authored</guid><title>Episode</title><enclosure url="${mediaUrl}" type="audio/mpeg"/></item></channel></rss>`
   :'authored audio')};
 }});
 input.timeoutMs=86400000;
 const feed=await sources.discover({url:feedUrl});
 await sources.downloadMedia({feedUrl,episodeId:feed.episodes[0].id,mediaUrl,timeoutMs:86400000,idleTimeoutMs:600000});
 assert.deepEqual(calls.map(({url})=>url),[feedUrl,feedUrl,mediaUrl]);
 assert.equal(calls[0].options.timeoutMs,undefined,'metadata keeps the fetcher default');
 assert.equal(calls[1].options.timeoutMs,undefined,'download revalidation keeps the metadata deadline');
 assert.equal(calls[2].options.timeoutMs,3600000);
 assert.equal(calls[2].options.idleTimeoutMs,180000);
 assert.equal(calls[2].options.maxBytes,200*1024*1024);
 assert.ok(Object.isFrozen(sources.downloadPolicy));
 assert.deepEqual(sources.downloadPolicy,{timeoutMs:3600000,idleTimeoutMs:180000});
 await sources.downloadMedia({url:mediaUrl,timeoutMs:86400000});
 assert.equal(calls.at(-1).options.timeoutMs,3600000,'direct media uses the same startup deadline');
});
