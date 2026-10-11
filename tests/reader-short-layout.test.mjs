import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {readFirstFixture} from './helpers/read-first-fixture.mjs';
function setup(count=3,{width=320,bilingual=false}={}){
 const doc=readFirstFixture(count,{demo:bilingual});delete doc.provenance;doc.title='A complete authored title for compact short reading';
 const h=libraryHarness([doc],{probe:true,configureCore:w=>w.happyDOM.setWindowSize({width,height:900})});return {...h,doc};
}
for(const width of [320,390])for(const bilingual of [false,true])test(`${width} short ${bilingual?'bilingual':'source'} has compact header and fixed, reachable controls`,async()=>{
 const {w,$,doc}=setup(3,{width,bilingual});try{
  assert.equal(w.document.body.dataset.headerCompact,'true');assert.equal(w.document.body.dataset.shortReadingCompact,'true');assert.equal($('title').parentElement,$('reader-title-slot'));
  assert.equal($('reading-info-title').textContent,doc.title);assert.equal($('subtitle').parentElement,$('reading-info-meta'));assert.equal($('reading-settings').parentElement,$('reading-info-settings'));
  assert.equal(w.document.querySelector('.passage-toolbar').hidden,true);assert.equal($('reading-utility').classList.contains('is-passage'),false);
  assert.equal($('transcript-tools-disclosure').open,false);assert.equal($('transcript-reading-tools').parentElement,$('transcript-tools-disclosure'));assert.equal($('transcript-tools-label').hidden,false);
  $('reading-info').open=true;assert.equal($('reading-settings').open,true);$('close-reading-info').click();assert.equal(w.document.activeElement,$('reading-info').querySelector('summary'));
  w.document.querySelector('.segment').focus();w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'/',bubbles:true}));assert.equal($('transcript-tools-disclosure').open,true);assert.equal(w.document.activeElement,$('search'));
  $('search').value='observation 2';$('search').oninput();assert.match($('transcript-tools-label').textContent,/observation 2/);assert.equal($('transcript').querySelectorAll('.segment').length,1);
  $('transcript-tools-disclosure').open=false;assert.match($('transcript-tools-label').textContent,/筛选中/);
  $('clear-search').click();assert.equal($('transcript-tools-disclosure').open,true);assert.equal(w.document.activeElement,$('search'));assert.equal($('transcript').querySelectorAll('.segment').length,3);
  $('filter-notes').click();assert.match($('transcript-tools-label').textContent,/仅笔记/);$('filter-all').click();
  $('mode-summary').click();assert.equal($('transcript-tools-label').hidden,true);$('summary-open-transcript').click();assert.equal($('transcript-tools-disclosure').open,true);assert.equal(w.document.activeElement,$('search'));
 }finally{await w.happyDOM.close();}
});
test('desktop and long-cue-mode reading do not gain the short disclosure; passages keep their own toolbar',async()=>{
 for(const [count,width] of [[3,1360],[12,320]]){
  const {w,$}=setup(count,{width});try{
   if(count===12){assert.equal($('reading-utility').classList.contains('is-passage'),true);assert.equal(w.document.querySelector('.passage-toolbar').hidden,false);$('mode-transcript').click();}
   assert.equal(w.document.body.dataset.shortReadingCompact,'false');assert.equal($('transcript-tools-disclosure').open,true);assert.equal($('transcript-tools-label').hidden,true);assert.equal(w.document.querySelector('.passage-toolbar').hidden,true);
  }finally{await w.happyDOM.close();}
 }
});
test('resizing never reparents, blurs or loses the active search input selection',async()=>{
 const {w,$}=setup(3,{width:1360});try{
  const search=$('search'),parent=search.parentElement,toolsParent=$('transcript-reading-tools').parentElement;let blurs=0;search.addEventListener('blur',()=>blurs++);
  search.value='Authored observation';search.focus();search.setSelectionRange(2,8);search.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));
  for(const width of [320,1360,390]){w.happyDOM.setWindowSize({width,height:900});assert.equal(w.document.activeElement,search);assert.equal(search.parentElement,parent);assert.equal($('transcript-reading-tools').parentElement,toolsParent);assert.equal(search.selectionStart,2);assert.equal(search.selectionEnd,8);assert.equal($('transcript-tools-disclosure').open,true);}
  assert.equal(blurs,0);search.dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true}));
 }finally{await w.happyDOM.close();}
});
test('note/bookmark edits retain their cue focus and leave the tools collapsed',async()=>{
 const {w,$}=setup();try{
  const first=()=>w.document.querySelector('.segment');first().querySelector('.bookmark-button').click();assert.equal(w.document.activeElement,first().querySelector('.bookmark-button'));assert.equal($('transcript-tools-disclosure').open,false);
  first().querySelector('.note-button').click();$('note').value='Authored note';$('note').dispatchEvent(new w.Event('input',{bubbles:true}));$('return-excerpt').click();assert.equal(w.document.activeElement.dataset.segmentId,'read-0');assert.equal($('transcript-tools-disclosure').open,false);
  await w.flushContentForTest();assert.equal(w.libraryProbe.documents[0].notes['read-0'],'Authored note');assert.equal(w.libraryProbe.documents[0].readingPosition,'read-0');
 }finally{await w.happyDOM.close();}
});
test('compact header information does not collapse, replace or play attached transcript media',async()=>{
 const {w,$}=setup();try{
  w.URL.createObjectURL=()=> 'blob:authored';w.URL.revokeObjectURL=()=>{};$('attach-reader-media').click();
  Object.defineProperty($('reader-media-file'),'files',{configurable:true,value:[{name:'authored.wav',type:'audio/wav',size:64,slice:()=>({text:async()=> 'RIFF authored'})}]});await $('reader-media-file').onchange();
  const player=$('source-media').querySelector('audio');assert.ok(player);assert.equal($('episode-media').hidden,false);let plays=0;player.play=async()=>plays++;
  $('reading-info').querySelector('summary').click();assert.equal($('episode-media').hidden,false);assert.equal($('source-media').querySelector('audio'),player);assert.equal(plays,0);
  $('mode-summary').click();$('mode-transcript').click();assert.equal($('episode-media').hidden,false);assert.equal($('source-media').querySelector('audio'),player);assert.equal(plays,0);
 }finally{await w.happyDOM.close();}
});
test('settings caret and IME ownership defer breakpoint reparenting until focus leaves settings',async()=>{
 const {w,$}=setup(3,{width:1360});try{
  const settings=$('reading-settings'),input=$('reading-time');settings.open=true;input.value='00:05';input.focus();input.setSelectionRange(1,4);input.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));let blurs=0;input.addEventListener('blur',()=>blurs++);
  w.happyDOM.setWindowSize({width:320,height:900});assert.equal(settings.parentElement,$('reader-options'));assert.equal(w.document.activeElement,input);assert.equal(input.selectionStart,1);assert.equal(input.selectionEnd,4);assert.equal(blurs,0);assert.equal(w.document.body.dataset.headerCompact,'false');
  settings.querySelector('button').focus();await Promise.resolve();assert.equal(settings.parentElement,$('reader-options'),'focus within settings must keep the same parent');
  w.document.querySelector('.segment').focus();await Promise.resolve();assert.equal(settings.parentElement,$('reading-info-settings'));assert.equal(w.document.body.dataset.headerCompact,'true');
  $('reading-info').open=true;input.focus();input.setSelectionRange(1,4);const before=blurs;w.happyDOM.setWindowSize({width:1360,height:900});
  assert.equal(settings.parentElement,$('reading-info-settings'));assert.equal($('reading-info').hidden,false);assert.equal($('reading-info').open,true);assert.equal(w.document.activeElement,input);assert.equal(input.selectionStart,1);assert.equal(input.selectionEnd,4);assert.equal(blurs,before);
  input.dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true}));w.document.querySelector('.segment').focus();await Promise.resolve();assert.equal(settings.parentElement,$('reader-options'));assert.equal(w.document.body.dataset.headerCompact,'false');
 }finally{await w.happyDOM.close();}
});
test('importing a different short source clears the old filter before composing its collapsed tools',async()=>{
 const {w,$}=setup();try{
  $('search').value='observation 2';$('search').oninput();const doc=readFirstFixture(2),text=JSON.stringify(doc);
  Object.defineProperty($('file'),'files',{configurable:true,value:[{name:'fresh.json',size:text.length,text:async()=>text}]});await $('file').onchange();
  assert.equal($('search').value,'');assert.equal($('transcript-tools-disclosure').open,false);assert.equal($('transcript-tools-label').textContent,'搜索与筛选');assert.equal($('transcript').querySelectorAll('.segment').length,2);
 }finally{await w.happyDOM.close();}
});
