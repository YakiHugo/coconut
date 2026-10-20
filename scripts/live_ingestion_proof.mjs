#!/usr/bin/env node
/** Opt-in real short public episode -> existing local ASR -> durable project.
 * Never substitutes fixture text, installs packages, downloads weights, or calls
 * a paid model. Prepare the optional executor explicitly before --live.
 * Media and full transcript stay in this temporary workspace, never CI artifacts.
 */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {build} from 'esbuild';
import {startDevelopmentBridge} from '../desktop/dev.mjs';
import {createIngestionExecutor} from '../desktop/ingestion-executor.mjs';

if(process.argv.length!==3||process.argv[2]!=='--live')throw Error('Explicit --live is required; prepares no dependencies or model.');
const python=process.env.COCONUT_ASR_PROOF_PYTHON;
if(!python||!path.isAbsolute(python))throw Error('Provide an explicit absolute COCONUT_ASR_PROOF_PYTHON.');
const sourceUrl='https://www.xiaoyuzhoufm.com/episode/65e7c944d602439838b530aa';
const require=createRequire(import.meta.url),core=require('../reader/core.js'),canonical=require('../reader/canonical-library.js');
const temporary=await mkdtemp(path.join(os.tmpdir(),'coconut-public-asr-'));
let child,bridge,controller,stage='start',result={check:'real_public_ingestion_asr',source_url:sourceUrl,passed:false,paid_calls:0,fixture_transcript:false,model_download:false};
try{
 const compiled=await build({stdin:{contents:"export * from './frontend/app/ingestion-media';export * from './frontend/app/ingestion-jobs';export * from './frontend/app/ingestion-binding';export * from './frontend/app/attach-transcript';export {inspectFile} from './frontend/app/ingestion';",resolveDir:process.cwd()},bundle:true,format:'esm',write:false,platform:'node'});
 const {downloadedMediaFile,transcriptionFileIssue,inspectFile,createIngestionJobs,ingestionBinding,rememberIngestionFile,attachTranscript}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].contents).toString('base64'));
 stage='local_executor_start';
 child=spawn(python,['serve.py','--port','0','--data-dir',path.join(temporary,'executor')],{stdio:['ignore','pipe','pipe'],env:{...process.env,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_IMPLICIT_TOKEN:'1'}});
 // Do not publish subprocess transcript text or private filesystem paths.
 child.stderr.resume();
 const pythonOrigin=await new Promise((resolve,reject)=>{
  let stdout='';const timer=setTimeout(()=>reject(Error('executor_start_timeout')),30000);
  child.once('error',()=>{clearTimeout(timer);reject(Error('executor_start_failed'));});
  child.once('exit',()=>{clearTimeout(timer);reject(Error('executor_exited'));});
  child.stdout.on('data',chunk=>{stdout=(stdout+chunk.toString()).slice(-4096);const match=/Coconut is ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);if(match){clearTimeout(timer);resolve(match[1]);}});
 });
 bridge=await startDevelopmentBridge({port:0,libraryDirectory:path.join(temporary,'library'),taskDirectory:path.join(temporary,'tasks'),captionPython:null,ingestionExecutor:createIngestionExecutor({url:pythonOrigin}),providers:{status(){throw Error('No external model provider may be probed');}}});
 const request=async(route,init={})=>{
  const response=await fetch(new URL(route,bridge.origin+'/'),{...init,headers:{Origin:bridge.origin,...init.headers},signal:AbortSignal.timeout(60000)});
  const body=await response.json();
  if(!response.ok)throw Object.assign(Error('api_request_failed'),{status:response.status,code:body.code});
  return body;
 };
 const post=(route,body)=>request(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 stage='discover_public_source';
 const discovery=(await post('/api/v1/ingestions',{protocolVersion:1,source:{kind:'url',url:sourceUrl}})).ingestion;
 assert.equal(discovery.state,'awaiting_selection');assert.equal(discovery.selection.episodes.length,1);
 const episode=discovery.selection.episodes[0];
 assert.ok(episode.duration>0&&episode.duration<=180);assert.equal(episode.transcripts.length,0);
 assert.ok(episode.media[0].length>0&&episode.media[0].length<=4*1024*1024);
 result.original_duration_seconds=episode.duration;
 stage='open_no_transcript_episode';
 const receipt=(await post('/api/v1/ingestions',{protocolVersion:1,source:{kind:'url',url:sourceUrl},episode:{feed_url:discovery.selection.feed_url,episode_id:episode.id}})).ingestion;
 assert.equal(receipt.state,'needs_transcription');assert.equal(receipt.transcript,null);assert.equal(receipt.transcription.available,true);
 assert.equal(receipt.media.download.endpoint,'/api/podcasts/media');
 result.publisher_transcript_count=0;
 stage='guarded_public_media_download';
 const response=await fetch(bridge.origin+receipt.media.download.endpoint,{method:'POST',headers:{Origin:bridge.origin,'Content-Type':'application/json'},body:JSON.stringify(receipt.media.download.body),signal:AbortSignal.timeout(60000)});
 assert.equal(response.status,200);
 const chunks=[];let size=0;
 for await(const chunk of response.body){size+=chunk.length;assert.ok(size<=4*1024*1024);chunks.push(chunk);}
 assert.ok(size>0);
 let file=downloadedMediaFile([Buffer.concat(chunks)],{name:receipt.media.name,kind:receipt.media.kind,contentType:response.headers.get('content-type')||''});
 assert.equal(transcriptionFileIssue(file),null);assert.equal(file.type,'audio/mp4');assert.ok(file.name.endsWith('.m4a'));
 const inspected=await inspectFile(file);rememberIngestionFile(file,inspected.source.fingerprint);
 result.media_bytes=size;result.media_type=file.type;result.filename_extension=path.extname(file.name);
 const original={key:'public-asr-proof',...receipt.project.document,project_note:'Authored proof note',timestamp_bookmarks:[{id:'proof',time:1,note:'Authored proof bookmark'}]};
 let document=original,revision=0,token=null,journal=null,accepted=false,uploads=0;
 const library=await request('/api/v1/library');assert.equal(library.enabled,true);
 async function save(value){
  const saved=await post('/api/v1/library/commit',{protocolVersion:1,epoch:library.epoch,action:'put',key:original.key,receiptKey:randomUUID(),expected:token,document:value});
  token=saved.token;return saved;
 }
 await save(original);
 const store={getDocument:()=>document,getFile:()=>file,getRevision:()=>revision};
 const dependencies={
  request:async(route,init)=>{if(route.startsWith('api/v1/ingestions/upload?'))uploads++;return request(route,init);},
  binding:(key,expected)=>ingestionBinding(store,key,expected),
  accept:async(transcript,binding)=>{
   assert.equal(binding.key,original.key);
   const next=attachTranscript(document,transcript,core,canonical.project);
   await save(next);document=next;revision++;accepted=true;return true;
  },
  journal:{read:()=>journal,write:value=>{journal=value;}},uuid:randomUUID,
 };
 controller=createIngestionJobs(dependencies);
 stage='offline_executor_capabilities';
 await controller.commands.capabilities();assert.equal(controller.getSnapshot().available,true);
 stage='explicit_media_upload';
 const inferenceStart=performance.now();
 await controller.commands.upload(original.key,file);
 let entry=controller.getSnapshot().entries[0];
 assert.ok(entry?.job&&!entry.unknown);assert.equal(uploads,1);
 const operation=entry.operation;
 // Reload the real frontend controller without retaining its File. The existing
 // job and remote-source binding must survive; this must not send another upload.
 controller.dispose();file=null;controller=createIngestionJobs(dependencies);
 stage='real_local_asr';
 const deadline=Date.now()+10*60*1000;
 while(Date.now()<deadline){
  await controller.commands.refresh(operation);entry=controller.getSnapshot().entries[0];
  if(entry?.job?.state==='ready')break;
  if(['failed','interrupted','cancelled'].includes(entry?.job?.state)){result.executor_state=entry.job.state;throw Error('asr_terminal_failure');}
  await delay(1000);
 }
 assert.equal(entry?.job?.state,'ready');
 result.inference_elapsed_seconds=Math.round((performance.now()-inferenceStart)/100)/10;
 stage='accept_into_original_project';
 await controller.commands.accept(operation);assert.equal(accepted,true);assert.equal(uploads,1);
 const reloaded=(await request('/api/v1/library/document?protocolVersion=1&key='+original.key)).record.document;
 assert.equal(reloaded.key,original.key);assert.equal(reloaded.source_url,original.source_url);assert.equal(reloaded.title,original.title);
 assert.deepEqual(reloaded.podcast_source,original.podcast_source);assert.equal(reloaded.project_note,original.project_note);assert.deepEqual(reloaded.timestamp_bookmarks,original.timestamp_bookmarks);
 assert.equal(reloaded.provenance.kind,'local_asr');assert.equal(reloaded.provenance.backend,'faster-whisper');assert.equal(reloaded.provenance.model,'small');assert.equal(reloaded.provenance.review_status,'unreviewed');
 assert.ok(reloaded.segments.length>0);
 let previous=0;
 for(const segment of reloaded.segments){assert.ok(Number.isFinite(segment.start)&&Number.isFinite(segment.end)&&segment.start>=previous&&segment.end>segment.start&&segment.end<=episode.duration+5);assert.ok(typeof segment.text==='string'&&segment.text.trim());previous=segment.start;}
 result={...result,passed:true,segment_count:reloaded.segments.length,first_start:reloaded.segments[0].start,last_end:reloaded.segments.at(-1).end,language:reloaded.language,transcript_sha256:createHash('sha256').update(JSON.stringify(reloaded.segments)).digest('hex'),model:reloaded.provenance.model,backend:reloaded.provenance.backend,model_revision:process.env.COCONUT_PROOF_MODEL_REVISION||null,preserved_source:true,preserved_notes:true,canonical_saved:true,reloaded_controller:true,uploads,review_status:'unreviewed'};
}catch(error){result={...result,stage,error_code:typeof error.code==='string'?error.code.slice(0,80):error.name||'proof_failed',...(Number.isInteger(error.status)?{http_status:error.status}:{})};process.exitCode=1;}
finally{
 controller?.dispose();
 if(bridge)await new Promise(resolve=>bridge.server.shutdown(resolve));
 if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(5000)]);if(child.exitCode===null)child.kill('SIGKILL');}
 await rm(temporary,{recursive:true,force:true});
 console.log(JSON.stringify(result,null,2));
}
