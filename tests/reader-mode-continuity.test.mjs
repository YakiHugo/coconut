import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
function setup(){
 const docs=largeLibraryFixture(1,{cues:1000});docs[0].readingPosition=docs[0].segments[19].id;
 const h=libraryHarness(docs,{probe:true});h.w.HTMLElement.prototype.scrollIntoView=function(){h.scrolled=this;};
 h.plays=0;h.w.HTMLMediaElement.prototype.play=async()=>{h.plays++;};return h;
}
const source=h=>JSON.stringify(h.w.libraryProbe.documents[0].segments);
const row=(h,id)=>[...h.$('transcript').querySelectorAll('.segment')].find(node=>node.dataset.segmentId===id);
function visibleOnly(nodes,target){for(const node of nodes)node.getBoundingClientRect=()=>node===target?{top:40,bottom:120}:{top:2000,bottom:2100};}
test('late passage page switches to original and bilingual at the source anchor without source/bookmark drift',async()=>{
 const h=setup(),{$,w}=h;try{
  const before=source(h),bookmark=w.libraryProbe.documents[0].readingPosition;
  $('mode-passages').click();for(let i=0;i<5;i++)$('passage-next').click();
  const anchor=$('passage-body').firstElementChild.dataset.firstCueId;
  $('mode-transcript').click();assert.ok(row(h,anchor));assert.equal(w.document.activeElement.dataset.segmentId,anchor);assert.equal(h.scrolled?.dataset.segmentId,anchor);
  const cue=row(h,anchor);visibleOnly($('transcript').querySelectorAll('.segment'),cue);
  $('mode-bilingual').click();assert.ok(row(h,anchor));assert.equal(w.document.activeElement.dataset.segmentId,anchor);assert.equal($('mode-bilingual').getAttribute('aria-pressed'),'true');
  await w.flushContentForTest();assert.equal(source(h),before);assert.equal(w.libraryProbe.documents[0].readingPosition,bookmark);assert.equal(h.plays,0);
 }finally{await w.happyDOM.close();}
});
test('ordinary cue pagination overrides an old passage page, including the last short page',async()=>{
 const h=setup(),{$,w}=h;try{
  $('mode-passages').click();$('passage-next').click();$('mode-transcript').click();
  for(let i=0;i<9;i++)$('next-page').click();
  const anchor=$('transcript').firstElementChild.dataset.segmentId;assert.equal(anchor,'shelf-0-cue-900');
  $('mode-passages').click();assert.ok($('passage-body').querySelector(`[data-cue-id="${anchor}"]`));
  assert.ok(w.document.activeElement.querySelector(`[data-cue-id="${anchor}"]`));assert.equal(w.libraryProbe.documents[0].readingPosition,'shelf-0-cue-19');
 }finally{await w.happyDOM.close();}
});
test('viewport source position wins over the first mounted cue in both reading layouts',async()=>{
 const h=setup(),{$,w}=h;try{
  $('mode-transcript').click();$('next-page').click();
  const target=row(h,'shelf-0-cue-170');visibleOnly($('transcript').querySelectorAll('.segment'),target);
  $('mode-passages').click();assert.ok($('passage-body').querySelector('[data-cue-id="shelf-0-cue-170"]'));
  const cues=[...$('passage-body').querySelectorAll('.passage-original .passage-cue')],last=cues.at(-1),id=last.dataset.cueId;visibleOnly(cues,last);
  $('mode-bilingual').click();assert.equal(w.document.activeElement.dataset.segmentId,id);assert.equal(h.plays,0);
 }finally{await w.happyDOM.close();}
});
test('explicit note selection and search context keep precedence over viewport fallback',async()=>{
 const h=setup(),{$,w}=h;try{
  $('mode-transcript').click();row(h,'shelf-0-cue-70').querySelector('.note-button').click();
  visibleOnly($('transcript').querySelectorAll('.segment'),row(h,'shelf-0-cue-5'));
  $('mode-passages').click();assert.ok($('passage-body').querySelector('[data-cue-id="shelf-0-cue-70"]'));
  $('mode-transcript').click();$('search').value='source sentence 900.';$('search').oninput();$('next-match').click();$('mode-passages').click();
  assert.ok($('passage-body').querySelector('[data-cue-id="shelf-0-cue-900"]'));assert.equal($('reading-context').hidden,false);
  $('mode-bilingual').click();assert.equal(w.document.activeElement.dataset.segmentId,'shelf-0-cue-900');
  $('return-reading-results').click();assert.equal($('search').value,'source sentence 900.');assert.equal($('transcript').querySelectorAll('.segment').length,1);
 }finally{await w.happyDOM.close();}
});
