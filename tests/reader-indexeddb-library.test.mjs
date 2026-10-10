import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';
import {Window} from 'happy-dom';
import {transactionDouble} from './helpers/indexeddb-transaction-double.mjs';
const require=createRequire(import.meta.url),provider=require('../reader/storage-provider.js'),legacyModule=require('../reader/library-store.js'),documentModule=require('../reader/indexeddb-document-adapter.js'),Coconut=require('../reader/core.js');
const root=new URL('../',import.meta.url),KEY=legacyModule.KEY,FENCE=legacyModule.FENCE_KEY;
const doc=key=>({schema_version:1,key,title:key,language:'en',segments:[{id:'one',start:0,end:4,text:'Authored source '+key}],notes:{},ai_answers:[]});
function memory(raw=JSON.stringify({documents:[doc('a'),doc('b')],active:'b'})){
 const values=new Map([[KEY,raw]]),writes=[];
 return {values,writes,getItem:key=>values.get(key)??null,setItem(key,value){writes.push({key,value});values.set(key,value);}};
}
async function fixture({raw,indexedDB=true,engine=transactionDouble(),storage=memory(raw)}={}){
 const result=await provider.initialize({indexedDB:indexedDB===true?engine.indexedDB:indexedDB,getStorage:()=>storage,validate:Coconut.validate,legacyModule,documentModule});
 return {engine,storage,result};
}
function storeFor(f){let documents=f.result.loaded.documents;const store=legacyModule.create({adapter:f.result.adapter,getDocuments:()=>documents,checkpoint:doc=>({answers:doc.ai_answers?.length||0}),delay:10000});return {store,get documents(){return documents;},set documents(value){documents=value;}};}

test('ready library migrates once without overwriting raw bytes and reload preserves order/selection hint',async()=>{
 const raw=' '+JSON.stringify({documents:[doc('z'),doc('a')],active:'z'})+'\n',f=await fixture({raw});
 assert.equal(f.result.ok,true);assert.equal(f.result.backend,'indexeddb');assert.equal(f.result.migrated,true);assert.equal(f.result.legacyRaw,raw);
 assert.deepEqual(f.result.loaded.documents.map(d=>d.key),['z','a']);assert.equal(f.result.loaded.active,'z');assert.equal(f.storage.getItem(KEY),raw);
 assert.deepEqual(f.storage.writes.map(w=>w.key),[FENCE]);
 const second=await fixture({engine:f.engine,storage:f.storage});assert.equal(second.result.migrated,false);assert.deepEqual(second.result.loaded.documents.map(d=>d.key),['z','a']);
});

test('unavailable or access-denied IndexedDB uses truthful small-quota legacy fallback only before a fence',async()=>{
 for(const denied of [false,true]){
  const engine=transactionDouble();if(denied)engine.control.openError='SecurityError';
  const f=await fixture({engine,indexedDB:denied?true:null});assert.equal(f.result.backend,'legacy');assert.equal(f.result.loaded.ok,true);
  const {store,documents}=storeFor(f);documents[0].notes.one='fallback';store.queueDocument('a',documents[0]);assert.equal((await store.flush()).ok,true);assert.match(f.storage.getItem(KEY),/fallback/);
 }
 const storage=memory();storage.setItem(FENCE,'owned migration');const f=await fixture({storage,indexedDB:null});assert.equal(f.result.ok,false);assert.equal(f.result.error.code,'fenced');
});

test('blocked/version/failed migration never silently fall through to legacy writes',async()=>{
 const blocked=transactionDouble();blocked.control.blocked=true;assert.equal((await fixture({engine:blocked})).result.error.code,'blocked');
 const broken=await fixture({raw:JSON.stringify({documents:[doc('a'),{...doc('a'),title:'duplicate'}]})});assert.equal(broken.result.ok,false);assert.equal(broken.result.error.code,'corruption');assert.ok(broken.storage.getItem(FENCE));
 const quota=transactionDouble();quota.control.failMutation=1;const f=await fixture({engine:quota});assert.equal(f.result.ok,false);assert.equal(f.result.error.code,'quota');assert.ok(f.storage.getItem(FENCE));assert.equal(f.storage.writes.some(w=>w.key===KEY),false);
});

test('ordinary edits capture, checkpoint and write only dirty documents; held completion keeps newer generation pending',async()=>{
 const f=await fixture(),s=storeFor(f),[a,b]=s.documents;f.engine.operations.length=0;
 a.notes.one='captured';a.ai_answers.push({answer:'first'});s.store.queueDocument('a',a);f.engine.control.holdNextWrite=true;
 const flushing=s.store.flush();await f.engine.tick();a.ai_answers.push({answer:'later'});s.store.queueDocument('a',a);
 assert.equal(s.store.status('a').status,'pending');assert.equal(f.engine.operations.some(op=>op.key==='b'),false);
 f.engine.control.held.shift().complete();const first=await flushing;assert.equal(first.ok,true);assert.deepEqual(first.results[0].checkpoints.map(c=>[c.key,c.checkpoint.answers]),[['a',1]]);
 assert.equal(s.store.status('a').status,'pending');assert.equal((await s.store.flush()).ok,true);
 assert.equal(f.engine.rows(provider.NAME).get('documents').get('a').payload.ai_answers.length,2);assert.equal(s.store.status('b').generation,0);
 assert.equal(f.storage.writes.some(write=>write.key===KEY),false);assert.equal(b.notes.one,undefined);
});

test('parallel windows independently commit distinct keys and never overwrite a newer same-key revision',async()=>{
 const f=await fixture(),second=await fixture({engine:f.engine,storage:f.storage}),a=storeFor(f),b=storeFor(second);
 a.documents[0].notes.one='new A';a.store.queueDocument('a',a.documents[0]);assert.equal((await a.store.flush()).ok,true);
 b.documents[1].notes.one='new B';b.store.queueDocument('b',b.documents[1]);assert.equal((await b.store.flush()).ok,true);
 b.documents[0].notes.one='stale A';b.store.queueDocument('a',b.documents[0]);const conflict=await b.store.flush();assert.equal(conflict.ok,false);assert.equal(b.store.status('a').error.code,'conflict');
 const rows=f.engine.rows(provider.NAME).get('documents');assert.equal(rows.get('a').payload.notes.one,'new A');assert.equal(rows.get('b').payload.notes.one,'new B');
 assert.equal(b.store.snapshotForExport().documents[0].notes.one,'stale A');assert.equal((await b.store.retry()).ok,false);
});

test('remove/undo advances tombstone identity, and a never-committed document can be removed safely',async()=>{
 const f=await fixture(),s=storeFor(f),a=s.documents[0];s.documents=s.documents.filter(d=>d!==a);s.store.queueDocument('a',a,'remove');assert.equal((await s.store.flush()).ok,true);
 const restored={...a,notes:{one:'undo'}};s.documents.unshift(restored);s.store.queueDocument('a',restored,'restore');assert.equal((await s.store.flush()).ok,true);
 const row=f.engine.rows(provider.NAME).get('documents').get('a');assert.equal(row.epoch,2);assert.equal(row.payload.notes.one,'undo');
 const fresh=doc('never');s.documents.push(fresh);s.store.queueDocument('never',fresh);f.engine.control.failMutation=1;assert.equal((await s.store.flush()).ok,false);
 s.documents.pop();s.store.queueDocument('never',fresh,'remove');assert.equal((await s.store.flush()).ok,true);assert.equal(f.engine.rows(provider.NAME).get('tombstones').get('never').revision,1);
});

test('large additive restore commits all documents atomically and quota failure permits full retry/rescue',async()=>{
 const f=await fixture(),s=storeFor(f),large=Array.from({length:6},(_,i)=>({...doc('large'+i),notes:{one:'x'.repeat(1024*1024)}}));s.documents.push(...large);
 s.store.queueDocuments(large.map(identity=>({key:identity.key,identity})));f.engine.control.failMutation=5;assert.equal((await s.store.flush()).ok,false);
 assert.equal(f.engine.rows(provider.NAME).get('documents').size,2);const rescue=s.store.snapshotForExport();assert.equal(rescue.documents.length,6);assert.equal(rescue.documents[5].notes.one.length,1024*1024);
 assert.equal((await s.store.retry()).ok,true);assert.equal(f.engine.rows(provider.NAME).get('documents').size,8);assert.equal(f.storage.writes.some(w=>w.key===KEY),false);
});

test('versionchange is visible even before another edit and cannot produce a false receipt',async()=>{
 const f=await fixture(),s=storeFor(f);let called=0;f.result.adapter.subscribe(()=>called++);f.engine.versionchange();assert.equal(called,1);assert.equal(f.result.adapter.status().error.code,'version');
 s.documents[0].notes.one='rescue';s.store.queueDocument('a',s.documents[0]);assert.equal((await s.store.flush()).ok,false);assert.equal(s.store.status('a').error.code,'version');assert.equal(s.store.snapshotForExport().documents[0].notes.one,'rescue');
});

async function ui(f){
 f??=await fixture();
 const w=new Window({url:'https://coconut.example/'});w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];Object.defineProperty(w,'crypto',{value:webcrypto});
 w.CoconutStorageBootstrap={phase:'ready',result:f.result};w.eval(fs.readFileSync(new URL('reader/library-store.js',root),'utf8'));
 w.eval(['summary','core','passages','passage-playback','app','language','translation-review','podcasts'].map(file=>fs.readFileSync(new URL('reader/'+file+'.js',root),'utf8')).join('\n')+'\nwindow.idbUI={get documents(){return state.documents;},get store(){return libraryStore;},get checkpoint(){return persistedAIAnswerCounts;}};');
 return {w,f,$:id=>w.document.getElementById(id)};
}
test('actual IndexedDB provider feeds the existing reader UI, pending receipt, failure and rescue',async()=>{
 const {w,f,$}=await ui();try{
  w.document.querySelector('.note-button').click();$('note').value='UI pending note';$('note').oninput();f.engine.control.holdNextWrite=true;const flushing=w.idbUI.store.flush();await f.engine.tick();assert.equal($('save-status').dataset.state,'pending');
  f.engine.control.held.shift().complete();assert.equal((await flushing).ok,true);assert.equal($('save-status').dataset.state,'saved');assert.equal(f.engine.rows(provider.NAME).get('documents').get('b').payload.notes.one,'UI pending note');
  f.engine.versionchange();assert.equal($('save-status').dataset.state,'failed');assert.match($('save-status').textContent,/版本已改变/);
  $('note').value='UI recovery after versionchange';$('note').oninput();assert.equal((await w.idbUI.store.flush()).ok,false);assert.equal($('export-unsaved-documents').hidden,false);
  let blob;w.URL.createObjectURL=value=>{blob=value;return 'blob:authored';};w.HTMLAnchorElement.prototype.click=function(){};$('export-unsaved-documents').click();assert.equal(JSON.parse(await blob.text()).documents[0].notes.one,'UI recovery after versionchange');
 }finally{await w.happyDOM.close();}
});

test('JSON and notebook exports cannot substitute for a committed note/bookmark receipt before reload',async()=>{
 const first=await ui(),{w,f,$}=first;let interrupted,reloaded;
 try{
  w.document.querySelector('.note-button').click();$('note').value='Authored pending reload note';$('note').oninput();$('close-note').click();
  w.document.querySelector('.bookmark-button').click();
  f.engine.control.holdNextWrite=true;const saving=w.idbUI.store.flush();await f.engine.tick();
  let blob;w.URL.createObjectURL=value=>{blob=value;return 'blob:authored';};w.HTMLAnchorElement.prototype.click=function(){};
  $('export').click();const exported=JSON.parse(await blob.text());
  $('export-notebook').click();const notebook=await blob.text();
  assert.equal(exported.readingPosition,'one');assert.equal(exported.notes.one,'Authored pending reload note');assert.match(notebook,/Authored pending reload note/);
  assert.equal($('save-status').dataset.state,'pending');
  const unload=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true);
  // Reproduce the storage state if navigation terminates this uncommitted
  // transaction. Exports succeeded, but the next reader still has no bookmark.
  f.engine.control.held.shift().abort();assert.equal((await saving).ok,false);
  interrupted=await ui(await fixture({engine:f.engine,storage:f.storage}));
  assert.equal(interrupted.$('resume').hidden,true);assert.equal(interrupted.w.idbUI.documents.find(doc=>doc.key==='b').notes.one,undefined);
  // The required save receipt, followed by an independent provider reload,
  // proves both the note and reading position actually survive navigation.
  assert.equal((await w.idbUI.store.retry()).ok,true);assert.equal($('save-status').dataset.state,'saved');
  reloaded=await ui(await fixture({engine:f.engine,storage:f.storage}));
  assert.equal(reloaded.$('resume').hidden,false);reloaded.$('resume').click();reloaded.w.document.querySelector('.note-button').click();
  assert.equal(reloaded.$('note').value,exported.notes.one);assert.equal(reloaded.w.idbUI.documents.find(doc=>doc.key==='b').readingPosition,exported.readingPosition);
 }finally{await w.happyDOM.close();await interrupted?.w.happyDOM.close();await reloaded?.w.happyDOM.close();}
});

test('an access-denied IndexedDB property getter can use unfenced legacy fallback',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'indexedDB'),storage=memory();
 Object.defineProperty(globalThis,'indexedDB',{configurable:true,get(){throw new DOMException('Denied getter','SecurityError');}});
 try{const result=await provider.initialize({getStorage:()=>storage,validate:Coconut.validate,legacyModule,documentModule});assert.equal(result.ok,true);assert.equal(result.backend,'legacy');assert.equal(result.loaded.documents.length,2);assert.equal(storage.getItem(FENCE),null);}
 finally{if(original)Object.defineProperty(globalThis,'indexedDB',original);else delete globalThis.indexedDB;}
});
