import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import C from '../reader/core.js';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {settle} from './helpers/save-pipeline.mjs';
const root=process.env.COCONUT_BASE_SOURCE?pathToFileURL(process.env.COCONUT_BASE_SOURCE+'/'):new URL('../',import.meta.url);
const quotation=fs.readFileSync(new URL('reader/quotation.js',root),'utf8');
function fixture(id=''){
 const doc={...C.validate({title:'Authored empty cue source',language:'en',segments:Array.from({length:180},(_,i)=>({id:i===155?id:'cue-'+i,start:i*10,end:i*10+4,text:'Authored passage '+i+'.'})),notes:{[id]:'Original private needle'}}),key:'target'};
 doc.exact_excerpts=[C.exactExcerptSnapshot(doc,[doc.segments[155]],[],0,doc.segments[155].text.length,{id:'precise-target',createdAt:'2026-10-14T00:00:00.000Z'})];
 const other={...C.validate({title:'Other document',segments:[{id:'other',start:0,end:5,text:'Unrelated text.'}]}),key:'other'};
 return [other,doc];
}
function setup(id=''){return libraryHarness(fixture(id),{probe:true,sourceRoot:root,configureCore:w=>w.eval(quotation)});}
const doc=h=>h.w.libraryProbe.documents.find(doc=>doc.key==='target');
const row=(h,id)=>[...h.$('transcript').querySelectorAll('.segment')].find(row=>row.dataset.segmentId===id);
const open=h=>{h.$('library-scope').value='notes';h.$('library-search').value='private needle';h.$('library-search').oninput();h.$('library').querySelector('.library-hit[data-hit-kind="note"]').click();};
const ready=async()=>{await settle();await new Promise(resolve=>setTimeout(resolve,0));};
const unload=w=>{const event=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(event);return event.defaultPrevented;};

test('cue validation preserves an empty string but never treats numeric zero as a string identity',()=>{
 const source=fixture()[1];assert.equal(C.validate(source).segments[155].id,'');
 assert.equal(C.validate({segments:[{id:0,text:'Zero is not a cue string.',start:0,end:1}]}).segments[0].id,'segment-1');
});

for(const id of ['', 'ordinary-target'])test(`searched note ${JSON.stringify(id)} remains visible, durable and reachable after cross-document navigation`,async()=>{
 const h=setup(id),{w,$}=h;try{
  open(h);assert.equal($('title').textContent,doc(h).title);assert.equal($('notes-panel').hidden,false);assert.equal(w.document.activeElement,$('note'));assert.equal($('note').value,'Original private needle');
  $('note').value='Revised durable private needle';$('note').dispatchEvent(new w.Event('input',{bubbles:true}));assert.equal((await w.flushContentForTest()).ok,true);assert.equal(doc(h).notes[id],'Revised durable private needle');
  const stored=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents.find(doc=>doc.key==='target');assert.equal(stored.notes[id],'Revised durable private needle');assert.equal(stored.segments[155].id,id);
  $('note').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal($('notes-panel').hidden,true);assert.equal(w.document.activeElement,row(h,id).querySelector('.note-button'));
  $('return-library-search').click();$('library-search').value='';$('library-search').oninput();$('library').querySelector('[data-document-key="other"] .library-open').click();assert.equal($('title').textContent,'Other document');
  $('open-library-notebook').click();$('notebook-search').value='Revised durable private needle';$('notebook-search').oninput();await ready();$('notebook-captures').querySelector('.notebook-open').click();
  assert.equal($('title').textContent,doc(h).title);assert.equal($('notes-panel').hidden,false);assert.equal($('note').value,'Revised durable private needle');assert.equal(row(h,id).classList.contains('selected'),true);
  $('return-library-notebook').click();await ready();assert.equal($('notebook-search').value,'Revised durable private needle');assert.equal(w.document.activeElement.closest('.notebook-capture').dataset.captureId,id);
 }finally{await w.happyDOM.close();}
});

for(const id of ['', 'ordinary-target'])test(`note ${JSON.stringify(id)} owns draft protection and reading-mode anchors`,async()=>{
 const h=setup(id),{w,$}=h;try{
  open(h);$('note').value='Unsubmitted local composition';$('note').dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));$('note').dispatchEvent(new w.Event('change',{bubbles:true}));
  assert.equal(unload(w),true);assert.equal(doc(h).notes[id],'Original private needle');$('note').value=doc(h).notes[id];$('note').dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true}));$('note').dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(unload(w),false);
  $('mode-bilingual').click();assert.equal(w.document.activeElement.dataset.segmentId,id);assert.equal($('notes-panel').hidden,false);
  $('mode-passages').click();assert.equal(w.document.activeElement.dataset.firstCueId,id);assert.ok($('passage-body').querySelector('.passage-annotation'));
  $('mode-passages').click();assert.equal(w.document.activeElement.dataset.firstCueId,id,'reselecting passage mode keeps the exact selected note');
  w.document.activeElement.querySelector('.passage-annotation').click();assert.equal(w.document.activeElement.dataset.segmentId,id);row(h,id).querySelector('.note-button').click();assert.equal($('notes-panel').hidden,false);assert.equal($('note').value,'Original private needle');$('return-to-passages').click();assert.ok(w.document.activeElement.closest('.passage').querySelector('.passage-cue[data-cue-id="'+id+'"]'));
 }finally{await w.happyDOM.close();}
});

for(const id of ['', 'ordinary-target'])test(`current exact excerpt ${JSON.stringify(id)} supports inline recall and notebook source return`,async()=>{
 const h=setup(id),{w,$}=h;try{
  open(h);$('close-note').click();const before=JSON.stringify(doc(h)),state=w.Coconut.exactExcerptState(doc(h).exact_excerpts[0],doc(h));assert.equal(state.freshness,'current');assert.equal(state.cueId,id);
  const recall=row(h,id).querySelector('.reading-excerpt-open');assert.equal(recall.hidden,false);recall.click();assert.match($('reading-excerpts-list').textContent,/Authored passage 155/);$('reading-excerpts-close').click();assert.equal(w.document.activeElement,recall);
  $('open-library-notebook').click();$('notebook-kind').value='excerpt';$('notebook-kind').onchange();await ready();const capture=$('notebook-captures').querySelector('[data-capture-type="exact-excerpt"]');assert.ok(capture);const button=capture.querySelector('.notebook-open');assert.equal(button.disabled,false);button.click();assert.equal($('library-notebook').open,false);assert.equal(w.document.activeElement.dataset.segmentId,id);
  $('return-library-notebook').click();await ready();assert.equal(w.document.activeElement.closest('.notebook-capture').dataset.captureId,'precise-target');assert.equal(JSON.stringify(doc(h)),before);
  $('notebook-close').click();doc(h).segments.splice(155,1);w.libraryProbe.render();$('open-library-notebook').click();await ready();const missing=$('notebook-captures').querySelector('[data-capture-type="exact-excerpt"] .notebook-open');assert.equal(missing.disabled,true);assert.equal(missing.textContent,'原位置已删除');
 }finally{await w.happyDOM.close();}
});

for(const id of ['', 'ordinary-target'])test(`an open note ${JSON.stringify(id)} blocks resumed playback follow without moving its editor`,async()=>{
 const documents=fixture(id);documents[1].source_media={job_id:'a'.repeat(32),kind:'audio'};
 const h=libraryHarness(documents,{probe:true,sourceRoot:root,configureCore:w=>w.eval(quotation)}),{w,$}=h;
 try{
  open(h);w.dispatchEvent(new w.Event('coconut-worker-ready'));const player=$('source-media').querySelector('audio');assert.ok(player);
  const frames=new Map();let frameId=0,scrolls=0;w.requestAnimationFrame=fn=>{frames.set(++frameId,fn);return frameId;};w.cancelAnimationFrame=id=>frames.delete(id);w.HTMLElement.prototype.scrollIntoView=()=>scrolls++;
  Object.defineProperties(player,{duration:{configurable:true,value:1800},paused:{configurable:true,value:false}});player.currentTime=0;player.dispatchEvent(new w.Event('timeupdate'));
  $('follow-playback').focus();$('follow-playback').click();for(const fn of [...frames.values()])fn();frames.clear();
  assert.equal($('follow-playback').dataset.state,'suspended');assert.equal($('notes-panel').hidden,false);assert.equal($('note').value,'Original private needle');assert.equal(row(h,id).classList.contains('selected'),true);assert.equal(scrolls,0);
 }finally{await w.happyDOM.close();}
});
