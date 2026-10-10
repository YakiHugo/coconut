import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {installSavePipeline,settle} from './helpers/save-pipeline.mjs';

const root=new URL('../',import.meta.url),KEY='coconut-reader-v1';
const source=title=>({title,language:'en',segments:[{id:'cue',start:0,end:4,text:'Authored source for '+title}],notes:{cue:'Private note for '+title}});
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function setup(){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];Object.defineProperty(w,'crypto',{value:webcrypto});
 w.fetch=()=>{throw new Error('Local import and restore must not send a network request');};
 installSavePipeline(w);
 w.eval(['summary','core','passages','passage-playback','app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
 const $=id=>w.document.getElementById(id);
 for(const id of ['file','library-file'])Object.defineProperty($(id),'value',{configurable:true,writable:true,value:''});
 const choose=(kind,data,{text=async()=>JSON.stringify(data),name=kind+'.json'}={})=>{
  const input=$(kind==='file'?'file':'library-file');Object.defineProperty(input,'files',{configurable:true,value:[{name,size:100,text}]});input.value=name;return input.onchange();
 };
 const library=()=>JSON.parse(w.localStorage.getItem(KEY)||'{"documents":[]}');
 const backup=title=>({format:'coconut-library',version:1,active:title,documents:[{...w.Coconut.validate(source(title)),key:title}]});
 const open=title=>[...$('library').querySelectorAll('.library-open')].find(button=>button.querySelector('.library-title').textContent===title).click();
 return {w,$,choose,library,backup,open};
}

test('a stale restore cannot replace a newer file, its open note, consent or success notice',async()=>{
 const {w,$,choose,library,backup}=setup(),read=deferred();let pending;
 try{
  await choose('file',source('Existing'));pending=choose('restore',backup('Old backup'),{text:()=>read.promise});
  await choose('file',source('New current file'));$('mode-transcript').click();w.document.querySelector('.note-button').click();
  $('note').value='New saved note';$('note').dispatchEvent(new w.Event('input'));$('note').focus();$('ai-consent').checked=true;
  const saved=w.localStorage.getItem(KEY),message=$('notice').textContent;read.resolve(JSON.stringify(backup('Old backup')));await pending;
  assert.equal(w.localStorage.getItem(KEY),saved);assert.equal($('title').textContent,'New current file');assert.equal(library().documents.length,2);
  assert.equal($('note').value,'New saved note');assert.equal($('notes-panel').hidden,false);assert.equal(w.document.activeElement,$('note'));
  assert.equal($('ai-consent').checked,true);assert.equal($('notice').textContent,message);
 }finally{read.resolve('{}');await pending;await w.happyDOM.close();}
});

for(const [oldKind,newKind] of [['restore','file'],['restore','restore'],['file','restore']])test(`${newKind} selection supersedes pending ${oldKind} without losing the newer input`,async()=>{
 const {w,$,choose,library,backup}=setup(),oldRead=deferred(),newRead=deferred();let oldRun,newRun;
 const oldData=oldKind==='file'?source('Old selection'):backup('Old selection'),newData=newKind==='file'?source('New selection'):backup('New selection');
 try{
  await choose('file',source('Existing'));oldRun=choose(oldKind,oldData,{text:()=>oldRead.promise,name:'old.json'});
  newRun=choose(newKind,newData,{text:()=>newRead.promise,name:'new.json'});const saved=w.localStorage.getItem(KEY),message=$('notice').textContent;
  oldRead.resolve(JSON.stringify(oldData));await oldRun;
  assert.equal(w.localStorage.getItem(KEY),saved);assert.equal($('title').textContent,'Existing');assert.equal($('notice').textContent,message);
  assert.equal($(newKind==='file'?'file':'library-file').value,'new.json');
  newRead.resolve(JSON.stringify(newData));await newRun;
  assert.equal($('title').textContent,'New selection');assert.deepEqual(library().documents.map(doc=>doc.title),['Existing','New selection']);
  assert.equal($('file').value,'');assert.equal($('library-file').value,'');
 }finally{oldRead.resolve('{}');newRead.resolve(JSON.stringify(newData));await oldRun;await newRun;await w.happyDOM.close();}
});

for(const navigation of ['library-return','read-return','add-return','sample','pagehide'])test(`${navigation} permanently retires an unread restore and permits an explicit retry`,async()=>{
 const {w,$,choose,library,backup,open}=setup(),read=deferred();let pending;
 try{
  await choose('file',source('First existing'));await choose('file',source('Second existing'));if(navigation==='add-return')$('add-content').click();
  const data=backup('Retry backup');pending=choose('restore',data,{text:()=>read.promise});
  if(navigation==='library-return'){open('First existing');open('Second existing');}
  if(navigation==='read-return'){$('add-content').click();$('back-reading').click();}
  if(navigation==='add-return'){$('back-reading').click();$('add-content').click();}
  if(navigation==='sample')await $('sample').onclick();
  if(navigation==='pagehide')for(const type of ['pagehide','pageshow']){const event=new w.Event(type);Object.defineProperty(event,'persisted',{value:true});w.dispatchEvent(event);}
  const saved=w.localStorage.getItem(KEY),message=$('notice').textContent,title=$('title').textContent,workspace=w.document.body.dataset.workspace;
  assert.equal($('library-file').value,'','abandonment clears the old selection for native same-file retry');
  read.resolve(JSON.stringify(data));await pending;
  assert.equal(w.localStorage.getItem(KEY),saved);assert.equal($('notice').textContent,message);assert.equal($('title').textContent,title);assert.equal(w.document.body.dataset.workspace,workspace);
  await choose('restore',data);assert.equal($('title').textContent,'Retry backup');assert.equal(library().documents.filter(doc=>doc.title==='Retry backup').length,1);
 }finally{read.resolve('{}');await pending;await w.happyDOM.close();}
});

for(const failure of ['read','parse'])for(const newKind of ['file','restore'])test(`stale restore ${failure} failure cannot replace newer ${newKind} success`,async()=>{
 const {w,$,choose,backup}=setup(),read=deferred();let pending;
 try{
  pending=choose('restore',backup('Old backup'),{text:()=>read.promise});await choose(newKind,newKind==='file'?source('Latest'):backup('Latest'));
  const saved=w.localStorage.getItem(KEY),message=$('notice').textContent;
  if(failure==='read')read.reject(new Error('Obsolete restore read error'));else read.resolve('{');
  await pending;assert.equal(w.localStorage.getItem(KEY),saved);assert.equal($('notice').textContent,message);assert.equal($('title').textContent,'Latest');
 }finally{read.resolve('{}');await pending;await w.happyDOM.close();}
});

test('restore remains additive and backup.active remains authoritative after neutral reader actions',async()=>{
 const {w,$,choose,library}=setup(),read=deferred();let pending;
 try{
  await choose('file',source('Existing'));const original=library(),originalActive=w.sessionStorage.getItem('coconut-reader-active-v1'),data={format:'coconut-library',version:1,...original,active:originalActive};
  pending=choose('restore',data,{text:()=>read.promise});$('mode-transcript').click();w.document.querySelector('.note-button').click();$('note').value='Latest live note';$('note').dispatchEvent(new w.Event('input'));
  $('search').value='Authored';$('search').dispatchEvent(new w.Event('input'));$('filter-notes').click();$('clear-search').click();$('mode-summary').click();
  for(const [button,input] of [['import','file'],['restore-library','library-file']]){$(button).click();$(input).dispatchEvent(new w.Event('cancel'));Object.defineProperty($(input),'files',{configurable:true,value:[]});await $(input).onchange();}
  w.URL.createObjectURL=()=> 'blob:authored-backup';w.URL.revokeObjectURL=()=>{};$('export-library').click();
  read.resolve(JSON.stringify(data));await pending;const after=library(),afterActive=w.sessionStorage.getItem('coconut-reader-active-v1');
  assert.equal(after.documents.length,2,'a changed live document and its backup are separately retained');
  assert.equal(after.documents.find(doc=>doc.key===originalActive).notes.cue,'Latest live note');
  assert.notEqual(afterActive,originalActive);assert.equal(after.documents.find(doc=>doc.key===afterActive).notes.cue,'Private note for Existing');
  assert.match($('notice').textContent,/已恢复 1 份文字稿/);await choose('restore',data);assert.equal(library().documents.length,2);assert.equal(w.sessionStorage.getItem('coconut-reader-active-v1'),afterActive);assert.match($('notice').textContent,/已恢复 0 份文字稿/);
 }finally{read.resolve('{}');await pending;await w.happyDOM.close();}
});

test('current restore failures remain visible and explicit retry keeps all pre-existing data',async()=>{
 const {w,$,choose,library,backup}=setup();
 try{
  await choose('file',source('Existing'));const saved=w.localStorage.getItem(KEY);
  await choose('restore',null,{text:async()=>{throw new Error('Current restore error');}});assert.match($('notice').textContent,/恢复失败.*Current restore error/);assert.equal($('library-file').value,'');
  await choose('restore',null,{text:async()=>'{'});assert.match($('notice').textContent,/恢复失败/);assert.equal(w.localStorage.getItem(KEY),saved);
  await choose('restore',backup('Retry'));assert.equal(library().documents.length,2);assert.equal(library().documents[0].notes.cue,'Private note for Existing');assert.equal($('title').textContent,'Retry');
 }finally{await w.happyDOM.close();}
});

test('a direct add context change retires a pending restore',async()=>{
 const {w,$,choose,backup}=setup(),read=deferred();let pending;
 try{
  pending=choose('restore',backup('Old backup'),{text:()=>read.promise});await w.add(w.Coconut.validate(source('Opened job result')));
  const saved=w.localStorage.getItem(KEY),message=$('notice').textContent;read.resolve(JSON.stringify(backup('Old backup')));await pending;
  assert.equal(w.localStorage.getItem(KEY),saved);assert.equal($('title').textContent,'Opened job result');assert.equal($('notice').textContent,message);
 }finally{read.resolve('{}');await pending;await w.happyDOM.close();}
});

test('an empty backup succeeds in an empty library without losing its completion notice',async()=>{
 const {w,$,choose,library}=setup();
 try{
  await choose('restore',{format:'coconut-library',version:1,documents:[],active:null});
  assert.deepEqual(library(),{documents:[]});assert.equal(w.sessionStorage.getItem('coconut-reader-active-v1'),null);assert.equal(w.document.body.dataset.workspace,'add');
  assert.match($('notice').textContent,/已恢复 0 份文字稿/);assert.equal($('library-file').value,'');
 }finally{await w.happyDOM.close();}
});
