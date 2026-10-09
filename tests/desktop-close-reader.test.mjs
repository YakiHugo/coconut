import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url),key='coconut-reader-v1';
function setup(){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});
 w.coconutUpdates={state:async()=>({status:'idle',version:'test',arch:'arm64'}),subscribe:()=>{}};
 for(const file of ['summary','core'])w.eval(fs.readFileSync(new URL(`reader/${file}.js`,root),'utf8'));
 w.eval(['app','language','podcasts'].map(file=>fs.readFileSync(new URL(`reader/${file}.js`,root),'utf8')).join('\n')+'\nlet sourceSubmitting=false,sourceCaptionRequest=null;\n'+fs.readFileSync(new URL('reader/updates.js',root),'utf8')+'\nwindow.closeTest={start(){asking=true;summaryScope={stop:false};},revision:()=>localImportRevision,stopped:()=>summaryScope.stop,answer(question){active().ai_answers=[{question,answer:"Authored answer",citations:["demo-1"],provider:"fixture"}];save();},requests(){sourceCaptionRequest=new AbortController();podcastRequest=new AbortController();podcastMediaRequest=new AbortController();projectCaptionRequest={controller:new AbortController()};return [sourceCaptionRequest,podcastRequest,podcastMediaRequest,projectCaptionRequest.controller];}};');
 return {w,$:id=>w.document.getElementById(id)};
}
test('native snapshot detects changed dialog values and leaves untouched dialogs clean',async()=>{
 const {w,$}=setup();try{
  await $('sample').onclick();$('document-details').click();assert.equal(w.coconutPrepareClose('inspect').safe,true);
  $('document-title').value='New title';assert.equal(w.coconutPrepareClose('inspect').safe,false);assert.equal(w.coconutPrepareClose('safe'),false);assert.notEqual(w.document.body.inert,true);
  $('details-dialog').close();assert.equal(w.coconutPrepareClose('inspect').safe,true);
  assert.equal(w.coconutPrepareClose('safe'),true);assert.equal(w.document.body.inert,true);
 }finally{await w.happyDOM.close();}
});
test('storage failures stay unsafe even after an export attempt',async()=>{
 const {w,$}=setup();try{
  await $('sample').onclick();const backing=w.localStorage;Object.defineProperty(w,'localStorage',{value:{getItem:k=>backing.getItem(k),setItem(){throw Error('quota');}}});
  w.document.querySelector('.note-button').click();$('note').value='Unsaved note';$('note').dispatchEvent(new w.Event('input',{bubbles:true}));
  assert.equal(w.coconutPrepareClose('inspect').safe,false);$('export-library').click();assert.equal(w.coconutPrepareClose('inspect').safe,false);
  assert.equal(w.coconutPrepareClose('discard'),true);assert.equal(w.document.body.inert,true);
 }finally{await w.happyDOM.close();}
});
test('inspection leaves current summary consent and imports intact; discard retires them',async()=>{
 const {w,$}=setup();try{
  await $('sample').onclick();w.closeTest.start();$('ai-consent').checked=true;
  const before=w.closeTest.revision();assert.equal(w.coconutPrepareClose('inspect').safe,false);assert.equal(w.closeTest.stopped(),false);assert.equal($('ai-consent').checked,true);assert.equal(w.closeTest.revision(),before);
  w.coconutPrepareClose('discard');assert.equal(w.closeTest.stopped(),true);assert.equal($('ai-consent').checked,false);assert.equal(w.closeTest.revision(),before+1);
 }finally{await w.happyDOM.close();}
});
for(const discard of [false,true])test(`pending restore ${discard?'cannot commit after approved discard':'still completes after read-only close inspection'}`,async()=>{
 const {w,$}=setup();try{
  let resolve;const pending=new Promise(r=>resolve=r);
  const backup={format:'coconut-library',version:1,documents:[{key:'restore',schema_version:1,title:'Restore fixture',language:'en',segments:[{id:'one',start:0,end:4,text:'Authored fixture'}]}],active:'restore'};
  Object.defineProperty($('library-file'),'files',{configurable:true,value:[{size:100,text:()=>pending}]});
  const restore=$('library-file').onchange();assert.equal(w.coconutPrepareClose('inspect').safe,false);
  if(discard)assert.equal(w.coconutPrepareClose('discard'),true);
  resolve(JSON.stringify(backup));await restore;
  const saved=JSON.parse(w.localStorage.getItem(key)||'{"documents":[]}');assert.equal(saved.documents.length,discard?0:1);
 }finally{await w.happyDOM.close();}
});

test('an already saved question is not an unsubmitted draft',async()=>{
 const {w,$}=setup();try{
  await $('sample').onclick();$('ai-question').value='Authored question';assert.equal(w.coconutPrepareClose('inspect').safe,false);
  w.closeTest.answer('Authored question');assert.equal(w.coconutPrepareClose('inspect').safe,true);
  $('ai-question').value='Different question';assert.equal(w.coconutPrepareClose('inspect').safe,false);
 }finally{await w.happyDOM.close();}
});
test('approved discard cannot write a late AI answer over the saved library',async()=>{
 const {w,$}=setup();try{
  await $('sample').onclick();const saved=w.localStorage.getItem(key);
  w.closeTest.start();assert.equal(w.coconutPrepareClose('discard'),true);
  w.closeTest.answer('A late current-batch answer');assert.equal(w.localStorage.getItem(key),saved);
  w.coconutPrepareClose('release');assert.equal(w.coconutPrepareClose('inspect').safe,false);assert.equal(w.document.body.inert,false);
 }finally{await w.happyDOM.close();}
});
test('canceled local media picker is clean and does not strand update readiness',async()=>{
 const {w,$}=setup();try{
  await $('sample').onclick();$('attach-reader-media').click();$('reader-media-file').dispatchEvent(new w.Event('cancel'));
  assert.equal(w.coconutPrepareClose('inspect').safe,true);assert.equal(w.coconutPrepareUpdate(),true);
 }finally{await w.happyDOM.close();}
});

test('only approved close aborts caption and publisher request owners',async()=>{
 const {w,$}=setup();try{
  await $('sample').onclick();const controllers=w.closeTest.requests();
  w.coconutPrepareClose('inspect');assert.equal(controllers.some(c=>c.signal.aborted),false);
  w.coconutPrepareClose('discard');assert.equal(controllers.every(c=>c.signal.aborted),true);
 }finally{await w.happyDOM.close();}
});
