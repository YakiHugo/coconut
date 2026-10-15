// Compatibility renderer regression; this suite is not default React acceptance.
/** Production DOM handlers with authored media and storage only; no browser/model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import C from '../reader/core.js';
import {installSavePipeline,settle,saveClock} from './helpers/save-pipeline.mjs';
const root=new URL('../',import.meta.url),KEY='coconut-reader-v1';
const srt='1\n00:00:01,125 --> 00:00:03,875\nFirst authored caption 你好\nSecond line\n\n2\n00:00:04,000 --> 00:00:05,250\nSecond caption';
const vtt='WEBVTT\n\nopening\n00:01.125 --> 00:03.875\n<v Alice>Hello &lt;Team&gt;</v>\n\nreply\n00:04.000 --> 00:05.250\n<v Bob>Reply</v>';
const clone=value=>JSON.parse(JSON.stringify(value));
function setup(storage={}){
 const w=new Window({url:'https://coconut.example/'}),network=[],created=[];
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/compatibility.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 for(const [key,value] of Object.entries(storage))w.localStorage.setItem(key,value);
 Object.defineProperty(w,'crypto',{value:webcrypto});w.fetch=url=>{network.push(String(url));throw Error('Offline authored captions only');};
 w.URL.createObjectURL=file=>{const url='blob:project-'+created.length;created.push({url,file});return url;};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};
 const saves=installSavePipeline(w,{clock:saveClock()});
 w.eval(['summary','core','passages','passage-playback','app'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+`\nwindow.projectPasteTest={active:()=>active(),docs:()=>state.documents,media:()=>browserMedia,select:key=>{resetReaderForDocumentNavigation();selectActiveDocument(key);render();},remove:()=>requestLibraryRemoval(active()),mediaChange:()=>changeMediaSelection(active().key),replace:()=>{state.documents[state.documents.indexOf(active())]={...active()};},sourceChange:()=>{active().local_media_source={...active().local_media_source,name:'Changed.wav'};},flush:()=>libraryStore.flush()};`);
 const $=id=>{const node=w.document.getElementById(id);assert.ok(node,'Missing production element #'+id);return node;};
 const change=(id,value)=>{$(id).value=value;$(id).dispatchEvent(new w.Event(id==='paste-subtitle-format'?'change':'input',{bubbles:true}));};
 return {w,$,saves,network,created,change,active:()=>w.projectPasteTest.active(),docs:()=>w.projectPasteTest.docs(),stored:()=>JSON.parse(w.localStorage.getItem(KEY)),storage:()=>Object.fromEntries(Array.from({length:w.localStorage.length},(_,i)=>{const key=w.localStorage.key(i);return [key,w.localStorage.getItem(key)];})),close:async()=>{saves.hold(false);for(const write of saves.writes)write.commit();await settle();await w.happyDOM.close();}};
}
async function until(fn){for(let i=0;i<200&&!fn();i++){await settle();await new Promise(r=>setTimeout(r,1));}assert.ok(fn(),'checkpoint reached');}
async function project(e,name='Original.wav'){
 e.$('open-local-media').click();Object.defineProperty(e.$('local-media-file'),'files',{configurable:true,value:[new e.w.File(['RIFF authored local audio'],name,{type:'audio/wav',lastModified:7})]});await e.$('local-media-file').onchange();
 e.change('project-note','Private project note');await e.w.projectPasteTest.flush();
 e.$('audio-bookmark-time').value='12.5';e.$('audio-bookmark-note').value='Saved time note';await e.$('audio-bookmark-form').onsubmit({preventDefault(){}});await e.w.projectPasteTest.flush();return e.active();
}
function preview(e,text=srt){e.$('paste-project-subtitles').click();assert.equal(e.$('paste-subtitle-dialog').open,true);e.change('paste-subtitle-text',text);e.$('preview-paste-subtitle').click();assert.equal(e.$('confirm-paste-subtitle').disabled,false,e.$('paste-subtitle-status').textContent);}
function player(e){const p=e.$('source-media').querySelector('audio');Object.defineProperties(p,{duration:{configurable:true,value:120},paused:{configurable:true,value:true}});let plays=0;p.play=async()=>{plays++;};p.dispatchEvent(new e.w.Event('loadedmetadata'));p.currentTime=31.25;return {p,plays:()=>plays};}
for(const [format,text] of [['srt',srt],['vtt',vtt]])test(format+' project paste previews exact destination and attaches once preserving player, metadata and drafts',async()=>{
 const e=setup();let restored;try{
  const original=await project(e,'<Original & voice>.wav'),before=clone(original),{p,plays}=player(e),attachment=e.w.projectPasteTest.media().get(original.key);
  e.$('audio-bookmark-time').value='27.125';e.$('audio-bookmark-note').value='Unsubmitted bookmark';
  preview(e,text);assert.match(e.$('paste-subtitle-destination').textContent,/<Original & voice>.wav/);assert.equal(e.$('paste-subtitle-destination').querySelector('original'),null);assert.match(e.$('confirm-paste-subtitle').textContent,/附加到此项目/);assert.equal(e.$('paste-subtitle-title').hidden,true);
  assert.equal(e.docs().length,1);assert.equal(e.active(),original);assert.equal(e.$('source-media').querySelector('audio'),p);
  await e.$('confirm-paste-subtitle').onclick();const after=e.active();assert.notEqual(after,original);assert.equal(e.docs().length,1);assert.equal(after.key,before.key);assert.equal(after.title,before.title);assert.equal(after.project_kind,undefined);assert.deepEqual(clone(after.local_media_source),before.local_media_source);assert.equal(after.project_note,before.project_note);assert.deepEqual(clone(after.timestamp_bookmarks),before.timestamp_bookmarks);assert.deepEqual(clone(after.segments),clone(C.parsePastedSubtitles(text,{format}).document.segments));
  assert.equal(e.$('source-media').querySelector('audio'),p);assert.equal(e.w.projectPasteTest.media().get(after.key),attachment);assert.equal(p.currentTime,31.25);assert.equal(plays(),0);assert.equal(e.$('audio-bookmark-time').value,'27.125');assert.equal(e.$('audio-bookmark-note').value,'Unsubmitted bookmark');assert.equal(e.$('paste-project-subtitles').hidden,true);assert.equal(e.$('paste-subtitle-dialog').open,false);assert.equal(e.$('paste-subtitle-text').value,'');
  restored=setup(e.storage());assert.equal(restored.docs().length,1);assert.deepEqual(clone(restored.active()),clone(after));assert.equal(restored.$('source-media').querySelector('audio'),null);assert.deepEqual(e.network,[]);
 }finally{await e.close();await restored?.close();}
});
test('invalid captions and malformed-block diagnostics use strict shared preview without mutating the project',async()=>{
 const e=setup();try{await project(e);const before=clone(e.active());e.$('paste-project-subtitles').click();e.change('paste-subtitle-text','00:01 no end');e.$('preview-paste-subtitle').click();assert.equal(e.$('confirm-paste-subtitle').disabled,true);await e.$('confirm-paste-subtitle').onclick();assert.deepEqual(clone(e.active()),before);
  e.change('paste-subtitle-text',srt+'\n\n3\n00:00:06,000 -> 00:00:07,000\n<bad>');e.$('preview-paste-subtitle').click();assert.match(e.$('paste-subtitle-status').textContent,/跳过 1/);assert.ok(e.$('paste-subtitle-diagnostics').querySelector('details'));await e.$('confirm-paste-subtitle').onclick();assert.equal(e.docs().length,1);assert.equal(e.active().segments.length,2);
 }finally{await e.close();}
});
for(const close of ['close','cancel','clear'])test(close+' preserves exact project and requires a new preview before attachment',async()=>{
 const e=setup();try{await project(e);const before=clone(e.active());preview(e);
  if(close==='cancel')e.$('paste-subtitle-dialog').dispatchEvent(new e.w.Event('cancel',{cancelable:true}));else e.$(close==='close'?'close-paste-subtitle':'clear-paste-subtitle').click();
  await e.$('confirm-paste-subtitle').onclick();assert.deepEqual(clone(e.active()),before);assert.equal(e.docs().length,1);assert.equal(e.$('paste-subtitle-text').value,close==='clear'?'':srt);
  if(close!=='clear'){e.$('paste-project-subtitles').click();assert.equal(e.$('confirm-paste-subtitle').disabled,true);assert.match(e.$('paste-subtitle-destination').textContent,/Original.wav/);}
 }finally{await e.close();}
});
for(const change of ['sourceChange','replace','mediaChange'])test('stale '+change+' refuses to attach instead of overwriting newer ownership',async()=>{
 const e=setup();try{await project(e);preview(e);e.w.projectPasteTest[change]();const before=clone(e.active());await e.$('confirm-paste-subtitle').onclick();assert.deepEqual(clone(e.active()),before);assert.equal(e.docs().length,1);assert.equal(e.$('paste-subtitle-text').value,srt);assert.match(e.$('paste-subtitle-status').textContent,/切换|更新|重新/);
 }finally{await e.close();}
});
for(const action of ['close','edit','navigation','mediaChange'])test('held project save receipt cannot take over newer '+action+' or clear its draft',async()=>{
 const e=setup();try{const first=await project(e);e.$('add-content').click();const second=await project(e,'Other.wav');e.w.projectPasteTest.select(first.key);preview(e);e.saves.hold();const submitted=e.$('confirm-paste-subtitle').onclick();await until(()=>e.saves.writes.length===1);assert.equal(e.docs().length,2);
  await e.$('confirm-paste-subtitle').onclick();assert.equal(e.saves.writes.length,1);
  if(action==='close')e.$('close-paste-subtitle').click();if(action==='edit')e.change('paste-subtitle-text','New unsaved draft');if(action==='navigation')e.w.projectPasteTest.select(second.key);if(action==='mediaChange')e.w.projectPasteTest.mediaChange();
  const active=e.active(),draft=e.$('paste-subtitle-text').value;e.saves.writes[0].commit();await submitted;assert.equal(e.active(),active);assert.equal(e.$('paste-subtitle-text').value,draft);assert.equal(e.docs().length,2);assert.equal(e.docs().find(d=>d.key===first.key).segments.length,2);
 }finally{await e.close();}
});
test('failed save exports the same attached project and retries durability without attaching again',async()=>{
 const e=setup();try{const original=await project(e);preview(e);e.saves.hold();const submit=e.$('confirm-paste-subtitle').onclick();await until(()=>e.saves.writes.length===1);e.saves.writes[0].fail();await submit;const attached=e.active();assert.equal(attached.key,original.key);assert.equal(e.docs().length,1);assert.equal(e.$('retry-paste-subtitle').hidden,false);assert.equal(e.$('paste-subtitle-text').value,srt);assert.equal(e.stored().documents[0].segments.length,0);e.$('export-paste-subtitle').click();assert.equal(e.created.at(-1).file.type,'application/json');
  const retry=e.$('retry-paste-subtitle').onclick();await until(()=>e.saves.writes.length===2);e.saves.writes[1].commit();await retry;assert.equal(e.active(),attached);assert.equal(e.docs().length,1);assert.equal(e.stored().documents[0].segments.length,2);assert.equal(e.$('paste-subtitle-dialog').open,false);assert.equal(e.$('paste-subtitle-text').value,'');
 }finally{await e.close();}
});
test('deleted target and restored project cannot revive an old paste confirmation',async()=>{
 const e=setup();try{const original=await project(e);preview(e);e.w.projectPasteTest.remove();await e.$('confirm-removal').onclick();await e.$('confirm-paste-subtitle').onclick();assert.equal(e.docs().length,0);await e.$('undo-removal').onclick();assert.equal(e.docs().length,1);assert.equal(e.active().key,original.key);assert.equal(e.active().segments.length,0);await e.$('confirm-paste-subtitle').onclick();assert.equal(e.active().segments.length,0);assert.equal(e.$('paste-subtitle-text').value,srt);
 }finally{await e.close();}
});
test('standalone paste remains independent and identical existing text never steals the project destination',async()=>{
 const e=setup();try{const original=await project(e);e.$('add-content').click();e.$('paste-subtitles').click();e.change('paste-subtitle-title','Original.wav');e.change('paste-subtitle-text',srt);e.$('preview-paste-subtitle').click();await e.$('confirm-paste-subtitle').onclick();const standalone=e.active();assert.notEqual(standalone.key,original.key);assert.equal(e.docs().length,2);assert.equal(standalone.local_media_source,undefined);
  e.w.projectPasteTest.select(original.key);preview(e);await e.$('confirm-paste-subtitle').onclick();assert.equal(e.docs().length,2);assert.equal(e.active().key,original.key);assert.equal(e.docs().find(d=>d.key===standalone.key),standalone);assert.equal(e.active().project_note,'Private project note');
 }finally{await e.close();}
});

test('existing 500-character project title and explicit language survive without the standalone title limit',async()=>{
 const title='现有项目'.repeat(125),source={version:1,kind:'audio',name:'Original.wav',size:64,last_modified:7,type:'audio/wav',fingerprint:'a'.repeat(64)};
 const doc={...C.validate({project_kind:'audio_only',title,source_url:'https://example.org/authored',language:'zh',project_language_override:true,local_media_source:source,segments:[]}),key:'long-title'};
 const e=setup({[KEY]:JSON.stringify({documents:[doc],active:doc.key})});try{preview(e);assert.ok(e.$('paste-subtitle-destination').textContent.includes(title));await e.$('confirm-paste-subtitle').onclick();assert.equal(e.active().title,title);assert.equal(e.active().language,'zh');assert.equal(e.active().project_language_override,true);assert.equal(e.active().source_url,doc.source_url);assert.equal(e.docs().length,1);}finally{await e.close();}
});

test('a cancelled project draft can be explicitly reused for another project without retaining old recovery actions',async()=>{
 const e=setup();try{const first=await project(e);e.$('add-content').click();const second=await project(e,'Other.wav');e.w.projectPasteTest.select(first.key);preview(e);e.saves.hold();const submit=e.$('confirm-paste-subtitle').onclick();await until(()=>e.saves.writes.length===1);e.saves.writes[0].fail();await submit;assert.equal(e.$('retry-paste-subtitle').hidden,false);e.$('close-paste-subtitle').click();e.saves.hold(false);await e.saves.store.retry(first.key);e.w.projectPasteTest.select(second.key);e.$('paste-project-subtitles').click();assert.match(e.$('paste-subtitle-destination').textContent,/Other.wav/);assert.equal(e.$('retry-paste-subtitle').hidden,true);assert.equal(e.$('read-paste-subtitle').hidden,true);assert.equal(e.$('confirm-paste-subtitle').disabled,true);assert.equal(e.$('paste-subtitle-text').value,srt);e.$('preview-paste-subtitle').click();await e.$('confirm-paste-subtitle').onclick();assert.equal(e.active().key,second.key);assert.equal(e.docs().length,2);assert.ok(e.docs().every(doc=>doc.segments.length===2));}finally{await e.close();}
});

test('queued project-note edits and newer note text during a held attachment receipt remain on the same owner',async()=>{
 const e=setup();try{await project(e);e.change('project-note','Queued before caption attachment');preview(e);e.saves.hold();const submitted=e.$('confirm-paste-subtitle').onclick();await until(()=>e.saves.writes.length===1);const attached=e.active();e.change('project-note','Newer note during caption save');e.saves.hold(false);e.saves.writes[0].commit();await submitted;await e.w.projectPasteTest.flush();assert.equal(e.active(),attached);assert.equal(e.active().project_note,'Newer note during caption save');assert.equal(e.stored().documents[0].project_note,'Newer note during caption save');assert.equal(e.docs().length,1);}finally{await e.close();}
});
