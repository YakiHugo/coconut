/** Authored DOM/File fixtures only. Never uploads, decodes real media, or calls a service. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';
import {Window} from 'happy-dom';
import {installSavePipeline,settle} from './helpers/save-pipeline.mjs';
const require=createRequire(import.meta.url),C=require('../reader/core.js');
const root=new URL('../',import.meta.url),KEY='coconut-reader-v1';
const clone=value=>JSON.parse(JSON.stringify(value));
const localSource={version:1,kind:'audio',name:'Original.wav',size:64,last_modified:7,type:'audio/wav',fingerprint:'a'.repeat(64)};
function transcript(overrides={}){
 const doc=C.validate({title:'Authored transcript',language:'en',source_url:'https://example.org/original',segments:[
  {id:'a',start:10,end:12,text:'Actual corrected opening',original_text:'Actual opening',saved_excerpt:true},
  {id:'b',start:20,end:24,text:'Actual closing'}],notes:{a:'Keep cue note'},project_note:'Keep project note',
  timestamp_bookmarks:[{id:'bookmark',time:25,note:'Keep time bookmark'}],readingPosition:'b',
  reading_chapters:[{id:'chapter',title:'Opening chapter',cue_id:'a',time:10,note:'Keep chapter note'}],
  ai_answers:[{question:'Authored old question',answer:'Authored historical answer',citations:['a'],provider:'fixture',purpose:'question'}],...overrides});
 doc.exact_excerpts=[C.exactExcerptSnapshot(doc,doc.segments.slice(0,1),[],0,6,{id:'excerpt',createdAt:'2026-10-11T00:00:00.000Z'})];
 return doc;
}
function setup(storage={},options={}){
 const w=new Window({url:'https://coconut.example/'}),calls=[],created=[],revoked=[],releases=[];
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});for(const [key,value] of Object.entries(storage))w.localStorage.setItem(key,value);
 w.fetch=async url=>{calls.push(url);throw new Error('No network permitted');};
 w.URL.createObjectURL=file=>{const url='blob:association-'+(created.length+1);created.push({url,file});return url;};w.URL.revokeObjectURL=url=>revoked.push(url);
 const pipeline=installSavePipeline(w,options);
 w.eval(['summary','core','passages','passage-playback','app'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+`\nwindow.associationTest={active:()=>active(),docs:()=>state.documents,media:()=>browserMedia,flush:()=>libraryStore.flush(),commit:doc=>commitDocument(doc),render:()=>render(),fingerprint:file=>fingerprintMedia(file),replaceDocument:()=>{const doc=active();state.documents[state.documents.indexOf(doc)]={...doc};render();},resetListen:()=>{listeningSession.engaged=false;renderListeningResume();}};`);
 return {w,$:id=>w.document.getElementById(id),calls,created,revoked,releases,pipeline};
}
async function close(env){
 if(!env)return;env.pipeline.hold(false);for(const release of env.releases)release();
 if(env.$('local-media-project-dialog').open)env.$('cancel-local-media-project').click();
 for(const write of env.pipeline.writes)write.commit();await settle();await env.w.happyDOM.close();
}
const snapshot=w=>Object.fromEntries(Array.from({length:w.localStorage.length},(_,i)=>{const key=w.localStorage.key(i);return [key,w.localStorage.getItem(key)];}));
function file(w,name='Original.wav',bytes='RIFF authored local audio',extra={}){return new w.File([bytes],name,{type:name.endsWith('.mp4')?'video/mp4':'audio/wav',lastModified:7,...extra});}
async function pick(env,selected,action='attach-reader-media'){
 const input=env.$(action==='open-local-media'?'local-media-file':'reader-media-file');
 env.$(action).click();Object.defineProperty(input,'files',{configurable:true,value:[selected]});return input.onchange();
}
async function importJSON(env,doc){
 const text=JSON.stringify(doc);Object.defineProperty(env.$('file'),'files',{configurable:true,value:[{name:'authored.json',size:text.length,text:async()=>text,arrayBuffer:async()=>new TextEncoder().encode(text).buffer}]});await env.$('file').onchange();return env.w.associationTest.active();
}
async function attachTranscript(env,doc=transcript()){
 env.$('attach-project-transcript').click();const text=JSON.stringify(doc);Object.defineProperty(env.$('project-transcript-file'),'files',{configurable:true,value:[{name:'captions.json',size:text.length,text:async()=>text,arrayBuffer:async()=>new TextEncoder().encode(text).buffer}]});await env.$('project-transcript-file').onchange();return env.w.associationTest.active();
}
async function until(predicate,label='asynchronous checkpoint reached'){
 for(let i=0;i<150&&!predicate();i++){await settle();await new Promise(resolve=>setTimeout(resolve,1));}assert.ok(predicate(),label);
}
async function chooser(env){await until(()=>env.$('local-media-project-dialog').open,'explicit association chooser opens');return env.$('local-media-project-dialog');}
function candidate(env,key){const button=[...env.$('local-media-project-options').children].find(button=>button.dataset.documentKey===key);assert.ok(button,'exact existing document is offered');return button;}
function selectLibrary(env,key){const entry=[...env.w.document.querySelectorAll('.library-entry')].find(entry=>entry.dataset.documentKey===key);assert.ok(entry);entry.querySelector('.library-open').click();}
function player(env,duration=120){
 const p=env.$('source-media').querySelector('audio,video');assert.ok(p,'selected file has an owned player');let paused=true;
 Object.defineProperties(p,{duration:{configurable:true,value:duration},paused:{configurable:true,get:()=>paused}});
 p.play=async()=>{paused=false;p.dispatchEvent(new env.w.Event('play'));};p.pause=()=>{paused=true;p.dispatchEvent(new env.w.Event('pause'));};p.dispatchEvent(new env.w.Event('loadedmetadata'));return p;
}
async function calibrate(env,offset=2){env.$('media-timing-offset').value=String(offset);env.$('media-timing-offset').dispatchEvent(new env.w.Event('input'));await env.$('media-timing-save').onclick();}
async function listen(env,p,time=42){await p.play();p.currentTime=time;p.pause();await env.w.associationTest.flush();return 'coconut-listening-v1:'+env.w.associationTest.active().key;}
function evidence(doc){return JSON.stringify(Object.fromEntries(['key','title','language','source_url','segments','notes','project_note','timestamp_bookmarks','readingPosition','reading_chapters','exact_excerpts','ai_answers'].filter(key=>key in doc).map(key=>[key,doc[key]])));}
function delayedFile(env,chosen=file(env.w)){
 let release;const gate=new Promise(resolve=>{release=resolve;});let reading=false,held=false;
 env.releases.push(release);
 return {selected:{name:chosen.name,size:chosen.size,lastModified:chosen.lastModified,type:chosen.type,slice:(start,end)=>{const part=chosen.slice(start,end);return {text:()=>part.text(),arrayBuffer:async()=>{if(!held){held=true;reading=true;await gate;}return part.arrayBuffer();}};}},release,get reading(){return reading;}};
}
async function bound(env,selected=file(env.w)){await importJSON(env,transcript());const doc=env.w.associationTest.active();await pick(env,selected);return doc;}

// Core export/import invariants do not depend on object URL or DOM behavior.
test('transcript local source roundtrips only metadata and never accepts a competing hosted source',()=>{
 const original=transcript(),doc=C.validate({...original,local_media_source:{...localSource,bytes:'private bytes',url:'blob:private',path:'/private/source.wav'}});
 assert.deepEqual(doc.local_media_source,localSource);assert.equal(doc.project_kind,undefined);assert.deepEqual(doc.segments,original.segments);
 assert.deepEqual(C.validate(clone(doc)).local_media_source,localSource);assert.doesNotMatch(JSON.stringify(doc.local_media_source),/blob:|private|bytes|path|url/);
 for(const other of [{source_media:{job_id:'b'.repeat(32),kind:'audio'}},{podcast_source:{kind:'direct_media',media_url:'https://example.org/audio.mp3',media_kind:'audio'}}])assert.throws(()=>C.validate({...doc,...other}),/本地文件来源/);
 assert.deepEqual(doc.exact_excerpts,original.exact_excerpts);assert.equal(C.exactExcerptFreshness(doc.exact_excerpts[0],doc),'stale');
});

test('transcript-first association persists the existing key and metadata, then reload requires matching-file reselection',async()=>{
 const env=setup();let fresh;try{
  const doc=await importJSON(env,transcript()),before=evidence(doc),historical=JSON.stringify(doc.exact_excerpts);assert.equal(env.$('replace-reader-media').hidden,true);assert.equal(env.$('unlink-reader-media').hidden,true);
  assert.equal(C.exactExcerptFreshness(clone(doc.exact_excerpts[0]),clone(doc)),'current');assert.equal(doc.exact_excerpts[0].snapshot.source.local_media_source,undefined);
  await pick(env,file(env.w));assert.equal(env.w.associationTest.active(),doc);assert.equal(evidence(doc),before);assert.equal(doc.local_media_source.version,1);assert.equal(doc.local_media_source.name,'Original.wav');
  assert.equal(JSON.stringify(doc.exact_excerpts),historical);assert.equal(C.exactExcerptFreshness(clone(doc.exact_excerpts[0]),clone(doc)),'stale');
  assert.equal(env.w.associationTest.docs().length,1);assert.equal(doc.project_kind,undefined);assert.equal(env.$('replace-reader-media').hidden,false);assert.equal(env.$('unlink-reader-media').hidden,false);
  const saved=env.w.localStorage.getItem(KEY),decoded=JSON.parse(saved).documents[0];assert.equal(decoded.key,doc.key);assert.deepEqual(decoded.local_media_source,clone(doc.local_media_source));assert.doesNotMatch(saved,/blob:|RIFF authored local audio|base64/);assert.equal(env.calls.length,0);
  fresh=setup(snapshot(env.w));assert.equal(fresh.w.associationTest.active().key,doc.key);assert.equal(fresh.$('source-media').querySelector('audio'),null);assert.match(fresh.$('reader-media-status').textContent,/重新选择.*Original.wav/);
  const reloaded=fresh.w.associationTest.active();assert.equal(JSON.stringify(reloaded.exact_excerpts),historical);assert.equal(C.exactExcerptFreshness(clone(reloaded.exact_excerpts[0]),clone(reloaded)),'stale');
  const changedBytes=new Uint8Array(await file(fresh.w).arrayBuffer());changedBytes[10]^=1;const mismatched=file(fresh.w,'Original.wav',changedBytes);assert.equal(mismatched.size,file(fresh.w).size);
  await pick(fresh,mismatched);assert.equal(fresh.created.length,0);assert.equal(evidence(fresh.w.associationTest.active()),before);assert.match(fresh.$('notice').textContent,/文件信息或部分内容与原文件不同/);
  await pick(fresh,file(fresh.w));assert.ok(fresh.$('source-media').querySelector('audio'));assert.equal(fresh.w.associationTest.active().key,doc.key);assert.equal(fresh.w.associationTest.docs().length,1);assert.equal(fresh.calls.length,0);
 }finally{await close(env);await close(fresh);}
});

test('audio-first subtitle attachment keeps the same project; even its sole transcript candidate requires a home choice',async()=>{
 const env=setup();try{
  await pick(env,file(env.w),'open-local-media');const original=env.w.associationTest.active(),key=original.key,source=clone(original.local_media_source);assert.equal(env.$('replace-reader-media').hidden,true);assert.equal(env.$('unlink-reader-media').hidden,true);
  const attached=await attachTranscript(env);assert.equal(attached.key,key);assert.deepEqual(clone(attached.local_media_source),source);assert.equal(attached.project_kind,undefined);assert.equal(attached.segments[0].text,'Actual corrected opening');
  env.$('add-content').click();const pending=pick(env,file(env.w),'open-local-media');await chooser(env);assert.equal(env.$('local-media-project-options').children.length,1);assert.equal(env.$('new-local-media-project').hidden,false);assert.equal(env.created.length,1);
  candidate(env,key).click();await pending;assert.equal(env.w.document.activeElement,env.$('title'));assert.equal(env.w.associationTest.active(),attached);assert.equal(env.w.associationTest.docs().length,1);assert.equal(env.created.length,2);assert.equal(env.calls.length,0);
 }finally{await close(env);}
});

test('home cancel is inert and explicitly choosing a new project never steals a transcript or merges its annotations',async()=>{
 const env=setup();try{
  const doc=await bound(env),before=evidence(doc),source=clone(doc.local_media_source);env.$('add-content').click();
  let pending=pick(env,file(env.w),'open-local-media');await chooser(env);env.$('cancel-local-media-project').click();await pending;
  assert.equal(env.created.length,1);assert.equal(env.w.associationTest.docs().length,1);assert.equal(env.$('add-workspace').hidden,false);assert.equal(evidence(doc),before);
  pending=pick(env,file(env.w),'open-local-media');await chooser(env);env.$('new-local-media-project').click();await pending;
  const fresh=env.w.associationTest.active();assert.equal(env.w.document.activeElement,env.$('title'));assert.notEqual(fresh.key,doc.key);assert.equal(fresh.project_kind,'audio_only');assert.equal(fresh.segments.length,0);assert.equal(fresh.project_note,'');assert.equal(env.w.associationTest.docs().length,2);assert.equal(evidence(doc),before);assert.deepEqual(clone(doc.local_media_source),source);
 }finally{await close(env);}
});

test('unsampled-byte v1 collision always prompts for its transcript candidate and visibly preserves calibration until explicit reset',async()=>{
 const env=setup();try{
  const bytes=new Uint8Array(512*1024);bytes.set(new TextEncoder().encode('RIFF authored collision'));const different=bytes.slice();different[96*1024]=1;
  const original=file(env.w,'Collision.wav',bytes),collision=file(env.w,'Collision.wav',different);
  assert.notDeepEqual(new Uint8Array(await original.arrayBuffer()),new Uint8Array(await collision.arrayBuffer()));
  assert.equal(await env.w.associationTest.fingerprint(original),await env.w.associationTest.fingerprint(collision),'v1 does not pretend to identify unsampled bytes');
  const doc=await bound(env,original),p=player(env);await calibrate(env,2.5);const listeningKey=await listen(env,p),record=env.w.localStorage.getItem(listeningKey),timing=clone(doc.media_timing),before=evidence(doc);
  env.$('add-content').click();const pending=pick(env,collision,'open-local-media');const dialog=await chooser(env);
  assert.match(dialog.textContent,/候选|部分内容/);assert.match(candidate(env,doc.key).textContent,/2\.5/);assert.equal(env.created.length,1);assert.deepEqual(clone(doc.media_timing),timing);assert.equal(env.w.localStorage.getItem(listeningKey),record);
  candidate(env,doc.key).click();await pending;assert.equal(env.w.associationTest.active(),doc);assert.equal(evidence(doc),before);assert.deepEqual(clone(doc.media_timing),timing);assert.equal(env.$('episode-media').hidden,false);assert.equal(env.$('media-timing').hidden,false);assert.equal(env.$('media-timing-offset').value,'2.5');assert.equal(env.w.localStorage.getItem(listeningKey),record);
  const reopened=player(env);assert.equal(reopened.paused,true);env.$('media-timing-reset').click();assert.equal(doc.media_timing.offset,2.5);await env.$('media-timing-save').onclick();assert.equal(doc.media_timing.offset,0);assert.equal(env.calls.length,0);
 }finally{await close(env);}
});

for(const existingKind of ['audio-only','transcript'])test(`first binding with a matching ${existingKind} offers separate current and existing projects`,async()=>{
 const env=setup();try{
  if(existingKind==='audio-only')await pick(env,file(env.w),'open-local-media');else await bound(env);
  const existing=env.w.associationTest.active(),existingBefore=evidence(existing);
  const current=await importJSON(env,transcript({title:'Second authored transcript',notes:{a:'Separate note'}})),before=evidence(current);
  const pending=pick(env,file(env.w));await chooser(env);assert.equal(env.$('local-media-current-project').hidden,false);candidate(env,existing.key);assert.equal(current.local_media_source,undefined);assert.equal(env.created.length,1);
  env.$('local-media-current-project').click();await pending;assert.equal(env.w.associationTest.active(),current);assert.equal(evidence(current),before);assert.equal(evidence(existing),existingBefore);assert.equal(env.w.associationTest.docs().length,2);assert.equal(current.local_media_source.fingerprint,existing.local_media_source.fingerprint);assert.notEqual(current.key,existing.key);
 }finally{await close(env);}
});

test('first-bind candidate selection opens exactly the existing project and leaves the current transcript unbound',async()=>{
 const env=setup();try{
  await pick(env,file(env.w),'open-local-media');const existing=env.w.associationTest.active();const current=await importJSON(env,transcript()),before=evidence(current);
  const pending=pick(env,file(env.w));await chooser(env);candidate(env,existing.key).click();await pending;
  assert.equal(env.w.associationTest.active(),existing);assert.equal(current.local_media_source,undefined);assert.equal(evidence(current),before);assert.equal(env.w.associationTest.docs().length,2);assert.equal(env.w.associationTest.media().has(current.key),false);
 }finally{await close(env);}
});

for(const kind of ['podcast_source','source_media','local_job_binding'])test(`existing ${kind} keeps transient media attachment without a durable local association`,async()=>{
 const env=setup();try{
  const extra=kind==='podcast_source'?{podcast_source:{kind:'direct_media',media_url:'https://example.org/episode.mp3',media_kind:'audio'}}:kind==='source_media'?{source_media:{job_id:'b'.repeat(32),kind:'audio'}}:{};
  const doc=await importJSON(env,transcript(extra));if(kind==='local_job_binding'){doc.local_job_binding={id:'b'.repeat(32),fingerprint:'c'.repeat(64)};env.w.associationTest.render();}
  const source=JSON.stringify(doc[kind]);await pick(env,file(env.w));assert.ok(env.$('source-media').querySelector('audio'));assert.equal(doc.local_media_source,undefined);assert.equal(JSON.stringify(doc[kind]),source);assert.equal(env.$('replace-reader-media').hidden,true);assert.equal(env.$('unlink-reader-media').hidden,true);assert.equal(env.calls.length,0);
 }finally{await close(env);}
});

test('detach releases only this page attachment and leaves association, calibration, duration, checkpoint and annotations intact',async()=>{
 const env=setup();try{
  const doc=await bound(env),p=player(env);await calibrate(env);const listeningKey=await listen(env,p),before=JSON.stringify(doc),record=env.w.localStorage.getItem(listeningKey),stored=env.w.localStorage.getItem(KEY);
  env.$('detach-reader-media').click();assert.equal(JSON.stringify(doc),before);assert.equal(env.w.localStorage.getItem(KEY),stored);assert.equal(env.w.localStorage.getItem(listeningKey),record);assert.equal(env.w.associationTest.media().has(doc.key),false);assert.equal(env.$('source-media').querySelector('audio'),null);assert.deepEqual(env.revoked,['blob:association-1']);assert.equal(env.$('unlink-reader-media').hidden,false);
  await pick(env,file(env.w));assert.equal(env.$('media-timing-offset').value,'2');assert.equal(doc.media_duration,120);assert.equal(evidence(env.w.associationTest.active()),evidence(doc));
 }finally{await close(env);}
});

test('replace picker cancel and confirmation cancel preserve the old source and every resettable state',async()=>{
 const env=setup();try{
  const doc=await bound(env),p=player(env);await calibrate(env);const listeningKey=await listen(env,p),before=JSON.stringify(doc),record=env.w.localStorage.getItem(listeningKey),attachment=env.w.associationTest.media().get(doc.key);
  env.$('replace-reader-media').click();env.$('reader-media-file').dispatchEvent(new env.w.Event('cancel'));assert.equal(JSON.stringify(doc),before);
  const pending=pick(env,file(env.w,'Replacement.wav','RIFF replacement'),'replace-reader-media');const dialog=await chooser(env);assert.match(dialog.textContent,/校准|对齐/);assert.match(dialog.textContent,/进度|回听位置|收听续点/);assert.equal(JSON.stringify(doc),before);assert.equal(env.w.localStorage.getItem(listeningKey),record);assert.equal(env.created.length,1);
  env.$('cancel-local-media-project').click();await pending;assert.equal(JSON.stringify(doc),before);assert.equal(env.w.associationTest.media().get(doc.key),attachment);assert.equal(env.w.localStorage.getItem(listeningKey),record);assert.equal(env.revoked.length,0);
 }finally{await close(env);}
});

test('confirmed replacement saves only on receipt, resets old timing/duration/checkpoint, and preserves all authored history through failed save and retry',async()=>{
 const env=setup();let fresh;try{
  const doc=await bound(env),p=player(env);await calibrate(env);const listeningKey=await listen(env,p);
  doc.exact_excerpts=[env.w.Coconut.exactExcerptSnapshot(doc,doc.segments.slice(0,1),[],0,6,{id:'original-bound-excerpt',createdAt:'2026-10-11T01:00:00.000Z'})];await env.w.associationTest.commit(doc);
  const before=evidence(doc),originalSource=clone(doc.local_media_source),saved=env.w.localStorage.getItem(KEY);
  env.pipeline.hold();const pending=pick(env,file(env.w,'Replacement.mp4','ftyp authored replacement'),'replace-reader-media');await chooser(env);env.$('local-media-current-project').click();await until(()=>env.pipeline.writes.length===1);
  assert.equal(evidence(doc),before);assert.equal(doc.local_media_source.name,'Replacement.mp4');assert.notEqual(doc.local_media_source.fingerprint,originalSource.fingerprint);assert.deepEqual(clone(doc.exact_excerpts[0].snapshot.source.local_media_source),originalSource);assert.equal(doc.media_timing,undefined);assert.equal(doc.media_duration,undefined);assert.equal(env.w.localStorage.getItem(listeningKey),null);assert.ok(env.$('source-media').querySelector('video'));assert.equal(env.w.localStorage.getItem(KEY),saved);assert.equal(env.$('save-status').dataset.state,'pending');assert.deepEqual(env.revoked,['blob:association-1']);
  env.pipeline.writes[0].fail();await pending;assert.equal(env.$('save-status').dataset.state,'failed');assert.match(env.$('notice').textContent,/尚未保存|未能保存|保存失败/);assert.equal(evidence(doc),before);assert.ok(env.$('source-media').querySelector('video'));assert.equal(C.exactExcerptFreshness(clone(doc.exact_excerpts[0]),clone(doc)),'stale');
  env.pipeline.hold(false);await env.$('retry-save').onclick();assert.equal(env.$('save-status').dataset.state,'saved');fresh=setup(snapshot(env.w));assert.equal(evidence(fresh.w.associationTest.active()),before);assert.equal(fresh.w.associationTest.active().local_media_source.name,'Replacement.mp4');assert.equal(fresh.w.associationTest.active().media_timing,undefined);assert.equal(fresh.w.associationTest.active().media_duration,undefined);assert.equal(fresh.w.localStorage.getItem(listeningKey),null);assert.equal(env.calls.length,0);
 }finally{await close(env);await close(fresh);}
});

test('unlink requires its own confirmation and saves removal while retaining the readable transcript, annotations and exact capture-time source',async()=>{
 const env=setup();let fresh;try{
  const doc=await bound(env),p=player(env);await calibrate(env);const listeningKey=await listen(env,p);
  doc.exact_excerpts=[env.w.Coconut.exactExcerptSnapshot(doc,doc.segments.slice(0,1),[],0,6,{id:'bound-excerpt',createdAt:'2026-10-11T01:00:00.000Z'})];await env.w.associationTest.commit(doc);
  const before=evidence(doc),source=clone(doc.local_media_source),saved=env.w.localStorage.getItem(KEY);
  let pending=env.$('unlink-reader-media').onclick();await chooser(env);env.$('cancel-local-media-project').click();await pending;assert.deepEqual(clone(doc.local_media_source),source);assert.equal(env.revoked.length,0);
  env.pipeline.hold();pending=env.$('unlink-reader-media').onclick();const dialog=await chooser(env);assert.match(dialog.textContent,/校准|对齐/);assert.match(dialog.textContent,/进度|回听位置|收听续点/);env.$('local-media-current-project').click();await until(()=>env.pipeline.writes.length===1);
  assert.equal(env.w.document.activeElement,env.$('attach-reader-media'));assert.equal(doc.local_media_source,undefined);assert.equal(doc.media_timing,undefined);assert.equal(doc.media_duration,undefined);assert.equal(evidence(doc),before);assert.equal(env.w.localStorage.getItem(listeningKey),null);assert.equal(env.$('source-media').querySelector('audio,video'),null);assert.equal(env.w.localStorage.getItem(KEY),saved);assert.equal(env.$('save-status').dataset.state,'pending');assert.equal(doc.exact_excerpts[0].snapshot.source.local_media_source.name,'Original.wav');assert.equal(C.exactExcerptFreshness(clone(doc.exact_excerpts[0]),clone(doc)),'stale');
  env.pipeline.writes[0].fail();await pending;assert.match(env.$('notice').textContent,/尚未保存|未能保存|保存失败/);assert.equal(evidence(doc),before);assert.equal(env.$('title').textContent,doc.title);
  env.pipeline.hold(false);await env.$('retry-save').onclick();fresh=setup(snapshot(env.w));assert.equal(evidence(fresh.w.associationTest.active()),before);assert.equal(fresh.w.associationTest.active().local_media_source,undefined);assert.equal(fresh.$('replace-reader-media').hidden,true);assert.equal(fresh.$('unlink-reader-media').hidden,true);assert.equal(env.calls.length,0);
 }finally{await close(env);await close(fresh);}
});

test('first association remains readable/playable while pending and after failure; retry persists exactly that source',async()=>{
 const env=setup();try{
  const doc=await importJSON(env,transcript()),before=evidence(doc);await env.w.associationTest.flush();env.pipeline.hold();const pending=pick(env,file(env.w));await until(()=>env.pipeline.writes.length===1);
  assert.equal(evidence(doc),before);assert.ok(env.$('source-media').querySelector('audio'));assert.equal(env.$('save-status').dataset.state,'pending');assert.equal(JSON.parse(env.w.localStorage.getItem(KEY)).documents[0].local_media_source,undefined);assert.doesNotMatch(env.$('notice').textContent,/关联已保存/);
  env.pipeline.writes[0].fail();await pending;assert.equal(env.$('save-status').dataset.state,'failed');assert.match(env.$('notice').textContent,/尚未保存|未能保存|保存失败/);assert.ok(env.$('source-media').querySelector('audio'));assert.equal(evidence(doc),before);
  env.pipeline.hold(false);await env.$('retry-save').onclick();assert.equal(env.$('save-status').dataset.state,'saved');assert.deepEqual(JSON.parse(env.w.localStorage.getItem(KEY)).documents[0].local_media_source,clone(doc.local_media_source));
 }finally{await close(env);}
});

for(const change of ['navigation','same-document-reselection','replacement-document','new-source','later-file-selection','removal-undo'])test(`delayed transcript fingerprint is retired by ${change} without stale source, URL, or notice`,async()=>{
 const env=setup();try{
  const doc=await importJSON(env,transcript()),slow=delayedFile(env),before=evidence(doc);const pending=pick(env,slow.selected);await until(()=>slow.reading);
  if(change==='navigation')env.$('add-content').click();
  else if(change==='same-document-reselection')selectLibrary(env,doc.key);
  else if(change==='replacement-document')env.w.associationTest.replaceDocument();
  else if(change==='new-source'){doc.source_media={job_id:'d'.repeat(32),kind:'audio'};env.w.associationTest.render();}
  else if(change==='later-file-selection')await pick(env,file(env.w,'Newer.wav','RIFF newer selection'));
  else {env.w.document.querySelector('.library-remove').click();await env.$('confirm-removal').onclick();await env.$('undo-removal').onclick();}
  const active=env.w.associationTest.active(),created=env.created.length;env.$('notice').textContent='Keep newer guidance';slow.release();await pending;
  assert.equal(env.w.associationTest.active(),active);assert.equal(env.created.length,created);assert.equal(env.$('notice').textContent,'Keep newer guidance');assert.equal(evidence(active),before);
  if(change==='later-file-selection')assert.equal(active.local_media_source.name,'Newer.wav');else assert.equal(active.local_media_source,undefined);
  assert.equal(env.calls.length,0);
 }finally{await close(env);}
});

for(const change of ['navigation','same-document-reselection','later-file-selection'])test(`late first-binding save receipt cannot overwrite ${change} feedback or reopen its media`,async()=>{
 const env=setup();try{
  const doc=await importJSON(env,transcript());env.pipeline.hold();const pending=pick(env,file(env.w));await until(()=>env.pipeline.writes.length===1);
  if(change==='navigation')env.$('add-content').click();else if(change==='same-document-reselection')selectLibrary(env,doc.key);else await pick(env,file(env.w));
  const active=env.w.associationTest.active(),created=env.created.length,attachment=env.w.associationTest.media().get(doc.key);env.$('notice').textContent='Newer interaction owns this notice';const focus=env.$(change==='navigation'?'open-local-media':'ai-question');focus.focus();env.pipeline.writes[0].commit();await pending;assert.equal(env.w.document.activeElement,focus);
  assert.equal(env.w.associationTest.active(),active);assert.equal(env.created.length,created);assert.equal(env.w.associationTest.media().get(doc.key),attachment);assert.equal(env.$('notice').textContent,'Newer interaction owns this notice');assert.equal(JSON.parse(env.w.localStorage.getItem(KEY)).documents[0].local_media_source.name,'Original.wav');if(change==='navigation')assert.equal(env.$('add-workspace').hidden,false);
 }finally{await close(env);}
});

test('navigation and remove/Undo retire a pending replace or unlink chooser before it can mutate the transcript',async()=>{
 for(const action of ['replace-reader-media','unlink-reader-media'])for(const navigation of ['leave','remove-undo']){
  const env=setup();try{
   const doc=await bound(env),before=JSON.stringify(doc);const pending=action==='replace-reader-media'?pick(env,file(env.w,'Replacement.wav'),'replace-reader-media'):env.$('unlink-reader-media').onclick();await chooser(env);
   if(navigation==='leave')env.$('add-content').click();else {env.w.document.querySelector('.library-remove').click();await env.$('confirm-removal').onclick();await env.$('undo-removal').onclick();}
   await pending;assert.equal(env.$('local-media-project-dialog').open,false);assert.equal(JSON.stringify(env.w.associationTest.active()),before);assert.equal(env.created.length,1);assert.equal(env.calls.length,0);
  }finally{await close(env);}
 }
});

for(const origin of ['home','first-bind'])test(`${origin} chooser cannot attach an old candidate after that candidate source changes`,async()=>{
 const env=setup();try{
  const existing=await bound(env),before=evidence(existing);let current=existing;
  if(origin==='home')env.$('add-content').click();else current=await importJSON(env,transcript({title:'Independent current transcript'}));
  const pending=pick(env,file(env.w),origin==='home'?'open-local-media':'attach-reader-media');await chooser(env);
  const offered=candidate(env,existing.key),attachment=env.w.associationTest.media().get(existing.key);
  existing.local_media_source={...existing.local_media_source,name:'Newly associated.wav',fingerprint:'d'.repeat(64)};
  offered.click();await pending;
  assert.equal(env.created.length,1,'the stale chooser must not allocate/attach the former candidate file');assert.equal(env.w.associationTest.media().get(existing.key),attachment);assert.equal(evidence(existing),before);assert.equal(existing.local_media_source.name,'Newly associated.wav');
  if(origin==='first-bind'){assert.equal(env.w.associationTest.active(),current);assert.equal(current.local_media_source,undefined);}else assert.equal(env.$('add-workspace').hidden,false);
 }finally{await close(env);}
});

for(const action of ['replace-reader-media','unlink-reader-media'])test(`late ${action} save failure leaves newer navigation feedback untouched`,async()=>{
 const env=setup();try{
  const doc=await bound(env),before=evidence(doc);env.pipeline.hold();
  const pending=action==='replace-reader-media'?pick(env,file(env.w,'Replacement.wav'),'replace-reader-media'):env.$('unlink-reader-media').onclick();await chooser(env);env.$('local-media-current-project').click();await until(()=>env.pipeline.writes.length===1);
  env.$('add-content').click();env.$('notice').textContent='Newer navigation feedback';env.$('open-local-media').focus();env.pipeline.writes[0].fail();await pending;assert.equal(env.w.document.activeElement,env.$('open-local-media'));
  assert.equal(evidence(doc),before);assert.equal(env.$('notice').textContent,'Newer navigation feedback');assert.equal(env.$('add-workspace').hidden,false);assert.equal(env.$('save-status').dataset.state,'failed');
  if(action==='replace-reader-media')assert.equal(doc.local_media_source.name,'Replacement.wav');else assert.equal(doc.local_media_source,undefined);
 }finally{await close(env);}
});

test('multiple transcript candidates retain independent keys, notes, calibration and exact-history evidence',async()=>{
 const env=setup();try{
  const first=await bound(env);player(env);await calibrate(env,2);const firstBefore=evidence(first),copy=clone(first);copy.title='Independent saved version';copy.notes.a='Different version note';copy.media_timing.offset=4;
  const second=await importJSON(env,copy),secondBefore=evidence(second);assert.notEqual(first.key,second.key);env.$('add-content').click();
  const pending=pick(env,file(env.w),'open-local-media');await chooser(env);assert.equal(env.$('local-media-project-options').children.length,2);assert.match(candidate(env,first.key).textContent,/2 秒/);assert.match(candidate(env,second.key).textContent,/4 秒/);
  candidate(env,second.key).click();await pending;assert.equal(env.w.associationTest.active(),second);assert.equal(env.$('media-timing-offset').value,'4');assert.equal(evidence(first),firstBefore);assert.equal(evidence(second),secondBefore);assert.equal(first.media_timing.offset,2);assert.equal(second.media_timing.offset,4);assert.equal(env.w.associationTest.docs().length,2);
 }finally{await close(env);}
});

function unloadProtected(env){const event=new env.w.Event('beforeunload',{cancelable:true});env.w.dispatchEvent(event);return event.defaultPrevented;}

test('a pending or failed first binding protects beforeunload until a successful receipt clears only the committed change',async()=>{
 const env=setup();try{
  const doc=await importJSON(env,transcript()),before=evidence(doc);assert.equal(unloadProtected(env),false);env.pipeline.hold();
  const pending=pick(env,file(env.w));await until(()=>env.pipeline.writes.length===1);assert.equal(unloadProtected(env),true);assert.equal(env.$('save-status').dataset.state,'pending');assert.equal(evidence(doc),before);
  env.pipeline.writes[0].fail();await pending;assert.equal(unloadProtected(env),true);assert.equal(env.$('save-status').dataset.state,'failed');assert.ok(env.$('source-media').querySelector('audio'));
  env.pipeline.hold(false);await env.$('retry-save').onclick();assert.equal(env.$('save-status').dataset.state,'saved');assert.equal(unloadProtected(env),false);assert.equal(evidence(doc),before);assert.deepEqual(JSON.parse(env.w.localStorage.getItem(KEY)).documents[0].local_media_source,clone(doc.local_media_source));
 }finally{await close(env);}
});

test('association CAS conflict leaves the external saved source untouched and the complete in-page replacement exportable for rescue',async()=>{
 const env=setup();try{
  const doc=await bound(env),before=evidence(doc),oldSource=clone(doc.local_media_source);env.pipeline.hold();
  const pending=pick(env,file(env.w,'Replacement.wav','RIFF replacement'),'replace-reader-media');await chooser(env);env.$('local-media-current-project').click();await until(()=>env.pipeline.writes.length===1);
  const external=JSON.parse(env.w.localStorage.getItem(KEY));external.documents[0].notes.a='A newer note saved by another window';const externalBytes=JSON.stringify(external);env.w.localStorage.setItem(KEY,externalBytes);
  env.pipeline.writes[0].commit();await pending;assert.equal(env.$('save-status').dataset.state,'failed');assert.match(env.$('save-status').textContent,/另一个页面/);assert.equal(unloadProtected(env),true);
  assert.equal(env.w.localStorage.getItem(KEY),externalBytes);assert.deepEqual(JSON.parse(env.w.localStorage.getItem(KEY)).documents[0].local_media_source,oldSource);assert.equal(evidence(doc),before);assert.equal(doc.local_media_source.name,'Replacement.wav');assert.ok(env.$('source-media').querySelector('audio'));assert.equal(env.$('export-unsaved-documents').hidden,false);
  env.w.HTMLAnchorElement.prototype.click=function(){};env.$('export').onclick();const rescue=JSON.parse(await env.created.at(-1).file.text());
  assert.equal(evidence(rescue),before);assert.deepEqual(rescue.local_media_source,clone(doc.local_media_source));assert.doesNotMatch(JSON.stringify(rescue),/blob:|RIFF replacement/);assert.equal(env.$('save-status').dataset.state,'failed');assert.equal(unloadProtected(env),true);assert.equal(env.w.localStorage.getItem(KEY),externalBytes);assert.equal(env.calls.length,0);
 }finally{await close(env);}
});

for(const origin of ['reader','home'])test(`${origin} native picker result arriving after navigation is inert before onchange starts`,async()=>{
 const env=setup();try{
  const first=await importJSON(env,transcript()),firstBefore=evidence(first);
  if(origin==='home')env.$('add-content').click();
  env.$(origin==='home'?'open-local-media':'attach-reader-media').click();
  const staleInput=env.$(origin==='home'?'local-media-file':'reader-media-file');
  // The browser picker has opened, but it has not delivered any file/change event.
  const newer=await importJSON(env,transcript({title:'Newer selected transcript',notes:{a:'Newer transcript note'}})),newerBefore=evidence(newer);
  env.$('notice').textContent='Newer transcript owns this feedback';env.$('ai-question').focus();
  Object.defineProperty(staleInput,'files',{configurable:true,value:[file(env.w)]});await staleInput.onchange();
  assert.equal(env.w.associationTest.active(),newer);assert.equal(env.w.document.body.dataset.workspace,'read');assert.equal(env.$('notice').textContent,'Newer transcript owns this feedback');assert.equal(env.w.document.activeElement,env.$('ai-question'));
  assert.equal(env.created.length,0);assert.equal(env.w.associationTest.media().size,0);assert.equal(first.local_media_source,undefined);assert.equal(newer.local_media_source,undefined);assert.equal(evidence(first),firstBefore);assert.equal(evidence(newer),newerBefore);assert.equal(env.w.associationTest.docs().length,2);assert.equal(staleInput.value,'');assert.equal(env.calls.length,0);
 }finally{await close(env);}
});

async function downloadJSON(env,id){
 env.w.HTMLAnchorElement.prototype.click=function(){};const count=env.created.length;env.$(id).onclick();assert.equal(env.created.length,count+1,'production export creates one JSON artifact');return JSON.parse(await env.created.at(-1).file.text());
}
async function restoreLibraryJSON(env,backup){
 const text=JSON.stringify(backup);Object.defineProperty(env.$('library-file'),'files',{configurable:true,value:[{name:'authored-library.json',size:text.length,text:async()=>text,arrayBuffer:async()=>new TextEncoder().encode(text).buffer}]});await env.$('library-file').onchange();return env.w.associationTest.active();
}
function contentEvidence(doc){const value=JSON.parse(evidence(doc));delete value.key;return JSON.stringify(value);}
const rawSourceFixtures=[
 ['custom-port URL','https://media.example:8443/episode?Case=X#part'],
 ['host without trailing slash','https://example.org'],
 ['opaque legacy attribution','Legacy source: shelf / tape #7?Case=X'],
 ['javascript attribution','javascript:alert("authored fixture")'],
 ['data attribution','data:text/plain,authored-source'],
 ['blob attribution','blob:https://example.org/authored-source'],
 ['file attribution','file:///authored/source.wav']
];
for(const [label,sourceURL] of rawSourceFixtures)test(`raw ${label} survives association, real save/reload, both JSON restore routes and saved unlink exactly`,async()=>{
 const env=setup();let reloaded,single,library,unlinked;try{
  const original=transcript({source_url:sourceURL});assert.equal(original.source_url,sourceURL);
  const doc=await importJSON(env,original),key=doc.key,before=contentEvidence(doc),snapshots=JSON.stringify(doc.exact_excerpts);
  assert.equal(doc.source_url,sourceURL);assert.equal(JSON.parse(env.w.localStorage.getItem(KEY)).documents[0].source_url,sourceURL);
  await pick(env,file(env.w));assert.equal(doc.source_url,sourceURL);assert.equal(doc.key,key);assert.equal(contentEvidence(doc),before);assert.equal(JSON.stringify(doc.exact_excerpts),snapshots);assert.equal(env.$('save-status').dataset.state,'saved');
  const saved=JSON.parse(env.w.localStorage.getItem(KEY)).documents[0];assert.equal(saved.source_url,sourceURL);assert.ok(saved.local_media_source);assert.equal(contentEvidence(saved),before);assert.equal(JSON.stringify(saved.exact_excerpts),snapshots);
  reloaded=setup(snapshot(env.w));const loaded=reloaded.w.associationTest.active();assert.equal(loaded.key,key);assert.equal(loaded.source_url,sourceURL);assert.equal(contentEvidence(loaded),before);assert.equal(JSON.stringify(loaded.exact_excerpts),snapshots);assert.equal(reloaded.$('source-media').querySelector('audio,video'),null);
  const exported=await downloadJSON(reloaded,'export');assert.equal(exported.source_url,sourceURL);assert.equal(JSON.stringify(exported.exact_excerpts),snapshots);
  single=setup();const imported=await importJSON(single,exported);assert.equal(imported.source_url,sourceURL);assert.equal(contentEvidence(imported),before);assert.equal(JSON.stringify(imported.exact_excerpts),snapshots);assert.equal(JSON.parse(single.w.localStorage.getItem(KEY)).documents[0].source_url,sourceURL);assert.deepEqual(clone(imported.local_media_source),clone(doc.local_media_source));
  const backup=await downloadJSON(reloaded,'export-library');assert.equal(backup.format,'coconut-library');assert.equal(backup.documents[0].source_url,sourceURL);
  library=setup();const restored=await restoreLibraryJSON(library,backup);assert.equal(restored.source_url,sourceURL);assert.equal(restored.key,key);assert.equal(contentEvidence(restored),before);assert.equal(JSON.stringify(restored.exact_excerpts),snapshots);assert.equal(JSON.parse(library.w.localStorage.getItem(KEY)).documents[0].source_url,sourceURL);assert.deepEqual(clone(restored.local_media_source),clone(doc.local_media_source));
  const pending=reloaded.$('unlink-reader-media').onclick();await chooser(reloaded);reloaded.$('local-media-current-project').click();await pending;assert.equal(reloaded.$('save-status').dataset.state,'saved');assert.equal(loaded.local_media_source,undefined);assert.equal(loaded.source_url,sourceURL);assert.equal(contentEvidence(loaded),before);assert.equal(JSON.stringify(loaded.exact_excerpts),snapshots);
  const unlinkSaved=JSON.parse(reloaded.w.localStorage.getItem(KEY)).documents[0];assert.equal(unlinkSaved.source_url,sourceURL);assert.equal(unlinkSaved.local_media_source,undefined);assert.equal(JSON.stringify(unlinkSaved.exact_excerpts),snapshots);
  unlinked=setup(snapshot(reloaded.w));assert.equal(unlinked.w.associationTest.active().source_url,sourceURL);assert.equal(contentEvidence(unlinked.w.associationTest.active()),before);assert.equal(unlinked.w.associationTest.active().local_media_source,undefined);
  for(const view of [env,reloaded,single,library,unlinked])assert.equal(view.calls.length,0,'source metadata never triggers network access');
 }finally{await close(env);await close(reloaded);await close(single);await close(library);await close(unlinked);}
});

test('raw transcript attribution does not relax timed source links, audio-only source sanitization, or podcast URL validation',()=>{
 const unsafe=rawSourceFixtures.slice(2).map(([,value])=>value);
 for(const value of unsafe){assert.equal(C.source(value,12),'',value+' is never an executable source link');assert.equal(C.podcastURL(value),'');}
 assert.equal(C.source('https://www.youtube.com/watch?v=authored1234&Case=X&t=9#part',12.9),'https://www.youtube.com/watch?v=authored1234&Case=X&t=12');
 assert.equal(C.source('https://youtu.be/authored1234?t=9#part',12.9),'https://youtu.be/authored1234?t=12');
 assert.equal(C.source('https://youtube.com.evil.example/watch?v=authored1234',12),'');
 const audio=source_url=>C.validate({project_kind:'audio_only',title:'Authored audio-only project',segments:[],local_media_source:localSource,source_url});
 assert.equal(audio('https://example.org').source_url,'https://example.org/');assert.equal(audio('https://media.example:8443/episode?Case=X#part').source_url,'');
 for(const value of unsafe)assert.equal(audio(value).source_url,'');
 assert.equal(C.podcastURL('https://example.org'),'https://example.org/');assert.equal(C.podcastURL('https://media.example:8443/episode?Case=X#part'),'');
 assert.equal(C.podcastURL('https://user:password@example.org/episode'),'');
 assert.deepEqual(C.podcastSource({kind:'direct_media',media_url:'https://example.org',media_kind:'audio'}),{kind:'direct_media',media_url:'https://example.org/',media_kind:'audio'});
 assert.equal(C.podcastSource({kind:'direct_media',media_url:'https://media.example:8443/episode',media_kind:'audio'}),undefined);
 for(const value of unsafe)assert.equal(C.podcastSource({kind:'direct_media',media_url:value,media_kind:'audio'}),undefined);
});
