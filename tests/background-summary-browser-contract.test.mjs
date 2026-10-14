/** CPU-only contract for the exact real-HTTP fake-CLI browser harness. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {backgroundSummaryBridge,authoredSource,until} from './helpers/background-summary-bridge.mjs';
const Tasks=createRequire(import.meta.url)('../reader/task-client.js');
const payload=key=>({protocolVersion:1,kind:'summary',idempotencyKey:key,document:{key:'authored-document',revision:key},provider:'codex',consent:true,segments:authoredSource('Authored').segments});

test('browser harness serves actual production assets and enforces consent/idempotency before a fake CLI run',async t=>{
 const h=await backgroundSummaryBridge();t.after(()=>h.close());
 const html=await (await fetch(h.origin)).text();assert.match(html,/background-summary\.js/);
 for(const asset of ['task-client.js','background-summary.js'])assert.equal((await fetch(h.origin+'/'+asset)).status,200);
 const language=await h.request('/api/language-tools');assert.equal(language.status,200);assert.equal(language.ai.codex.ready,true);assert.equal(language.ai.claude.ready,false);assert.equal(h.invocations.length,0);
 const invalid=await h.request('/api/v1/tasks',{...payload('one'),consent:false});assert.equal(invalid.status,400);assert.equal(h.invocations.length,0);
 const first=await h.request('/api/v1/tasks',payload('one'));assert.equal(first.status,202);
 await until(()=>h.invocations.length===1);
 const duplicate=await h.request('/api/v1/tasks',payload('one'));assert.equal(duplicate.status,200);assert.equal(duplicate.task.taskId,first.task.taskId);assert.equal((await h.tasks()).length,1);assert.equal(h.invocations.length,1);
 assert.equal(JSON.stringify(h.invocations[0].input).includes('LOCAL NOTE'),false);
 h.invocations[0].release();const task=await h.waitTask(first.task.taskId,'succeeded');assert.equal(task.result.input_snapshot.segments.length,2);
});
test('browser harness holds real cancellation until a deliberately late fake CLI completion',async t=>{
 const h=await backgroundSummaryBridge();t.after(()=>h.close());const {task}=await h.request('/api/v1/tasks',payload('cancel'));
 await until(()=>h.invocations.length===1);assert.equal((await h.request('/api/v1/tasks/'+task.taskId+'/cancel',{protocolVersion:1})).task.status,'cancel_requested');
 assert.equal(h.invocations[0].signal.aborted,true);h.invocations[0].release();assert.equal((await h.waitTask(task.taskId,'cancelled')).result,undefined);
});
test('browser harness reopens the same real HTTP origin and disk ledger without restarting interrupted inference',async t=>{
 const h=await backgroundSummaryBridge();t.after(()=>h.close());const {task}=await h.request('/api/v1/tasks',payload('restart'));
 await until(()=>h.invocations.length===1);const origin=h.origin;await h.restart();assert.equal(h.origin,origin);assert.equal(h.invocations[0].signal.aborted,true);
 h.invocations[0].release();await h.invocations[0].settled;
 assert.equal((await h.waitTask(task.taskId,'interrupted')).result,undefined);assert.equal(h.invocations.length,1);
 assert.equal((await h.request('/api/v1/tasks',payload('restart'))).task.status,'interrupted');assert.equal(h.invocations.length,1);
});
test('browser harness preserves independently exportable completed source after executor restart',async t=>{
 const h=await backgroundSummaryBridge();t.after(()=>h.close());const {task}=await h.request('/api/v1/tasks',payload('standalone-result'));
 await until(()=>h.invocations.length===1);h.invocations[0].release();const completed=await h.waitTask(task.taskId,'succeeded');await h.restart();
 const listed=await h.tasks();assert.equal(listed[0].result,undefined);const receipt=Tasks.recoveryFor(await h.task(listed[0].taskId));
 assert.equal(receipt.task.taskId,task.taskId);assert.equal(receipt.result.answer,completed.result.answer);assert.deepEqual(receipt.result.input_snapshot,completed.result.input_snapshot);assert.equal(receipt.segments,undefined);assert.equal(receipt.documents,undefined);assert.equal(h.invocations.length,1);assert.deepEqual(h.posts,['/api/v1/tasks']);
});
test('browser harness switches independent task directories on the same origin without rerunning known intents',async t=>{
 const h=await backgroundSummaryBridge();t.after(()=>h.close());const origin=h.origin,{task:first}=await h.request('/api/v1/tasks',payload('original-directory'));
 await until(()=>h.invocations.length===1);h.invocations[0].release();await h.waitTask(first.taskId,'succeeded');
 await h.switchTaskDirectory('alternate');assert.equal(h.origin,origin);assert.equal((await h.request('/api/v1/executor')).enabled,true);assert.deepEqual(await h.tasks(),[]);
 const absent=await h.request('/api/v1/tasks/'+first.taskId);assert.equal(absent.status,404);assert.equal(absent.code,'not_found');assert.equal(h.invocations.length,1);
 const {task:second}=await h.request('/api/v1/tasks',payload('alternate-directory'));await until(()=>h.invocations.length===2);h.invocations[1].release();await h.waitTask(second.taskId,'succeeded');assert.notEqual(second.taskId,first.taskId);
 await h.switchTaskDirectory('original');assert.equal(h.origin,origin);assert.equal((await h.task(first.taskId)).status,'succeeded');assert.equal((await h.request('/api/v1/tasks/'+second.taskId)).status,404);assert.equal(h.invocations.length,2);assert.deepEqual(h.posts,['/api/v1/tasks','/api/v1/tasks']);
});


test('browser harness archive survives restart and complete rescue preserves original identity without another CLI run',async t=>{
 const h=await backgroundSummaryBridge();t.after(()=>h.close());const value=payload('archive-lifecycle'),{task}=await h.request('/api/v1/tasks',value);
 await until(()=>h.invocations.length===1);h.invocations[0].release();await h.waitTask(task.taskId,'succeeded');
 const original=(await h.request('/api/v1/tasks/'+task.taskId+'/export')).record.task;
 assert.ok((await h.request('/api/v1/tasks/'+task.taskId+'/archive',{protocolVersion:1})).task.archivedAt);assert.deepEqual(await h.tasks(),[]);await h.restart();
 const page=await h.request('/api/v1/tasks?archived=true&limit=20');assert.equal(page.total,1);assert.equal(page.tasks[0].taskId,task.taskId);
 const rescued=(await h.request('/api/v1/tasks/'+task.taskId+'/export')).record.task;for(const key of ['taskId','attemptId','idempotencyKey','inputDigest','snapshot','result'])assert.deepEqual(rescued[key],original[key]);
 assert.equal((await h.request('/api/v1/tasks',value)).created,false);assert.equal((await h.request('/api/v1/tasks/'+task.taskId+'/restore',{protocolVersion:1})).task.archivedAt,undefined);assert.equal((await h.tasks()).length,1);assert.equal(h.invocations.length,1);
});
test('browser checkpoint fixture reuses accepted first batch and a lost resume receipt by exact key',async t=>{
 const h=await backgroundSummaryBridge();t.after(()=>h.close());const input={...payload('checkpoint-resume-browser'),segments:Array.from({length:401},(_,i)=>({id:'cue-'+i,text:'Authored '+i}))};const {task}=await h.request('/api/v1/tasks',input);
 await until(()=>h.invocations.length===1);h.invocations[0].release();await until(()=>h.invocations.length===2);await h.restart();h.invocations[1].release();await h.invocations[1].settled;assert.equal(h.invocations.length,2);const interrupted=await h.task(task.taskId);assert.equal(interrupted.checkpoint.completed,1);
 const resume={protocolVersion:1,consent:true,resumeKey:'explicit-browser-resume',attemptId:task.attemptId,inputDigest:task.inputDigest};const received=await h.request('/api/v1/tasks/'+task.taskId+'/resume',resume);assert.equal(received.status,202);await until(()=>h.invocations.length===3);
 const found=await h.request('/api/v1/tasks/'+task.taskId+'?resumeKey='+resume.resumeKey);assert.equal(found.receipt.attemptId,received.task.attemptId);assert.equal((await h.request('/api/v1/tasks/'+task.taskId+'/resume',resume)).created,false);assert.equal(h.invocations.length,3);assert.deepEqual(h.invocations[2].input.transcript.map(x=>x.id),['cue-400']);h.invocations[2].release();await until(()=>h.invocations.length===4);h.invocations[3].release();assert.equal((await h.waitTask(task.taskId,'succeeded')).resume.remainingRequests,0);
});
