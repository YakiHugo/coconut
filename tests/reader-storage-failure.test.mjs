import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url);
function setup(stored, beforeLoad=null){
  const window=new Window({url:'https://coconut.example/'});
  window.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
  Object.defineProperty(window,'crypto',{value:webcrypto});
  if(stored!==undefined)window.localStorage.setItem('coconut-reader-v1',stored);
  beforeLoad?.(window);
  window.eval(fs.readFileSync(new URL('reader/summary.js',root),'utf8'));
  window.eval(fs.readFileSync(new URL('reader/core.js',root),'utf8'));
  window.eval(fs.readFileSync(new URL('reader/app.js',root),'utf8') + '\n' + fs.readFileSync(new URL('reader/language.js',root),'utf8') + '\n' + fs.readFileSync(new URL('reader/podcasts.js',root),'utf8'));
  return window;
}
async function importDocument(w, document) {
  const input=w.document.getElementById('file');
  const text=JSON.stringify(document);
  Object.defineProperty(input,'files',{configurable:true,value:[{name:'backup.json',size:text.length,text:async()=>text}]});
  await input.onchange();
}

const key='coconut-reader-v1';
function blockStorage(w, mode='quota'){
 const backing=w.localStorage;let blocked=true,attempts=0;
 Object.defineProperty(w,'localStorage',{configurable:true,value:{
  getItem(name){if(blocked&&mode==='security')throw new w.DOMException('Storage access denied','SecurityError');return backing.getItem(name);},
  setItem(name,value){attempts++;if(blocked)throw new w.DOMException('Storage write denied',mode==='quota'?'QuotaExceededError':'SecurityError');backing.setItem(name,value);}
 }});
 return {backing,unblock(){blocked=false;},get attempts(){return attempts;}};
}
async function exportActive(w){
 let blob;w.URL.createObjectURL=value=>{blob=value;return 'blob:storage-test';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};
 w.document.getElementById('export').onclick();return JSON.parse(await blob.text());
}
for(const mode of ['quota','security'])for(const operation of ['note','edit','import'])test(`${mode} failure during ${operation} preserves disk data and exports current-page changes`,async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();
  const before=w.localStorage.getItem(key),storage=blockStorage(w,mode);
  if(operation==='note'){
   w.document.querySelector('.segment .note-button').click();$('note').value='Unsaved personal note';$('note').oninput();
  }else if(operation==='edit'){
   w.document.querySelector('.segment .edit-button').click();$('edit-segment').value='Unsaved corrected transcript';$('save-edit').click();
  }else await importDocument(w,{title:'Unsaved import',segments:[{id:'new',text:'New local transcript',start:0,end:2}]});
  assert.equal(storage.backing.getItem(key),before);
  assert.equal($('save-status').hidden,false);assert.match($('save-status').textContent,/尚未保存|暂停/);
  assert.match($('notice').textContent,/保存空间不足或被禁用|暂停保存/);
  const backup=await exportActive(w);
  assert.equal($('save-status').hidden,false,'download initiation must not clear the persistence warning');
  if(operation==='note')assert.equal(backup.notes['demo-1'],'Unsaved personal note');
  if(operation==='edit'){assert.equal(backup.segments[0].text,'Unsaved corrected transcript');assert.ok(backup.segments[0].original_text);}
  if(operation==='import')assert.equal(backup.title,'Unsaved import');
  // A later successful user change persists the pending in-page work as well.
  storage.unblock();$('document-details').click();$('document-title').value=backup.title+' recovered';$('save-details').click();
  assert.equal($('save-status').hidden,true);
  const saved=JSON.parse(storage.backing.getItem(key)).documents.find(d=>d.title===backup.title+' recovered');
  assert.ok(saved);assert.deepEqual(saved.notes,backup.notes);assert.deepEqual(saved.segments,backup.segments);
 }finally{await w.happyDOM.close();}
});
test('storage unavailable on startup preserves inaccessible data and keeps imports explicitly temporary',async()=>{
 const original=JSON.stringify({active:'old',documents:[{key:'old',title:'Original saved content',segments:[{id:'old',text:'Do not overwrite',start:0,end:1}]}]});let storage;
 const w=setup(original,window=>{storage=blockStorage(window,'security');});try{
  const $=id=>w.document.getElementById(id);assert.equal($('save-status').hidden,false);
  await importDocument(w,{title:'Temporary content',segments:[{id:'tmp',text:'Export before closing',start:0,end:1}]});
  assert.equal(storage.backing.getItem(key),original);assert.equal(storage.attempts,0);
  assert.equal($('save-status').hidden,false);assert.match($('notice').textContent,/自动保存已暂停/);
  storage.unblock();await $('sample').onclick();assert.equal(storage.backing.getItem(key),original);assert.equal(storage.attempts,0,'restored access cannot silently overwrite previously unread data');
 }finally{await w.happyDOM.close();}
});
