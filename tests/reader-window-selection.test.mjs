/** Deterministic DOM/storage integration. Native two-page/reload/download proof runs only in browser CI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';

const root=new URL('../',import.meta.url),KEY='coconut-reader-v1',ACTIVE='coconut-reader-active-v1',LAST_ACTIVE='coconut-reader-last-active-v1';
const source=key=>({key,title:'Authored '+key,language:'en',notes:{cue:'Saved '+key},readingPosition:'cue',segments:[{id:'cue',start:0,end:4,text:'Original authored source '+key}]});
function storage(entries=[]){
 const values=new Map(entries),writes=[];
 return {values,writes,getItem:key=>values.get(key)??null,setItem(key,value){writes.push([key,String(value)]);values.set(key,String(value));},removeItem:key=>values.delete(key)};
}
function library(active='a'){return JSON.stringify({documents:['a','b','c'].map(source),active});}
function setup({disk=storage([[KEY,library()]]),session=storage(),sessionFailure=null}={}){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});
 Object.defineProperty(w,'localStorage',{configurable:true,value:disk});
 Object.defineProperty(w,'sessionStorage',{configurable:true,get(){
  if(sessionFailure==='access')throw new w.DOMException('Session storage denied','SecurityError');
  return sessionFailure==='write'?{getItem:session.getItem,setItem(){throw new w.DOMException('Session quota','QuotaExceededError');},removeItem(){throw new w.DOMException('Session quota','QuotaExceededError');}}:session;
 }});
 w.fetch=()=>{throw new Error('Reading selection must not send a request');};
 w.eval(['summary','core','passages','passage-playback','app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
 w.eval(`window.selectionProbe={serializedDocuments:0};
 const originalStringify=JSON.stringify;
 JSON.stringify=function(value,...args){
  if(value?.documents||value?.segments&&typeof value.key==='string'||Array.isArray(value)&&value.some(item=>item?.segments&&typeof item.key==='string'))selectionProbe.serializedDocuments++;
  return originalStringify.call(this,value,...args);
 };`);
 const $=id=>w.document.getElementById(id);
 const open=key=>{
  const writes=disk.writes.filter(([key])=>key===KEY).length,serializations=w.selectionProbe.serializedDocuments,before=disk.getItem(KEY);
  [...$('library').querySelectorAll('.library-open')].find(button=>button.querySelector('.library-title').textContent==='Authored '+key).click();
  assert.equal(w.selectionProbe.serializedDocuments,serializations,'each navigation must not stringify documents, their array, or the whole library');
  assert.equal(disk.writes.filter(([key])=>key===KEY).length,writes,'each navigation must not write the shared content library');assert.equal(disk.getItem(KEY),before);
  assert.equal($('title').textContent,'Authored '+key);
 };
 const note=text=>{w.goToSegment('cue');w.document.querySelector('.note-button').click();$('note').value=text;$('note').dispatchEvent(new w.Event('input'));$('close-note').click();};
 const choose=async(id,data)=>{const text=JSON.stringify(data);Object.defineProperty($(id),'files',{configurable:true,value:[{name:'authored.json',size:Buffer.byteLength(text),text:async()=>text}]});await $(id).onchange();};
 const exported=async id=>{let blob;w.URL.createObjectURL=value=>{blob=value;return 'blob:authored-selection';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};$(id).click();return JSON.parse(await blob.text());};
 const unloadBlocked=()=>{const event=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(event);return event.defaultPrevented;};
 return {w,$,disk,session,open,note,choose,exported,unloadBlocked};
}

test('separate windows navigate without serializing or writing the library, then save real notes normally',async()=>{
 const disk=storage([[KEY,library()]]),a=setup({disk}),b=setup({disk});let reloadedA,reloadedB;
 try{
  assert.equal(a.$('title').textContent,'Authored a');assert.equal(b.$('title').textContent,'Authored a');
  for(const key of ['b','c','a','b'])a.open(key);
  assert.equal(a.session.getItem(ACTIVE),'b');assert.equal(b.session.getItem(ACTIVE),'a');assert.equal(disk.writes.filter(([key])=>key===KEY).length,0);
  b.note('Saved by B after A only navigated');
  assert.equal(b.$('save-status').hidden,true);assert.equal(b.unloadBlocked(),false);
  const saved=JSON.parse(disk.getItem(KEY));assert.equal(Object.hasOwn(saved,'active'),false);assert.equal(saved.documents.length,3);
  assert.equal(saved.documents.find(doc=>doc.key==='a').notes.cue,'Saved by B after A only navigated');
  assert.equal(saved.documents.find(doc=>doc.key==='b').notes.cue,'Saved b');
  reloadedA=setup({disk,session:a.session});reloadedB=setup({disk,session:b.session});
  assert.equal(reloadedA.$('title').textContent,'Authored b');assert.equal(reloadedB.$('title').textContent,'Authored a');
  assert.equal(reloadedB.w.active().notes.cue,'Saved by B after A only navigated');
 }finally{for(const env of [a,b,reloadedA,reloadedB])await env?.w.happyDOM.close();}
});

test('real remote content changes still block stale saves and navigation never clears unsaved protection',async()=>{
 const disk=storage([[KEY,library()]]),a=setup({disk}),b=setup({disk});
 try{
  b.note('Newer remote note');const latest=disk.getItem(KEY);
  a.open('b');assert.equal(a.$('save-status').hidden,true,'navigation is not a failed content save');
  a.note('Unsaved local note');assert.equal(disk.getItem(KEY),latest);assert.match(a.$('save-status').textContent,/另一个页面/);assert.equal(a.unloadBlocked(),true);
  const warning=a.$('save-status').textContent;
  a.open('c');a.open('b');assert.equal(a.$('save-status').textContent,warning);assert.equal(a.unloadBlocked(),true);
  const backup=await a.exported('export-library');assert.equal(backup.active,'b');assert.equal(backup.documents.length,3);
  assert.equal(backup.documents.find(doc=>doc.key==='b').notes.cue,'Unsaved local note');assert.equal(disk.getItem(KEY),latest);assert.equal(a.unloadBlocked(),true,'download initiation does not prove a save');
  a.note('A later local note remains protected');assert.equal(disk.getItem(KEY),latest);assert.equal(a.unloadBlocked(),true);
 }finally{await a.w.happyDOM.close();await b.w.happyDOM.close();}
});

for(const [selection,legacy,expected] of [['b','c','b'],['missing','c','c'],[null,'c','c'],['missing','missing','a'],[null,undefined,'a']])test(`startup chooses valid window selection, then legacy fallback, then first document (${selection}/${legacy})`,async()=>{
 const disk=storage([[KEY,JSON.stringify({documents:['a','b','c'].map(source),...(legacy===undefined?{}:{active:legacy})})]]),session=storage(selection===null?[]:[[ACTIVE,selection]]),env=setup({disk,session});
 try{assert.equal(env.$('title').textContent,'Authored '+expected);assert.equal(session.getItem(ACTIVE),expected);assert.equal(disk.writes.filter(([key])=>key===KEY).length,0);assert.equal(env.unloadBlocked(),false);}
 finally{await env.w.happyDOM.close();}
});

test('new windows and native relaunch use the last-open hint without redirecting existing windows',async()=>{
 const disk=storage([[KEY,library('a')]]),a=setup({disk});let b,reloadedA,newWindow;
 try{
  a.open('b');assert.equal(disk.getItem(LAST_ACTIVE),'b');
  b=setup({disk});assert.equal(b.$('title').textContent,'Authored b');
  b.open('c');assert.equal(disk.getItem(LAST_ACTIVE),'c');assert.equal(a.$('title').textContent,'Authored b');
  newWindow=setup({disk});assert.equal(newWindow.$('title').textContent,'Authored c');
  reloadedA=setup({disk,session:a.session});assert.equal(reloadedA.$('title').textContent,'Authored b','the window session takes priority over the shared hint');
  assert.equal(disk.writes.filter(([key])=>key===KEY).length,0);
 }finally{for(const env of [a,b,reloadedA,newWindow])await env?.w.happyDOM.close();}
});

test('invalid last-open hint falls through to the valid legacy selection without rewriting content',async()=>{
 const disk=storage([[KEY,library('c')],[LAST_ACTIVE,'removed']]),env=setup({disk});
 try{assert.equal(env.$('title').textContent,'Authored c');assert.equal(disk.writes.filter(([key])=>key===KEY).length,0);}
 finally{await env.w.happyDOM.close();}
});

test('a denied last-open preference write does not block reading or durable notes',async()=>{
 const disk=storage([[KEY,library()]]),write=disk.setItem;disk.setItem=(key,value)=>{if(key===LAST_ACTIVE)throw new Error('Preference denied');write(key,value);};const env=setup({disk});
 try{env.open('b');env.note('Saved despite preference denial');assert.equal(env.$('save-status').hidden,true);assert.equal(env.unloadBlocked(),false);assert.equal(JSON.parse(disk.getItem(KEY)).documents.find(doc=>doc.key==='b').notes.cue,'Saved despite preference denial');}
 finally{await env.w.happyDOM.close();}
});

test('a disappeared selection falls back safely and an empty library does not manufacture documents',async()=>{
 const disk=storage([[KEY,JSON.stringify({documents:[source('a')]})]]),session=storage([[ACTIVE,'b']]),env=setup({disk,session});let empty;
 try{
  assert.equal(env.$('title').textContent,'Authored a');assert.equal(session.getItem(ACTIVE),'a');
  disk.values.set(KEY,JSON.stringify({documents:[]}));empty=setup({disk,session});
  assert.equal(empty.w.document.body.dataset.workspace,'add');assert.equal(session.getItem(ACTIVE),null);assert.equal(disk.writes.filter(([key])=>key===KEY).length,0);
 }finally{await env.w.happyDOM.close();await empty?.w.happyDOM.close();}
});

for(const sessionFailure of ['access','write'])test(`unavailable session storage (${sessionFailure}) leaves reading and content saving usable`,async()=>{
 const env=setup({sessionFailure});
 try{
  env.open('b');env.note('Still saves body without session storage');assert.equal(env.$('save-status').hidden,true);assert.equal(env.unloadBlocked(),false);
  assert.equal(JSON.parse(env.disk.getItem(KEY)).documents.find(doc=>doc.key==='b').notes.cue,'Still saves body without session storage');
  const backup=await env.exported('export-library');assert.equal(backup.active,'b','export uses in-memory selection even when session storage is unavailable');
 }finally{await env.w.happyDOM.close();}
});

test('explicit imports and backup restore select their intended version, export it, and survive a same-window reload',async()=>{
 const env=setup();let refreshed;
 try{
  env.open('b');await env.choose('file',source('imported'));
  const imported=env.w.active().key;assert.equal(env.session.getItem(ACTIVE),imported);assert.equal(env.$('title').textContent,'Authored imported');
  const original=source('b');original.notes.cue='Different backup version';
  await env.choose('library-file',{format:'coconut-library',version:1,active:'b',documents:[original]});
  const restored=env.w.active().key;assert.equal(restored,'b-restored-1');assert.equal(env.session.getItem(ACTIVE),restored);
  const persisted=JSON.parse(env.disk.getItem(KEY));assert.equal(Object.hasOwn(persisted,'active'),false);assert.equal(persisted.documents.length,5);assert.equal(persisted.documents.find(doc=>doc.key==='b').notes.cue,'Saved b');
  const backup=await env.exported('export-library');assert.equal(backup.active,restored);assert.deepEqual(backup.documents,persisted.documents);
  env.open('a');await env.choose('library-file',backup);assert.equal(env.session.getItem(ACTIVE),restored);assert.equal(JSON.parse(env.disk.getItem(KEY)).documents.length,5);
  refreshed=setup({disk:env.disk,session:env.session});assert.equal(refreshed.w.active().key,restored);assert.equal(refreshed.w.active().notes.cue,'Different backup version');
 }finally{await env.w.happyDOM.close();await refreshed?.w.happyDOM.close();}
});

test('failed import save keeps current temporary selection without losing earlier unsaved changes on navigation',async()=>{
 const env=setup();
 try{
  const original=env.disk.getItem(KEY);env.disk.setItem=()=>{throw new env.w.DOMException('Full','QuotaExceededError');};
  env.note('Unsaved before importing');await env.choose('file',source('temporary'));
  assert.equal(env.$('title').textContent,'Authored temporary');assert.equal(env.unloadBlocked(),true);assert.equal(env.disk.getItem(KEY),original);
  env.open('b');assert.equal(env.unloadBlocked(),true);assert.equal(env.$('save-status').hidden,false);
  const backup=await env.exported('export-library');assert.equal(backup.documents.length,4);assert.equal(backup.documents.find(doc=>doc.key==='a').notes.cue,'Unsaved before importing');assert.equal(env.unloadBlocked(),true);
 }finally{await env.w.happyDOM.close();}
});

test('legacy active-only writes remain conservative conflicts rather than silently replacing unknown data',async()=>{
 const env=setup();
 try{
  const legacy=JSON.parse(env.disk.getItem(KEY));legacy.active='c';env.disk.values.set(KEY,JSON.stringify(legacy));const external=env.disk.getItem(KEY);
  env.open('b');assert.equal(env.$('save-status').hidden,true);env.note('Local edit after old-client navigation');
  assert.equal(env.disk.getItem(KEY),external);assert.match(env.$('save-status').textContent,/另一个页面/);assert.equal(env.unloadBlocked(),true);
 }finally{await env.w.happyDOM.close();}
});

test('cross-document search hits retain selection-only navigation without serializing or writing content',async()=>{
 const env=setup();
 try{
  env.$('library-scope').value='notes';env.$('library-search').value='Saved b';env.$('library-search').oninput();
  const before=env.disk.getItem(KEY),writes=env.disk.writes.filter(([key])=>key===KEY).length,count=env.w.selectionProbe.serializedDocuments;
  env.$('library').querySelector('.library-hit').click();
  assert.equal(env.$('title').textContent,'Authored b');assert.equal(env.session.getItem(ACTIVE),'b');
  assert.equal(env.$('note').value,'Saved b');assert.equal(env.$('notes-panel').hidden,false);
  assert.equal(env.disk.getItem(KEY),before);assert.equal(env.disk.writes.filter(([key])=>key===KEY).length,writes);assert.equal(env.w.selectionProbe.serializedDocuments,count);
 }finally{await env.w.happyDOM.close();}
});

function requestRemoval(env,key){env.$('library').querySelector(`.library-entry[data-document-key="${key}"] .library-remove`).click();env.$('confirm-removal').click();}

test('successful active removal and undo change preferences only after content persistence',async()=>{
 const disk=storage([[KEY,library('b')]]),session=storage(),env=setup({disk,session});
 try{
  const events=[],writeDisk=disk.setItem,writeSession=session.setItem;
  disk.setItem=(key,value)=>{events.push(key);writeDisk(key,value);};session.setItem=(key,value)=>{events.push(key);writeSession(key,value);};
  requestRemoval(env,'b');
  assert.deepEqual(events,[KEY,ACTIVE,LAST_ACTIVE]);assert.equal(session.getItem(ACTIVE),'c');assert.equal(disk.getItem(LAST_ACTIVE),'c');assert.equal(env.$('title').textContent,'Authored c');
  assert.equal(Object.hasOwn(JSON.parse(disk.getItem(KEY)),'active'),false);
  events.length=0;env.$('undo-removal').click();
  assert.deepEqual(events,[KEY,ACTIVE,LAST_ACTIVE]);assert.equal(session.getItem(ACTIVE),'b');assert.equal(disk.getItem(LAST_ACTIVE),'b');assert.equal(env.$('title').textContent,'Authored b');
 }finally{await env.w.happyDOM.close();}
});

test('failed removal and failed undo preserve the existing selection and last-open preferences',async()=>{
 const env=setup();
 try{
  env.open('b');const write=env.disk.setItem,original=env.disk.getItem(KEY);let blocked=true;
  env.disk.setItem=(key,value)=>{if(key===KEY&&blocked)throw new Error('Injected quota');write(key,value);};
  const sessionWrites=env.session.writes.length,preferenceWrites=env.disk.writes.filter(([key])=>key===LAST_ACTIVE).length;
  requestRemoval(env,'b');
  assert.equal(env.disk.getItem(KEY),original);assert.equal(env.w.active().key,'b');assert.equal(env.session.getItem(ACTIVE),'b');assert.equal(env.disk.getItem(LAST_ACTIVE),'b');
  assert.equal(env.session.writes.length,sessionWrites);assert.equal(env.disk.writes.filter(([key])=>key===LAST_ACTIVE).length,preferenceWrites);
  blocked=false;env.$('confirm-removal').click();assert.equal(env.w.active().key,'c');
  const removed=env.disk.getItem(KEY),sessionAfter=env.session.writes.length,preferenceAfter=env.disk.writes.filter(([key])=>key===LAST_ACTIVE).length;
  blocked=true;env.$('undo-removal').click();
  assert.equal(env.disk.getItem(KEY),removed);assert.equal(env.w.active().key,'c');assert.equal(env.session.getItem(ACTIVE),'c');assert.equal(env.disk.getItem(LAST_ACTIVE),'c');
  assert.equal(env.session.writes.length,sessionAfter);assert.equal(env.disk.writes.filter(([key])=>key===LAST_ACTIVE).length,preferenceAfter);assert.equal(env.$('removal-recovery').hidden,false);
  blocked=false;env.$('undo-removal').click();assert.equal(env.session.getItem(ACTIVE),'b');assert.equal(env.disk.getItem(LAST_ACTIVE),'b');
 }finally{await env.w.happyDOM.close();}
});

test('noncurrent removal and undo do not overwrite another window last-open hint or the current selection',async()=>{
 const env=setup();
 try{
  env.disk.values.set(LAST_ACTIVE,'c');const sessionWrites=env.session.writes.length,preferenceWrites=env.disk.writes.filter(([key])=>key===LAST_ACTIVE).length;
  requestRemoval(env,'b');env.$('undo-removal').click();
  assert.equal(env.w.active().key,'a');assert.equal(env.session.getItem(ACTIVE),'a');assert.equal(env.disk.getItem(LAST_ACTIVE),'c');
  assert.equal(env.session.writes.length,sessionWrites);assert.equal(env.disk.writes.filter(([key])=>key===LAST_ACTIVE).length,preferenceWrites);
 }finally{await env.w.happyDOM.close();}
});

test('removing the last document clears selection preferences only after saving and undo restores them',async()=>{
 const env=setup({disk:storage([[KEY,JSON.stringify({documents:[source('a')],active:'a'})]])});
 try{
  requestRemoval(env,'a');assert.equal(env.session.getItem(ACTIVE),null);assert.equal(env.disk.getItem(LAST_ACTIVE),null);assert.equal(JSON.parse(env.disk.getItem(KEY)).documents.length,0);
  env.$('undo-removal').click();assert.equal(env.session.getItem(ACTIVE),'a');assert.equal(env.disk.getItem(LAST_ACTIVE),'a');assert.equal(env.w.active().key,'a');
 }finally{await env.w.happyDOM.close();}
});
