import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {createReadabilityJobs} from '../desktop/readability-jobs.mjs';
import {startBridge} from '../desktop/server.mjs';
const document=()=>({schema_version:1,key:'interview',title:'访谈',language:'zh',segments:[{id:'one',start:0,end:2,text:'我们开始吧',speaker:null}],provenance:{kind:'automatic_subtitles'}});
const wait=async(fn)=>{for(let i=0;i<200;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,5));}assert.fail('Job did not settle');};
async function fixture(t,runWorker){const directory=await mkdtemp(path.join(tmpdir(),'coconut-resource-jobs-'));t.after(()=>rm(directory,{recursive:true,force:true}));const model=path.join(directory,'model.onnx');await writeFile(model,'authored model placeholder');const options={directory,python:process.execPath,punctuationModel:model,segmentationModel:model,embeddingModel:model,runWorker};return {directory,options};}
const stream=bytes=>Object.assign(Readable.from([bytes]),{headers:{'content-type':'application/octet-stream','content-length':String(bytes.length)}});
test('durable jobs select only missing stages; audio upload gates voices, source remains unchanged, restart retains result',async t=>{
 let calls=0;const f=await fixture(t,async({document:doc,steps,media})=>{calls++;assert.deepEqual(steps,['punctuation','speakers']);assert.equal((await readFile(media)).toString(),'authored-audio');doc.segments[0].original_text=doc.segments[0].text;doc.segments[0].text+='。';doc.segments[0].speaker='说话人 1';doc.provenance.punctuation_method='local-reading-v1';doc.provenance.speaker_method='recording-acoustic-v1';return doc;});
 let service=await createReadabilityJobs(f.options);t.after(()=>service.shutdown());
 const input={protocolVersion:1,operation_id:randomUUID(),document:document(),media:{identity:'media:one',name:'source.m4a',size:14}};
 const job=await service.create(input);assert.equal(job.state,'awaiting_media');assert.equal(calls,0);assert.deepEqual(await service.create(input),job);
 await assert.rejects(service.create({...input,document:{...input.document,title:'different'}}),/另一份/);
 await service.upload(job.id,stream(Buffer.from('authored-audio')));
 await wait(()=>service.get(job.id).state==='ready');assert.equal(calls,1);
 const ready=await service.result(job.id);assert.equal(ready.input.segments[0].text,'我们开始吧');assert.equal(ready.result.segments[0].text,'我们开始吧。');assert.equal(input.document.segments[0].text,'我们开始吧');
 await assert.rejects(service.upload(job.id,stream(Buffer.from('different-data'))),/不一致/);
 await service.shutdown();service=await createReadabilityJobs(f.options);assert.equal((await service.result(job.id)).result.segments[0].speaker,'说话人 1');assert.equal(calls,1);
});
test('punctuation-only job needs no audio or ASR; failures can retry and running cancellation keeps source',async t=>{
 let calls=0,started;const f=await fixture(t,async({document:doc,signal})=>{calls++;if(calls===1)throw Error('authored failure');if(calls===3)return new Promise((resolve,reject)=>{started=true;signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});});doc.segments[0].text+='。';return doc;});const service=await createReadabilityJobs(f.options);t.after(()=>service.shutdown());
 const input={protocolVersion:1,operation_id:randomUUID(),document:document()};const job=await service.create(input);assert.deepEqual(job.steps,['punctuation']);await wait(()=>service.get(job.id).state==='failed');await service.action(job.id,'retry');await wait(()=>service.get(job.id).state==='ready');
 const second=await service.create({...input,operation_id:randomUUID()});await wait(()=>started);await service.action(second.id,'cancel');await wait(()=>service.get(second.id).state==='cancelled');await assert.rejects(service.result(second.id),/尚未完成/);
});
test('HTTP protocol requires reader origin, keeps resource upload separate, and exposes recoverable job/result routes',async t=>{
 const f=await fixture(t,async({document:doc})=>({...doc,segments:doc.segments.map(c=>({...c,text:c.text+'。'}))}));const jobs=await createReadabilityJobs(f.options);const server=await startBridge({port:0,readabilityJobs:jobs});t.after(()=>server.shutdown());const origin='http://127.0.0.1:'+server.address().port;
 const send=(route,data,headers={})=>fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
 assert.equal((await fetch(origin+'/api/v1/readability/capabilities')).status,200);
 const input={protocolVersion:1,operation_id:randomUUID(),document:document()};assert.equal((await send('/api/v1/readability/jobs',input,{Origin:'https://evil.test'})).status,403);
 const response=await send('/api/v1/readability/jobs',input);assert.equal(response.status,201);const {job}=await response.json();await wait(()=>jobs.get(job.id).state==='ready');
 const result=await (await fetch(origin+'/api/v1/readability/jobs/'+job.id+'/result')).json();assert.equal(result.job.result.segments[0].text,'我们开始吧。');assert.equal((await (await fetch(origin+'/api/v1/readability/jobs?key=interview')).json()).jobs.length,1);
 const audioInput={...input,operation_id:randomUUID(),media:{identity:'audio:one',name:'source.m4a',size:14}};
 const audioJob=(await (await send('/api/v1/readability/jobs',audioInput)).json()).job;
 const uploaded=await fetch(origin+'/api/v1/readability/jobs/'+audioJob.id+'/media',{method:'POST',headers:{Origin:origin,'Content-Type':'application/octet-stream'},body:Buffer.from('authored-audio')});assert.equal(uploaded.status,200);
 const route=origin+'/api/v1/readability/jobs/'+audioJob.id+'/media',partial=await fetch(route,{headers:{Range:'bytes=2-6'}});assert.equal(partial.status,206);assert.equal(partial.headers.get('content-range'),'bytes 2-6/14');assert.equal(await partial.text(),'thore');
 const head=await fetch(route,{method:'HEAD'});assert.equal(head.headers.get('content-length'),'14');assert.equal((await head.arrayBuffer()).byteLength,0);
 assert.equal((await fetch(route,{headers:{Range:'bytes=99-100'}})).status,416);
});
