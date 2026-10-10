import {compactShelfResultReady} from './helpers/compact-library-proof.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
function setup(mobile=true){
 let media,listener;const h=libraryHarness(largeLibraryFixture(500),{configureCore(w){
  const original=w.matchMedia.bind(w);media={matches:mobile,addEventListener(type,fn){listener=fn;}};
  w.matchMedia=query=>query==='(max-width: 650px)'?media:original(query);
 }});return {...h,resize(value){media.matches=value;listener();}};
}
test('mobile tools keep original nodes, edits, open state and focus through repeated desktop resize',async()=>{
 const {w,$,resize}=setup();try{
  const nodes=['open-library-notebook','library-options','library-pagination'].map($),backup=w.document.querySelector('.library-backup');
  assert.equal($('library-tools').hidden,false);assert.equal($('library-tools').open,false);
  assert.ok(nodes.every(n=>$('library-tools-content').contains(n)));assert.equal($('library').children.length,40);
  $('library-tools').open=true;$('library-options').open=true;backup.open=true;$('library-sort').value='title';$('library-sort').focus();
  for(let i=0;i<3;i++){
   resize(false);assert.equal($('library-tools').hidden,true);assert.equal(w.document.activeElement,$('library-sort'));
   assert.equal($('open-library-notebook').nextElementSibling.className,'library-search');
   assert.equal(backup.nextElementSibling.className,'eyebrow');
   assert.equal($('library-options').nextElementSibling.id,'library-page-status');
   assert.equal($('library-pagination').nextElementSibling.id,'library');
   resize(true);assert.equal($('library-tools').open,true);assert.equal(w.document.activeElement,$('library-sort'));
   assert.equal($('library-sort').value,'title');assert.equal(backup.open,true);assert.equal($('library-options').open,true);
   assert.ok(nodes.every(n=>$('library-tools-content').contains(n)));
  }
  $('library-sort').onchange();$('library-page-number').value='13';$('library-page-form').onsubmit({preventDefault(){}});
  assert.equal($('library').children.length,20);assert.equal($('library').firstElementChild.dataset.documentKey,'shelf-480');
 }finally{await w.happyDOM.close();}
});
test('mobile close, Escape and current-document activation preserve live reader focus without navigation',async()=>{
 const {w,$}=setup();try{
  const title=$('title'),card=$('library').querySelector('.library-open');title.focus();$('toggle-library').click();
  $('library-search').focus();$('library-search').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal($('toggle-library').getAttribute('aria-expanded'),'false');assert.equal(w.document.activeElement,title);
  $('toggle-library').click();card.click();assert.equal(w.document.activeElement,title);assert.equal($('title'),title);
  $('toggle-library').click();$('toggle-library').click();assert.equal(w.document.activeElement,title);
 }finally{await w.happyDOM.close();}
});
test('Escape respects IME, prevented events and dialogs; stale reader origins cannot steal new focus',async()=>{
 const {w,$}=setup();try{
  $('title').focus();$('toggle-library').click();$('library-search').focus();
  for(const options of [{isComposing:true},{}]){const event=new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true,...options});if(!options.isComposing)event.preventDefault();$('library-search').dispatchEvent(event);assert.equal($('toggle-library').getAttribute('aria-expanded'),'true');}
  $('library-notebook').setAttribute('open','');$('library-search').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal($('toggle-library').getAttribute('aria-expanded'),'true');$('library-notebook').removeAttribute('open');
  const old=$('title');old.focus();$('toggle-library').click();$('toggle-library').click();
  old.remove();$('library-search').focus();$('toggle-library').click();assert.notEqual(w.document.activeElement,old);
 }finally{await w.happyDOM.close();}
});

test('desktop focused tools, search and card stay visible when entering mobile from a collapsed toggle',async()=>{
 const {w,$,resize}=setup(false);try{
  for(const control of [$('library-search'),$('library').querySelector('.library-open'),$('library-sort')]){
   resize(false);$('toggle-library').setAttribute('aria-expanded','false');$('library-options').open=true;control.focus();resize(true);
   assert.equal($('toggle-library').getAttribute('aria-expanded'),'true');assert.equal(w.document.activeElement,control);
   if(control===$('library-sort'))assert.equal($('library-tools').open,true);
  }
  resize(false);$('toggle-library').setAttribute('aria-expanded','false');$('title').focus();resize(true);
  assert.equal($('toggle-library').getAttribute('aria-expanded'),'false');assert.equal(w.document.activeElement,$('title'));
 }finally{await w.happyDOM.close();}
});
test('selecting the active document from Add opens reading rather than returning to the URL field',async()=>{
 const {w,$}=setup();try{
  $('add-content').click();assert.equal($('reader-workspace').hidden,true);assert.equal(w.document.activeElement,$('video-url'));
  $('toggle-library').click();$('library').querySelector('.library-open').click();
  assert.equal($('reader-workspace').hidden,false);assert.equal(w.document.activeElement,$('title'));
 }finally{await w.happyDOM.close();}
});
test('a focused control owns prevented Escape before the library handler runs',async()=>{
 const {w,$}=setup();try{
  $('toggle-library').click();$('library-search').focus();let called=false;
  $('library-search').addEventListener('keydown',event=>{called=true;event.preventDefault();});
  $('library-search').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal(called,true);assert.equal($('toggle-library').getAttribute('aria-expanded'),'true');
 }finally{await w.happyDOM.close();}
});
test('closing a programmatically opened empty shelf does not require a captured reader origin',async()=>{
 const {w,$}=libraryHarness([]);try{
  $('toggle-library').setAttribute('aria-expanded','true');$('toggle-library').click();
  assert.equal($('toggle-library').getAttribute('aria-expanded'),'false');assert.equal(w.document.activeElement,$('main-content'));
 }finally{await w.happyDOM.close();}
});

test('desktop transition moves focus from mobile-only close and tools summary to visible search',async()=>{
 const {w,$,resize}=setup();try{
  for(const control of [$('toggle-library'),$('library-tools').querySelector('summary')]){
   resize(true);$('toggle-library').setAttribute('aria-expanded','true');control.focus();resize(false);
   assert.equal($('library-tools').hidden,true);assert.equal(w.document.activeElement,$('library-search'));
  }
 }finally{await w.happyDOM.close();}
});

test('browser proof waits for this query to finish and render the exact expected result',()=>{
 const expected={query:'last authored title',key:'shelf-499',count:1};
 const input={value:expected.query};let busy='false',cards=[{dataset:{documentKey:expected.key}}];
 const host={hidden:false,getAttribute:name=>name==='aria-busy'?busy:null,querySelectorAll:()=>cards};
 const root={getElementById:id=>id==='library'?host:id==='library-search'?input:null};
 assert.equal(compactShelfResultReady(expected,root),true);
 busy='true';assert.equal(compactShelfResultReady(expected,root),false);busy='false';
 input.value='earlier query';assert.equal(compactShelfResultReady(expected,root),false);input.value=expected.query;
 host.hidden=true;assert.equal(compactShelfResultReady(expected,root),false);host.hidden=false;
 cards=[{dataset:{documentKey:'shelf-0'}}];assert.equal(compactShelfResultReady(expected,root),false);
 cards=[{dataset:{documentKey:expected.key}},{dataset:{documentKey:'shelf-0'}}];assert.equal(compactShelfResultReady(expected,root),false);
 cards=[];assert.equal(compactShelfResultReady(expected,root),false);
 cards=[{dataset:{documentKey:expected.key}}];assert.equal(compactShelfResultReady(expected,root),true);
});
