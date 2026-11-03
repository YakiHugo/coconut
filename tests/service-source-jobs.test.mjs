import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Readable} from 'node:stream';
import {createLibraryStore} from '../desktop/library-store.mjs';
import {createSourceMediaStore} from '../desktop/source-media.mjs';
import {createSourceJobs} from '../desktop/source-jobs.mjs';
import {startService} from '../server/main.mjs';
const doc={key:'server-podcast',title:'Authored episode',source_url:'https://example.test/episode',project_kind:'audio_only',podcast_source:{kind:'direct_media',media_url:'https://example.test/audio.mp3',media_kind:'audio'},segments:[]};
function commit(library,document,action='put'){return library.commit({protocolVersion:1,epoch:library.describe().epoch,key:document.key,receiptKey:randomUUID(),expected:library.get(document.key)?.token||null,action,...(action==='put'?{document}:{})});}
const missing=()=>Object.assign(Error('not found'),{taskCode:'ingestion_operation_not_found'});
async function until(fn,predicate){for(let attempt=0;attempt<100;attempt++){const value=await fn();if(predicate(value))return value;await delay(10);}throw Error('Timed out');}
async function fixture(t,{download,executor}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'coconut-source-jobs-'));
 const library=await createLibraryStore({directory});commit(library,doc);
 const media=await createSourceMediaStore({directory:path.join(directory,'media'),libraryStore:library});
 let calls=0;const podcastSources={downloadMedia:async(request,options)=>{calls++;return download?download(request,options):{body:Buffer.from('ID3 authored media'),type:'audio/mpeg'};}};
 executor??={status:async()=>({available:true}),recover:async()=>{throw missing();}};
 const options={directory:path.join(directory,'jobs'),libraryStore:library,mediaStore:media,podcastSources,executor};let jobs=await createSourceJobs(options);
 t.after(async()=>{await jobs.shutdown();await media.shutdown();library.close();await rm(directory,{recursive:true,force:true});});
 const create=kind=>jobs.create({protocolVersion:1,operation_id:randomUUID(),key:doc.key,source:media.owner(doc.key).source,kind,consent:true});
 return {directory,library,media,create,executor,options,get jobs(){return jobs;},get calls(){return calls;},async restart(){await jobs.shutdown();jobs=await createSourceJobs(options);}};
}
test('download persists directly on the server, deduplicates concurrent browsers and survives restart',async t=>{
 const f=await fixture(t);assert.equal(f.calls,0);const [a,b]=await Promise.all([f.create('download'),f.create('download')]);assert.equal(a.id,b.id);
 await until(()=>f.jobs.get(a.id),j=>j.state==='ready');const receipt=await f.media.read(doc.key);assert.equal(receipt.type,'audio/mpeg');assert.equal(f.calls,1);
 await f.restart();assert.equal((await f.jobs.list(doc.key))[0].id,a.id);assert.equal((await f.create('download')).id,a.id);assert.equal(f.calls,1);assert.deepEqual(await f.media.read(doc.key),receipt);
});
test('source replacement during acquisition never gives the new project old bytes',async t=>{
 let release;const gate=new Promise(resolve=>release=resolve),f=await fixture(t,{download:async()=>{await gate;return {body:Buffer.from('ID3 old'),type:'audio/mpeg'};}});
 const job=await f.create('download');await until(async()=>f.calls,n=>n===1);commit(f.library,{...doc,source_url:'https://example.test/new'});release();
 await until(()=>f.jobs.get(job.id),j=>j.state==='interrupted');assert.equal(await f.media.read(doc.key),null);assert.deepEqual(await f.jobs.list(doc.key),[]);await assert.rejects(f.jobs.action(job.id,'retry'),/来源已变化/);
});
test('download cancellation is explicit and shutdown never automatically retries interrupted acquisition',async t=>{
 const f=await fixture(t,{download:async(_,{signal})=>{await delay(10000,null,{signal});return {body:Buffer.from('late'),type:'audio/mpeg'};}});
 const first=await f.create('download');await until(async()=>f.calls,n=>n===1);assert.equal((await f.jobs.action(first.id,'cancel')).state,'cancelled');await f.restart();assert.equal(f.calls,1);assert.equal(await f.media.read(doc.key),null);
 await f.jobs.action(first.id,'retry');await until(async()=>f.calls,n=>n===2);await f.restart();assert.equal((await f.jobs.get(first.id)).state,'interrupted');await delay(30);assert.equal(f.calls,2);
});
test('ASR uses the verified stored asset, recovers uncertain upload receipts and retains project authority',async t=>{
 let operation,upstream,uploads=0,bytes;
 const executor={status:async()=>({available:true}),recover:async value=>{if(!upstream)throw missing();assert.deepEqual(value,operation);return upstream;},upload:async(body,value)=>{uploads++;bytes=Buffer.concat(await Array.fromAsync(body));const {signal,...fields}=value;operation={filename:fields.filename,language:fields.language,operation_id:fields.operation_id,fingerprint:fields.fingerprint,last_modified:fields.last_modified,size:bytes.length};upstream={id:'a'.repeat(32),state:'running'};throw Error('authored lost upload response');},action:async()=>upstream,result:async()=>({...upstream,transcript:{document:{schema_version:1,segments:[{id:'a',start:0,end:1,text:'Authored'}]}}})};
 const f=await fixture(t,{executor});const source=f.media.owner(doc.key).source;await f.media.save(doc.key,source,Readable.from([Buffer.from('ID3 authored bytes')]),{type:'audio/mpeg',name:'episode.mp3'});
 const job=await f.create('transcribe');await until(async()=>uploads,n=>n===1);await until(()=>f.jobs.get(job.id),j=>j.ingestionId===upstream.id);assert.equal(bytes.toString(),'ID3 authored bytes');
 await f.restart();assert.equal((await f.jobs.list(doc.key))[0].ingestionId,upstream.id);assert.equal((await f.create('transcribe')).id,job.id);assert.equal(uploads,1);
 upstream={...upstream,state:'ready'};assert.equal((await f.jobs.get(job.id)).state,'ready');assert.equal((await f.jobs.result(job.id)).ingestion.transcript.document.segments[0].text,'Authored');
 commit(f.library,{...doc,project_note:'keep notes',title:'Edit title'});assert.equal((await f.jobs.result(job.id)).job.id,job.id);
 commit(f.library,doc,'delete');commit(f.library,doc,'restore');assert.deepEqual(await f.jobs.list(doc.key),[]);await assert.rejects(f.jobs.result(job.id),/来源已变化/);
});
test('corrupt saved bytes are rejected before ASR upload and unknown operations do not silently retry',async t=>{
 let uploads=0;const executor={status:async()=>({available:true}),recover:async()=>{throw missing();},upload:async()=>{uploads++;throw Error('never');}};
 const f=await fixture(t,{executor}),source=f.media.owner(doc.key).source,receipt=await f.media.save(doc.key,source,Readable.from(['original']),{type:'audio/mpeg',name:'source.mp3'});
 await writeFile(path.join(f.directory,'media',receipt.sha256+'.media'),'changed!');await assert.rejects(f.create('transcribe'),/changed|integrity/);assert.equal(uploads,0);
});
test('missing consent, conflicting operation identity and stale source fail before any fetch',async t=>{
 const f=await fixture(t),base={protocolVersion:1,operation_id:randomUUID(),key:doc.key,source:f.media.owner(doc.key).source,kind:'download'};
 await assert.rejects(f.jobs.create(base));await assert.rejects(f.jobs.create({...base,consent:true,source:'0'.repeat(64)}));assert.equal(f.calls,0);
 await f.jobs.create({...base,consent:true});await assert.rejects(f.jobs.create({...base,consent:true,kind:'transcribe'}),/另一份来源/);
});
test('real authenticated HTTP accepts a source task independently of the response connection',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'coconut-source-task-http-'));let release;const gate=new Promise(resolve=>release=resolve);
 const {server,origin}=await startService({env:{COCONUT_PORT:'0',COCONUT_DATA_DIRECTORY:directory},podcastSources:{downloadMedia:async()=>{await gate;return {body:Buffer.from('ID3 independent'),type:'audio/mpeg'};}}});t.after(async()=>{await server.shutdown();await rm(directory,{recursive:true,force:true});});
 const post=async(route,value)=>{const response=await fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});assert.ok(response.ok);return response.json();};
 const epoch=(await(await fetch(origin+'/api/v1/library')).json()).epoch;await post('/api/v1/library/commit',{protocolVersion:1,epoch,key:doc.key,receiptKey:randomUUID(),expected:null,action:'put',document:doc});
 const {createHash}=await import('node:crypto'),{sourceMediaIdentity}=await import('../shared/source-media.js');const source=createHash('sha256').update(sourceMediaIdentity(doc)).digest('hex');
 assert.equal((await fetch(origin+'/api/health').then(r=>r.json())).client.capabilities.sourceJobs,true);
 const {job}=await post('/api/v1/source-jobs',{protocolVersion:1,operation_id:randomUUID(),key:doc.key,source,kind:'download',consent:true});release();
 await until(async()=>fetch(origin+'/api/v1/source-jobs/'+job.id).then(r=>r.json()),value=>value.job.state==='ready');
 const receipt=await fetch(origin+'/api/v1/source-media?'+new URLSearchParams({key:doc.key,source})).then(r=>r.json());assert.ok(receipt.media.sha256);
 assert.equal((await fetch(origin+'/api/v1/source-jobs',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})).status,403);
});
