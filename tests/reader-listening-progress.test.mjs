import {installSavePipeline} from './helpers/save-pipeline.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url);
function setup(storage={}){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});for(const [k,v]of Object.entries(storage))w.localStorage.setItem(k,v);
 w.fetch=async()=>{throw new Error('No external requests');};
 installSavePipeline(w);
 w.eval(['summary','core','passages','passage-playback','app'].map(n=>fs.readFileSync(new URL('reader/'+n+'.js',root),'utf8')).join('\n')+'\nwindow.testProgress={reset:()=>{listeningSession.engaged=false;renderListeningResume();},listen:range=>passagePlayback.listen(range),cancel:()=>passagePlayback.cancel(),return:()=>passagePlayback.returnToPrevious(),replaceDocument:()=>{state.documents[state.documents.indexOf(active())]={...active()};},replaceAttachment:()=>browserMedia.set(active().key,{origin:"local",identity:"new-authored-attachment",url:$("source-media").querySelector("audio,video").getAttribute("src"),kind:"audio"})};');
 return {w,$:id=>w.document.getElementById(id)};
}
const fixture={title:'Authored listening fixture',source_media:{job_id:'a'.repeat(32),kind:'audio'},segments:[{id:'one',start:0,end:40,text:'Authored text'}]};
async function media(env){
 const {w,$}=env,text=JSON.stringify(fixture);Object.defineProperty($('file'),'files',{configurable:true,value:[{name:'listening.json',size:text.length,text:async()=>text}]});await $('file').onchange();
 w.dispatchEvent(new w.Event('coconut-worker-ready'));const p=$('source-media').querySelector('audio');let paused=true;
 Object.defineProperties(p,{duration:{configurable:true,value:120},paused:{configurable:true,get:()=>paused}});
 p.play=async()=>{if(paused){paused=false;p.dispatchEvent(new w.Event('play'));}};p.pause=()=>{paused=true;p.dispatchEvent(new w.Event('pause'));};
 p.dispatchEvent(new w.Event('loadedmetadata'));return p;
}
const stored=w=>Array.from({length:w.localStorage.length},(_,i)=>w.localStorage.key(i)).filter(k=>k.startsWith('coconut-listening-v1:'));
test('separate checkpoint is throttled, reloaded only by explicit paused resume, and does not alter manual bookmark',async()=>{
 const env=setup();try{const {w,$}=env,p=await media(env);const library=w.localStorage.getItem('coconut-reader-v1');
 await p.play();p.currentTime=30;p.dispatchEvent(new w.Event('timeupdate'));const key=stored(w)[0],old=w.localStorage.getItem(key);
 p.currentTime=31;p.dispatchEvent(new w.Event('timeupdate'));assert.equal(w.localStorage.getItem(key),old);p.pause();assert.equal(JSON.parse(w.localStorage.getItem(key)).time,31);
 assert.equal(w.localStorage.getItem('coconut-reader-v1'),library);
 p.currentTime=0;w.testProgress.reset();assert.equal(p.currentTime,0);assert.equal($('resume-listening').hidden,false);$('resume-listening').click();assert.equal(p.currentTime,31);assert.equal(p.paused,true);assert.match($('listening-progress-status').textContent,/未自动播放/);
 }finally{await env.w.happyDOM.close();}
});
test('preview cancel and pagehide retain main position until explicit normal play',async()=>{
 const env=setup();try{const {w}=env,p=await media(env);await p.play();p.currentTime=70;p.pause();const key=stored(w)[0];
 await w.testProgress.listen({id:'one',start:10,end:20});p.currentTime=15;p.dispatchEvent(new w.Event('timeupdate'));w.testProgress.cancel();p.pause();w.dispatchEvent(new w.Event('pagehide'));assert.equal(JSON.parse(w.localStorage.getItem(key)).time,70);
 await p.play();p.currentTime=25;p.pause();assert.equal(JSON.parse(w.localStorage.getItem(key)).time,25);
 }finally{await env.w.happyDOM.close();}
});
test('completion clears resume, short media ignored and storage failure preserves last record',async()=>{
 const env=setup();try{const {w,$}=env,p=await media(env);await p.play();p.currentTime=40;p.pause();const key=stored(w)[0],old=w.localStorage.getItem(key);
 const backing=w.localStorage;Object.defineProperty(w,'localStorage',{configurable:true,value:{getItem:key=>backing.getItem(key),setItem:()=>{throw new Error('Quota');}}});p.currentTime=50;p.pause();assert.equal(w.localStorage.getItem(key),old);assert.match($('listening-progress-status').textContent,/未能保存/);
 Object.defineProperty(w,'localStorage',{configurable:true,value:backing});p.currentTime=119;p.pause();assert.equal($('resume-listening').hidden,true);
 Object.defineProperty(p,'duration',{value:10});p.currentTime=6;p.pause();assert.equal(JSON.parse(w.localStorage.getItem(key)).time,0);
 }finally{await env.w.happyDOM.close();}
});
test('candidate fingerprint samples at most 192 KiB even for huge files and includes changed metadata/content',async()=>{
 const env=setup();try{const {w}=env;let read=0;w.file={name:'same.wav',size:8*1024**3,lastModified:7,type:'audio/wav',slice:(a,b)=>({arrayBuffer:async()=>{read+=b-a;return new Uint8Array(b-a).buffer;}})};
 const first=await w.eval('fingerprintMedia(file)');assert.ok(read<=192*1024);w.file.lastModified=8;assert.notEqual(await w.eval('fingerprintMedia(file)'),first);
 w.file.lastModified=7;w.file.slice=(a,b)=>({arrayBuffer:async()=>new Uint8Array(b-a).fill(1).buffer});assert.notEqual(await w.eval('fingerprintMedia(file)'),first);
 }finally{await env.w.happyDOM.close();}
});
test('explicit skip takes over a playing preview without requiring another play event',async()=>{
 const env=setup();try{const {w,$}=env,p=await media(env);await p.play();p.currentTime=70;p.pause();const key=stored(w)[0];await w.testProgress.listen({id:'one',start:10,end:30});
 $('skip-forward').click();p.dispatchEvent(new w.Event('seeked'));p.currentTime=23;p.pause();assert.equal(JSON.parse(w.localStorage.getItem(key)).time,23);
 }finally{await env.w.happyDOM.close();}
});
test('changed identity or loaded duration never exposes an old resume position',async()=>{
 const env=setup();try{const {w,$}=env,p=await media(env);await p.play();p.currentTime=40;p.pause();
 Object.defineProperty(p,'duration',{value:121});p.dispatchEvent(new w.Event('durationchange'));assert.equal($('resume-listening').hidden,true);
 Object.defineProperty(p,'duration',{value:120});w.testProgress.reset();assert.equal($('resume-listening').hidden,false);
 const key=stored(w)[0],record=JSON.parse(w.localStorage.getItem(key));record.identity='other-source';w.localStorage.setItem(key,JSON.stringify(record));
 const fresh=setup({'coconut-reader-v1':w.localStorage.getItem('coconut-reader-v1'),[key]:JSON.stringify(record)});try{await media(fresh);assert.equal(fresh.$('resume-listening').hidden,true);}finally{await fresh.w.happyDOM.close();}
 }finally{await env.w.happyDOM.close();}
});
test('failed preview return cannot replace the primary position with a temporary preview clock',async()=>{
 const env=setup();try{const {w}=env,p=await media(env);await p.play();p.currentTime=70;p.pause();const key=stored(w)[0];await w.testProgress.listen({id:'one',start:10,end:20});p.currentTime=15;
 Object.defineProperty(p,'currentTime',{configurable:true,get:()=>15,set(){throw new Error('seek rejected');}});
 await w.testProgress.return();p.pause();w.dispatchEvent(new w.Event('pagehide'));assert.equal(JSON.parse(w.localStorage.getItem(key)).time,70);
 }finally{await env.w.happyDOM.close();}
});
test('failed skip keeps a canceled preview from replacing the primary position',async()=>{
 const env=setup();try{const {w,$}=env,p=await media(env);await p.play();p.currentTime=70;p.pause();const key=stored(w)[0];await w.testProgress.listen({id:'one',start:10,end:20});p.currentTime=15;
 Object.defineProperty(p,'currentTime',{configurable:true,get:()=>15,set(){throw new Error('seek rejected');}});
 $('skip-forward').click();w.dispatchEvent(new w.Event('pagehide'));assert.equal(JSON.parse(w.localStorage.getItem(key)).time,70);
 }finally{await env.w.happyDOM.close();}
});
test('a canceled native picker retires its target; a fresh chooser selection attaches normally',async()=>{
 const env=setup();try{
  const {w,$}=env,original=await media(env),originalSource=original.getAttribute('src');
  w.URL.createObjectURL=()=> 'blob:authored-selection';w.URL.revokeObjectURL=()=>{};
  const file={name:'authored.wav',type:'audio/wav',size:4,lastModified:7,slice:()=>({text:async()=> 'RIFF',arrayBuffer:async()=>new Uint8Array([82,73,70,70]).buffer})};
  const choose=async()=>{Object.defineProperty($('reader-media-file'),'files',{configurable:true,value:[file]});await $('reader-media-file').onchange();};
  $('attach-reader-media').click();$('reader-media-file').dispatchEvent(new w.Event('cancel'));await choose();
  assert.equal($('source-media').querySelector('audio').getAttribute('src'),originalSource);
  assert.match($('notice').textContent,/打开媒体失败：原文字稿已关闭，请重新选择/);
  $('attach-reader-media').click();await choose();
  assert.equal($('source-media').querySelector('audio').getAttribute('src'),'blob:authored-selection');
  assert.match($('notice').textContent,/媒体只在本次页面读取/);
 }finally{await env.w.happyDOM.close();}
});

test('late cue play abort after navigation does not replace the new document notice',async()=>{
 const env=setup();try{
 const {w,$}=env,p=await media(env);$('mode-transcript').click();
 let rejectPlay;p.play=()=>new Promise((resolve,reject)=>{rejectPlay=reject;});
 $('transcript').querySelector('.segment .time button').click();
 const next=JSON.stringify({title:'New document without media',segments:[{id:'new',start:0,end:5,text:'New authored text'}]});
 Object.defineProperty($('file'),'files',{configurable:true,value:[{name:'new.json',size:next.length,text:async()=>next}]});await $('file').onchange();
 const before=$('notice').textContent;assert.equal($('title').textContent,'New document without media');
 rejectPlay(Object.assign(new Error('play interrupted by pause'),{name:'AbortError'}));await Promise.resolve();await Promise.resolve();
 assert.equal($('notice').textContent,before);
 }finally{await env.w.happyDOM.close();}
});
test('a genuine cue playback rejection for the current owner remains visible',async()=>{
 const env=setup();try{const {w,$}=env,p=await media(env);$('mode-transcript').click();
 p.play=async()=>{throw Object.assign(new Error('permission denied'),{name:'NotAllowedError'});};
 $('transcript').querySelector('.segment .time button').click();await Promise.resolve();await Promise.resolve();
 assert.equal($('notice').textContent,'请点击播放器开始播放，再按时间戳定位。');
 }finally{await env.w.happyDOM.close();}
});
test('cue playback rejection cannot report for a replaced source, attachment or document on the same player',async()=>{
 for(const replacement of ['source','attachment','document']){
  const env=setup();try{const {w,$}=env,p=await media(env);$('mode-transcript').click();
   let rejectPlay;p.play=()=>new Promise((resolve,reject)=>{rejectPlay=reject;});
   $('transcript').querySelector('.segment .time button').click();
   if(replacement==='source')p.setAttribute('src','blob:authored-replacement');else if(replacement==='attachment')w.testProgress.replaceAttachment();else w.testProgress.replaceDocument();
   const before=$('notice').textContent;
   rejectPlay(Object.assign(new Error('obsolete playback failed'),{name:'NotAllowedError'}));await Promise.resolve();await Promise.resolve();
   assert.equal($('source-media').querySelector('audio'),p,'same element is deliberately reused');
   assert.equal($('notice').textContent,before,replacement+' owns its own guidance');
  }finally{await env.w.happyDOM.close();}
 }
});
test('expected cue playback AbortError is quiet even while the same owner remains active',async()=>{
 const env=setup();try{const {w,$}=env,p=await media(env);$('mode-transcript').click();
  const before=$('notice').textContent;
  p.play=async()=>{throw Object.assign(new Error('pause interrupted playback'),{name:'AbortError'});};
  $('transcript').querySelector('.segment .time button').click();await Promise.resolve();await Promise.resolve();
  assert.equal($('notice').textContent,before);
 }finally{await env.w.happyDOM.close();}
});

test('same-document library reselection retires delayed rejection',async()=>{
 const env=setup();try{const {w,$}=env,p=await media(env);$('mode-transcript').click();
 let rejectPlay;p.play=()=>new Promise((resolve,reject)=>{rejectPlay=reject;});
 $('transcript').querySelector('.segment .time button').click();
 $('library').querySelector('.library-open').click();
 const before=$('notice').textContent;
 assert.equal($('source-media').querySelector('audio'),p);
 rejectPlay(Object.assign(new Error('old permission denial'),{name:'NotAllowedError'}));await Promise.resolve();await Promise.resolve();
 assert.equal($('notice').textContent,before);
 }finally{await env.w.happyDOM.close();}
});
test('delayed permission denial cannot overwrite different-document notice',async()=>{
 const env=setup();try{const {w,$}=env,p=await media(env);$('mode-transcript').click();
 let rejectPlay;p.play=()=>new Promise((resolve,reject)=>{rejectPlay=reject;});$('transcript').querySelector('.segment .time button').click();
 const text=JSON.stringify({title:'Other source',source_media:{job_id:'b'.repeat(32),kind:'audio'},segments:[{id:'other',start:0,end:10,text:'Other text'}]});Object.defineProperty($('file'),'files',{configurable:true,value:[{name:'other.json',size:text.length,text:async()=>text}]});await $('file').onchange();
 assert.notEqual($('source-media').querySelector('audio'),p);const before=$('notice').textContent;rejectPlay(Object.assign(new Error('old denial'),{name:'NotAllowedError'}));await Promise.resolve();await Promise.resolve();assert.equal($('notice').textContent,before);
 }finally{await env.w.happyDOM.close();}
});
