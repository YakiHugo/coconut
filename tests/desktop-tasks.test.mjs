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

const archiveStores=new Map();
async function openArchiveStore(options){const store=await createTaskStore(options);archiveStores.get(options.directory)?.push(store);return store;}

async function archivedFixture(t,{active=1,archived=0,version=2}={}){
 const {directory,store}=await setup({after(){}});archiveStores.set(directory,[]);t.after(async()=>{for(const opened of archiveStores.get(directory))await opened.shutdown();archiveStores.delete(directory);await fs.rm(directory,{recursive:true,force:true});});const receipt=await store.submit(submission());await until(store,receipt.task.taskId,'succeeded');await store.shutdown();
 const file=path.join(directory,'tasks.json'),seed=JSON.parse(await fs.readFile(file,'utf8')).tasks[0];
 if(version<3){delete seed.checkpoint;delete seed.resumeReceipts;}
 const {randomUUID}=await import('node:crypto');
 const tasks=Array.from({length:active+archived},(_,i)=>({...seed,taskId:randomUUID(),attemptId:randomUUID(),idempotencyKey:'fixture-'+i,...(i>=active?{archivedAt:'2026-10-14T00:00:00.000Z'}:{})}));
 await fs.writeFile(file,JSON.stringify({version,extension:{kept:true},tasks}));return {directory,file,tasks};
}

test('128 retained terminal tasks can explicitly archive then submit, with archived identity/digest/source/result intact',async t=>{
 const {directory,file,tasks}=await archivedFixture(t,{active:128});let calls=0;
 let store=await openArchiveStore({directory,providers:{ask:async()=>{calls++;return {answer:'New result',citations:['a']};}}});t.after(()=>store.shutdown());
 await assert.rejects(store.submit(submission({idempotencyKey:'new-intent'})),e=>e.taskCode==='active_tasks_full');assert.equal(calls,0);
 const archived=await store.archive(tasks[0].taskId);assert.ok(archived.archivedAt);assert.equal((await store.list()).length,127);
 const newTask=await store.submit(submission({idempotencyKey:'new-intent'}));await until(store,newTask.task.taskId,'succeeded');assert.equal(calls,1);
 const duplicate=await store.submit(submission({idempotencyKey:'fixture-0'}));assert.equal(duplicate.created,false);assert.equal(duplicate.task.taskId,tasks[0].taskId);assert.equal(duplicate.task.archivedAt,archived.archivedAt);assert.equal(calls,1);
 await assert.rejects(store.submit(submission({idempotencyKey:'fixture-0',provider:'claude'})),e=>e.taskCode==='idempotency_conflict');
 assert.equal((await store.findSubmission('fixture-0')).taskId,tasks[0].taskId);
 const exported=await store.exportTask(tasks[0].taskId);for(const key of ['taskId','attemptId','idempotencyKey','inputDigest','snapshot','result'])assert.deepEqual(exported.task[key],tasks[0][key]);
 assert.equal((await store.archive(tasks[0].taskId)).archivedAt,archived.archivedAt);
 await assert.rejects(store.restore(tasks[0].taskId),e=>e.taskCode==='active_tasks_full');
 await store.archive(newTask.task.taskId);const restored=await store.restore(tasks[0].taskId);assert.equal(restored.archivedAt,undefined);assert.equal(restored.taskId,tasks[0].taskId);assert.equal(calls,1);
 await store.archive(tasks[0].taskId);await store.shutdown();
 store=await openArchiveStore({directory,providers:{ask:async()=>{calls++;}}});assert.equal((await store.submit(submission({idempotencyKey:'fixture-0'}))).created,false);assert.equal(calls,1);
 const persisted=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(persisted.version,3);assert.equal(persisted.tasks.length,129);assert.deepEqual(persisted.extension,{kept:true});
});

test('running, queued, cancel-unsettled and interrupted tasks cannot be archived',async t=>{
 const gate=deferred(),{store}=await setup(t,()=>gate.promise);const first=await store.submit(submission());await until(store,first.task.taskId,'running');
 const second=await store.submit(submission({idempotencyKey:'queued'}));
 for(const task of [first.task,second.task])await assert.rejects(store.archive(task.taskId),e=>e.taskCode==='task_not_archivable');
 await store.cancel(first.task.taskId);await assert.rejects(store.archive(first.task.taskId),e=>e.taskCode==='task_not_archivable');
 await store.cancel(second.task.taskId);assert.ok((await store.archive(second.task.taskId)).archivedAt);
 gate.resolve({answer:'Late result',citations:['a']});await until(store,first.task.taskId,'cancelled');assert.ok((await store.archive(first.task.taskId)).archivedAt);
 const fixture=await archivedFixture(t);const raw=JSON.parse(await fs.readFile(fixture.file,'utf8'));raw.tasks[0].status='interrupted';delete raw.tasks[0].result;await fs.writeFile(fixture.file,JSON.stringify(raw));
 const recovered=await openArchiveStore({directory:fixture.directory,providers:{ask:async()=>{throw new Error('No inference');}}});t.after(()=>recovered.shutdown());await assert.rejects(recovered.archive(raw.tasks[0].taskId),e=>e.taskCode==='task_not_archivable');
});

test('archive bound is 2048 and paginated reads stay bounded without deleting old records',async t=>{
 const {directory,tasks}=await archivedFixture(t,{active:1,archived:2048});const store=await openArchiveStore({directory,providers:{ask:async()=>{throw new Error('No inference');}}});t.after(()=>store.shutdown());
 await assert.rejects(store.archive(tasks[0].taskId),e=>e.taskCode==='archive_full');assert.equal((await store.list()).length,1);
 let after='',ids=[];do{const page=await store.listArchived({after,limit:50});assert.ok(page.tasks.length<=50);assert.equal(page.total,2048);assert.ok(page.tasks.every(task=>!task.result&&!task.snapshot));ids.push(...page.tasks.map(task=>task.taskId));after=page.nextCursor;}while(after);
 assert.equal(ids.length,2048);assert.equal(new Set(ids).size,2048);
 for(const options of [{limit:0},{limit:51},{limit:1.5},{after:'bad-cursor'}])await assert.rejects(store.listArchived(options),e=>e.taskCode==='invalid_request');
 await store.restore(tasks[1].taskId);await store.archive(tasks[0].taskId);assert.equal((await store.listArchived()).total,2048);assert.equal((await store.get(tasks[1].taskId)).taskId,tasks[1].taskId);
});

test('exact byte-full archive rejection leaves the existing manifest and identity readable',async t=>{
 const {directory,file,tasks}=await archivedFixture(t),before=await fs.readFile(file,'utf8');
 const store=await openArchiveStore({directory,maxLedgerBytes:Buffer.byteLength(before),providers:{ask:async()=>{throw new Error('No inference');}}});t.after(()=>store.shutdown());
 await assert.rejects(store.archive(tasks[0].taskId),e=>e.taskCode==='store_full');assert.equal(await fs.readFile(file,'utf8'),before);assert.equal(store.describe().enabled,true);assert.equal((await store.findSubmission('fixture-0')).archivedAt,undefined);
});

test('v1 migration retains all records and extension fields on its first atomic archive write',async t=>{
 const {directory,file,tasks}=await archivedFixture(t,{version:1});const ledger=JSON.parse(await fs.readFile(file,'utf8'));ledger.tasks[0].extension={retained:'record field'};await fs.writeFile(file,JSON.stringify(ledger));
 const store=await openArchiveStore({directory,providers:{ask:async()=>{throw new Error('No inference');}}});t.after(()=>store.shutdown());
 assert.equal(JSON.parse(await fs.readFile(file,'utf8')).version,1);await store.archive(tasks[0].taskId);
 const saved=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(saved.version,3);assert.deepEqual(saved.tasks[0].extension,{retained:'record field'});assert.deepEqual(saved.extension,{kept:true});assert.equal(saved.tasks.length,1);
});

for(const damage of ['duplicate-key','duplicate-id','active-archived','archive-overflow'])test('invalid archive '+damage+' fails closed and preserves original bytes',async t=>{
 const fixture=await archivedFixture(t,{active:1,archived:damage==='archive-overflow'?2049:1});let ledger=JSON.parse(await fs.readFile(fixture.file,'utf8'));
 if(damage==='duplicate-key')ledger.tasks[1].idempotencyKey=ledger.tasks[0].idempotencyKey;
 if(damage==='duplicate-id')ledger.tasks[1].taskId=ledger.tasks[0].taskId;
 if(damage==='active-archived')ledger.tasks[1].status='running';
 const before=JSON.stringify(ledger);await fs.writeFile(fixture.file,before);let calls=0;
 await assert.rejects(openArchiveStore({directory:fixture.directory,providers:{ask:async()=>{calls++;}}}),e=>e.taskCode==='store_unavailable');assert.equal(await fs.readFile(fixture.file,'utf8'),before);assert.equal(calls,0);
});

for(const phase of ['before','after','enospc'])test('interrupted archive commit '+phase+' retains exactly one complete record across restart',async t=>{
 const {fork}=await import('node:child_process'),fixture=await archivedFixture(t),before=await fs.readFile(fixture.file,'utf8');
 const child=fork(new URL('./helpers/task-archive-crash-worker.mjs',import.meta.url),[fixture.directory,fixture.tasks[0].taskId,phase],{stdio:['ignore','ignore','ignore','ipc']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Fault fixture did not pause')),5000);child.on('error',reject);child.on('message',m=>{if(m.paused===phase||(phase==='enospc'&&m.error==='store_unavailable')){clearTimeout(timer);resolve();}});child.on('exit',()=>reject(new Error('Fixture exited early')));});
 const exit=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exit;
 if(phase!=='after')assert.equal(await fs.readFile(fixture.file,'utf8'),before);
 const recovered=await openArchiveStore({directory:fixture.directory,providers:{ask:async()=>{throw new Error('No inference');}}});t.after(()=>recovered.shutdown());
 const result=await recovered.exportTask(fixture.tasks[0].taskId);for(const key of ['taskId','attemptId','idempotencyKey','inputDigest','snapshot','result'])assert.deepEqual(result.task[key],fixture.tasks[0][key]);assert.equal(!!result.task.archivedAt,phase==='after');
 assert.equal((await recovered.list()).length+(await recovered.listArchived()).total,1);assert.equal((await recovered.submit(submission({idempotencyKey:'fixture-0'}))).created,false);
});

test('archive identity is compared inside the write queue and remains enforced for already archived records',async t=>{
 const {store,calls,directory}=await setup(t),{task}=await store.submit(submission()),done=await until(store,task.taskId,'succeeded');
 const expected={taskId:done.taskId,attemptId:done.attemptId,inputDigest:done.inputDigest};
 const [valid,conflict]=await Promise.allSettled([store.archive(done.taskId,expected),store.archive(done.taskId,{...expected,inputDigest:'0'.repeat(64)})]);
 assert.equal(valid.status,'fulfilled');assert.ok(valid.value.archivedAt);assert.equal(conflict.status,'rejected');assert.equal(conflict.reason.taskCode,'task_identity_conflict');assert.equal(calls.length,1);
 const disk=JSON.parse(await fs.readFile(path.join(directory,'tasks.json'),'utf8'));assert.equal(disk.tasks.length,1);assert.equal(disk.tasks[0].attemptId,expected.attemptId);assert.equal(disk.tasks[0].archivedAt,valid.value.archivedAt);
});

test('explicit model is immutable input, survives restart and reaches every summary stage',async t=>{
 const {store,calls,directory}=await setup(t,async data=>({answer:'Summary',citations:[data.segments[0].id],requested_model:data.model}));
 const input=submission({model:'authored-model',segments:[{id:'a',text:'A'.repeat(16000)},{id:'b',text:'B'.repeat(100)}]});
 const {task}=await store.submit(input);const done=await until(store,task.taskId,'succeeded');
 assert.equal(calls.length,3);assert.ok(calls.every(call=>call.data.model==='authored-model'));
 assert.equal(done.model,'authored-model');assert.equal(done.result.requested_model,'authored-model');
 await assert.rejects(store.submit({...input,model:'other-model'}),error=>error.status===409);
 await assert.rejects(store.submit({...input,model:''}),error=>error.status===409);
 await store.shutdown();let restartCalls=0;
 const recovered=await createTaskStore({directory,providers:{ask:async()=>{restartCalls++;}}});
 try{assert.deepEqual(await recovered.get(task.taskId),done);assert.equal((await recovered.submit(input)).created,false);assert.equal(restartCalls,0);}finally{await recovered.shutdown();}
});
test('default model retains legacy digest while invalid models never start tasks',async t=>{
 const {store,calls}=await setup(t);const first=await store.submit(submission());
 assert.equal((await store.submit(submission({model:''}))).task.inputDigest,first.task.inputDigest);
 assert.equal((await store.submit(submission({model:null}))).created,false);
 for(const model of ['--help','vendor/model',{},'x'.repeat(121)])await assert.rejects(store.submit(submission({idempotencyKey:'bad-model',model})),error=>error.status===400);
 await until(store,first.task.taskId,'succeeded');assert.equal(calls.length,1);assert.equal(Object.hasOwn(calls[0].data,'model'),false);
});
