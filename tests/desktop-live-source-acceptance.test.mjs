/** Authored transport receipts; never evidence that a live platform passed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {startBridge} from '../desktop/server.mjs';
import {createVideoAudioService} from '../desktop/video-audio-service.mjs';
import {acceptanceWorkerEnvironment,sourceInput,initialSourceReport,recordSourceReceipt,recordSourceMedia,persistSourceEvidence,runSourceAcceptance} from '../scripts/live_source_acceptance.mjs';

const url='https://www.bilibili.com/video/BV1XNtJ6UEmm';
const source={kind:'url',url,provider:'bilibili',media_id:'BV1XNtJ6UEmm'};
const document=()=>({schema_version:1,title:'Authored title',source_url:url,language:'zh',segments:[{id:'1',start:0,end:1,text:'私有测试正文'}],
 provenance:{kind:'platform_subtitles',caption_method:'platform_provided',review_status:'unreviewed',source_platform:'bilibili',media_id:source.media_id,media_duration:4}});
const ready=()=>({protocolVersion:1,ingestion:{state:'ready',source,transcript:{document:document()}}});
const negative=status=>({protocolVersion:1,ingestion:{state:'blocked',source,error:{code:status,
 diagnostic:{stage:'metadata',reason:status==='no_matching_captions'?'no_matching_track':'http_access_denied',requests_attempted:1,responses_received:1},
 ...(status==='no_matching_captions'?{audio_fallback:{endpoint:'/api/videos/source-media',url,language:'zh'}}:{})}}});
const bytes=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypM4A authored fixture')]);
const sha256=createHash('sha256').update(bytes).digest('hex');
const mediaResult=()=>({status:'media_ready',bytes,media:{type:'audio/mp4',kind:'audio',bytes:bytes.length,sha256},
 source:{url,id:source.media_id,provider:'bilibili',title:'Private title',duration:4,subtitle_check:'not_requested',purpose:'source',
 audio_language:null,audio_language_basis:'provider_single_source',audio_role:'unknown',format:'m4a',format_id:'30280'}});
const mediaResponse=(mutate=()=>{},body=bytes)=>{
 const value={...mediaResult().source,kind:'audio',type:'audio/mp4',sha256};mutate(value);
 return new Response(body,{headers:{'Content-Type':'audio/mp4','Content-Length':String(bytes.length),'X-Coconut-Media-Source':Buffer.from(JSON.stringify(value)).toString('base64url')}});
};

test('strict source input accepts the shared trailing slash but refuses credentials, query selectors and other hosts',()=>{
 assert.equal(sourceInput(url+'/','zh').url,url);
 assert.equal(sourceInput('https://www.youtube.com/watch?v=BaW_jenozKc','en',true).provider,'youtube');
 for(const input of [url+'?p=2',url+'?token=secret',url+'?p=1',url+'/#secret',url.replace('https://','http://'),
  url.replace('www.bilibili.com','www.bilibili.com.evil.test'),'https://127.0.0.1/video/BV1XNtJ6UEmm',
  'https://user:password@www.bilibili.com/video/BV1XNtJ6UEmm','https://x.com/user/status/123'])assert.throws(()=>sourceInput(input,'zh'));
 for(const language of ['zh;echo secret','$(echo secret)','',null])assert.throws(()=>sourceInput(url,language));
 assert.throws(()=>sourceInput(url,'zh','true'));
 const child=spawnSync(process.execPath,['scripts/live_source_acceptance.mjs','--live',url+'?token=secret','zh'],{encoding:'utf8'});
 assert.equal(child.status,2);assert.doesNotMatch(child.stdout+child.stderr,/token=secret/);
});

test('source reports retain counts and provenance, never transcript text or raw diagnostics',()=>{
 const input=sourceInput(url,'zh'),report=initialSourceReport(input);
 assert.equal(recordSourceReceipt(report,input,ready(),200),'/api/videos/source-media');
 assert.equal(report.metadata.state,'validated');assert.equal(report.captions.state,'ready');assert.equal(report.captions.cue_count,1);
 assert.match(report.captions.cue_sha256,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(report),/私有测试正文|Authored title/);
 const blocked=negative('network_unavailable');blocked.ingestion.error.message='https://cdn.example/?sig=secret';blocked.ingestion.error.diagnostic.secret='secret';
 recordSourceReceipt(report,input,blocked,200);assert.equal(report.captions.state,'blocked');assert.doesNotMatch(JSON.stringify(report),/secret|cdn\.example/);
});

test('explicit media is separate from captions, while generic access denial is never retried',()=>{
 const input=sourceInput(url,'zh',true);
 for(const status of ['unavailable','network_unavailable','language_required','metadata_incomplete','extractor_failed','caption_file_invalid','caption_parse_failed','guard_stopped','captions_available','media_unavailable','video_media_unavailable','unexpected']){
  const report=initialSourceReport(input);assert.equal(recordSourceReceipt(report,input,negative(status),200),null,status);assert.notEqual(report.captions.state,'ready');
 }
 assert.equal(recordSourceReceipt(initialSourceReport(input),input,negative('no_matching_captions'),200),'/api/videos/source-media');
 const login=negative('access_restricted');login.ingestion.error.diagnostic.reason='subtitle_login_required';
 const report=initialSourceReport(input);assert.equal(recordSourceReceipt(report,input,login,200),'/api/videos/source-media');assert.equal(report.captions.status,'access_restricted');
 for(const reason of ['login_required','http_access_denied','access_restricted','rate_limited']){const blocked=negative('access_restricted');blocked.ingestion.error.diagnostic.reason=reason;assert.equal(recordSourceReceipt(initialSourceReport(input),input,blocked,200),null,reason);}
 const yt=sourceInput('https://www.youtube.com/watch?v=S6l3aRsecuE','en',true),ytLogin=structuredClone(login);ytLogin.ingestion.source={kind:'url',url:yt.url,provider:yt.provider,media_id:yt.mediaId};assert.equal(recordSourceReceipt(initialSourceReport(yt),yt,ytLogin,200),null,'subtitle_login_required exception is Bilibili-only');
 for(const change of [r=>r.ingestion.source={...source,media_id:'wrong'},r=>r.ingestion.transcript.document.source_url='https://evil.test',r=>r.ingestion.transcript.document.language='en',r=>r.ingestion.transcript.document.segments=[],r=>r.ingestion.transcript.document.segments[0].end=0,r=>r.ingestion.transcript.document.provenance.caption_method='translated']){
  const payload=ready();change(payload);assert.equal(recordSourceReceipt(initialSourceReport(input),input,payload,200),null);
 }
});

test('media receipt requires full bytes and hash without claiming decoding or saving media',async()=>{
 const input=sourceInput(url,'zh',true),report=initialSourceReport(input);
 await recordSourceMedia(report,input,mediaResponse(),'/api/videos/source-media');
 assert.equal(report.media.downloaded,true);assert.equal(report.media.playback_verified,false);assert.equal(report.media.bytes,bytes.length);
 assert.doesNotMatch(JSON.stringify(report),/Private title|authored fixture/);
 for(const change of [m=>m.id='wrong',m=>m.sha256='a'.repeat(64),m=>m.url='https://cdn.example/?sig=secret',m=>m.duration=Infinity,m=>m.subtitle_check='found']){
  await assert.rejects(recordSourceMedia(initialSourceReport(input),input,mediaResponse(change),'/api/videos/source-media'));
 }
 await assert.rejects(recordSourceMedia(initialSourceReport(input),input,mediaResponse(()=>{},bytes.subarray(0,-1)),'/api/videos/source-media'));
 const existing=mediaResponse(m=>{m.purpose='source';m.subtitle_check='not_requested';});
 await recordSourceMedia(initialSourceReport(input),input,existing,'/api/videos/source-media');
});

async function fixtureBridge(status,{media=false,seen=[]}={}){
 return async options=>{
  assert.equal(options.captionProxy,null);assert.equal(options.podcastProxy,null);assert.equal(options.readingPython,null);
  assert.ok(options.libraryDirectory);assert.deepEqual(options.sourceNetwork,{mode:'direct'});assert.equal(await options.bilibiliSession.cookies(),null);
  assert.equal((await options.ingestionExecutor.status()).available,false);
  const helper={extractAudio:async request=>{seen.push(request);const value=mediaResult();if(request.purpose==='source'){value.source.purpose='source';value.source.subtitle_check='not_requested';}return value;}};
  const server=await startBridge({...options,captionService:{available:true,providers:['bilibili'],importCaption:async()=>status==='ready'?{status,document:document()}:{status,diagnostic:negative(status).ingestion.error.diagnostic}},
   videoAudioService:media?createVideoAudioService({helper,sourceMedia:true}):null});
  return {server,origin:'http://127.0.0.1:'+server.address().port,captions:{available:true},captionDiagnostic:{version:'2026.08.19',sourceMedia:media}};
 };
}

test('real same-origin HTTP reports caption success and never automatically downloads media or calls a model',async()=>{
 const seen=[];const report=await runSourceAcceptance({input:sourceInput(url,'zh'),startBridge:await fixtureBridge('ready',{media:true,seen})});
 assert.equal(report.passed,true);assert.equal(report.captions.state,'ready');assert.equal(report.media.state,'not_requested');assert.equal(seen.length,0);
 assert.equal(report.asr_attempted,false);assert.equal(report.model_downloaded,false);assert.equal(report.platform_credentials,false);
});

test('media access failure is attempted exactly once with no alternate route or persistence',async()=>{
 const input=sourceInput(url,'zh',true);let calls=0;
 const start=await fixtureBridge('no_matching_captions',{media:true});
 const report=await runSourceAcceptance({input,startBridge:start,fetchImpl:async(url,init)=>{
  if(new URL(url).pathname==='/api/videos/source-media'){calls++;return new Response(JSON.stringify({code:'access_restricted',diagnostic:{stage:'media_download',reason:'http_access_denied',requests_attempted:1,responses_received:1}}),{status:409});}
  return fetch(url,init);
 }});
 assert.equal(calls,1);assert.equal(report.passed,false);assert.equal(report.captions.state,'not_available');assert.equal(report.media.state,'blocked');assert.equal(report.persist.state,'not_attempted');
});

test('setup and transport failures cannot pass or expose raw local errors',async()=>{
 let requested=0;const report=await runSourceAcceptance({input:sourceInput(url,'zh'),startBridge:async()=>({captions:{available:false},server:{shutdown:async()=>{}}}),fetchImpl:()=>{requested++;}});
 assert.equal(report.passed,false);assert.equal(requested,0);assert.equal(report.captions.reason,'setup_not_ready');
 const failed=await runSourceAcceptance({input:sourceInput(url,'zh'),startBridge:async()=>{throw Error('Cookie: secret https://cdn.example/?sig=secret');}});
 assert.equal(failed.passed,false);assert.equal(failed.error,'execution_or_receipt_failed');assert.doesNotMatch(JSON.stringify(failed),/secret|cdn\.example/);
});


test('persistence helper verifies committed document, full bytes and ranges after restart',async()=>{
 const input=sourceInput(url,'zh',true),report=initialSourceReport(input);Object.assign(report.media,{sha256});
 let stored,asset,restarted=false;const routes=[];
 const request=async(route,init={})=>{
  const parsed=new URL(route,'http://127.0.0.1');routes.push(parsed.pathname);
  if(parsed.pathname==='/api/v1/library')return Response.json({enabled:true,backend:'sqlite',epoch:'epoch'});
  if(parsed.pathname==='/api/v1/library/commit'){stored=JSON.parse(init.body).document;return Response.json({token:{}});}
  if(parsed.pathname==='/api/v1/source-media'&&init.method==='POST'){asset={binding:'a'.repeat(64),sha256,size:bytes.length,type:'audio/mp4',kind:'audio'};return Response.json({protocolVersion:1,media:asset});}
  assert.equal(restarted,true);
  if(parsed.pathname==='/api/v1/library/document')return Response.json({record:{document:stored}});
  if(parsed.pathname==='/api/v1/source-media')return Response.json({protocolVersion:1,media:asset});
  if(init.headers?.Range)return new Response(bytes.subarray(0,12),{status:206,headers:{'Content-Range':`bytes 0-11/${bytes.length}`}});
  return new Response(bytes,{headers:{'Content-Length':String(bytes.length)}});
 };
 await persistSourceEvidence({report,input,document:document(),media:{bytes,type:'audio/mp4',kind:'audio',format:'m4a'},request,restart:async()=>{restarted=true;},sourceIdentity:JSON.stringify});
 assert.equal(report.persist.state,'ready');assert.equal(report.restart.state,'ready');assert.equal(report.restart.playback_verified,false);assert.equal(report.restart.range_verified,true);
 assert.equal(routes.filter(p=>p==='/api/v1/source-media/content').length,2);
});

test('missing asset API and restart failures cannot report a persistence pass',async()=>{
 for(const at of ['asset','restart']){
  const input=sourceInput(url,'zh',true),report=initialSourceReport(input);Object.assign(report.media,{sha256});
  const request=async(route)=>route==='/api/v1/library'?Response.json({enabled:true,backend:'sqlite',epoch:'e'}):route==='/api/v1/library/commit'?Response.json({}):at==='asset'?new Response('{}',{status:503}):Response.json({protocolVersion:1,media:{binding:'a'.repeat(64),sha256,size:bytes.length,type:'audio/mp4',kind:'audio'}});
  await assert.rejects(persistSourceEvidence({report,input,document:document(),media:{bytes,type:'audio/mp4',kind:'audio',format:'m4a'},request,restart:async()=>{throw Error('restart failed');},sourceIdentity:JSON.stringify}));
  assert.equal(report.passed,false);assert.notEqual(report.restart.state,'ready');
 }
});


test('live worker strips ambient proxies, sessions and model execution settings',()=>{
 const env=acceptanceWorkerEnvironment({PATH:'/usr/bin',COCONUT_CAPTION_PYTHON:'/isolated/python',TMPDIR:'/tmp',COCONUT_READING_PYTHON:'/model/python',COCONUT_ASR_EXECUTOR_URL:'http://127.0.0.1:9999',HTTP_PROXY:'http://proxy',HF_TOKEN:'private',COCONUT_SOURCE_NETWORK:'environment'});
 assert.deepEqual(env,{PATH:'/usr/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TMPDIR:'/tmp',COCONUT_CAPTION_PYTHON:'/isolated/python'});
});

test('workflow is opt-in, hash-pinned, quoted and records two independent PR sources',async()=>{
 const workflow=await readFile(new URL('../.github/workflows/source-acceptance.yml',import.meta.url),'utf8');
 assert.match(workflow,/types: \[labeled\]/);assert.match(workflow,/live-source-check/);
 assert.match(workflow,/live-source-bilibili/);assert.match(workflow,/ref: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/);
 assert.match(workflow,/RUNNER_TEMP\/coconut-source-python/);
 assert.match(workflow,/BV1XNtJ6UEmm/);assert.match(workflow,/sJ4VJWycX9M/);assert.doesNotMatch(workflow,/S6l3aRsecuE/);
 assert.match(workflow,/live-source-youtube/);
 assert.match(workflow,/persist-credentials: false/);assert.match(workflow,/--require-hashes/);
 assert.match(workflow,/fail-fast: false/);assert.match(workflow,/if: always\(\)/);
 assert.match(workflow,/args=\(--live "\$SOURCE_URL" "\$SOURCE_LANGUAGE"\)/);
 assert.doesNotMatch(workflow,/pull_request_target|secrets\.|continue-on-error|git push/);
});


test('subtitle-only login failure remains visible when explicit owner media is attempted',async()=>{
 const input=sourceInput(url,'zh',true);let mediaRequests=0;
 const start=await fixtureBridge('access_restricted',{media:true});
 const report=await runSourceAcceptance({input,startBridge:start,fetchImpl:async(url,init)=>{
  const route=new URL(url).pathname;
  if(route==='/api/v1/ingestions'){const payload=negative('access_restricted');payload.ingestion.error.diagnostic.reason='subtitle_login_required';return Response.json(payload);}
  if(route==='/api/videos/source-media'){mediaRequests++;assert.equal(JSON.parse(init.body).consent,true);return Response.json({code:'media_unavailable'},{status:409});}
  throw Error('Unexpected persistence or alternate request');
 }});
 assert.equal(mediaRequests,1);assert.equal(report.captions.status,'access_restricted');assert.equal(report.captions.diagnostic.reason,'subtitle_login_required');assert.equal(report.media.status,'media_unavailable');assert.equal(report.passed,false);
});


test('every unknown or blocked caption failure stops before an explicit media request',async()=>{
 for(const status of ['unavailable','network_unavailable','language_required','metadata_incomplete','extractor_failed','caption_file_invalid','caption_parse_failed','guard_stopped','access_restricted']){
  let calls=0;const input=sourceInput(url,'zh',true),start=await fixtureBridge(status,{media:true});
  const report=await runSourceAcceptance({input,startBridge:start,fetchImpl:async(url,init)=>{calls++;assert.equal(new URL(url).pathname,'/api/v1/ingestions');return fetch(url,init);}});
  assert.equal(calls,1,status);assert.equal(report.passed,false,status);assert.equal(report.media.state,'not_attempted',status);assert.equal(report.persist.state,'not_attempted',status);
 }
});

test('authored production HTTP media survives actual SQLite and asset-store restart',async()=>{
 const seen=[];const report=await runSourceAcceptance({input:sourceInput(url,'zh',true),startBridge:await fixtureBridge('no_matching_captions',{media:true,seen})});
 assert.equal(report.passed,true,JSON.stringify(report));assert.equal(report.media.state,'ready');
 assert.equal(report.persist.media_saved,true);assert.equal(report.restart.media_hash_verified,true);assert.equal(report.restart.range_verified,true);
 assert.equal(report.restart.playback_verified,false);assert.equal(seen.length,1);assert.equal(seen[0].purpose,'source');
});
