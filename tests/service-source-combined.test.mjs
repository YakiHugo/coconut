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
const document={key:'episode',title:'Fixture',source_url:'https://example.test/episode',project_kind:'audio_only',podcast_source:{kind:'direct_media',media_url:'https://example.test/audio.mp3',media_kind:'audio'},segments:[]};
const output={schema_version:1,title:'Fixture',segments:[{id:'one',start:0,end:1,text:'Fixture only'}]};
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function until(fn,p){for(let i=0;i<150;i++){const v=await fn();if(p(v))return v;await delay(10);}throw Error('timeout');}
async function fixture(t,{type='audio/mpeg',broken=false,failASR=false,badReceipt=false,failAfterSave=false,downloadPolicy}={}){
 const dir=await mkdtemp(path.join(tmpdir(),'combined-')),library=await createLibraryStore({directory:dir});
 const commit=doc=>library.commit({protocolVersion:1,epoch:library.describe().epoch,key:doc.key,receiptKey:randomUUID(),expected:library.get(doc.key)?.token||null,action:'put',document:doc});commit(document);
 const media=await createSourceMediaStore({directory:path.join(dir,'media'),libraryStore:library}),eof=gate();let started=0,normal=0,downloads=0,mediaWaitSeconds;
 const transcriber={profile:{backend:'qwen-mlx'},incrementalStatus:async()=>({available:true}),status:async()=>({available:true}),run:async o=>{normal++;if(failASR)throw Error('fixture model failure');await writeFile(path.join(o.workDirectory,'result.json'),JSON.stringify(output));},startIncremental:o=>{
  started++;mediaWaitSeconds=o.mediaWaitSeconds;let resolve,reject;const completion=new Promise((r,j)=>{resolve=r;reject=j;});o.signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});
  return {completion,appendWatermark(){},abort(){reject(Error('abort'));},seal:({size,sha256})=>{void (async()=>{if(failASR)throw Error('fixture model failure');await writeFile(path.join(o.workDirectory,'result.json'),JSON.stringify(output));await writeFile(path.join(o.workDirectory,'incremental_receipt.json'),JSON.stringify({protocol_version:1,attempt_id:o.attemptId,source_sha256:badReceipt?'wrong':sha256,size,source_snapshot:o.sourceSnapshot,profile:transcriber.profile,frozen_context:{title:o.title??null,context:o.context??null,hotwords:o.hotwords??null,name_corrections:o.nameCorrections??null,speaker_count:o.speakerCount??null},reused_chunks:0,recomputed_chunks:1,fallback_reason:null}));resolve();})().catch(reject);}};
 }};
 if(failAfterSave){const save=media.save;media.save=async(...args)=>{await save(...args);throw Error('fixture crash after durable media receipt');};}
 const jobs=await createSourceJobs({directory:path.join(dir,'jobs'),libraryStore:library,mediaStore:media,transcriber,reviewProvider:'codex',reviewer:{review(){throw Error('must never review');}},podcastSources:{downloadPolicy,async downloadMedia(req,{consume,signal}){downloads++;const body=Readable.from((async function*(){yield Buffer.from('fixture');await Promise.race([eof.promise,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}))]);if(broken)throw Error('fixture EOF');yield Buffer.from(' tail');})());await consume({body,type});return {};}}});
 const request=(kind='download_transcribe',id=randomUUID())=>({protocolVersion:1,operation_id:id,libraryId:library.describe().epoch,key:document.key,source:media.owner(document.key).source,kind,consent:true,localOnly:true,acquisitionMode:'incremental-experimental-v1'});
 t.after(async()=>{eof.resolve();await jobs.shutdown();await media.shutdown();library.close();await rm(dir,{recursive:true,force:true});});
 return {jobs,media,commit,eof,request,get started(){return started;},get normal(){return normal;},get downloads(){return downloads;},get mediaWaitSeconds(){return mediaWaitSeconds;}};
}
for(const idleTimeoutMs of [undefined,600000])test(`incremental input wait outlasts the download idle deadline (${idleTimeoutMs??'default'})`,async t=>{
 const f=await fixture(t,{downloadPolicy:idleTimeoutMs===undefined?undefined:{timeoutMs:7200000,idleTimeoutMs}});
 const job=await f.jobs.create(f.request());await until(()=>f.started,Boolean);
 assert.equal(f.mediaWaitSeconds,idleTimeoutMs===undefined?180:660);
 f.eof.resolve();await until(()=>f.jobs.get(job.id),j=>j.state==='ready');
});
test('fixture stream starts inference before EOF; only sealed receipt enables result; nonce dedup',async t=>{
 const f=await fixture(t),a=await f.jobs.create(f.request());await until(()=>f.started,Boolean);
 assert.equal((await f.jobs.get(a.id)).mediaReady,false);await assert.rejects(f.jobs.result(a.id));assert.equal((await f.jobs.create(f.request())).id,a.id);assert.equal((await f.jobs.create(f.request('download_transcribe',a.id))).id,a.id);assert.equal((await f.jobs.capabilities()).downloadTranscribe.available,true);
 f.eof.resolve();const done=await until(()=>f.jobs.get(a.id),j=>j.state==='ready');assert.equal(done.mediaReady,true);assert.equal(done.resultAvailable,true);assert.equal(f.normal,0);assert.equal((await f.jobs.result(a.id)).ingestion.transcript.document.segments[0].text,'Fixture only');
 f.commit({...document,title:'Changed'});assert.equal((await f.jobs.get(a.id)).resultAvailable,false);await assert.rejects(f.jobs.result(a.id),/识别输入/);
});
for(const mode of ['broken','failASR','badReceipt'])test('fixture '+mode+' never publishes a result',async t=>{const f=await fixture(t,{[mode]:true}),j=await f.jobs.create(f.request());f.eof.resolve();const done=await until(()=>f.jobs.get(j.id),j=>['failed','interrupted'].includes(j.state));assert.equal(done.resultAvailable,false);assert.equal(Boolean(await f.media.read(document.key)),mode!=='broken');await assert.rejects(f.jobs.result(j.id));});
test('unsupported stream format uses complete-file local run without paid review',async t=>{const f=await fixture(t,{type:'audio/wav'}),j=await f.jobs.create(f.request());f.eof.resolve();await until(()=>f.jobs.get(j.id),j=>j.state==='ready');assert.equal(f.started,0);assert.equal(f.normal,1);assert.equal(f.downloads,1);});
test('active download cannot be silently upgraded and cancellation leaves no result',async t=>{const f=await fixture(t),j=await f.jobs.create(f.request('download'));await assert.rejects(f.jobs.create(f.request()),/下载正在进行/);await f.jobs.action(j.id,'cancel');assert.equal((await f.jobs.get(j.id)).state,'cancelled');});
test('combined cancellation aborts inference and does not seal media',async t=>{const f=await fixture(t),j=await f.jobs.create(f.request());await until(()=>f.started,Boolean);await f.jobs.action(j.id,'cancel');await delay(30);assert.equal((await f.jobs.get(j.id)).state,'cancelled');assert.equal(await f.media.read(document.key),null);});
test('sealed-media failed inference retry uses local complete file, without redownload',async t=>{
 const f=await fixture(t,{badReceipt:true}),j=await f.jobs.create(f.request());f.eof.resolve();await until(()=>f.jobs.get(j.id),j=>j.state==='failed');
 await f.jobs.action(j.id,'retry');await until(()=>f.jobs.get(j.id),j=>j.state==='ready');assert.equal(f.downloads,1);assert.equal(f.normal,1);assert.equal(f.started,1);
});
test('explicit local flags and no model/review override are required',async t=>{const f=await fixture(t);for(const extra of [{localOnly:false},{acquisitionMode:'other'},{review:{provider:'codex'}},{profile:{}},{model:'remote'}])await assert.rejects(f.jobs.create({...f.request(),...extra}));assert.equal(f.downloads,0);});
test('combined atomically holds inference lane while download is gated',async t=>{
 const f=await fixture(t),j=await f.jobs.create(f.request());await until(()=>f.started,Boolean);
 const second={...document,key:'second',source_url:'https://example.test/second'};f.commit(second);await f.media.save(second.key,f.media.owner(second.key).source,Readable.from([Buffer.from('second')]),{type:'audio/mpeg',name:'second.mp3'});
 const next=await f.jobs.create({...f.request('transcribe'),key:second.key,source:f.media.owner(second.key).source});await delay(25);assert.equal((await f.jobs.get(next.id)).state,'queued');assert.equal(f.normal,0);
 f.eof.resolve();await until(()=>f.jobs.get(j.id),j=>j.state==='ready');await until(()=>f.jobs.get(next.id),j=>j.state==='ready');assert.equal(f.normal,1);
});

test('deduplicated nonce has durable verifiable receipt and rejects nonce retargeting',async t=>{const f=await fixture(t),first=await f.jobs.create(f.request()),request=f.request(),second=await f.jobs.create(request);assert.equal(second.id,first.id);assert.equal(second.requestedOperationId,request.operation_id);assert.equal((await f.jobs.get(request.operation_id)).id,first.id);await assert.rejects(f.jobs.create({...request,kind:'download'}),/另一份来源/);f.eof.resolve();});

test('fresh explicit nonce escapes interrupted unclaimed saved media without adopting it into old task',async t=>{const f=await fixture(t,{failAfterSave:true}),old=await f.jobs.create(f.request());f.eof.resolve();await until(()=>f.jobs.get(old.id),j=>j.state==='failed');assert.ok(await f.media.read(document.key));assert.equal((await f.jobs.get(old.id)).assetSha256,null);await assert.rejects(f.jobs.action(old.id,'retry'),/原声已经替换/);const fresh=await f.jobs.create(f.request());assert.notEqual(fresh.id,old.id);await until(()=>f.jobs.get(fresh.id),j=>j.state==='ready');assert.equal(f.downloads,1);assert.equal(f.normal,1);assert.equal((await f.jobs.get(old.id)).assetSha256,null);});
