import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url),key='coconut-reader-v1';
function setup(){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{configurable:true,value:webcrypto});
 w.coconutUpdates={state:async()=>({status:'idle',version:'test',arch:'arm64'}),subscribe:()=>{}};
 for(const file of ['summary','core','passages','passage-playback'])w.eval(fs.readFileSync(new URL(`reader/${file}.js`,root),'utf8'));
 w.eval(['app','language','translation-review','podcasts'].map(file=>fs.readFileSync(new URL(`reader/${file}.js`,root),'utf8')).join('\n')+'\nlet sourceSubmitting=false,sourceCaptionRequest=null;\n'+fs.readFileSync(new URL('reader/updates.js',root),'utf8')+'\nlet closeTestFlushes=0;const originalCloseTestFlush=flushListening;flushListening=(...args)=>{closeTestFlushes++;return originalCloseTestFlush(...args);};\nwindow.closeTest={flushes:()=>closeTestFlushes,start(){asking=true;summaryScope={stop:false};},revision:()=>localImportRevision,stopped:()=>summaryScope.stop,answer(question){active().ai_answers=[{question,answer:"Authored answer",citations:["demo-1"],provider:"fixture"}];save();},requests(){sourceCaptionRequest=new AbortController();podcastRequest=new AbortController();podcastMediaRequest=new AbortController();projectCaptionRequest={controller:new AbortController()};return [sourceCaptionRequest,podcastRequest,podcastMediaRequest,projectCaptionRequest.controller];}};');
 let nextRequestId=0;
 const request=(kind='close')=>({id:++nextRequestId,kind,expiresAt:Date.now()+60000});
 return {w,$:id=>w.document.getElementById(id),request};
}
test('native snapshot detects changed dialog values and leaves untouched dialogs clean',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();$('document-details').click();assert.equal(w.coconutPrepareClose('inspect').safe,true);
  $('document-title').value='New title';assert.equal(w.coconutPrepareClose('inspect').safe,false);assert.equal(w.coconutPrepareClose('safe',request()),false);assert.notEqual(w.document.body.inert,true);
  $('details-dialog').close();assert.equal(w.coconutPrepareClose('inspect').safe,true);
  assert.equal(w.coconutPrepareClose('safe',request()),true);assert.equal(w.document.body.inert,true);
 }finally{await w.happyDOM.close();}
});
test('storage failures stay unsafe even after an export attempt',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();const backing=w.localStorage;Object.defineProperty(w,'localStorage',{value:{getItem:k=>backing.getItem(k),setItem(){throw Error('quota');}}});
  w.document.querySelector('.note-button').click();$('note').value='Unsaved note';$('note').dispatchEvent(new w.Event('input',{bubbles:true}));
  assert.equal(w.coconutPrepareClose('inspect').safe,false);$('export-library').click();assert.equal(w.coconutPrepareClose('inspect').safe,false);
  assert.equal(w.coconutPrepareClose('discard',request()),true);assert.equal(w.document.body.inert,true);
 }finally{await w.happyDOM.close();}
});
test('inspection leaves current summary consent and imports intact; discard retires them',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();w.closeTest.start();$('ai-consent').checked=true;
  const before=w.closeTest.revision();assert.equal(w.coconutPrepareClose('inspect').safe,false);assert.equal(w.closeTest.stopped(),false);assert.equal($('ai-consent').checked,true);assert.equal(w.closeTest.revision(),before);
  w.coconutPrepareClose('discard',request());assert.equal(w.closeTest.stopped(),true);assert.equal($('ai-consent').checked,false);assert.equal(w.closeTest.revision(),before+1);
 }finally{await w.happyDOM.close();}
});
for(const discard of [false,true])test(`pending restore ${discard?'cannot commit after approved discard':'still completes after read-only close inspection'}`,async()=>{
 const {w,$,request}=setup();try{
  let resolve;const pending=new Promise(r=>resolve=r);
  const backup={format:'coconut-library',version:1,documents:[{key:'restore',schema_version:1,title:'Restore fixture',language:'en',segments:[{id:'one',start:0,end:4,text:'Authored fixture'}]}],active:'restore'};
  Object.defineProperty($('library-file'),'files',{configurable:true,value:[{size:100,text:()=>pending}]});
  const restore=$('library-file').onchange();assert.equal(w.coconutPrepareClose('inspect').safe,false);
  if(discard)assert.equal(w.coconutPrepareClose('discard',request()),true);
  resolve(JSON.stringify(backup));await restore;
  const saved=JSON.parse(w.localStorage.getItem(key)||'{"documents":[]}');assert.equal(saved.documents.length,discard?0:1);
 }finally{await w.happyDOM.close();}
});

test('an already saved question is not an unsubmitted draft',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();$('ai-question').value='Authored question';assert.equal(w.coconutPrepareClose('inspect').safe,false);
  w.closeTest.answer('Authored question');assert.equal(w.coconutPrepareClose('inspect').safe,true);
  $('ai-question').value='Different question';assert.equal(w.coconutPrepareClose('inspect').safe,false);
 }finally{await w.happyDOM.close();}
});
test('approved discard cannot write a late AI answer over the saved library',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();const saved=w.localStorage.getItem(key);
  const owner=request();w.closeTest.start();assert.equal(w.coconutPrepareClose('discard',owner),true);
  w.closeTest.answer('A late current-batch answer');assert.equal(w.localStorage.getItem(key),saved);
  w.coconutPrepareClose('release',owner);assert.equal(w.coconutPrepareClose('inspect').safe,false);assert.equal(w.document.body.inert,false);
 }finally{await w.happyDOM.close();}
});
test('canceled local media picker is clean and does not strand update readiness',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();$('attach-reader-media').click();$('reader-media-file').dispatchEvent(new w.Event('cancel'));
  assert.equal(w.coconutPrepareClose('inspect').safe,true);assert.equal(w.coconutPrepareUpdate(),true);
 }finally{await w.happyDOM.close();}
});

test('only approved close aborts caption and publisher request owners',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();const controllers=w.closeTest.requests();
  w.coconutPrepareClose('inspect');assert.equal(controllers.some(c=>c.signal.aborted),false);
  w.coconutPrepareClose('discard',request());assert.equal(controllers.every(c=>c.signal.aborted),true);
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
  assert.equal(mode==='update'?w.coconutPrepareUpdate(true,owner):w.coconutPrepareClose(mode,owner),true);
  assert.equal(JSON.parse(w.localStorage.getItem(progressKey)).time,23);assert.equal(w.document.body.inert,true);
  assert.equal(w.coconutPrepareClose('release',owner),true);assert.equal(w.document.body.inert,false);
  assert.equal(JSON.parse(w.localStorage.getItem(progressKey)).time,23,'owned release preserves the final listening clock');
 }finally{await w.happyDOM.close();}
});

test('native close explicitly warns that removal recovery exists only in this page',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();w.document.querySelector('.library-remove').click();$('confirm-removal').click();
  const snapshot=w.coconutPrepareClose('inspect');assert.equal(snapshot.safe,false);assert.match(JSON.stringify(snapshot),/移除备份仅在本页/);assert.equal(w.coconutPrepareUpdate(),false);assert.equal(w.coconutPrepareUpdate(true,request('update')),false);assert.equal(w.document.body.inert,false);
  $('undo-removal').click();assert.equal(w.coconutPrepareClose('inspect').safe,true);
 }finally{await w.happyDOM.close();}
});

test('owned glossary input blocks native close and update until cancel or save',async()=>{
 const {w,$,request}=setup();try{
  assert.equal(w.coconutPrepareUpdate(),true);
  await $('sample').onclick();$('mode-transcript').click();$('language-panel').open=true;
  $('ai-task').value='translation';$('ai-task').dispatchEvent(new w.Event('change',{bubbles:true}));$('translation-options').open=true;
  const input=value=>{$('translation-glossary').value=value;$('translation-glossary').dispatchEvent(new w.Event('input',{bubbles:true}));};
  input('Coconut = 椰子');assert.equal(w.coconutPrepareUpdate(),false);assert.equal(w.coconutPrepareClose('inspect').safe,false);
  $('cancel-translation-glossary').click();assert.equal(w.coconutPrepareUpdate(),true);assert.equal(w.coconutPrepareClose('inspect').safe,true);
  input('Coconut = 椰子');assert.equal(w.coconutPrepareUpdate(),false);$('save-translation-glossary').click();assert.equal(w.coconutPrepareUpdate(),true);assert.equal(w.coconutPrepareClose('inspect').safe,true);
  assert.deepEqual(JSON.parse(w.localStorage.getItem(key)).documents[0].translation_glossary.zh,[{source:'Coconut',target:'椰子'}]);
 }finally{await w.happyDOM.close();}
});

for(const mode of ['safe','discard'])test(`native ${mode} commit requires an unexpired authored ownership request`,async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();const before=w.closeTest.revision();
  for(const token of [undefined,null,{}, {id:0,kind:'close',expiresAt:Date.now()+60000}, {id:1,kind:'other',expiresAt:Date.now()+60000}, {...request(),expiresAt:Date.now()-1}]){
   assert.equal(w.coconutPrepareClose(mode,token),false);
   assert.notEqual(w.document.body.inert,true);assert.equal(w.closeTest.revision(),before);
  }
  assert.equal(w.coconutPrepareClose(mode,request()),true);
 }finally{await w.happyDOM.close();}
});

test('final update shares close ownership and only its matching release restores writes',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();const saved=w.localStorage.getItem(key),before=w.closeTest.revision();
  assert.equal(w.coconutPrepareUpdate(true),false,'tokenless final update cannot lock');
  const owner=request('update');assert.equal(w.coconutPrepareUpdate(true,owner),true);
  assert.equal(w.document.body.inert,true);assert.equal(w.closeTest.revision(),before+1);
  const flushed=w.closeTest.flushes();assert.equal(w.coconutPrepareUpdate(true,owner),true,'same update owner is idempotent');
  assert.equal(w.closeTest.flushes(),flushed,'repeated update commit cannot flush listening twice');
  assert.equal(w.closeTest.revision(),before+1,'repeated update commit cannot cancel imports twice');
  for(const token of [undefined,{...owner,kind:'close'},{...owner,id:owner.id+100}]){
   assert.equal(w.coconutPrepareClose('release',token),false);assert.equal(w.document.body.inert,true);
   assert.equal(w.coconutPrepareUpdate(true,owner),true,'rejected foreign release cannot poison the live owner');
   assert.equal(w.closeTest.flushes(),flushed);assert.equal(w.closeTest.revision(),before+1);
  }
  w.closeTest.answer('While locked');assert.equal(w.localStorage.getItem(key),saved);
  assert.equal(w.coconutPrepareClose('release',owner),true);assert.equal(w.document.body.inert,false);
  w.closeTest.answer('After owned release');assert.match(w.localStorage.getItem(key),/After owned release/);
  assert.equal(w.coconutPrepareUpdate(true,owner),false,'released request cannot re-acquire ownership');
  const next=request();assert.equal(w.coconutPrepareClose('safe',next),true,'unknown higher release cannot poison the next actual ID');
  const finalRevision=w.closeTest.revision(),finalFlushes=w.closeTest.flushes();assert.equal(w.coconutPrepareClose('safe',next),true,'same close owner is idempotent');
  assert.equal(w.closeTest.flushes(),finalFlushes,'repeated close commit cannot flush listening twice');
  assert.equal(w.closeTest.revision(),finalRevision,'repeated close commit cannot cancel imports twice');
  assert.equal(w.coconutPrepareClose('release',next),true);assert.equal(w.document.body.inert,false);
 }finally{await w.happyDOM.close();}
});

test('late old release and commit cannot retire a newer renderer owner',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();const old=request(),current=request('update');
  assert.equal(w.coconutPrepareClose('safe',old),true);
  assert.equal(w.coconutPrepareClose('release',old),true);
  assert.equal(w.coconutPrepareUpdate(true,current),true);const before=w.closeTest.revision();
  assert.equal(w.coconutPrepareClose('release',old),false);
  assert.equal(w.coconutPrepareClose('discard',old),false);
  assert.equal(w.document.body.inert,true);assert.equal(w.closeTest.revision(),before);
  assert.equal(w.coconutPrepareClose('release',current),true);assert.equal(w.document.body.inert,false);
 }finally{await w.happyDOM.close();}
});

test('expired queued discard cannot stop consented work or abort a request',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();w.closeTest.start();$('ai-consent').checked=true;
  const controllers=w.closeTest.requests(),before=w.closeTest.revision();
  assert.equal(w.coconutPrepareClose('discard',{...request(),expiresAt:Date.now()-1}),false);
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
  const before=w.closeTest.revision();assert.equal(w.coconutPrepareUpdate(),false);
  assert.equal(w.coconutPrepareUpdate(true,request('update')),false);
  assert.equal(w.closeTest.revision(),before);assert.notEqual(w.document.body.inert,true);
  complete();await sample;assert.equal($('sample').disabled,false);
  assert.equal(JSON.parse(w.localStorage.getItem(key)).documents.length,1);
  assert.equal(w.coconutPrepareUpdate(),true);
 }finally{complete?.();await w.happyDOM.close();}
});

 test('manual translation draft participates in native close inspection and approved discard guard',async()=>{
 const {w,$,request}=setup();try{
  await $('sample').onclick();w.document.querySelector('.review-translation-button').click();assert.equal(w.coconutPrepareClose('inspect').safe,true);
  $('translation-edit-text').value='Uncommitted human translation';$('translation-edit-text').dispatchEvent(new w.Event('input',{bubbles:true}));
  const owner=request(),disk=w.localStorage.getItem(key);assert.equal(w.coconutPrepareClose('inspect').safe,false);assert.equal(w.coconutPrepareClose('safe',owner),false);
  assert.equal($('translation-edit-dialog').open,true);assert.equal($('translation-edit-text').value,'Uncommitted human translation');
  assert.equal(w.coconutPrepareClose('discard',owner),true);$('save-translation-edit').click();assert.equal(w.localStorage.getItem(key),disk);
  w.coconutPrepareClose('release',owner);$('save-translation-edit').click();assert.equal(w.coconutPrepareClose('inspect').safe,true);
 }finally{await w.happyDOM.close();}
});
