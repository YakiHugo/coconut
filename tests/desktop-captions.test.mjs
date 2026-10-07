import test from 'node:test';
import assert from 'node:assert/strict';
import {captionSource,createCaptionService} from '../desktop/caption-service.mjs';
const url='https://x.com/example/status/123456';
const result=()=>({source:{url,id:'media-1',title:'A public video',extractor:'twitter',language:'en',automatic:true,duration:4},format:'vtt',bytes:Buffer.from('WEBVTT\n\n00:00.000 --> 00:02.000\n<v A>Use List<T> &amp; preserve source.</v>\n\n00:02.000 --> 00:04.000\nSecond original sentence.\n')});
const service=extract=>createCaptionService({helper:{extractCaptions:extract},enabledProviders:['x']});
test('video source normalization rejects credentials, other sites, posts and unsupported routes',()=>{
 assert.equal(captionSource('https://mobile.twitter.com/example/status/123456?s=20#x').url,url);
 for(const value of ['http://x.com/example/status/123456','https://a:b@x.com/example/status/123456','https://x.com:8443/example/status/123456','https://x.com/example','https://x.com/search?q=a','https://youtube.com/watch?v=123456'])assert.throws(()=>captionSource(value));
});
test('caption import is disabled by default and never invokes a helper',async()=>{
 let calls=0;const captions=createCaptionService({helper:{extractCaptions:async()=>{calls++;return result();}}});
 assert.equal(captions.available,false);await assert.rejects(captions.importCaption({url}),/尚未启用/);assert.equal(calls,0);
});
test('validated captions preserve timing, literal source text and honest provenance',async()=>{
 const doc=(await service(async()=>result()).importCaption({url,language:'en'})).document;
 assert.equal(doc.segments.length,2);assert.equal(doc.segments[0].text,'Use List<T> & preserve source.');assert.equal(doc.segments[1].start,2);assert.equal(doc.source_url,url);assert.equal(doc.provenance.caption_method,'automatic');assert.equal(doc.provenance.review_status,'unreviewed');assert.equal(doc.provenance.media_id,'media-1');assert.equal(doc.ai_answers.length,0);
});
test('source, language, live-state, duration and output mismatches never become documents',async()=>{
 const changes=[r=>r.source.url='https://x.com/other/status/999',r=>r.source.language='zh',r=>r.source.is_live=true,r=>r.source.duration=21601,r=>r.source.duration=null,r=>r.source.translated=true,r=>delete r.source.automatic,r=>r.source.extractor='generic',r=>r.bytes=Buffer.alloc(8*1024*1024+1),r=>r.format='html'];
 for(const change of changes){const r=result();change(r);await assert.rejects(service(async()=>r).importCaption({url,language:'en'}));}
});
test('cancellation discards late output and concurrent acquisition is bounded',async()=>{
 let release;const captions=service(()=>new Promise(resolve=>{release=resolve;})),controller=new AbortController();const pending=captions.importCaption({url},{signal:controller.signal});
 await assert.rejects(captions.importCaption({url}),/另一份/);controller.abort();release(result());await assert.rejects(pending,/取消/);
});
test('restricted and unavailable outcomes do not assert that a video has no subtitles',async()=>{
 for(const status of ['access_restricted','unavailable','language_required']){const r=await service(async()=>({status})).importCaption({url});assert.equal(r.status,status);assert.equal(r.document,undefined);assert.doesNotMatch(r.message,/没有字幕/);}
});
