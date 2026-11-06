import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Window} from 'happy-dom';
import {webcrypto} from 'node:crypto';

// Mount the real podcast component and file validators. Only the shared durable
// storage boundary is controlled here; its actual HTTP/SQLite tests live with
// source-media. These tests never claim browser decoding or public-network proof.
const built=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {MediaSource} from './frontend/app/media-source';const root=createRoot(document.getElementById('root'));window.mount=(store,key)=>root.render(<MediaSource store={store} documentKey={key}/>);window.unmount=()=>root.unmount();`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,format:'iife',platform:'browser',write:false,define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'storage-boundary',setup(build){build.onResolve({filter:/^\.\/source-media$/},()=>({path:'storage-boundary',namespace:'test'}));build.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const saveSourceMedia=(...args)=>window.saveMedia(...args);',loader:'js'}));}}]});
const source=built.outputFiles[0].text;
const wait=async check=>{for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.ok(check(),'component did not settle');};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function mount({download,save}={}){
 const w=new Window({url:'http://localhost/'});Object.defineProperty(w,'crypto',{value:webcrypto});w.File=File;w.Blob=Blob;w.TextEncoder=TextEncoder;
 w.document.body.innerHTML='<div id="root"></div>';
 let document={key:'episode',title:'Exact publisher episode'},calls=0,file=null,media=null;const saves=[],activity=[],listeners=new Set();
 const remote={kind:'audio',name:'Exact publisher episode',download:{endpoint:'/api/podcasts/media',body:{feedUrl:'https://publisher.example/feed',episodeId:'a'.repeat(64),mediaUrl:'https://publisher.example/episode.m4a'}}};
 const store={getDocument:()=>document,getRemoteMedia:()=>remote,getMedia:()=>media,getFile:()=>file,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},setActivity:(...args)=>activity.push(args),setFile:()=>assert.fail('component must not attach transient file'),setMedia:()=>assert.fail('component must not attach a transient Blob')};
 w.fetch=async(...args)=>{calls++;assert.equal(args[0],'api/podcasts/media');return download?download(...args):new Response('authored media bytes',{headers:{'Content-Type':'audio/mp4'}});};
 w.saveMedia=async(...args)=>{saves.push(args);return save?.(...args);};w.eval(source);w.mount(store,'episode');await wait(()=>w.document.querySelector('button'));
 return {w,store,remote,saves,activity,calls:()=>calls,replaceMedia:()=>{file=new File(['new local choice'],'new.mp3',{type:'audio/mpeg'});media={url:'blob:new-local-choice'};for(const listener of listeners)listener();w.mount(store,'episode');},switchDocument:()=>{document={...document,key:'new-episode'};w.mount(store,'new-episode');},replaceDocument:()=>{document={...document,title:'Different owner'};},close:async()=>{w.unmount();await w.happyDOM.close();}};
}
test('podcast download waits for durable storage, preserves file MIME and never creates a transient player',async()=>{
 const pending=deferred(),h=await mount({save:()=>pending.promise});try{
  assert.equal(h.calls(),0);assert.doesNotMatch(h.w.document.body.textContent,/本页保留/);
  const button=h.w.document.querySelector('button');button.click();button.click();await wait(()=>h.saves.length===1&&button.textContent.includes('正在保存'));
  assert.equal(h.calls(),1);assert.match(button.textContent,/正在保存/);assert.equal(button.disabled,true);
  const [store,key,file,signal]=h.saves[0];assert.equal(store,h.store);assert.equal(key,'episode');assert.equal(file.type,'audio/mp4');assert.match(file.name,/\.m4a$/);assert.equal(await file.text(),'authored media bytes');assert.equal(signal.aborted,false);
  pending.resolve();await wait(()=>!button.disabled);assert.match(button.textContent,/载入原声/);
 }finally{await h.close();}
});
test('storage failure is visible and a deliberate retry is possible without claiming saved playback',async()=>{
 let attempts=0;const h=await mount({save:async()=>{if(++attempts===1)throw new h.w.Error('磁盘写入失败，原声未保存');}});try{
  h.w.document.querySelector('button').click();await wait(()=>h.w.document.querySelector('[role=status]').textContent.includes('未保存'));
  assert.equal(h.saves.length,1);h.w.document.querySelector('button').click();await wait(()=>h.saves.length===2&&!h.w.document.querySelector('button').disabled);
  assert.equal(h.w.document.querySelector('[role=status]').textContent,'');
 }finally{await h.close();}
});
test('cancel during saving propagates AbortSignal and suppresses a late failed save',async()=>{
 const pending=deferred(),h=await mount({save:()=>pending.promise});try{
  h.w.document.querySelector('button').click();await wait(()=>h.saves.length===1);
  [...h.w.document.querySelectorAll('button')].find(b=>b.textContent==='取消').click();assert.equal(h.saves[0][3].aborted,true);
  pending.reject(Error('late cancellation'));await new Promise(r=>setTimeout(r,20));assert.equal(h.w.document.querySelector('[role=status]').textContent,'');assert.equal(h.w.document.querySelector('button').disabled,false);
 }finally{await h.close();}
});
test('late downloaded bytes cannot be persisted to a changed or unmounted project',async()=>{
 for(const retire of ['replace','unmount']){const pending=deferred(),h=await mount({download:()=>pending.promise});try{
  h.w.document.querySelector('button').click();await wait(()=>h.calls()===1);if(retire==='replace')h.replaceDocument();else h.w.unmount();
  pending.resolve(new Response('authored bytes',{headers:{'Content-Type':'audio/mp4'}}));await new Promise(r=>setTimeout(r,30));assert.equal(h.saves.length,0);
 }finally{await h.close();}}
});
test('wrong MIME, playlist payload and oversized media never reach durable storage',async()=>{
 for(const variant of ['mime','playlist','size']){let cancelled=false;const h=await mount({download:async()=>variant==='size'?{ok:true,body:{getReader:()=>({read:async()=>({done:false,value:{byteLength:201*1024*1024}}),cancel:async()=>{cancelled=true;}})}}:new Response(variant==='playlist'?'#EXTM3U\nhttps://example.org/private':'authored bytes',{headers:{'Content-Type':variant==='mime'?'text/html':'audio/mp4'}})});try{
  h.w.document.querySelector('button').click();await wait(()=>h.w.document.querySelector('[role=status]').textContent.length>0);assert.equal(h.saves.length,0);if(variant==='size')assert.equal(cancelled,true);
 }finally{await h.close();}}
});

test('a newer local media choice retires an in-flight remote download without persisting stale bytes',async()=>{
 const pending=deferred();let signal;const h=await mount({download:(_url,init)=>{signal=init.signal;return pending.promise;}});try{
  h.w.document.querySelector('button').click();await wait(()=>h.calls()===1);h.replaceMedia();await wait(()=>!h.w.document.querySelector('button'));assert.equal(signal.aborted,true);
  pending.resolve(new Response('older remote bytes',{headers:{'Content-Type':'audio/mp4'}}));await new Promise(r=>setTimeout(r,30));assert.equal(h.saves.length,0);
  assert.ok(h.activity.some(([key,message])=>key==='media-download'&&message===null));
 }finally{await h.close();}
});

test('switching projects or hiding the page retires the owner and allows a fresh explicit download',async()=>{
 for(const action of ['switch','pagehide']){const pending=deferred();let oldSignal,calls=0;const h=await mount({download:(_url,init)=>{if(++calls===1){oldSignal=init.signal;return pending.promise;}return new Response('new source bytes',{headers:{'Content-Type':'audio/mp4'}});}});try{
  h.w.document.querySelector('button').click();await wait(()=>h.calls()===1&&h.w.document.querySelector('button').disabled);
  if(action==='switch')h.switchDocument();else h.w.dispatchEvent(new h.w.Event('pagehide'));
  await wait(()=>oldSignal.aborted&&!h.w.document.querySelector('button').disabled);h.w.document.querySelector('button').click();await wait(()=>h.saves.length===1);
  assert.equal(h.saves[0][1],action==='switch'?'new-episode':'episode');assert.equal(await h.saves[0][2].text(),'new source bytes');
  pending.resolve(new Response('stale source bytes',{headers:{'Content-Type':'audio/mp4'}}));await new Promise(r=>setTimeout(r,30));assert.equal(h.saves.length,1);
 }finally{await h.close();}}
});
