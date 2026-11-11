/** Authored protocol tests, not live platform claims. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createVideoAudioService,VideoSourceError,videoSourceErrorDetails} from '../desktop/video-audio-service.mjs';
import {createIngestionService} from '../desktop/ingestion-service.mjs';
import {startBridge} from '../desktop/server.mjs';
const url='https://www.youtube.com/watch?v=abcdefghijk';
const bytes=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypM4A authored protocol fixture')]);
const sha256=createHash('sha256').update(bytes).digest('hex');
const valid=()=>({status:'media_ready',bytes,media:{type:'audio/mp4',kind:'audio',bytes:bytes.length,sha256},source:{url,id:'abcdefghijk',provider:'youtube',title:'A/B 原始标题',duration:4,subtitle_check:'no_matching_captions',audio_language:'en',audio_language_basis:'platform_original',audio_role:'original',format:'m4a',format_id:'140'}});
test('existing captions can explicitly load source audio without claiming caption absence or invoking ASR',async t=>{
 let called;const result=valid();result.source.subtitle_check='found';result.source.purpose='source';
 const service=createVideoAudioService({sourceMedia:true,helper:{extractAudio:async request=>{called=request;return result;}}});
 const server=await startBridge({port:0,videoAudioService:service});t.after(()=>server.shutdown());const origin='http://127.0.0.1:'+server.address().port;
 const response=await fetch(origin+'/api/videos/source-media',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({url,consent:true})});assert.equal(response.status,200);assert.equal(called.purpose,'source');
 const source=JSON.parse(Buffer.from(response.headers.get('X-Coconut-Media-Source'),'base64url'));assert.equal(source.subtitle_check,'found');assert.equal(source.purpose,'source');assert.equal((await response.arrayBuffer()).byteLength,bytes.length);
 await assert.rejects(service.download({url,consent:true}),/校验/);
 await assert.rejects(createVideoAudioService({helper:{extractAudio:()=>assert.fail('Old helper must not run')}}).download({url,consent:true},{purpose:'source'}),/不支持/);
});
test('only positively checked caption absence advertises the explicit media action',async()=>{
 for(const status of ['no_matching_captions','access_restricted','network_unavailable','language_required','metadata_incomplete','extractor_failed','caption_parse_failed','guard_stopped']){
  let calls=0;
  const service=createIngestionService({videoAudioProviders:['youtube'],captionService:{available:true,providers:['youtube'],importCaption:async()=>{calls++;return {status,message:'Authored result'};}},podcastSources:{discover:()=>assert.fail('No podcast fallback')}});
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
 assert.equal(result.source.subtitle_check,'no_matching_captions');assert.equal(result.source.format_id,'140');
});
test('helper process failures become finite source errors without the raw message',async()=>{
 const secret='https://secret.example/helper-timeout';
 const error=Error(secret);error.name='CaptionHelperError';error.code='CAPTION_TIMEOUT';
 await assert.rejects(createVideoAudioService({sourceMedia:true,helper:{extractAudio:async()=>{throw error;}}}).download({url,consent:true},{purpose:'source'}),failure=>{
  assert.ok(failure instanceof VideoSourceError);
  assert.equal(failure.code,'extractor_failed');
  assert.equal(failure.diagnostic.stage,'helper_execution');
  assert.equal(failure.diagnostic.reason,'helper_error');
  assert.doesNotMatch(failure.message,/secret/);
  return true;
 });
});
test('single-language youtube audio keeps the language without claiming it is original',async()=>{
 const result=valid();
 result.source.audio_language='en';result.source.audio_language_basis='single_language_track';result.source.audio_role='unknown';
 const downloaded=await createVideoAudioService({helper:{extractAudio:async()=>result}}).download({url,consent:true});
 assert.equal(downloaded.source.audio_language,'en');assert.equal(downloaded.source.audio_role,'unknown');
 result.source.audio_role='original';
 await assert.rejects(createVideoAudioService({helper:{extractAudio:async()=>result}}).download({url,consent:true}),/校验/);
});
test('unlabeled youtube audio is accepted without claiming an original language',async()=>{
 const result=valid();
 result.source.audio_language=null;result.source.audio_language_basis='unlabeled_single_source';result.source.audio_role='unknown';
 const downloaded=await createVideoAudioService({helper:{extractAudio:async()=>result}}).download({url,consent:true});
 assert.equal(downloaded.source.audio_language,null);assert.equal(downloaded.source.audio_role,'unknown');
});
test('audio receipt must match canonical source, bytes and bounded duration',async()=>{
 for(const mutate of [r=>r.source.id='different',r=>r.source.url='https://evil.example',r=>r.source.subtitle_check='failed',r=>r.source.audio_language_basis='guessed',r=>r.source.audio_language=null,r=>r.source.duration=Infinity,r=>r.media.sha256='a'.repeat(64),r=>r.media.bytes++,r=>r.media.type='video/mp4',r=>r.bytes=Buffer.from('not media')]){
  const result=valid();mutate(result);
  await assert.rejects(createVideoAudioService({helper:{extractAudio:async()=>result}}).download({url,consent:true}),/校验/);
 }
});
test('HTTP public audio requires same origin and explicit consent, exposes no CDN authority',async t=>{
 let calls=0;
 const service=createVideoAudioService({helper:{extractAudio:async()=>{calls++;return valid();}}});
 const server=await startBridge({port:0,videoAudioService:service});t.after(()=>server.shutdown());
 const origin='http://127.0.0.1:'+server.address().port;
 const post=(data,Origin=origin)=>fetch(origin+'/api/videos/media',{method:'POST',headers:{Origin,'Content-Type':'application/json'},body:JSON.stringify(data)});
 assert.equal((await post({url,consent:true},'https://external.example')).status,403);assert.equal(calls,0);
 assert.equal((await post({url})).status,400);assert.equal(calls,0);
 const response=await post({url,consent:true});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'audio/mp4');
 const meta=JSON.parse(Buffer.from(response.headers.get('X-Coconut-Media-Source'),'base64url').toString());
 assert.equal(meta.url,url);assert.equal(meta.provider,'youtube');assert.equal(meta.id,'abcdefghijk');
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);assert.equal(calls,1);
});

test('provider capabilities are explicit rather than a global promise',async()=>{
 const service=createIngestionService({videoAudioProviders:['bilibili'],captionService:{available:true,importCaption:async()=>({status:'no_matching_captions'})}});
 assert.equal((await service.ingest({protocolVersion:1,source:{kind:'url',url}})).ingestion.error.audio_fallback,undefined);
 let calls=0;const media=createVideoAudioService({enabledProviders:['bilibili'],helper:{extractAudio:async()=>{calls++;return valid();}}});
 await assert.rejects(media.download({url,consent:true}));assert.equal(calls,0);
});

test('media timeout reports bounded transfer evidence through HTTP',async t=>{
 const diagnostic={stage:'media_download',reason:'budget_exceeded',requests_attempted:7,responses_received:7};
 const helper={extractAudio:async()=>({status:'guard_stopped',diagnostic:{...diagnostic,url:'https://private.example/signed'}})};
 const server=await startBridge({port:0,videoAudioService:createVideoAudioService({helper})});t.after(()=>server.shutdown());
 const origin='http://127.0.0.1:'+server.address().port;
 const response=await fetch(origin+'/api/videos/media',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({url,consent:true})});
 assert.equal(response.status,409);const result=await response.json();
 assert.deepEqual(result.diagnostic,diagnostic);assert.match(result.error,/15 分钟/);
 assert.doesNotMatch(JSON.stringify(result),/private\.example/);
});
test('combined source MP4 stays video with bounded default or unknown language provenance',async()=>{
 for(const role of ['default','unknown']){
  const result=valid();Object.assign(result.media,{kind:'video',type:'video/mp4'});Object.assign(result.source,{format:'mp4',format_id:'18',audio_role:role,audio_language:role==='unknown'?null:'en',audio_language_basis:'platform_video_stream'});
  const response=await createVideoAudioService({helper:{extractAudio:async()=>result}}).download({url,consent:true});
  assert.equal(response.kind,'video');assert.equal(response.type,'video/mp4');assert.equal(response.filename,'public-source.mp4');assert.equal(response.source.audio_role,role);
  result.source.audio_language_basis='platform_original';await assert.rejects(createVideoAudioService({helper:{extractAudio:async()=>result}}).download({url,consent:true}),/校验/);
 }
});

test('only Bilibili subtitle-specific restriction offers a distinct source action',async()=>{
 const bilibili='https://www.bilibili.com/video/BV1xx411c7mD';
 for(const [target,reason,enabled,expected] of [[bilibili,'subtitle_login_required',true,true],[bilibili,'login_required',true,false],[bilibili,'http_access_denied',true,false],[url,'subtitle_login_required',true,false],[bilibili,'subtitle_login_required',false,false]]){
  const service=createIngestionService({videoSourceMedia:enabled,videoAudioProviders:['bilibili','youtube'],captionService:{available:true,importCaption:async()=>({status:'access_restricted',diagnostic:{reason},message:'Subtitles restricted'})}});
  const receipt=(await service.ingest({protocolVersion:1,source:{kind:'url',url:target}})).ingestion;
  assert.equal(receipt.error.code,'access_restricted');assert.equal(Boolean(receipt.error.audio_fallback),expected);
  if(expected)assert.equal(receipt.error.audio_fallback.purpose,'source');
 }
});

test('independent source action can truthfully report subtitles not requested',async()=>{
 const result=valid();result.source.purpose='source';result.source.subtitle_check='not_requested';
 const service=createVideoAudioService({sourceMedia:true,helper:{extractAudio:async()=>result}});
 assert.equal((await service.download({url,consent:true},{purpose:'source'})).source.subtitle_check,'not_requested');
 await assert.rejects(service.download({url,consent:true}),/校验/);
});
test('video failure construction accepts finite observations and cannot publish upstream text',async()=>{
 const secret='https://secret.example/signed?token=top-secret /private/owner/media.mp4';
 const diagnostic={stage:'metadata',reason:'login_required',requests_attempted:1,responses_received:1};
 const error=new VideoSourceError('access_restricted',{diagnostic:{...diagnostic,url:secret},message:secret,cause:secret});
 assert.equal(error.status,409);assert.match(error.message,/明确要求登录或认证/);assert.deepEqual(error.diagnostic,diagnostic);
 assert.deepEqual(videoSourceErrorDetails(error),{code:'access_restricted',diagnostic});
 assert.throws(()=>{error.message=secret;},TypeError);assert.doesNotMatch(JSON.stringify(error),/secret|private|signed/);
 assert.throws(()=>new VideoSourceError(secret),/未知的视频来源错误类型/);
 const service=createVideoAudioService({sourceMedia:true,helper:{extractAudio:async()=>({status:secret,message:secret,diagnostic:{...diagnostic,reason:secret},availability:{media:'available'}})}});
 await assert.rejects(service.download({url,consent:true},{purpose:'source'}),error=>{
  assert.ok(error instanceof VideoSourceError);assert.equal(error.code,'extractor_failed');
  assert.equal(error.diagnostic,undefined);assert.equal(error.availability,undefined);assert.doesNotMatch(error.message,/secret|private|signed/);return true;
 });
});
test('source media absence and service configuration errors make only supported claims',async()=>{
 const service=createVideoAudioService({sourceMedia:true,helper:{extractAudio:async()=>({status:'media_unavailable'})}});
 await assert.rejects(service.download({url,consent:true},{purpose:'source'}),error=>error instanceof VideoSourceError&&error.code==='media_unavailable'&&!/没有.*字幕/.test(error.message));
 await assert.rejects(service.download({url,consent:true}),/已确认没有匹配字幕/);
 await assert.rejects(createVideoAudioService().download({url,consent:true},{purpose:'source'}),error=>error instanceof VideoSourceError&&error.status===503&&error.code==='video_media_unavailable'&&/未配置/.test(error.message));
 await assert.rejects(createVideoAudioService({helper:{extractAudio:()=>assert.fail('Unconfigured source helper must not run')}}).download({url,consent:true},{purpose:'source'}),error=>error instanceof VideoSourceError&&error.status===503&&error.code==='video_source_unavailable');
 const token=new VideoSourceError('subtitle_token_required',{diagnostic:{stage:'metadata',reason:'subtitle_token_required',requests_attempted:2,responses_received:1}});
 assert.deepEqual(token.availability,{metadata:'unverified',captions:'token_required',media:'unknown'});assert.match(token.message,/媒体是否可取得尚未知/);
});
