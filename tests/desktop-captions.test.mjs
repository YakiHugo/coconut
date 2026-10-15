import test from 'node:test';
import assert from 'node:assert/strict';
import {captionSource,createCaptionService} from '../desktop/caption-service.mjs';
const url='https://x.com/example/status/123456';
const result=()=>({source:{url,id:'1234567890',title:'A public video',extractor:'twitter',language:'en',automatic:true,duration:4},format:'vtt',bytes:Buffer.from('WEBVTT\n\n00:00.000 --> 00:02.000\n<v A>Use List<T> &amp; preserve source.</v>\n\n00:02.000 --> 00:04.000\nSecond original sentence.\n')});
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
 assert.equal(doc.segments.length,2);assert.equal(doc.segments[0].text,'Use List<T> & preserve source.');assert.equal(doc.segments[1].start,2);assert.equal(doc.source_url,url);assert.equal(doc.provenance.caption_method,'automatic');assert.equal(doc.provenance.review_status,'unreviewed');assert.equal(doc.provenance.media_id,'1234567890');assert.equal(doc.ai_answers.length,0);
});
test('source, language, live-state, duration and output mismatches never become documents',async()=>{
 const changes=[r=>r.source.url='https://x.com/other/status/999',r=>r.source.language='zh',r=>r.source.is_live=true,r=>r.source.live=true,r=>r.track={language:'en',captionMethod:'platform_provided'},r=>r.source.duration=21601,r=>r.source.duration=null,r=>r.source.translated=true,r=>delete r.source.automatic,r=>r.source.extractor='generic',r=>r.bytes=Buffer.alloc(8*1024*1024+1),r=>r.format='html'];
 for(const change of changes){const r=result();change(r);await assert.rejects(service(async()=>r).importCaption({url,language:'en'}));}
});
test('cancellation discards late output and concurrent acquisition is bounded',async()=>{
 let release;const captions=service(()=>new Promise(resolve=>{release=resolve;})),controller=new AbortController();const pending=captions.importCaption({url},{signal:controller.signal});
 await assert.rejects(captions.importCaption({url}),/另一份/);controller.abort();release(result());await assert.rejects(pending,/取消/);
});
test('restricted and unavailable outcomes do not assert that a video has no subtitles',async()=>{
 for(const status of ['access_restricted','unavailable','language_required']){const r=await service(async()=>({status})).importCaption({url});assert.equal(r.status,status);assert.equal(r.document,undefined);assert.doesNotMatch(r.message,/没有字幕/);}
});


test('track provenance preserves user language evidence and exact automatic-track identity',async()=>{
 const r=result();r.track={language:'en',captionMethod:'automatic',languageBasis:'user_hint',captionTrack:'en-orig'};const doc=(await service(async()=>r).importCaption({url,language:'en'})).document;assert.equal(doc.provenance.language_basis,'user_hint');assert.equal(doc.provenance.caption_track,'en-orig');
});

test('out-of-order cues are rejected instead of silently rearranging source evidence',async()=>{
 const r=result();r.bytes=Buffer.from('WEBVTT\n\n00:02.000 --> 00:04.000\nLater.\n\n00:00.000 --> 00:02.000\nEarlier.\n');await assert.rejects(service(async()=>r).importCaption({url}),/时间戳/);
});


test('VTT comments and style/region metadata never become spoken source evidence',async()=>{
 const r=result();r.bytes=Buffer.from('WEBVTT\n\nNOTE source comments\n00:00.000 --> 00:00.500\nThis is not a spoken cue\n\nSTYLE\n00:00.000 --> 00:00.500\nNot spoken CSS\n\nREGION\n00:00.000 --> 00:00.500\nNot spoken region\n\n00:00.500 --> 00:01.000\nActual spoken cue.\n');const doc=(await service(async()=>r).importCaption({url})).document;assert.equal(doc.segments.length,1);assert.equal(doc.segments[0].text,'Actual spoken cue.');assert.equal(doc.segments[0].start,.5);
});

// Diagnostics are produced by the shared parser, never accepted from the helper.
import C from '../reader/core.js';
import {captionFixtureURL,captionFixtureResult} from './helpers/caption-diagnostics-fixtures.mjs';
for(const format of ['srt','vtt'])test(`${format} caption response preserves parser loss details outside document identity`,async()=>{
 const fixture=captionFixtureResult({format});fixture.diagnostics=[{category:'forged'}];
 const expected=C.parseWithDiagnostics(fixture.bytes.toString('utf8'),'captions.'+format);
 const actual=await service(async()=>fixture).importCaption({url:captionFixtureURL,language:'en'});
 assert.equal(actual.status,'ready');assert.deepEqual(actual.diagnostics,expected.diagnostics);
 assert.deepEqual(actual.document.segments,expected.document.segments);
 assert.deepEqual(actual.diagnostics.map(item=>item.category),['malformed_timing','empty_cue']);
 assert.equal(actual.document.title,fixture.source.title);assert.equal(actual.document.provenance.caption_track,'en-original-fixture');
 assert.equal(actual.document.provenance.caption_method,'platform_provided');assert.equal(actual.document.provenance.review_status,'unreviewed');
 assert.equal(Object.hasOwn(actual.document,'diagnostics'),false);assert.equal(JSON.stringify(actual.document).includes('Missing authored detail'),false);
 const complete=await service(async()=>captionFixtureResult({format,complete:true})).importCaption({url:captionFixtureURL});
 assert.deepEqual(complete.diagnostics,[]);assert.deepEqual(actual.document,complete.document);
});
test('all-invalid caption blocks and empty output still fail; later valid imports are allowed',async()=>{
 let fixture=captionFixtureResult({onlyInvalid:true});const captions=service(async()=>fixture);
 await assert.rejects(captions.importCaption({url:captionFixtureURL}),/必须包含/);
 fixture={...fixture,bytes:Buffer.from('WEBVTT\n\nNOTE no spoken cues'),format:'vtt'};
 await assert.rejects(captions.importCaption({url:captionFixtureURL}),/必须包含/);
 fixture=captionFixtureResult({complete:true});assert.equal((await captions.importCaption({url:captionFixtureURL})).document.segments.length,2);
});
test('caption diagnostics retain every skipped block with bounded literal previews',async()=>{
 const fixture=captionFixtureResult({warningCount:105});
 fixture.bytes=Buffer.from(fixture.bytes.toString('utf8').replace('missing-1','x'.repeat(1000)).replace('Missing authored detail 1.','🌱'.repeat(1000)));
 const actual=await service(async()=>fixture).importCaption({url:captionFixtureURL});
 assert.equal(actual.diagnostics.length,106);assert.ok(actual.diagnostics.every(item=>item.preview.length<=240&&(!item.cueId||item.cueId.length<=120)));
 assert.equal(actual.document.segments.length,2);
});

import {startBridge} from '../desktop/server.mjs';
test('HTTP caption import carries authoritative loss diagnostics and rejects all-invalid output',async t=>{
 let fixture=captionFixtureResult(),calls=0;
 const server=await startBridge({port:0,captionService:service(async()=>{calls++;return fixture;}),providers:{status:async()=>{throw new Error('No provider probes');}}});
 t.after(()=>new Promise(resolve=>server.shutdown(resolve)));const origin=`http://127.0.0.1:${server.address().port}`;
 const send=()=>fetch(origin+'/api/captions/import',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({url:captionFixtureURL,language:'en'})});
 assert.equal((await (await fetch(origin+'/api/health')).json()).capabilities.caption_import,true);assert.equal(calls,0);
 const partial=await send();assert.equal(partial.status,200);const actual=await partial.json();assert.equal(actual.diagnostics.length,2);assert.equal(actual.document.segments.length,2);
 fixture=captionFixtureResult({onlyInvalid:true});const invalid=await send();assert.equal(invalid.status,400);assert.match((await invalid.json()).error,/必须包含/);
 fixture=captionFixtureResult({complete:true});const normal=await send();assert.equal(normal.status,200);assert.deepEqual((await normal.json()).diagnostics,[]);assert.equal(calls,3);
});

test('platform URL normalization preserves identity and rejects redirects, collections and unsupported parts',()=>{
 for(const input of ['https://youtu.be/BaW_jenozKc?t=4','https://m.youtube.com/shorts/BaW_jenozKc','https://youtube.com/watch?v=BaW_jenozKc&list=ignored'])assert.equal(captionSource(input).url,'https://www.youtube.com/watch?v=BaW_jenozKc');
 assert.equal(captionSource('https://m.bilibili.com/video/BV1xx411c7mD/?share=1').url,'https://www.bilibili.com/video/BV1xx411c7mD');
 for(const input of ['https://youtu.be/BaW_jenozKc/extra','https://youtube.com/watch?v=BaW_jenozKc&v=different00','https://youtube.com/playlist?list=PL1','https://b23.tv/short','https://www.bilibili.com/video/BV1xx411c7mD?p=2','https://www.bilibili.com/video/av123'])assert.throws(()=>captionSource(input));
});
test('platform readiness and media identity are independent',async()=>{
 const r=result();r.source={...r.source,url:'https://www.youtube.com/watch?v=BaW_jenozKc',id:'BaW_jenozKc',extractor:'youtube',live_status:'not_live'};
 const captions=createCaptionService({helper:{extractCaptions:async()=>r},enabledProviders:['youtube']});
 assert.equal(captions.available,true);assert.deepEqual(captions.providers,['youtube']);
 assert.equal((await captions.importCaption({url:r.source.url})).document.provenance.source_platform,'youtube');
 await assert.rejects(captions.importCaption({url}),/尚未启用/);
 r.source.id='different00';await assert.rejects(captions.importCaption({url:r.source.url}),/来源/);
});
test('network uncertainty stays distinct from missing or restricted captions',async()=>{
 const receipt=await service(async()=>({status:'network_unavailable'})).importCaption({url});
 assert.equal(receipt.status,'network_unavailable');assert.match(receipt.message,/网络/);assert.equal(receipt.document,undefined);
});


test('YouTube completion evidence is required while completed broadcasts stay importable',async()=>{
 const r=result();r.source={...r.source,url:'https://www.youtube.com/watch?v=BaW_jenozKc',id:'BaW_jenozKc',extractor:'youtube'};
 const captions=createCaptionService({helper:{extractCaptions:async()=>r},enabledProviders:['youtube']});
 await assert.rejects(captions.importCaption({url:r.source.url}),/已结束/);
 r.source.live_status='was_live';assert.equal((await captions.importCaption({url:r.source.url})).status,'ready');
 const incomplete=await service(async()=>({status:'metadata_incomplete'})).importCaption({url});
 assert.equal(incomplete.status,'metadata_incomplete');assert.equal(incomplete.document,undefined);
});
