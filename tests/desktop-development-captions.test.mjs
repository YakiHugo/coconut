import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readdir,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDevelopmentCaptionHelper} from '../desktop/development-captions.mjs';
import {startDevelopmentBridge} from '../desktop/dev.mjs';
import {diagnoseDevelopment,formatDoctorReport} from '../desktop/doctor.mjs';
const url='https://x.com/example/status/123456';
const version={status:'ok',protocol:1,version:'2026.08.19',publicExtraction:true,guardProtocol:1,tlsRootsVerified:true,developmentProviders:['x','youtube','bilibili']};
const caption={status:'ok',source:{url,id:'123456',title:'Authored protocol fixture',extractor:'twitter',language:'en',automatic:false,translated:false,live:false,duration:2},track:{language:'en',captionMethod:'platform_provided',languageBasis:'single_track'},format:'vtt',captionBase64:Buffer.from('WEBVTT\n\n00:00.000 --> 00:02.000\nAn authored original sentence.\n').toString('base64')};
async function fixture(t,{probe=version,result=caption,delay=0}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'coconut-dev-caption-test-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const executable=path.join(directory,'authored-python'),log=path.join(directory,'requests.jsonl');
 await writeFile(executable,`#!${process.execPath}\nconst fs=require('node:fs');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{const input=JSON.parse(raw);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({input,args:process.argv.slice(2),env:process.env,cwd:process.cwd()})+'\\n');const result=input.operation==='version'?${JSON.stringify(probe)}:${JSON.stringify(result)};setTimeout(()=>process.stdout.write(JSON.stringify(result)),input.operation==='version'?0:${delay});});`,{mode:0o700});
 return {directory,executable,log};
}
test('explicit developer adapter runs real isolated process from URL through HTTP to validated document',async t=>{
 let server;t.after(async()=>{if(server)await server.shutdown();});
 // Close the task writer before fixture removal; Node runs after-hooks FIFO.
 const f=await fixture(t);
 const started=await startDevelopmentBridge({libraryDirectory:null,port:0,taskDirectory:path.join(f.directory,'tasks'),captionPython:f.executable,providers:{status(){throw Error('Unexpected provider probe');}}});server=started.server;
 assert.equal(started.captions.available,true);assert.deepEqual(started.captions.providers.filter(p=>p.available).map(p=>p.id),['x','youtube','bilibili']);
 assert.equal(started.captions.automatic_asr,false);
 assert.equal((await fetch(started.origin+'/api/captions/status',{headers:{Origin:'https://example.com'}})).status,403);
 const send=value=>fetch(started.origin+'/api/captions/import',{method:'POST',headers:{Origin:started.origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
 assert.equal((await send({url:'https://www.youtube.com/watch?v=abc'})).status,400);
 const response=await send({url,language:'en'});assert.equal(response.status,200);const result=await response.json();
 assert.equal(result.status,'ready');assert.equal(result.document.segments[0].text,'An authored original sentence.');assert.equal(result.document.source_url,url);assert.equal(result.document.provenance.caption_method,'platform_provided');
 const calls=(await readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(calls.map(c=>c.input.operation),['version','extract-development']);assert.deepEqual(calls[1].input,{operation:'extract-development',url,language:'en'});
 for(const call of calls){assert.deepEqual(call.args.slice(0,3),['-I','-B','-c']);assert.equal(call.env.PYTHONPATH,undefined);assert.equal(call.env.HTTP_PROXY,undefined);assert.equal(call.env.OPENAI_API_KEY,undefined);assert.notEqual(call.env.HOME,process.env.HOME);await assert.rejects(stat(call.cwd),{code:'ENOENT'});}
 const report=await diagnoseDevelopment({port:server.address().port});assert.equal(report.captions.available,true);assert.match(formatDoctorReport(report),/YouTube/);
});
test('missing or mismatched Python fails closed with actionable status and no source extraction',async t=>{
 for(const probe of [{...version,version:'wrong'},{status:'version_mismatch',version:'2025.1.1'},{...version,tlsRootsVerified:false}]){
  const f=await fixture(t,{probe});const {server,origin,captions}=await startDevelopmentBridge({libraryDirectory:null,port:0,taskDirectory:path.join(f.directory,'tasks'),captionPython:f.executable});
  try{assert.equal(captions.available,false);assert.equal(captions.code,'CAPTION_VERSION');assert.match(captions.message,/COCONUT_CAPTION_PYTHON/);const doctor=formatDoctorReport(await diagnoseDevelopment({port:server.address().port}));assert.match(doctor,/yt-dlp==2026.8.19/);assert.match(doctor,/COCONUT_CAPTION_PYTHON=.*npm run dev/);assert.equal((await fetch(origin+'/api/health').then(r=>r.json())).capabilities.caption_import,false);assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);}finally{await server.shutdown();}
 }
 const f=await fixture(t);const {server,captions}=await startDevelopmentBridge({libraryDirectory:null,port:0,taskDirectory:path.join(f.directory,'missing-tasks'),captionPython:path.join(f.directory,'missing')});try{assert.equal(captions.available,false);assert.equal(captions.code,'CAPTION_START');}finally{await server.shutdown();}
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
 for(const result of [{status:'access_restricted'},{status:'metadata_incomplete'},{...caption,captionBase64:'not base64!'}]){
  const f=await fixture(t,{result});const helper=createDevelopmentCaptionHelper({python:f.executable});assert.equal((await helper.status()).ready,true);
  if(['access_restricted','metadata_incomplete'].includes(result.status))assert.deepEqual(await helper.extractCaptions({url}),{status:result.status});
  else await assert.rejects(helper.extractCaptions({url}),e=>e.code==='CAPTION_OUTPUT');
  await helper.shutdown();
 }
});

test('developer HTTP route imports YouTube VTT and Bilibili SRT with provider identities',async t=>{
 for(const [provider,url,id,format,body] of [
  ['youtube','https://www.youtube.com/watch?v=BaW_jenozKc','BaW_jenozKc','vtt','WEBVTT\n\n00:00.000 --> 00:02.000\nOriginal fixture.\n'],
  ['bilibili','https://www.bilibili.com/video/BV1xx411c7mD','BV1xx411c7mD','srt','1\n00:00:00,000 --> 00:00:02,000\nOriginal fixture.\n']]){
  const result={...caption,format,captionBase64:Buffer.from(body).toString('base64'),source:{...caption.source,url,id,extractor:provider,live_status:'not_live'}};
  const f=await fixture(t,{result});const {server,origin}=await startDevelopmentBridge({libraryDirectory:null,port:0,taskDirectory:path.join(f.directory,'tasks'),captionPython:f.executable});
  try{
   const response=await fetch(origin+'/api/captions/import',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({url})});
   assert.equal(response.status,200);const receipt=await response.json();assert.equal(receipt.status,'ready');
   assert.equal(receipt.document.provenance.source_platform,provider);assert.equal(receipt.document.provenance.media_id,id);assert.equal(receipt.document.segments[0].text,'Original fixture.');
  }finally{await server.shutdown();}
 }
});

test('dependency failures flow through HTTP and doctor without attempting extraction or leaking diagnostics',async t=>{
 for(const [missing,code,phrase] of [
  [['yt_dlp'],'CAPTION_MISSING_YT_DLP','缺少 yt-dlp'],
  [['certifi'],'CAPTION_MISSING_CERTIFI','缺少 certifi'],
  [['yt_dlp','certifi'],'CAPTION_MISSING_DEPENDENCIES','缺少 yt-dlp 和 certifi'],
  [['yt_dlp','private/path/token'],'CAPTION_OUTPUT','检查未通过'],
  [['yt_dlp','yt_dlp'],'CAPTION_OUTPUT','检查未通过'],
  [[],'CAPTION_OUTPUT','检查未通过'],
 ]){
  const f=await fixture(t,{probe:{status:'dependencies_missing',missing,stderr:'PRIVATE_SECRET'}});
  const {server,origin,captions}=await startDevelopmentBridge({libraryDirectory:null,port:0,taskDirectory:path.join(f.directory,'tasks'),captionPython:f.executable});
  try{
   assert.equal(captions.available,false);assert.equal(captions.code,code);
   const report=await diagnoseDevelopment({port:server.address().port});const output=formatDoctorReport(report);
   assert.match(output,new RegExp(phrase));assert.doesNotMatch(output,/PRIVATE_SECRET|private\/path\/token/);
   assert.match(output,/手动重启/);
   assert.equal((await fetch(origin+'/api/health').then(r=>r.json())).capabilities.caption_import,false);
   assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
  }finally{await server.shutdown();}
 }
});

test('development guidance uses hashed runtime-only pins and displays only safe actual versions',async()=>{
 const {captionSetupGuidance}=await import('../desktop/caption-setup-guidance.mjs');
 const lock=JSON.parse(await readFile(new URL('../desktop/caption-helper-lock.json',import.meta.url),'utf8'));
 const requirements=await readFile(new URL('../desktop/development-caption-requirements.txt',import.meta.url),'utf8');
 const lines=requirements.split('\n').filter(line=>line&&!line.startsWith('#'));assert.equal(lines.length,2);
 for(const name of ['yt-dlp','certifi']){
  const pkg=lock.packages.find(p=>p.name===name),wheel=pkg.files.find(f=>f.type==='bdist_wheel');
  assert.ok(lines.includes(`${name}==${pkg.version} --hash=sha256:${wheel.sha256}`));
 }
 const unconfigured=captionSetupGuidance('CAPTION_UNAVAILABLE');
 assert.match(unconfigured,/python3 --version/);assert.match(unconfigured,/Python 3.10\+/);
 assert.match(captionSetupGuidance('CAPTION_PYTHON_VERSION'),/重新创建独立环境/);
 assert.match(unconfigured,/python3 -m venv \.venv-captions/);assert.match(unconfigured,/--require-hashes --only-binary=:all: --no-deps -r desktop\/development-caption-requirements.txt/);
 assert.match(unconfigured,/COCONUT_CAPTION_PYTHON="\$PWD\/\.venv-captions\/bin\/python" npm run dev/);
 assert.match(captionSetupGuidance('CAPTION_MISSING_CERTIFI'),/同一 Python/);
 assert.match(captionSetupGuidance('CAPTION_VERSION',{actualVersion:'2025.01.01'}),/当前 yt-dlp=2025.01.01；需要 2026.08.19/);
 assert.doesNotMatch(captionSetupGuidance('CAPTION_VERSION',{actualVersion:'secret\ncommand'}),/secret|command/);
 assert.match(captionSetupGuidance('CAPTION_CONFIGURATION'),/绝对路径/);
});

test('real isolated Python dependency preflight emits only allowlisted missing modules',async t=>{
 const {spawnSync}=await import('node:child_process');
 const python=spawnSync('python3',['-I','-c','import sys;print(sys.executable)'],{encoding:'utf8'});
 if(python.status!==0)return t.skip('Python 3 unavailable; real interpreter preflight not exercised');
 const f=await fixture(t);const helper=createDevelopmentCaptionHelper({python:f.executable});
 await helper.status();await helper.shutdown();
 const launcher=JSON.parse((await readFile(f.log,'utf8')).trim()).args[3];
 for(const missing of [['yt_dlp','certifi'],['yt_dlp'],['certifi']]){
  // -S supplies a truly empty site-packages environment for the both-missing case.
  // Single-module cases use authored module-discovery results, never package imports.
  const prefix=missing.length===2?'':`import importlib.util;importlib.util.find_spec=lambda name: None if name in ${JSON.stringify(missing)} else object();\n`;
  const result=spawnSync(python.stdout.trim(),['-I','-S','-B','-c',prefix+launcher],{input:'{"operation":"version"}\n',encoding:'utf8',timeout:10000,cwd:f.directory});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
  assert.deepEqual(JSON.parse(result.stdout),{status:'dependencies_missing',missing});
 }
 const oldPython=spawnSync(python.stdout.trim(),['-I','-S','-B','-c',"import sys;sys.version_info=(3,9,0);\n"+launcher],{input:'{"operation":"version"}\n',encoding:'utf8',timeout:10000,cwd:f.directory});
 assert.equal(oldPython.status,0,oldPython.stderr);assert.equal(oldPython.stderr,'');
 assert.deepEqual(JSON.parse(oldPython.stdout),{status:'python_unsupported'});
 const oldFixture=await fixture(t,{probe:{status:'python_unsupported'}});
 const oldHelper=createDevelopmentCaptionHelper({python:oldFixture.executable});
 assert.deepEqual(await oldHelper.status(),{ready:false,code:'CAPTION_PYTHON_VERSION'});await oldHelper.shutdown();
 const oldVersion=spawnSync(python.stdout.trim(),['-I','-S','-B','-c',"import importlib.util,importlib.metadata;importlib.util.find_spec=lambda name: object();importlib.metadata.version=lambda name: '2025.1.1';\n"+launcher],{input:'{"operation":"version"}\n',encoding:'utf8',timeout:10000,cwd:f.directory});
 assert.equal(oldVersion.status,0,oldVersion.stderr);assert.equal(oldVersion.stderr,'');
 assert.deepEqual(JSON.parse(oldVersion.stdout),{status:'version_mismatch',version:'2025.1.1'});
 assert.deepEqual((await readdir(f.directory)).sort(),['authored-python','requests.jsonl']);
});

test('owner-only caption proxy crosses isolated protocol, never Web overrides or X',async t=>{
 let server;t.after(async()=>{if(server)await server.shutdown();});
 const publicUrl='https://www.youtube.com/watch?v=BaW_jenozKc';
 const f=await fixture(t,{probe:{...version,developmentProxyProtocol:1},result:{status:'network_unavailable',diagnostic:{stage:'metadata',reason:'proxy_unavailable',requests_attempted:1,responses_received:0}}});
 const started=await startDevelopmentBridge({libraryDirectory:null,port:0,taskDirectory:path.join(f.directory,'tasks'),captionPython:f.executable,captionProxy:'http://127.0.0.1:7897/'});
 server=started.server;const {origin,captions}=started;
 assert.equal(captions.networkMode,'trusted_local_proxy');assert.deepEqual(captions.proxyProviders,['youtube','bilibili']);
 assert.doesNotMatch(JSON.stringify(captions),/7897|127\.0\.0\.1/);
 const send=body=>fetch(origin+'/api/captions/import',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const response=await send({url:publicUrl,trustedProxy:'http://127.0.0.1:9999',proxy:'http://127.0.0.1:9999'});
 assert.equal(response.status,200);const receipt=await response.json();assert.equal(receipt.diagnostic.reason,'proxy_unavailable');assert.match(receipt.message,/本机字幕代理/);
 await send({url});
 const calls=(await readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(calls[0].input,{operation:'version'});
 assert.deepEqual(calls[1].input,{operation:'extract-development',url:publicUrl,language:null,trustedProxy:'http://127.0.0.1:7897'});
 assert.deepEqual(calls[2].input,{operation:'extract-development',url,language:null});
 for(const call of calls)assert.equal(Object.keys(call.env).some(k=>/proxy/i.test(k)),false);
});

test('invalid proxy configuration fails closed before spawning and missing protocol cannot silently go direct',async t=>{
 const {validateCaptionProxy}=await import('../desktop/development-captions.mjs');
 for(const proxy of ['',false,{},'http://127.1:7897','http://localhost:7897','http://127.0.0.1:0','http://127.0.0.1:65536','http://127.0.0.1:7897?x','http://secret:password@127.0.0.1:7897','socks5://127.0.0.1:7897','https://127.0.0.1:7897','http://192.168.0.1:7897']){
  assert.throws(()=>createDevelopmentCaptionHelper({python:'/never/spawn',proxy}),e=>e.code==='CAPTION_PROXY_CONFIGURATION'&&!/secret|password/.test(e.message));
 }
 assert.equal(validateCaptionProxy('http://[::1]:7897/'),'http://[::1]:7897');assert.equal(validateCaptionProxy(null),null);
 const f=await fixture(t);const helper=createDevelopmentCaptionHelper({python:f.executable,proxy:'http://127.0.0.1:7897'});
 assert.equal((await helper.status()).code,'CAPTION_VERSION');await assert.rejects(helper.extractCaptions({url}),e=>e.code==='CAPTION_UNAVAILABLE');await helper.shutdown();
 assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
});

test('development process retains bounded actual language choices without diagnostic payload leakage',async t=>{
 const f=await fixture(t,{result:{status:'language_required',languages:['fr','en','en','https://private.example'],token:'private'}}),helper=createDevelopmentCaptionHelper({python:f.executable});
 try{assert.equal((await helper.status()).ready,true);assert.deepEqual(await helper.extractCaptions({url}),{status:'language_required',languages:['en','fr']});}finally{await helper.shutdown();}
});

test('caption-only trusted proxy never advertises or executes the direct public media route',async t=>{
 let server;t.after(async()=>{if(server)await server.shutdown();});
 // Register shutdown before fixture cleanup so writer.lock remains until close.
 const probe={...version,developmentProxyProtocol:1,developmentAudioProtocol:1};
 const f=await fixture(t,{probe,result:{status:'no_matching_captions'}});
 const helper=createDevelopmentCaptionHelper({python:f.executable,proxy:'http://127.0.0.1:7897'});
 const status=await helper.status();assert.equal(status.ready,true);assert.equal(status.audioFallback,false);assert.deepEqual(status.audioProviders,[]);
 await assert.rejects(helper.extractAudio({url:'https://www.bilibili.com/video/BV1xx411c7mD'}),error=>error.code==='CAPTION_UNAVAILABLE');
 await helper.shutdown();assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
 const started=await startDevelopmentBridge({libraryDirectory:null,port:0,taskDirectory:path.join(f.directory,'tasks'),captionPython:f.executable,captionProxy:'http://127.0.0.1:7897'});
 server=started.server;assert.equal(started.captions.available,true);
 const response=await fetch(started.origin+'/api/v1/ingestions',{method:'POST',headers:{Origin:started.origin,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:1,source:{kind:'url',url:'https://www.bilibili.com/video/BV1xx411c7mD'}})});
 assert.equal(response.status,200);assert.equal((await response.json()).ingestion.error.audio_fallback,undefined);
 const media=await fetch(started.origin+'/api/videos/media',{method:'POST',headers:{Origin:started.origin,'Content-Type':'application/json'},body:JSON.stringify({url:'https://www.bilibili.com/video/BV1xx411c7mD',consent:true})});
 assert.equal(media.status,503);
 const calls=(await readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.some(call=>call.input.operation==='extract-development-audio'),false);
});
