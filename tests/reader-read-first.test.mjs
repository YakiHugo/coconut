import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {readFirstFixture} from './helpers/read-first-fixture.mjs';
const mode=h=>h.w.document.body.dataset.readingMode;
async function importDoc(h,doc){const text=JSON.stringify(doc);Object.defineProperty(h.$('file'),'files',{configurable:true,value:[{name:'authored.json',size:text.length,text:async()=>text}]});await h.$('file').onchange();}
const open=h=>h.$('library').querySelector('.library-open').click();
for(const count of [1,11,12])for(const state of ['none','current','stale','unknown','job']){
 test(`${count} cues with ${state}: import and fresh startup choose defaults; ordinary reopen remembers the chosen mode`,async()=>{
  const doc=readFirstFixture(count,{summary:['current','stale','unknown'].includes(state)?state:null,job:state==='job'}),expected=count>=12?'passages':state==='none'?'transcript':'summary';
  const h=libraryHarness([],{probe:true});let stored;try{
   await importDoc(h,doc);assert.equal(mode(h),expected);
   h.$('mode-summary').click();h.w.libraryProbe.render();assert.equal(mode(h),'summary','ordinary render preserves manual summary even without an answer');
   open(h);assert.equal(mode(h),'summary');await h.w.flushContentForTest();stored=JSON.parse(h.w.localStorage.getItem('coconut-reader-v1')).documents;
   if(state==='job')assert.ok(stored[0].summary_job);if(['current','stale','unknown'].includes(state))assert.equal(h.w.Coconut.summaryFreshness(h.w.Coconut.latestSummary(stored[0]),stored[0]),state);
  }finally{await h.w.happyDOM.close();}
  const reloaded=libraryHarness(stored);try{assert.equal(mode(reloaded),expected);}finally{await reloaded.w.happyDOM.close();}
 });
}
test('demo startup and reopen retain bilingual or explicitly chosen source-only language',async()=>{
 for(const target of ['zh','']){
  const doc=readFirstFixture(3,{demo:true});doc.translation_view=target;
  const h=libraryHarness([doc],{probe:true});try{
   assert.equal(mode(h),'transcript');assert.equal(h.$('mode-bilingual').getAttribute('aria-pressed'),String(!!target));
   h.$('mode-summary').click();h.w.libraryProbe.render();assert.equal(mode(h),'summary');open(h);assert.equal(mode(h),'summary');assert.equal(h.w.libraryProbe.documents[0].translation_view,target);
  }finally{await h.w.happyDOM.close();}
 }
});
test('explicit import and bookmark control reach the saved bookmark; invalid bookmark uses default',async()=>{
 for(const bookmark of ['read-2','missing']){
  const h=libraryHarness([],{probe:true});try{
   await importDoc(h,readFirstFixture(3,{summary:'current',bookmark}));assert.equal(mode(h),bookmark==='read-2'?'transcript':'summary');
   if(bookmark==='read-2')assert.equal(h.w.document.activeElement.dataset.segmentId,bookmark);
   open(h);if(bookmark==='read-2')h.$('resume').click();assert.equal(mode(h),bookmark==='read-2'?'transcript':'summary');
   if(bookmark==='read-2')assert.equal(h.w.document.activeElement.dataset.segmentId,bookmark);
  }finally{await h.w.happyDOM.close();}
 }
});
test('summary citation and library search retain exact source targets over entry defaults',async()=>{
 const h=libraryHarness([readFirstFixture(11,{summary:'current',bookmark:'read-8'})],{probe:true});try{
  h.$('summary-citations').querySelector('button').click();assert.equal(mode(h),'transcript');assert.equal(h.w.document.activeElement.dataset.segmentId,'read-0');
  h.$('library-scope').value='text';h.$('library-scope').onchange();h.$('library-search').value='observation 6';h.$('library-search').oninput();
  for(let i=0;i<100&&!h.$('library').querySelector('.library-hit');i++)await new Promise(r=>setTimeout(r,2));
  const hit=h.$('library').querySelector('.library-hit');assert.ok(hit);hit.click();assert.equal(mode(h),'transcript');assert.equal(h.w.document.activeElement.dataset.segmentId,'read-5');assert.equal(h.w.libraryProbe.documents[0].readingPosition,'read-8');
 }finally{await h.w.happyDOM.close();}
});
test('audio-only project keeps its dedicated UI at startup and reopening',async()=>{
 const doc={key:'authored-audio',project_kind:'audio_only',title:'Authored local audio',local_media_source:{version:1,kind:'audio',name:'authored.wav',size:64,last_modified:7,type:'audio/wav',fingerprint:'a'.repeat(64)},segments:[]};
 const h=libraryHarness([doc]);try{for(let i=0;i<2;i++){assert.equal(h.$('audio-project').hidden,false);assert.equal(h.$('summary-workspace').hidden,true);assert.equal(h.$('reading-modes').hidden,true);open(h);}}finally{await h.w.happyDOM.close();}
});
async function restoreDoc(h,doc){const text=JSON.stringify({format:'coconut-library',version:1,active:doc.key,documents:[doc]});Object.defineProperty(h.$('library-file'),'files',{configurable:true,value:[{name:'library.json',size:text.length,text:async()=>text}]});await h.$('library-file').onchange();}
for(const state of ['none','current','stale','unknown','job','long','demo'])test(`whole-library restore activates ${state} with an entry default`,async()=>{
 const h=libraryHarness([],{probe:true});try{
  if(state!=='none')await importDoc(h,readFirstFixture(1));
  const doc=readFirstFixture(state==='long'?12:3,{summary:['current','stale','unknown'].includes(state)?state:null,job:state==='job',demo:state==='demo'});
  await restoreDoc(h,doc);assert.equal(mode(h),state==='long'?'passages':['none','demo'].includes(state)?'transcript':'summary');
  h.$('mode-summary').click();await restoreDoc(h,h.w.libraryProbe.documents.find(d=>d.title===doc.title));assert.equal(mode(h),'summary','same-document restore retains the manual choice');
 }finally{await h.w.happyDOM.close();}
});
async function waitFor(predicate){for(let i=0;i<100&&!predicate();i++)await new Promise(r=>setTimeout(r,2));assert.ok(predicate(),'pending writer reached');}
for(const choice of ['summary','source-only','other-document'])test(`a delayed demo receipt cannot overwrite a newer ${choice} choice`,async()=>{
 const h=libraryHarness([readFirstFixture(1)],{probe:true});let pending;try{
  await h.w.flushContentForTest();h.pipeline.hold();let scrolls=0;h.$('title').scrollIntoView=()=>scrolls++;
  pending=h.$('sample').onclick();await waitFor(()=>h.pipeline.writes.length>0);
  const firstScroll=scrolls;assert.equal(firstScroll,1);assert.equal(mode(h),'transcript');
  if(choice==='summary')h.$('mode-summary').click();else if(choice==='source-only')h.$('mode-transcript').click();else open(h);
  const chosenScrolls=scrolls,selectedTitle=h.$('title').textContent,currentMode=mode(h),translation=h.w.libraryProbe.documents.find(d=>d.title===h.$('title').textContent)?.translation_view;
  h.pipeline.hold(false);h.pipeline.writes[0].commit();await pending;pending=null;await h.w.flushContentForTest();
  assert.equal(h.$('title').textContent,selectedTitle);assert.equal(mode(h),currentMode);assert.equal(h.w.libraryProbe.documents.find(d=>d.title===selectedTitle)?.translation_view,translation);assert.equal(scrolls,chosenScrolls,'the delayed receipt must not scroll the newer reading view');
 }finally{h.pipeline.hold(false);for(const write of h.pipeline.writes)write.commit();await pending;await h.w.happyDOM.close();}
});
test('a delayed restored-document receipt preserves a newer explicit view choice',async()=>{
 const h=libraryHarness([],{probe:true});let pending;try{
  h.pipeline.hold();pending=restoreDoc(h,readFirstFixture(3));await waitFor(()=>h.pipeline.writes.length>0);assert.equal(mode(h),'transcript');h.$('mode-summary').click();
  h.pipeline.hold(false);h.pipeline.writes[0].commit();await pending;pending=null;assert.equal(mode(h),'summary');
 }finally{h.pipeline.hold(false);for(const write of h.pipeline.writes)write.commit();await pending;await h.w.happyDOM.close();}
});
