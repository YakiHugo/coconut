#!/usr/bin/env node
/** Opt-in production HTTP acquisition, not an ASR or playback-quality claim. */
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
import {spawn, spawnSync} from 'node:child_process';
import {captionSource, captionDiagnostic, CAPTION_FAILURE_STATUSES, captionFailureAvailability} from '../desktop/caption-service.mjs';
import {createIngestionExecutor} from '../desktop/ingestion-executor.mjs';
import {startDevelopmentBridge} from '../desktop/dev.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const lock=JSON.parse(await readFile(new URL('../desktop/caption-helper-lock.json',import.meta.url),'utf8'));
const MAX_MEDIA_BYTES=200*1024*1024;
const failures=new Set([...CAPTION_FAILURE_STATUSES,'captions_available','media_unavailable','video_media_unavailable']);
const safeFailure=value=>failures.has(value)?value:'invalid_receipt';
export function acceptanceWorkerEnvironment(env=process.env){
 return {PATH:env.PATH||'',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',...(env.TMPDIR?{TMPDIR:env.TMPDIR}:{}),COCONUT_CAPTION_PYTHON:env.COCONUT_CAPTION_PYTHON};
}
const noSession=Object.freeze({cookies:async()=>null,status:async()=>({supported:false,connected:false,profiles:[]})});

/** Never echo credentials, unrelated query data, a redirect or an arbitrary host. */
export function sourceInput(url,language,downloadMedia=false){
 const source=captionSource(url);
 if(!['youtube','bilibili'].includes(source.provider)||
    (url!==source.url&&!(source.provider==='bilibili'&&url===source.url+'/'))||
    typeof language!=='string'||!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(language)||
    typeof downloadMedia!=='boolean')throw Error('Canonical public YouTube/Bilibili URL and explicit language required');
 return Object.freeze({...source,language,downloadMedia});
}

export function initialSourceReport(input){
 const sha=spawnSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8',timeout:2000}).stdout?.trim();
 const status=spawnSync('git',['status','--porcelain'],{cwd:ROOT,encoding:'utf8',timeout:2000});
 return {check:'production_source_acquisition',requested_scope:input.downloadMedia?'explicit_media_and_persistence':'captions_and_persistence',commit:/^[a-f0-9]{40}$/.test(sha||'')?sha:null,
  worktree_modified:status.status===0?Boolean(status.stdout?.trim()):null,
  time:new Date().toISOString(),source_url:input.url,provider:input.provider,media_id:input.mediaId,
  api_path:'/api/v1/ingestions',network_mode:'direct_public',platform_credentials:false,paid_calls:0,
  asr_attempted:false,model_downloaded:false,fixture:false,passed:false,setup_ready:false,
  extractor_expected:lock.ytDlpVersion,extractor_verified:null,elapsed_ms:0,
  metadata:{state:'not_attempted'},captions:{state:'not_attempted'},
  media:{state:input.downloadMedia?'not_attempted':'not_requested',requested:input.downloadMedia,
   downloaded:false,playback_verified:false},persist:{state:'not_attempted'},restart:{state:'not_attempted'}};
}

/** Receipt observations are finite/validated; never include raw errors or text. */
export function recordSourceReceipt(report,input,payload,httpStatus){
 if(httpStatus!==200){
  report.metadata={state:'unverified'};
  report.captions={state:'unverified',reason:'http_error',http_status:httpStatus};return null;
 }
 const receipt=payload?.protocolVersion===1?payload.ingestion:null;
 if(receipt?.source?.url!==input.url||receipt.source.provider!==input.provider||receipt.source.media_id!==input.mediaId){
  report.metadata={state:'unverified'};report.captions={state:'unverified',reason:'invalid_receipt'};return null;
 }
 if(receipt.state==='blocked'){
  const status=safeFailure(receipt.error?.code),diagnostic=captionDiagnostic(receipt.error?.diagnostic);
  report.metadata={state:status==='no_matching_captions'?'validated':'unverified'};
  const availability=captionFailureAvailability(status);if(availability)report.availability=availability;
  report.captions={state:status==='no_matching_captions'?'not_available':'blocked',status,...(diagnostic?{diagnostic}:{})};
  // Explicit owner media is a separate request, never an automatic fallback.
  // Only a subtitle-specific login gate may pass an access-restricted caption result.
  return status==='no_matching_captions'||input.provider==='bilibili'&&status==='access_restricted'&&diagnostic?.reason==='subtitle_login_required'?'/api/videos/source-media':null;
 }
 const doc=receipt?.transcript?.document,cues=doc?.segments,provenance=doc?.provenance;
 if(receipt?.state!=='ready'||doc?.source_url!==input.url||provenance?.source_platform!==input.provider||
    provenance.media_id!==input.mediaId||!['platform_provided','automatic'].includes(provenance.caption_method)||
    typeof doc.language!=='string'||doc.language.split('-')[0]!==input.language.split('-')[0]||
    !Number.isFinite(provenance.media_duration)||provenance.media_duration<=0||provenance.media_duration>21600||
    !Array.isArray(cues)||!cues.length||cues.length>20000||cues.some(c=>!Number.isFinite(c.start)||!Number.isFinite(c.end)||
     c.start<0||c.end<=c.start||c.end>provenance.media_duration+1||typeof c.text!=='string'||!c.text.trim())){
  report.metadata={state:'unverified'};report.captions={state:'unverified',reason:'invalid_receipt'};return null;
 }
 report.metadata={state:'validated',duration_seconds:provenance.media_duration};
 report.captions={state:'ready',language:doc.language,method:provenance.caption_method,review_status:'unreviewed',
  cue_count:cues.length,time_range:{start:Math.min(...cues.map(c=>c.start)),end:Math.max(...cues.map(c=>c.end))},
  cue_sha256:createHash('sha256').update(JSON.stringify(cues.map(c=>({start:c.start,end:c.end,text:c.text})))).digest('hex')};
 return '/api/videos/source-media';
}

export async function recordSourceMedia(report,input,response,route){
 if(!response.ok){
  const value=await response.json();const diagnostic=captionDiagnostic(value?.diagnostic);
  Object.assign(report.media,{state:'blocked',status:safeFailure(value?.code),http_status:response.status,...(diagnostic?{diagnostic}:{})});return;
 }
 const encoded=response.headers.get('X-Coconut-Media-Source')||'';
 if(!encoded||encoded.length>8192||!/^[A-Za-z0-9_-]+$/.test(encoded))throw Error('Invalid media metadata');
 const meta=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
 const size=Number(response.headers.get('Content-Length'));
 const shape=meta.type==='audio/mp4'&&meta.kind==='audio'&&meta.format==='m4a'||meta.type==='video/mp4'&&meta.kind==='video'&&meta.format==='mp4';
 if(meta.url!==input.url||meta.provider!==input.provider||meta.id!==input.mediaId||!shape||
    response.headers.get('Content-Type')!==meta.type||!Number.isSafeInteger(size)||size<12||size>MAX_MEDIA_BYTES||
    !Number.isFinite(meta.duration)||meta.duration<=0||meta.duration>21600||!/^[a-f0-9]{64}$/.test(meta.sha256||'')||
    (route==='/api/videos/source-media'?meta.purpose!=='source'||meta.subtitle_check!=='not_requested':meta.subtitle_check!=='no_matching_captions')){
  await response.body?.cancel();throw Error('Invalid media receipt');
 }
 let bytes=0,prefix=Buffer.alloc(0);const chunks=[];const digest=createHash('sha256'),reader=response.body?.getReader();
 if(!reader)throw Error('Missing media stream');
 try{
  while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;
   if(bytes>size||bytes>MAX_MEDIA_BYTES)throw Error('Media size exceeded');
   if(prefix.length<12)prefix=Buffer.concat([prefix,Buffer.from(value).subarray(0,12-prefix.length)]);
   digest.update(value);chunks.push(Buffer.from(value));
  }
  if(bytes!==size||prefix.subarray(4,8).toString()!=='ftyp'||digest.digest('hex')!==meta.sha256)throw Error('Media integrity failed');
 }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 Object.assign(report.media,{state:'ready',downloaded:true,bytes,type:meta.type,kind:meta.kind,
  duration_seconds:meta.duration,sha256:meta.sha256,subtitle_check:meta.subtitle_check});
 return {bytes:Buffer.concat(chunks),type:meta.type,kind:meta.kind,format:meta.format};
}

/** Persist only a verified source receipt and reopen it after a complete bridge restart.
 * No browser rendering/decoding claim. Dependency must be the production asset API.
 */
export async function persistSourceEvidence({report,input,document,media,request,restart,sourceIdentity}){
 const key='source-acceptance-'+randomUUID();
 const saved={...document,key};
 const json=async(route,init={})=>{const response=await request(route,init);if(!response.ok)throw Error('Persistence HTTP failure');return response.json();};
 report.persist={state:'attempted'};
 const library=await json('/api/v1/library');
 if(library.backend!=='sqlite'||library.enabled!==true)throw Error('Canonical SQLite unavailable');
 await json('/api/v1/library/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:1,epoch:library.epoch,action:'put',key,receiptKey:randomUUID(),expected:null,document:saved})});
 let asset,source;
 if(media){
  source=createHash('sha256').update(sourceIdentity(saved)).digest('hex');
  const result=await json('/api/v1/source-media?'+new URLSearchParams({key,source,name:'public-source.'+media.format}),{method:'POST',headers:{'Content-Type':media.type},body:media.bytes});
  asset=result.media;
  if(result.protocolVersion!==1||asset?.sha256!==report.media.sha256||asset.size!==media.bytes.length||asset.type!==media.type||asset.kind!==media.kind||!/^[a-f0-9]{64}$/.test(asset.binding||''))throw Error('Invalid durable asset receipt');
 }
 report.persist={state:'ready',backend:'sqlite',document_saved:true,media_saved:Boolean(media)};
 report.restart={state:'attempted'};
 await restart();
 const loaded=await json('/api/v1/library/document?'+new URLSearchParams({protocolVersion:'1',key}));
 if(JSON.stringify(loaded.record?.document)!==JSON.stringify(saved))throw Error('Document did not survive restart');
 if(media){
  const recovered=await json('/api/v1/source-media?'+new URLSearchParams({key,source}));
  if(JSON.stringify(recovered.media)!==JSON.stringify(asset))throw Error('Asset did not survive restart');
  const endpoint='/api/v1/source-media/content?'+new URLSearchParams({key,binding:asset.binding,sha256:asset.sha256});
  const full=await request(endpoint);if(full.status!==200||Number(full.headers.get('Content-Length'))!==asset.size)throw Error('Restored media response invalid');
  const hash=createHash('sha256');let size=0;for await(const chunk of full.body){size+=chunk.length;if(size>asset.size)throw Error('Restored media oversized');hash.update(chunk);}
  if(size!==asset.size||hash.digest('hex')!==asset.sha256)throw Error('Restored media hash mismatch');
  const range=await request(endpoint,{headers:{Range:'bytes=0-11'}});
  if(range.status!==206||range.headers.get('Content-Range')!==`bytes 0-11/${asset.size}`||!Buffer.from(await range.arrayBuffer()).equals(media.bytes.subarray(0,12)))throw Error('Restored media range invalid');
 }
 report.restart={state:'ready',document_reopened:true,media_hash_verified:Boolean(media),range_verified:Boolean(media),playback_verified:false};
}

export async function runSourceAcceptance({input,python,deadlineMs=input.downloadMedia?1050000:145000,
 startBridge=startDevelopmentBridge,fetchImpl=fetch,onReport=()=>{}}={}){
 const report=initialSourceReport(input),started=performance.now();let bridge,directory,phase='setup';
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),deadlineMs);
 const notify=()=>onReport(structuredClone(report));
 try{
  directory=await mkdtemp(path.join(tmpdir(),'coconut-source-acceptance-'));
  const options={captionPython:python,captionProxy:null,sourceNetwork:{mode:'direct'},podcastProxy:null,bilibiliSession:noSession,
   captionHelperDetached:false,port:0,libraryDirectory:path.join(directory,'library'),taskDirectory:path.join(directory,'tasks'),
   readingPython:null,punctuationModel:null,segmentationModel:null,embeddingModel:null,
   ingestionExecutor:createIngestionExecutor({url:null}),providers:{status(){throw Error('No model provider probing');}}};
  bridge=await startBridge(options);
  report.setup_ready=bridge.captions.available===true;
  report.extractor_verified=bridge.captionDiagnostic?.version===lock.ytDlpVersion?lock.ytDlpVersion:null;
  if(!report.setup_ready||!report.extractor_verified){report.captions={state:'unverified',reason:'setup_not_ready'};return report;}
  const request=(route,init={})=>fetchImpl(bridge.origin+route,{...init,headers:{Origin:bridge.origin,...init.headers},signal:controller.signal,redirect:'error'});
  const post=(route,body)=>request(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  phase='captions';report.metadata={state:'attempted'};report.captions={state:'attempted'};notify();
  const response=await post('/api/v1/ingestions',{protocolVersion:1,source:{kind:'url',url:input.url},language:input.language});
  const payload=await response.json(),route=recordSourceReceipt(report,input,payload,response.status);notify();
  let media=null;
  if(input.downloadMedia&&route){
   phase='media';
   if(bridge.captionDiagnostic?.sourceMedia!==true)Object.assign(report.media,{state:'unverified',reason:'source_media_not_available'});
   else{
    Object.assign(report.media,{state:'attempted',api_path:route});notify();
    media=await recordSourceMedia(report,input,await post(route,{url:input.url,language:input.language,consent:true}),route);
    if(media)report.metadata={state:'validated',duration_seconds:report.media.duration_seconds,basis:'independent_media_receipt'};
   }
   notify();
  }
  if(input.downloadMedia&&!media||!input.downloadMedia&&report.captions.state!=='ready')return report;
  const document=report.captions.state==='ready'?payload.ingestion.transcript.document:
   {schema_version:1,project_kind:'audio_only',transcript_status:'not_imported',title:'Source acceptance',language:input.language,source_url:input.url,media_duration:report.media.duration_seconds,segments:[]};
  phase='persist';
  // Load the actual shared ownership helper only when asset persistence is needed.
  const sourceIdentity=media?require('../shared/source-media.js').sourceMediaIdentity:null;
  await persistSourceEvidence({report,input,document,media,request,sourceIdentity,restart:async()=>{
   phase='restart';notify();await bridge.server.shutdown();bridge=null;bridge=await startBridge(options);
  }});
  report.passed=report.persist.state==='ready'&&report.restart.state==='ready';
 }catch{
  report.passed=false;report.error=controller.signal.aborted?'deadline':'execution_or_receipt_failed';report.failure_stage=phase;
  if(phase==='captions')report.metadata={state:'unverified'};
  if(['media','captions','persist','restart'].includes(phase))report[phase]={...report[phase],state:'unverified'};
 }finally{
  clearTimeout(timer);await bridge?.server.shutdown().catch(()=>{});
  if(directory)await rm(directory,{recursive:true,force:true});
  report.elapsed_ms=Math.round(performance.now()-started);notify();
 }
 return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);let input;
 try{
  if(!['--live','--worker'].includes(args[0])||![3,4].includes(args.length)||args.length===4&&args[3]!=='--media')throw Error('Usage');
  input=sourceInput(args[1],args[2],args[3]==='--media');
 }catch{process.stderr.write('Usage: COCONUT_CAPTION_PYTHON=/absolute/python node scripts/live_source_acceptance.mjs --live CANONICAL_VIDEO_URL LANGUAGE [--media]\n');process.exitCode=2;}
 if(input){
  if(args[0]==='--worker'&&process.send){
   const report=await runSourceAcceptance({input,python:process.env.COCONUT_CAPTION_PYTHON,onReport:value=>process.send({progress:true,report:value})});process.send({progress:false,report},()=>process.disconnect());
  }else if(args[0]==='--live'){
   let report=initialSourceReport(input),received=false,finished=false;const started=performance.now();
   const save=()=>writeFileSync('live-source-report.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});save();
   if(!['linux','darwin'].includes(process.platform)||!path.isAbsolute(process.env.COCONUT_CAPTION_PYTHON||'')){
    report.error='setup_not_ready';save();process.exitCode=1;
   }else{
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--worker',...args.slice(1)],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:acceptanceWorkerEnvironment()});
    const stop=()=>{if(Number.isSafeInteger(child.pid)&&child.pid>0){try{process.kill(-child.pid,'SIGKILL');}catch{}}};
    const interrupt=()=>{if(finished)return;finished=true;report.passed=false;report.error='interrupted';report.elapsed_ms=Math.round(performance.now()-started);save();stop();};
    process.once('SIGTERM',interrupt);process.once('SIGINT',interrupt);
    const timer=setTimeout(()=>{if(finished)return;finished=true;report.passed=false;report.error='deadline';report.elapsed_ms=Math.round(performance.now()-started);save();stop();},input.downloadMedia?1070000:150000);
    child.on('message',value=>{if(finished)return;report=value.report;received=!value.progress;save();});
    child.on('error',()=>{if(finished)return;finished=true;report.error='setup_not_ready';save();stop();});
    child.on('close',(code,signal)=>{clearTimeout(timer);stop();process.removeListener('SIGTERM',interrupt);process.removeListener('SIGINT',interrupt);
     if(code!==0||signal||!received&&!finished){report.passed=false;if(!finished)report.error='worker_failed';save();}process.stdout.write(JSON.stringify(report,null,2)+'\n');process.exitCode=code===0&&!signal&&received&&!finished&&report.passed?0:1;});
   }
  }else process.exitCode=2;
 }
}
