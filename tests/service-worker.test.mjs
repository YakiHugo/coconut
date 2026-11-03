import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startAsrWorker} from '../server/worker.mjs';
import {serviceConfig} from '../server/config.mjs';
import {startService} from '../server/main.mjs';
const python=execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim();
async function directory(t){const value=await mkdtemp(path.join(tmpdir(),'coconut-worker-'));t.after(()=>rm(value,{recursive:true,force:true}));return value;}
test('managed worker configuration is explicit and rejects conflicting or relative paths',()=>{
 for(const env of [{COCONUT_ASR_PYTHON:'relative'},{COCONUT_MODEL_DIRECTORY:'relative'},{COCONUT_ASR_PYTHON:python,COCONUT_ASR_EXECUTOR_URL:'http://127.0.0.1:1234'}])assert.throws(()=>serviceConfig(env));
 assert.equal(serviceConfig({COCONUT_ASR_PYTHON:python}).asrPython,python);
});
test('real managed Python transport stays offline, closes its listener and can reopen the same storage',async t=>{
 const data=await directory(t),worker=await startAsrWorker({python,directory:data,modelDirectory:path.join(data,'no-models')});t.after(()=>worker.shutdown());
 assert.equal(worker.online,true);
 const response=await fetch(worker.origin+'/api/ingestion-executor/status');const status=await response.json();
 assert.equal(status.model_download,false);assert.equal(status.available,false);assert.equal(status.upload_operations,1);
 await worker.shutdown();assert.equal(worker.online,false);await assert.rejects(fetch(worker.origin+'/api/ingestion-executor/status'));
 const restarted=await startAsrWorker({python,directory:data});await restarted.shutdown();
});
test('service owns worker startup and shutdown, while health probe discloses no library state',async t=>{
 const data=await directory(t),config=serviceConfig({COCONUT_PORT:'0',COCONUT_DATA_DIRECTORY:data,COCONUT_ASR_PYTHON:python,COCONUT_MODEL_DIRECTORY:path.join(data,'missing')});
 const started=await startService({config});t.after(()=>started.server.shutdown());
 assert.deepEqual(await (await fetch(started.origin+'/healthz')).json(),{status:'ok'});
 const status=await (await fetch(started.origin+'/api/v1/ingestions/capabilities')).json();assert.equal(status.transcription.available,false);
 await started.server.shutdown();
 const reopened=await startService({config});await reopened.server.shutdown();
});
test('invalid worker readiness and missing Python fail closed without hanging startup',async t=>{
 const data=await directory(t),invalid=path.join(data,'invalid.py');await writeFile(invalid,"print('invalid receipt', flush=True)\n");
 await assert.rejects(startAsrWorker({python,directory:data,scriptPath:invalid}),/Invalid ASR worker/);
 await assert.rejects(startAsrWorker({python:path.join(data,'not-python'),directory:data}),/could not be started/);
});
test('parent process death closes the real worker and releases its storage lock',async t=>{
 const data=await directory(t),module=new URL('../server/worker.mjs',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`import {startAsrWorker} from ${JSON.stringify(module)};const worker=await startAsrWorker(${JSON.stringify({python,directory:data})});console.log(worker.origin);setInterval(()=>{},1000);`],{stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill('SIGKILL'));
 const origin=await new Promise((resolve,reject)=>{let output='';child.stdout.on('data',value=>{output+=value;if(output.includes('\n'))resolve(output.trim());});child.on('error',reject);child.on('exit',()=>reject(Error('Parent exited before readiness')));});
 assert.equal((await fetch(origin+'/api/ingestion-executor/status')).status,200);child.kill('SIGKILL');
 let closed=false;for(let attempt=0;attempt<50;attempt++){await delay(100);try{await fetch(origin+'/api/ingestion-executor/status',{signal:AbortSignal.timeout(500)});}catch{closed=true;break;}}
 assert.equal(closed,true,'orphan worker must not keep listening');
 const restarted=await startAsrWorker({python,directory:data});await restarted.shutdown();
});
