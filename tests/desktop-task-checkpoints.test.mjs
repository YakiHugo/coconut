import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {createTaskStore} from '../desktop/tasks.mjs';
import {startBridge} from '../desktop/server.mjs';
const submission=()=>({protocolVersion:1,kind:'summary',idempotencyKey:'intent',document:{key:'doc',revision:'r1'},provider:'codex',model:'chosen-model',consent:true,segments:[{id:'a',text:'Authored source. '.repeat(1100)}]});
const consent=(task,key='resume-1')=>({protocolVersion:1,consent:true,resumeKey:key,attemptId:task.attemptId,inputDigest:task.inputDigest});
const identity=task=>({taskId:task.taskId,attemptId:task.attemptId,inputDigest:task.inputDigest});
async function until(read,predicate){for(let i=0;i<200;i++){const value=await read();if(predicate(value))return value;await new Promise(r=>setTimeout(r,5));}throw new Error('Timed out');}
const cleanup=new Map();
async function directory(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-checkpoints-'));cleanup.set(dir,[]);t.after(async()=>{for(const close of cleanup.get(dir))await close();cleanup.delete(dir);await fs.rm(dir,{recursive:true,force:true});});return dir;}
async function open(t,dir,ask,options={}){const store=await createTaskStore({directory:dir,providers:{ask},...options});cleanup.get(dir).push(()=>store.shutdown());return store;}
async function failed(t,dir){let calls=0;const store=await open(t,dir,async()=>{if(++calls===1)return {answer:'First accepted note',citations:['a']};throw new Error('Authored failure');});const {task}=await store.submit(submission());return {store,task:await until(()=>store.get(task.taskId),x=>x.status==='failed')};}
async function crashed(t,dir,stopAt=2){
 const child=fork(new URL('./helpers/task-checkpoint-crash-worker.mjs',import.meta.url),[dir,String(stopAt)],{stdio:['ignore','ignore','pipe','ipc']});let receipt;
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Crash fixture timed out')),5000);child.on('error',reject);child.on('message',m=>{if(m.task)receipt=m.task;if(m.waiting){clearTimeout(timeout);resolve();}});child.on('exit',()=>{clearTimeout(timeout);reject(new Error('Crash fixture exited early'));});});
 const exit=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exit;return receipt;
}
test('SIGKILL preserves accepted notes and in-flight uncertainty; explicit duplicate resume reuses notes and identity',async t=>{
 const dir=await directory(t),original=await crashed(t,dir),calls=[];
 const store=await open(t,dir,async data=>{calls.push(data);return {answer:'Resumed answer',citations:[data.segments[0].id]};});
 const interrupted=await store.get(original.taskId);assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.attemptId,original.attemptId);assert.equal(calls.length,0);
 assert.deepEqual(interrupted.checkpoint,{version:1,completed:1,inFlight:1});assert.equal(interrupted.resume.remainingRequests,2);assert.equal(interrupted.resume.outcomeUnknown,true);
 assert.equal((await store.exportTask(original.taskId)).task.checkpoint.notes[0].answer,'Accepted first batch');
 const before=consent(interrupted),[one,two]=await Promise.all([store.resume(original.taskId,before),store.resume(original.taskId,before)]);
 assert.deepEqual([one.created,two.created],[true,false]);assert.equal(one.task.attemptId,two.task.attemptId);assert.deepEqual(one.receipt,two.receipt);assert.equal(one.receipt.outcomeUnknown,true);assert.equal(one.receipt.completedBatches,1);assert.notEqual(one.task.attemptId,original.attemptId);
 const done=await until(()=>store.get(original.taskId),x=>x.status==='succeeded');assert.equal(done.resume.remainingRequests,0);assert.equal(done.resume.eligible,false);assert.equal(calls.length,2);assert.equal(calls[0].segments[0].text,submission().segments[0].text.slice(16000));assert.match(calls[1].segments[0].text,/Accepted first batch/);
 for(const key of ['taskId','inputDigest','provider','model','document'])assert.deepEqual(done[key],original[key]);
 assert.ok(calls.every(call=>call.model==='chosen-model'));assert.equal((await store.findResume(done.taskId,'resume-1')).receipt.attemptId,done.attemptId);
 assert.equal((await store.resume(done.taskId,before)).created,false);assert.equal((await store.findResume(done.taskId,'absent')).receipt,null);
 await store.shutdown();const again=await open(t,dir,()=>{throw new Error('Must not execute');});assert.equal((await again.findResume(done.taskId,'resume-1')).receipt.attemptId,done.attemptId);assert.equal((await again.resume(done.taskId,before)).created,false);
});
test('resume rejects missing consent, changed identity and key reuse across attempts; cancellation cannot revive',async t=>{
 const dir=await directory(t),{store,task}=await failed(t,dir);
 for(const value of [{...consent(task),consent:false},{...consent(task),inputDigest:'changed'},{...consent(task),attemptId:'bad'},{...consent(task),resumeKey:42}])await assert.rejects(store.resume(task.taskId,value));
 const resumed=await store.resume(task.taskId,consent(task));
 await assert.rejects(store.cancel(task.taskId,identity(task)),e=>e.taskCode==='task_identity_conflict');await assert.rejects(store.cancel(task.taskId),e=>e.taskCode==='cancel_identity_required');
 const cancelled=await store.cancel(task.taskId,identity(resumed.task));assert.equal(cancelled.status,'cancelled');
 await assert.rejects(store.resume(task.taskId,consent(cancelled,'new-key')),e=>e.taskCode==='task_not_resumable');
 await assert.rejects(store.resume(task.taskId,consent(cancelled)),e=>e.taskCode==='idempotency_conflict');
 assert.equal((await store.resume(task.taskId,consent(task))).created,false);
});
for(const version of [1,2])test('legacy v'+version+' progress never substitutes for accepted notes',async t=>{
 const dir=await directory(t),{store,task}=await failed(t,dir);await store.shutdown();const file=path.join(dir,'tasks.json'),ledger=JSON.parse(await fs.readFile(file));ledger.version=version;delete ledger.tasks[0].checkpoint;await fs.writeFile(file,JSON.stringify(ledger));
 let calls=0;const reopened=await open(t,dir,async data=>{calls++;return {answer:'Fresh result',citations:[data.segments[0].id]};});assert.equal((await reopened.get(task.taskId)).resume.completedBatches,0);
 await reopened.resume(task.taskId,consent(task));await until(()=>reopened.get(task.taskId),x=>x.status==='succeeded');assert.equal(calls,3);
});
for(const damage of ['citation','note-size','plan','model','flight','progress','version','receipt','null'])test('damaged '+damage+' checkpoint fails closed without overwriting evidence',async t=>{
 const dir=await directory(t),{store}=await failed(t,dir);await store.shutdown();const file=path.join(dir,'tasks.json'),ledger=JSON.parse(await fs.readFile(file)),raw=ledger.tasks[0];
 if(damage==='null')raw.checkpoint=null;
 if(damage==='citation')raw.checkpoint.notes[0].citations=['absent'];if(damage==='note-size')raw.checkpoint.notes[0].answer='x'.repeat(1201);if(damage==='plan')raw.checkpoint.planDigest='wrong';if(damage==='model')raw.model='different';if(damage==='flight')raw.checkpoint.inFlight=0;if(damage==='progress')raw.progress.completed=2;if(damage==='version')raw.checkpoint.version=99;if(damage==='receipt')raw.resumeReceipts=[{key:'bad',fromAttemptId:raw.attemptId,attemptId:'wrong'}];
 const evidence=JSON.stringify(ledger);await fs.writeFile(file,evidence);let calls=0;await assert.rejects(createTaskStore({directory:dir,providers:{ask:()=>{calls++;}}}),e=>e.taskCode==='store_unavailable');assert.equal(calls,0);assert.equal(await fs.readFile(file,'utf8'),evidence);
});
test('invalid provider note never becomes a reusable checkpoint',async t=>{
 const dir=await directory(t);const store=await open(t,dir,async()=>({answer:'Bad',citations:['wrong']}));const {task}=await store.submit(submission());const done=await until(()=>store.get(task.taskId),x=>x.status==='failed');assert.equal(done.checkpoint.completed,0);assert.equal(done.checkpoint.inFlight,0);assert.equal(done.resume.outcomeUnknown,true);
});
test('resume admission checks storage reservation before creating a new attempt',async t=>{
 const dir=await directory(t),{store,task}=await failed(t,dir);await store.shutdown();const file=path.join(dir,'tasks.json'),before=await fs.readFile(file,'utf8');let calls=0;
 const reopened=await open(t,dir,()=>{calls++;},{maxLedgerBytes:Buffer.byteLength(before)+1000});await assert.rejects(reopened.resume(task.taskId,consent(task)),e=>e.taskCode==='store_full');assert.equal((await reopened.get(task.taskId)).attemptId,task.attemptId);assert.equal(calls,0);assert.equal(await fs.readFile(file,'utf8'),before);
});
test('HTTP resume receipt recovery is read-only; guarded cancellation rejects stale attempt',async t=>{
 const dir=await directory(t),original=await crashed(t,dir);let calls=0,resolve;
 const server=await startBridge({port:0,taskDirectory:dir,providers:{ask:()=>{calls++;return new Promise(r=>{resolve=r;});}}});cleanup.get(dir).push(()=>new Promise(r=>server.shutdown(r)));const origin=`http://127.0.0.1:${server.address().port}`;
 const request=(suffix,body)=>fetch(origin+'/api/v1/tasks/'+original.taskId+suffix,body?{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
 assert.equal((await (await request('?resumeKey=resume-1')).json()).receipt,null);assert.equal(calls,0);
 const receipt=await request('/resume',consent(original));assert.equal(receipt.status,202);const resumed=(await receipt.json()).task;await until(()=>calls,x=>x===1);
 const query=await (await request('?resumeKey=resume-1')).json();assert.equal(query.receipt.attemptId,resumed.attemptId);assert.equal((await request('/resume',consent(original))).status,200);assert.equal(calls,1);
 assert.equal((await request('/cancel',{protocolVersion:2,expected:identity(original)})).status,409);assert.equal((await request('/cancel',{protocolVersion:1})).status,409);
 assert.equal((await request('/cancel',{protocolVersion:2,expected:identity(resumed)})).status,200);resolve({answer:'Late result',citations:['a']});const cancelled=await until(async()=> (await (await request('')).json()).task,x=>x.status==='cancelled');assert.equal(cancelled.result,undefined);assert.equal(cancelled.checkpoint.completed,1);
});

test('crash during final aggregation reuses every accepted batch and only repeats aggregation',async t=>{
 const dir=await directory(t),task=await crashed(t,dir,3),calls=[];const store=await open(t,dir,async data=>{calls.push(data);return {answer:'Final',citations:['batch-1','batch-2']};});
 const interrupted=await store.get(task.taskId);assert.equal(interrupted.checkpoint.completed,2);assert.equal(interrupted.resume.remainingRequests,1);await store.resume(task.taskId,consent(task));await until(()=>store.get(task.taskId),x=>x.status==='succeeded');assert.equal(calls.length,1);assert.deepEqual(calls[0].segments.map(x=>x.id),['batch-1','batch-2']);
});
test('checkpoint persistence failure aborts the executor before any next batch',async t=>{
 const dir=await directory(t);let calls=0,resolve;const store=await open(t,dir,()=>{calls++;return new Promise(r=>{resolve=r;});});const {task}=await store.submit(submission());await until(()=>calls,x=>x===1);
 await fs.rename(path.join(dir,'tasks.json'),path.join(dir,'evidence.json'));await fs.mkdir(path.join(dir,'tasks.json'));resolve({answer:'Unsaved note',citations:['a']});
 await until(()=>store.describe(),x=>!x.enabled);assert.equal(calls,1);await assert.rejects(store.get(task.taskId),e=>e.taskCode==='store_unavailable');assert.equal(JSON.parse(await fs.readFile(path.join(dir,'evidence.json'))).tasks[0].checkpoint.notes.length,0);
});
test('resume cannot replace provider, requested model, snapshot or document identity',async t=>{
 const dir=await directory(t),{store,task}=await failed(t,dir);
 for(const extra of [{provider:'claude'},{model:'changed'},{segments:[]},{document:{key:'other'}}])await assert.rejects(store.resume(task.taskId,{...consent(task),...extra}));assert.equal((await store.get(task.taskId)).attemptId,task.attemptId);
});
test('64 explicit attempts are bounded, durable and all prior resume receipts remain idempotent',async t=>{
 const dir=await directory(t);let calls=0;const store=await open(t,dir,async()=>{calls++;throw new Error('Authored failure');});const {task}=await store.submit({...submission(),segments:[{id:'a',text:'Small source'}]});let current=await until(()=>store.get(task.taskId),x=>x.status==='failed'),first;
 for(let i=0;i<64;i++){const request=consent(current,'attempt-'+i);if(i===0)first=request;const receipt=await store.resume(task.taskId,request);assert.equal(receipt.created,true);current=await until(()=>store.get(task.taskId),x=>x.status==='failed');}
 assert.equal(current.resume.eligible,false);await assert.rejects(store.resume(task.taskId,consent(current,'overflow')),e=>e.taskCode==='resume_limit');assert.equal((await store.resume(task.taskId,first)).created,false);assert.equal(calls,65);
 await store.shutdown();const reopened=await open(t,dir,()=>{throw new Error('No execution');});assert.equal((await reopened.findResume(task.taskId,'attempt-0')).receipt.fromAttemptId,task.attemptId);assert.equal((await reopened.resume(task.taskId,first)).created,false);
});
for(const damage of ['terminal-process','terminal-provider','terminal-citation','terminal-notes'])test('terminal '+damage+' is checked with canonical summary validation',async t=>{
 const dir=await directory(t);const store=await open(t,dir,async data=>({answer:'Final',citations:[data.segments[0].id]}));const {task}=await store.submit(submission());const done=await until(()=>store.get(task.taskId),x=>x.status==='succeeded');assert.equal(done.resume.remainingRequests,0);await store.shutdown();const file=path.join(dir,'tasks.json'),ledger=JSON.parse(await fs.readFile(file)),raw=ledger.tasks[0];
 if(damage==='terminal-process')raw.result.summary_process.requests=99;if(damage==='terminal-provider')raw.result.provider='claude_subscription';if(damage==='terminal-citation')raw.result.citations=['absent'];if(damage==='terminal-notes')raw.checkpoint.notes=[];
 const evidence=JSON.stringify(ledger);await fs.writeFile(file,evidence);await assert.rejects(createTaskStore({directory:dir,providers:{ask:()=>{throw new Error('No execution');}}}),e=>e.taskCode==='store_unavailable');assert.equal(await fs.readFile(file,'utf8'),evidence);
});
test('single-batch success has no resumable note, zero remaining calls and validates after restart',async t=>{
 const dir=await directory(t);const store=await open(t,dir,async()=>({answer:'Final',citations:['a']}));const {task}=await store.submit({...submission(),segments:[{id:'a',text:'Single source'}]});const done=await until(()=>store.get(task.taskId),x=>x.status==='succeeded');assert.equal(done.resume.remainingRequests,0);assert.equal(done.resume.eligible,false);assert.deepEqual(done.checkpoint,{version:1,completed:0,inFlight:null});await store.shutdown();const reopened=await open(t,dir,()=>{throw new Error('No execution');});assert.equal((await reopened.get(task.taskId)).result.answer,'Final');
});

for(const version of [1,2])test('legacy v'+version+' successful result preserves its original weaker field contract after v3 rewrite',async t=>{
 const dir=await directory(t);const store=await open(t,dir,async()=>({answer:'Legacy success',citations:['a']}));const {task}=await store.submit({...submission(),segments:[{id:'a',text:'Legacy source'}]});await until(()=>store.get(task.taskId),x=>x.status==='succeeded');await store.shutdown();const file=path.join(dir,'tasks.json'),ledger=JSON.parse(await fs.readFile(file)),raw=ledger.tasks[0];ledger.version=version;delete raw.checkpoint;delete raw.result.summary_process;delete raw.result.provider;const original=structuredClone(raw.result);await fs.writeFile(file,JSON.stringify(ledger));
 const reopened=await open(t,dir,()=>{throw new Error('No execution');});assert.equal((await reopened.get(task.taskId)).result.answer,'Legacy success');await reopened.archive(task.taskId);await reopened.shutdown();const migrated=JSON.parse(await fs.readFile(file));assert.equal(migrated.version,3);assert.deepEqual(migrated.tasks[0].result,original);
 const again=await open(t,dir,()=>{throw new Error('No execution');});assert.equal((await again.get(task.taskId)).result.answer,'Legacy success');
});
