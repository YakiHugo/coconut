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
 if(desktop)Object.defineProperty(w,'coconutUpdates',{value:Object.freeze({state:async()=>({})})});
 if(stored!==undefined)w.localStorage.setItem(key,stored);
 const attached=new Set(),add=w.addEventListener.bind(w),remove=w.removeEventListener.bind(w);
 w.addEventListener=(type,fn,...args)=>{if(type==='beforeunload')attached.add(fn);return add(type,fn,...args);};
 w.removeEventListener=(type,fn,...args)=>{if(type==='beforeunload')attached.delete(fn);return remove(type,fn,...args);};
 for(const file of ['summary','core','passages','passage-playback'])w.eval(fs.readFileSync(new URL(`reader/${file}.js`,root),'utf8'));
 w.eval(['app','language','podcasts'].map(file=>fs.readFileSync(new URL(`reader/${file}.js`,root),'utf8')).join('\n'));
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
