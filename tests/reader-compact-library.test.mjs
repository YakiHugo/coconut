import {compactShelfResultReady} from './helpers/compact-library-proof.mjs';
import {libraryToolsLayoutReady,openLibraryTools} from './helpers/library-tools-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
function setup(mobile=true){
 let media,listener;const h=libraryHarness(largeLibraryFixture(500),{configureCore(w){
  const original=w.matchMedia.bind(w);media={matches:mobile,addEventListener(type,fn){listener=fn;}};
  w.matchMedia=query=>query==='(max-width: 650px)'?media:original(query);
 }});return {...h,resize(value){media.matches=value;listener();},setViewport(value){media.matches=value;},deliverChange(){listener();}};
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

test('browser tools readiness requires every real tool to reach the current responsive home',async()=>{
 const {w,$,setViewport,deliverChange}=setup(false);try{
  const ready=()=>libraryToolsLayoutReady(null,w.document);
  assert.equal(ready(),true);setViewport(true);assert.equal(ready(),false);
  deliverChange();assert.equal(ready(),true);assert.equal($('library-tools').open,false);
  for(const node of [$('open-library-notebook'),w.document.querySelector('.library-backup'),$('library-options'),$('library-pagination')]){
   $('library-list').append(node);assert.equal(ready(),false);
   deliverChange();assert.equal(ready(),true);
  }
  setViewport(false);assert.equal(ready(),false);deliverChange();assert.equal(ready(),true);
  // Coalesced viewport changes must be judged against the current breakpoint.
  setViewport(true);setViewport(false);assert.equal(ready(),true);
 }finally{await w.happyDOM.close();}
});

test('browser helper waits for delayed responsive ownership before a normal mobile disclosure click',async()=>{
 const {w,$,setViewport,deliverChange}=setup(false);try{
  $('library-options').open=true;$('library').querySelector('.library-open').focus();setViewport(true);
  let resumeLayout,enteredWait;const actions=[],waiting=new Promise(resolve=>{enteredWait=resolve;});
  // This CPU adapter models only native hidden/details ancestry and the narrow
  // shelf toggle. It is not a substitute for browser layout or hit-target proof.
  function visible(node){
   if(node.id==='toggle-library')return w.matchMedia('(max-width: 650px)').matches;
   if(node.closest('#library-list')&&w.matchMedia('(max-width: 650px)').matches&&$('toggle-library').getAttribute('aria-expanded')!=='true')return false;
   for(let parent=node;parent;parent=parent.parentElement){
    if(parent.hidden)return false;
    if(parent!==node&&parent.localName==='details'&&!parent.open&&!parent.querySelector(':scope > summary')?.contains(node))return false;
   }
   return true;
  }
  function locator(selector,root=w.document){
   const node=root.querySelector(selector);assert.ok(node,selector);
   return {
    async isVisible(){return visible(node);},async getAttribute(name){return node.getAttribute(name);},async evaluate(fn){return fn(node);},
    locator(selector){return locator(selector,node);},
    async click(){assert.equal(visible(node),true,'ordinary click requires a visible entry');actions.push(node.id||node.parentElement.id+' > '+node.localName);node.click();}
   };
  }
  const opening=openLibraryTools({locator,async waitForFunction(predicate){
   assert.equal(predicate(null,w.document),false,'the media condition changed before the app moved its tools');
   await new Promise(resolve=>{resumeLayout=resolve;enteredWait();});
   assert.equal(predicate(null,w.document),true,'wait completes only after the app owns the correct DOM');
  }});
  // The legacy helper completes too early. The fixed helper remains pending
  // until the existing app callback runs; no timer, style, or disclosure is forced.
  await Promise.race([opening,waiting]);assert.deepEqual(actions,[]);
  deliverChange();assert.equal($('library-tools').open,false);resumeLayout?.();await opening;
  assert.deepEqual(actions,['library-tools > summary']);
  assert.equal(visible($('library-tools').querySelector(':scope > summary')),true);assert.equal($('library-options').open,true);
  // Happy DOM has no summary default toggle. The real-browser journey must
  // still open it with this ordinary click before using the unchanged controls.
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

test('desktop shelf focus owns narrow visibility before delayed MQL delivery without changing caret',async()=>{
 const {w,$,setViewport,deliverChange}=setup(false);try{
  const search=$('library-search');assert.equal($('toggle-library').getAttribute('aria-expanded'),'false');
  search.value='authored query';search.focus();search.setSelectionRange(2,7,'forward');
  assert.equal($('toggle-library').getAttribute('aria-expanded'),'true');
  setViewport(true); // CSS may apply now; the change callback has not run.
  assert.equal($('toggle-library').getAttribute('aria-expanded'),'true');assert.equal(w.document.activeElement,search);
  assert.equal(search.selectionStart,2);assert.equal(search.selectionEnd,7);
  deliverChange();assert.equal(w.document.activeElement,search);assert.equal(search.selectionStart,2);assert.equal(search.selectionEnd,7);
 }finally{await w.happyDOM.close();}
});
test('desktop reader navigation and explicit blur clear shelf ownership before narrowing',async()=>{
 const {w,$,setViewport,deliverChange}=setup(false);try{
  for(const leave of [()=> $('title').focus(),()=> $('library-search').blur(),()=> $('add-content').click()]){
   setViewport(false);deliverChange();$('library-search').focus();assert.equal($('toggle-library').getAttribute('aria-expanded'),'true');
   leave();const intended=w.document.activeElement;assert.equal($('toggle-library').getAttribute('aria-expanded'),'false');
   setViewport(true);deliverChange();assert.equal($('toggle-library').getAttribute('aria-expanded'),'false');assert.equal(w.document.activeElement,intended);
  }
 }finally{await w.happyDOM.close();}
});
test('rapid mobile desktop-focus mobile crossing does not require an MQL event to retain ownership',async()=>{
 const {w,$,setViewport,deliverChange}=setup();try{
  setViewport(false); // No callback: the browser may coalesce this transition.
  $('library-search').focus();assert.equal($('toggle-library').getAttribute('aria-expanded'),'true');
  setViewport(true);assert.equal($('toggle-library').getAttribute('aria-expanded'),'true');assert.equal(w.document.activeElement,$('library-search'));
  $('toggle-library').click();assert.equal($('toggle-library').getAttribute('aria-expanded'),'false');const intended=w.document.activeElement;
  deliverChange();assert.equal($('toggle-library').getAttribute('aria-expanded'),'false');assert.equal(w.document.activeElement,intended);
 }finally{await w.happyDOM.close();}
});

test('new desktop reader focus clears ownership even when a focused shelf node was removed',async()=>{
 const {w,$,setViewport,deliverChange}=setup(false);try{
  const search=$('library-search');search.focus();search.remove();
  // A browser need not dispatch focusout for a removed focused element.
  $('toggle-library').setAttribute('aria-expanded','true');$('title').focus();
  assert.equal($('toggle-library').getAttribute('aria-expanded'),'false');
  setViewport(true);deliverChange();assert.equal($('toggle-library').getAttribute('aria-expanded'),'false');assert.equal(w.document.activeElement,$('title'));
 }finally{await w.happyDOM.close();}
});

for(const collectionOnly of [false,true])test(`first mobile shelf opening without a captured reader focus works for ${collectionOnly?'a collection-only library':'an empty library'}`,async()=>{
 const collection={key:'collection-only',schema_version:1,project_kind:'reading_collection',collection_version:1,title:'Only collection',segments:[],notes:{},items:[]};
 const {w,$}=libraryHarness(collectionOnly?[collection]:[],{configureCore(w){
  const original=w.matchMedia.bind(w);w.matchMedia=query=>query==='(max-width: 650px)'?{matches:true,addEventListener(){}}:original(query);
 }});
 try{
  assert.equal($('reader-workspace').hidden,true);assert.equal($('toggle-library').getAttribute('aria-expanded'),'false');
  // Native button activation does not first focus a control in main-content.
  // Call its real handler directly so an event-listener exception fails here.
  assert.doesNotThrow(()=>$('toggle-library').onclick());assert.equal($('toggle-library').getAttribute('aria-expanded'),'true');
  $('library-tools').open=true;$('open-library-notebook').click();assert.equal($('library-notebook').open,true);
  if(collectionOnly){$('collection-tools').open=true;$('collection-tools').dispatchEvent(new w.Event('toggle'));$('collection-select').value=collection.key;$('collection-select').onchange();assert.equal($('collection-title').value,collection.title);assert.equal($('collection-status').dataset.state,'saved');}
  $('notebook-close').click();$('toggle-library').onclick();assert.equal($('toggle-library').getAttribute('aria-expanded'),'false');assert.equal(w.document.activeElement,$('main-content'));
  $('toggle-library').onclick();assert.equal($('toggle-library').getAttribute('aria-expanded'),'true');assert.equal($('reader-workspace').hidden,true);
 }finally{await w.happyDOM.close();}
});
