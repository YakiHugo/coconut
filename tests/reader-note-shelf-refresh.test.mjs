/** Count source work rather than setting hardware-dependent typing deadlines. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
import {settle} from './helpers/save-pipeline.mjs';
const cards=$=>[...$('library').children];
const keys=$=>cards($).map(card=>card.dataset.documentKey);
function edit($,value){$('note').value=value;$('note').oninput();}
function openNote(w,$){$('mode-transcript').click();w.document.querySelector('.note-button').click();}
function counters(doc){
 const result={id:0,end:0};
 for(const cue of doc.segments)for(const field of ['id','end']){let value=cue[field];Object.defineProperty(cue,field,{enumerable:true,configurable:true,get(){result[field]++;return value;},set(next){value=next;}});}
 return result;
}
for(const order of ['recent','title','duration','opened'])test(`note typing reuses untouched source metadata and renders once: ${order}`,async()=>{
 const {w,$}=libraryHarness(largeLibraryFixture(6,{cues:100}),{probe:true});try{
  openNote(w,$);$('library-sort').value=order;w.libraryProbe.renderLibrary();await settle();
  const docs=w.libraryProbe.documents,untouched=docs.slice(1).map(counters),before=cards($),input=$('note');
  let renders=0;const set=$('library').setAttribute.bind($('library'));$('library').setAttribute=(name,...args)=>{if(name==='aria-busy')renders++;return set(name,...args);};
  for(const value of ['Authored note',' \u0085\uFEFF ','New nonblank note']){
   renders=0;input.focus();input.setSelectionRange(1,1);edit($,value);const selection=input.selectionStart;
   assert.equal(renders,1);await settle();assert.equal(renders,1);
   assert.equal(w.document.activeElement,input);assert.equal(input.selectionStart,selection);assert.equal($('note'),input);
   assert.deepEqual(cards($),before);assert.match(before.find(card=>card.dataset.documentKey===docs[0].key).querySelector('small').textContent,new RegExp(w.Coconut.segmentNoteCount(docs[0])+' 则片段笔记'));
  }
  assert.deepEqual(untouched,docs.slice(1).map(()=>({id:0,end:0})));
 }finally{await w.happyDOM.close();}
});

test('generation refreshes match uncached duration, notes and bookmark metadata; ordinary refresh handles in-place changes',async()=>{
 const {w,$,pipeline}=libraryHarness(largeLibraryFixture(4,{cues:20}),{probe:true});try{
  const docs=w.libraryProbe.documents,doc=docs[2];$('library-sort').value='duration';w.libraryProbe.renderLibrary();await settle();
  doc.segments[0].end=8000;doc.notes[doc.segments[1].id]='authored';doc.readingPosition=doc.segments[3].id;
  pipeline.store.queueDocument(doc.key,doc);await settle();
  assert.deepEqual(keys($),Array.from(w.Coconut.sortedLibrary(docs,'duration'),doc=>doc.key));
  let metadata=cards($).find(card=>card.dataset.documentKey===doc.key).querySelector('small').textContent;
  assert.ok(metadata.includes(w.Coconut.time(w.Coconut.documentDuration(doc))));assert.ok(metadata.includes(w.Coconut.segmentNoteCount(doc)+' 则片段笔记'));assert.ok(metadata.includes('读到 '+w.Coconut.time(doc.segments[3].start)));
  // Unknown callers retain the conservative render path, even with identical
  // object/array identities, lengths and persistence generations.
  doc.segments[0].end=1;doc.notes[doc.segments[1].id]=' ';doc.readingPosition=doc.segments[5].id;
  w.libraryProbe.renderLibrary();assert.deepEqual(keys($),Array.from(w.Coconut.sortedLibrary(docs,'duration'),doc=>doc.key));
  metadata=cards($).find(card=>card.dataset.documentKey===doc.key).querySelector('small').textContent;
  assert.ok(metadata.includes(w.Coconut.segmentNoteCount(doc)+' 则片段笔记'));assert.ok(metadata.includes('读到 '+w.Coconut.time(doc.segments[5].start)));
  // Replacement identities and replacement arrays cannot reuse old values.
  const replacement={...doc,segments:doc.segments.map(cue=>({...cue,end:cue.end+500})),notes:{}};docs[2]=replacement;
  pipeline.store.queueDocument(replacement.key,replacement);await settle();
  assert.deepEqual(keys($),Array.from(w.Coconut.sortedLibrary(docs,'duration'),doc=>doc.key));
  assert.ok(cards($).find(card=>card.dataset.documentKey===doc.key).querySelector('small').textContent.includes('0 则片段笔记'));
 }finally{await w.happyDOM.close();}
});

test('note filter and search membership update synchronously while preserving the composing editor',async()=>{
 const {w,$}=libraryHarness(largeLibraryFixture(3,{cues:10}),{probe:true});try{
  openNote(w,$);const input=$('note'),doc=w.libraryProbe.documents[0];
  $('library-scope').value='notes';$('library-search').value='unique typing token';$('library-search').oninput();assert.deepEqual(keys($),[]);
  input.focus();input.dispatchEvent(new w.CompositionEvent('compositionstart'));edit($,'unique typing token');
  assert.deepEqual(keys($),[doc.key]);assert.equal(w.document.activeElement,input);
  edit($,' ');assert.deepEqual(keys($),[]);assert.equal(w.document.activeElement,input);
  $('library-search').value='';$('library-kind').value='annotated';$('library-search').oninput();
  edit($,'new annotation');assert.ok(keys($).includes(doc.key));edit($,'\u0085\uFEFF');assert.ok(!keys($).includes(doc.key));
  input.dispatchEvent(new w.CompositionEvent('compositionend'));await settle();assert.equal(w.document.activeElement,input);
 }finally{await w.happyDOM.close();}
});

test('coalescing keeps cooperative completion live and newer pending query intent wins',async()=>{
 const tasks=[],drain=()=>{let limit=10000;while(tasks.length){assert.ok(limit-->0);tasks.shift()();}};
 const {w,$}=libraryHarness(largeLibraryFixture(3,{cues:1500}),{probe:true,configureCore(w){const create=w.Coconut.createLibrarySearch;w.Coconut.createLibrarySearch=options=>create({...options,schedule:run=>tasks.push(run),now:()=>0});}});try{
  openNote(w,$);const input=$('note'),doc=w.libraryProbe.documents[0];$('library-sort').value='duration';$('library-scope').value='notes';$('library-search').value='first unique token';$('library-search').oninput();drain();
  input.focus();edit($,'first unique token');assert.equal($('library').hidden,true);await settle();assert.equal($('library').hidden,true);
  const pendingTasks=tasks.length;w.libraryProbe.renderLibrary();assert.equal(tasks.length,pendingTasks);
  $('library-search').value='second unique token';$('library-search').oninput();edit($,'second unique token');await settle();drain();
  assert.equal($('library').hidden,false);assert.equal($('library').getAttribute('aria-busy'),'false');assert.deepEqual(keys($),[doc.key]);assert.equal(w.document.activeElement,input);assert.match($('library').textContent,/second unique token/);
  w.libraryProbe.renderLibrary();assert.equal(tasks.length,0);assert.equal($('library').hidden,false);
 }finally{await w.happyDOM.close();}
});

test('the same-generation shelf skip still refreshes an open notebook',async()=>{
 const {w,$}=libraryHarness(largeLibraryFixture(2,{cues:10}),{probe:true});try{
  openNote(w,$);edit($,'before notebook refresh');await settle();$('open-library-notebook').click();
  assert.ok($('library-notebook').textContent.includes('before notebook refresh'));
  edit($,'after notebook refresh');await settle();
  assert.ok($('library-notebook').textContent.includes('after notebook refresh'));assert.ok(!$('library-notebook').textContent.includes('before notebook refresh'));
 }finally{await w.happyDOM.close();}
});

test('missing reading bookmark does not search source IDs during metadata warmup',async()=>{
 const {w,$}=libraryHarness(largeLibraryFixture(3,{cues:100}),{probe:true});try{
  const doc=w.libraryProbe.documents[1];delete doc.readingPosition;
  let finds=0;const find=doc.segments.find;doc.segments.find=function(...args){finds++;return find.apply(this,args);};
  w.libraryProbe.renderLibrary();assert.equal(finds,0);
  doc.readingPosition=doc.segments[99].id;w.libraryProbe.renderLibrary();assert.equal(finds,1);
  assert.ok(cards($).find(card=>card.dataset.documentKey===doc.key).querySelector('small').textContent.includes('读到 '+w.Coconut.time(doc.segments[99].start)));
 }finally{await w.happyDOM.close();}
});
