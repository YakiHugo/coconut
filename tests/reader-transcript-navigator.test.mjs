import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {readFirstFixture} from './helpers/read-first-fixture.mjs';
const setup=(count=120)=>libraryHarness([readFirstFixture(count)],{probe:true});
test('navigation snapshots are bounded, frozen and read-only; exact page jump preserves passage mode and bookmark',async()=>{
 const {w,$,pipeline}=setup();try{
  const doc=w.libraryProbe.documents[0];doc.readingPosition='read-3';
  const before=JSON.stringify(doc),generation=pipeline.store.status().generation;
  const session=w.CoconutTranscriptNavigation.open(),page=session.read(2);
  assert.equal(page.cues.length,40);assert.equal(page.cues[0].id,'read-80');assert.equal(page.pages,3);
  assert.equal(Object.isFrozen(page),true);assert.equal(Object.isFrozen(page.cues[0]),true);assert.equal(page.cues[0].text.includes('undefined'),false);
  assert.equal(JSON.stringify(doc),before);assert.equal(pipeline.store.status().generation,generation);
  assert.equal(session.jump('read-80'),true);assert.equal(w.document.body.dataset.readingMode,'passages');
  assert.equal($('passage-body').querySelector('.passage-cue').dataset.cueId,'read-80');assert.equal(doc.readingPosition,'read-3');
 }finally{await w.happyDOM.close();}
});
test('transcript mode and displayed translation survive navigation, invalid and out-of-range time does nothing',async()=>{
 const {w,$}=setup();try{
  $('mode-transcript').click();const session=w.CoconutTranscriptNavigation.open();const mode=w.document.body.dataset.readingMode;
  for(const value of ['', '-1', 'bad','1:99','999999'])assert.equal(session.jumpTime(value),false);
  assert.equal(w.document.body.dataset.readingMode,mode);
  assert.equal(session.jumpTime('0'),true);assert.equal(w.document.body.dataset.readingMode,'transcript');
  assert.equal(w.document.activeElement.dataset.segmentId,'read-0');
 }finally{await w.happyDOM.close();}
});
test('stale preview edits, replacement and document selection ABA cannot navigate',async()=>{
 const {w,$}=setup();try{
  const doc=w.libraryProbe.documents[0],session=w.CoconutTranscriptNavigation.open();session.read(0);
  doc.segments[0].text+=' changed';assert.equal(session.jump('read-0'),false);
  const next=w.CoconutTranscriptNavigation.open();next.read();doc.segments=[...doc.segments];assert.equal(next.isCurrent(),false);assert.equal(next.jumpTime('0'),false);
  const last=w.CoconutTranscriptNavigation.open();last.read();w.libraryProbe.documents[0]={...doc};assert.equal(last.isCurrent(),false);assert.equal(last.read(),null);
 }finally{await w.happyDOM.close();}
});
test('one navigation surface routes to existing search and chapter ownership, with native fallback',async()=>{
 const {w,$}=setup();try{
  const session=w.CoconutTranscriptNavigation.open();session.search();assert.equal(w.document.activeElement,$('search'));assert.equal(w.document.body.dataset.readingMode,'transcript');
  const next=w.CoconutTranscriptNavigation.open();next.chapters();assert.equal($('chapter-dialog').open,true);
  assert.equal(w.document.body.dataset.transcriptNavigation,undefined);assert.ok($('reading-jump'));assert.ok($('passage-time-range'));
  const html=fs.readFileSync(new URL('../reader/index.html',import.meta.url),'utf8');assert.match(html,/<script src="transcript-navigator.js\?v=[a-f0-9]+" defer>/);assert.doesNotMatch(html,/<script src="transcript-navigator[^>]*data-reader-script/);
 }finally{await w.happyDOM.close();}
});
test('every shipped server and desktop package includes the self-contained island',()=>{
 for(const filename of ['desktop/server.mjs','desktop/package.mjs','serve.py'])assert.match(fs.readFileSync(new URL('../'+filename,import.meta.url),'utf8'),/transcript-navigator\.js/);
});
test('production React island mounts and routes dialog controls without owning content state',async()=>{
 const {w,$}=setup();try{
  w.eval(fs.readFileSync(new URL('../reader/transcript-navigator.js',import.meta.url),'utf8'));
  const settle=()=>new Promise(resolve=>setTimeout(resolve,40));await settle();
  assert.equal(w.document.body.dataset.transcriptNavigation,'ready');assert.equal($('open-transcript-navigator').hidden,false);
  $('open-transcript-navigator').click();await settle();assert.equal($('transcript-navigator-dialog').open,true);assert.equal(w.document.querySelectorAll('.navigator-results li').length,40);
  [...$('transcript-navigator-dialog').querySelectorAll('button')].find(node=>node.textContent==='后面的原文').click();await settle();assert.match(w.document.querySelector('.navigator-results li').textContent,/observation 41/);
  const cancel=new w.Event('cancel',{cancelable:true});$('transcript-navigator-dialog').dispatchEvent(cancel);await settle();assert.equal($('transcript-navigator-dialog').open,false);assert.equal(w.document.activeElement,$('open-transcript-navigator'));
 }finally{await w.happyDOM.close();}
});
test('selection ABA retires an otherwise identical document session',async()=>{
 const {w}=libraryHarness([readFirstFixture(120),readFirstFixture(3)],{probe:true});try{
  const session=w.CoconutTranscriptNavigation.open();session.read();
  const open=title=>[...w.document.querySelectorAll('.library-open')].find(node=>node.textContent.includes(title)).click();
  open('Authored read-first 3');open('Authored read-first 120');
  assert.equal(session.isCurrent(),false);assert.equal(session.jump('read-0'),false);
 }finally{await w.happyDOM.close();}
});
test('a 100,000-cue navigation page reads only its 40 source previews',async()=>{
 const {w}=setup();try{
  let reads=0;w.libraryProbe.documents[0].segments=Array.from({length:100000},(_,i)=>({id:'large-'+i,start:i,end:i+1,get text(){reads++;return 'Authored bounded preview';}}));
  const session=w.CoconutTranscriptNavigation.open(),page=session.read(2499);
  assert.equal(page.cues.length,40);assert.equal(page.cues.at(-1).id,'large-99999');assert.equal(page.pages,2500);assert.ok(reads<=80,'no full-source cloning or text scan');
 }finally{await w.happyDOM.close();}
});
