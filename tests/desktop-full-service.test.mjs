import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {desktopTranscriptionSettings,startDesktopService} from '../desktop/full-service.mjs';
import {serviceConfig} from '../server/config.mjs';

async function directory(t){const data=await mkdtemp(path.join(tmpdir(),'coconut-desktop-full-'));return data;}
test('Finder configuration shares standalone profile without inheriting listener or credentials',async t=>{
 const data=await directory(t),env={COCONUT_ASR_PYTHON:'/custom/python',COCONUT_MODEL_DIRECTORY:'/models',COCONUT_ASR_BACKEND:'qwen-mlx'};
 await writeFile(path.join(data,'transcription.json'),JSON.stringify(env));
 const config=await desktopTranscriptionSettings({userDataDirectory:data,env:{COCONUT_HOST:'0.0.0.0',COCONUT_OWNER_TOKEN:'not-used'}});
 assert.deepEqual(config.asrProfile,serviceConfig(env).asrProfile);assert.equal(config.asrPython,env.COCONUT_ASR_PYTHON);
 assert.equal(config.host,undefined);assert.equal(config.ownerToken,undefined);
 const overridden=await desktopTranscriptionSettings({userDataDirectory:data,env:{COCONUT_ASR_PYTHON:'/another/python'}});assert.equal(overridden.asrPython,'/another/python');
});
test('missing Python never prevents desktop source storage and restart',async t=>{
 const data=await directory(t),options={userDataDirectory:data,env:{},port:0,libraryDirectory:path.join(data,'library'),taskDirectory:path.join(data,'tasks')};
 for(let i=0;i<2;i++){
  const server=await startDesktopService(options);t.after(()=>server.shutdown());const origin=`http://127.0.0.1:${server.address().port}`;
  const health=await(await fetch(origin+'/api/health')).json();assert.equal(health.client.capabilities.sourceJobs,true);assert.equal(health.client.capabilities.sourceMedia,true);
  const response=await fetch(origin+'/api/v1/source-jobs');assert.equal(response.status,400);assert.doesNotMatch(await response.text(),/来源任务未启用/);
  const capabilities=await(await fetch(origin+'/api/v1/ingestions/capabilities')).json();assert.equal(capabilities.transcription.available,false);assert.equal(capabilities.transcription.code,'asr_not_configured');
  await server.shutdown();
 }
});
test('invalid runtime settings fail closed for models but preserve reading and source tasks',async t=>{
 const data=await directory(t);await writeFile(path.join(data,'transcription.json'),JSON.stringify({COCONUT_ASR_PYTHON:'relative'}));
 const server=await startDesktopService({userDataDirectory:data,env:{},port:0,libraryDirectory:path.join(data,'library'),taskDirectory:path.join(data,'tasks')});t.after(()=>server.shutdown());
 const origin=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(origin+'/api/v1/library')).status,200);
 const status=(await(await fetch(origin+'/api/v1/ingestions/capabilities')).json()).transcription;
 assert.equal(status.code,'desktop_transcription_config_invalid');assert.equal(status.available,false);assert.equal(status.automatic,false);await server.shutdown();
});
test('settings reject unknown secret/network fields instead of accepting an arbitrary service profile',async t=>{
 const data=await directory(t);await writeFile(path.join(data,'transcription.json'),JSON.stringify({COCONUT_OWNER_TOKEN:'not-a-model-setting'}));
 await assert.rejects(desktopTranscriptionSettings({userDataDirectory:data,env:{}}),/配置格式无效/);
});
test('desktop owns download and alignment jobs across restart and aborts active work on shutdown',async t=>{
 const {randomUUID,createHash}=await import('node:crypto');const {setTimeout:delay}=await import('node:timers/promises');
 const {sourceMediaIdentity}=await import('../shared/source-media.js');
 const data=await directory(t),document={key:'desktop-source',title:'Source',source_url:'https://example.test/episode',project_kind:'transcript',podcast_source:{kind:'direct_media',media_url:'https://example.test/audio.mp3',media_kind:'audio'},segments:[{id:'a',start:0,end:1,text:'Original'}]};
 let calls=0,aborted=false;const transcriber={profile:{backend:'test'},status:async()=>({available:true}),alignmentStatus:async()=>({available:true}),align:async({signal})=>{calls++;try{await delay(10000,null,{signal});}finally{aborted=signal.aborted;}}};
 const options={userDataDirectory:data,env:{},port:0,libraryDirectory:path.join(data,'library'),taskDirectory:path.join(data,'tasks'),transcriber,podcastSources:{downloadMedia:async()=>({body:Buffer.from('authored audio'),type:'audio/mpeg'})}};
 let server=await startDesktopService(options);t.after(async()=>{await server.shutdown();await rm(data,{recursive:true,force:true});});let origin=`http://127.0.0.1:${server.address().port}`;
 const post=async(route,value)=>{const response=await fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});assert.ok(response.ok,await response.clone().text());return response.json();};
 const epoch=(await(await fetch(origin+'/api/v1/library')).json()).epoch;
 await post('/api/v1/library/commit',{protocolVersion:1,epoch,key:document.key,receiptKey:randomUUID(),expected:null,action:'put',document});
 const source=createHash('sha256').update(sourceMediaIdentity(document)).digest('hex');
 const create=kind=>post('/api/v1/source-jobs',{protocolVersion:1,operation_id:randomUUID(),libraryId:epoch,key:document.key,source,kind,consent:true});
 const {job}=await create('download');
 let ready=false;for(let i=0;i<100;i++){if((await(await fetch(origin+'/api/v1/source-jobs/'+job.id)).json()).job.state==='ready'){ready=true;break;}await delay(10);}assert.equal(ready,true);
 const {job:alignment}=await create('align');for(let i=0;i<100&&calls===0;i++)await delay(10);assert.equal(calls,1);
 await server.shutdown();assert.equal(aborted,true);
 server=await startDesktopService(options);origin=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await(await fetch(origin+'/api/v1/source-jobs/'+alignment.id)).json()).job.state,'interrupted');assert.equal(calls,1);
 assert.equal((await fetch(origin+'/api/v1/source-jobs',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})).status,403);
});
test('task close lease rejects new work until matching owner releases it',async t=>{
 const data=await directory(t),server=await startDesktopService({userDataDirectory:data,env:{},port:0,libraryDirectory:path.join(data,'library'),taskDirectory:path.join(data,'tasks')});
 t.after(async()=>{await server.shutdown();await rm(data,{recursive:true,force:true});});
 const gate=server.sourceTaskLifecycle;assert.equal(gate.pause(1),true);assert.equal(gate.pause(2),false);gate.resume(2);assert.equal(gate.pause(2),false);gate.resume(1);assert.equal(gate.pause(2),true);gate.resume(2);
 assert.deepEqual(gate.activity(),{active:0});
});
