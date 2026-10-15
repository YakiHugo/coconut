#!/usr/bin/env node
/** Explicit single-sample public import; never prints source text or diagnostics. */
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {CAPTION_FAILURE_STATUSES,captionDiagnostic} from '../desktop/caption-service.mjs';
import {startDevelopmentBridge} from '../desktop/dev.mjs';

export const SAMPLE_ID='QRS8MkLhQmM';
const SAMPLE_URL=`https://www.youtube.com/watch?v=${SAMPLE_ID}`;
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const lock=JSON.parse(await readFile(new URL('../desktop/caption-helper-lock.json',import.meta.url),'utf8'));
const statuses=new Set(CAPTION_FAILURE_STATUSES);
export function initialReport(){
 const sha=spawnSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8',timeout:2000}).stdout?.trim();
 return {commit:/^[a-f0-9]{40}$/.test(sha||'')?sha:null,time:new Date().toISOString(),runner:process.env.GITHUB_ACTIONS==='true'?'github-actions':'local',provider:'youtube',sample_id:SAMPLE_ID,versions:{node:process.versions.node,extractor_expected:lock.ytDlpVersion,extractor_verified:null},setup_ready:false,import_status:'not_attempted',outcome:'unverified',reason:'unknown',elapsed_ms:0,language:null,method:null,cue_count:0,time_range:null,cue_sha256:null};
}
export function recordReceipt(report,receipt,httpStatus){
 if(httpStatus!==200){
  report.import_status='http_error';
  if(receipt?.code==='CAPTION_PARSE_FAILED'){report.reason='caption_parse_failed';report.outcome='unverified';report.diagnostic={stage:'reader_parse',reason:'caption_parse_failed',requests_attempted:null,responses_received:null};return;}
  // Only a broken helper protocol is unambiguously internal. Do not guess from prose.
  report.outcome=receipt?.code==='CAPTION_OUTPUT'?'implementation_failure':'unverified';
  report.reason=receipt?.code==='CAPTION_OUTPUT'?'invalid_helper_output':receipt?.code==='CAPTION_TIMEOUT'?'deadline':'unknown';
  return;
 }
 if(statuses.has(receipt?.status)){
  report.import_status=receipt.status;report.outcome=['access_restricted','network_unavailable','guard_stopped'].includes(receipt.status)?'blocked':'unverified';
  const diagnostic=captionDiagnostic(receipt.diagnostic);
  if(diagnostic)report.diagnostic=diagnostic;
  report.reason=diagnostic?.reason||(['access_restricted','network_unavailable','guard_stopped','no_matching_captions','extractor_failed','caption_file_invalid','caption_parse_failed'].includes(receipt.status)?receipt.status:'unknown');return;
 }
 const doc=receipt?.document,cues=doc?.segments;
 if(receipt?.status!=='ready'||doc?.source_url!==SAMPLE_URL||doc?.language!=='en'||doc?.provenance?.source_platform!=='youtube'||doc?.provenance?.media_id!==SAMPLE_ID||!['platform_provided','automatic'].includes(doc?.provenance?.caption_method)||!Array.isArray(cues)||!cues.length||cues.length>20000||cues.some(c=>!c||typeof c!=='object'||!Number.isFinite(c.start)||!Number.isFinite(c.end)||c.start<0||c.end<=c.start||typeof c.text!=='string'||!c.text.trim())){
  report.import_status='invalid_document';report.outcome='implementation_failure';report.reason='invalid_document';return;
 }
 const normalized=cues.map(c=>({start:c.start,end:c.end,text:c.text.normalize('NFC').replace(/\r\n?/g,'\n')}));
 report.import_status='ready';report.outcome='live_pass';report.reason=null;report.language=doc.language;report.method=doc.provenance.caption_method;report.cue_count=cues.length;
 report.time_range={start:Math.min(...cues.map(c=>c.start)),end:Math.max(...cues.map(c=>c.end))};
 report.cue_sha256=createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
export async function runSmoke({python,deadlineMs=145000}={}){
 const report=initialReport(),start=performance.now();let bridge,directory;
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),deadlineMs);
 try{
  directory=await mkdtemp(path.join(tmpdir(),'coconut-live-smoke-'));
  bridge=await startDevelopmentBridge({captionPython:python,captionHelperDetached:false,port:0,libraryDirectory:null,taskDirectory:path.join(directory,'tasks'),providers:{status(){throw new Error('Model provider probing is forbidden');}}});
  report.setup_ready=bridge.captions.available===true;
  if(!report.setup_ready){report.reason='setup_not_ready';return report;}
  report.versions.extractor_verified=bridge.captionDiagnostic?.version===lock.ytDlpVersion?lock.ytDlpVersion:null;
  report.import_status='attempted';
  const response=await fetch(bridge.origin+'/api/captions/import',{method:'POST',headers:{Origin:bridge.origin,'Content-Type':'application/json'},body:JSON.stringify({url:SAMPLE_URL,language:'en'}),signal:controller.signal});
  recordReceipt(report,await response.json(),response.status);
 }catch{
  report.outcome='unverified';report.reason=controller.signal.aborted?'deadline':'unknown';
 }finally{
  clearTimeout(timer);
  await bridge?.server.shutdown().catch(()=>{});
  if(directory)await rm(directory,{recursive:true,force:true});
  report.elapsed_ms=Math.round(performance.now()-start);
 }
 return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv[2]==='--worker'&&process.send){
  const report=await runSmoke({python:process.env.COCONUT_CAPTION_PYTHON});process.send(report,()=>process.disconnect());
 }else if(process.argv.length===3&&process.argv[2]==='--live'){
  // Parent remains responsive even if bridge shutdown fails. A detached process group
  // bounds the Python helper too. This CLI is supported on Linux/macOS only.
  const reportPath=path.join(process.cwd(),'live-caption-report.json');let report=initialReport();
  const save=()=>writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});save();
  if(!['linux','darwin'].includes(process.platform)||!path.isAbsolute(process.env.COCONUT_CAPTION_PYTHON||'')){
   report.reason='setup_not_ready';save();process.exitCode=1;
  }else{
   const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--worker'],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:process.env});
   const stopOwnedGroup=()=>{if(Number.isSafeInteger(child.pid)&&child.pid>0){try{process.kill(-child.pid,'SIGKILL');}catch{}}};
   let received=false;const started=performance.now();
   const timer=setTimeout(()=>{report.outcome='unverified';report.reason='deadline';report.elapsed_ms=Math.round(performance.now()-started);save();stopOwnedGroup();},150000);
   child.on('message',value=>{report=value;received=true;save();});
   child.on('error',()=>{stopOwnedGroup();report.reason='setup_not_ready';save();});
   child.on('close',()=>{clearTimeout(timer);stopOwnedGroup();if(!received)save();process.exitCode=received&&report.outcome==='live_pass'?0:1;});
  }
 }else{
  process.stderr.write('Usage: COCONUT_CAPTION_PYTHON=/absolute/venv/bin/python node scripts/live_caption_smoke.mjs --live\n');process.exitCode=2;
 }
}
