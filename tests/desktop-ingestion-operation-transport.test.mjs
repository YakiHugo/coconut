/** Real loopback contract; the Python worker is disabled and no ASR is run. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {createIngestionExecutor} from '../desktop/ingestion-executor.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function fixture(directory){
 const script=`import sys\nfrom pathlib import Path\nimport serve\nserve.ImportJobs.start=lambda self: None\nserve.executor_status=lambda: {'available':True,'model_download':False,'upload_operations':1}\nserver,jobs=serve.build_server(Path(sys.argv[1]),0)\nprint(server.server_port,flush=True)\nserver.serve_forever()\n`;
 const child=spawn('python3',['-u','-c',script,directory],{cwd:root,stdio:['ignore','pipe','pipe']});
 let errors='';child.stderr.on('data',chunk=>{errors+=chunk;});
 const port=await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{child.kill();reject(new Error('Python fixture startup timed out: '+errors));},10000);
  child.once('error',error=>{clearTimeout(timeout);reject(error);});
  child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Python fixture stopped: '+errors));});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timeout);resolve(Number(output.trim().split('\n')[0]));}});
 });
 return {executor:createIngestionExecutor({url:`http://127.0.0.1:${port}`}),async close(){if(child.exitCode!==null||child.signalCode!==null)return;await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});}};
}
function body(value='abc'){const req=Readable.from([Buffer.from(value)]);req.headers={'content-type':'application/octet-stream','content-length':String(Buffer.byteLength(value))};return req;}
test('real Node→Python operation recovery survives restart and prevents duplicate or mismatched admission',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'coconut-operation-'));let running;
 t.after(async()=>{await running?.close();await rm(directory,{recursive:true,force:true});});
 const identity={operation_id:'12345678-1234-4234-8234-123456789abc',filename:'audio.mp3',size:3,fingerprint:'f'.repeat(64),last_modified:100,language:''};
 running=await fixture(directory);
 await assert.rejects(running.executor.recover(identity),error=>error.status===404&&error.taskCode==='ingestion_operation_not_found');
 const first=await running.executor.upload(body(),identity);assert.equal(first.state,'queued');assert.equal(first.source.operation_id,identity.operation_id);
 const replay=await running.executor.upload(body(),identity);assert.equal(replay.id,first.id);assert.equal((await running.executor.list()).length,1);
 await assert.rejects(running.executor.upload(body('xyz'),identity),error=>error.status===409&&error.taskCode==='ingestion_operation_conflict');
 await assert.rejects(running.executor.recover({...identity,last_modified:101}),error=>error.status===409&&error.taskCode==='ingestion_operation_conflict');
 await running.close();running=await fixture(directory);
 assert.equal((await running.executor.recover(identity)).id,first.id);
 assert.equal((await running.executor.upload(body(),identity)).id,first.id);
 assert.equal((await running.executor.list()).length,1);
 const cancelled=await running.executor.action(first.id,'cancel');assert.equal(cancelled.state,'cancelled');
 const repeated=await running.executor.upload(body(),identity);assert.equal(repeated.state,'cancelled');assert.equal(repeated.id,first.id);
});
