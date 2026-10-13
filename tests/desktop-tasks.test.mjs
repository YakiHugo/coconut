import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTaskStore } from '../desktop/tasks.mjs';
const submission=(overrides={})=>({protocolVersion:1,kind:'summary',idempotencyKey:'submission-1',document:{key:'doc',revision:'rev-1'},provider:'codex',consent:true,segments:[{id:'a',text:'Authored test source.'}],...overrides});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function setup(t,ask=async()=>({answer:'Summary',citations:['a']}),options={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-tasks-test-'));
 const calls=[];const store=await createTaskStore({...options,directory,providers:{ask:async(data,options)=>{calls.push({data,options});return ask(data,options);}}});
 t.after(async()=>{await store.shutdown();await fs.rm(directory,{recursive:true,force:true});});return {directory,store,calls};
}
async function until(store,id,status){for(let i=0;i<100;i++){const task=await store.get(id);if(task.status===status)return task;await new Promise(r=>setTimeout(r,5));}throw new Error('Task did not become '+status);}

test('submission is durable, duplicate submissions share one task and one provider run',async t=>{
 const gate=deferred(),{store,calls,directory}=await setup(t,()=>gate.promise);
 const [a,b]=await Promise.all([store.submit(submission()),store.submit(submission())]);
 assert.equal(a.task.taskId,b.task.taskId);assert.deepEqual([a.created,b.created],[true,false]);
 const saved=JSON.parse(await fs.readFile(path.join(directory,'tasks.json'),'utf8'));assert.equal(saved.tasks.length,1);
 await until(store,a.task.taskId,'running');assert.equal(calls.length,1);
 gate.resolve({answer:'Summary',citations:['a']});const done=await until(store,a.task.taskId,'succeeded');
 assert.equal(done.result.purpose,'summary');assert.equal(done.result.input_snapshot.segments[0].text,'Authored test source.');
 assert.equal((await store.submit(submission())).task.taskId,a.task.taskId);assert.equal(calls.length,1);
});

test('same idempotency key with different revision, input or provider is a conflict before inference',async t=>{
 const {store,calls}=await setup(t);await store.submit(submission());
 for(const changed of [{document:{key:'doc',revision:'rev-2'}},{segments:[{id:'a',text:'Changed'}]},{provider:'claude'}])await assert.rejects(store.submit(submission(changed)),error=>error.status===409);
 await until(store,(await store.list())[0].taskId,'succeeded');assert.equal(calls.length,1);
});

test('explicit cancellation wins over a late provider result and survives another read',async t=>{
 const gate=deferred(),{store,calls}=await setup(t,()=>gate.promise);const {task}=await store.submit(submission());await until(store,task.taskId,'running');
 assert.equal((await store.cancel(task.taskId)).status,'cancel_requested');assert.equal(calls[0].options.signal.aborted,true);
 gate.resolve({answer:'Too late',citations:['a']});await new Promise(r=>setTimeout(r,25));
 const again=await store.get(task.taskId);assert.equal(again.status,'cancelled');assert.equal(again.result,undefined);assert.equal((await store.submit(submission())).task.status,'cancelled');
});

test('shutdown aborts immediately and restart records interruption without spending again',async t=>{
 const gate=deferred(),{directory,store,calls}=await setup(t,()=>gate.promise);const {task}=await store.submit(submission());await until(store,task.taskId,'running');
 const shutting=store.shutdown();assert.equal(calls[0].options.signal.aborted,true);await shutting;
 const recovered=await createTaskStore({directory,providers:{ask:async()=>{throw new Error('Must not run on recovery');}}});
 assert.equal((await recovered.get(task.taskId)).status,'interrupted');assert.equal((await recovered.submit(submission())).task.status,'interrupted');
 gate.resolve({answer:'Old process result',citations:['a']});await new Promise(r=>setTimeout(r,15));assert.equal((await recovered.get(task.taskId)).status,'interrupted');await recovered.shutdown();
});

test('multi-batch summary reuses the real plan and maps final batch citations to sources',async t=>{
 const {store,calls}=await setup(t,async data=>({answer:'Bounded summary',citations:[data.segments[0].id]}));
 const {task}=await store.submit(submission({segments:[{id:'a',text:'A'.repeat(16000)},{id:'b',text:'B'.repeat(100)}]}));
 const done=await until(store,task.taskId,'succeeded');assert.equal(calls.length,3);assert.equal(done.progress.completed,3);assert.equal(done.progress.total,3);assert.deepEqual(done.result.citations,['a']);assert.equal(done.result.summary_process.batches,2);
});

test('invalid consent, unsupported kinds and malformed payloads never start providers',async t=>{
 const {store,calls}=await setup(t);
 for(const changed of [{consent:false},{protocolVersion:2},{kind:'translation'},{provider:'other'},{document:{key:'doc',revision:''}},{idempotencyKey:'../invalid'},{segments:[]},{segments:[{id:'a',text:'one'},{id:'a',text:'two'}]}])await assert.rejects(store.submit(submission(changed)));
 assert.equal(calls.length,0);assert.deepEqual(await store.list(),[]);
});

test('queued cancellation never starts the second task and terminal cancellation is idempotent',async t=>{
 const gate=deferred(),{store,calls}=await setup(t,()=>gate.promise);const first=await store.submit(submission());await until(store,first.task.taskId,'running');
 const second=await store.submit(submission({idempotencyKey:'second-intent'}));assert.equal(second.task.status,'queued');
 assert.equal((await store.cancel(second.task.taskId)).status,'cancelled');assert.equal((await store.cancel(second.task.taskId)).status,'cancelled');
 gate.resolve({answer:'Summary',citations:['a']});await until(store,first.task.taskId,'succeeded');assert.equal(calls.length,1);
});

test('completed result and original idempotency key survive store restart',async t=>{
 const {directory,store}=await setup(t);const {task}=await store.submit(submission());const finished=await until(store,task.taskId,'succeeded');await store.shutdown();
 let calls=0;const recovered=await createTaskStore({directory,providers:{ask:async()=>{calls++;}}});
 try{assert.deepEqual(await recovered.get(task.taskId),finished);assert.equal((await recovered.submit(submission())).created,false);assert.equal(calls,0);}finally{await recovered.shutdown();}
});

test('a second writer cannot open an active directory',async t=>{
 const {directory}=await setup(t);await assert.rejects(createTaskStore({directory,providers:{ask:async()=>{}}}),error=>error.taskCode==='store_locked');
});

test('truncated ledger fails closed without probing or overwriting the evidence',async t=>{
 const {directory,store}=await setup(t);await store.shutdown();const bad='{"version":1,"tasks":[';await fs.writeFile(path.join(directory,'tasks.json'),bad);let calls=0;
 await assert.rejects(createTaskStore({directory,providers:{ask:async()=>{calls++;}}}),error=>error.taskCode==='store_unavailable');
 assert.equal(calls,0);assert.equal(await fs.readFile(path.join(directory,'tasks.json'),'utf8'),bad);
});

test('failed durable write never acknowledges a task or starts provider execution',async t=>{
 const {directory,store,calls}=await setup(t);
 await fs.mkdir(path.join(directory,'tasks.json'));await assert.rejects(store.submit(submission()),error=>error.taskCode==='store_unavailable');
 await new Promise(r=>setTimeout(r,15));assert.equal(calls.length,0);await assert.rejects(store.list(),error=>error.taskCode==='store_unavailable');
});

test('task file permissions are private and snapshots exclude notes, media and arbitrary fields',async t=>{
 const {directory,store}=await setup(t);const {task}=await store.submit(submission({notes:{private:'note'},mediaPath:'/private/media',segments:[{id:'a',text:'Source',notes:'never send'}]}));await until(store,task.taskId,'succeeded');
 const filename=path.join(directory,'tasks.json'),content=await fs.readFile(filename,'utf8');assert.equal((await fs.stat(filename)).mode&0o777,0o600);assert.ok(!content.includes('private'));assert.ok(!content.includes('never send'));
});

test('real process death leaves running work interrupted, with no automatic new attempt',async t=>{
 const {fork}=await import('node:child_process');const directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-task-crash-'));
 const child=fork(new URL('./helpers/task-crash-worker.mjs',import.meta.url),[directory],{stdio:['ignore','ignore','pipe','ipc']});
 t.after(async()=>{child.kill('SIGKILL');await fs.rm(directory,{recursive:true,force:true});});
 let id;await new Promise((resolve,reject)=>{child.on('error',reject);child.on('message',message=>{if(message.taskId)id=message.taskId;if(message.started)resolve();});child.on('exit',code=>{if(!id)reject(new Error('Worker exited '+code));});});
 const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;assert.ok(id);
 let calls=0;const recovered=await createTaskStore({directory,providers:{ask:async()=>{calls++;}}});
 try{const task=await recovered.get(id);assert.equal(task.status,'interrupted');assert.equal(task.error.code,'executor_interrupted');assert.equal(calls,0);assert.equal((await recovered.findSubmission('crash-intent')).taskId,id);}
 finally{await recovered.shutdown();}
});

test('admission reserves the exact terminal budget so accepted work remains cancellable at capacity',async t=>{
 const fixed={taskId:'0'.repeat(36),attemptId:'0'.repeat(36),idempotencyKey:'submission-1',inputDigest:'0'.repeat(64),kind:'summary',document:{key:'doc',revision:'rev-1'},provider:'codex',snapshot:submission().segments};
 const maxLedgerBytes=Buffer.byteLength(JSON.stringify({version:1,tasks:[fixed]}))+1024*1024;
 const gate=deferred(),{store,directory,calls}=await setup(t,()=>gate.promise,{maxLedgerBytes});
 const {task}=await store.submit(submission());await until(store,task.taskId,'running');assert.equal(calls.length,1);
 await assert.rejects(store.submit(submission({idempotencyKey:'another-intent'})),error=>error.status===507);
 assert.equal(store.describe().enabled,true);assert.equal((await store.cancel(task.taskId)).status,'cancel_requested');await store.shutdown();
 const recovered=await createTaskStore({directory,maxLedgerBytes,providers:{ask:async()=>{throw new Error('Must not rerun');}}});
 try{assert.equal((await recovered.get(task.taskId)).status,'cancelled');}finally{await recovered.shutdown();}
 gate.resolve({answer:'Late',citations:['a']});
});

test('accepted task can save a final result at its exact reserved capacity',async t=>{
 const fixed={taskId:'0'.repeat(36),attemptId:'0'.repeat(36),idempotencyKey:'submission-1',inputDigest:'0'.repeat(64),kind:'summary',document:{key:'doc',revision:'rev-1'},provider:'codex',snapshot:submission().segments};
 const maxLedgerBytes=Buffer.byteLength(JSON.stringify({version:1,tasks:[fixed]}))+1024*1024;
 const {store}=await setup(t,async()=>({answer:'\u0000'.repeat(7999)+'x',citations:['a']}),{maxLedgerBytes});
 const {task}=await store.submit(submission());assert.equal((await until(store,task.taskId,'succeeded')).result.answer.length,8000);
});

test('near-full admission preserves an older successful result while reserving cancellation and restart',async t=>{
 const {directory,store}=await setup(t);const first=await store.submit(submission());const old=await until(store,first.task.taskId,'succeeded');await store.shutdown();
 const ledger=JSON.parse(await fs.readFile(path.join(directory,'tasks.json'),'utf8'));
 const fixed={taskId:'0'.repeat(36),attemptId:'0'.repeat(36),idempotencyKey:'next-intent',inputDigest:'0'.repeat(64),kind:'summary',document:{key:'doc',revision:'rev-1'},provider:'codex',snapshot:submission().segments};
 const maxLedgerBytes=Buffer.byteLength(JSON.stringify({version:1,tasks:[...ledger.tasks,fixed]}))+1024*1024,gate=deferred();
 const second=await createTaskStore({directory,maxLedgerBytes,providers:{ask:()=>gate.promise}});
 const queued=await second.submit(submission({idempotencyKey:'next-intent'}));await until(second,queued.task.taskId,'running');
 await assert.rejects(second.submit(submission({idempotencyKey:'third-intent'})),error=>error.status===507);
 assert.deepEqual(await second.get(first.task.taskId),old);assert.equal((await second.cancel(queued.task.taskId)).status,'cancel_requested');await second.shutdown();
 const third=await createTaskStore({directory,maxLedgerBytes,providers:{ask:async()=>{throw new Error('No automatic retry');}}});
 try{assert.deepEqual(await third.get(first.task.taskId),old);assert.equal((await third.get(queued.task.taskId)).status,'cancelled');}finally{await third.shutdown();}gate.resolve({answer:'Late',citations:['a']});
});
