import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createDevelopmentCaptionHelper} from '../desktop/development-captions.mjs';
import {runSmoke,recordReceipt,initialReport,SAMPLE_ID} from '../scripts/live_caption_smoke.mjs';
const url=`https://www.youtube.com/watch?v=${SAMPLE_ID}`;
const secret='PRIVATE_CAPTION_SENTINEL';
const version={status:'ok',protocol:1,version:'2026.08.19',publicExtraction:true,guardProtocol:1,tlsRootsVerified:true,developmentProviders:['x','youtube','bilibili']};
const caption={status:'ok',source:{url,id:SAMPLE_ID,title:secret,extractor:'youtube',language:'en',automatic:false,translated:false,live:false,live_status:'not_live',duration:2},track:{language:'en',captionMethod:'platform_provided',languageBasis:'user_hint'},format:'vtt',captionBase64:Buffer.from(`WEBVTT\n\n00:00.000 --> 00:02.000\n${secret}\n`).toString('base64')};
async function helper(t,result,{delay=0,probe=version}={}){
 const dir=await mkdtemp(path.join(tmpdir(),'coconut-smoke-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const python=path.join(dir,'python'),log=path.join(dir,'calls');
 await writeFile(python,`#!${process.execPath}\nconst fs=require('node:fs');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{const input=JSON.parse(raw);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,input,args:process.argv.slice(2),env:process.env})+'\\n');setTimeout(()=>{process.stderr.write('PRIVATE_ERROR https://signed.invalid/?token=PRIVATE_TOKEN');process.stdout.write(JSON.stringify(input.operation==='version'?${JSON.stringify(probe)}:${JSON.stringify(result)}));},input.operation==='version'?0:${delay});});`,{mode:0o700});
 return {python,log};
}
function safe(report){assert.doesNotMatch(JSON.stringify(report),/PRIVATE_|signed.invalid|captionBase64|WEBVTT/);}
test('offline harness crosses real localhost API and isolated helper, validates Reader document',async t=>{
 const f=await helper(t,caption);const report=await runSmoke({python:f.python});
 assert.equal(report.outcome,'live_pass');assert.equal(report.setup_ready,true);assert.equal(report.cue_count,1);assert.equal(report.language,'en');assert.deepEqual(report.time_range,{start:0,end:2});assert.match(report.cue_sha256,/^[a-f0-9]{64}$/);safe(report);
 const calls=(await readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(calls.map(c=>c.input),[{operation:'version'},{operation:'extract-development',url,language:'en'}]);
 assert.deepEqual(calls[1].args.slice(0,3),['-I','-B','-c']);assert.equal(calls[1].env.HTTP_PROXY,undefined);assert.equal(calls[1].env.OPENAI_API_KEY,undefined);
});
test('blocked and unknown are not skip/pass and do not disclose helper diagnostics',async t=>{
 for(const status of ['access_restricted','network_unavailable','unavailable','metadata_incomplete']){
  const f=await helper(t,{status,error:secret});const report=await runSmoke({python:f.python});
  assert.equal(report.import_status,status);assert.equal(report.outcome,['access_restricted','network_unavailable'].includes(status)?'blocked':'unverified');assert.equal(report.cue_sha256,null);safe(report);
 }
});
test('malformed protocol is an implementation failure, missing setup never extracts',async t=>{
 const malformed=await helper(t,{...caption,captionBase64:'PRIVATE_INVALID'});const report=await runSmoke({python:malformed.python});assert.equal(report.outcome,'implementation_failure');safe(report);
 const missing=await helper(t,caption,{probe:{status:'dependencies_missing',missing:['yt_dlp']}});const absent=await runSmoke({python:missing.python});assert.equal(absent.setup_ready,false);assert.equal(absent.outcome,'unverified');assert.equal((await readFile(missing.log,'utf8')).trim().split('\n').length,1);
});
test('deadline aborts real API request and helper without exposing errors',async t=>{
 const f=await helper(t,caption,{delay:5000});const report=await runSmoke({python:f.python,deadlineMs:400});assert.equal(report.outcome,'unverified');assert.equal(report.reason,'deadline');assert.ok(report.elapsed_ms<3000);safe(report);
});
test('ready alone or malformed/empty document never constitutes live proof',()=>{
 for(const receipt of [{status:'ready'},{status:'ready',document:{segments:[]}},{status:secret}]){
  const report=initialReport();recordReceipt(report,receipt,200);assert.equal(report.outcome,'implementation_failure');safe(report);
 }
});
test('workflow is manual-only and artifact contains only the evidence file',async()=>{
 const workflow=await readFile(new URL('../.github/workflows/live-caption-smoke.yml',import.meta.url),'utf8');
 assert.match(workflow,/workflow_dispatch:/);assert.doesNotMatch(workflow,/pull_request:|push:|schedule:|secrets\./);assert.match(workflow,/contents: read/);assert.match(workflow,/retention-days: 3/);assert.match(workflow,/path: live-caption-report.json/);
});

test('CLI requires opt-in and preserves safe reports with truthful exit codes',async t=>{
 const cli=fileURLToPath(new URL('../scripts/live_caption_smoke.mjs',import.meta.url));
 for(const [result,expected] of [[caption,0],[{status:'unavailable'},1]]){
  const f=await helper(t,result);const cwd=path.dirname(f.python);
  const run=args=>new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[cli,...args],{cwd,env:{...process.env,COCONUT_CAPTION_PYTHON:f.python}});let output='';
   child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('close',code=>resolve({code,output}));
  });
  const noOptIn=await run([]);assert.equal(noOptIn.code,2);await assert.rejects(readFile(f.log),{code:'ENOENT'});
  const completed=await run(['--live']);assert.equal(completed.code,expected);assert.equal(completed.output,'');
  const report=JSON.parse(await readFile(path.join(cwd,'live-caption-report.json'),'utf8'));safe(report);assert.equal(report.outcome,expected===0?'live_pass':'unverified');
 }
});

test('supervised worker and real helper share the group killed at the hard deadline',async t=>{
 if(process.platform==='win32')return t.skip('POSIX-only live CLI');
 const f=await helper(t,caption,{delay:60000}),dir=path.dirname(f.python);
 const entry=path.join(dir,'worker.mjs');
 const module=new URL('../scripts/live_caption_smoke.mjs',import.meta.url).href;
 await writeFile(entry,`import {runSmoke} from ${JSON.stringify(module)}; await runSmoke({python:${JSON.stringify(f.python)}});`);
 const worker=spawn(process.execPath,[entry],{detached:true,stdio:'ignore'});
 const closed=new Promise(resolve=>worker.on('close',resolve));let helperPid;
 t.after(()=>{try{process.kill(-worker.pid,'SIGKILL');}catch{} if(helperPid){try{process.kill(helperPid,'SIGKILL');}catch{}}});
 for(let i=0;i<100;i++){
  const calls=await readFile(f.log,'utf8').catch(()=>'');
  const extraction=calls.trim().split('\n').filter(Boolean).map(JSON.parse).find(c=>c.input.operation==='extract-development');
  if(extraction){helperPid=extraction.pid;break;}
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 assert.ok(helperPid,'real helper must start before the simulated hard deadline');
 assert.equal(Number(spawnSync('ps',['-o','pgid=','-p',String(helperPid)],{encoding:'utf8'}).stdout.trim()),worker.pid);
 // This is the exact supervisor kill used at 150 seconds, accelerated offline.
 process.kill(-worker.pid,'SIGKILL');await closed;
 let active=true;
 for(let i=0;i<100;i++){
  const state=spawnSync('ps',['-o','stat=','-p',String(helperPid)],{encoding:'utf8'}).stdout.trim();
  active=!!state&&!state.startsWith('Z');if(!active)break;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 assert.equal(active,false,'no running orphan helper may outlive the worker group');
});
test('ready document with null cue is classified without throwing or exposing content',()=>{
 const report=initialReport();recordReceipt(report,{status:'ready',document:{source_url:url,language:'en',provenance:{source_platform:'youtube',media_id:SAMPLE_ID,caption_method:'platform_provided'},segments:[null]}},200);
 assert.equal(report.outcome,'implementation_failure');safe(report);
});

test('helper process-group opt-out requires an internal boolean',()=>{
 assert.throws(()=>createDevelopmentCaptionHelper({python:'/unused/python',detached:'false'}),error=>error.code==='CAPTION_CONFIGURATION');
});

test('actual CLI cleans its owned helper when only the worker crashes',async t=>{
 if(!['linux','darwin'].includes(process.platform))return t.skip('POSIX live CLI');
 const dir=await mkdtemp(path.join(tmpdir(),'coconut-smoke-crash-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const python=path.join(dir,'python'),pidFile=path.join(dir,'helper-pid');
 await writeFile(python,`#!${process.execPath}\nconst fs=require('node:fs');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{const input=JSON.parse(raw);if(input.operation==='version'){process.stdout.write(JSON.stringify(${JSON.stringify(version)}));return;}fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);process.kill(process.ppid,'SIGKILL');});`,{mode:0o700});
 const cli=fileURLToPath(new URL('../scripts/live_caption_smoke.mjs',import.meta.url));
 const child=spawn(process.execPath,[cli,'--live'],{cwd:dir,env:{...process.env,COCONUT_CAPTION_PYTHON:python},stdio:'ignore'});
 const exit=await new Promise(resolve=>child.on('close',resolve));assert.equal(exit,1);
 const pid=Number(await readFile(pidFile,'utf8'));t.after(()=>{try{process.kill(pid,'SIGKILL');}catch{}});
 let active=true;
 for(let i=0;i<100;i++){
  const state=spawnSync('ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}).stdout.trim();active=!!state&&!state.startsWith('Z');if(!active)break;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 assert.equal(active,false,'unexpected worker exit must not strand its helper');
 const report=JSON.parse(await readFile(path.join(dir,'live-caption-report.json'),'utf8'));assert.equal(report.outcome,'unverified');safe(report);
});

test('offline failure stages survive helper, API and smoke without making absence or access claims',async t=>{
 for(const [status,stage,reason,attempted,received,outcome] of [
  ['extractor_failed','extractor_setup','extractor_error',0,0,'unverified'],
  ['caption_parse_failed','caption_parse','caption_parse_failed',2,2,'unverified'],
  ['caption_file_invalid','caption_output','invalid_caption_file',2,2,'unverified'],
  ['guard_stopped','metadata','request_scope_stopped',0,0,'blocked'],
  ['no_matching_captions','track_selection','no_matching_track',1,1,'unverified'],
  ['access_restricted','metadata','access_restricted',1,1,'blocked'],
  ['extractor_failed','helper_execution','helper_error',null,null,'unverified'],
 ]){
  const diagnostic={stage,reason,requests_attempted:attempted,responses_received:received};
  const f=await helper(t,{status,diagnostic:{...diagnostic,error:secret,url:'https://signed.invalid/?token=PRIVATE_TOKEN'},error:secret});
  const report=await runSmoke({python:f.python});
  assert.equal(report.import_status,status);assert.equal(report.outcome,outcome);assert.equal(report.reason,reason);
  assert.deepEqual(report.diagnostic,diagnostic);assert.equal(report.cue_count,0);assert.equal(report.cue_sha256,null);safe(report);
  assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,2,'one version and one extraction, never retry');
 }
});
test('unknown or malformed diagnostic fields never reach the evidence report',()=>{
 for(const diagnostic of [
  {stage:secret,reason:'extractor_error',requests_attempted:0,responses_received:0},
  {stage:'metadata',reason:secret,requests_attempted:0,responses_received:0},
  {stage:'metadata',reason:'extractor_error',requests_attempted:1,responses_received:2},
  {stage:'metadata',reason:'extractor_error',requests_attempted:33,responses_received:1},
  {stage:'metadata',reason:'extractor_error',requests_attempted:null,responses_received:null},
 ]){
  const report=initialReport();recordReceipt(report,{status:'extractor_failed',diagnostic},200);
  assert.equal(report.diagnostic,undefined);assert.equal(report.reason,'extractor_failed');safe(report);
 }
});

test('HTTP reader parse failures retain their stage without exposing parser text',()=>{
 const report=initialReport();recordReceipt(report,{code:'CAPTION_PARSE_FAILED',error:secret},400);
 assert.equal(report.import_status,'http_error');assert.equal(report.reason,'caption_parse_failed');
 assert.equal(report.outcome,'unverified');assert.deepEqual(report.diagnostic,{stage:'reader_parse',reason:'caption_parse_failed',requests_attempted:null,responses_received:null});safe(report);
});
