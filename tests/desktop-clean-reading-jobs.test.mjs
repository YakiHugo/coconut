import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import D from '../reader/disfluency.js';
import {createLibraryStore} from '../desktop/library-store.mjs';
import {createCleanReadingJobs} from '../desktop/clean-reading-jobs.mjs';
import {startBridge} from '../desktop/server.mjs';
const document=()=>({schema_version:1,key:'one',title:'自写稿',notes:{a:'PRIVATE_NOTE'},project_note:'PRIVATE_PROJECT',ai_answers:[{text:'PRIVATE_AI'}],segments:[{id:'a',start:1,end:5,text:'我我觉得值得认真讨论，然后继续。',speaker:'发言者'}]});
async function until(fn){for(let i=0;i<200;i++){const result=fn();if(result)return result;await delay(10);}throw Error('timeout');}
async function fixture(t,prepare){
 const directory=await mkdtemp(path.join(tmpdir(),'coconut-clean-jobs-')),library=await createLibraryStore({directory:path.join(directory,'library')});let calls=0,identity='authored-v1';
 const commit=(doc,action='put')=>library.commit({protocolVersion:1,epoch:library.describe().epoch,key:doc.key,receiptKey:randomUUID(),expected:library.get(doc.key)?.token||null,action,...(action==='put'?{document:doc}:{})});commit(document());
 const planner={identity:async()=>identity,prepare:async(doc,options)=>{calls++;assert.ok(!JSON.stringify(doc).includes('PRIVATE_'));await prepare?.(doc,options);
  return {identity,reading_cleanup:{version:1,policyVersion:'authored-v1',sourceSignature:D.signature(doc),decisions:[{cue_id:'a',from:0,to:1,action:'hide',reason:'authored_restart'}],marks:[],breaks:[],stats:{edits:1,llmCalls:options.provider?1:0}}};}};
 const options={directory:path.join(directory,'jobs'),libraryStore:library,planner};let jobs=await createCleanReadingJobs(options);
 t.after(async()=>{await jobs.shutdown();library.close();await rm(directory,{recursive:true,force:true});});
 return {directory,library,commit,input:(extra={})=>({protocolVersion:1,operation_id:randomUUID(),key:'one',source_signature:D.signature(library.get('one').document),...extra}),get jobs(){return jobs;},get calls(){return calls;},changePolicy(){identity='changed';},async restart(){await jobs.shutdown();jobs=await createCleanReadingJobs(options);}};
}
test('default job is local-only, preserves private edits and clocks, and replays after restart without work',async t=>{
 let release;const gate=new Promise(r=>release=r);const f=await fixture(t,async(doc,options)=>{assert.equal(options.provider,'');await gate;});
 const input=f.input(),job=await f.jobs.create(input);assert.equal((await f.jobs.create(input)).id,job.id);await until(()=>f.calls===1);
 f.commit({...f.library.get('one').document,notes:{a:'new private note'}});release();await until(()=>f.jobs.get(job.id).state==='ready');await f.restart();
 await f.jobs.action(job.id,'apply');let record=f.library.get('one');assert.deepEqual(record.document.segments,document().segments);assert.equal(record.document.notes.a,'new private note');assert.equal(record.document.reading_cleanup.stats.llmCalls,0);
 const revision=record.token.revision;await f.jobs.action(job.id,'apply');assert.equal(f.library.get('one').token.revision,revision);assert.equal(f.calls,1);
});
test('fallback needs explicit consent; source conflicts and deleted lifetimes reject old results',async t=>{
 const f=await fixture(t);await assert.rejects(f.jobs.create(f.input({fallback:true,consent:false})),/确认/);
 const job=await f.jobs.create(f.input({fallback:true,consent:true}));await until(()=>f.jobs.get(job.id).state==='ready');
 f.commit({...f.library.get('one').document,segments:[{...document().segments[0],text:'已人工校对的原话'}]});await assert.rejects(f.jobs.action(job.id,'apply'),/已变化/);
 f.commit(f.library.get('one').document,'delete');f.commit(document(),'restore');assert.throws(()=>f.jobs.get(job.id),/删除或替换/);assert.deepEqual(f.jobs.list('one'),[]);
});
test('queued cancellation skips work; interrupted retry cannot switch policy',async t=>{
 const f=await fixture(t),job=await f.jobs.create(f.input());await f.jobs.action(job.id,'cancel');await delay(30);assert.equal(f.calls,0);
 f.changePolicy();await assert.rejects(f.jobs.action(job.id,'retry'),/策略已变化/);
});
test('HTTP exposes explicit same-origin durable jobs and never starts fallback on reads',async t=>{
 const f=await fixture(t),server=await startBridge({port:0,cleanReadingJobs:f.jobs});t.after(()=>server.shutdown());const origin='http://127.0.0.1:'+server.address().port;
 const send=(route,body,originHeader=origin)=>fetch(origin+'/api/v1/clean-reading/'+route,{method:'POST',headers:{Origin:originHeader,'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await fetch(origin+'/api/v1/clean-reading/capabilities')).status,200);assert.equal(f.calls,0);
 assert.equal((await send('jobs',f.input(),'https://foreign.test')).status,403);
 assert.equal((await send('jobs',f.input({fallback:true,consent:false}))).status,400);
 const response=await send('jobs',f.input());assert.equal(response.status,202);const {job}=await response.json();await until(()=>f.jobs.get(job.id).state==='ready');
 assert.equal((await send('jobs/'+job.id+'/apply',{protocolVersion:1})).status,200);assert.equal(f.library.get('one').document.reading_cleanup.jobId,job.id);
});
