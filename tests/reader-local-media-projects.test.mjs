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
 w.eval(['summary','core','passages','passage-playback','app'].map(n=>fs.readFileSync(new URL('reader/'+n+'.js',root),'utf8')).join('\n')+'\nwindow.localTest={active:()=>active(),docs:()=>state.documents,media:()=>browserMedia,resetListen:()=>{listeningSession.engaged=false;renderListeningResume();},flush:()=>libraryStore.flush()};');
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

test('local source schema admits no fake transcript, remote association, file bytes, paths, or object URLs',()=>{
 const doc=Coconut.validate(project({source_url:'blob:private',local_media_source:{...localSource,url:'blob:private',bytes:'base64-private'},ai_answers:[{text:'fake'}]}));
 assert.equal(doc.project_kind,'audio_only');assert.deepEqual(doc.local_media_source,localSource);assert.equal(doc.source_url,'');assert.deepEqual(doc.segments,[]);assert.deepEqual(doc.ai_answers,[]);
 assert.match(Coconut.audioProjectIdentity(doc),/local_media/);assert.equal(Coconut.summaryReadiness(doc).ready,false);
 for(const invalid of [{name:'/private/recording.wav'},{name:'C:\\recording.wav'},{fingerprint:'blob:private'},{size:Infinity},{last_modified:-1},{type:'x\nsecret'}])assert.throws(()=>Coconut.validate(project({local_media_source:{...localSource,...invalid}})),/本地文件信息/);
 assert.throws(()=>Coconut.validate(project({podcast_source:{kind:'direct_media',media_url:'https://example.org/a.mp3',media_kind:'audio'}})),/一个公开媒体或本地文件来源/);
 const attached=Coconut.attachProjectTranscript(doc,{title:'captions',segments:[{id:'a',start:0,end:1,text:'Actual words'}],source_media:{job_id:'b'.repeat(32),kind:'video'}});
 assert.equal(attached.local_media_source.fingerprint,localSource.fingerprint);assert.equal(attached.source_media,undefined);assert.equal(attached.podcast_source,undefined);assert.equal(attached.project_kind,undefined);
 assert.equal(Coconut.validate(attached).local_media_source.name,localSource.name);
});

test('opening audio and video creates useful local-only projects with no service, model, autoplay or upload cap',async()=>{
 const env=setup();try{const {w,$,calls}=env;let read=0;
 const huge={name:'Large.mp4',type:'video/mp4',size:8*1024**3,lastModified:7,slice:(start,end)=>({text:async()=>{read+=Math.min(end,huge.size)-start;return 'ftyp';},arrayBuffer:async()=>{read+=Math.min(end,huge.size)-start;return new Uint8Array(Math.min(end,huge.size)-start).buffer;}})};
 await pick(env,huge);const doc=w.localTest.active();assert.ok($('source-media').querySelector('video'));assert.ok(read<=193*1024);assert.equal(env.created[0].file,huge);
 assert.equal(doc.local_media_source.size,8*1024**3);assert.equal(doc.segments.length,0);assert.equal($('audio-project').hidden,false);assert.equal($('reading-modes').hidden,true);assert.equal($('export-subtitles').disabled,true);assert.equal($('source-media').querySelector('video').autoplay,false);
 await addNote(env,'A useful note before any transcript');await bookmark(env);assert.equal(w.localTest.active().timestamp_bookmarks[0].time,12);
 const saved=w.localStorage.getItem('coconut-reader-v1');assert.ok(saved.length<2500);assert.doesNotMatch(saved,/blob:|ftyp|base64|api\/jobs/);assert.equal(calls.length,0);assert.match($('notice').textContent,/未运行识别或 AI/);
 $('add-content').click();await pick(env,file(w,'Other.wav'));assert.ok($('source-media').querySelector('audio'));assert.equal(w.localTest.docs().length,2);
 }finally{await env.w.happyDOM.close();}
});

test('reload requires explicit original-file reselection and preserves key, annotations and paused listening resume',async()=>{
 const env=setup();let fresh;try{const {w,$}=env;await pick(env,file(w));await addNote(env,'Persistent note');await bookmark(env);
 const key=w.localTest.active().key,p=player(env);await p.play();p.currentTime=42;p.pause();await w.localTest.flush();
 fresh=setup(snapshot(w));assert.equal(fresh.$('source-media').querySelector('audio'),null);assert.equal(fresh.$('project-note').value,'Persistent note');assert.match(fresh.$('reader-media-status').textContent,/重新选择.*Original.wav/);assert.equal(fresh.w.localTest.active().key,key);
 await pick(fresh,file(fresh.w,'Original.wav','RIFF different bytes'),{add:false});assert.equal(fresh.$('source-media').querySelector('audio'),null);assert.match(fresh.$('notice').textContent,/文件信息或部分内容与原文件不同/);assert.equal(fresh.$('project-note').value,'Persistent note');
 await pick(fresh,file(fresh.w),{add:false});const restored=player(fresh);assert.equal(fresh.$('resume-listening').hidden,false);fresh.$('resume-listening').click();assert.equal(restored.currentTime,42);assert.equal(restored.paused,true);assert.equal(fresh.w.localTest.active().timestamp_bookmarks[0].time,12);assert.equal(fresh.calls.length,0);
 }finally{await env.w.happyDOM.close();await fresh?.w.happyDOM.close();}
});

test('same-file reopening reuses the exact project and revokes only the old owned URL',async()=>{
 const env=setup();try{const {w,$}=env;await pick(env,file(w));await addNote(env,'Keep this note');const key=w.localTest.active().key,first=env.created[0].url;
 $('add-content').click();await pick(env,file(w));assert.equal(w.localTest.docs().length,1);assert.equal(w.localTest.active().key,key);assert.equal($('project-note').value,'Keep this note');assert.deepEqual(env.revoked,[first]);assert.equal(w.localTest.media().get(key).url,env.created[1].url);
 }finally{await env.w.happyDOM.close();}
});

test('distinct annotated backup versions require an exact choice without merging notes or rewriting versions',async()=>{
 const env=setup();try{const {w,$}=env;await pick(env,file(w));await addNote(env,'Version A');const first=w.localTest.active(),copy=JSON.parse(JSON.stringify(first));copy.project_note='Version B';await importJSON(env,copy);const second=w.localTest.active();assert.notEqual(first.key,second.key);
 $('add-content').click();const pending=pick(env,file(w));await until(()=>$('local-media-project-dialog').open);assert.equal($('local-media-project-options').children.length,2);assert.match($('local-media-project-options').textContent,/Version A/);assert.match($('local-media-project-options').textContent,/Version B/);
 [...$('local-media-project-options').children].find(button=>button.dataset.documentKey===first.key).click();await pending;assert.equal(w.localTest.active().key,first.key);assert.equal(w.localTest.docs().length,2);assert.equal(first.project_note,'Version A');assert.equal(second.project_note,'Version B');
 $('add-content').click();const cancelled=pick(env,file(w));await until(()=>$('local-media-project-dialog').open);$('cancel-local-media-project').click();await cancelled;assert.equal(env.created.length,2);assert.equal($('add-workspace').hidden,false);
 }finally{await env.w.happyDOM.close();}
});

test('later subtitle attachment keeps local identity, notes, bookmarks and current player on the same key',async()=>{
 const env=setup();try{const {w,$}=env;await pick(env,file(w));await addNote(env,'Private project note');await bookmark(env);const before=w.localTest.active(),p=player(env);
 $('attach-project-transcript').click();const text='1\n00:00:00,000 --> 00:00:02,000\nAuthored actual words\n';Object.defineProperty($('project-transcript-file'),'files',{configurable:true,value:[{name:'actual.srt',size:text.length,text:async()=>text}]});await $('project-transcript-file').onchange();
 const after=w.localTest.active();assert.equal(after.key,before.key);assert.equal(after.project_kind,undefined);assert.equal(after.local_media_source.fingerprint,before.local_media_source.fingerprint);assert.equal(after.project_note,'Private project note');assert.equal(after.timestamp_bookmarks[0].note,'Authored bookmark');assert.equal($('source-media').querySelector('audio'),p);assert.equal(w.localTest.docs().length,1);assert.equal(after.segments[0].text,'Authored actual words');assert.equal(env.calls.length,0);
 const exported=Coconut.validate(JSON.parse(JSON.stringify(after)));assert.equal(exported.local_media_source.name,'Original.wav');assert.doesNotMatch(JSON.stringify(exported),/blob:/);
 }finally{await env.w.happyDOM.close();}
});

test('cancel, wrong formats and remote playlists cannot open a project or allocate media URLs',async()=>{
 const env=setup();try{const {w,$}=env;$('open-local-media').click();$('local-media-file').dispatchEvent(new w.Event('cancel'));await pick(env,file(w),{click:false});assert.equal(w.localTest.docs().length,0);
 for(const selected of [file(w,'source.wav','#EXTM3U\nhttps://external.example/media.mp3'),file(w,'source.wav','[playlist]\nFile1=https://external.example'),file(w,'source.wav','<html>external</html>'),file(w,'empty.wav',''),file(w,'text.txt','words',{type:'text/plain'})])await pick(env,selected);
 assert.equal(w.localTest.docs().length,0);assert.equal(env.created.length,0);assert.equal(env.calls.length,0);
 }finally{await env.w.happyDOM.close();}
});

test('a newer file selection and navigation retire delayed fingerprint work before URL or project creation',async()=>{
 const env=setup();try{const {w,$}=env;let release;const slow={name:'Slow.wav',size:12,lastModified:7,type:'audio/wav',slice:()=>({text:()=>new Promise(resolve=>{release=()=>resolve('RIFF');}),arrayBuffer:async()=>new Uint8Array(12).buffer})};
 const pending=pick(env,slow);await until(()=>release);await pick(env,file(w,'New.wav'));release();await pending;assert.equal(w.localTest.docs().length,1);assert.equal(w.localTest.active().title,'New.wav');assert.equal(env.created.length,1);
 $('add-content').click();release=null;const navigate=pick(env,slow);await until(()=>release);$('back-reading').click();release();await navigate;assert.equal(w.localTest.docs().length,1);assert.equal(env.created.length,1);
 }finally{await env.w.happyDOM.close();}
});

test('successful removal revokes the file; Undo preserves annotations and requires reselection',async()=>{
 const env=setup();try{const {w,$}=env;await pick(env,file(w));await addNote(env,'Undo survives');const doc=w.localTest.active();
 w.document.querySelector('.library-remove').click();await $('confirm-removal').onclick();assert.equal(w.localTest.docs().length,0);assert.deepEqual(env.revoked,['blob:local-1']);assert.equal(w.localTest.media().size,0);
 await $('undo-removal').onclick();assert.equal(w.localTest.active().key,doc.key);assert.equal($('project-note').value,'Undo survives');assert.equal($('source-media').querySelector('audio'),null);assert.match($('reader-media-status').textContent,/重新选择/);
 await pick(env,file(w),{add:false});assert.equal(w.localTest.active().key,doc.key);assert.ok($('source-media').querySelector('audio'));
 }finally{await env.w.happyDOM.close();}
});

test('a failed project save keeps playable media and editable notes, reporting failure only after its receipt',async()=>{
 const env=setup({}, {held:true});try{const {w,$,pipeline}=env;const pending=pick(env,file(w));await until(()=>pipeline.writes.length===1);assert.ok($('source-media').querySelector('audio'));assert.equal($('save-status').dataset.state,'pending');assert.doesNotMatch($('notice').textContent,/项目已保存/);
 pipeline.writes.shift().fail('quota');await pending;assert.match($('notice').textContent,/尚未保存/);assert.equal($('save-status').dataset.state,'failed');assert.ok($('source-media').querySelector('audio'));pipeline.hold(false);await addNote(env,'Editable after failed save');assert.equal(w.localTest.active().project_note,'Editable after failed save');assert.equal($('save-status').dataset.state,'saved');
 }finally{await env.w.happyDOM.close();}
});

test('decoder failure offers clear reselection without deleting any annotations',async()=>{
 const env=setup();try{await pick(env,file(env.w));await addNote(env,'Keep on decode failure');const p=env.$('source-media').querySelector('audio');p.dispatchEvent(new env.w.Event('error'));assert.match(env.$('reader-media-status').textContent,/无法解码.*重新选择/);assert.equal(env.$('project-note').value,'Keep on decode failure');assert.equal(env.w.localTest.docs().length,1);
 }finally{await env.w.happyDOM.close();}
});

test('library navigation retains each owned file URL without borrowing a different project player',async()=>{
 const env=setup();try{const {w,$}=env;await pick(env,file(w));const first=w.localTest.active(),url=env.created[0].url;
 $('add-content').click();await pick(env,file(w,'Second.wav'));const second=w.localTest.active();assert.equal(env.revoked.length,0);
 [...w.document.querySelectorAll('.library-entry')].find(row=>row.dataset.documentKey===first.key).querySelector('.library-open').click();
 assert.equal($('source-media').querySelector('audio').getAttribute('src'),url);assert.equal(w.localTest.media().size,2);assert.equal(env.revoked.length,0);
 $('detach-reader-media').click();assert.deepEqual(env.revoked,[url]);assert.equal(w.localTest.media().has(second.key),true);
 }finally{await env.w.happyDOM.close();}
});

test('failed removal keeps ownership and its file URL without a revoke; retry and Undo never reuse freed bytes',async()=>{
 const env=setup();try{const {w,$,pipeline}=env;await pick(env,file(w));await addNote(env,'Removal failure note');const key=w.localTest.active().key;
 pipeline.hold();w.document.querySelector('.library-remove').click();const pending=$('confirm-removal').onclick();await until(()=>pipeline.writes.length===1);assert.equal(env.revoked.length,0);pipeline.writes.shift().fail('quota');await pending;
 assert.equal(w.localTest.docs()[0].key,key);assert.equal(env.revoked.length,0);assert.equal(w.localTest.media().has(key),true);pipeline.hold(false);await w.localTest.flush();
 w.document.querySelector('.library-open').click();assert.ok($('source-media').querySelector('audio'));assert.equal($('project-note').value,'Removal failure note');
 }finally{await env.w.happyDOM.close();}
});

test('delayed media reselection cannot attach across removal and Undo',async()=>{
 const env=setup();try{const {w,$}=env;await pick(env,file(w));const first=w.localTest.active();let release;
 const slow={name:'Original.wav',size:12,lastModified:7,type:'audio/wav',slice:()=>({text:()=>new Promise(resolve=>{release=()=>resolve('RIFF');}),arrayBuffer:async()=>new Uint8Array(12).buffer})};
 const pending=pick(env,slow,{add:false});await until(()=>release);w.document.querySelector('.library-remove').click();await $('confirm-removal').onclick();await $('undo-removal').onclick();release();await pending;
 assert.equal(w.localTest.active().key,first.key);assert.equal(env.created.length,1);assert.equal(w.localTest.media().size,0);
 }finally{await env.w.happyDOM.close();}
});

test('removing a candidate while its duplicate chooser is open cancels the pending file cleanly',async()=>{
 const env=setup();try{const {w,$}=env;await pick(env,file(w));await addNote(env,'One');const copy=JSON.parse(JSON.stringify(w.localTest.active()));copy.project_note='Two';await importJSON(env,copy);
 $('add-content').click();const pending=pick(env,file(w));await until(()=>$('local-media-project-dialog').open);
 $('back-reading').click();await pending;assert.equal($('local-media-project-dialog').open,false);assert.equal(env.created.length,1);assert.equal(w.localTest.docs().length,2);
 }finally{await env.w.happyDOM.close();}
});

test('new-project scroll happens before its held receipt and never scrolls a newer document',async()=>{
 const env=setup({}, {held:true});try{const {w,$,pipeline}=env;let scrolls=0;$('title').scrollIntoView=()=>{scrolls++;};
 const pending=pick(env,file(w));await until(()=>pipeline.writes.length===1);assert.equal(scrolls,1);
 $('add-content').click();assert.equal($('add-workspace').hidden,false);pipeline.writes.shift().commit();await pending;
 assert.equal(scrolls,1);assert.equal($('add-workspace').hidden,false);
 }finally{await env.w.happyDOM.close();}
});

test('local project language override, including explicit unknown, survives subtitle attachment',async()=>{
 for(const language of ['fr','']){
  const source=Coconut.validate(project({language,project_language_override:true}));assert.equal(source.project_language_override,true);
  const attached=Coconut.attachProjectTranscript(source,{title:'captions',language:'en',segments:[{id:'a',start:0,end:1,text:'Actual authored words'}]});
  assert.equal(attached.language,language);assert.equal(attached.project_language_override,true);assert.equal(attached.local_media_source.fingerprint,localSource.fingerprint);
 }
});

test('reselection retains its exact local project across navigation without changing or notifying the newer reader',async()=>{
 const env=setup();try{const {w,$}=env;await pick(env,file(w));const original=w.localTest.active(),chosen=file(w);let release;
 const slow={name:chosen.name,type:chosen.type,size:chosen.size,lastModified:chosen.lastModified,slice:(start,end)=>{const part=chosen.slice(start,end);return start===0&&end===1024?{text:()=>new Promise(resolve=>{release=async()=>resolve(await part.text());})}:part;}};
 const pending=pick(env,slow,{add:false});await until(()=>release);await $('sample').onclick();const newer=w.localTest.active(),notice=$('notice').textContent;release();await pending;
 assert.equal(w.localTest.active(),newer);assert.equal($('source-media').querySelector('audio'),null);assert.equal($('notice').textContent,notice);assert.equal(w.localTest.media().get(original.key).url,'blob:local-2');assert.deepEqual(env.revoked,['blob:local-1']);
 [...w.document.querySelectorAll('.library-entry')].find(row=>row.dataset.documentKey===original.key).querySelector('.library-open').click();assert.equal($('source-media').querySelector('audio').getAttribute('src'),'blob:local-2');
 }finally{await env.w.happyDOM.close();}
});
