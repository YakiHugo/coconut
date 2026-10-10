import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';
import {Window} from 'happy-dom';
import {installSavePipeline,settle} from './helpers/save-pipeline.mjs';
const require=createRequire(import.meta.url),Coconut=require('../reader/core.js');
const root=new URL('../',import.meta.url);
const localSource={version:1,kind:'audio',name:'Original.wav',size:64,last_modified:7,type:'audio/wav',fingerprint:'a'.repeat(64)};
const project=(overrides={})=>({project_kind:'audio_only',title:'Local authored recording',local_media_source:localSource,segments:[],...overrides});
function setup(storage={},options={}){
 const w=new Window({url:'https://coconut.example/'}),calls=[],created=[],revoked=[];
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});for(const [key,value] of Object.entries(storage))w.localStorage.setItem(key,value);
 w.fetch=async url=>{calls.push(url);throw new Error('No network permitted');};
 w.URL.createObjectURL=file=>{const url='blob:local-'+(created.length+1);created.push({url,file});return url;};w.URL.revokeObjectURL=url=>revoked.push(url);
 const pipeline=installSavePipeline(w,options);
 w.eval(['summary','core','passages','passage-playback','app'].map(n=>fs.readFileSync(new URL('reader/'+n+'.js',root),'utf8')).join('\n')+'\nwindow.localTest={active:()=>active(),docs:()=>state.documents,media:()=>browserMedia,resetListen:()=>{listeningSession.engaged=false;renderListeningResume();},flush:()=>libraryStore.flush(),cue:()=>playbackSegment(),repeat:cue=>toggleRepeat(cue),preview:()=>passagePlayback.getState(),render:()=>render()};');
 const $=id=>w.document.getElementById(id);
 return {w,$,calls,created,revoked,pipeline};
}
const snapshot=w=>Object.fromEntries(Array.from({length:w.localStorage.length},(_,i)=>{const key=w.localStorage.key(i);return [key,w.localStorage.getItem(key)];}));
function file(w,name='Original.wav',bytes='RIFF authored local audio',extra={}){return new w.File([bytes],name,{type:name.endsWith('.mp4')?'video/mp4':'audio/wav',lastModified:7,...extra});}
async function pick(env,selected,{add=true,click=true}={}){
 const {$}=env,id=add?'local-media-file':'reader-media-file';
 if(click)$(add?'open-local-media':'attach-reader-media').click();
 Object.defineProperty($(id),'files',{configurable:true,value:[selected]});return $(id).onchange();
}
async function importJSON(env,doc){const text=JSON.stringify(doc);Object.defineProperty(env.$('file'),'files',{configurable:true,value:[{name:'backup.json',size:text.length,text:async()=>text}]});await env.$('file').onchange();}
async function addNote(env,text){env.$('project-note').value=text;env.$('project-note').dispatchEvent(new env.w.Event('input',{bubbles:true}));await env.w.localTest.flush();}
async function bookmark(env,time='12',note='Authored bookmark'){
 env.$('audio-bookmark-time').value=time;env.$('audio-bookmark-note').value=note;await env.$('audio-bookmark-form').onsubmit({preventDefault(){}});await env.w.localTest.flush();
}
async function until(predicate){for(let n=0;n<100&&!predicate();n++){await settle();await new Promise(r=>setTimeout(r,1));}assert.ok(predicate(),'condition settled');}
function player(env,duration=120){const p=env.$('source-media').querySelector('audio,video');let paused=true;
 Object.defineProperties(p,{duration:{configurable:true,value:duration},paused:{configurable:true,get:()=>paused}});
 p.play=async()=>{paused=false;p.dispatchEvent(new env.w.Event('play'));};p.pause=()=>{paused=true;p.dispatchEvent(new env.w.Event('pause'));};p.dispatchEvent(new env.w.Event('loadedmetadata'));return p;
}

const captions={title:'Calibration fixture',source_url:'https://www.youtube.com/watch?v=authored1234',segments:[{id:'a',start:10,end:12,text:'First authored cue'},{id:'b',start:20,end:24,text:'Second authored cue'}]};
async function open(env){await importJSON(env,captions);await pick(env,file(env.w),{add:false});return player(env);}
function draft(env,value){env.$('media-timing-offset').value=String(value);env.$('media-timing-offset').dispatchEvent(new env.w.Event('input'));}

test('bounded schema and source exports preserve canonical timestamps',()=>{
 const identity='file-candidate-v1:authored';
 const doc=Coconut.validate({...captions,media_timing:{version:1,identity,offset:2.1234}});
 assert.equal(doc.media_timing.offset,2.123);assert.equal(Coconut.mediaTimingOffset(doc,identity),2.123);assert.equal(Coconut.mediaTimingOffset(doc,'other'),0);
 for(const offset of [Infinity,NaN,'2',3600.01])assert.equal(Coconut.mediaTiming({version:1,identity,offset}),null);
 assert.equal(Coconut.mediaTimingRange({start:10,end:12},-11,120),null);assert.equal(Coconut.mediaTimingRange({start:10,end:12},110,120),null);
 assert.deepEqual(Coconut.mediaTimingRange({start:10,end:12},-10,120),{start:0,end:2});
 assert.equal(Coconut.subtitleExport(doc,'srt',false).text,Coconut.subtitleExport(Coconut.validate(captions),'srt',false).text);
 assert.equal(doc.segments[0].start,10);assert.match(Coconut.source(doc.source_url,10),/10/);
});

test('draft alignment, bounded preview and return preserve physical listening while save maps seeks, inverse highlight and loops',async()=>{
 const env=setup();try{const {w,$}=env,p=await open(env),doc=w.localTest.active();assert.equal($('media-timing').hidden,false);
 p.currentTime=12;$('media-timing-align').click();assert.equal($('media-timing-offset').value,'2');assert.match($('media-timing-example').textContent,/00:10 → 媒体 00:12/);assert.equal(doc.media_timing,undefined);
 p.currentTime=40;$('media-timing-preview').click();await settle();assert.equal(p.currentTime,12);assert.equal(w.localTest.cue().id,'a');assert.equal(w.localTest.preview().range.end,14);
 await $('media-timing-return').onclick();assert.equal(p.currentTime,40);assert.equal(p.paused,true);
 await $('media-timing-save').onclick();assert.match($('media-timing-status').textContent,/已保存/);assert.equal(doc.media_timing.offset,2);
 p.currentTime=11;assert.equal(w.localTest.cue(),undefined);p.currentTime=13;assert.equal(w.localTest.cue().id,'a');
 w.localTest.repeat(doc.segments[0]);assert.equal(p.currentTime,12);p.currentTime=14;p.dispatchEvent(new w.Event('timeupdate'));assert.equal(p.currentTime,12);$('stop-repeat').click();
 $('mode-transcript').click();const seek=$('transcript').querySelector('.segment .time button');seek.click();assert.equal(p.currentTime,12);
 p.currentTime=40;draft(env,-11);$('media-timing-preview').click();assert.equal(p.currentTime,40);assert.match($('media-timing-status').textContent,/无法试听/);
 draft(env,111);$('media-timing-preview').click();assert.equal(p.currentTime,40);
 $('media-timing-reset').click();assert.equal($('media-timing-offset').value,'0');assert.equal(doc.media_timing.offset,2);await $('media-timing-save').onclick();assert.equal(doc.media_timing.offset,0);
 }finally{await env.w.happyDOM.close();}
});

test('different file has zero mapping; same-file reselection and JSON reload restore calibration without autoplay',async()=>{
 const env=setup();let fresh;try{const {w,$}=env;await open(env);draft(env,2);await $('media-timing-save').onclick();const saved=snapshot(w);
 await pick(env,file(w,'Other.wav','RIFF other audio'),{add:false});player(env);assert.equal($('media-timing-offset').value,'0');assert.match($('media-timing-status').textContent,/不同/);
 await pick(env,file(w),{add:false});player(env);assert.equal($('media-timing-offset').value,'2');
 fresh=setup(saved);assert.equal(fresh.$('media-timing').hidden,true);await pick(fresh,file(fresh.w),{add:false});const p=player(fresh);assert.equal(fresh.$('media-timing-offset').value,'2');assert.equal(p.paused,true);assert.equal(p.currentTime,0);
 assert.equal(Coconut.validate(JSON.parse(JSON.stringify(w.localTest.active()))).media_timing.offset,2);
 }finally{await env.w.happyDOM.close();await fresh?.w.happyDOM.close();}
});

test('late and failed receipts never claim a newer timing draft was saved',async()=>{
 const env=setup();try{const {w,$,pipeline}=env;await open(env);await w.localTest.flush();pipeline.hold();draft(env,2);const save=$('media-timing-save').onclick();await until(()=>pipeline.writes.length===1);
 draft(env,3);pipeline.writes[0].commit();await save;assert.equal($('media-timing-offset').value,'3');assert.match($('media-timing-status').textContent,/尚未保存/);
 const failed=$('media-timing-save').onclick();await until(()=>pipeline.writes.length===2);pipeline.writes[1].fail();await failed;assert.match($('media-timing-status').textContent,/保存失败/);assert.equal(w.localTest.active().media_timing.offset,3);
 pipeline.hold(false);await $('media-timing-save').onclick();assert.match($('media-timing-status').textContent,/已保存/);
 }finally{await env.w.happyDOM.close();}
});

test('zero-origin preview return, calibrated passage bounds, and physical resume are independent',async()=>{
 const env=setup();try{const {w,$}=env,p=await open(env);draft(env,2);await $('media-timing-save').onclick();
 p.currentTime=0;$('media-timing-preview').click();await settle();await $('media-timing-return').onclick();assert.equal(p.currentTime,0);assert.equal(p.paused,true);
 $('mode-passages').click();let listen=$('passage-body').querySelector('.passage-listen');assert.equal(listen.disabled,false);listen.click();await settle();assert.equal(p.currentTime,12);assert.equal(w.localTest.preview().range.start,12);await $('passage-return-playback').onclick();assert.equal(p.currentTime,0);
 draft(env,-11);await $('media-timing-save').onclick();listen=$('passage-body').querySelector('.passage-listen');assert.equal(listen.disabled,true);p.currentTime=40;listen.onclick();assert.equal(p.currentTime,40);
 draft(env,111);await $('media-timing-save').onclick();assert.equal(listen.disabled,true);w.localTest.repeat(w.localTest.active().segments[0]);assert.equal(p.currentTime,40);assert.match($('repeat-status').textContent,/范围/);
 draft(env,2);await $('media-timing-save').onclick();await p.play();p.currentTime=42;p.pause();const key='coconut-listening-v1:'+w.localTest.active().key;assert.equal(JSON.parse(w.localStorage.getItem(key)).time,42);
 p.currentTime=3;w.localTest.resetListen();$('resume-listening').click();assert.equal(p.currentTime,42);assert.equal(p.paused,true);
 }finally{await env.w.happyDOM.close();}
});

test('cue seeks retain pre-metadata playback start while bounded previews and loops wait for duration',async()=>{
 const env=setup();try{const {w,$}=env,p=await open(env),doc=w.localTest.active();
 Object.defineProperty(p,'duration',{configurable:true,value:NaN});$('mode-transcript').click();
 $('transcript').querySelector('.segment .time button').click();assert.equal(p.currentTime,10,'uncalibrated cue seek works before metadata');
 await p.pause();draft(env,2);await $('media-timing-save').onclick();p.currentTime=0;
 $('transcript').querySelector('.segment .time button').click();assert.equal(p.currentTime,12,'known local offset maps the default playback start');
 await p.pause();p.currentTime=30;$('media-timing-preview').click();await settle();assert.equal(p.currentTime,30);assert.equal(p.paused,true);assert.equal(w.localTest.preview().range,null);
 w.localTest.repeat(doc.segments[0]);assert.equal(p.currentTime,30);assert.equal(p.paused,true);
 draft(env,-11);await $('media-timing-save').onclick();$('transcript').querySelector('.segment .time button').click();assert.equal(p.currentTime,30,'negative mapped time is rejected even before metadata');
 Object.defineProperty(p,'duration',{configurable:true,value:120});draft(env,111);await $('media-timing-save').onclick();$('transcript').querySelector('.segment .time button').click();assert.equal(p.currentTime,30,'known duration still bounds ordinary cue seeking');
 }finally{await env.w.happyDOM.close();}
});

test('native seeks release cue loops in either direction, including while paused, but owned rewinds survive queued seek events',async()=>{
 for(const paused of [false,true])for(const destination of [5,11,50]){
  const env=setup();try{const {w,$}=env,p=await open(env),doc=w.localTest.active();
   w.localTest.repeat(doc.segments[0]);
   // The initial seek's events can arrive after play/metadata events.
   p.dispatchEvent(new w.Event('loadedmetadata'));p.dispatchEvent(new w.Event('seeking'));p.dispatchEvent(new w.Event('timeupdate'));p.dispatchEvent(new w.Event('seeked'));
   if(paused)p.pause();
   p.currentTime=destination;p.dispatchEvent(new w.Event('seeking'));p.dispatchEvent(new w.Event('timeupdate'));p.dispatchEvent(new w.Event('seeked'));
   assert.equal(p.currentTime,destination);assert.equal($('stop-repeat').hidden,true);assert.equal(p.paused,paused);
  }finally{await env.w.happyDOM.close();}
 }
 const env=setup();try{const {w,$}=env,p=await open(env),doc=w.localTest.active();
  draft(env,2);await $('media-timing-save').onclick();w.localTest.repeat(doc.segments[0]);
  const seekEvents=()=>{p.dispatchEvent(new w.Event('seeking'));p.dispatchEvent(new w.Event('timeupdate'));p.dispatchEvent(new w.Event('seeked'));};
  seekEvents();assert.equal(p.currentTime,12);p.pause();assert.equal($('stop-repeat').hidden,false);await p.play();
  for(let i=0;i<2;i++){p.currentTime=14.1;p.dispatchEvent(new w.Event('timeupdate'));assert.equal(p.currentTime,12);seekEvents();assert.equal($('stop-repeat').hidden,false);}
  p.currentTime=14;p.dispatchEvent(new w.Event('ended'));assert.equal(p.currentTime,12);seekEvents();assert.equal($('stop-repeat').hidden,false);
  // A native seek overtakes an internal rewind before its queued events arrive.
  p.currentTime=14;p.dispatchEvent(new w.Event('timeupdate'));p.currentTime=50;seekEvents();
  assert.equal(p.currentTime,50);assert.equal($('stop-repeat').hidden,true);assert.equal(env.calls.length,0);
 }finally{await env.w.happyDOM.close();}
});

test('retired player seek events cannot stop a replacement loop, while source or attachment replacement retires its own loop',async()=>{
 const env=setup();try{const {w,$}=env,old=await open(env);
  w.localTest.repeat(w.localTest.active().segments[0]);
  await importJSON(env,{...captions,title:'Second source',segments:[{id:'new',start:20,end:24,text:'Second authored recording'}]});
  await pick(env,file(w,'Second.wav'),{add:false});const current=player(env),doc=w.localTest.active();
  w.localTest.repeat(doc.segments[0]);current.dispatchEvent(new w.Event('seeking'));current.dispatchEvent(new w.Event('seeked'));
  old.currentTime=90;old.dispatchEvent(new w.Event('seeking'));old.dispatchEvent(new w.Event('seeked'));old.dispatchEvent(new w.Event('timeupdate'));
  assert.equal($('stop-repeat').hidden,false);assert.equal(current.currentTime,20);
  current.setAttribute('src','blob:replacement');current.dispatchEvent(new w.Event('seeking'));assert.equal($('stop-repeat').hidden,true);
  w.localTest.repeat(doc.segments[0]);const prior=w.localTest.media().get(doc.key);w.localTest.media().set(doc.key,{...prior,url:'blob:replacement-attachment'});
  current.dispatchEvent(new w.Event('seeked'));assert.equal($('stop-repeat').hidden,true);
 }finally{await env.w.happyDOM.close();}
});


test('a timeupdate queued before native seeking cannot rewind the requested position; no-op entry owns no future seek',async()=>{
 const env=setup();try{const {w,$}=env,p=await open(env),doc=w.localTest.active();let seeking=false;
  Object.defineProperty(p,'seeking',{configurable:true,get:()=>seeking});
  w.localTest.repeat(doc.segments[0]);p.dispatchEvent(new w.Event('seeking'));p.dispatchEvent(new w.Event('seeked'));
  p.currentTime=50;seeking=true;p.dispatchEvent(new w.Event('timeupdate'));assert.equal(p.currentTime,50);
  p.dispatchEvent(new w.Event('seeking'));seeking=false;p.dispatchEvent(new w.Event('seeked'));assert.equal($('stop-repeat').hidden,true);
  p.currentTime=10;w.localTest.repeat(doc.segments[0]);assert.equal($('stop-repeat').hidden,false);
  // At an already-settled start, no internal seek is needed or expected.
  p.dispatchEvent(new w.Event('seeking'));assert.equal($('stop-repeat').hidden,true);assert.equal(p.currentTime,10);
 }finally{await env.w.happyDOM.close();}
});
