import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Window} from 'happy-dom';
import {webcrypto} from 'node:crypto';

// The real component, file inspection and durable-save helper run together.
// Only HTTP responses and store persistence latency are controlled; no public
// network, media decoding or successful server-side rollback is claimed.
const built=await build({stdin:{contents:`import React,{useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';import {MediaSource} from './frontend/app/media-source';function App(){useSyncExternalStore(window.store.subscribe,window.store.getSnapshot);return <MediaSource store={window.store} documentKey="episode"/>;}const root=createRoot(document.getElementById('root'));window.mount=()=>root.render(<App/>);window.unmount=()=>root.unmount();`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,format:'iife',platform:'browser',write:false,define:{'process.env.NODE_ENV':'"production"'}});
const code=built.outputFiles[0].text;
const wait=async check=>{for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.ok(check(),'component did not settle');};
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
async function mount({flushGate,hashGate,uploadGate}={}){
 const w=new Window({url:'http://localhost/'}),listeners=new Set(),activities=new Map(),requests=[];
 let file=null,media=null,revision=0,flushStarted=false,hashStarted=false,digests=0;
 const publish=()=>{revision++;for(const listener of listeners)listener();};
 const digest=async(...args)=>{const result=await webcrypto.subtle.digest(...args);if(++digests===3&&hashGate){hashStarted=true;await hashGate.promise;}return result;};
 Object.defineProperty(w,'crypto',{value:{subtle:{digest}}});w.File=File;w.Blob=Blob;w.TextEncoder=TextEncoder;
 w.document.body.innerHTML='<div id="root"></div>';
 const document={key:'episode',source_url:'https://publisher.example.org/episode',podcast_source:{media_url:'https://publisher.example.org/source.m4a'},segments:[]};
 const store={getDocument:()=>document,getMedia:()=>media,getFile:()=>file,getSnapshot:()=>revision,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},getRemoteMedia:()=>({kind:'audio',name:'Source',download:{endpoint:'/api/podcasts/media',body:{}}}),setActivity:(key,value)=>activities.set(key,value),flush:async()=>{flushStarted=true;if(flushGate)await flushGate.promise;return {ok:true};},setFile:(_key,value)=>{file=value;},setMedia:(_key,value)=>{media=value;publish();}};
 w.store=store;w.fetch=async(url,init)=>{requests.push({url,init});if(url==='api/podcasts/media')return new Response('authored source bytes',{headers:{'Content-Type':'audio/mp4'}});assert.match(url,/^api\/v1\/source-media\?/);if(uploadGate)await uploadGate.promise;return Response.json({media:{protocolVersion:1,binding:'a'.repeat(64),sha256:'b'.repeat(64),size:21,type:'audio/mp4',name:'Source.m4a',kind:'audio'}});};
 w.eval(code);w.mount();await wait(()=>w.document.querySelector('button'));
 const choose=(fileOnly=false)=>{const newerFile=new File(['new local bytes'],'new-local.m4a',{type:'audio/mp4'}),newerMedia={url:'blob:newer-local',kind:'audio',name:'new-local.m4a',identity:'new-local',availability:'local_session'};store.setFile('episode',newerFile);if(!fileOnly)store.setMedia('episode',newerMedia);return {file:newerFile,media:fileOnly?null:newerMedia};};
 return {w,store,requests,activities,choose,flushStarted:()=>flushStarted,hashStarted:()=>hashStarted,close:async()=>{w.unmount();await w.happyDOM.close();}};
}
test('real podcast component and durable helper keep a newer local selection when an old POST receipt arrives late',async()=>{
 const gate=deferred(),h=await mount({uploadGate:gate});try{
  h.w.document.querySelector('button').click();await wait(()=>h.requests.length===2);const upload=h.requests[1];const newer=h.choose();assert.equal(upload.init.signal.aborted,true);
  // Simulate a server that committed just before cancellation. This response is
  // not evidence of rollback: only the current attachment must remain newer.
  gate.resolve();await wait(()=>![...h.activities.values()].some(Boolean));assert.equal(h.store.getFile(),newer.file);assert.equal(h.store.getMedia(),newer.media);assert.equal(h.store.getMedia().availability,'local_session');assert.equal(h.requests.length,2);
 }finally{gate.resolve();await h.close();}
});
for(const stage of ['flush','hash'])test('a newer file during '+stage+' prevents the real component/helper from starting an obsolete upload',async()=>{
 const gate=deferred(),h=await mount(stage==='flush'?{flushGate:gate}:{hashGate:gate});try{
  h.w.document.querySelector('button').click();await wait(()=>stage==='flush'?h.flushStarted():h.hashStarted());const newer=h.choose(stage==='hash');gate.resolve();await wait(()=>![...h.activities.values()].some(Boolean));assert.equal(h.requests.length,1);assert.equal(h.store.getFile(),newer.file);assert.equal(h.store.getMedia(),newer.media);
 }finally{gate.resolve();await h.close();}
});
test('the real helper successful attachment is not cancelled by the component as a competing selection',async()=>{
 const h=await mount();try{
  h.w.document.querySelector('button').click();await wait(()=>h.store.getMedia());assert.match(h.store.getMedia().url,/^api\/v1\/source-media\/content\?/);assert.equal(h.store.getMedia().availability,'remote');assert.equal(await h.store.getFile().text(),'authored source bytes');assert.equal(h.requests.length,2);assert.equal(h.requests[1].init.signal.aborted,false);await wait(()=>![...h.activities.values()].some(Boolean));
 }finally{await h.close();}
});
