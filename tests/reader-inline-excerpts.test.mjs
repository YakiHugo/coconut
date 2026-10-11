import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import C from '../reader/core.js';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {settle} from './helpers/save-pipeline.mjs';
const root=new URL('../',import.meta.url),quotation=fs.readFileSync(new URL('reader/quotation.js',root),'utf8');
const raw=()=>({key:'inline',title:'Authored inline reading',language:'en',segments:[
 {id:'a',text:'Repeated repeated 🌴',start:0,end:5},{id:'b',text:'words 中文。',start:5,end:10},{id:'c',text:'Uncaptured final source.',start:10,end:15}],notes:{a:'Existing cue thought'}});
function capture(doc,id='first',from=9,to=26,cues=doc.segments.slice(0,2)){return C.exactExcerptSnapshot(doc,cues,Array(cues.length-1).fill(' '),from,to,{id,createdAt:'2026-10-11T00:00:00.000Z'});}
function fixture(){const doc={...C.validate(raw()),key:'inline'};doc.exact_excerpts=[capture(doc)];return doc;}
function setup(doc=fixture()){const env=libraryHarness([doc],{probe:true,configureCore:w=>w.eval(quotation)});env.$('mode-passages').click();return env;}
const button=w=>w.document.querySelector('#passage-body .reading-excerpt-open:not([hidden])');
const ready=async()=>{await settle();await new Promise(resolve=>setTimeout(resolve,0));};

test('saved exact selections are recalled beside source text and existing cue notes without changing either',async()=>{
 const {w,$}=setup();try{
  const doc=w.libraryProbe.documents[0],before=JSON.stringify(doc),source=w.document.querySelector('.passage-original'),html=source.innerHTML;
  const open=button(w);assert.equal(open.textContent,'摘录 1');assert.match(open.getAttribute('aria-label'),/本段.*1.*精确摘录/);
  assert.match(w.document.querySelector('.passage-annotation').textContent,/Existing cue thought/);assert.equal(doc.segments[0].saved_excerpt,undefined);
  open.focus();open.click();assert.equal($('reading-excerpts-dialog').open,true);assert.equal($('library-notebook').open,false);assert.match($('reading-excerpts-list').textContent,/repeated 🌴 words/);assert.match($('reading-excerpts-list').textContent,/来源仍一致/);
  assert.equal(source.innerHTML,html);assert.equal(source.querySelectorAll('mark').length,0);assert.equal(JSON.stringify(doc),before);
  $('reading-excerpts-dismiss').click();assert.equal(w.document.activeElement,open);assert.equal(w.document.querySelector('.passage-original'),source);
 }finally{await w.happyDOM.close();}
});

test('new exact save adds recall immediately and receipts never rebuild source, controls or player',async()=>{
 const {w,$,pipeline}=setup(raw());try{
  const source=w.document.querySelector('.passage-original'),text=source.innerHTML,player=w.document.createElement('audio');$('source-media').append(player);const open=w.document.querySelector('#passage-body .reading-excerpt-open');assert.equal(open.hidden,true);
  pipeline.hold();w.document.querySelector('.passage-quote').click();$('quotation-source').setSelectionRange(9,26);$('quotation-preview-selection').click();$('quotation-save').click();await settle();
  assert.equal(open.hidden,false);assert.equal(open.textContent,'摘录 1');assert.match(open.title,/正在保存/);assert.equal(w.document.querySelector('.passage-original'),source);assert.equal(source.innerHTML,text);assert.equal($('source-media').firstChild,player);
  $('quotation-close').click();open.click();assert.match($('reading-excerpts-save-status').textContent,/正在保存/);const heading=$('reading-excerpts-heading');heading.focus();pipeline.writes[0].fail();await ready();
  assert.match($('reading-excerpts-save-status').textContent,/尚未保存/);assert.equal(w.document.activeElement,heading);assert.equal(w.document.querySelector('.passage-original'),source);assert.equal($('source-media').firstChild,player);
  w.document.querySelector('.reading-excerpt-edit').click();$('exact-note-text').value='My thought';$('exact-note-text').oninput();const pending=$('exact-note-save').onclick();await settle();pipeline.writes[1].commit();await pending;
  $('exact-note-close').click();assert.match($('reading-excerpts-list').textContent,/My thought/);assert.match($('reading-excerpts-save-status').textContent,/已保存到本机/);assert.equal(w.document.activeElement.className,'reading-excerpt-edit');assert.equal($('source-media').firstChild,player);
 }finally{await w.happyDOM.close();}
});

test('direct note editing retains existing rescue, draft guard and exact-record ownership',async()=>{
 const {w,$,pipeline}=setup();try{
  button(w).click();w.document.querySelector('.reading-excerpt-edit').click();$('exact-note-text').value='Pending thought';$('exact-note-text').oninput();$('exact-note-close').click();assert.equal($('exact-note-dialog').open,true);assert.match($('exact-note-status').textContent,/尚未提交/);
  pipeline.hold();const pending=$('exact-note-save').onclick();await settle();pipeline.writes[0].fail();await pending;assert.match($('exact-note-status').textContent,/保存未成功/);assert.equal($('exact-note-text').value,'Pending thought');
  const doc=w.libraryProbe.documents[0],old=doc.exact_excerpts[0];doc.exact_excerpts=[C.validate({...doc}).exact_excerpts[0]];assert.notEqual(doc.exact_excerpts[0],old);
  $('exact-note-text').value='Rescue this newer draft';$('exact-note-text').oninput();await $('exact-note-save').onclick();assert.match($('exact-note-status').textContent,/更换或移除/);assert.equal(doc.exact_excerpt_notes[old.id],'Pending thought');
  $('exact-note-cancel').click();assert.equal(w.document.querySelector('.reading-excerpt-edit').disabled,true);assert.match($('reading-excerpts-list').textContent,/摘录已更换或移除/);assert.equal(w.document.activeElement,$('reading-excerpts-heading'));assert.match($('reading-excerpts-list').textContent,/Pending thought/);
 }finally{await w.happyDOM.close();}
});

for(const change of ['text','title','speaker','same-id'])test('source '+change+' changes only historical association, never snapshot or precise highlight',async()=>{
 const {w,$}=setup();try{
  const doc=w.libraryProbe.documents[0],record=doc.exact_excerpts[0],snapshot=JSON.stringify(record);
  if(change==='same-id')doc.segments[0]={...doc.segments[0]};else if(change==='title')doc.title='Revised title';else doc.segments[0][change]='Revised '+change;
  w.libraryProbe.render();const open=button(w);assert.ok(open);assert.equal(open.dataset.history,'true');open.click();assert.match($('reading-excerpts-list').textContent,/历史关联/);if(change==='same-id')assert.match($('reading-excerpts-list').textContent,/已替换/);
  assert.equal(JSON.stringify(record),snapshot);assert.equal(w.document.querySelectorAll('.passage-original mark').length,0);
 }finally{await w.happyDOM.close();}
});
for(const change of ['missing','reordered','inserted'])test('source '+change+' cannot acquire a guessed inline anchor',async()=>{
 const {w,$}=setup();try{
  const doc=w.libraryProbe.documents[0];if(change==='missing')doc.segments.splice(1,1);else if(change==='reordered')doc.segments.reverse();else doc.segments.splice(1,0,{id:'new',text:'New source',start:2,end:3});
  w.libraryProbe.render();assert.equal(button(w),null);$('open-library-notebook').click();await ready();assert.match($('notebook-captures').textContent,/repeated 🌴 words/);
 }finally{await w.happyDOM.close();}
});

test('JSON restore establishes current equality; missing cue undo can restore the original live identity',async()=>{
 const source=JSON.parse(JSON.stringify(fixture())),{w,$}=setup(source);try{
  assert.equal(button(w).dataset.history,'false');const doc=w.libraryProbe.documents[0],removed=doc.segments.splice(1,1)[0];w.libraryProbe.render();assert.equal(button(w),null);doc.segments.splice(1,0,removed);w.libraryProbe.render();assert.equal(button(w).dataset.history,'false');
  button(w).click();assert.match($('reading-excerpts-list').textContent,/来源仍一致/);
 }finally{await w.happyDOM.close();}
});

test('overlapping cross-cue records appear once per paragraph and only beside included source cues',async()=>{
 const doc=fixture();doc.exact_excerpts.push(capture(doc,'overlap',0,12));const {w,$}=setup(doc);try{
  assert.equal(button(w).textContent,'摘录 2');button(w).click();assert.equal($('reading-excerpts-list').children.length,2);$('reading-excerpts-close').click();$('mode-transcript').click();
  const buttons=[...$('transcript').querySelectorAll('.reading-excerpt-open')];assert.deepEqual(buttons.map(button=>button.hidden),[false,false,true]);assert.equal(buttons[0].textContent,'摘录 2');assert.equal(buttons[1].textContent,'摘录 1');
  $('search').value='中文';$('search').oninput();const row=$('transcript').querySelector('.segment');assert.equal(row.dataset.segmentId,'b');row.querySelector('.reading-excerpt-open').click();assert.equal($('reading-excerpts-list').children.length,1);$('reading-excerpts-close').click();assert.equal($('search').value,'中文');assert.equal(w.document.activeElement,row.querySelector('.reading-excerpt-open'));
 }finally{await w.happyDOM.close();}
});

test('bounded recall pages and explicit progressive expansion avoid mounting giant record context',async()=>{
 const doc={...C.validate(raw()),key:'inline'};doc.segments=[{id:'giant',text:'🌴'.repeat(12000),start:0,end:10}];doc.exact_excerpts=Array.from({length:19},(_,i)=>capture(doc,'e'+i,0,doc.segments[0].text.length,doc.segments));const {w,$}=setup(doc);try{
  button(w).click();assert.equal($('reading-excerpts-list').children.length,8);assert.ok($('reading-excerpts-list').textContent.length<7000);
  const details=w.document.querySelector('.reading-excerpt-details');details.open=true;details.dispatchEvent(new w.Event('toggle'));const content=details.querySelector('.reading-excerpt-content');assert.equal(content.textContent.length,4000);assert.equal(/[\uD800-\uDBFF]$/.test(content.textContent),false);
  details.querySelector('.reading-excerpt-more').click();assert.equal(content.textContent.length,8000);$('reading-excerpts-next').click();assert.equal($('reading-excerpts-list').children.length,8);assert.match($('reading-excerpts-position').textContent,/9–16/);$('reading-excerpts-next').click();assert.equal($('reading-excerpts-list').children.length,3);assert.equal($('reading-excerpts-next').disabled,true);assert.equal(w.document.activeElement,$('reading-excerpts-heading'));
 }finally{await w.happyDOM.close();}
});

test('bilingual snapshots retain selected translation after current translation changes',async()=>{
 const doc={...C.validate(raw()),key:'inline'};for(const cue of doc.segments)cue.translations={zh:{text:'选取时译文 '+cue.id,source_text:cue.text,source_language:'en',provider:'authored'}};
 const cues=doc.segments.slice(0,2),run=C.translationSelectionModels(doc,cues,'zh')[0];doc.exact_excerpts=[C.pairedExactExcerptSnapshot(doc,cues,[' '],0,8,run,0,6,{id:'paired',createdAt:'2026-10-11T00:00:00.000Z',confirmedAt:'2026-10-11T00:00:00.000Z'})];const {w,$}=setup(doc);try{
  const live=w.libraryProbe.documents[0];delete live.segments[0].translations;w.libraryProbe.render();button(w).click();assert.match($('reading-excerpts-list').textContent,/双语摘录/);assert.match($('reading-excerpts-list').textContent,/选取时译文/);assert.match($('reading-excerpts-list').textContent,/历史关联/);
  const details=w.document.querySelector('.reading-excerpt-details');details.open=true;details.dispatchEvent(new w.Event('toggle'));assert.match(details.textContent,/用户确认两段对应/);w.document.querySelector('.reading-excerpt-edit').click();assert.match($('exact-note-quote').value,/选取时译文/);
 }finally{await w.happyDOM.close();}
});

test('full render batches once and receipts do not rescan a large document or rebuild expanded details',async()=>{
 const doc=fixture();for(let i=3;i<20000;i++)doc.segments.push({id:'long'+i,text:'Long source '+i,start:i*5,end:i*5+5});const {w,$,pipeline}=setup(doc);try{
  let batches=0;const batch=w.Coconut.exactExcerptStateBatch;w.Coconut.exactExcerptStateBatch=(...args)=>{batches++;return batch(...args);};w.libraryProbe.render();assert.equal(batches,1);
  button(w).click();assert.equal(batches,2);const details=w.document.querySelector('.reading-excerpt-details');details.open=true;details.dispatchEvent(new w.Event('toggle'));const child=details.querySelector('.reading-excerpt-content');
  pipeline.hold();w.document.querySelector('.reading-excerpt-edit').click();$('exact-note-text').value='Receipt note';$('exact-note-text').oninput();const pending=$('exact-note-save').onclick();await settle();const before=batches;pipeline.writes[0].commit();await pending;assert.equal(batches,before);assert.equal(details.querySelector('.reading-excerpt-content'),child);assert.equal(details.open,true);
 }finally{await w.happyDOM.close();}
});

test('closing a stale dialog does not steal focus from a newer document',async()=>{
 const {w,$}=setup();try{
  button(w).click();const docs=w.libraryProbe.documents;docs[0]={...docs[0],title:'Replacement',segments:docs[0].segments.map(cue=>({...cue}))};w.libraryProbe.render();const target=$('passage-search');target.focus();$('reading-excerpts-close').click();assert.equal(w.document.activeElement,target);
 }finally{await w.happyDOM.close();}
});

test('long-document result and passage pages survive nested note editing and the outer Find return',async()=>{
 const doc={...C.validate(raw()),key:'inline'};doc.notes={};doc.segments=Array.from({length:1200},(_,i)=>({id:'long'+i,text:'Authored long paragraph '+i+' '+('reading '.repeat(30))+(i===955?' FIND-ME':''),start:i*5,end:i*5+5}));doc.readingPosition='long630';doc.exact_excerpts=[capture(doc,'far',0,12,[doc.segments[955]])];const {w,$}=setup(doc);try{
  const initial=w.document.querySelector('.passage').dataset.firstCueId;$('passage-search').click();$('search').value='FIND-ME';$('search').oninput();const row=$('transcript').querySelector('.segment'),open=row.querySelector('.reading-excerpt-open');assert.equal(row.dataset.segmentId,'long955');assert.equal(open.hidden,false);
  open.click();w.document.querySelector('.reading-excerpt-edit').click();$('exact-note-text').value='Thought at the far match';$('exact-note-text').oninput();await $('exact-note-save').onclick();$('exact-note-close').click();$('reading-excerpts-close').click();assert.equal($('search').value,'FIND-ME');assert.equal(w.document.activeElement,open);assert.equal(w.libraryProbe.documents[0].readingPosition,'long630');
  $('return-before-search').click();assert.equal(w.document.querySelector('.passage').dataset.firstCueId,initial);assert.equal(w.libraryProbe.documents[0].exact_excerpt_notes.far,'Thought at the far match');
 }finally{await w.happyDOM.close();}
});

test('a rerendered opener falls back to its surviving cue without scrolling; removed records disable old editing',async()=>{
 const {w,$}=setup();try{
  button(w).click();const old=button(w);let scrolls=0;w.scrollTo=w.scrollBy=()=>scrolls++;
  w.libraryProbe.render();assert.equal(old.isConnected,false);$('reading-excerpts-close').click();assert.equal(w.document.activeElement.dataset.cueId,'a');assert.equal(scrolls,0);
  button(w).click();w.libraryProbe.documents[0].exact_excerpts=[];w.libraryProbe.render();assert.equal(w.document.querySelector('.reading-excerpt-edit').disabled,true);assert.match($('reading-excerpts-list').textContent,/更换或移除/);$('reading-excerpts-close').click();assert.equal(scrolls,0);assert.equal(button(w),null);
 }finally{await w.happyDOM.close();}
});

for(const mode of ['transcript','bilingual'])test(mode+' recall returns to the same button rather than a hidden-mode fallback',async()=>{
 const {w,$}=setup();try{
  $('mode-'+mode).click();const entry=$('transcript').querySelector('.reading-excerpt-open');entry.click();$('reading-excerpts-dialog').dispatchEvent(new w.Event('cancel',{cancelable:true}));assert.equal(w.document.activeElement,entry);assert.equal($('reading-excerpts-dialog').open,false);
 }finally{await w.happyDOM.close();}
});

test('an open snapshot reports source removal accurately while keeping its personal note editable',async()=>{
 const {w,$}=setup();try{
  button(w).click();w.libraryProbe.documents[0].segments.splice(1,1);w.libraryProbe.render();assert.match($('reading-excerpts-list').textContent,/原片段已移除/);assert.doesNotMatch($('reading-excerpts-list').textContent,/原片段已替换/);assert.equal(w.document.querySelector('.reading-excerpt-edit').disabled,false);assert.equal(button(w),null);
 }finally{await w.happyDOM.close();}
});

test('save status resolves the active document once rather than scanning the shelf for every mounted control',async()=>{
 const doc=fixture();for(let i=3;i<200;i++)doc.segments.push({id:'extra'+i,text:'Extra source '+i,start:i*5,end:i*5+5});
 const others=Array.from({length:300},(_,i)=>({...raw(),key:'other'+i,title:'Other '+i}));const {w,$,pipeline}=libraryHarness([doc,...others],{probe:true});try{
  const docs=w.libraryProbe.documents,current=docs.shift();docs.push(current);w.libraryProbe.render();assert.ok(w.document.querySelectorAll('.reading-excerpt-open').length>=100);
  let finds=0;const find=docs.find;docs.find=function(...args){finds++;return find.apply(this,args);};pipeline.store.queueDocument(current.key,current);assert.ok(finds<10,'queued receipt performed '+finds+' document scans');docs.find=find;await ready();
 }finally{await w.happyDOM.close();}
});

test('recall and nested note dialogs own only real Tab boundaries and skip collapsed evidence',async()=>{
 const {w,$}=setup();try{
  button(w).click();const key=(node,options={})=>{const event=new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true,...options});node.dispatchEvent(event);return event;};
  assert.equal(key($('reading-excerpts-heading'),{shiftKey:true}).defaultPrevented,true);assert.equal(w.document.activeElement,$('reading-excerpts-close'));
  assert.equal(key($('reading-excerpts-close')).defaultPrevented,true);assert.equal(w.document.activeElement,$('reading-excerpts-dismiss'));
  assert.equal(key($('reading-excerpts-dismiss'),{shiftKey:true}).defaultPrevented,true);assert.equal(w.document.activeElement,$('reading-excerpts-close'));
  for(const options of [{altKey:true},{ctrlKey:true},{metaKey:true},{isComposing:true}])assert.equal(key($('reading-excerpts-close'),options).defaultPrevented,false);
  const hidden=w.document.createElement('details'),summary=w.document.createElement('summary'),hiddenButton=w.document.createElement('button');summary.textContent='Collapsed test evidence';hidden.append(summary,hiddenButton);$('reading-excerpts-dialog').append(hidden);summary.tabIndex=-1;
  assert.equal(key($('reading-excerpts-close')).defaultPrevented,true);assert.equal(w.document.activeElement,$('reading-excerpts-dismiss'));hidden.remove();
  const edit=w.document.querySelector('.reading-excerpt-edit');edit.focus();assert.equal(key(edit).defaultPrevented,false);edit.click();
  $('exact-note-quote').focus();assert.equal(key($('exact-note-quote'),{shiftKey:true}).defaultPrevented,true);assert.equal(w.document.activeElement,$('exact-note-backup'));
  assert.equal(key($('exact-note-backup')).defaultPrevented,true);assert.equal(w.document.activeElement,$('exact-note-quote'));
  $('exact-note-text').focus();assert.equal(key($('exact-note-text')).defaultPrevented,false);
 }finally{await w.happyDOM.close();}
});
