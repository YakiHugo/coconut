/** Authored large shelves. Storage cardinality, DOM bounds, and focus are separate assertions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
import {settle} from './helpers/save-pipeline.mjs';
const saved=w=>JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents;
const cards=$=>[...$('library').children];
function jump($,page){$('library-page-number').value=String(page);$('library-page-form').dispatchEvent(new ($('library').ownerDocument.defaultView.Event)('submit',{cancelable:true}));}
function search($,query,scope='title'){$('library-scope').value=scope;$('library-search').value=query;$('library-search').oninput();}
async function backup(w,$){let blob;w.URL.createObjectURL=value=>{blob=value;return 'blob:authored-shelf';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};$('export-library').click();return JSON.parse(await blob.text());}

test('1,001 saved documents use 40-card pages and the final full title remains reachable and exportable',async()=>{
 const docs=largeLibraryFixture(),last=docs.at(-1);last.title+=' · '+('很长但没有截断的标题'.repeat(10));
 const {w,$}=libraryHarness(docs);try{
  assert.equal(saved(w).length,1001);assert.equal(cards($).length,40);assert.equal($('library-total').textContent,'1001');assert.match($('library-page-status').textContent,/1–40.*1001/);
  jump($,26);assert.equal(cards($).length,1);assert.equal(cards($)[0].dataset.documentKey,last.key);assert.equal($('library').querySelector('.library-title').textContent,last.title);
  assert.equal($('library-next').disabled,true);assert.equal(w.document.activeElement,$('library').querySelector('.library-open'));
  $('library').querySelector('.library-open').click();assert.equal($('title').textContent,last.title);assert.equal($('library').querySelector('[aria-current="page"]').closest('.library-entry').dataset.documentKey,last.key);
  $('library-previous').click();assert.equal(cards($).length,40);assert.equal(cards($)[0].dataset.documentKey,'shelf-960');
  $('library-show-active').click();assert.equal(cards($)[0].dataset.documentKey,last.key);assert.equal(w.document.activeElement,$('library').querySelector('.library-open'));
  const exported=await backup(w,$);assert.equal(exported.documents.length,1001);assert.equal(exported.documents.at(-1).title,last.title);assert.equal(exported.documents[500].segments.length,8);assert.equal(saved(w).length,1001);
 }finally{await w.happyDOM.close();}
});

test('query, scope, kind and sort reset paging over the complete library without losing control focus',async()=>{
 const docs=largeLibraryFixture(121);docs[120].notes['shelf-120-cue-7']='last private note';docs[120].segments[7].end=1000;docs[1].segments[7].end=2000;docs[120].title='AAA shelf first by title';docs[0].title='ZZZ shelf last by title';
 const {w,$}=libraryHarness(docs);try{
  jump($,3);$('library-search').focus();search($,'shelf');assert.equal(cards($)[0].dataset.documentKey,'shelf-0');assert.equal(w.document.activeElement,$('library-search'));
  jump($,3);search($,'last private note','notes');assert.equal(cards($).length,1);assert.equal(cards($)[0].dataset.documentKey,'shelf-120');assert.equal($('library-pagination').hidden,true);assert.match($('library-page-status').textContent,/1.*121/);
  search($,'');jump($,3);$('library-kind').value='annotated';$('library-kind').onchange();assert.equal(cards($).length,1);assert.equal(cards($)[0].dataset.documentKey,'shelf-120');
  $('library-kind').value='all';$('library-kind').onchange();jump($,3);$('library-sort').value='duration';$('library-sort').onchange();assert.equal(cards($)[0].dataset.documentKey,'shelf-0');jump($,4);assert.equal(cards($)[0].dataset.documentKey,'shelf-1');
  $('library-sort').value='title';$('library-sort').onchange();assert.equal(cards($)[0].dataset.documentKey,'shelf-120');jump($,4);assert.equal(cards($)[0].dataset.documentKey,'shelf-0');
  search($,'not in the library');assert.equal(cards($).length,0);assert.equal($('library-empty').hidden,false);assert.equal($('library-pagination').hidden,true);assert.match($('library-page-status').textContent,/0.*121/);assert.equal(saved(w).length,121);
 }finally{await w.happyDOM.close();}
});

test('late-page full-text hits navigate to the exact cue and note while keeping library filters and stored position',async()=>{
 const docs=largeLibraryFixture(81,{cues:221});for(const d of docs){d.segments[220].text='authored pagination needle';d.readingPosition=d.segments[0].id;}docs[80].notes['shelf-80-cue-219']='authored final private needle';
 const tasks=[];const drain=()=>{while(tasks.length)tasks.shift()();};
 const {w,$}=libraryHarness(docs,{configureCore(w){const create=w.Coconut.createLibrarySearch;w.Coconut.createLibrarySearch=options=>create({...options,schedule:run=>tasks.push(run)});}});try{
  search($,'pagination needle','text');drain();assert.equal(cards($).length,40);jump($,3);assert.equal(cards($)[0].dataset.documentKey,'shelf-80');
  $('library').querySelector('.library-hit').click();assert.equal($('title').textContent,docs[80].title);assert.equal(w.document.activeElement.dataset.segmentId,'shelf-80-cue-220');assert.ok(w.document.querySelectorAll('#transcript .segment').length<=100);assert.equal($('library-search').value,'pagination needle');assert.equal($('library-page-number').value,'3');assert.equal(saved(w).at(-1).readingPosition,'shelf-80-cue-0');
  search($,'final private needle','notes');drain();$('library').querySelector('.library-hit').click();assert.equal(w.document.activeElement,$('note'));assert.equal($('note').value,'authored final private needle');
 }finally{await w.happyDOM.close();}
});

test('removing the sole final-page card clamps the page and Undo reveals and focuses its exact restored card',async()=>{
 const docs=largeLibraryFixture(81);docs[80].notes['shelf-80-cue-0']='Keep this final note';
 const {w,$}=libraryHarness(docs);try{
  const original=(await backup(w,$)).documents.at(-1);jump($,3);$('library-options').open=true;$('library-options').dispatchEvent(new w.Event('toggle'));
  $('library').querySelector('.library-remove').click();await $('confirm-removal').onclick();
  assert.equal(saved(w).length,80);assert.equal(cards($).length,40);assert.equal($('library-page-number').value,'2');assert.equal($('title').textContent,docs[0].title);
  $('undo-removal').focus();await $('undo-removal').onclick();assert.equal(saved(w).length,81);assert.deepEqual(saved(w).at(-1),original);assert.equal(cards($).length,1);assert.equal($('library-page-number').value,'3');assert.equal(w.document.activeElement.closest('.library-entry').dataset.documentKey,'shelf-80');assert.equal(w.document.activeElement.className,'library-remove');
 }finally{await w.happyDOM.close();}
});

test('ordinary refresh and note edits retain mounted card identities and unrelated keyboard focus',async()=>{
 const {w,$}=libraryHarness(largeLibraryFixture(1001),{probe:true});try{
  const before=cards($);const focus=before[20].querySelector('.library-open');focus.focus();w.libraryProbe.renderLibrary();
  assert.equal(w.document.activeElement,focus);assert.deepEqual(cards($),before);
  $('mode-transcript').click();w.document.querySelector('.note-button').click();$('note').value='Updated live note count';$('note').oninput();
  assert.equal(w.document.activeElement,$('note'));assert.deepEqual(cards($),before);assert.match(before[0].querySelector('small').textContent,/1 则片段笔记/);assert.equal(cards($).length,40);
  await w.flushContentForTest();assert.equal(saved(w).length,1001);assert.equal(saved(w)[0].notes['shelf-0-cue-0'],'Updated live note count');
 }finally{await w.happyDOM.close();}
});

test('page input rejects invalid destinations without discarding the current shelf and clamps after content changes',async()=>{
 const {w,$}=libraryHarness(largeLibraryFixture(81));try{
  for(const invalid of ['0','-1','4','1.5','']){jump($,invalid);assert.equal(cards($)[0].dataset.documentKey,'shelf-0');}
  jump($,2);assert.equal(cards($)[0].dataset.documentKey,'shelf-40');$('library-next').click();assert.equal(cards($)[0].dataset.documentKey,'shelf-80');$('library-previous').click();assert.equal(cards($)[0].dataset.documentKey,'shelf-40');
 }finally{await w.happyDOM.close();}
});


test('unchanged refresh constructs no card elements and computes previews only for the mounted page',async()=>{
 const {w,$}=libraryHarness(largeLibraryFixture(1001),{probe:true});try{
  let previews=0,created=0;const hits=w.Coconut.libraryHits,create=w.document.createElement.bind(w.document);
  w.Coconut.libraryHits=(...args)=>{previews++;return hits(...args);};w.document.createElement=(...args)=>{created++;return create(...args);};
  w.libraryProbe.renderLibrary();assert.equal(previews,40);assert.equal(created,0);assert.equal(cards($).length,40);assert.equal(saved(w).length,1001);
 }finally{await w.happyDOM.close();}
});

test('title-only browsing does not inspect source cues for the inactive annotation filter',async()=>{
 const {w}=libraryHarness();try{
  const doc={title:'A title',notes:{},get segments(){throw Error('Title browsing scanned source cues');}};
  assert.equal(w.Coconut.libraryMatches(doc,'title','all','title'),true);assert.equal(w.Coconut.libraryMatches(doc,'missing','all','title'),false);
 }finally{await w.happyDOM.close();}
});

test('changed source previews preserve the exact focused hit, while background refresh never steals an editor',async()=>{
 const {w,$}=libraryHarness(largeLibraryFixture(81),{probe:true});try{
  const doc=w.libraryProbe.documents[80];doc.segments[7].text='needle before';w.Coconut.invalidateSearch(doc);search($,'needle','text');
  const hit=$('library').querySelector('.library-hit');hit.focus();doc.segments[7].text='needle changed';w.Coconut.invalidateSearch(doc);w.libraryProbe.renderLibrary();
  assert.equal(hit.isConnected,false);assert.equal(w.document.activeElement.dataset.hitId,'shelf-80-cue-7');assert.match(w.document.activeElement.textContent,/changed/);
  $('library-search').focus();doc.segments[7].text='needle changed again';w.Coconut.invalidateSearch(doc);w.libraryProbe.renderLibrary();assert.equal(w.document.activeElement,$('library-search'));
  $('library').querySelector('.library-hit').focus();doc.segments[7].text='no longer a match';w.Coconut.invalidateSearch(doc);w.libraryProbe.renderLibrary();assert.equal(cards($).length,0);assert.equal(w.document.activeElement,$('library-search'));
 }finally{await w.happyDOM.close();}
});


test('paging to a provisionally restored card uses available focus and a delayed receipt respects newer input',async()=>{
 const {w,$,pipeline}=libraryHarness(largeLibraryFixture(81));try{
  jump($,3);$('library-options').open=true;$('library-options').dispatchEvent(new w.Event('toggle'));$('library').querySelector('.library-remove').click();await $('confirm-removal').onclick();
  pipeline.hold(true);$('undo-removal').focus();const undo=$('undo-removal').onclick();await settle();assert.equal(pipeline.writes.length,1);
  $('library-next').click();assert.equal(cards($)[0].dataset.documentKey,'shelf-80');assert.equal($('library').querySelector('.library-open').disabled,true);assert.equal(w.document.activeElement,$('library-search'));
  pipeline.writes[0].commit();await undo;assert.equal(w.document.activeElement,$('library-search'));assert.equal($('library').querySelector('.library-open').disabled,false);assert.equal(saved(w).length,81);
 }finally{await w.happyDOM.close();}
});
