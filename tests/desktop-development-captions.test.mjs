import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readdir,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDevelopmentCaptionHelper} from '../desktop/development-captions.mjs';
import {startDevelopmentBridge} from '../desktop/dev.mjs';
import {diagnoseDevelopment,formatDoctorReport} from '../desktop/doctor.mjs';
const url='https://x.com/example/status/123456';
const version={status:'ok',protocol:1,version:'2026.08.19',publicExtraction:true,guardProtocol:1,tlsRootsVerified:true};
const caption={status:'ok',source:{url,id:'123456',title:'Authored protocol fixture',extractor:'twitter',language:'en',automatic:false,translated:false,live:false,duration:2},track:{language:'en',captionMethod:'platform_provided',languageBasis:'single_track'},format:'vtt',captionBase64:Buffer.from('WEBVTT\n\n00:00.000 --> 00:02.000\nAn authored original sentence.\n').toString('base64')};
async function fixture(t,{probe=version,result=caption,delay=0}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'coconut-dev-caption-test-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const executable=path.join(directory,'authored-python'),log=path.join(directory,'requests.jsonl');
 await writeFile(executable,`#!${process.execPath}\nconst fs=require('node:fs');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{const input=JSON.parse(raw);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({input,args:process.argv.slice(2),env:process.env,cwd:process.cwd()})+'\\n');const result=input.operation==='version'?${JSON.stringify(probe)}:${JSON.stringify(result)};setTimeout(()=>process.stdout.write(JSON.stringify(result)),input.operation==='version'?0:${delay});});`,{mode:0o700});
 return {directory,executable,log};
}
test('explicit developer adapter runs real isolated process from URL through HTTP to validated document',async t=>{
 const f=await fixture(t);let server;
 t.after(async()=>{if(server)await server.shutdown();});
 const started=await startDevelopmentBridge({port:0,taskDirectory:path.join(f.directory,'tasks'),captionPython:f.executable,providers:{status(){throw Error('Unexpected provider probe');}}});server=started.server;
 assert.equal(started.captions.available,true);assert.deepEqual(started.captions.providers.filter(p=>p.available).map(p=>p.id),['x']);
 assert.equal(started.captions.automatic_asr,false);
 assert.equal((await fetch(started.origin+'/api/captions/status',{headers:{Origin:'https://example.com'}})).status,403);
 const send=value=>fetch(started.origin+'/api/captions/import',{method:'POST',headers:{Origin:started.origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
 assert.equal((await send({url:'https://www.youtube.com/watch?v=abc'})).status,400);
 const response=await send({url,language:'en'});assert.equal(response.status,200);const result=await response.json();
 assert.equal(result.status,'ready');assert.equal(result.document.segments[0].text,'An authored original sentence.');assert.equal(result.document.source_url,url);assert.equal(result.document.provenance.caption_method,'platform_provided');
 const calls=(await readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(calls.map(c=>c.input.operation),['version','extract']);assert.deepEqual(calls[1].input,{operation:'extract',url,language:'en'});
 for(const call of calls){assert.deepEqual(call.args.slice(0,3),['-I','-B','-c']);assert.equal(call.env.PYTHONPATH,undefined);assert.equal(call.env.HTTP_PROXY,undefined);assert.equal(call.env.OPENAI_API_KEY,undefined);assert.notEqual(call.env.HOME,process.env.HOME);await assert.rejects(stat(call.cwd),{code:'ENOENT'});}
 const report=await diagnoseDevelopment({port:server.address().port});assert.equal(report.captions.available,true);assert.match(formatDoctorReport(report),/公开 X/);
});
test('missing or mismatched Python fails closed with actionable status and no source extraction',async t=>{
 for(const probe of [{...version,version:'wrong'},{...version,tlsRootsVerified:false}]){
  const f=await fixture(t,{probe});const {server,origin,captions}=await startDevelopmentBridge({port:0,taskDirectory:path.join(f.directory,'tasks'),captionPython:f.executable});
  try{assert.equal(captions.available,false);assert.equal(captions.code,'CAPTION_VERSION');assert.match(captions.message,/COCONUT_CAPTION_PYTHON/);const doctor=formatDoctorReport(await diagnoseDevelopment({port:server.address().port}));assert.match(doctor,/yt-dlp==2026.8.19/);assert.match(doctor,/COCONUT_CAPTION_PYTHON=.*npm run dev/);assert.equal((await fetch(origin+'/api/health').then(r=>r.json())).capabilities.caption_import,false);assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);}finally{await server.shutdown();}
 }
 const f=await fixture(t);const {server,captions}=await startDevelopmentBridge({port:0,taskDirectory:path.join(f.directory,'missing-tasks'),captionPython:path.join(f.directory,'missing')});try{assert.equal(captions.available,false);assert.equal(captions.code,'CAPTION_START');}finally{await server.shutdown();}
});
test('adapter cancellation, busy protection, timeout and cleanup bound real child processes',async t=>{
 const f=await fixture(t,{delay:5000});const helper=createDevelopmentCaptionHelper({python:f.executable,tempRoot:f.directory,timeoutMs:500});
 assert.equal((await helper.status()).ready,true);
 const controller=new AbortController();const pending=helper.extractCaptions({url,signal:controller.signal});
 await assert.rejects(helper.extractCaptions({url}),e=>e.code==='CAPTION_BUSY');controller.abort();await assert.rejects(pending,e=>e.code==='CAPTION_CANCELLED');
 await assert.rejects(helper.extractCaptions({url}),e=>e.code==='CAPTION_TIMEOUT');
 assert.equal((await readdir(f.directory)).some(n=>n.startsWith('coconut-dev-caption-')),false);
 const stopped=helper.extractCaptions({url});await helper.shutdown();await assert.rejects(stopped,e=>e.code==='CAPTION_CANCELLED');
 await assert.rejects(helper.extractCaptions({url}),e=>e.code==='CAPTION_CANCELLED');
});
test('malformed output is rejected and restricted responses preserve uncertainty',async t=>{
 for(const result of [{status:'access_restricted'},{...caption,captionBase64:'not base64!'}]){
  const f=await fixture(t,{result});const helper=createDevelopmentCaptionHelper({python:f.executable});assert.equal((await helper.status()).ready,true);
  if(result.status==='access_restricted')assert.deepEqual(await helper.extractCaptions({url}),{status:'access_restricted'});
  else await assert.rejects(helper.extractCaptions({url}),e=>e.code==='CAPTION_OUTPUT');
  await helper.shutdown();
 }
});
