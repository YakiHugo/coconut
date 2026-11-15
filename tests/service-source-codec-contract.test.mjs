/** Real media observer -> child FD3/NDJSON -> PyAV -> canonical pipeline.
 * Only Qwen recognition/probe are injected deterministic fixtures, never models.
 * Set COCONUT_CODEC_PYTHON to a local Python with PyAV; otherwise skip explicitly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {createTranscriber} from '../desktop/transcriber.mjs';
import {createSourceJobs} from '../desktop/source-jobs.mjs';
import {createSourceMediaStore} from '../desktop/source-media.mjs';
import {createLibraryStore} from '../desktop/library-store.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),python=process.env.COCONUT_CODEC_PYTHON||'python3';
let available=true;try{execFileSync(python,['-c','import av'],{stdio:'ignore'});execFileSync('ffmpeg',['-version'],{stdio:'ignore'});}catch{available=false;}
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function exists(file){try{await readFile(file);return true;}catch{return false;}}
async function until(fn,p,message){for(let i=0;i<1500;i++){const v=await fn();if(p(v))return v;await delay(20);}throw Error(message||'Timed out');}
async function fixture(t,codec,{blockCanonical=false}={}){
 const dir=await mkdtemp(path.join(tmpdir(),'coconut-codec-contract-')),audio=path.join(dir,'fixture.'+codec),marker=path.join(dir,'recognition.log'),canonical=path.join(dir,'canonical.marker'),script=path.join(dir,'fixture-worker.py');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','anoisesrc=duration=510:sample_rate=44100:seed=123','-c:a',codec==='mp3'?'libmp3lame':'flac',...(codec==='mp3'?['-b:a','128k']:[]),audio]);
 const bytes=await readFile(audio),digest=createHash('sha256').update(bytes).digest('hex');
 await writeFile(script,`import sys,time\nfrom pathlib import Path\nsys.path.insert(0,${JSON.stringify(root)})\nimport transcription\nfrom audio_pipeline import CallableBackend\ntranscription.probe=lambda p:{'available':True}\ndef recognize(p):\n with open(${JSON.stringify(marker)},'a') as f: f.write(str(p)+'\\n')\n if ${blockCanonical?'True':'False'} and 'canonical' in str(p):\n  Path(${JSON.stringify(canonical)}).write_text('fixture blocking')\n  while True: time.sleep(.02)\n return {'segments':[{'start':.1,'end':.2,'text':'fixture only'}]}\ntranscription.QwenBackend=lambda *a,**k:CallableBackend({'fixture':1},recognize)\ntranscription.main()\n`);
 const library=await createLibraryStore({directory:path.join(dir,'library')}),doc={key:'fixture',title:'Codec fixture',source_url:'https://example.test/episode',project_kind:'audio_only',podcast_source:{kind:'direct_media',media_url:'https://example.test/audio.'+codec,media_kind:'audio'},segments:[]};
 library.commit({protocolVersion:1,epoch:library.describe().epoch,key:doc.key,receiptKey:randomUUID(),expected:null,action:'put',document:doc});
 const media=await createSourceMediaStore({directory:path.join(dir,'media'),libraryStore:library}),release=gate();let reachedEOF=false;
 const jobs=await createSourceJobs({directory:path.join(dir,'jobs'),libraryStore:library,mediaStore:media,transcriber:createTranscriber({python,scriptPath:script,profile:{backend:'qwen-mlx',asr_model:'/fixture/no-model'}}),podcastSources:{async downloadMedia(_,{consume,signal}){
  const body=Readable.from((async function*(){const boundary=Math.floor(bytes.length*.65);for(let i=0;i<boundary;i+=65536){signal.throwIfAborted();yield bytes.subarray(i,Math.min(i+65536,boundary));await delay(1);}await Promise.race([release.promise,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}))]);for(let i=boundary;i<bytes.length;i+=65536){signal.throwIfAborted();yield bytes.subarray(i,Math.min(i+65536,bytes.length));await delay(1);}reachedEOF=true;})());await consume({body,type:codec==='mp3'?'audio/mpeg':'audio/flac',sha256:digest,size:bytes.length});return {};}}});
 t.after(async()=>{release.resolve();await jobs.shutdown();await media.shutdown();library.close();await rm(dir,{recursive:true,force:true});});
 const job=await jobs.create({protocolVersion:1,operation_id:randomUUID(),libraryId:library.describe().epoch,key:doc.key,source:media.owner(doc.key).source,kind:'download_transcribe',consent:true,localOnly:true,acquisitionMode:'incremental-experimental-v1'});
 return {dir,media,jobs,job,release,marker,canonical,digest,size:bytes.length,get reachedEOF(){return reachedEOF;},async receipt(){const base=path.join(dir,'jobs',job.id,'attempts'),[attempt]=await readdir(base);return JSON.parse(await readFile(path.join(base,attempt,'incremental_receipt.json'),'utf8'));}};
}
for(const codec of ['mp3','flac'])test(`real ${codec} streamed codec + Node/Python contract (fixture recognition)`,{skip:!available,timeout:60000},async t=>{
 const f=await fixture(t,codec);await until(()=>exists(f.marker),Boolean,'recognition did not start before gated EOF');assert.equal(f.reachedEOF,false);assert.equal((await f.jobs.get(f.job.id)).mediaReady,false);await assert.rejects(f.jobs.result(f.job.id));
 f.release.resolve();const done=await until(()=>f.jobs.get(f.job.id),j=>['ready','failed','interrupted'].includes(j.state));assert.equal(done.state,'ready',JSON.stringify(done));assert.equal(done.mediaReady,true);assert.equal(done.resultAvailable,true);
 const receipt=await f.receipt();assert.equal(receipt.source_sha256,f.digest);assert.equal(receipt.size,f.size);assert.ok(receipt.reused_chunks>0);if(codec==='mp3'){assert.ok(receipt.recomputed_chunks>0);assert.equal(receipt.fallback_reason,'canonical_pcm_mismatch');}
 assert.equal((await f.jobs.result(f.job.id)).job.assetSha256,f.digest);assert.equal(JSON.parse(await readFile(path.join(f.dir,'jobs',f.job.id,'result.json'),'utf8')).provenance.source_sha256,f.digest);
 t.diagnostic(`${codec}: reused=${receipt.reused_chunks}, recomputed=${receipt.recomputed_chunks}, fallback=${receipt.fallback_reason}`);
});
test('real child cancellation after durable seal preserves complete media but publishes no result',{skip:!available,timeout:60000},async t=>{
 const f=await fixture(t,'mp3',{blockCanonical:true});await until(()=>exists(f.marker),Boolean);f.release.resolve();await until(()=>exists(f.canonical),Boolean,'canonical tail was not recomputed');assert.equal((await f.jobs.get(f.job.id)).mediaReady,true);
 await f.jobs.action(f.job.id,'cancel');await delay(150);assert.equal((await f.jobs.get(f.job.id)).state,'cancelled');assert.equal((await f.media.read('fixture')).sha256,f.digest);await assert.rejects(f.jobs.result(f.job.id));assert.equal(await exists(path.join(f.dir,'jobs',f.job.id,'result.json')),false);
});
