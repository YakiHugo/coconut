import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,link,readFile,rm,writeFile} from 'node:fs/promises';
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
async function fixture(t,{type='audio/mpeg',broken=false,failASR=false,failFirstASR=false,failAfterSave=false,beforeConsume,prepareContext,sourceContext}={}){
 const dir=await mkdtemp(path.join(tmpdir(),'combined-')),library=await createLibraryStore({directory:dir});
 const commit=doc=>library.commit({protocolVersion:1,epoch:library.describe().epoch,key:doc.key,receiptKey:randomUUID(),expected:library.get(doc.key)?.token||null,action:'put',document:doc});
 commit(sourceContext?{...document,transcription_context:sourceContext}:document);
 const media=await createSourceMediaStore({directory:path.join(dir,'media'),libraryStore:library}),eof=gate();let normal=0,downloads=0,lastInput;
 const transcriber={profile:{backend:'qwen-mlx'},status:async()=>({available:true,local_only:true,model_download:false}),run:async options=>{
  normal++;lastInput=options;
  assert.ok(await media.read(document.key));
  if(failASR||failFirstASR&&normal===1)throw Error('fixture model failure');
  await writeFile(path.join(options.workDirectory,'result.json'),JSON.stringify(output));
 }};
 if(failAfterSave){const save=media.save;media.save=async(...args)=>{await save(...args);throw Error('fixture crash after durable media receipt');};}
 const options={directory:path.join(dir,'jobs'),libraryStore:library,mediaStore:media,transcriber,reviewProvider:'codex',reviewer:{prepareContext,review(){throw Error('must never review');}},podcastSources:{async downloadMedia(req,{consume,signal}){downloads++;await beforeConsume?.();const body=Readable.from((async function*(){yield Buffer.from('fixture');await Promise.race([eof.promise,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}))]);if(broken)throw Error('fixture EOF');yield Buffer.from(' tail');})());await consume({body,type});return {};}}};
 const jobs=await createSourceJobs(options);
 const request=(kind='download_transcribe',id=randomUUID())=>({protocolVersion:1,operation_id:id,libraryId:library.describe().epoch,key:document.key,source:media.owner(document.key).source,kind,consent:true,localOnly:true,acquisitionMode:'incremental-experimental-v1'});
 t.after(async()=>{eof.resolve();await jobs.shutdown();await media.shutdown();library.close();await rm(dir,{recursive:true,force:true});});
 return {options,jobs,media,commit,eof,request,get normal(){return normal;},get downloads(){return downloads;},get lastInput(){return lastInput;}};
}
test('complete-file inference waits for a sealed source and keeps nonce deduplication',async t=>{
 const f=await fixture(t),a=await f.jobs.create(f.request());await until(()=>f.downloads,Boolean);
 assert.equal(f.normal,0);assert.equal((await f.jobs.get(a.id)).mediaReady,false);await assert.rejects(f.jobs.result(a.id));
 assert.equal((await f.jobs.create(f.request())).id,a.id);assert.equal((await f.jobs.capabilities()).downloadTranscribe.available,true);
 f.eof.resolve();const done=await until(()=>f.jobs.get(a.id),j=>j.state==='ready');assert.equal(done.mediaReady,true);
 assert.equal(done.resultAvailable,true);assert.equal(f.normal,1);assert.equal((await f.jobs.result(a.id)).ingestion.transcript.document.segments[0].text,'Fixture only');
 f.commit({...document,title:'Changed'});assert.equal((await f.jobs.get(a.id)).resultAvailable,false);await assert.rejects(f.jobs.result(a.id),/识别输入/);
});

test('authorized publisher metadata is prepared during download before local ASR',async t=>{
 const context={source_url:document.source_url,description:'Published roster: Alice and Bob.'};
 const started=gate(),prepared=gate();
 const f=await fixture(t,{sourceContext:context,prepareContext:async source=>{
  started.resolve();await prepared.promise;
  return {...source,speaker_identity_evidence:{expected_speakers:2,speakers:[{name:'Alice',role:'主持人'},{name:'Bob',role:'嘉宾'}]},
   transcription_glossary:[{term:'Fixture',source:source.source_url}]};
 }});
 try{
  const job=await f.jobs.create({...f.request(),after_transcription_review:'codex'});
  await started.promise;await until(()=>f.downloads,Boolean);assert.equal(f.normal,0);
  prepared.resolve();f.eof.resolve();
  await until(()=>f.jobs.get(job.id),j=>j.state==='ready');
  assert.equal(f.lastInput.speakerCount,2);
  assert.deepEqual(f.lastInput.hotwords,['Alice','Bob','Fixture']);
  assert.deepEqual(f.lastInput.context.participants.map(p=>p.name),['Alice','Bob']);
 }finally{prepared.resolve();}
});
test('disabled or failed publisher metadata preparation leaves local ASR available',async t=>{
 const context={source_url:document.source_url,description:'Published metadata'};
 let calls=0;
 const f=await fixture(t,{sourceContext:context,prepareContext:async()=>{calls++;throw Error('fixture extraction failure');}});
 const plain=await f.jobs.create(f.request());f.eof.resolve();await until(()=>f.jobs.get(plain.id),j=>j.state==='ready');
 assert.equal(calls,0);
 const optIn=await f.jobs.create({...f.request(),after_transcription_review:'codex'});
 await until(()=>f.jobs.get(optIn.id),j=>j.state==='ready');
 assert.equal(calls,1);assert.equal(f.lastInput.context.description,context.description);
});

test('an author transcript imported during download admission prevents ASR',async t=>{
 const release=gate(),f=await fixture(t,{beforeConsume:()=>release.promise});
 try{
  const job=await f.jobs.create(f.request());await until(()=>f.downloads,Boolean);
  f.commit({...document,project_kind:'transcript',segments:output.segments,provenance:{kind:'publisher_transcript'}});
  release.resolve();
  const done=await until(()=>f.jobs.get(job.id),value=>value.state==='interrupted');
  assert.match(done.error,/已有文字稿/);assert.equal(f.normal,0);
  assert.equal(await f.media.read(document.key),null);
  await assert.rejects(f.jobs.action(job.id,'retry'),/已有文字稿/);
 }finally{release.resolve();}
});
for(const mode of ['broken','failASR'])test('fixture '+mode+' never publishes a result',async t=>{const f=await fixture(t,{[mode]:true}),j=await f.jobs.create(f.request());f.eof.resolve();const done=await until(()=>f.jobs.get(j.id),j=>['failed','interrupted'].includes(j.state));assert.equal(done.resultAvailable,false);assert.equal(Boolean(await f.media.read(document.key)),mode!=='broken');await assert.rejects(f.jobs.result(j.id));});
test('saved WAV uses the same complete-file local run without paid review',async t=>{const f=await fixture(t,{type:'audio/wav'}),j=await f.jobs.create(f.request());f.eof.resolve();await until(()=>f.jobs.get(j.id),j=>j.state==='ready');assert.equal(f.normal,1);assert.equal(f.downloads,1);});
test('active download cannot be silently upgraded and cancellation leaves no result',async t=>{const f=await fixture(t),j=await f.jobs.create(f.request('download'));await assert.rejects(f.jobs.create(f.request()),/下载正在进行/);await f.jobs.action(j.id,'cancel');assert.equal((await f.jobs.get(j.id)).state,'cancelled');});
test('combined cancellation during download does not seal media or start ASR',async t=>{const f=await fixture(t),j=await f.jobs.create(f.request());await until(()=>f.downloads,Boolean);await f.jobs.action(j.id,'cancel');await delay(30);assert.equal((await f.jobs.get(j.id)).state,'cancelled');assert.equal(await f.media.read(document.key),null);});
test('sealed-media failed inference retry uses local complete file, without redownload',async t=>{
 const f=await fixture(t,{failFirstASR:true}),j=await f.jobs.create(f.request());f.eof.resolve();await until(()=>f.jobs.get(j.id),j=>j.state==='failed');
 await f.jobs.action(j.id,'retry');await until(()=>f.jobs.get(j.id),j=>j.state==='ready');assert.equal(f.downloads,1);assert.equal(f.normal,2);
});
test('explicit local flags and no model/review override are required',async t=>{const f=await fixture(t);for(const extra of [{localOnly:false},{acquisitionMode:'other'},{review:{provider:'codex'}},{profile:{}},{model:'remote'}])await assert.rejects(f.jobs.create({...f.request(),...extra}));assert.equal(f.downloads,0);});
test('combined atomically holds inference lane while download is gated',async t=>{
 const f=await fixture(t),j=await f.jobs.create(f.request());await until(()=>f.downloads,Boolean);
 const second={...document,key:'second',source_url:'https://example.test/second'};f.commit(second);await f.media.save(second.key,f.media.owner(second.key).source,Readable.from([Buffer.from('second')]),{type:'audio/mpeg',name:'second.mp3'});
 const next=await f.jobs.create({...f.request('transcribe'),key:second.key,source:f.media.owner(second.key).source});await delay(25);assert.equal((await f.jobs.get(next.id)).state,'queued');assert.equal(f.normal,0);
 f.eof.resolve();await until(()=>f.jobs.get(j.id),j=>j.state==='ready');await until(()=>f.jobs.get(next.id),j=>j.state==='ready');assert.equal(f.normal,2);
});

test('deduplicated nonce has durable verifiable receipt and rejects nonce retargeting',async t=>{const f=await fixture(t),first=await f.jobs.create(f.request()),request=f.request(),second=await f.jobs.create(request);assert.equal(second.id,first.id);assert.equal(second.requestedOperationId,request.operation_id);assert.equal((await f.jobs.get(request.operation_id)).id,first.id);await assert.rejects(f.jobs.create({...request,kind:'download'}),/另一份来源/);f.eof.resolve();});

test('fresh explicit nonce escapes interrupted unclaimed saved media without adopting it into old task',async t=>{const f=await fixture(t,{failAfterSave:true}),old=await f.jobs.create(f.request());f.eof.resolve();await until(()=>f.jobs.get(old.id),j=>j.state==='failed');assert.ok(await f.media.read(document.key));assert.equal((await f.jobs.get(old.id)).assetSha256,null);await assert.rejects(f.jobs.action(old.id,'retry'),/原声已经替换/);const fresh=await f.jobs.create(f.request());assert.notEqual(fresh.id,old.id);await until(()=>f.jobs.get(fresh.id),j=>j.state==='ready');assert.equal(f.downloads,1);assert.equal(f.normal,1);assert.equal((await f.jobs.get(old.id)).assetSha256,null);});


test('restarting an interrupted job removes only its link to shared PCM and its sealed copy', {skip:process.platform==='win32'},async t=>{
 const f=await fixture(t),job=await f.jobs.create(f.request());
 await until(()=>f.downloads,Boolean);
 await f.jobs.shutdown();
 const cache=f.media.pcmCacheDirectory,attempt=path.join(f.options.directory,job.id,'attempts',randomUUID());
 const retained=path.join(cache,'audio.wav'),interrupted=path.join(attempt,'audio.wav'),sealed=path.join(attempt,'f'.repeat(64)+'.media');
 await mkdir(cache,{mode:0o700});await mkdir(attempt,{recursive:true,mode:0o700});
 await writeFile(retained,'normalized',{mode:0o600});await link(retained,interrupted);await writeFile(sealed,'sealed media',{mode:0o600});
 const reopened=await createSourceJobs(f.options);
 try{
  assert.equal((await reopened.get(job.id)).state,'interrupted');
  assert.equal(await readFile(retained,'utf8'),'normalized');
  await assert.rejects(readFile(interrupted),{code:'ENOENT'});
  await assert.rejects(readFile(sealed),{code:'ENOENT'});
 }finally{await reopened.shutdown();}
});
