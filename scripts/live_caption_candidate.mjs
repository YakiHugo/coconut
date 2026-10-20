#!/usr/bin/env node
/** Explicit public caption candidate. Metadata-only evidence; no media/ASR fallback. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {captionSource} from '../desktop/caption-service.mjs';
import {startDevelopmentBridge} from '../desktop/dev.mjs';
if(process.argv.length!==5||process.argv[2]!=='--live')throw Error('Usage: node scripts/live_caption_candidate.mjs --live CANONICAL_PUBLIC_URL LANGUAGE');
const source=captionSource(process.argv[3]),language=process.argv[4],python=process.env.COCONUT_CAPTION_PYTHON;
if(!['youtube','bilibili'].includes(source.provider)||!path.isAbsolute(python||'')||!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(language))throw Error('Explicit isolated interpreter, public video source and language required.');
const directory=await mkdtemp(path.join(tmpdir(),'coconut-caption-candidate-'));
const report={check:'independent_public_caption_candidate',source_url:source.url,provider:source.provider,media_id:source.mediaId,time:new Date().toISOString(),passed:false,media_attempted:false,asr_attempted:false,fixture:false};
let bridge;
try{
 bridge=await startDevelopmentBridge({captionPython:python,captionProxy:null,captionHelperDetached:false,port:0,libraryDirectory:path.join(directory,'library'),taskDirectory:path.join(directory,'tasks'),providers:{status(){throw Error('No model provider calls');}}});
 report.setup_ready=bridge.captions.available===true;assert.equal(report.setup_ready,true);
 const request=async(route,body)=>{const response=await fetch(bridge.origin+route,{...(body?{method:'POST',headers:{Origin:bridge.origin,'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(145000)});assert.equal(response.status,200);return response.json();};
 const receipt=(await request('/api/v1/ingestions',{protocolVersion:1,source:{kind:'url',url:source.url},language})).ingestion;
 report.state=receipt.state;
 if(receipt.state!=='ready'){
  report.status=receipt.error?.code||'not_ready';report.diagnostic=receipt.error?.diagnostic||null;report.media_action_offered=Boolean(receipt.error?.audio_fallback);process.exitCode=1;
 }else{
  const document=receipt.transcript.document;assert.equal(document.source_url,source.url);assert.equal(document.provenance.source_platform,source.provider);assert.equal(document.provenance.media_id,source.mediaId);assert.ok(document.segments.length>0);
  for(const cue of document.segments)assert.ok(Number.isFinite(cue.start)&&Number.isFinite(cue.end)&&cue.start>=0&&cue.end>cue.start&&typeof cue.text==='string'&&cue.text.trim());
  const library=await request('/api/v1/library'),key='independent-public-caption';
  await request('/api/v1/library/commit',{protocolVersion:1,epoch:library.epoch,action:'put',key,receiptKey:randomUUID(),expected:null,document:{...document,key}});
  const saved=(await request('/api/v1/library/document?protocolVersion=1&key='+key)).record.document;
  assert.deepEqual(saved.segments,document.segments);assert.equal(saved.source_url,source.url);
  Object.assign(report,{passed:true,status:'ready',method:document.provenance.caption_method,language:document.language,cue_count:document.segments.length,first_start:document.segments[0].start,last_end:document.segments.at(-1).end,cue_sha256:createHash('sha256').update(JSON.stringify(document.segments)).digest('hex'),canonical_reload:true});
 }
}catch(error){report.error=error.name;process.exitCode=1;}
finally{await bridge?.server.shutdown();await rm(directory,{recursive:true,force:true});console.log(JSON.stringify(report,null,2));}
