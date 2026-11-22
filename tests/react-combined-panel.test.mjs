import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Window} from 'happy-dom';import {webcrypto} from 'node:crypto';
const output=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {SourceJobsPanel} from './frontend/app/source-jobs-panel';import core from './reader/core.js';window.Coconut=core;window.CoconutCanonicalLibrary={project:(raw,normal)=>({...raw,...normal})};const root=createRoot(document.getElementById('root'));window.mount=()=>root.render(<SourceJobsPanel store={window.store} currentKey="one" onTasksChange={()=>{}}/>);window.unmount=()=>root.unmount();`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,format:'iife',write:false,define:{'process.env.NODE_ENV':'"production"'}});
const wait=async check=>{for(let n=0;n<200;n++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.ok(check());};
async function mount({ready=true,changed=null,auto=false}={}){const w=new Window({url:'http://localhost'});w.document.body.innerHTML='<div id="root"></div>';w.TextEncoder=TextEncoder;w.structuredClone=structuredClone;Object.defineProperty(w,'crypto',{value:webcrypto});w.CoconutClientCapabilities={allows:()=>true,identity:()=> 'client',generation:1,current:{libraryId:'library'}};
 let revision=1,commits=0,requested=0,resolve,finishSave,unsaved=0,reviewRequests=[];const gate=new Promise(r=>resolve=r);let media={identity:'source-media-sha256:'+'a'.repeat(64),url:'blob:authored'};let doc={key:'one',project_kind:'audio_only',title:'Video',source_url:'https://www.youtube.com/watch?v=abcdefghijk',video_source:{version:1,provider:'youtube',media_id:'abcdefghijk'},segments:[]};
 const job={id:'job',documentKey:'one',source:'source',binding:'binding',kind:'download_transcribe',assetSha256:'a'.repeat(64),mediaReady:true,state:'ready',updated:1,ingestionId:'ingestion',resultAvailable:ready,error:null,...(auto?{readingReviewProvider:'kimi'}:{})};
 w.store={getDocument:()=>doc,getMedia:()=>media,getRevision:()=>revision,flush:async()=>({ok:true}),getSnapshot:()=>({activeKey:'one',dirty:false,save:{unsaved}}),
 commitDocument:async next=>{commits++;if(auto){doc=next;revision++;unsaved=1;w.mount();await new Promise(r=>finishSave=r);unsaved=0;w.mount();}return true;}};
 w.fetch=async (url,options)=>{if(url==='api/v1/transcript-review/jobs'){reviewRequests.push(JSON.parse(options.body));return Response.json({});}if(url==='api/v1/source-jobs/capabilities')return Response.json({protocolVersion:1,downloadTranscribe:{available:true,local_only:true,acquisitionMode:'incremental-experimental-v1',backend:'qwen-mlx',fallback:'complete-file'}});if(url==='api/v1/ingestions/capabilities')return Response.json({transcription:{available:true}});if(url.endsWith('/result')){requested++;await gate;return Response.json({job,ingestion:{id:'ingestion',transcript:{document:{title:'Transcript',segments:[{id:'one',start:0,end:1,text:'Authored words'}]}}}});}return Response.json({jobs:[job]});};
 w.eval(output.outputFiles[0].text);w.mount();await wait(()=>w.document.body.textContent.includes('获取原声并转录'));
 return {w,commits:()=>commits,requested:()=>requested,reviewRequests,finishSave:()=>finishSave?.(),release(){if(changed==='media')media={...media,identity:'source-media-sha256:'+'b'.repeat(64)};if(changed==='revision')revision++;resolve();},close:async()=>{resolve();finishSave?.();w.unmount();await w.happyDOM.close();}};
}
test('combined result not marked available cannot be accepted',async()=>{const h=await mount({ready:false});try{assert.ok(!h.w.document.body.textContent.includes('将文字稿接入原项目'));assert.equal(h.commits(),0);}finally{await h.close();}});
for(const changed of [null,'media','revision'])test('combined result accept checks media and revision: '+changed,async()=>{const h=await mount({changed});try{await wait(()=>[...h.w.document.querySelectorAll('button')].some(b=>b.textContent==='将文字稿接入原项目'));[...h.w.document.querySelectorAll('button')].find(b=>b.textContent==='将文字稿接入原项目').click();await wait(()=>h.requested()===1);h.release();await wait(()=>h.w.document.body.textContent.includes(changed?'项目或任务已变化':'文字稿已保存'));assert.equal(h.commits(),changed?0:1);}finally{await h.close();}});

test('opted-in transcription appears before AI starts and queues the exact consented CLI after saving',async()=>{
 const h=await mount({auto:true});
 try{
  await wait(()=>h.requested()===1);h.release();
  await wait(()=>h.commits()===1);
  assert.deepEqual(h.reviewRequests,[]);
  h.finishSave();
  await wait(()=>h.reviewRequests.length===1);
  assert.equal(h.reviewRequests[0].provider,'kimi');
  assert.equal(h.reviewRequests[0].kind,'reading');
  assert.equal(h.reviewRequests[0].consent,true);
 }finally{await h.close();}
});
