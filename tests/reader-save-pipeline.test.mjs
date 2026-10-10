import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {installSavePipeline,settle,saveClock} from './helpers/save-pipeline.mjs';
const root=new URL('../',import.meta.url),KEY='coconut-reader-v1';
const doc=key=>({schema_version:1,key,title:key,language:'en',segments:[{id:'one',start:0,end:4,text:'Authored source '+key}],notes:{}});
function setup({documents=[doc('a'),doc('b')],raw=null,held=false,clock=null}={}){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});w.localStorage.setItem(KEY,raw??JSON.stringify({documents,active:documents[0]?.key}));
 const saves=installSavePipeline(w,{held,clock});
 w.eval(['summary','core','passages','passage-playback','app','language','translation-review','podcasts'].map(file=>fs.readFileSync(new URL('reader/'+file+'.js',root),'utf8')).join('\n')+'\nwindow.saveTest={get documents(){return state.documents;},get active(){return active();},get savedAnswers(){return persistedAIAnswerCounts;},queue:queueDocument,commit:commitDocument,hasDrafts:hasUnsubmittedReaderDrafts};');
 const $=id=>w.document.getElementById(id);
 const note=text=>{if($('notes-panel').hidden)w.document.querySelector('.note-button').click();$('note').value=text;$('note').dispatchEvent(new w.Event('input',{bubbles:true}));};
 const unload=()=>{const event=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(event);return event.defaultPrevented;};
 return {w,$,saves,note,unload};
}
test('input shows pending and guards unload synchronously; a burst debounces to one actual content write',async()=>{
 const clock=saveClock(),f=setup({clock});try{
  f.note('first');assert.equal(f.$('save-status').dataset.state,'pending');assert.equal(f.unload(),true);assert.equal(f.saves.prepares,0);
  await clock.tick(100);f.note('second');await clock.tick(100);f.note('third');await clock.tick(249);assert.equal(f.saves.prepares,0);
  await clock.tick(1);assert.equal(f.saves.prepares,1);assert.equal(f.$('save-status').dataset.state,'saved');assert.equal(f.unload(),false);
  assert.equal(JSON.parse(f.w.localStorage.getItem(KEY)).documents[0].notes.one,'third');
  f.w.document.querySelectorAll('.library-open')[1].click();assert.equal(f.saves.prepares,1,'clean navigation never serializes content');
 }finally{await f.w.happyDOM.close();}
});
test('held A+B receipt acknowledges captured generations and AI counts without clearing newer B edits',async()=>{
 const f=setup({held:true});try{
  const [a,b]=f.w.saveTest.documents;a.notes.one='A';f.w.saveTest.queue(a);b.ai_answers=[{question:'one',answer:'first'}];f.w.saveTest.queue(b);
  const flushing=f.saves.store.flush();b.ai_answers.push({question:'two',answer:'second'});b.notes.one='B newer';f.w.saveTest.queue(b);
  f.saves.writes[0].commit();await flushing;assert.equal(f.saves.store.status('a').status,'saved');assert.equal(f.saves.store.status('b').status,'pending');
  assert.equal(f.w.saveTest.savedAnswers.get(b),1);assert.equal(f.unload(),true);
  const next=f.saves.store.flush();f.saves.writes[1].commit();await next;assert.equal(f.w.saveTest.savedAnswers.get(b),2);assert.equal(f.unload(),false);
 }finally{await f.w.happyDOM.close();}
});
for(const [code,message] of [['quota','空间不足'],['denied','禁止'],['conflict','另一个页面'],['fenced','版本已改变']])test(`${code} leaves document memory, failed status and unload protection intact`,async()=>{
 const f=setup({held:true});try{
  f.note('Keep everything');const flushing=f.saves.store.flush();f.saves.writes[0].fail(code);await flushing;
  assert.equal(f.w.saveTest.active.notes.one,'Keep everything');assert.equal(f.$('save-status').dataset.state,'failed');assert.match(f.$('save-status').textContent,new RegExp(message));assert.equal(f.unload(),true);
  assert.equal(f.$('retry-save').hidden,false);assert.equal(f.$('export-unsaved-documents').hidden,false);
 }finally{await f.w.happyDOM.close();}
});
test('retry persists all current notes and histories without touching the focused newer form draft',async()=>{
 const f=setup({held:true});try{
  f.note('Failed then rescued');const first=f.saves.store.flush();f.saves.writes[0].fail();await first;
  const a=f.w.saveTest.active;a.ai_answers=Array.from({length:25},(_,index)=>({answer:'History '+index}));f.w.saveTest.queue(a);
  f.$('ai-question').value='A newer unsubmitted question';f.$('ai-question').focus();const retry=f.$('retry-save').onclick();
  f.saves.writes[1].commit();await retry;
  assert.equal(f.$('save-status').dataset.state,'saved');assert.equal(f.$('ai-question').value,'A newer unsubmitted question');assert.equal(f.w.document.activeElement,f.$('ai-question'));assert.equal(f.unload(),true,'draft stays separate from saved content');
  const saved=JSON.parse(f.w.localStorage.getItem(KEY)).documents[0];assert.equal(saved.notes.one,'Failed then rescued');assert.equal(saved.ai_answers.length,25);
 }finally{await f.w.happyDOM.close();}
});
test('dirty rescue is full-fidelity and importable; starting download never acknowledges persistence',async()=>{
 const f=setup({held:true});try{
  f.note('Full note');const a=f.w.saveTest.active;a.ai_answers=Array.from({length:24},(_,i)=>({question:'Question '+i,answer:'Answer '+i,citations:['one'],provider:'fixture'}));a.segments[0].translations={zh:{text:'人工译文',source_text:a.segments[0].text,source_language:'en',document_language:'en',provider:'fixture'}};f.w.saveTest.queue(a);
  let blob;f.w.URL.createObjectURL=value=>{blob=value;return 'blob:fixture';};f.w.HTMLAnchorElement.prototype.click=function(){};
  f.$('export-unsaved-documents').click();const backup=JSON.parse(await blob.text());
  assert.equal(backup.format,'coconut-library');assert.equal(backup.documents.length,1);assert.equal(backup.documents[0].ai_answers.length,24);assert.equal(backup.documents[0].notes.one,'Full note');assert.equal(backup.documents[0].segments[0].translations.zh.text,'人工译文');
  assert.equal(f.unload(),true);assert.match(f.$('notice').textContent,/未提交表单草稿/);
  const restored=f.w.Coconut.mergeLibraryBackup({documents:[],active:null},backup);assert.equal(restored.documents[0].ai_answers.length,24);
 }finally{await f.w.happyDOM.close();}
});
test('unreadable untouched storage stays clean and is never overwritten after a new edit',async()=>{
 const f=setup({raw:'{broken'});try{
  assert.equal(f.unload(),false);assert.match(f.$('save-status').textContent,/原有数据无法读取/);
  await f.$('sample').onclick();assert.equal(f.w.localStorage.getItem(KEY),'{broken');assert.equal(f.unload(),true);assert.equal(f.saves.store.status().status,'failed');
 }finally{await f.w.happyDOM.close();}
});
test('atomic restore registers every new identity before a subscriber can force a captured write',async()=>{
 const f=setup({held:true});try{
  const backup={format:'coconut-library',version:1,documents:[doc('x'),doc('y')],active:'x'};
  let registered;f.saves.store.subscribe((snapshot,event)=>{if(event.type==='queued'){registered=snapshot;void f.saves.store.flush();}});
  const text=JSON.stringify(backup);Object.defineProperty(f.$('library-file'),'files',{configurable:true,value:[{name:'backup.json',size:text.length,text:async()=>text}]});
  const restoring=f.$('library-file').onchange();await settle();assert.equal(f.saves.writes.length,1);assert.equal(registered.unsaved,2);assert.equal(JSON.parse(f.saves.writes[0].value).documents.length,4);
  f.saves.writes[0].commit();await restoring;assert.equal(f.saves.store.status().unsaved,0);assert.equal(f.w.saveTest.documents.length,4);
 }finally{await f.w.happyDOM.close();}
});

test('failed pending removal restores only A while B edits and the newer focus survive',async()=>{
 const f=setup({held:true});try{
  f.w.document.querySelector('.library-remove').onclick();const removal=f.$('confirm-removal').onclick();
  assert.equal(f.$('remove-document-dialog').open,false);assert.equal(f.w.saveTest.active.key,'b');assert.equal(f.saves.writes.length,1);
  f.note('Concurrent B edit');f.$('note').focus();const newer=f.saves.store.flush();
  f.saves.writes[0].fail();await removal;assert.equal(f.w.saveTest.documents.find(doc=>doc.key==='a').key,'a');
  assert.equal(f.w.saveTest.active.key,'b');assert.equal(f.w.saveTest.active.notes.one,'Concurrent B edit');assert.equal(f.$('note').value,'Concurrent B edit');assert.equal(f.w.document.activeElement,f.$('note'));
  assert.equal(f.saves.writes.length,2);assert.deepEqual(JSON.parse(f.saves.writes[1].value).documents.map(doc=>doc.key),['a','b']);
  f.saves.writes[1].commit();await newer;assert.equal(JSON.parse(f.w.localStorage.getItem(KEY)).documents[1].notes.one,'Concurrent B edit');
 }finally{await f.w.happyDOM.close();}
});
test('failed pending undo cannot open the provisional identity or lose concurrent B edits and its recovery slot',async()=>{
 const f=setup();try{
  f.w.document.querySelector('.library-remove').onclick();await f.$('confirm-removal').onclick();assert.equal(f.w.saveTest.active.key,'b');
  f.saves.hold();const undo=f.$('undo-removal').onclick();const provisional=f.w.document.querySelector('.library-entry[data-document-key="a"] .library-open');
  assert.equal(provisional.disabled,true);provisional.onclick();assert.equal(f.w.saveTest.active.key,'b','programmatic stale opener cannot select the provisional identity');
  f.note('B during Undo');f.$('note').focus();const flush=f.saves.store.flush();f.saves.writes[0].fail();await undo;
  assert.deepEqual(Array.from(f.w.saveTest.documents,doc=>doc.key),['b']);assert.equal(f.$('removal-recovery').hidden,false);assert.equal(f.$('note').value,'B during Undo');assert.equal(f.w.document.activeElement,f.$('note'));
  f.saves.writes[1].commit();await flush;assert.equal(JSON.parse(f.w.localStorage.getItem(KEY)).documents[0].notes.one,'B during Undo');
 }finally{await f.w.happyDOM.close();}
});
test('successful Undo receipt does not navigate away from a newer B draft',async()=>{
 const f=setup();try{
  f.w.document.querySelector('.library-remove').onclick();await f.$('confirm-removal').onclick();f.saves.hold();const undo=f.$('undo-removal').onclick();
  f.note('Keep typing B');f.$('note').focus();f.saves.writes[0].commit();await undo;
  assert.equal(f.w.saveTest.active.key,'b');assert.equal(f.$('note').value,'Keep typing B');assert.equal(f.w.document.activeElement,f.$('note'));assert.equal(f.saves.store.status('b').status,'pending');
  const flush=f.saves.store.flush();f.saves.writes[1].commit();await flush;
 }finally{await f.w.happyDOM.close();}
});
test('pending removal keeps its own glossary draft bundle and previous recovery slot through failure',async()=>{
 const f=setup({documents:[doc('a'),doc('b'),doc('c')]});try{
  f.w.document.querySelector('.library-entry[data-document-key="c"] .library-remove').onclick();await f.$('confirm-removal').onclick();
  f.$('mode-transcript').click();f.$('translation-glossary').value='source = 新草稿';f.$('translation-glossary').dispatchEvent(new f.w.Event('input',{bubbles:true}));
  f.saves.hold();f.w.document.querySelector('.library-entry[data-document-key="a"] .library-remove').onclick();const removal=f.$('confirm-removal').onclick();
  assert.match(f.$('removal-recovery-title').textContent,/c/);f.saves.writes[0].fail();await removal;
  assert.match(f.$('removal-recovery-title').textContent,/c/);assert.equal(f.w.saveTest.active.key,'a');assert.equal(f.$('translation-glossary').value,'source = 新草稿');assert.equal(f.unload(),true);
 }finally{await f.w.happyDOM.close();}
});
test('delayed import receipt cannot steal newer selection, focus, drafts or success notice',async()=>{
 const f=setup({held:true});try{
  const text=JSON.stringify({...doc('new'),title:'New import'});Object.defineProperty(f.$('file'),'files',{configurable:true,value:[{name:'new.json',size:text.length,text:async()=>text}]});
  const imported=f.$('file').onchange();for(let i=0;i<30&&!f.saves.writes.length;i++)await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(f.saves.writes.length,1);f.w.document.querySelector('.library-entry[data-document-key="b"] .library-open').click();
  f.$('ai-question').value='New B question';f.$('ai-question').focus();const notice=f.$('notice').textContent;
  f.saves.writes[0].commit();await imported;assert.equal(f.w.saveTest.active.key,'b');assert.equal(f.$('ai-question').value,'New B question');assert.equal(f.w.document.activeElement,f.$('ai-question'));assert.equal(f.$('notice').textContent,notice);
  assert.equal(JSON.parse(f.w.localStorage.getItem(KEY)).documents.length,3);
 }finally{await f.w.happyDOM.close();}
});

test('a retry receipt cannot announce all content saved while a newer note is still pending',async()=>{
 const f=setup({held:true});try{
  f.note('First failed');const initial=f.saves.store.flush();f.saves.writes[0].fail();await initial;
  const retry=f.$('retry-save').onclick();f.note('Newer while retry saves');const previousNotice=f.$('notice').textContent;
  f.saves.writes[1].commit();await retry;assert.equal(f.$('save-status').dataset.state,'pending');assert.equal(f.$('notice').textContent,previousNotice);
  assert.equal(f.$('note').value,'Newer while retry saves');const flush=f.saves.store.flush();f.saves.writes[2].commit();await flush;
 }finally{await f.w.happyDOM.close();}
});
