import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
import {settle} from './helpers/save-pipeline.mjs';
function fixture(){const docs=largeLibraryFixture(2,{cues:65});for(const doc of docs){doc.segments.forEach(cue=>cue.saved_excerpt=true);doc.notes={[doc.segments[64].id]:'Private final thought '+doc.key};}return docs;}
function open($,w){$('open-library-notebook').click();$('collection-tools').open=true;$('collection-tools').dispatchEvent(new w.Event('toggle'));}
async function create($,name='Course findings'){$('collection-title').value=name;$('collection-save-title').click();await settle();}
function rows($){return [...$('notebook-captures').children];}
async function pick($,index=0){rows($)[index].querySelector('.collection-add').click();await settle();}
test('individual cross-page and cross-document picks retain exact membership, order, title and exported content without source mutation',async()=>{
 const {w,$,pipeline}=libraryHarness(fixture(),{probe:true});try{
  const original=JSON.stringify(w.libraryProbe.documents),title=$('title').textContent,transcript=$('transcript').innerHTML;
  let blob;w.URL.createObjectURL=b=>{blob=b;return 'blob:collection';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};
  open($,w);await create($);await pick($);$('notebook-next').click();await pick($,2);$('notebook-search').value='Private final thought shelf-1';$('notebook-search').oninput();await pick($);
  const doc=w.libraryProbe.documents.find(d=>d.project_kind==='reading_collection');assert.equal(doc.items.length,3);assert.equal(JSON.stringify(w.libraryProbe.documents.filter(d=>d!==doc)),original);assert.equal($('title').textContent,title);assert.equal($('transcript').innerHTML,transcript);
  const ids=doc.items.map(item=>item.id);$('collection-items').lastElementChild.querySelector('.collection-up').click();assert.deepEqual([...doc.items.map(item=>item.id)],[ids[0],ids[2],ids[1]]);
  $('collection-preview-button').click();assert.equal($('collection-preview').hidden,false);assert.match($('collection-preview').textContent,/Private final thought/);
  $('collection-export').click();assert.equal(await blob.text(),$('collection-preview').textContent);assert.doesNotMatch(await blob.text(),/source sentence 1\n/);
  await pipeline.store.flush();assert.equal($('collection-status').dataset.state,'saved');
  assert.equal($('library-total').textContent,'2');assert.equal([...$('library').children].some(row=>row.dataset.documentKey===doc.key),false);
  const persisted=JSON.parse(w.localStorage.getItem('coconut-reader-v1'));assert.equal(persisted.documents.find(d=>d.key===doc.key).items.length,3);
 }finally{await w.happyDOM.close();}
});
test('title drafts survive close, block switching and can explicitly cancel; saved collections reopen without reader activation',async()=>{
 const {w,$,pipeline}=libraryHarness(fixture(),{probe:true});try{open($,w);await create($,'First');await pick($);await pipeline.store.flush();
  const doc=w.libraryProbe.documents.at(-1);$('collection-title').value='Unsubmitted';$('notebook-close').click();open($,w);assert.equal($('collection-title').value,'Unsubmitted');
  $('collection-select').value='';$('collection-select').onchange();assert.equal($('collection-select').value,doc.key);assert.match($('collection-status').textContent,/尚未提交/);
  $('collection-reset-title').click();assert.equal($('collection-title').value,'First');$('collection-title').value='Renamed';$('collection-save-title').click();assert.equal(doc.title,'Renamed');await pipeline.store.flush();
  $('collection-select').value='';$('collection-select').onchange();await create($,'Second');assert.equal(w.libraryProbe.documents.filter(d=>d.project_kind==='reading_collection').length,2);
  $('collection-select').value=doc.key;$('collection-select').onchange();assert.equal($('collection-items').children.length,1);assert.notEqual($('title').textContent,doc.title);
 }finally{await w.happyDOM.close();}
});
test('selected snapshots remain after source edit/deletion, duplicate and stale capture clicks cannot add unintended content',async()=>{
 const {w,$}=libraryHarness(fixture(),{probe:true});try{open($,w);await create($);const stale=rows($)[0].querySelector('.collection-add');await pick($);await pick($);const doc=w.libraryProbe.documents.at(-1);assert.equal(doc.items.length,1);
  const snapshot=JSON.stringify(doc.items);w.libraryProbe.documents[0].segments[0].text='Changed source';stale.click();assert.equal(doc.items.length,1);assert.equal(JSON.stringify(doc.items),snapshot);
  w.libraryProbe.documents.splice(0,1);$('collection-tools').dispatchEvent(new w.Event('toggle'));assert.match($('collection-items').textContent,/本书架无此来源/);assert.equal(JSON.stringify(doc.items),snapshot);
  $('collection-items').querySelector('.collection-remove').click();assert.equal(doc.items.length,0);assert.equal($('collection-export').disabled,true);assert.equal(w.document.activeElement,$('collection-title'));
 }finally{await w.happyDOM.close();}
});
test('failed persistence and failed downloads retain all selected data for retry without stealing title caret',async()=>{
 const {w,$,pipeline}=libraryHarness(fixture(),{probe:true});try{open($,w);await create($);await pick($);pipeline.hold();const pending=pipeline.store.flush();await settle();assert.equal(pipeline.writes.length,1);
  $('collection-title').focus();$('collection-title').value='Draft title';$('collection-title').setSelectionRange(2,4);pipeline.writes[0].fail();await pending;assert.equal($('collection-status').dataset.state,'failed');assert.equal($('collection-retry').hidden,false);assert.equal(w.document.activeElement,$('collection-title'));assert.equal($('collection-title').selectionStart,2);
  const doc=w.libraryProbe.documents.at(-1),snapshot=JSON.stringify(doc.items);w.URL.createObjectURL=()=>{throw Error('blocked download');};$('collection-export').click();assert.match($('collection-status').textContent,/下载失败/);assert.equal(JSON.stringify(doc.items),snapshot);
  pipeline.hold(false);await $('collection-retry').onclick();assert.equal($('collection-status').dataset.state,'saved');assert.equal($('collection-title').value,'Draft title');
 }finally{await w.happyDOM.close();}
});
test('collection list stays bounded and reorder across page boundary preserves focused identity',async()=>{
 const {w,$}=libraryHarness(fixture(),{probe:true});try{open($,w);await create($);for(let i=0;i<22;i++)await pick($,i);assert.equal($('collection-items').children.length,20);$('collection-next').click();assert.equal($('collection-items').children.length,2);
  const item=$('collection-items').firstElementChild,id=item.dataset.itemId;item.querySelector('.collection-up').click();assert.equal($('collection-items').children.length,20);assert.equal(w.document.activeElement.closest('li').dataset.itemId,id);
  const player=w.document.createElement('audio');let pauses=0;player.pause=()=>pauses++;$('source-media').append(player);$('collection-preview-button').click();assert.equal(pauses,0);
 }finally{await w.happyDOM.close();}
});
test('a library containing only collections remains accessible, independently recoverable and removable with Undo',async()=>{
 const first=libraryHarness(fixture(),{probe:true});let collection;
 try{open(first.$,first.w);await create(first.$);await pick(first.$);collection=JSON.parse(JSON.stringify(first.w.libraryProbe.documents.at(-1)));}finally{await first.w.happyDOM.close();}
 const {w,$,pipeline}=libraryHarness([collection],{probe:true});try{
  assert.equal($('library-total').textContent,'0');assert.equal($('reader-workspace').hidden,true);open($,w);assert.equal(rows($).length,0);
  $('collection-select').value=collection.key;$('collection-select').onchange();assert.equal($('collection-items').children.length,1);assert.equal($('collection-status').dataset.state,'saved');assert.match($('collection-status').textContent,/已保存到本机/);assert.equal($('collection-retry').hidden,true);assert.match($('collection-items').textContent,/本书架无此来源/);
  let blob;w.URL.createObjectURL=b=>{blob=b;return 'blob:backup';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};$('collection-backup').click();const backup=JSON.parse(await blob.text());assert.equal(backup.active,null);assert.deepEqual(backup.documents,[collection]);
  $('collection-delete').click();assert.equal($('library-notebook').open,false);assert.equal($('remove-document-dialog').open,true);await $('confirm-removal').onclick();assert.equal(w.libraryProbe.documents.length,0);$('export-removed-document').click();const rescue=JSON.parse(await blob.text());assert.deepEqual(rescue.documents,[collection]);assert.equal(rescue.active,null);assert.deepEqual(JSON.parse(JSON.stringify(w.Coconut.mergeLibraryBackup({documents:[],active:null},rescue).documents)),[collection]);
  await $('undo-removal').onclick();await pipeline.store.flush();open($,w);$('collection-select').value=collection.key;$('collection-select').onchange();assert.equal($('collection-items').children.length,1);$('collection-delete').click();await $('confirm-removal').onclick();$('finish-removal').click();$('confirm-finish-removal').click();const unload=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(unload);assert.equal(unload.defaultPrevented,false);
 }finally{await w.happyDOM.close();}
});
test('adding a record keeps its keyboard focus and collection receipts never rerender source controls',async()=>{
 const {w,$,pipeline}=libraryHarness(fixture(),{probe:true});try{open($,w);await create($);const button=rows($)[0].querySelector('.collection-add');button.focus();await pick($);assert.equal(w.document.activeElement,button);assert.equal(button.isConnected,true);assert.equal(button.getAttribute('aria-disabled'),'true');await pipeline.store.flush();assert.equal(w.document.activeElement,button);assert.equal(button.isConnected,true);
 }finally{await w.happyDOM.close();}
});
test('bare collection files cannot enter transcript import or change active source',async()=>{
 const {w,$}=libraryHarness(fixture(),{probe:true});try{const collection=w.Coconut.createReadingCollection({key:'bare-collection',title:'Bare collection',items:[]});const title=$('title').textContent;
  $('add-content').click();Object.defineProperty($('file'),'files',{configurable:true,value:[{name:'bare.json',size:100,text:async()=>JSON.stringify(collection)}]});await $('file').onchange();
  assert.equal(w.libraryProbe.documents.length,2);assert.equal($('title').textContent,title);assert.match($('notice').textContent,/恢复书架备份/);
 }finally{await w.happyDOM.close();}
});

test('stale reorder controls cannot create out-of-range entries and invalid rename leaves the saved collection intact',async()=>{
 const {w,$}=libraryHarness(fixture(),{probe:true});try{open($,w);await create($);await pick($);await pick($,1);const doc=w.libraryProbe.documents.at(-1),up=$('collection-items').lastElementChild.querySelector('.collection-up');up.click();up.click();assert.equal(doc.items.length,2);assert.ok(doc.items.every(Boolean));
  const title=doc.title;$('collection-title').value='x'.repeat(501);$('collection-save-title').click();assert.equal(doc.title,title);assert.match($('collection-status').textContent,/未创建/);
 }finally{await w.happyDOM.close();}
});
