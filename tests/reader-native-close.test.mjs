import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url),key='coconut-reader-v1';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await turn();}assert.fail('Missing expected native lifecycle boundary');}
function setup(){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{configurable:true,value:webcrypto});
 w.coconutUpdates={state:async()=>({status:'idle',version:'test',arch:'arm64'}),subscribe:()=>{}};
 for(const file of ['summary','core','passages','passage-playback','library-store'])w.eval(fs.readFileSync(new URL(`reader/${file}.js`,root),'utf8'));
 const writes={held:false,pending:[],count:0};
 const createAdapter=w.CoconutLibraryStore.createLegacyAdapter;
 w.CoconutLibraryStore.createLegacyAdapter=options=>{
  const adapter=createAdapter(options);
  return {...adapter,write(value,context){writes.count++;if(!writes.held)return adapter.write(value,context);
   return new Promise(resolve=>writes.pending.push({value,signal:context.signal,settle:()=>resolve(adapter.write(value,context)),fail:()=>resolve({ok:false,status:'failed',error:{code:'quota'}})}));
  }};
 };
 w.eval(['app','language','podcasts'].map(file=>fs.readFileSync(new URL(`reader/${file}.js`,root),'utf8')).join('\n')+'\nlet sourceSubmitting=false,sourceCaptionRequest=null;\n'+fs.readFileSync(new URL('reader/updates.js',root),'utf8')+'\nlet closeTestFlushes=0,closeTestScope;const originalCloseTestFlush=flushListening;flushListening=(...args)=>{closeTestFlushes++;return originalCloseTestFlush(...args);};\nwindow.closeTest={flushes:()=>closeTestFlushes,start(){asking=true;summaryScope=closeTestScope={stop:false};},revision:()=>localImportRevision,stopped:()=>closeTestScope.stop,answer(question){if(!contentIngressAllowed(active()))return Promise.resolve({ok:false});active().ai_answers=[{question,answer:"Authored answer",citations:["demo-1"],provider:"fixture"}];return commitDocument(active());},flush:()=>libraryStore.flush(),status:()=>libraryStore.status(),closing:()=>readerClosing,requests(){sourceCaptionRequest=new AbortController();podcastRequest=new AbortController();podcastMediaRequest=new AbortController();projectCaptionRequest={controller:new AbortController()};return [sourceCaptionRequest,podcastRequest,podcastMediaRequest,projectCaptionRequest.controller];}};');
 let nextRequestId=0;
 const request=(kind='close')=>({id:++nextRequestId,kind,expiresAt:Date.now()+60000});
 return {w,$:id=>w.document.getElementById(id),request,writes};
}
test('native snapshot detects changed dialog values and leaves untouched dialogs clean',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();$('document-details').click();assert.equal(w.coconutPrepareClose('inspect').safe,true);
  $('document-title').value='New title';assert.equal(w.coconutPrepareClose('inspect').safe,false);assert.equal(await w.coconutPrepareClose('safe',request()),false);assert.notEqual(w.document.body.inert,true);
  $('details-dialog').close();assert.equal(w.coconutPrepareClose('inspect').safe,true);
  assert.equal(await w.coconutPrepareClose('safe',request()),true);assert.equal(w.document.body.inert,true);
 }finally{await w.happyDOM.close();}
});
test('storage failures stay unsafe even after an export attempt',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();const backing=w.localStorage;Object.defineProperty(w,'localStorage',{value:{getItem:k=>backing.getItem(k),setItem(){throw Error('quota');}}});
  w.document.querySelector('.note-button').click();$('note').value='Unsaved note';$('note').dispatchEvent(new w.Event('input',{bubbles:true}));await w.closeTest.flush();
  assert.equal(w.coconutPrepareClose('inspect').safe,false);$('export-library').click();assert.equal(w.coconutPrepareClose('inspect').safe,false);
  assert.equal(await w.coconutPrepareClose('discard',request()),true);assert.equal(w.document.body.inert,true);
 }finally{await w.happyDOM.close();}
});
test('inspection leaves current summary consent and imports intact; discard retires them',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();w.closeTest.start();$('ai-consent').checked=true;
  const before=w.closeTest.revision();assert.equal(w.coconutPrepareClose('inspect').safe,false);assert.equal(w.closeTest.stopped(),false);assert.equal($('ai-consent').checked,true);assert.equal(w.closeTest.revision(),before);
  await w.coconutPrepareClose('discard',request());assert.equal(w.closeTest.stopped(),true);assert.equal($('ai-consent').checked,false);assert.equal(w.closeTest.revision(),before+1);
 }finally{await w.happyDOM.close();}
});
for(const discard of [false,true])test(`pending restore ${discard?'cannot commit after approved discard':'still completes after read-only close inspection'}`,async()=>{
 const {w,$,request}=setup();try{
  let resolve;const pending=new Promise(r=>resolve=r);
  const backup={format:'coconut-library',version:1,documents:[{key:'restore',schema_version:1,title:'Restore fixture',language:'en',segments:[{id:'one',start:0,end:4,text:'Authored fixture'}]}],active:'restore'};
  Object.defineProperty($('library-file'),'files',{configurable:true,value:[{size:100,text:()=>pending}]});
  const restore=$('library-file').onchange();assert.equal(w.coconutPrepareClose('inspect').safe,false);
  if(discard)assert.equal(await w.coconutPrepareClose('discard',request()),true);
  resolve(JSON.stringify(backup));await restore;
  const saved=JSON.parse(w.localStorage.getItem(key)||'{"documents":[]}');assert.equal(saved.documents.length,discard?0:1);
 }finally{await w.happyDOM.close();}
});

test('an already saved question is not an unsubmitted draft',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();$('ai-question').value='Authored question';assert.equal(w.coconutPrepareClose('inspect').safe,false);
  await w.closeTest.answer('Authored question');assert.equal(w.coconutPrepareClose('inspect').safe,true);
  $('ai-question').value='Different question';assert.equal(w.coconutPrepareClose('inspect').safe,false);
 }finally{await w.happyDOM.close();}
});
test('approved discard cannot write a late AI answer over the saved library',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();const saved=w.localStorage.getItem(key);
  w.document.querySelector('.note-button').click();$('note').value='Pending before discard';$('note').dispatchEvent(new w.Event('input',{bubbles:true}));
  const owner=request();w.closeTest.start();assert.equal(await w.coconutPrepareClose('discard',owner),true);
  await w.closeTest.answer('A late current-batch answer');assert.equal(w.localStorage.getItem(key),saved);
  w.coconutPrepareClose('release',owner);assert.equal(w.coconutPrepareClose('inspect').safe,false);assert.equal(w.document.body.inert,false);
 }finally{await w.happyDOM.close();}
});
test('canceled local media picker is clean and does not strand update readiness',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();$('attach-reader-media').click();$('reader-media-file').dispatchEvent(new w.Event('cancel'));
  assert.equal(w.coconutPrepareClose('inspect').safe,true);assert.equal(await w.coconutPrepareUpdate(),true);
 }finally{await w.happyDOM.close();}
});

test('only approved close aborts caption and publisher request owners',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();const controllers=w.closeTest.requests();
  w.coconutPrepareClose('inspect');assert.equal(controllers.some(c=>c.signal.aborted),false);
  await w.coconutPrepareClose('discard',request());assert.equal(controllers.every(c=>c.signal.aborted),true);
 }finally{await w.happyDOM.close();}
});
for(const mode of ['safe','discard','update'])test(`approved native ${mode} flushes final listening clock before locking writes`,async()=>{
 const {w,$,request}=setup();try{
  const text=JSON.stringify({title:'Native resume fixture',source_media:{job_id:'b'.repeat(32),kind:'audio'},segments:[{id:'first',start:0,end:90,text:'Authored fixture.'}]});
  Object.defineProperty($('file'),'files',{configurable:true,value:[{name:'native.json',size:text.length,text:async()=>text}]});await $('file').onchange();Object.defineProperty($('file'),'files',{configurable:true,value:[]});
  w.dispatchEvent(new w.Event('coconut-worker-ready'));const p=$('source-media').querySelector('audio');Object.defineProperty(p,'duration',{value:90});p.dispatchEvent(new w.Event('play'));p.currentTime=20;p.dispatchEvent(new w.Event('timeupdate'));p.currentTime=23;
  const progressKey=Object.keys(w.localStorage).find(k=>k.startsWith('coconut-listening-v1:'));assert.equal(JSON.parse(w.localStorage.getItem(progressKey)).time,20,'final player clock is not yet persisted');
  if(mode==='update')Object.defineProperty(p,'paused',{value:true});
  const owner=request(mode==='update'?'update':'close');
  assert.equal(mode==='update'?await w.coconutPrepareUpdate(true,owner):await w.coconutPrepareClose(mode,owner),true);
  assert.equal(JSON.parse(w.localStorage.getItem(progressKey)).time,23);assert.equal(w.document.body.inert,true);
  assert.equal(w.coconutPrepareClose('release',owner),true);assert.equal(w.document.body.inert,false);
  assert.equal(JSON.parse(w.localStorage.getItem(progressKey)).time,23,'owned release preserves the final listening clock');
 }finally{await w.happyDOM.close();}
});

test('native close explicitly warns that removal recovery exists only in this page',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();w.document.querySelector('.library-remove').click();await $('confirm-removal').onclick();
  const snapshot=w.coconutPrepareClose('inspect');assert.equal(snapshot.safe,false);assert.match(JSON.stringify(snapshot),/移除备份仅在本页/);assert.equal(await w.coconutPrepareUpdate(),false);assert.equal(await w.coconutPrepareUpdate(true,request('update')),false);assert.equal(w.document.body.inert,false);
  await $('undo-removal').onclick();assert.equal(w.coconutPrepareClose('inspect').safe,true);
 }finally{await w.happyDOM.close();}
});

test('owned glossary input blocks native close and update until cancel or save',async()=>{
 const {w,$,request}=setup();try{
  assert.equal(await w.coconutPrepareUpdate(),true);
  await $('sample').onclick();$('mode-transcript').click();$('language-panel').open=true;
  $('ai-task').value='translation';$('ai-task').dispatchEvent(new w.Event('change',{bubbles:true}));$('translation-options').open=true;
  const input=value=>{$('translation-glossary').value=value;$('translation-glossary').dispatchEvent(new w.Event('input',{bubbles:true}));};
  input('Coconut = 椰子');assert.equal(await w.coconutPrepareUpdate(),false);assert.equal(w.coconutPrepareClose('inspect').safe,false);
  $('cancel-translation-glossary').click();assert.equal(await w.coconutPrepareUpdate(),true);assert.equal(w.coconutPrepareClose('inspect').safe,true);
  input('Coconut = 椰子');assert.equal(await w.coconutPrepareUpdate(),false);await $('save-translation-glossary').onclick();assert.equal(await w.coconutPrepareUpdate(),true);assert.equal(w.coconutPrepareClose('inspect').safe,true);
  assert.deepEqual(JSON.parse(w.localStorage.getItem(key)).documents[0].translation_glossary.zh,[{source:'Coconut',target:'椰子'}]);
 }finally{await w.happyDOM.close();}
});

for(const mode of ['safe','discard'])test(`native ${mode} commit requires an unexpired authored ownership request`,async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();const before=w.closeTest.revision();
  for(const token of [undefined,null,{}, {id:0,kind:'close',expiresAt:Date.now()+60000}, {id:1,kind:'other',expiresAt:Date.now()+60000}, {...request(),expiresAt:Date.now()-1}]){
   assert.equal(await w.coconutPrepareClose(mode,token),false);
   assert.notEqual(w.document.body.inert,true);assert.equal(w.closeTest.revision(),before);
  }
  assert.equal(await w.coconutPrepareClose(mode,request()),true);
 }finally{await w.happyDOM.close();}
});

test('final update shares close ownership and only its matching release restores writes',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();const saved=w.localStorage.getItem(key),before=w.closeTest.revision();
  assert.equal(await w.coconutPrepareUpdate(true),false,'tokenless final update cannot lock');
  const owner=request('update');assert.equal(await w.coconutPrepareUpdate(true,owner),true);
  assert.equal(w.document.body.inert,true);assert.equal(w.closeTest.revision(),before+1);
  const flushed=w.closeTest.flushes();assert.equal(await w.coconutPrepareUpdate(true,owner),true,'same update owner is idempotent');
  assert.equal(w.closeTest.flushes(),flushed,'repeated update commit cannot flush listening twice');
  assert.equal(w.closeTest.revision(),before+1,'repeated update commit cannot cancel imports twice');
  for(const token of [undefined,{...owner,kind:'close'},{...owner,id:owner.id+100}]){
   assert.equal(w.coconutPrepareClose('release',token),false);assert.equal(w.document.body.inert,true);
   assert.equal(await w.coconutPrepareUpdate(true,owner),true,'rejected foreign release cannot poison the live owner');
   assert.equal(w.closeTest.flushes(),flushed);assert.equal(w.closeTest.revision(),before+1);
  }
  await w.closeTest.answer('While locked');assert.equal(w.localStorage.getItem(key),saved);
  assert.equal(w.coconutPrepareClose('release',owner),true);assert.equal(w.document.body.inert,false);
  await w.closeTest.answer('After owned release');assert.match(w.localStorage.getItem(key),/After owned release/);
  assert.equal(await w.coconutPrepareUpdate(true,owner),false,'released request cannot re-acquire ownership');
  const next=request();assert.equal(await w.coconutPrepareClose('safe',next),true,'unknown higher release cannot poison the next actual ID');
  const finalRevision=w.closeTest.revision(),finalFlushes=w.closeTest.flushes();assert.equal(await w.coconutPrepareClose('safe',next),true,'same close owner is idempotent');
  assert.equal(w.closeTest.flushes(),finalFlushes,'repeated close commit cannot flush listening twice');
  assert.equal(w.closeTest.revision(),finalRevision,'repeated close commit cannot cancel imports twice');
  assert.equal(w.coconutPrepareClose('release',next),true);assert.equal(w.document.body.inert,false);
 }finally{await w.happyDOM.close();}
});

test('late old release and commit cannot retire a newer renderer owner',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();const old=request(),current=request('update');
  assert.equal(await w.coconutPrepareClose('safe',old),true);
  assert.equal(w.coconutPrepareClose('release',old),true);
  assert.equal(await w.coconutPrepareUpdate(true,current),true);const before=w.closeTest.revision();
  assert.equal(w.coconutPrepareClose('release',old),false);
  assert.equal(await w.coconutPrepareClose('discard',old),false);
  assert.equal(w.document.body.inert,true);assert.equal(w.closeTest.revision(),before);
  assert.equal(w.coconutPrepareClose('release',current),true);assert.equal(w.document.body.inert,false);
 }finally{await w.happyDOM.close();}
});

test('expired queued discard cannot stop consented work or abort a request',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();w.closeTest.start();$('ai-consent').checked=true;
  const controllers=w.closeTest.requests(),before=w.closeTest.revision();
  assert.equal(await w.coconutPrepareClose('discard',{...request(),expiresAt:Date.now()-1}),false);
  assert.equal(controllers.some(c=>c.signal.aborted),false);assert.equal(w.closeTest.stopped(),false);
  assert.equal($('ai-consent').checked,true);assert.equal(w.closeTest.revision(),before);assert.notEqual(w.document.body.inert,true);
 }finally{await w.happyDOM.close();}
});

test('sample hashing blocks both update preflight and final commit without retiring the sample',async()=>{
 const {w,$,request}=setup();let complete;
 try{
  const digest=new Promise(resolve=>{complete=resolve;});
  Object.defineProperty(w,'crypto',{configurable:true,value:{subtle:{digest:async(...args)=>{await digest;return webcrypto.subtle.digest(...args);}}}});
  const sample=$('sample').onclick();assert.equal($('sample').disabled,true);
  const before=w.closeTest.revision();assert.equal(await w.coconutPrepareUpdate(),false);
  assert.equal(await w.coconutPrepareUpdate(true,request('update')),false);
  assert.equal(w.closeTest.revision(),before);assert.notEqual(w.document.body.inert,true);
  complete();await sample;assert.equal($('sample').disabled,false);
  assert.equal(JSON.parse(w.localStorage.getItem(key)).documents.length,1);
  assert.equal(await w.coconutPrepareUpdate(),true);
 }finally{complete?.();await w.happyDOM.close();}
});

function editNote({w,$},text){
 w.document.querySelector('.note-button').click();$('note').value=text;$('note').dispatchEvent(new w.Event('input',{bubbles:true}));
}
for(const kind of ['close','update'])test(`pending ${kind} shares one completion and locks only after the real legacy receipt`,async()=>{
 const s=setup(),{w,$,request,writes}=s;try{
  await $('sample').onclick();writes.held=true;editNote(s,'Held native content');
  const snapshot=w.coconutPrepareClose('inspect');assert.equal(snapshot.safe,false);assert.equal(snapshot.flushable,true);assert.equal(snapshot.contentPending,1);assert.equal(writes.pending.length,0,'inspection cannot start a writer');
  const owner=request(kind),commit=()=>kind==='close'?w.coconutPrepareClose('safe',owner):w.coconutPrepareUpdate(true,owner);
  const first=commit(),second=commit();assert.equal(first,second,'same owner exposes the same pending Promise');
  await until(()=>writes.pending.length===1);assert.equal(w.closeTest.status().blocked,true);assert.equal(w.closeTest.closing(),false);assert.equal(w.document.body.inert,true);
  const before=w.closeTest.revision(),flushed=w.closeTest.flushes();assert.equal((await w.closeTest.answer('Blocked while flushing')).ok,false);
  writes.pending[0].settle();assert.equal(await first,true);assert.equal(await second,true);
  assert.match(w.localStorage.getItem(key),/Held native content/);assert.equal(w.closeTest.closing(),true);assert.equal(w.document.body.inert,true);
  assert.equal(w.closeTest.flushes(),flushed+1);assert.equal(w.closeTest.revision(),before+1);
  assert.equal(commit(),first,'locked repeat retains the same settled completion');
  assert.equal(w.coconutPrepareClose('release',owner),true);assert.equal(w.closeTest.status().blocked,false);
 }finally{await w.happyDOM.close();}
});

test('failed safe flush releases ingress and supports a fresh discard decision on the same attempt',async()=>{
 const s=setup(),{w,$,request,writes}=s;try{
  await $('sample').onclick();writes.held=true;editNote(s,'Quota stays in memory');
  const owner=request(),before=w.closeTest.revision(),pending=w.coconutPrepareClose('safe',owner);
  await until(()=>writes.pending.length===1);writes.pending[0].fail();assert.equal(await pending,false);
  assert.equal(w.closeTest.status().blocked,false);assert.equal(w.closeTest.closing(),false);assert.notEqual(w.document.body.inert,true);assert.equal(w.closeTest.revision(),before);
  const snapshot=w.coconutPrepareClose('inspect',owner);assert.equal(snapshot.safe,false);assert.equal(snapshot.flushable,false);assert.equal(snapshot.contentFailed,true);assert.equal($('note').value,'Quota stays in memory');
  assert.equal(await w.coconutPrepareClose('discard',owner),true);assert.equal(w.closeTest.status().blocked,true);
  assert.equal(w.coconutPrepareClose('release',owner),true);assert.equal(w.coconutPrepareClose('inspect').safe,false,'discarded unsaved memory remains recoverable after failed native quit');
 }finally{await w.happyDOM.close();}
});

test('pending release is synchronous and an old completion cannot unlock a newer update owner',async()=>{
 const s=setup(),{w,$,request,writes}=s;try{
  await $('sample').onclick();writes.held=true;editNote(s,'Complete after the old attempt retires');
  const old=request(),first=w.coconutPrepareClose('safe',old);await until(()=>writes.pending.length===1);
  assert.equal(w.coconutPrepareClose('release',old),true);assert.equal(w.closeTest.status().blocked,false);assert.equal(w.closeTest.closing(),false);
  const next=request('update'),second=w.coconutPrepareUpdate(true,next);assert.equal(w.closeTest.status().blocked,true);
  assert.equal(await first,false);assert.equal(w.closeTest.status().blocked,true,'old finally must not release the next barrier');
  assert.equal(w.coconutPrepareClose('release',old),false);assert.equal(await w.coconutPrepareClose('discard',old),false);
  writes.pending[0].settle();assert.equal(await second,true);assert.equal(w.document.body.inert,true);
  assert.equal(w.coconutPrepareClose('release',old),false);assert.equal(w.document.body.inert,true);
  assert.equal(w.coconutPrepareClose('release',next),true);
 }finally{await w.happyDOM.close();}
});

test('a deadline crossed while a writer waits cannot lock, flush listening, or retire request owners',async()=>{
 const s=setup(),{w,$,request,writes}=s;try{
  await $('sample').onclick();writes.held=true;editNote(s,'Late receipt after deadline');
  const owner=request(),before=w.closeTest.revision(),flushed=w.closeTest.flushes(),pending=w.coconutPrepareClose('safe',owner);
  await until(()=>writes.pending.length===1);const OriginalDate=w.Date;Object.defineProperty(w,'Date',{configurable:true,value:class extends OriginalDate{static now(){return owner.expiresAt+1;}}});
  writes.pending[0].settle();assert.equal(await pending,false);assert.equal(w.closeTest.status().blocked,false);
  assert.equal(w.closeTest.closing(),false);assert.notEqual(w.document.body.inert,true);assert.equal(w.closeTest.revision(),before);assert.equal(w.closeTest.flushes(),flushed);
  assert.equal(await w.coconutPrepareClose('discard',owner),false);
 }finally{await w.happyDOM.close();}
});

test('approved discard waits for the actual writer abort acknowledgement before final locking',async()=>{
 const s=setup(),{w,$,request,writes}=s;try{
  await $('sample').onclick();const saved=w.localStorage.getItem(key);writes.held=true;editNote(s,'Aborted content remains recoverable');
  const flushing=w.closeTest.flush();await until(()=>writes.pending.length===1);const before=w.closeTest.revision();
  const owner=request(),discard=w.coconutPrepareClose('discard',owner);let completed=false;void discard.then(()=>{completed=true;});
  await until(()=>writes.pending[0].signal.aborted);assert.equal(completed,false);assert.equal(w.closeTest.closing(),false);assert.equal(w.document.body.inert,true);assert.equal(w.closeTest.revision(),before);
  writes.pending[0].settle();assert.equal((await flushing).ok,false);assert.equal(await discard,true);
  assert.equal(w.localStorage.getItem(key),saved);assert.equal(w.document.body.inert,true);assert.equal(w.closeTest.revision(),before+1);
  w.coconutPrepareClose('release',owner);assert.equal(w.coconutPrepareClose('inspect').contentFailed,true);
 }finally{await w.happyDOM.close();}
});

test('a new dialog draft during safe flush is rechecked before final listening and teardown',async()=>{
 const s=setup(),{w,$,request,writes}=s;try{
  await $('sample').onclick();writes.held=true;editNote(s,'Persist before late draft');
  const before=w.closeTest.revision(),flushed=w.closeTest.flushes(),pending=w.coconutPrepareClose('safe',request());await until(()=>writes.pending.length===1);
  $('document-details').click();$('document-title').value='Late unsubmitted title';writes.pending[0].settle();assert.equal(await pending,false);
  assert.equal(w.closeTest.status().blocked,false);assert.equal(w.closeTest.closing(),false);assert.equal(w.closeTest.revision(),before);assert.equal(w.closeTest.flushes(),flushed);
  assert.equal($('document-title').value,'Late unsubmitted title');assert.equal(w.coconutPrepareClose('inspect').flushable,false);
 }finally{await w.happyDOM.close();}
});

test('update precheck waits without a lasting lock and detects newer content beyond its receipt',async()=>{
 const s=setup(),{w,$,request,writes}=s;try{
  await $('sample').onclick();writes.held=true;editNote(s,'Precheck generation one');
  const owner=request('update'),precheck=w.coconutPrepareUpdate(false,owner);await until(()=>writes.pending.length===1);
  assert.equal(w.closeTest.status().blocked,false);editNote(s,'Precheck generation two');writes.pending[0].settle();assert.equal(await precheck,false);
  assert.equal(w.closeTest.closing(),false);assert.notEqual(w.document.body.inert,true);assert.equal(w.closeTest.status().pending,1);
  writes.held=false;const freshPrecheck=w.coconutPrepareUpdate(false,owner);await until(()=>writes.pending.length===2);writes.pending[1].settle();assert.equal(await freshPrecheck,true);assert.equal(w.closeTest.status().blocked,false);assert.match(w.localStorage.getItem(key),/Precheck generation two/);
  assert.equal(await w.coconutPrepareUpdate(true,owner),true);assert.equal(w.coconutPrepareClose('release',owner),true);
 }finally{await w.happyDOM.close();}
});

for(const kind of ['close','update'])for(const field of ['note','project-note','bookmark-note'])test(`pending ${kind} prevents editing and retains an already queued ${field} input through release and retry`,async()=>{
 const s=setup(),{w,$,request,writes}=s;try{
  const data={title:'Native queued input fixture',project_note:'Initial project',timestamp_bookmarks:[{id:'bookmark',time:1,note:'Initial bookmark'}],segments:[{id:'one',start:0,end:4,text:'Authored source'}]};
  const text=JSON.stringify(data);Object.defineProperty($('file'),'files',{configurable:true,value:[{name:'fixture.json',size:text.length,text:async()=>text}]});await $('file').onchange();Object.defineProperty($('file'),'files',{configurable:true,value:[]});$('mode-transcript').click();
  if(field==='note')w.document.querySelector('.note-button').click();
  const input=field==='bookmark-note'?w.document.querySelector('#audio-bookmarks textarea'):$(field);
  const type=value=>{input.value=value;input.dispatchEvent(new w.Event('input',{bubbles:true}));};
  writes.held=true;type('Captured before close');input.focus();const owner=request(kind);
  const pending=kind==='close'?w.coconutPrepareClose('safe',owner):w.coconutPrepareUpdate(true,owner);
  assert.equal(w.document.body.inert,true,'interaction is disabled synchronously at the barrier');assert.equal(w.closeTest.closing(),false,'pending is not final teardown');
  await until(()=>writes.pending.length===1);
  // HappyDOM can dispatch to an inert node; this models an input/IME event
  // already queued before the browser's inert interaction gate took effect.
  type('Queued newest text');assert.equal(w.coconutPrepareClose('inspect').nonContentReasons.length>0,true);
  writes.pending[0].settle();assert.equal(await pending,false);assert.equal(w.document.body.inert,false);assert.equal(w.closeTest.closing(),false);assert.equal(input.value,'Queued newest text');
  assert.equal(w.closeTest.status().pending,1,'release registers the exact deferred input as a newer generation');
  writes.held=false;assert.equal((await w.closeTest.flush()).ok,true);
  const saved=JSON.parse(w.localStorage.getItem(key)).documents[0],actual=field==='note'?saved.notes.one:field==='project-note'?saved.project_note:saved.timestamp_bookmarks[0].note;
  assert.equal(actual,'Queued newest text');assert.equal(w.document.activeElement,input,'release retains the owned editor focus');
 }finally{await w.happyDOM.close();}
});

test('local-only file picker blocks update while open and native cancellation leaves no phantom task',async()=>{
 const {w,$,request}=setup();try{
  $('open-local-media').click();assert.equal(w.coconutPrepareClose('inspect').safe,false);assert.equal(await w.coconutPrepareUpdate(),false);
  $('local-media-file').dispatchEvent(new w.Event('cancel'));assert.equal(w.coconutPrepareClose('inspect').safe,true);assert.equal(await w.coconutPrepareUpdate(),true);
 }finally{await w.happyDOM.close();}
});
