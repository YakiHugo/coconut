/** Authored protocol tests, not live platform claims. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createVideoAudioService} from '../desktop/video-audio-service.mjs';
import {createIngestionService} from '../desktop/ingestion-service.mjs';
import {startBridge} from '../desktop/server.mjs';
const url='https://www.youtube.com/watch?v=abcdefghijk';
const bytes=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypM4A authored protocol fixture')]);
const sha256=createHash('sha256').update(bytes).digest('hex');
const valid=()=>({status:'media_ready',bytes,media:{type:'audio/mp4',kind:'audio',bytes:bytes.length,sha256},source:{url,id:'abcdefghijk',provider:'youtube',title:'A/B 原始标题',duration:4,subtitle_check:'no_matching_captions',format:'m4a'}});
test('only positively checked caption absence advertises the explicit media action',async()=>{
 for(const status of ['no_matching_captions','access_restricted','network_unavailable','language_required','metadata_incomplete','extractor_failed','caption_parse_failed','guard_stopped']){
  let calls=0;
  const service=createIngestionService({videoAudioAvailable:true,captionService:{available:true,providers:['youtube'],importCaption:async()=>{calls++;return {status,message:'Authored result'};}},podcastSources:{discover:()=>assert.fail('No podcast fallback')}});
  const receipt=(await service.ingest({protocolVersion:1,source:{kind:'url',url}})).ingestion;
  assert.equal(calls,1);assert.equal(receipt.state,'blocked');
  assert.equal(Boolean(receipt.error.audio_fallback),status==='no_matching_captions');
 }
 const service=createIngestionService({captionService:{available:true,importCaption:async()=>({status:'no_matching_captions'})}});
 assert.equal((await service.ingest({protocolVersion:1,source:{kind:'url',url}})).ingestion.error.audio_fallback,undefined);
});
test('explicit audio action rechecks captions and preserves precise terminal failure',async()=>{
 for(const status of ['captions_available','media_unavailable','access_restricted','network_unavailable','language_required','caption_parse_failed','guard_stopped']){
  let calls=0;const service=createVideoAudioService({helper:{extractAudio:async()=>{calls++;return {status};}}});
  await assert.rejects(service.download({url,consent:true}),error=>error.code===status);
  assert.equal(calls,1);
 }
 let calls=0;const service=createVideoAudioService({helper:{extractAudio:async()=>{calls++;return valid();}}});
 await assert.rejects(service.download({url}));assert.equal(calls,0);
 const result=await service.download({url,consent:true});
 assert.deepEqual(result.body,bytes);assert.equal(result.source.url,url);assert.equal(result.source.sha256,sha256);
 assert.equal(result.source.subtitle_check,'no_matching_captions');assert.equal(result.source.format_id,undefined);
});
test('audio receipt must match canonical source, bytes and bounded duration',async()=>{
 for(const mutate of [r=>r.source.id='different',r=>r.source.url='https://evil.example',r=>r.source.subtitle_check='failed',r=>r.source.duration=Infinity,r=>r.media.sha256='a'.repeat(64),r=>r.media.bytes++,r=>r.media.type='video/mp4',r=>r.bytes=Buffer.from('not media')]){
  const result=valid();mutate(result);
  await assert.rejects(createVideoAudioService({helper:{extractAudio:async()=>result}}).download({url,consent:true}),/校验/);
 }
});
test('HTTP public audio requires same origin and explicit consent, exposes no CDN authority',async t=>{
 let calls=0;
 const service=createVideoAudioService({helper:{extractAudio:async()=>{calls++;return valid();}}});
 const server=await startBridge({port:0,videoAudioService:service});t.after(()=>server.shutdown());
 const origin='http://127.0.0.1:'+server.address().port;
 const post=(data,Origin=origin)=>fetch(origin+'/api/videos/audio',{method:'POST',headers:{Origin,'Content-Type':'application/json'},body:JSON.stringify(data)});
 assert.equal((await post({url,consent:true},'https://external.example')).status,403);assert.equal(calls,0);
 assert.equal((await post({url})).status,400);assert.equal(calls,0);
 const response=await post({url,consent:true});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'audio/mp4');
 const meta=JSON.parse(Buffer.from(response.headers.get('X-Coconut-Media-Source'),'base64url').toString());
 assert.equal(meta.url,url);assert.equal(meta.provider,'youtube');assert.equal(meta.id,'abcdefghijk');
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);assert.equal(calls,1);
});
