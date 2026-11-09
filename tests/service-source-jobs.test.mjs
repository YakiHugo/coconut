import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Readable} from 'node:stream';
import {createLibraryStore} from '../desktop/library-store.mjs';
import {createSourceMediaStore} from '../desktop/source-media.mjs';
import {createSourceJobs} from '../desktop/source-jobs.mjs';
import {startService} from '../server/main.mjs';
import {createTranscriptReviewer} from '../desktop/transcript-review.mjs';
const doc={key:'server-podcast',title:'Authored episode',source_url:'https://example.test/episode',project_kind:'audio_only',podcast_source:{kind:'direct_media',media_url:'https://example.test/audio.mp3',media_kind:'audio'},segments:[]};
function commit(library,document,action='put'){return library.commit({protocolVersion:1,epoch:library.describe().epoch,key:document.key,receiptKey:randomUUID(),expected:library.get(document.key)?.token||null,action,...(action==='put'?{document}:{})});}
const missing=()=>Object.assign(Error('not found'),{taskCode:'ingestion_operation_not_found'});
async function until(fn,predicate){for(let attempt=0;attempt<100;attempt++){const value=await fn();if(predicate(value))return value;await delay(10);}throw Error('Timed out');}
async function fixture(t,{download,transcriber,reviewer,reviewProvider,videoAudioService}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'coconut-source-jobs-'));
 const library=await createLibraryStore({directory});commit(library,doc);
 const media=await createSourceMediaStore({directory:path.join(directory,'media'),libraryStore:library});
 let calls=0;const podcastSources={downloadMedia:async(request,options)=>{calls++;return download?download(request,options):{body:Buffer.from('ID3 authored media'),type:'audio/mpeg'};}};
 transcriber??={profile:{backend:'authored'},status:async()=>({available:true}),run:async({workDirectory})=>{await writeFile(path.join(workDirectory,'result.json'),JSON.stringify({schema_version:1,title:'Authored',segments:[{id:'a',start:0,end:1,text:'Authored'}]}));}};
 const options={directory:path.join(directory,'jobs'),libraryStore:library,mediaStore:media,podcastSources,videoAudioService,transcriber,reviewer,reviewProvider};let jobs=await createSourceJobs(options);
 t.after(async()=>{await jobs.shutdown();await media.shutdown();library.close();await rm(directory,{recursive:true,force:true});});
 const create=kind=>jobs.create({protocolVersion:1,operation_id:randomUUID(),libraryId:library.describe().epoch,key:doc.key,source:media.owner(doc.key).source,kind,consent:true});
 return {directory,library,media,create,transcriber,options,get jobs(){return jobs;},get calls(){return calls;},async restart(){await jobs.shutdown();jobs=await createSourceJobs(options);}};
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
test('transcription reads the owned file directly, persists progress and attaches after restart',async t=>{
 let runs=0,release;const gate=new Promise(resolve=>release=resolve);
 const f=await fixture(t,{transcriber:{profile:{backend:'authored'},status:async()=>({available:true}),run:async({inputPath,workDirectory,onProgress,signal})=>{runs++;assert.equal((await readFile(inputPath)).toString(),'ID3 authored bytes');onProgress({phase:'align'});await gate;signal.throwIfAborted();await writeFile(path.join(workDirectory,'result.json'),JSON.stringify({schema_version:1,title:'Authored',segments:[{id:'a',start:0,end:1,text:'Authored'}]}));}}});
 const source=f.media.owner(doc.key).source;await f.media.save(doc.key,source,Readable.from(['ID3 authored bytes']),{type:'audio/mpeg',name:'episode.mp3'});
 const job=await f.create('transcribe');await until(()=>f.jobs.get(job.id),j=>j.phase.includes('align'));assert.equal(runs,1);assert.equal((await f.create('transcribe')).id,job.id);
 release();await until(()=>f.jobs.get(job.id),j=>j.state==='ready');await f.restart();assert.equal((await f.jobs.result(job.id)).ingestion.transcript.document.segments[0].text,'Authored');assert.equal(runs,1);
 commit(f.library,{...doc,project_note:'keep notes',title:'Edit title'});assert.equal((await f.jobs.result(job.id)).job.id,job.id);
 commit(f.library,doc,'delete');commit(f.library,doc,'restore');assert.deepEqual(await f.jobs.list(doc.key),[]);await assert.rejects(f.jobs.result(job.id),/来源已变化/);
});
test('MOSS native timing and chunk-scoped speakers survive the service queue and result round trip',async t=>{
 let runs=0;
 const native={schema_version:1,title:'Authored MOSS episode',language:'zh',provenance:{kind:'local_asr',backend:'moss-mlx',model:'authored-moss',caption_method:'asr',review_status:'unreviewed'},segments:[
  {id:'moss-first',start:1.25,end:3.5,text:'第一块的原生句段',speaker:'说话人 1',speaker_id:'speaker-0001',speaker_status:'native_chunk_local',speaker_scope:'chunk',provider_speaker:'0:S01',chunk_index:0,timing_basis:'native_segment',alignment_status:'unavailable'},
  {id:'moss-second',start:1801.5,end:1804.75,text:'第二块的原生句段',speaker:'说话人 2',speaker_id:'speaker-0002',speaker_status:'native_chunk_local',speaker_scope:'chunk',provider_speaker:'1:S01',chunk_index:1,timing_basis:'native_segment',alignment_status:'unavailable'},
 ]};
 const f=await fixture(t,{transcriber:{profile:{backend:'moss-mlx',asr_model:'/authored/moss',align_model:'',segmentation:'',embedding:''},status:async()=>({available:true}),run:async({workDirectory,onProgress})=>{
  runs++;onProgress({phase:'recognize',chunk:2,chunks:2});await writeFile(path.join(workDirectory,'result.json'),JSON.stringify(native));
 }}});
 await f.media.save(doc.key,f.media.owner(doc.key).source,Readable.from(['ID3 authored MOSS audio']),{type:'audio/mpeg',name:'source.mp3'});
 const job=await f.create('transcribe');await until(()=>f.jobs.get(job.id),j=>j.state==='ready');await f.restart();
 const output=(await f.jobs.result(job.id)).ingestion.transcript.document;
 assert.equal(output.provenance.backend,'moss-mlx');assert.equal(output.provenance.model,'authored-moss');assert.equal(runs,1);
 for(const [index,cue] of output.segments.entries()){
  for(const field of ['id','start','end','text','speaker','speaker_id','speaker_status','speaker_scope','provider_speaker','chunk_index','timing_basis','alignment_status'])assert.deepEqual(cue[field],native.segments[index][field],field);
  assert.equal(Object.hasOwn(cue,'words'),false);
 }
 assert.notEqual(output.segments[0].speaker_id,output.segments[1].speaker_id);
 assert.notEqual(output.segments[0].speaker,output.segments[1].speaker);
});
test('corrupt saved bytes are rejected before a Python task starts',async t=>{
 const f=await fixture(t),source=f.media.owner(doc.key).source,receipt=await f.media.save(doc.key,source,Readable.from(['original']),{type:'audio/mpeg',name:'source.mp3'});
 await writeFile(path.join(f.directory,'media',receipt.sha256+'.media'),'changed!');await assert.rejects(f.create('transcribe'),/changed|integrity/);
});
test('transcription receives episode title and participant names from source identity evidence',async t=>{
 let captured;
 const f=await fixture(t,{transcriber:{profile:{backend:'authored'},status:async()=>({available:true}),run:async request=>{
  captured=request;await writeFile(path.join(request.workDirectory,'result.json'),JSON.stringify({schema_version:1,title:'Authored',segments:[{id:'a',start:0,end:1,text:'Authored'}]}));
 }}});
 commit(f.library,{...doc,title:'对话张元',transcription_glossary:[{term:'Manus',source:'节目简介'}],speaker_identity_evidence:{speakers:[{name:'张元',verified_asr_aliases:['张源','张晶','陈旌']},{name:'陈旌',verified_asr_aliases:['陈晶','张晶']},{name:'张元'},{name:42}]}});
 await f.media.save(doc.key,f.media.owner(doc.key).source,Readable.from(['authored']),{type:'audio/mpeg',name:'source.mp3'});
 const job=await f.create('transcribe');await until(()=>f.jobs.get(job.id),j=>j.state==='ready');
 assert.equal(captured.title,'对话张元');assert.deepEqual(captured.hotwords,['张元','陈旌','Manus']);
 assert.deepEqual(captured.nameCorrections,{'张源':'张元','陈晶':'陈旌'});
});
test('configured post-ASR review runs after recognition and retains usable original output on model failure',async t=>{
 for(const fail of [false,true]){
  let recognitions=0,reviews=0;
  const reviewer=createTranscriptReviewer({providers:{structured:async()=>{reviews++;if(fail)throw Error('CLI unavailable');return {edits:[{cue_id:'a',original:'刘源',replacement:'刘元',category:'entity',basis:'节目标题'}],issues:[]};}}});
  const f=await fixture(t,{reviewer,reviewProvider:'kimi',transcriber:{profile:{backend:'authored'},status:async()=>({available:true}),run:async({workDirectory})=>{recognitions++;await writeFile(path.join(workDirectory,'result.json'),JSON.stringify({schema_version:1,title:'对话刘元',segments:[{id:'a',start:0,end:1,text:'刘源来了',speaker:null}]}));}}});
  commit(f.library,{...doc,title:'对话刘元'});await f.media.save(doc.key,f.media.owner(doc.key).source,Readable.from(['authored audio']),{type:'audio/mpeg',name:'source.mp3'});
  const job=await f.create('transcribe');await until(()=>f.jobs.get(job.id),j=>j.state==='ready');const result=(await f.jobs.result(job.id)).ingestion.transcript.document;
  assert.equal(result.segments[0].text,fail?'刘源来了':'刘元来了');assert.equal(result.provenance.review_status,fail?'pending':'automatic_unreviewed:1;issues:0');
  const original=JSON.parse(await readFile(path.join(f.directory,'jobs',job.id,'original-asr.json'),'utf8'));assert.equal(original.segments[0].text,'刘源来了');assert.equal(recognitions,1);assert.equal(reviews,1);
 }
});
test('failed stages retry the same work directory; cancellation and restart never rerun automatically',async t=>{
 let runs=0,work,waiting=false;
 const f=await fixture(t,{transcriber:{profile:{backend:'authored'},status:async()=>({available:true}),run:async({workDirectory,signal})=>{runs++;if(work)assert.equal(workDirectory,work);work=workDirectory;if(runs===1)throw Error('authored alignment failure');waiting=true;await delay(10000,null,{signal});}}});
 await f.media.save(doc.key,f.media.owner(doc.key).source,Readable.from(['original']),{type:'audio/mpeg',name:'source.mp3'});
 const job=await f.create('transcribe');await until(()=>f.jobs.get(job.id),j=>j.state==='failed');await f.restart();assert.equal(runs,1);
 await f.jobs.action(job.id,'retry');await until(async()=>waiting,Boolean);await f.jobs.action(job.id,'cancel');await f.restart();assert.equal((await f.jobs.get(job.id)).state,'cancelled');assert.equal(runs,2);
});
test('explicit retry repairs a completed download while ordinary status reads never reacquire bytes',async t=>{
 const f=await fixture(t),job=await f.create('download');await until(()=>f.jobs.get(job.id),j=>j.state==='ready');const receipt=await f.media.read(doc.key);
 await writeFile(path.join(f.directory,'media',receipt.sha256+'.media'),Buffer.alloc(receipt.size));await assert.rejects(f.media.read(doc.key),/integrity/);
 assert.equal((await f.create('download')).id,job.id);assert.equal(f.calls,1);
 await f.jobs.action(job.id,'retry');await until(()=>f.jobs.get(job.id),j=>j.state==='ready');assert.equal(f.calls,2);assert.deepEqual(await f.media.read(doc.key),receipt);
});
test('once transcription owns an asset, a different download cannot replace it',async t=>{
 const f=await fixture(t),source=f.media.owner(doc.key).source;
 const media=await f.media.save(doc.key,source,Readable.from(['first audio']),{type:'audio/mpeg',name:'first.mp3'});const first=await f.create('transcribe');await until(()=>f.jobs.get(first.id),j=>j.state==='ready');
 await assert.rejects(f.media.save(doc.key,source,Readable.from(['second audio']),{type:'audio/mpeg',name:'second.mp3'}),/未替换旧原声/);assert.deepEqual(await f.media.read(doc.key),media);assert.equal((await f.jobs.result(first.id)).job.id,first.id);
});
test('asset replacement during readiness cannot reserve previous bytes',async t=>{
 let release,checking=false;const gate=new Promise(resolve=>release=resolve),f=await fixture(t,{transcriber:{profile:{backend:'authored'},status:async()=>{checking=true;await gate;return {available:true};}}}),source=f.media.owner(doc.key).source;
 await f.media.save(doc.key,source,Readable.from(['old audio']),{type:'audio/mpeg',name:'old.mp3'});const creation=f.create('transcribe');const rejected=assert.rejects(creation,/原声已变化/);await until(async()=>checking,Boolean);
 await f.media.save(doc.key,source,Readable.from(['new audio']),{type:'audio/mpeg',name:'new.mp3'});release();await rejected;assert.deepEqual(await f.jobs.list(doc.key),[]);
});
test('missing consent, conflicting operation identity and stale source fail before any fetch',async t=>{
 const f=await fixture(t),base={protocolVersion:1,operation_id:randomUUID(),libraryId:f.library.describe().epoch,key:doc.key,source:f.media.owner(doc.key).source,kind:'download'};
 await assert.rejects(f.jobs.create(base));await assert.rejects(f.jobs.create({...base,consent:true,source:'0'.repeat(64)}));assert.equal(f.calls,0);
 await f.jobs.create({...base,consent:true});await assert.rejects(f.jobs.create({...base,consent:true,kind:'transcribe'}),/另一份来源/);
});
test('a queued transcription can be cancelled before another source finishes acquisition',async t=>{
 let runs=0;const f=await fixture(t,{download:async(_,{signal})=>{await delay(10000,null,{signal});return {body:Buffer.from('late'),type:'audio/mpeg'};},transcriber:{profile:{backend:'authored'},status:async()=>({available:true}),run:async()=>{runs++;}}});
 const first=await f.create('download');await until(async()=>f.calls,n=>n===1);
 const second={...doc,key:'second-source'};commit(f.library,second);const source=f.media.owner(second.key).source;await f.media.save(second.key,source,Readable.from(['ID3 second']),{type:'audio/mpeg',name:'source.mp3'});
 const job=await f.jobs.create({protocolVersion:1,libraryId:f.library.describe().epoch,operation_id:randomUUID(),key:second.key,source,kind:'transcribe',consent:true});assert.equal(job.state,'queued');
 assert.equal((await f.jobs.action(job.id,'cancel')).state,'cancelled');await f.jobs.action(first.id,'cancel');await delay(30);assert.equal(runs,0);
});
test('real authenticated HTTP accepts a source task independently of the response connection',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'coconut-source-task-http-'));let release;const gate=new Promise(resolve=>release=resolve);
 const {server,origin}=await startService({env:{COCONUT_PORT:'0',COCONUT_DATA_DIRECTORY:directory},podcastSources:{downloadMedia:async()=>{await gate;return {body:Buffer.from('ID3 independent'),type:'audio/mpeg'};}}});t.after(async()=>{await server.shutdown();await rm(directory,{recursive:true,force:true});});
 const post=async(route,value)=>{const response=await fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});assert.ok(response.ok);return response.json();};
 const epoch=(await(await fetch(origin+'/api/v1/library')).json()).epoch;await post('/api/v1/library/commit',{protocolVersion:1,epoch,key:doc.key,receiptKey:randomUUID(),expected:null,action:'put',document:doc});
 const {createHash}=await import('node:crypto'),{sourceMediaIdentity}=await import('../shared/source-media.js');const source=createHash('sha256').update(sourceMediaIdentity(doc)).digest('hex');
 assert.equal((await fetch(origin+'/api/health').then(r=>r.json())).client.capabilities.sourceJobs,true);
 const {job}=await post('/api/v1/source-jobs',{protocolVersion:1,operation_id:randomUUID(),libraryId:epoch,key:doc.key,source,kind:'download',consent:true});release();
 await until(async()=>fetch(origin+'/api/v1/source-jobs/'+job.id).then(r=>r.json()),value=>value.job.state==='ready');
 const receipt=await fetch(origin+'/api/v1/source-media?'+new URLSearchParams({key:doc.key,source})).then(r=>r.json());assert.ok(receipt.media.sha256);
 assert.equal((await fetch(origin+'/api/v1/source-jobs',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})).status,403);
});
test('switching Qwen to MOSS creates a new task and cannot retry the old profile or adopt its checkpoints',async t=>{
 const work=[];
 const transcriber={profile:{backend:'qwen-mlx',asr_model:'/authored/qwen'},status:async()=>({available:true}),run:async({workDirectory})=>{
  work.push(workDirectory);
  if(transcriber.profile.backend==='qwen-mlx'){
   await writeFile(path.join(workDirectory,'authored-qwen-checkpoint.json'),JSON.stringify({backend:'qwen-mlx'}));throw Error('authored interrupted Qwen stage');
  }
  await assert.rejects(readFile(path.join(workDirectory,'authored-qwen-checkpoint.json')),{code:'ENOENT'});
  await writeFile(path.join(workDirectory,'result.json'),JSON.stringify({schema_version:1,title:'MOSS result',provenance:{kind:'local_asr',backend:'moss-mlx'},segments:[{id:'moss',start:0,end:1,text:'MOSS新任务'}]}));
 }};
 const f=await fixture(t,{transcriber});await f.media.save(doc.key,f.media.owner(doc.key).source,Readable.from(['original']),{type:'audio/mpeg',name:'source.mp3'});
 const first=await f.create('transcribe');await until(()=>f.jobs.get(first.id),j=>j.state==='failed');assert.equal((await f.jobs.get(first.id)).currentProfile,true);
 f.transcriber.profile={backend:'moss-mlx',asr_model:'/authored/moss'};assert.equal((await f.jobs.get(first.id)).currentProfile,false);
 await assert.rejects(f.jobs.action(first.id,'retry'),/模型配置已变化/);assert.equal(work.length,1);
 const second=await f.create('transcribe');assert.notEqual(second.id,first.id);await until(()=>f.jobs.get(second.id),j=>j.state==='ready');assert.equal((await f.jobs.list(doc.key)).length,2);
 assert.equal(work.length,2);assert.notEqual(work[0],work[1]);assert.equal((await f.jobs.get(first.id)).state,'failed');
 assert.equal((await f.jobs.result(second.id)).ingestion.transcript.document.provenance.backend,'moss-mlx');
 assert.deepEqual(JSON.parse(await readFile(path.join(work[0],'authored-qwen-checkpoint.json'),'utf8')),{backend:'qwen-mlx'});
});
test('metadata precedes ASR and identity follows acoustic grouping; metadata failure does not discard ASR',async t=>{
 for(const unavailable of [false,true]){
  const steps=[];
  const reviewer={prepareContext:async d=>{steps.push('context');if(unavailable)throw Error('CLI unavailable');return {...d,speaker_identity_evidence:{expected_speakers:2,speakers:[{name:'张元'}]},transcription_glossary:[{term:'Manus',source:'publisher'}]};},identifySpeakers:async d=>{steps.push('identity');return {...d,segments:d.segments.map(s=>({...s,speaker:'张元（嘉宾）'}))};},review:async d=>{steps.push('review');return {result:d};}};
  const f=await fixture(t,{reviewer,reviewProvider:'codex',transcriber:{profile:{backend:'authored'},status:async()=>({available:true}),run:async request=>{steps.push('asr');assert.deepEqual(request.hotwords,unavailable?[]:['张元','Manus']);assert.equal(request.speakerCount,unavailable?undefined:2);await writeFile(path.join(request.workDirectory,'result.json'),JSON.stringify({schema_version:1,title:'Authored',segments:[{id:'a',start:0,end:1,text:'原识别',speaker_id:'speaker-0001'}]}));}}});
  await f.media.save(doc.key,f.media.owner(doc.key).source,Readable.from(['ID3 authored']),{type:'audio/mpeg',name:'source.mp3'});const job=await f.create('transcribe');await until(()=>f.jobs.get(job.id),j=>j.state==='ready');
  const result=(await f.jobs.result(job.id)).ingestion.transcript.document;
  assert.deepEqual(steps,['context','asr','identity','review']);assert.equal(result.segments[0].speaker,'张元（嘉宾）');
  const original=JSON.parse(await readFile(path.join(f.directory,'jobs',job.id,'original-asr.json'),'utf8'));assert.equal(original.segments[0].speaker,undefined);
 }
});

test('existing text alignment is durable, isolated from paid review, and fenced by original text',async t=>{
 let runs=0;const f=await fixture(t,{reviewProvider:'codex',reviewer:{review(){assert.fail('alignment must not review text');}},transcriber:{profile:{backend:'qwen-mlx'},alignmentStatus:async()=>({available:true}),align:async({document,workDirectory})=>{runs++;const result=structuredClone(document);result.segments[0].words=[{word:'Hello',start:0,end:1}];await writeFile(path.join(workDirectory,'result.json'),JSON.stringify({document:result,alignment_report:{status:'candidate',source_text_quality:'unverified'},source_snapshot:document}));}}});
 const text={...doc,project_kind:'transcript',segments:[{id:'a',start:0,end:1,text:'Hello'}],provenance:{alignment_required:true}};commit(f.library,text);
 await f.media.save(doc.key,f.media.owner(doc.key).source,Readable.from(['original audio']),{type:'audio/mpeg',name:'source.mp3'});
 const job=await f.create('align');await until(()=>f.jobs.get(job.id),j=>j.state==='ready');assert.equal((await f.create('align')).id,job.id);assert.equal(runs,1);
 await f.restart();const result=await f.jobs.result(job.id);assert.equal(result.alignment.document.segments[0].text,'Hello');assert.equal(result.alignment.input.segments[0].text,'Hello');assert.equal(f.library.get(doc.key).document.segments[0].words,undefined);
 commit(f.library,{...text,segments:[{id:'a',start:0,end:1,text:'Changed'}]});await assert.rejects(f.jobs.result(job.id),/原稿已变化/);
 const newJob=await f.create('align');assert.notEqual(newJob.id,job.id);
});
test('existing platform transcript downloads source audio durably without invoking transcription',async t=>{
 let request,invocations=0;
 const f=await fixture(t,{videoAudioService:{sourceAvailable:true,providers:['bilibili'],download:async(data,options)=>{request={data,options};return {body:Buffer.from('authored media'),type:'audio/mp4'};}},transcriber:{profile:{backend:'authored'},status:async()=>({available:true}),run:async()=>{invocations++;}}});
 commit(f.library,{key:doc.key,title:'Existing text',source_url:'https://www.bilibili.com/video/BV1xx411c7mD',provenance:{kind:'platform_subtitles',source_platform:'bilibili',media_id:'BV1xx411c7mD'},segments:[{id:'one',start:0,end:1,text:'原文'}]});
 const task=await f.create('download');await until(()=>f.jobs.get(task.id),j=>j.state==='ready');
 assert.equal(request.options.purpose,'source');assert.equal(request.data.consent,true);assert.equal(invocations,0);assert.equal((await f.media.read(doc.key)).type,'audio/mp4');assert.equal(f.library.get(doc.key).document.segments[0].text,'原文');
});
test('unavailable video source download does not fall through to podcast fetching',async t=>{
 const f=await fixture(t);commit(f.library,{key:doc.key,title:'Video',source_url:'https://www.bilibili.com/video/BV1xx411c7mD',segments:[{id:'one',start:0,end:1,text:'Text'}]});
 await assert.rejects(f.create('download'),/没有可获取的原声/);assert.equal(f.calls,0);
});
