import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {startBridge} from '../desktop/server.mjs';
const require=createRequire(import.meta.url),Tasks=require('../reader/task-client.js');
const doc={key:'authored',segments:[{id:'a',text:'One authored source.'}],notes:{a:'Private reading note'}};
const input=()=>Tasks.submission(doc,{revision:'lifetime-1/rev-1',provider:'codex',idempotencyKey:'author-intent-1',consent:true});
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:value=>resolve(value)};};
async function setup(t,{ask=async()=>({answer:'Summary',citations:['a']})}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-task-api-')),calls=[];
 const providers={ask:async(data,options)=>{calls.push({data,options});return ask(data,options);},status:()=>{throw new Error('Unexpected CLI status probe');}};
 const server=await startBridge({port:0,taskDirectory:directory,providers});
 t.after(async()=>{await new Promise(resolve=>server.shutdown(resolve));await fs.rm(directory,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const request=(relative,options)=>fetch(origin+'/'+relative,{...options,headers:{...options?.headers,Origin:origin}});
 return {directory,server,origin,calls,client:Tasks.createClient({fetch:request})};
}
async function until(client,id,status){for(let i=0;i<100;i++){const {task}=await client.get(id);if(task.status===status)return task;await new Promise(r=>setTimeout(r,5));}throw new Error('Task did not become '+status);}

test('executor capability describes support separately from unchecked provider availability without inference',async t=>{
 const {client,calls,origin}=await setup(t);const capability=await client.describe();
 assert.equal(capability.protocolVersion,1);assert.equal(capability.enabled,true);assert.equal(capability.executor.online,true);assert.deepEqual(capability.supportedTaskKinds,['summary']);
 assert.equal(capability.providers.codex.availability,'not_checked');assert.equal(capability.remoteSubmission,false);assert.equal(calls.length,0);
 assert.equal((await fetch(origin+'/task-client.js')).status,200);
 assert.equal((await fetch(origin+'/background-summary.js')).status,200);
});

test('disconnect after submit does not cancel; a fresh client queries by key and safely accepts exact revision',async t=>{
 const gate=deferred(),{client,calls,origin}=await setup(t,{ask:()=>gate.promise}),value=input();
 const controller=new AbortController();const receipt=await client.submit(value,{signal:controller.signal});controller.abort();
 await until(client,receipt.task.taskId,'running');assert.equal(calls[0].options.signal.aborted,false);
 const refreshed=Tasks.createClient({fetch:(relative,options)=>fetch(origin+'/'+relative,{...options,headers:{...options?.headers,Origin:origin}})});
 const found=await refreshed.findSubmission(value.idempotencyKey);assert.equal(found.task.taskId,receipt.task.taskId);
 const duplicate=await refreshed.submit(value);assert.equal(duplicate.created,false);assert.equal(calls.length,1);
 gate.resolve({answer:'Summary',citations:['a']});const done=await until(refreshed,receipt.task.taskId,'succeeded');
 const before=JSON.stringify(doc),answer=Tasks.resultFor(done,doc,'lifetime-1/rev-1');assert.equal(answer.answer,'Summary');assert.equal(JSON.stringify(doc),before);
 for(const [document,revision] of [[{...doc,key:'other'},'lifetime-1/rev-1'],[doc,'lifetime-2/rev-1'],[{...doc,segments:[{id:'a',text:'Newer draft.'}]},'lifetime-1/rev-1']])assert.equal(Tasks.resultFor(done,document,revision),null);
 assert.equal(calls[0].data.segments[0].text,'One authored source.');assert.ok(!JSON.stringify(calls[0].data).includes('Private reading note'));
});

test('unknown submission receipt is exposed without automatic resubmit or new idempotency key',async()=>{
 let calls=0;const client=Tasks.createClient({fetch:async()=>{calls++;throw new TypeError('Network lost');}});
 await assert.rejects(client.submit(input()),error=>error.outcomeUnknown===true&&error.idempotencyKey==='author-intent-1');assert.equal(calls,1);
});

test('cancel API distinguishes durable request from settled cancellation; late result is discarded',async t=>{
 const gate=deferred(),{client,calls}=await setup(t,{ask:()=>gate.promise}),receipt=await client.submit(input());await until(client,receipt.task.taskId,'running');
 const cancelled=await client.cancel(receipt.task.taskId);assert.equal(cancelled.task.status,'cancel_requested');assert.equal(cancelled.task.cancellation.executionSettled,false);assert.equal(calls[0].options.signal.aborted,true);
 gate.resolve({answer:'Late',citations:['a']});const final=await until(client,receipt.task.taskId,'cancelled');assert.equal(final.result,undefined);assert.equal(final.cancellation.executionSettled,true);
});

test('versioned task mutations preserve existing host, origin and JSON boundaries',async t=>{
 const {client,origin,calls,server}=await setup(t);
 for(const endpoint of ['/api/v1/tasks','/api/v1/tasks/00000000-0000-4000-8000-000000000000/cancel','/api/v1/tasks/00000000-0000-4000-8000-000000000000/archive','/api/v1/tasks/00000000-0000-4000-8000-000000000000/restore']){
  for(const Origin of [undefined,'null','https://example.org'])assert.equal((await fetch(origin+endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(Origin?{Origin}: {})},body:JSON.stringify(input())})).status,403);
  assert.equal((await fetch(origin+endpoint,{method:'POST',headers:{Origin:origin,'Content-Type':'text/plain'},body:'{}'})).status,400);
 }
 assert.equal((await fetch(origin+'/api/v1/tasks',{headers:{Origin:'https://example.org'}})).status,403);
 const wrong=await new Promise((resolve,reject)=>{const request=http.get({host:'127.0.0.1',port:server.address().port,path:'/api/v1/executor',headers:{Host:'attacker.example'}},res=>{res.resume();resolve(res.statusCode);});request.on('error',reject);});assert.equal(wrong,403);
 assert.equal(calls.length,0);assert.deepEqual((await client.list()).tasks,[]);
});

test('existing foreground ask still cancels on connection close and never creates background tasks',async t=>{
 const gate=deferred(),{client,origin,calls}=await setup(t,{ask:()=>gate.promise});
 const controller=new AbortController(),pending=fetch(origin+'/api/ask',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({consent:true,question:'Question',provider:'codex',language:'en',segments:doc.segments}),signal:controller.signal}).catch(()=>{});
 for(let i=0;!calls.length&&i<100;i++)await new Promise(r=>setTimeout(r,5));assert.equal(calls.length,1);controller.abort();await pending;
 for(let i=0;!calls[0].options.signal.aborted&&i<100;i++)await new Promise(r=>setTimeout(r,5));assert.equal(calls[0].options.signal.aborted,true);assert.deepEqual((await client.list()).tasks,[]);gate.resolve({answer:'Late',citations:['a']});
});

test('lost ACK after server acceptance is recovered with the same key and never executes twice',async t=>{
 const gate=deferred(),{client,origin,calls}=await setup(t,{ask:()=>gate.promise});
 const unreliable=Tasks.createClient({fetch:async(relative,options)=>{await fetch(origin+'/'+relative,{...options,headers:{...options.headers,Origin:origin}});throw new TypeError('ACK lost');}});
 await assert.rejects(unreliable.submit(input()),error=>error.outcomeUnknown===true);
 const found=await client.findSubmission(input().idempotencyKey);assert.ok(found.task.taskId);await until(client,found.task.taskId,'running');
 assert.equal((await client.submit(input())).task.taskId,found.task.taskId);assert.equal(calls.length,1);gate.resolve({answer:'Summary',citations:['a']});await until(client,found.task.taskId,'succeeded');
});

test('unreadable task storage disables tasks but preserves independent reader and foreground endpoints',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-task-unavailable-'));await fs.writeFile(path.join(directory,'tasks.json'),'truncated');
 const server=await startBridge({port:0,taskDirectory:directory,providers:{ask:async()=>({answer:'Foreground remains available',citations:['a']})}});
 t.after(async()=>{await new Promise(resolve=>server.shutdown(resolve));await fs.rm(directory,{recursive:true,force:true});});const origin=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(origin+'/')).status,200);const descriptor=await fetch(origin+'/api/v1/executor').then(r=>r.json());assert.equal(descriptor.enabled,false);assert.equal(descriptor.unavailable.code,'store_unavailable');assert.equal((await fetch(origin+'/api/v1/tasks')).status,503);
 const foreground=await fetch(origin+'/api/ask',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({consent:true})});assert.equal(foreground.status,200);
 assert.equal(await fs.readFile(path.join(directory,'tasks.json'),'utf8'),'truncated');
});

test('packaged task runner resolves summary code from its explicit reader resource directory',async t=>{
 const {createTaskStore}=await import('../desktop/tasks.mjs'),directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-task-package-')),reader=path.join(directory,'resources','reader');await fs.mkdir(reader,{recursive:true});
 await fs.copyFile(new URL('../reader/summary.js',import.meta.url),path.join(reader,'summary.js'));await fs.copyFile(new URL('../reader/package.json',import.meta.url),path.join(reader,'package.json'));
 const store=await createTaskStore({directory:path.join(directory,'tasks'),readerDirectory:reader,providers:{ask:async()=>({answer:'Packaged summary',citations:['a']})}});
 t.after(async()=>{await store.shutdown();await fs.rm(directory,{recursive:true,force:true});});const receipt=await store.submit(input());
 for(let i=0;i<100&&(await store.get(receipt.task.taskId)).status!=='succeeded';i++)await new Promise(r=>setTimeout(r,5));assert.equal((await store.get(receipt.task.taskId)).result.answer,'Packaged summary');
 const packaging=await fs.readFile(new URL('../desktop/package.mjs',import.meta.url),'utf8');assert.match(packaging,/'tasks\.mjs'/);assert.match(packaging,/'task-client\.js'/);
});

test('standalone recovery validates completed receipts and returns only independent copied data',()=>{
 const task={taskId:'task-1',attemptId:'attempt-1',kind:'summary',status:'succeeded',document:{key:'authored',revision:'original-lifetime/revision'},provider:'codex',createdAt:'2026-10-14T00:00:00Z',idempotencyKey:'must-not-transfer-intent',result:{purpose:'summary',answer:'Authored result.',citations:['a'],input_snapshot:{version:1,segments:[{id:'a',text:'Authored source.',start:0,notes:'Private note'}]},privateField:'not a result'}};
 const saved=Tasks.recoveryFor(task);assert.equal(saved.format,'coconut-background-summary-result');assert.equal(saved.task.document.revision,task.document.revision);assert.equal(saved.task.idempotencyKey,undefined);assert.equal(saved.result.privateField,undefined);assert.deepEqual(saved.result.input_snapshot.segments,[{id:'a',text:'Authored source.'}]);
 saved.task.document.key='changed';saved.result.input_snapshot.segments[0].text='changed';assert.equal(task.document.key,'authored');assert.equal(task.result.input_snapshot.segments[0].text,'Authored source.');
 for(const status of ['queued','running','cancel_requested','cancelled','failed','interrupted'])assert.equal(Tasks.recoveryFor({...task,status}),null);
 for(const patch of [{purpose:'question'},{answer:''},{answer:'x'.repeat(8001)},{citations:[]},{citations:['missing']},{input_snapshot:{version:2,segments:task.result.input_snapshot.segments}},{input_snapshot:{version:1,segments:[{id:'a',text:'one'},{id:'a',text:'two'}]}}]){
  const bad={...task,result:{...task.result,...patch}};assert.equal(Tasks.recoveryFor(bad),null);
  assert.equal(Tasks.resultFor(bad,doc,task.document.revision),null);
 }
});

test('development bridge restart makes completed results independently retrievable without a browser journal or new inference',async t=>{
 const {startDevelopmentBridge}=await import('../desktop/dev.mjs'),directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-dev-result-rescue-'));let calls=0,server;
 const providers={ask:async()=>{calls++;return {answer:'Persisted development result.',citations:['a']};},status:()=>{throw new Error('No login probes');}};
 t.after(async()=>{if(server)await new Promise(resolve=>server.shutdown(resolve));await fs.rm(directory,{recursive:true,force:true});});
 let running=await startDevelopmentBridge({libraryDirectory:null,port:0,taskDirectory:directory,providers});server=running.server;
 const connect=origin=>Tasks.createClient({fetch:(relative,options)=>fetch(origin+'/'+relative,{...options,headers:{...options?.headers,Origin:origin}})});
 let client=connect(running.origin);const submitted=await client.submit(input()),finished=await until(client,submitted.task.taskId,'succeeded');await new Promise(resolve=>server.shutdown(resolve));server=null;
 running=await startDevelopmentBridge({libraryDirectory:null,port:0,taskDirectory:directory,providers});server=running.server;client=connect(running.origin);
 const listed=(await client.list()).tasks;assert.equal(listed.length,1);assert.equal(listed[0].result,undefined);const recovered=Tasks.recoveryFor((await client.get(listed[0].taskId)).task);
 assert.equal(recovered.task.taskId,finished.taskId);assert.equal(recovered.task.attemptId,finished.attemptId);assert.equal(recovered.result.answer,'Persisted development result.');assert.deepEqual(recovered.result.input_snapshot,finished.result.input_snapshot);assert.equal(calls,1);assert.equal(recovered.documents,undefined);assert.equal(recovered.background_summary_lifetime,undefined);
});


test('archive HTTP endpoints page, export and restore the original durable identity without inference',async t=>{
 const {client,calls,origin}=await setup(t),value=input(),receipt=await client.submit(value);await until(client,receipt.task.taskId,'succeeded');
 assert.equal((await client.describe()).archive.supported,true);const archived=await client.archive(receipt.task.taskId);assert.ok(archived.task.archivedAt);assert.deepEqual((await client.list()).tasks,[]);
 const page=await client.listArchived({limit:1});assert.equal(page.total,1);assert.equal(page.tasks[0].result,undefined);assert.equal(page.nextCursor,null);
 const found=await client.findSubmission(value.idempotencyKey);assert.equal(found.task.taskId,receipt.task.taskId);assert.ok(found.task.archivedAt);
 const exported=await client.exportTask(receipt.task.taskId);assert.equal(exported.record.task.idempotencyKey,value.idempotencyKey);assert.deepEqual(exported.record.task.snapshot,value.segments);assert.equal(exported.record.task.result.answer,'Summary');
 for(const endpoint of ['/api/v1/tasks?archived=true','/api/v1/tasks/'+receipt.task.taskId+'/export'])assert.equal((await fetch(origin+endpoint,{headers:{Origin:'https://example.org'}})).status,403);
 await assert.rejects(client.listArchived({limit:51}),e=>e.status===400);await assert.rejects(client.listArchived({after:'bad'}),e=>e.status===400);
 assert.equal((await client.submit(value)).created,false);const restored=await client.restore(receipt.task.taskId);assert.equal(restored.task.archivedAt,undefined);assert.equal(restored.task.attemptId,receipt.task.attemptId);assert.equal((await client.listArchived()).total,0);assert.equal(calls.length,1);
});

test('guarded single archive uses a narrow v2 request envelope and immutable preconditions without changing v1 receipts',async t=>{
 const {client,calls,origin}=await setup(t),{task}=await client.submit(input()),done=await until(client,task.taskId,'succeeded');
 assert.equal((await client.describe()).archive.identityPrecondition,true);
 const expected={taskId:done.taskId,attemptId:done.attemptId,inputDigest:done.inputDigest};
 for(const [key,value] of [['taskId','00000000-0000-4000-8000-000000000000'],['attemptId','00000000-0000-4000-8000-000000000000'],['inputDigest','0'.repeat(64)]])await assert.rejects(client.archive(done.taskId,{expected:{...expected,[key]:value}}),error=>error.status===409&&error.code==='task_identity_conflict');
 assert.equal((await client.get(done.taskId)).task.archivedAt,undefined);
 for(const body of [{protocolVersion:2},{protocolVersion:2,expected:null},{protocolVersion:2,expected:{}},{protocolVersion:2,expected:{...expected,attemptId:'invalid'}},{protocolVersion:1,expected}]){
  const result=await fetch(origin+'/api/v1/tasks/'+done.taskId+'/archive',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(result.status,400);
 }
 for(const action of ['restore']){
  const response=await fetch(origin+'/api/v1/tasks/'+done.taskId+'/'+action,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:2,expected})});assert.equal(response.status,400);
 }
 const invalidSubmit=await fetch(origin+'/api/v1/tasks',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({...input(),protocolVersion:2,expected})});assert.equal(invalidSubmit.status,400);
 const receipt=await client.archive(done.taskId,{expected});assert.equal(receipt.protocolVersion,1);assert.ok(receipt.task.archivedAt);
 await assert.rejects(client.archive(done.taskId,{expected:{...expected,attemptId:'00000000-0000-4000-8000-000000000000'}}),error=>error.status===409);
 assert.equal((await client.archive(done.taskId,{expected})).task.archivedAt,receipt.task.archivedAt);await client.restore(done.taskId);assert.equal((await client.get(done.taskId)).task.archivedAt,undefined);assert.equal(calls.length,1);
});

test('guarded identity never makes running or unsettled cancellation archivable',async t=>{
 const gate=deferred(),{client,calls}=await setup(t,{ask:()=>gate.promise}),{task}=await client.submit(input());const running=await until(client,task.taskId,'running');
 const expected={taskId:running.taskId,attemptId:running.attemptId,inputDigest:running.inputDigest};
 await assert.rejects(client.archive(task.taskId,{expected}),error=>error.status===409&&error.code==='task_not_archivable');
 await client.cancel(task.taskId);await assert.rejects(client.archive(task.taskId,{expected}),error=>error.status===409&&error.code==='task_not_archivable');
 gate.resolve({answer:'Late',citations:['a']});await until(client,task.taskId,'cancelled');assert.ok((await client.archive(task.taskId,{expected})).task.archivedAt);assert.equal(calls.length,1);
});

test('same-origin replacement ledger with the same taskId cannot satisfy a guarded archive for another attempt',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-archive-directory-'));let server;
 t.after(async()=>{if(server?.listening)await new Promise(resolve=>server.shutdown(resolve));await fs.rm(directory,{recursive:true,force:true});});
 const original=path.join(directory,'original'),alternate=path.join(directory,'alternate');let calls=0;
 server=await startBridge({port:0,taskDirectory:original,providers:{ask:async()=>{calls++;return {answer:'Authored result',citations:['a']};}}});
 const port=server.address().port,origin=`http://127.0.0.1:${port}`,client=Tasks.createClient({fetch:(relative,options)=>fetch(origin+'/'+relative,{...options,headers:{...options?.headers,Origin:origin}})});
 const {task}=await client.submit(input()),done=await until(client,task.taskId,'succeeded'),expected={taskId:done.taskId,attemptId:done.attemptId,inputDigest:done.inputDigest};
 await new Promise(resolve=>server.shutdown(resolve));const ledger=JSON.parse(await fs.readFile(path.join(original,'tasks.json'),'utf8'));ledger.tasks[0].attemptId='00000000-0000-4000-8000-000000000000';await fs.mkdir(alternate);await fs.writeFile(path.join(alternate,'tasks.json'),JSON.stringify(ledger));
 server=await startBridge({port,taskDirectory:alternate,providers:{ask:async()=>{throw new Error('No new execution is authorized');}}});
 await assert.rejects(client.archive(task.taskId,{expected}),error=>error.status===409&&error.code==='task_identity_conflict');assert.equal((await client.get(task.taskId)).task.archivedAt,undefined);assert.equal(calls,1);
 await new Promise(resolve=>server.shutdown(resolve));server=await startBridge({port,taskDirectory:original,providers:{ask:async()=>{throw new Error('No new execution is authorized');}}});
 assert.ok((await client.archive(task.taskId,{expected})).task.archivedAt);assert.equal(calls,1);
});

test('switching to an authored legacy v1 HTTP server after capability read rejects guarded writes instead of ignoring identity',async t=>{
 let archived=false;const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);const status=body.protocolVersion===1?200:400;
  if(status===200)archived=true;res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(status===200?{protocolVersion:1,task:{}}:{code:'invalid_request',error:'任务协议版本无效'}));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const origin=`http://127.0.0.1:${server.address().port}`,client=Tasks.createClient({fetch:(relative,options)=>fetch(origin+'/'+relative,options)});
 await assert.rejects(client.archive('00000000-0000-4000-8000-000000000001',{expected:{taskId:'00000000-0000-4000-8000-000000000001',attemptId:'00000000-0000-4000-8000-000000000002',inputDigest:'0'.repeat(64)}}),error=>error.status===400);assert.equal(archived,false);
});
