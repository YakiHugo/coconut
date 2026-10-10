import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';

const root=new URL('../',import.meta.url),KEY='coconut-reader-v1';
const source=title=>({title,language:'en',segments:[{id:'cue',start:0,end:4,text:'Authored source for '+title}],notes:{cue:'Private note for '+title}});
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function setup(){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:{subtle:{digest:(...args)=>webcrypto.subtle.digest(...args)}}});
 w.fetch=()=>{throw new Error('File import must not send a network request');};
 w.eval(['summary','core','passages','passage-playback','app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
 const $=id=>w.document.getElementById(id),input=$('file');
 // The DOM shim cannot choose native files. Track the displayed selection to
 // prove a retired request cannot clear the next request's still-pending file.
 Object.defineProperty(input,'value',{configurable:true,writable:true,value:''});
 const choose=(doc,{text=async()=>JSON.stringify(doc),name=doc.title+'.json'}={})=>{
  Object.defineProperty(input,'files',{configurable:true,value:[{name,size:100,text}]});input.value=name;return input.onchange();
 };
 const library=()=>JSON.parse(w.localStorage.getItem(KEY)||'{"documents":[]}');
 const open=title=>[...$('library').querySelectorAll('.library-open')].find(button=>button.querySelector('.library-title').textContent===title).click();
 return {w,$,input,choose,library,open};
}
function holdDigest(w){
 const entered=deferred(),gate=deferred();let first=true;
 w.crypto.subtle.digest=async(...args)=>{if(first){first=false;entered.resolve();await gate.promise;}return webcrypto.subtle.digest(...args);};
 return {entered:entered.promise,release:gate.resolve};
}

test('slow first fingerprint cannot save or reopen after a newer file succeeds',async()=>{
 const {w,$,input,choose,library}=setup();const hold=holdDigest(w);let pending;
 try{
  pending=choose(source('Old selection'));await hold.entered;
  await choose(source('Latest selection'));assert.equal($('title').textContent,'Latest selection');
  $('mode-transcript').click();w.document.querySelector('.note-button').click();
  $('note').value='A new private note';$('note').dispatchEvent(new w.Event('input'));
  $('ai-consent').checked=true;const saved=w.localStorage.getItem(KEY),message=$('notice').textContent;
  hold.release();await pending;
  assert.equal($('title').textContent,'Latest selection');assert.equal(w.localStorage.getItem(KEY),saved);
  assert.deepEqual(library().documents.map(doc=>doc.title),['Latest selection']);
  assert.equal($('note').value,'A new private note');assert.equal($('notes-panel').hidden,false);
  assert.equal($('ai-consent').checked,true);assert.equal($('notice').textContent,message);assert.equal(input.value,'');
 }finally{hold.release();await pending;await w.happyDOM.close();}
});

test('an old completion cannot clear the newer file while its read is pending',async()=>{
 const {w,input,choose,library}=setup();const hold=holdDigest(w),read=deferred();let first,second;
 try{
  first=choose(source('Old selection'));await hold.entered;
  second=choose(source('Latest selection'),{text:()=>read.promise});hold.release();await first;
  assert.equal(input.value,'Latest selection.json');assert.equal(library().documents.length,0);
  read.resolve(JSON.stringify(source('Latest selection')));await second;
  assert.equal(input.value,'');assert.deepEqual(library().documents.map(doc=>doc.title),['Latest selection']);
 }finally{hold.release();read.resolve(JSON.stringify(source('Latest selection')));await first;await second;await w.happyDOM.close();}
});

for(const returnToOriginal of [false,true])test(`library selection cancels pending import${returnToOriginal?' even after returning to the original document':''}`,async()=>{
 const {w,$,choose,library,open}=setup();let hold,pending;
 try{
  await choose(source('First existing'));await choose(source('Second existing'));
  hold=holdDigest(w);pending=choose(source('Abandoned import'));await hold.entered;
  open('First existing');if(returnToOriginal)open('Second existing');
  const saved=w.localStorage.getItem(KEY),expected=returnToOriginal?'Second existing':'First existing';
  hold.release();await pending;
  assert.equal($('title').textContent,expected);assert.equal(w.localStorage.getItem(KEY),saved);
  assert.equal(library().documents.length,2);assert.equal(library().documents[0].notes.cue,'Private note for First existing');
 }finally{hold?.release();await pending;await w.happyDOM.close();}
});

for(const from of ['read','add'])test(`leaving and returning to the ${from} workspace never revives an import`,async()=>{
 const {w,$,choose}=setup();let hold,pending;
 try{
  await choose(source('Existing'));if(from==='add')$('add-content').click();
  hold=holdDigest(w);pending=choose(source('Abandoned import'));await hold.entered;
  $(from==='read'?'add-content':'back-reading').click();$(from==='read'?'back-reading':'add-content').click();
  const saved=w.localStorage.getItem(KEY),message=$('notice').textContent;
  hold.release();await pending;
  assert.equal(w.document.body.dataset.workspace,from);assert.equal($('title').textContent,'Existing');
  assert.equal(w.localStorage.getItem(KEY),saved);assert.equal($('notice').textContent,message);
 }finally{hold?.release();await pending;await w.happyDOM.close();}
});

for(const failure of ['read','parse'])test(`stale ${failure} failure cannot replace a newer success notice`,async()=>{
 const {w,$,choose,library}=setup(),read=deferred();let pending;
 try{
  pending=choose(source('Old selection'),{text:()=>read.promise});await choose(source('Latest selection'));
  const message=$('notice').textContent;
  if(failure==='read')read.reject(new Error('Injected obsolete read error'));else read.resolve('invalid JSON');
  await pending;assert.equal($('notice').textContent,message);assert.equal($('title').textContent,'Latest selection');assert.equal(library().documents.length,1);
 }finally{read.resolve('{}');await pending;await w.happyDOM.close();}
});

test('abandoning a duplicate import never deletes the existing copy or its later notes',async()=>{
 const {w,$,choose,library}=setup();let hold,pending;
 try{
  const doc=source('Existing');await choose(doc);hold=holdDigest(w);pending=choose(doc);await hold.entered;
  $('add-content').click();$('back-reading').click();$('mode-transcript').click();w.document.querySelector('.note-button').click();
  $('note').value='Keep this latest edit';$('note').dispatchEvent(new w.Event('input'));const saved=w.localStorage.getItem(KEY);
  hold.release();await pending;
  assert.equal(w.localStorage.getItem(KEY),saved);assert.equal(library().documents.length,1);assert.equal(library().documents[0].notes.cue,'Keep this latest edit');assert.equal($('notes-panel').hidden,false);
 }finally{hold?.release();await pending;await w.happyDOM.close();}
});

test('current failures are visible and a normal same-file retry remains idempotent',async()=>{
 const {w,$,input,choose,library}=setup();
 try{
  const doc=source('Retry');await choose(doc,{text:async()=>{throw new Error('Injected current read error');}});
  assert.match($('notice').textContent,/导入失败.*Injected current read error/);assert.equal(input.value,'');assert.equal(library().documents.length,0);
  await choose(doc,{text:async()=>'{'});assert.match($('notice').textContent,/导入失败/);assert.equal(input.value,'');
  await choose(doc);const original=library().documents[0];await choose(doc);
  assert.equal($('title').textContent,'Retry');assert.match($('notice').textContent,/已导入并保存在本机浏览器/);
  assert.equal(input.value,'');assert.equal(library().documents.length,1);assert.deepEqual(library().documents[0],original);
 }finally{await w.happyDOM.close();}
});

test('an abandoned selection can be chosen again without reviving its old request',async()=>{
 const {w,$,input,choose,library}=setup();let hold,pending;
 try{
  await choose(source('Existing'));const doc=source('Retry after navigation');
  hold=holdDigest(w);pending=choose(doc);await hold.entered;$('add-content').click();$('back-reading').click();
  assert.equal(input.value,'','navigation clears only the abandoned selection for a same-file retry');
  await choose(doc);const saved=w.localStorage.getItem(KEY);hold.release();await pending;
  assert.equal(w.localStorage.getItem(KEY),saved);assert.equal($('title').textContent,doc.title);assert.equal(library().documents.length,2);
 }finally{hold?.release();await pending;await w.happyDOM.close();}
});

test('a newer invalid file still retires a pending valid selection',async()=>{
 const {w,$,choose,library}=setup();const hold=holdDigest(w);let pending;
 try{
  pending=choose(source('Old selection'));await hold.entered;await choose(source('New invalid selection'),{text:async()=>'{'});
  const message=$('notice').textContent;assert.match(message,/导入失败/);hold.release();await pending;
  assert.equal($('notice').textContent,message);assert.equal(library().documents.length,0);assert.equal(w.document.body.dataset.workspace,'add');
 }finally{hold.release();await pending;await w.happyDOM.close();}
});

test('opening then canceling file or restore pickers does not abandon a selected import',async()=>{
 const {w,$,choose,library}=setup();const hold=holdDigest(w);let pending;
 try{
  pending=choose(source('Still selected'));await hold.entered;
  for(const [button,input] of [['import','file'],['restore-library','library-file']]){
   $(button).click();$(input).dispatchEvent(new w.Event('cancel'));
   Object.defineProperty($(input),'files',{configurable:true,value:[]});await $(input).onchange();
  }
  hold.release();await pending;assert.equal($('title').textContent,'Still selected');assert.equal(library().documents.length,1);
 }finally{hold.release();await pending;await w.happyDOM.close();}
});

test('same-document views, filters, notes and read-only backup do not cancel a selected import',async()=>{
 const {w,$,choose,library}=setup();let hold,pending;
 try{
  await choose(source('Existing'));hold=holdDigest(w);pending=choose(source('Selected import'));await hold.entered;
  $('mode-transcript').click();w.document.querySelector('.note-button').click();$('note').value='A preserved note';$('note').dispatchEvent(new w.Event('input'));
  $('search').value='Authored';$('search').dispatchEvent(new w.Event('input'));$('filter-notes').click();$('clear-search').click();$('mode-summary').click();
  w.URL.createObjectURL=()=> 'blob:authored-backup';w.URL.revokeObjectURL=()=>{};$('export-library').click();
  assert.match($('notice').textContent,/备份下载/);hold.release();await pending;
  assert.equal($('title').textContent,'Selected import');assert.equal(library().documents.length,2);assert.equal(library().documents[0].notes.cue,'A preserved note');
 }finally{hold?.release();await pending;await w.happyDOM.close();}
});

test('explicit sample navigation retires a pending local import',async()=>{
 const {w,$,choose,library}=setup();const hold=holdDigest(w);let pending;
 try{
  pending=choose(source('Abandoned import'));await hold.entered;await $('sample').onclick();const saved=w.localStorage.getItem(KEY);
  hold.release();await pending;assert.equal(w.localStorage.getItem(KEY),saved);assert.equal(library().documents.length,1);
  assert.equal($('title').textContent,'把好想法，变成自己的想法');assert.equal($('mode-bilingual').getAttribute('aria-pressed'),'true');
 }finally{hold.release();await pending;await w.happyDOM.close();}
});

test('starting a selected library restore retires the file before the backup is read',async()=>{
 const {w,$,choose,library}=setup();const read=deferred();let hold,pending,restoring;
 try{
  await choose(source('Existing'));const backup={format:'coconut-library',version:1,...library()};
  hold=holdDigest(w);pending=choose(source('Abandoned import'));await hold.entered;
  const input=$('library-file');Object.defineProperty(input,'files',{configurable:true,value:[{name:'backup.json',size:100,text:()=>read.promise}]});
  restoring=input.onchange();hold.release();await pending;
  assert.deepEqual(library().documents.map(doc=>doc.title),['Existing']);
  read.resolve(JSON.stringify(backup));await restoring;
  assert.match($('notice').textContent,/已恢复 0 份文字稿/);assert.equal(library().documents.length,1);assert.equal(library().documents[0].notes.cue,'Private note for Existing');
 }finally{hold?.release();read.resolve('{}');await pending;await restoring;await w.happyDOM.close();}
});

test('opening a document through the shared add path cannot be replaced by a pending local file',async()=>{
 const {w,$,choose,library}=setup();const hold=holdDigest(w);let pending;
 try{
  pending=choose(source('Abandoned local file'));await hold.entered;
  // A completed server job uses this same production add path without calling
  // showWorkspace: it sets the active document and workspace during the commit.
  await w.add(w.Coconut.validate(source('Opened job result')));const saved=w.localStorage.getItem(KEY),message=$('notice').textContent;
  hold.release();await pending;
  assert.equal(w.localStorage.getItem(KEY),saved);assert.equal($('title').textContent,'Opened job result');assert.equal(library().documents.length,1);assert.equal($('notice').textContent,message);
 }finally{hold.release();await pending;await w.happyDOM.close();}
});

test('pagehide abandons a pending file across simulated page restoration and allows explicit retry',async()=>{
 const {w,$,input,choose,library}=setup();let hold,pending;
 try{
  await choose(source('Existing'));const doc=source('Retry after page restoration');
  hold=holdDigest(w);pending=choose(doc);await hold.entered;
  // Native event simulation only; actual browser BFCache behavior is not tested.
  for(const type of ['pagehide','pageshow']){
   const event=new w.Event(type);Object.defineProperty(event,'persisted',{value:true});w.dispatchEvent(event);
  }
  const saved=w.localStorage.getItem(KEY),message=$('notice').textContent;
  hold.release();await pending;
  assert.equal(w.localStorage.getItem(KEY),saved);assert.equal($('title').textContent,'Existing');assert.equal(w.document.body.dataset.workspace,'read');
  assert.equal($('notice').textContent,message);assert.equal(input.value,'');assert.equal(library().documents.length,1);
  await choose(doc);assert.equal($('title').textContent,doc.title);assert.equal(library().documents.length,2);assert.match($('notice').textContent,/已导入并保存在本机浏览器/);
 }finally{hold?.release();await pending;await w.happyDOM.close();}
});
