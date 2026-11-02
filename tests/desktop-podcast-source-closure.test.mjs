import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPodcastSources} from '../desktop/podcast-sources.mjs';
import {provePodcastSource} from '../scripts/live_podcast_source_closure.mjs';

// All source bytes are authored fixtures. The ingestion, media acquisition,
// library, asset HTTP handlers and restart logic are production implementations.
// This test is intentionally distinct from optional real-public-source CI.
const id='6ae06b84c96c8942ec130784',xyz='https://www.xiaoyuzhoufm.com/episode/'+id;
const feed='https://publisher.example.org/feed.xml',media='https://publisher.example.org/episode.mp3',transcript='https://publisher.example.org/episode.vtt';
const bytes=Buffer.alloc(4096,42);bytes.write('ID3');
const rss=`<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>Authored source</title><language>en</language><item><guid>authored-episode</guid><title>Authored episode</title><enclosure url="${media}" type="audio/mpeg" length="${bytes.length}"/><podcast:transcript url="${transcript}" type="text/vtt" language="en"/></item></channel></rss>`;
const html='<script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({props:{pageProps:{episode:{eid:id,title:'Authored free episode',duration:2,status:'NORMAL',payType:'FREE',isPrivateMedia:false,media:{size:bytes.length,mimeType:'audio/mpeg',source:{mode:'PUBLIC',url:media}},enclosure:{url:media}}}}})+'</script>';
for(const mode of ['xiaoyuzhou','rss'])test('source closure runner preserves '+mode+' media across a real service restart without source reads or ASR',async()=>{
 const calls=[],url=mode==='rss'?feed:xyz;
 const sources=createPodcastSources({fetchResource:async resource=>{calls.push(resource);if(resource===url)return {url,type:mode==='rss'?'application/rss+xml':'text/html',body:Buffer.from(mode==='rss'?rss:html)};if(resource===media)return {url:resource,type:'audio/mpeg',body:bytes};if(resource===transcript)return {url:resource,type:'text/vtt',body:Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nAuthored publisher words.\n')};assert.fail('Unexpected upstream request');}});
 const result=await provePodcastSource({mode,url,podcastSources:sources});assert.equal(result.passed,true,JSON.stringify(result));assert.equal(result.transport,'injected_test_transport');assert.equal(result.media_sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(result.media_bytes,bytes.length);assert.equal(result.media_persisted,true);assert.equal(result.media_restart_hash_match,true);assert.equal(result.sqlite_restart_exact_project,true);assert.equal(result.range_readback_verified,true);assert.equal(result.restore_provider_requests,0);assert.equal(result.transcription_attempted,false);assert.equal(result.paid_calls,0);assert.equal(result.browser_playback_verified,false);assert.equal(result.media_decode_verified,false);assert.equal(result.publisher_segments,mode==='rss'?1:0);assert.equal(calls.filter(value=>value===media).length,1);assert.equal(calls.filter(value=>value===transcript).length,mode==='rss'?1:0);
});
test('source proof failure logs omit publisher payloads and assertion diffs',async()=>{
 const result=await provePodcastSource({mode:'rss',url:feed,podcastSources:{discover:async()=>{throw Error('private-provider-payload');}}});assert.equal(result.passed,false);assert.equal(result.stage,'discover_exact_public_source');assert.match(result.error_code,/^[a-zA-Z0-9_-]+$/);assert.doesNotMatch(JSON.stringify(result),/private-provider-payload/);assert.equal(result.media_persisted,undefined);
});
