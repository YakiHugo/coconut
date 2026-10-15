/** Exact target + explicit cue context. Authored fixtures, no real provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {libraryHarness} from './helpers/large-library-harness.mjs';
const fixture=()=>({key:'selection',title:'Authored selection',language:'en',segments:[{id:'a',start:0,end:2,text:'Repeated repeated 🌴',speaker:'A'},{id:'b',start:2,end:4,text:'words 中文。',speaker:'A'}],notes:{a:'Private note must not enter context'}});
function setup(documents=[fixture()]){return libraryHarness(documents,{localService:true,probe:true,configureCore(w){w.eval(fs.readFileSync(new URL('../reader/quotation.js',import.meta.url),'utf8'));}});}
function select(w,from=9,to=20){const text=w.document.querySelector('.passage-cue').firstChild,range=w.document.createRange();range.setStart(text,from);range.setEnd(text,to);w.getSelection().removeAllRanges();w.getSelection().addRange(range);return range;}
const settle=async fn=>{for(let i=0;i<100&&!fn();i++)await new Promise(r=>setTimeout(r,10));assert.ok(fn());};

test('explain and translate retain exact selected text, use only containing cues, and require fresh consent',async()=>{
 for(const intent of ['explain','translate']){
  const {w,$}=setup();try{
   select(w);const doc=w.libraryProbe.documents[0],before=JSON.stringify(doc),session=w.CoconutSelectionActions.capture();
   assert.equal(session.text,'repeated 🌴');assert.equal(Object.isFrozen(session),true);
   assert.equal(session.run(intent),true);assert.equal($('passage-question-dialog').open,true);
   assert.equal($('passage-selection-text').textContent,'repeated 🌴');assert.equal($('passage-selection-target').hidden,false);
   assert.match($('ai-question').value,/请(解释|翻译)/);assert.doesNotMatch($('ai-question').value,/repeated/);
   assert.equal($('passage-question-preview').querySelectorAll('.passage-question-original').length,1);
   assert.equal($('passage-question-preview').querySelector('.passage-question-original').textContent,doc.segments[0].text);
   assert.match($('passage-question-state').textContent,/完整原片段作为上下文/);assert.equal($('ai-consent').checked,false);
   assert.equal($('ai-request-panel').parentElement,$('passage-question-slot'));assert.equal(w.document.querySelectorAll('#ai-request-panel').length,1);
   assert.equal(JSON.stringify(doc),before);$('close-passage-question').click();assert.equal(w.document.activeElement,w.document.querySelector('.passage-quote'));
  }finally{await w.happyDOM.close();}
 }
});
test('cross-cue target is exact, including separator; translation/mixed UI/empty selections have no action',async()=>{
 const {w,$}=setup();try{
  const cues=w.document.querySelectorAll('.passage-cue'),r=select(w);r.setEnd(cues[1].firstChild,5);
  assert.equal(w.CoconutSelectionActions.capture().text,'repeated 🌴 words');
  r.setEnd(w.document.querySelector('.passage-quote').firstChild,2);assert.equal(w.CoconutSelectionActions.capture(),null);
  w.getSelection().removeAllRanges();assert.equal(w.CoconutSelectionActions.capture(),null);
 }finally{await w.happyDOM.close();}
});
test('captured actions reject stale source, metadata, detached paragraph and document ABA',async()=>{
 for(const change of ['text','metadata','render','navigation']){
  const {w,$}=setup();try{
   select(w);const action=w.CoconutSelectionActions.capture(),doc=w.libraryProbe.documents[0];
   if(change==='text')doc.segments[0].text+=' changed';
   if(change==='metadata')doc.title+=' changed';
   if(change==='render')w.libraryProbe.render();
   if(change==='navigation'){$('mode-transcript').click();$('mode-passages').click();}
   assert.equal(action.isCurrent(),false);assert.equal(action.run('translate'),false);assert.equal($('passage-question-dialog').open,false);
  }finally{await w.happyDOM.close();}
 }
});
test('keyboard quotation fallback exposes the same exact action and stale selection cannot be refreshed into new text',async()=>{
 const {w,$}=setup();try{
  w.document.querySelector('.passage-quote').click();$('quotation-source').setSelectionRange(9,20);$('quotation-preview-selection').click();
  const action=w.CoconutSelectionActions.preview();assert.equal(action.text,'repeated 🌴');assert.equal(action.run('explain'),true);assert.equal($('quotation-dialog').open,false);
  w.libraryProbe.documents[0].segments[0].text='Changed original';$('ai-question').oninput();
  assert.equal($('refresh-passage-question').hidden,true);assert.match($('passage-question-state').textContent,/返回阅读重新选择/);assert.equal($('ai-consent').checked,false);
 }finally{await w.happyDOM.close();}
});
test('React mounts contextual actions in quotation modal; no duplicate composer or automatic request',async()=>{
 const {w,$}=setup();try{
  w.eval(fs.readFileSync(new URL('../reader/transcript-navigator.js',import.meta.url),'utf8'));await settle(()=>w.document.body.dataset.transcriptNavigation==='ready');
  w.document.querySelector('.passage-quote').click();$('quotation-source').setSelectionRange(9,20);$('quotation-preview-selection').click();
  await settle(()=>$('quotation-context-actions').querySelectorAll('button').length===2);
  $('quotation-context-actions').querySelector('button').click();await settle(()=>$('passage-question-dialog').open);
  assert.equal($('passage-selection-text').textContent,'repeated 🌴');assert.equal($('ai-consent').checked,false);
  $('close-passage-question').click();await settle(()=>!$('quotation-context-actions').querySelector('button'));
 }finally{await w.happyDOM.close();}
});

test('only explicit consent sends the exact selection question with full source context and saves compatible history',async()=>{
 const {w,$}=setup();try{
  const requests=[];w.fetch=async(url,options)=>{
   if(url.endsWith('language-tools'))return {ok:true,json:async()=>({ai:{codex:{ready:true},claude:{ready:true}}})};
   requests.push(JSON.parse(options.body));return {ok:true,json:async()=>({answer:'Authored selected-text answer.',citations:['a'],provider:'fixture'})};
  };
  select(w);w.CoconutSelectionActions.capture().run('translate');assert.equal(requests.length,0);
  await $('check-ai').onclick();await $('ask-ai').onclick();assert.equal(requests.length,0);
  $('ai-consent').checked=true;$('ai-consent').onchange();await $('ask-ai').onclick();
  assert.equal(requests.length,1);assert.match(requests[0].question,/所选原文：\nrepeated 🌴\n【所选原文结束】$/);
  assert.deepEqual(requests[0].segments,[{id:'a',text:'Repeated repeated 🌴'}]);assert.doesNotMatch(JSON.stringify(requests),/Private note/);
  const doc=w.libraryProbe.documents[0],answer=doc.ai_answers.at(-1);assert.match(answer.question,/所选原文：\nrepeated 🌴\n【所选原文结束】$/);
  assert.equal(w.Coconut.answerFreshness(answer,doc),'current');assert.equal(doc.segments[0].translations?.zh,undefined);
 }finally{await w.happyDOM.close();}
});

test('floating React actions respect Escape, IME composition and focused inputs',async()=>{
 const {w,$}=setup();try{
  w.Range.prototype.getBoundingClientRect=()=>({left:20,right:150,top:100,bottom:120});
  w.eval(fs.readFileSync(new URL('../reader/transcript-navigator.js',import.meta.url),'utf8'));await settle(()=>w.document.body.dataset.transcriptNavigation==='ready');
  select(w);w.document.dispatchEvent(new w.Event('selectionchange'));await settle(()=>w.document.querySelector('.selection-actions'));
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape'}));w.document.dispatchEvent(new w.KeyboardEvent('keyup',{key:'Escape'}));await settle(()=>!w.document.querySelector('.selection-actions'));
  w.document.dispatchEvent(new w.Event('selectionchange'));await settle(()=>w.document.querySelector('.selection-actions'));
  w.document.dispatchEvent(new w.Event('compositionstart'));await settle(()=>!w.document.querySelector('.selection-actions'));
  w.document.dispatchEvent(new w.Event('selectionchange'));assert.equal(w.document.querySelector('.selection-actions'),null);
  $('search').focus();w.document.dispatchEvent(new w.Event('compositionend'));await new Promise(r=>setTimeout(r,20));assert.equal(w.document.querySelector('.selection-actions'),null);
  assert.equal(w.CoconutSelectionActions.capture(),null);
 }finally{await w.happyDOM.close();}
});

test('target trailing whitespace survives request trimming and empty intervening cues remain explicit context',async()=>{
 const doc={key:'spaces',title:'Exact source',segments:[{id:'a',start:0,end:1,text:'one two  '},{id:'empty',start:1,end:2,text:''},{id:'c',start:2,end:3,text:'three'}],notes:{}};
 const {w,$}=libraryHarness([doc],{localService:true,probe:true,configureCore(w){w.eval(fs.readFileSync(new URL('../reader/quotation.js',import.meta.url),'utf8'));}});
 try{
  const spans=w.document.querySelectorAll('.passage-cue'),range=w.document.createRange();range.setStart(spans[0].firstChild,4);range.setEnd(spans[0].firstChild,9);w.getSelection().addRange(range);
  const action=w.CoconutSelectionActions.capture();assert.equal(action.text,'two  ');action.run('translate');
  const requests=[];w.fetch=async(url,options)=>url.endsWith('language-tools')?{ok:true,json:async()=>({ai:{codex:{ready:true}}})}:{ok:true,json:async()=>{requests.push(JSON.parse(options.body));return {answer:'Authored answer',citations:['a'],provider:'fixture'};}};
  await $('check-ai').onclick();$('ai-consent').checked=true;$('ai-consent').onchange();await $('ask-ai').onclick();assert.ok(requests[0].question.includes('所选原文：\ntwo  \n【所选原文结束】'));$('close-passage-question').click();
  const current=w.document.querySelectorAll('.passage-cue'),cross=w.document.createRange();cross.setStart(current[0].firstChild,4);cross.setEnd(current[2].firstChild,5);w.getSelection().removeAllRanges();w.getSelection().addRange(cross);
  assert.equal(w.CoconutSelectionActions.capture().run('explain'),true);assert.equal($('passage-question-dialog').open,true);
  assert.deepEqual([...$('passage-question-preview').querySelectorAll('[data-cue-id]')].map(n=>n.dataset.cueId),['a','empty','c']);
 }finally{await w.happyDOM.close();}
});
test('reselection immediately removes old React actions until a new preview is accepted',async()=>{
 const {w,$}=setup();try{
  w.eval(fs.readFileSync(new URL('../reader/transcript-navigator.js',import.meta.url),'utf8'));await settle(()=>w.document.body.dataset.transcriptNavigation==='ready');
  w.document.querySelector('.passage-quote').click();$('quotation-source').setSelectionRange(9,20);$('quotation-preview-selection').click();await settle(()=>$('quotation-context-actions').querySelector('button'));
  $('quotation-reselect').click();await settle(()=>!$('quotation-context-actions').querySelector('button'));assert.equal(w.CoconutSelectionActions.preview(),null);
 }finally{await w.happyDOM.close();}
});

test('selection draft returns after Close or Escape, retains edited instruction, and never retains consent',async()=>{
 for(const dismissal of ['close','escape']){
  const {w,$}=setup();try{
   select(w);w.CoconutSelectionActions.capture().run('explain');$('ai-question').value='Explain this in one sentence.';$('ai-question').oninput();$('ai-consent').checked=true;
   if(dismissal==='close')$('close-passage-question').click();else $('passage-question-dialog').dispatchEvent(new w.Event('cancel',{cancelable:true}));
   assert.equal($('passage-question-return').hidden,false);assert.equal($('ai-question').value,'');
   const unload=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true);
   $('return-passage-question').click();assert.equal($('passage-selection-text').textContent,'repeated 🌴');assert.equal($('ai-question').value,'Explain this in one sentence.');assert.equal($('ai-consent').checked,false);
   $('close-passage-question').click();w.libraryProbe.documents[0].segments[0].text='Edited while closed';$('return-passage-question').click();assert.match($('passage-question-state').textContent,/返回阅读重新选择/);
  }finally{await w.happyDOM.close();}
 }
});
test('new selection replaces retained target and document navigation retires the return owner',async()=>{
 const {w,$}=setup([fixture(),{...fixture(),key:'other',title:'Other source'}]);try{
  select(w);w.CoconutSelectionActions.capture().run('explain');$('close-passage-question').click();
  select(w,0,8);w.CoconutSelectionActions.capture().run('translate');assert.equal($('passage-selection-text').textContent,'Repeated');$('close-passage-question').click();
  $('library').querySelector('[data-document-key="other"] .library-open').click();assert.equal($('passage-question-return').hidden,true);assert.equal($('ai-question').value,'');
  $('library').querySelector('[data-document-key="selection"] .library-open').click();assert.equal($('passage-question-return').hidden,true);
 }finally{await w.happyDOM.close();}
});
test('focus alone dismisses floating actions without waiting for selection or composition events',async()=>{
 const {w,$}=setup();try{
  w.Range.prototype.getBoundingClientRect=()=>({left:20,right:150,top:100,bottom:120});
  w.eval(fs.readFileSync(new URL('../reader/transcript-navigator.js',import.meta.url),'utf8'));await settle(()=>w.document.body.dataset.transcriptNavigation==='ready');
  select(w);w.document.dispatchEvent(new w.Event('selectionchange'));await settle(()=>w.document.querySelector('.selection-actions'));
  $('search').focus();await settle(()=>!w.document.querySelector('.selection-actions'));
 }finally{await w.happyDOM.close();}
});

test('citation detour returns exact selected target and a deliberate new generic question retires the old draft',async()=>{
 const {w,$}=setup();try{
  w.fetch=async url=>url.endsWith('language-tools')?{ok:true,json:async()=>({ai:{codex:{ready:true}}})}:{ok:true,json:async()=>({answer:'Authored result',citations:['a'],provider:'fixture'})};
  select(w);w.CoconutSelectionActions.capture().run('explain');await $('check-ai').onclick();$('ai-consent').checked=true;$('ai-consent').onchange();await $('ask-ai').onclick();
  $('ai-answers').querySelector('.ai-answer > button').click();assert.equal($('passage-question-return').hidden,false);$('return-passage-question').click();
  assert.equal($('passage-selection-text').textContent,'repeated 🌴');assert.equal($('ai-consent').checked,false);
  $('close-passage-question').click();$('ai-question').value='A different general question';$('ai-question').oninput();assert.equal($('passage-question-return').hidden,true);
 }finally{await w.happyDOM.close();}
});

test('local connection setup detour preserves selected target and instruction without preserving consent',async()=>{
 const {w,$}=setup();try{
  select(w);w.CoconutSelectionActions.capture().run('explain');$('ai-question').value='Keep my authored instruction';$('ai-question').oninput();$('ai-consent').checked=true;
  $('passage-question-setup').click();assert.equal(w.document.body.dataset.workspace,'add');assert.equal($('ai-question').value,'');
  $('back-reading').click();$('return-passage-question').click();assert.equal($('passage-selection-text').textContent,'repeated 🌴');assert.equal($('ai-question').value,'Keep my authored instruction');assert.equal($('ai-consent').checked,false);
 }finally{await w.happyDOM.close();}
});
