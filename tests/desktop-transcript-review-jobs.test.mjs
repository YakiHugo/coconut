import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createLibraryStore} from '../desktop/library-store.mjs';
import {createTranscriptReviewJobs} from '../desktop/transcript-review-jobs.mjs';
import {createTranscriptReviewer} from '../desktop/transcript-review.mjs';
import {startBridge} from '../desktop/server.mjs';
import R from '../shared/transcript-review.js';
const document=()=>({schema_version:1,key:'one',title:'对话刘元',source_url:'https://example.test/episode',notes:{a:'my private note'},segments:[{id:'a',start:0,end:1,text:'刘源来了',speaker:null}]});
const output={edits:[{cue_id:'a',original:'刘源',replacement:'刘元',category:'entity',basis:'节目标题'}],issues:[]};
const until=async fn=>{for(let i=0;i<100;i++){const value=fn();if(value)return value;await delay(10);}throw Error('timeout');};
async function fixture(t,structured=async()=>output){
 const directory=await mkdtemp(path.join(tmpdir(),'coconut-review-jobs-')),library=await createLibraryStore({directory:path.join(directory,'library')});
 const commit=(doc,action='put')=>library.commit({protocolVersion:1,epoch:library.describe().epoch,key:doc.key,receiptKey:randomUUID(),expected:library.get(doc.key)?.token||null,action,...(action==='put'?{document:doc}:{})});commit(document());
 const reviewer=createTranscriptReviewer({providers:{structured}}),options={directory:path.join(directory,'reviews'),libraryStore:library,reviewer};let jobs=await createTranscriptReviewJobs(options);
 t.after(async()=>{await jobs.shutdown();library.close();await rm(directory,{recursive:true,force:true});});
 const input=()=>({protocolVersion:1,consent:true,operation_id:randomUUID(),key:'one',provider:'codex',source_signature:R.signature(library.get('one').document)});
 return {directory,library,commit,input,get jobs(){return jobs;},async restart(){await jobs.shutdown();jobs=await createTranscriptReviewJobs(options);}};
}
test('durable review excludes notes, applies to latest personal data, and survives restart idempotently',async t=>{
 let release;const gate=new Promise(r=>release=r);let calls=0;
 const f=await fixture(t,async(provider,input)=>{calls++;assert.ok(!input.includes('my private note'));await gate;return output;});
 const input=f.input(),job=f.jobs.create(input);assert.equal(f.jobs.create(input).id,job.id);
 await until(()=>f.jobs.get(job.id).state==='running');const current=f.library.get('one').document;f.commit({...current,notes:{a:'new note'},project_note:'concurrent personal edit'});
 release();await until(()=>f.jobs.get(job.id).state==='ready');await f.restart();assert.equal(calls,1);
 await f.jobs.action(job.id,'apply');const saved=f.library.get('one');assert.equal(saved.document.segments[0].text,'刘元来了');assert.equal(saved.document.segments[0].original_text,'刘源来了');assert.equal(saved.document.notes.a,'new note');assert.equal(saved.document.project_note,'concurrent personal edit');
 await f.jobs.action(job.id,'apply');assert.equal(f.library.get('one').token.revision,saved.token.revision);assert.equal(calls,1);
});
test('changed source and a deleted/restored lifetime cannot receive an old result',async t=>{
 const f=await fixture(t),job=f.jobs.create(f.input());await until(()=>f.jobs.get(job.id).state==='ready');
 const current=f.library.get('one').document;f.commit({...current,segments:[{...current.segments[0],text:'已人工修改'}]});await assert.rejects(f.jobs.action(job.id,'apply'),/已变化/);
 f.commit(f.library.get('one').document,'delete');f.commit(document(),'restore');assert.throws(()=>f.jobs.get(job.id),/删除或替换/);assert.deepEqual(f.jobs.list('one'),[]);
});
test('cancellation prevents a late response from publishing and retry reuses the original request',async t=>{
 let release;const gate=new Promise(r=>release=r);let calls=0;
 const f=await fixture(t,async()=>{calls++;if(calls===1)await gate;return output;}),job=f.jobs.create(f.input());await until(()=>calls===1);
 await f.jobs.action(job.id,'cancel');release();await delay(20);assert.equal(f.jobs.get(job.id).state,'cancelled');
 await f.jobs.action(job.id,'retry');await until(()=>f.jobs.get(job.id).state==='ready');assert.equal(calls,2);
});
test('cancelling before queue dispatch skips the model and lets the next task run',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return output;}),cancelled=f.jobs.create(f.input());
 assert.equal(cancelled.state,'queued');assert.equal((await f.jobs.action(cancelled.id,'cancel')).state,'cancelled');
 const next=f.jobs.create(f.input());await until(()=>f.jobs.get(next.id).state==='ready');
 assert.equal(f.jobs.get(cancelled.id).state,'cancelled');assert.equal(calls,1);
});
test('HTTP review enforces same origin and explicit submission without request-bound cancellation',async t=>{
 const f=await fixture(t),server=await startBridge({port:0,reviewJobs:f.jobs});t.after(()=>server.shutdown());const origin='http://127.0.0.1:'+server.address().port;
 const send=(route,body,headers={})=>fetch(origin+'/api/v1/transcript-review/'+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await send('jobs',f.input(),{Origin:'https://other.test'})).status,403);
 assert.equal((await send('jobs',{...f.input(),consent:false})).status,400);
 const response=await send('jobs',f.input());assert.equal(response.status,202);const {job}=await response.json();await until(()=>f.jobs.get(job.id).state==='ready');
 assert.equal((await send('jobs/'+job.id+'/apply',{protocolVersion:1})).status,200);assert.equal(f.library.get('one').document.segments[0].text,'刘元来了');
 // server owns this injected service; avoid double-shutdown in fixture cleanup.
 const original=f.jobs.shutdown;let stopped=false;f.jobs.shutdown=async()=>{if(!stopped){stopped=true;await original();}};
});
