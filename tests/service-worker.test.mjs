import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createTranscriber} from '../server/transcription.mjs';
import {serviceConfig} from '../server/config.mjs';
import {startService} from '../server/main.mjs';
const python=execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim();
async function directory(t){const value=await mkdtemp(path.join(tmpdir(),'coconut-worker-'));t.after(()=>rm(value,{recursive:true,force:true}));return value;}
test('direct transcription rejects executor URLs, unknown backends and non-local model paths',()=>{
 for(const env of [{COCONUT_ASR_PYTHON:'relative'},{COCONUT_MODEL_DIRECTORY:'relative'},{COCONUT_ASR_EXECUTOR_URL:'http://127.0.0.1:1234'},{COCONUT_ASR_BACKEND:'unknown'},{COCONUT_ASR_MODEL:'Qwen/model'}])assert.throws(()=>serviceConfig(env));
 assert.equal(serviceConfig({COCONUT_ASR_PYTHON:python}).asrProfile.backend,'qwen-mlx');
});
test('default Qwen recipe and explicit Whisper configuration remain compatible',()=>{
 const root=path.join(homedir(),'.coconut','models');
 assert.deepEqual(serviceConfig({}).asrProfile,{backend:'qwen-mlx',model_cache:undefined,
  asr_model:path.join(root,'Qwen3-ASR-1.7B-8bit'),align_model:path.join(root,'Qwen3-ForcedAligner-0.6B-8bit'),segmentation:'',embedding:''});
 const env={COCONUT_ASR_BACKEND:'faster-whisper',COCONUT_ASR_MODEL:'/models/asr',COCONUT_ALIGN_MODEL:'/models/align',COCONUT_SPEAKER_SEGMENTATION_MODEL:'/models/segmentation',COCONUT_SPEAKER_EMBEDDING_MODEL:'/models/embedding'};
 assert.deepEqual(serviceConfig(env).asrProfile,{backend:'faster-whisper',model_cache:undefined,
  asr_model:'/models/asr',align_model:'/models/align',segmentation:'/models/segmentation',embedding:'/models/embedding'});
});
test('MOSS selects its own model and excludes inactive Qwen/acoustic configuration from job identity',()=>{
 const env={COCONUT_ASR_BACKEND:'moss-mlx',COCONUT_MODEL_DIRECTORY:'/models'};
 const profile=serviceConfig(env).asrProfile;
 assert.deepEqual(profile,{backend:'moss-mlx',model_cache:'/models',asr_model:'/models/MOSS-Transcribe-Diarize-MLX-8bit',align_model:'',segmentation:'',embedding:''});
 assert.deepEqual(serviceConfig({...env,COCONUT_ALIGN_MODEL:'unused/aligner',COCONUT_SPEAKER_SEGMENTATION_MODEL:'/missing/segmentation',COCONUT_SPEAKER_EMBEDDING_MODEL:'/missing/embedding'}).asrProfile,profile);
 const overridden=serviceConfig({...env,COCONUT_ASR_MODEL:'/other/moss'}).asrProfile;
 assert.equal(overridden.asr_model,'/other/moss');assert.notDeepEqual(overridden,profile);
 assert.throws(()=>serviceConfig({...env,COCONUT_ASR_MODEL:'MOSS/model'}));
});
test('offline MOSS probe reports the selected engine unavailable without fallback or a download',async t=>{
 const data=await directory(t),config=serviceConfig({COCONUT_ASR_BACKEND:'moss-mlx',COCONUT_ASR_PYTHON:python,COCONUT_MODEL_DIRECTORY:path.join(data,'missing')});
 const status=await createTranscriber({python,profile:config.asrProfile}).status();
 assert.equal(status.backend,'moss-mlx');assert.equal(status.available,false);assert.equal(status.local_only,true);
 assert.equal(status.model_download,false);assert.equal(status.upload_operations,0);
});
test('real offline probe needs no model or listener and service remains usable',async t=>{
 const data=await directory(t),config=serviceConfig({COCONUT_PORT:'0',COCONUT_DATA_DIRECTORY:data,COCONUT_ASR_PYTHON:python,COCONUT_MODEL_DIRECTORY:path.join(data,'missing')});
 const runner=createTranscriber({python,profile:config.asrProfile});const status=await runner.status();assert.equal(status.available,false);assert.equal(status.model_download,false);assert.equal(status.upload_operations,0);
 const started=await startService({config});t.after(()=>started.server.shutdown());assert.deepEqual(await (await fetch(started.origin+'/healthz')).json(),{status:'ok'});
 assert.equal((await (await fetch(started.origin+'/api/v1/ingestions/capabilities')).json()).transcription.available,false);
 await started.server.shutdown();const reopened=await startService({config});await reopened.server.shutdown();
});
test('one task streams bounded JSON progress, remains offline and cancellation settles the process',async t=>{
 const data=await directory(t),script=path.join(data,'authored.py');await writeFile(script,`import sys,json,time,os\nr=json.loads(sys.stdin.readline())\nassert os.environ['HF_HUB_OFFLINE']=='1'\nprint(json.dumps({'phase':'recognize','chunk':1,'chunks':2}),flush=True)\ntime.sleep(20)\n`);
 const runner=createTranscriber({python,profile:{backend:'authored'},scriptPath:script}),controller=new AbortController(),events=[];
 const pending=runner.run({inputPath:path.join(data,'audio'),sha256:'a'.repeat(64),workDirectory:data,signal:controller.signal,onProgress:value=>{events.push(value);controller.abort();}});
 await assert.rejects(pending);assert.equal(events[0].phase,'recognize');
});
test('malformed worker output and missing Python are explicit failures',async t=>{
 const data=await directory(t),script=path.join(data,'invalid.py');await writeFile(script,"print('invalid receipt',flush=True)\n");
 const runner=createTranscriber({python,profile:{},scriptPath:script});assert.equal((await runner.status()).available,false);
 assert.equal((await createTranscriber({python:path.join(data,'missing'),profile:{}}).status()).available,false);
});
test('parent death terminates the real task parent-control path without an orphan',async t=>{
 const data=await directory(t),script=path.join(data,'held.py'),pidFile=path.join(data,'pid');
 await writeFile(script,`import sys,time,os\nsys.path.insert(0,${JSON.stringify(process.cwd())})\nimport transcription\ntranscription.probe=lambda _: {'available':True}\ndef held(request):\n open(${JSON.stringify(pidFile)},'w').write(str(os.getpid()))\n transcription.emit(phase='recognize')\n time.sleep(30)\ntranscription.run=held\ntranscription.main()\n`);
 const module=new URL('../server/transcription.mjs',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`import {createTranscriber} from ${JSON.stringify(module)};await createTranscriber(${JSON.stringify({python,profile:{backend:'authored'},scriptPath:script})}).run(${JSON.stringify({inputPath:path.join(data,'audio'),workDirectory:data,sha256:'a'.repeat(64)})});`],{stdio:['ignore','ignore','ignore']});t.after(()=>child.kill('SIGKILL'));
 let pid;for(let i=0;i<100;i++){try{pid=Number(await readFile(pidFile,'utf8'));if(pid)break;}catch{}await delay(20);}assert.ok(pid);child.kill('SIGKILL');
 let gone=false;for(let i=0;i<100;i++){try{process.kill(pid,0);}catch{gone=true;break;}await delay(20);}assert.equal(gone,true);
});
test('normal completion exits cleanly while the production parent watcher is waiting',async t=>{
 const data=await directory(t),script=path.join(data,'completed.py');
 await writeFile(script,`import sys\nsys.path.insert(0,${JSON.stringify(process.cwd())})\nimport transcription\ntranscription.run=lambda _: transcription.emit(phase='done')\ntranscription.main()\n`);
 const phases=[];await createTranscriber({python,profile:{backend:'authored'},scriptPath:script}).run({inputPath:path.join(data,'audio'),sha256:'a'.repeat(64),workDirectory:data,onProgress:value=>phases.push(value.phase)});
 assert.deepEqual(phases,['done']);
});
