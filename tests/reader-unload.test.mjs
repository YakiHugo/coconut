import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url),key='coconut-reader-v1';
function setup(stored,desktop=false){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});
 if(desktop)Object.defineProperty(w,'coconutUpdates',{value:Object.freeze({state:async()=>({status:'idle',version:'test',arch:'arm64'}),subscribe:()=>{}})});
 if(stored!==undefined)w.localStorage.setItem(key,stored);
 const attached=new Set(),add=w.addEventListener.bind(w),remove=w.removeEventListener.bind(w);
 w.addEventListener=(type,fn,...args)=>{if(type==='beforeunload')attached.add(fn);return add(type,fn,...args);};
 w.removeEventListener=(type,fn,...args)=>{if(type==='beforeunload')attached.delete(fn);return remove(type,fn,...args);};
 for(const file of ['summary','core','passages','passage-playback'])w.eval(fs.readFileSync(new URL(`reader/${file}.js`,root),'utf8'));
 w.eval(['app','language','podcasts'].map(file=>fs.readFileSync(new URL(`reader/${file}.js`,root),'utf8')).join('\n')+'\nwindow.draftTest={fixture(){active().project_note="";active().timestamp_bookmarks=[{id:"first",time:10,note:"Keep me"},{id:"second",time:20,note:"Other"}];state.documents.push({...JSON.parse(JSON.stringify(active())),key:"other",title:"Other document"});save();render();},switchDoc(other){selectActiveDocument(other?"other":state.documents[0].key);render();},plain(){const doc={...JSON.parse(JSON.stringify(active())),key:"plain",title:"Plain transcript"};delete doc.project_note;delete doc.timestamp_bookmarks;state.documents.push(doc);selectActiveDocument(doc.key);save();render();}};'+(desktop?'\nlet sourceSubmitting=false,sourceCaptionRequest=null;\n'+fs.readFileSync(new URL('reader/updates.js',root),'utf8'):''));
 return {w,$:id=>w.document.getElementById(id),attached};
}
function unload(w){const event=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(event);return event.defaultPrevented;}
function input(w,node,value){node.value=value;node.dispatchEvent(new w.Event('input',{bubbles:true}));}
function note(w,text){w.document.querySelector('.segment .note-button').click();input(w,w.document.getElementById('note'),text);}
test('clean, saved notes, and background work have no unload listener',async()=>{
 const {w,$,attached}=setup();try{
  assert.equal(attached.size,0);await $('sample').onclick();note(w,'Saved now');
  assert.equal(attached.size,0);assert.equal(unload(w),false);
  w.eval('asking=true;translating=true;subscriptionTranslating=true');
  $('search').click();assert.equal(attached.size,0);assert.equal(unload(w),false);
  const reload=setup(w.localStorage.getItem(key));try{assert.equal(reload.attached.size,0);assert.equal(JSON.parse(reload.w.localStorage.getItem(key)).documents[0].notes['demo-1'],'Saved now');}finally{await reload.w.happyDOM.close();}
 }finally{await w.happyDOM.close();}
});
test('failed note persistence protects unload and a successful retry removes protection',async()=>{
 const {w,$,attached}=setup();try{
  await $('sample').onclick();const backing=w.localStorage;let blocked=true;
  Object.defineProperty(w,'localStorage',{value:{getItem:k=>backing.getItem(k),setItem(k,v){if(blocked)throw new Error('quota');backing.setItem(k,v);}}});
  note(w,'Unsaved note');assert.equal(attached.size,1);assert.equal(unload(w),true);assert.equal($('save-status').hidden,false);
  blocked=false;input(w,$('note'),'Saved after retry');assert.equal(attached.size,0);assert.equal(unload(w),false);assert.equal($('save-status').hidden,true);
 }finally{await w.happyDOM.close();}
});
test('stale-tab navigation alone stays clean, conflicting edits protect unload without overwriting disk',async()=>{
 const {w,$,attached}=setup();try{
  await $('sample').onclick();const external=JSON.parse(w.localStorage.getItem(key));external.documents[0].notes['demo-1']='Other tab';const disk=JSON.stringify(external);w.localStorage.setItem(key,disk);
  $('library').querySelector('button').click();assert.equal(attached.size,0);assert.equal(unload(w),false);
  note(w,'This tab unsaved');assert.equal(attached.size,1);assert.equal(unload(w),true);assert.equal(w.localStorage.getItem(key),disk);assert.equal($('save-status').hidden,false);
 }finally{await w.happyDOM.close();}
});
for(const kind of ['edit','source','details'])test(`${kind} dialog guards changed values only and clears after cancel or save`,async()=>{
 const {w,$,attached}=setup();try{
  await $('sample').onclick();
  const open=()=>kind==='edit'?w.document.querySelector('.segment .edit-button').click():$(kind==='source'?'source':'document-details').click();
  const id={edit:'edit-segment',source:'source-url',details:'document-title'}[kind];
  open();assert.equal(attached.size,0);assert.equal(unload(w),false);
  const original=$(id).value;input(w,$(id),original+' changed');assert.equal(attached.size,1);assert.equal(unload(w),true);
  input(w,$(id),original);assert.equal(attached.size,0);
  input(w,$(id),'changed again');$(kind+'-dialog').close();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(unload(w),false);assert.equal(attached.size,0);
  open();input(w,$(id),kind==='source'?'https://www.youtube.com/watch?v=jNQXAC9IVRw':'Saved change');$('save-'+kind).click();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(attached.size,0);assert.equal(unload(w),false);
 }finally{await w.happyDOM.close();}
});
test('unreadable startup storage does not guard an empty page',async()=>{
 const {w,attached}=setup('{broken');try{assert.equal(attached.size,0);assert.equal(unload(w),false);}finally{await w.happyDOM.close();}
});

test('Electron preload capability keeps the Web unload guard absent for draft and failed persistence',async()=>{
 const {w,$,attached}=setup(undefined,true);try{
  await $('sample').onclick();w.document.querySelector('.segment .edit-button').click();input(w,$('edit-segment'),'Uncommitted native draft');
  assert.equal(attached.size,0);assert.equal(unload(w),false);$('edit-dialog').close();
  const backing=w.localStorage;Object.defineProperty(w,'localStorage',{value:{getItem:k=>backing.getItem(k),setItem(){throw new Error('quota');}}});
  note(w,'Native unsaved note');assert.equal($('save-status').hidden,false);assert.equal(attached.size,0);assert.equal(unload(w),false);
 }finally{await w.happyDOM.close();}
});

async function annotationFixture(w,$){
 await $('sample').onclick();
 w.draftTest.fixture();
}
test('Web protects glossary drafts, including drafts on another document, and clears a reverted draft',async()=>{
 const {w,$,attached}=setup();try{
  await annotationFixture(w,$);input(w,$('translation-glossary'),'Coconut = 椰子');assert.equal(unload(w),true);
  w.draftTest.switchDoc(true);assert.equal($('translation-glossary').value,'');assert.equal(unload(w),true);
  w.draftTest.switchDoc(false);assert.equal($('translation-glossary').value,'Coconut = 椰子');
  input(w,$('translation-glossary'),'');assert.equal(unload(w),false);assert.equal(attached.size,0);
 }finally{await w.happyDOM.close();}
});
test('new timestamp drafts survive document switching and protect Web unload',async()=>{
 const {w,$}=setup();try{
  await annotationFixture(w,$);input(w,$('audio-bookmark-time'),'1:02');input(w,$('audio-bookmark-note'),'An unfinished thought');assert.equal(unload(w),true);
  w.draftTest.switchDoc(true);assert.equal($('audio-bookmark-time').value,'');assert.equal(unload(w),true);
  w.draftTest.switchDoc(false);assert.equal($('audio-bookmark-time').value,'1:02');assert.equal($('audio-bookmark-note').value,'An unfinished thought');
  $('audio-bookmark-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(unload(w),false);
 }finally{await w.happyDOM.close();}
});
test('timestamp corrections survive search rerenders and navigation, while untouched edits and search stay clean',async()=>{
 const {w,$}=setup();try{
  await annotationFixture(w,$);$('audio-bookmarks').querySelector('.edit-bookmark-time').click();assert.equal(unload(w),false);
  input(w,$('audio-bookmarks').querySelector('form input'),'30');assert.equal(unload(w),true);
  input(w,$('audio-bookmark-search'),'Other');assert.equal(unload(w),true);
  input(w,$('audio-bookmark-search'),'');let form=$('audio-bookmarks').querySelector('form');assert.equal(form.hidden,false);assert.equal(form.querySelector('input').value,'30');
  w.draftTest.switchDoc(true);w.draftTest.switchDoc(false);form=$('audio-bookmarks').querySelector('form');assert.equal(form.querySelector('input').value,'30');
  form.querySelector('[type="button"]').click();assert.equal(unload(w),false);input(w,$('audio-bookmark-search'),'Other');assert.equal(unload(w),false);
 }finally{await w.happyDOM.close();}
});

for(const desktop of [false,true])test(`${desktop?'Desktop':'Web'} shares draft save, cancel, invalid edit, and autosave rules`,async()=>{
 const {w,$,attached}=setup(undefined,desktop);const dirty=()=>desktop?!w.coconutPrepareClose('inspect').safe:unload(w);
 try{
  await annotationFixture(w,$);assert.equal(dirty(),false);
  input(w,$('translation-glossary'),'Word = 词');assert.equal(dirty(),true);$('cancel-translation-glossary').click();assert.equal(dirty(),false);
  input(w,$('translation-glossary'),'Word = 词');$('save-translation-glossary').click();assert.equal(dirty(),false);
  input(w,$('translation-glossary'),'Bad line');$('save-translation-glossary').click();assert.equal(dirty(),true);$('cancel-translation-glossary').click();assert.equal(dirty(),false);
  input(w,$('audio-bookmark-note'),'Draft without time');assert.equal(dirty(),true);$('cancel-audio-bookmark').click();assert.equal(dirty(),false);
  $('audio-bookmarks').querySelector('.edit-bookmark-time').click();let form=$('audio-bookmarks').querySelector('form');input(w,form.querySelector('input'),'bad');assert.equal(dirty(),true);
  form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(dirty(),true);
  $('audio-bookmarks').querySelector('.edit-bookmark-time').click();assert.equal(form.querySelector('input').value,'bad');
  input(w,form.querySelector('input'),'0:10');assert.equal(dirty(),false);
  input(w,form.querySelector('input'),'30');form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(dirty(),false);
  input(w,$('project-note'),'Saved project note');input(w,$('audio-bookmarks').querySelector('textarea'),'Saved bookmark note');assert.equal(dirty(),false);
  input(w,$('audio-bookmark-search'),'Saved');assert.equal(dirty(),false);
  input(w,$('ai-question'),'Unsubmitted question');assert.equal(dirty(),true);input(w,$('ai-question'),'');assert.equal(dirty(),false);
  if(desktop)assert.equal(attached.size,0);
 }finally{await w.happyDOM.close();}
});
for(const desktop of [false,true])test(`${desktop?'Desktop':'Web'} keeps concurrent document and filtered correction drafts until each is resolved`,async()=>{
 const {w,$}=setup(undefined,desktop);const dirty=()=>desktop?!w.coconutPrepareClose('inspect').safe:unload(w);
 try{
  await annotationFixture(w,$);input(w,$('audio-bookmark-time'),'7');$('audio-bookmarks').querySelector('.edit-bookmark-time').click();input(w,$('audio-bookmarks').querySelector('form input'),'35');
  input(w,$('audio-bookmark-search'),'Other');assert.equal(dirty(),true);
  w.draftTest.switchDoc(true);input(w,$('audio-bookmark-note'),'Second document draft');$('cancel-audio-bookmark').click();assert.equal(dirty(),true);
  input(w,$('translation-glossary'),'Term = 术语');w.draftTest.switchDoc(false);assert.equal($('audio-bookmark-time').value,'7');
  $('cancel-audio-bookmark').click();assert.equal(dirty(),true);
  let form=$('audio-bookmarks').querySelector('form');assert.equal(form.querySelector('input').value,'35');form.querySelector('[type="button"]').click();assert.equal(dirty(),true);
  w.draftTest.switchDoc(true);$('cancel-translation-glossary').click();assert.equal(dirty(),false);
 }finally{await w.happyDOM.close();}
});
for(const desktop of [false,true])test(`${desktop?'Desktop':'Web'} drafts survive a plain transcript detour and failed saves remain dirty`,async()=>{
 const {w,$}=setup(undefined,desktop);const dirty=()=>desktop?!w.coconutPrepareClose('inspect').safe:unload(w);
 try{
  await annotationFixture(w,$);input(w,$('audio-bookmark-time'),'9');$('audio-bookmarks').querySelector('.edit-bookmark-time').click();input(w,$('audio-bookmarks').querySelector('form input'),'44');
  w.draftTest.plain();assert.equal($('audio-project').hidden,true);assert.equal(dirty(),true);w.draftTest.switchDoc(false);
  assert.equal($('audio-bookmark-time').value,'9');assert.equal($('audio-bookmarks').querySelector('form input').value,'44');
  const backing=w.localStorage;let blocked=true;Object.defineProperty(w,'localStorage',{value:{getItem:k=>backing.getItem(k),setItem(k,v){if(blocked)throw Error('quota');backing.setItem(k,v);}}});
  $('audio-bookmark-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  const form=$('audio-bookmarks').querySelector('[data-bookmark-id="first"] form');form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  assert.equal($('audio-bookmark-time').value,'');assert.equal(dirty(),true);assert.equal($('save-status').hidden,false);
  blocked=false;input(w,$('project-note'),'Saved after retry');assert.equal(dirty(),false);assert.equal($('save-status').hidden,true);
 }finally{await w.happyDOM.close();}
});

function removeFixture(w,$,key){
 const row=[...$('library').children].find(node=>node.dataset.documentKey===key);assert.ok(row);
 row.querySelector('.library-remove').click();$('confirm-removal').click();
}
for(const desktop of [false,true])test(`${desktop?'Desktop':'Web'} active removal and undo restore bookmark drafts with new callback ownership`,async()=>{
 const {w,$}=setup(undefined,desktop);const dirty=()=>desktop?!w.coconutPrepareClose('inspect').safe:unload(w);
 try{
  await annotationFixture(w,$);const key=w.sessionStorage.getItem('coconut-reader-active-v1');
  input(w,$('translation-glossary'),'Restored = 恢复');input(w,$('audio-bookmark-time'),'8');input(w,$('audio-bookmark-note'),'Keep my unfinished bookmark');
  const row=$('audio-bookmarks').querySelector('[data-bookmark-id="first"]');row.querySelector('.edit-bookmark-time').click();const oldForm=row.querySelector('form');input(w,oldForm.querySelector('input'),'41');
  removeFixture(w,$,key);assert.equal($('removal-recovery').hidden,false);assert.equal(dirty(),true);
  $('undo-removal').click();assert.equal($('audio-bookmark-time').value,'8');assert.equal($('audio-bookmark-note').value,'Keep my unfinished bookmark');assert.equal($('audio-bookmarks').querySelector('[data-bookmark-id="first"] form input').value,'41');
  const disk=w.localStorage.getItem('coconut-reader-v1');row.querySelector('textarea').value='Late stale note';row.querySelector('textarea').oninput();oldForm.onsubmit({preventDefault(){}});row.querySelectorAll('button')[1].onclick();
  assert.equal(w.localStorage.getItem('coconut-reader-v1'),disk);assert.equal($('audio-bookmark-time').value,'8');assert.equal($('audio-bookmarks').querySelector('[data-bookmark-id="first"] form input').value,'41');
  assert.equal($('translation-glossary').value,'Restored = 恢复');$('cancel-translation-glossary').click();
  $('cancel-audio-bookmark').click();$('audio-bookmarks').querySelector('[data-bookmark-id="first"] form [type="button"]').click();assert.equal(dirty(),false);
 }finally{await w.happyDOM.close();}
});
for(const desktop of [false,true])test(`${desktop?'Desktop':'Web'} noncurrent remove and undo preserve the current document drafts`,async()=>{
 const {w,$}=setup(undefined,desktop);const dirty=()=>desktop?!w.coconutPrepareClose('inspect').safe:unload(w);
 try{
  await annotationFixture(w,$);const key=w.sessionStorage.getItem('coconut-reader-active-v1');
  input(w,$('audio-bookmark-time'),'11');w.draftTest.switchDoc(true);input(w,$('audio-bookmark-note'),'Current unfinished note');input(w,$('translation-glossary'),'Current = 当前');
  removeFixture(w,$,key);assert.equal($('audio-bookmark-note').value,'Current unfinished note');assert.equal($('translation-glossary').value,'Current = 当前');
  $('undo-removal').click();assert.equal(w.sessionStorage.getItem('coconut-reader-active-v1'),'other');assert.equal($('audio-bookmark-note').value,'Current unfinished note');assert.equal($('translation-glossary').value,'Current = 当前');
  $('cancel-audio-bookmark').click();$('cancel-translation-glossary').click();assert.equal(dirty(),true);
  w.draftTest.switchDoc(false);assert.equal($('audio-bookmark-time').value,'11');$('cancel-audio-bookmark').click();assert.equal(dirty(),false);
 }finally{await w.happyDOM.close();}
});
test('failed noncurrent removal retains hidden drafts and ending successful removal cannot resurrect them',async()=>{
 const {w,$}=setup();try{
  await annotationFixture(w,$);const key=w.sessionStorage.getItem('coconut-reader-active-v1');
  input(w,$('audio-bookmark-time'),'19');w.draftTest.switchDoc(true);
  const backing=w.localStorage;let blocked=true;Object.defineProperty(w,'localStorage',{value:{getItem:k=>backing.getItem(k),setItem(k,v){if(blocked)throw Error('quota');backing.setItem(k,v);}}});
  removeFixture(w,$,key);assert.equal($('remove-document-dialog').open,true);$('cancel-removal').click();w.draftTest.switchDoc(false);assert.equal($('audio-bookmark-time').value,'19');
  blocked=false;input(w,$('project-note'),'Saved retry');removeFixture(w,$,key);$('finish-removal').click();$('confirm-finish-removal').click();assert.equal(unload(w),false);
 }finally{await w.happyDOM.close();}
});
test('failed undo retains its recovery drafts and leaves another document draft alone until retry',async()=>{
 const {w,$}=setup();try{
  await annotationFixture(w,$);const key=w.sessionStorage.getItem('coconut-reader-active-v1');
  input(w,$('audio-bookmark-time'),'12');input(w,$('translation-glossary'),'Recovered = 恢复');w.draftTest.switchDoc(true);input(w,$('audio-bookmark-note'),'Still editing the other document');
  removeFixture(w,$,key);
  const backing=w.localStorage;let blocked=true;Object.defineProperty(w,'localStorage',{value:{getItem:k=>backing.getItem(k),setItem(k,v){if(blocked)throw Error('quota');backing.setItem(k,v);}}});
  $('undo-removal').click();assert.equal($('removal-recovery').hidden,false);assert.equal($('audio-bookmark-note').value,'Still editing the other document');
  blocked=false;$('undo-removal').click();assert.equal($('removal-recovery').hidden,true);assert.equal($('audio-bookmark-note').value,'Still editing the other document');
  w.draftTest.switchDoc(false);assert.equal($('audio-bookmark-time').value,'12');assert.equal($('translation-glossary').value,'Recovered = 恢复');
 }finally{await w.happyDOM.close();}
});
