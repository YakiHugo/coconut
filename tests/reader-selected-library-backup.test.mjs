import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {installSelectedBackupWriteProbe} from './helpers/selected-backup-write-probe.mjs';
/** Selected backup is identity-owned, session-only and uses the existing restore format. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
import {annotatedDocument} from './helpers/backup-fixtures.mjs';
import {settle} from './helpers/save-pipeline.mjs';
const require=createRequire(import.meta.url),C=require('../reader/core.js');
const clone=value=>JSON.parse(JSON.stringify(value));
const KEY='coconut-reader-v1';
function richDocument(){
 const doc={...C.validate(annotatedDocument()),key:'rich'};
 const cue=doc.segments[0];C.saveManualTranslation(doc,cue,'zh','人工核对译文',C.manualReviewSnapshot(doc,cue,'zh'),JSON.stringify(cue.translations.zh));
 doc.ai_answers=Array.from({length:130},(_,index)=>({...doc.ai_answers[0],question:'Historical question '+index}));
 doc.exact_excerpts=[C.exactExcerptSnapshot(doc,doc.segments,[],0,8,{id:'capture',createdAt:'2026-10-11T00:00:00.000Z'})];
 doc.exact_excerpt_notes=C.exactExcerptNotesWith(doc,'capture','Exact private thought');
 doc.project_note='Project private note';doc.timestamp_bookmarks=[{id:'bookmark',time:2,note:'Timestamp private note'}];
 return {...C.validate(doc),key:doc.key};
}
function select($,key){const input=$('library').querySelector(`[data-document-key="${key}"] .library-select`);assert.ok(input,key);input.click();return input;}
function jump($,page){$('library-page-number').value=String(page);$('library-page-form').onsubmit({preventDefault(){}});}
function search($,query){$('library-search').value=query;$('library-search').oninput();}
function downloads(w){const blobs=[];w.URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:selected';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};return blobs;}
async function backup(w,$,id='export-selected-library'){const blobs=downloads(w);$(id).click();assert.equal(blobs.length,1);return JSON.parse(await blobs[0].text());}

test('selected envelope preserves all validated annotation fields, uses shelf order and restores additively',()=>{
 const rich=richDocument(),ordinary={...C.validate(largeLibraryFixture(1)[0]),key:'ordinary'},unselected={...ordinary,key:'private',title:'Do not export'};
 const docs=[ordinary,unselected,rich],selection=C.createLibraryBackupSelection();
 selection.toggle(rich,true,docs);selection.toggle(ordinary,true,docs);
 const payload=clone(selection.backup(docs,'private'));
 assert.deepEqual(payload,{format:'coconut-library',version:1,documents:clone([ordinary,rich]),active:'ordinary'});
 assert.equal(selection.backup(docs,'rich').active,'rich');
 const fresh=C.mergeLibraryBackup({documents:[],active:null},payload);assert.deepEqual(clone(fresh.documents),payload.documents);
 assert.equal(C.mergeLibraryBackup(fresh,payload).documents.length,2);
 const conflict=clone(rich);conflict.notes.cue='New version still kept';
 const merged=C.mergeLibraryBackup({documents:[unselected,conflict],active:unselected.key},payload);
 assert.equal(merged.documents.length,4);assert.equal(merged.documents[0],unselected);assert.equal(merged.documents[1],conflict);
 const restored=merged.documents.find(doc=>doc.key==='rich-restored-1');assert.deepEqual(clone({...restored,key:'rich'}),clone(rich));
 assert.equal(C.mergeLibraryBackup(merged,payload).documents.length,4);
});

test('unannotated local audio projects restore without embedding media bytes',()=>{
 const source={version:1,kind:'audio',name:'Authored.wav',size:64,last_modified:7,type:'audio/wav',fingerprint:'a'.repeat(64)};
 const doc={...C.validate({project_kind:'audio_only',title:'Unannotated audio',local_media_source:source,segments:[]}),key:'audio'};
 const selection=C.createLibraryBackupSelection();selection.toggle(doc,true,[doc]);const payload=clone(selection.backup([doc],null));
 assert.deepEqual(clone(C.mergeLibraryBackup({documents:[],active:null},payload).documents[0]),clone(doc));
 assert.equal(payload.documents[0].segments.length,0);assert.deepEqual(payload.documents[0].local_media_source,source);assert.doesNotMatch(JSON.stringify(payload),/blob:|base64/);
});

test('selection never silently adopts replacement identities or changes membership during structural operations',()=>{
 const doc=richDocument(),other={...doc,key:'other'},docs=[doc,other],selection=C.createLibraryBackupSelection();selection.toggle(doc,true,docs);
 const replacement={...doc,title:'same key, different identity'},pending=new Map([[doc.key,{}]]);
 assert.deepEqual(selection.reconcile([replacement,other],pending),{count:1,removed:0,blocked:true});
 assert.equal(selection.toggle(replacement,true,[replacement,other],pending),false);
 assert.throws(()=>selection.backup([replacement,other],other.key,pending),/正在移除或恢复/);
 assert.throws(()=>selection.backup([replacement,other],other.key),/已移除或替换/);
 assert.equal(selection.has(replacement),false);assert.equal(selection.has(doc),false);
 selection.toggle(doc,true,docs);assert.equal(selection.reconcile([other],pending).count,1);
 assert.throws(()=>selection.backup([other],other.key,pending),/正在移除或恢复/);
 assert.equal(selection.backup(docs,doc.key).documents[0],doc); // Failed operation rolled back the same identity.
 assert.equal(selection.reconcile([other]).removed,1);
 assert.throws(()=>selection.backup(docs,doc.key),/先选择/); // Undo/new same-key identity is not implicitly selected.
});

test('150-document selections cross pages, query and sort without changing storage or reader',async()=>{
 const {w,$}=libraryHarness(largeLibraryFixture(150));try{
  const before=w.localStorage.getItem(KEY),title=$('title'),segments=$('segments'),activeCard=$('library').querySelector('[aria-current="page"]');
  assert.equal($('library-selection-controls').hidden,true);assert.ok([...$('library').querySelectorAll('.library-select-label')].every(label=>label.hidden));
  $('library-options').open=true;$('library-selection-mode').click();const first=select($,'shelf-1');first.focus();
  assert.equal(w.document.activeElement,first);assert.equal(first.getAttribute('aria-label'),'选择备份 Authored shelf 00001 · 完整书架标题');
  for(const index of [4,20,39])select($,'shelf-'+index);
  jump($,2);for(const index of [44,51,79])select($,'shelf-'+index);
  jump($,3);for(const index of [84,100,119])select($,'shelf-'+index);
  jump($,4);for(const index of [125,149])select($,'shelf-'+index);
  assert.match($('library-selection-status').textContent,/已选 12 份.*其中 10 份不在当前页/);
  $('library-search').focus();search($,'00001');assert.equal(w.document.activeElement,$('library-search'));
  assert.equal($('library').children.length,1);assert.equal($('library').querySelector('.library-select').checked,true);
  search($,'no matching title');assert.equal($('library').children.length,0);assert.match($('library-selection-status').textContent,/已选 12 份.*其中 12 份不在当前页/);
  $('library-sort').value='title';$('library-sort').onchange();const payload=await backup(w,$);
  assert.deepEqual(payload.documents.map(doc=>doc.key),[1,4,20,39,44,51,79,84,100,119,125,149].map(index=>'shelf-'+index));assert.equal(payload.active,'shelf-1');
  assert.equal(w.localStorage.getItem(KEY),before);assert.equal($('title'),title);assert.equal($('segments'),segments);assert.equal(activeCard.getAttribute('aria-current'),'page');
  const whole=await backup(w,$,'export-library');assert.equal(whole.documents.length,150);assert.equal(whole.active,'shelf-0');
  search($,'');assert.equal($('library').children.length,40);assert.equal($('library').querySelector('[data-document-key="shelf-1"] .library-select').checked,true);
  $('clear-library-selection').click();assert.equal($('export-selected-library').disabled,true);assert.match($('library-selection-status').textContent,/已选 0 份/);
  select($,'shelf-2');$('library-selection-mode').click();assert.equal($('library-selection-controls').hidden,true);assert.equal($('library-selection-mode').textContent,'选择备份');
  $('library-selection-mode').click();assert.equal($('export-selected-library').disabled,true);assert.equal($('library-selection-mode').textContent,'取消选择');
 }finally{await w.happyDOM.close();}
});

test('export includes current in-memory edits while leaving save status, focus, caret and media untouched',async()=>{
 const {w,$,pipeline}=libraryHarness([richDocument()],{probe:true});try{
  $('library-selection-mode').click();select($,'rich');const doc=w.libraryProbe.documents[0];
  const textarea=w.document.createElement('textarea');textarea.value='Unsubmitted draft';w.document.body.append(textarea);textarea.focus();textarea.setSelectionRange(3,8);
  const media=w.document.createElement('audio');$('source-media').append(media);let pauses=0;media.pause=()=>pauses++;
  doc.notes.cue='Latest unsaved note';pipeline.store.queueDocument(doc.key,doc);pipeline.hold();const flush=pipeline.store.flush();await settle();
  const status=$('save-status').getAttribute('data-state'),disk=w.localStorage.getItem(KEY),blobs=downloads(w);
  $('export-selected-library').onclick();assert.equal(blobs.length,1);const payload=JSON.parse(await blobs[0].text());
  assert.equal(payload.documents[0].notes.cue,'Latest unsaved note');assert.equal(w.localStorage.getItem(KEY),disk);assert.equal($('save-status').getAttribute('data-state'),status);
  assert.equal(w.document.activeElement,textarea);assert.equal(textarea.selectionStart,3);assert.equal(textarea.selectionEnd,8);assert.equal($('source-media').firstChild,media);assert.equal(pauses,0);
  assert.match($('selected-backup-details').textContent,/不代表已保存到书架/);assert.match($('selected-backup-details').textContent,/未提交的编辑草稿/);assert.match($('notice').textContent,/已发起所选 1 份备份下载/);
  pipeline.writes[0].fail();await flush;
 }finally{await w.happyDOM.close();}
});

test('UI prunes replaced identities, informs user and blocks an unrendered stale export',async()=>{
 const {w,$}=libraryHarness(largeLibraryFixture(3),{probe:true});try{
  $('library-selection-mode').click();select($,'shelf-0');select($,'shelf-1');
  const original=w.libraryProbe.documents[0];w.libraryProbe.documents[0]={...original,title:'Replacement'};
  const blobs=downloads(w);$('export-selected-library').onclick();assert.equal(blobs.length,0);assert.match($('notice').textContent,/核对选择数量/);
  assert.match($('library-selection-status').textContent,/已选 1 份.*已取消 1 份/);
  w.libraryProbe.renderLibrary();assert.equal($('library').querySelector('[data-document-key="shelf-0"] .library-select').checked,false);
  const payload=await backup(w,$);assert.deepEqual(payload.documents.map(doc=>doc.key),['shelf-1']);
 }finally{await w.happyDOM.close();}
});

test('pending removal keeps selection count, blocks backup, and rollback preserves selection',async()=>{
 const {w,$,pipeline}=libraryHarness(largeLibraryFixture(3));try{
  $('library-selection-mode').click();select($,'shelf-1');pipeline.hold();
  $('library').querySelector('[data-document-key="shelf-1"] .library-remove').click();const removing=$('confirm-removal').onclick();await settle();
  assert.equal($('export-selected-library').disabled,true);assert.match($('library-selection-status').textContent,/已选 1 份.*正在移除或恢复/);
  const blobs=downloads(w);$('export-selected-library').onclick();assert.equal(blobs.length,0);
  assert.equal(pipeline.writes.length,1);pipeline.writes[0].fail();await removing;
  assert.equal($('library').querySelector('[data-document-key="shelf-1"] .library-select').checked,true);assert.equal($('export-selected-library').disabled,false);
  pipeline.hold(false);$('library').querySelector('[data-document-key="shelf-1"] .library-remove').click();await $('confirm-removal').onclick();
  assert.match($('library-selection-status').textContent,/已选 0 份.*已取消 1 份/);
  await $('undo-removal').onclick();assert.equal($('library').querySelector('[data-document-key="shelf-1"] .library-select').checked,false);
 }finally{await w.happyDOM.close();}
});

for(const failure of ['serialization','object-url','anchor-click'])test(`${failure} failure retains the exact selection and supports retry without persistence changes`,async()=>{
 const {w,$}=libraryHarness(largeLibraryFixture(3));try{
  $('library-selection-mode').click();select($,'shelf-0');select($,'shelf-2');
  const before=w.localStorage.getItem(KEY),stringify=w.JSON.stringify,urls=downloads(w);
  const originalURL=w.URL.createObjectURL,originalClick=w.HTMLAnchorElement.prototype.click;
  const failedBlobs=failure==='anchor-click'?1:0;
  if(failure==='serialization')w.JSON.stringify=function(value,...args){if(value?.format==='coconut-library')throw new Error('Injected serializer failure');return stringify.call(this,value,...args);};
  else if(failure==='object-url')w.URL.createObjectURL=()=>{throw new Error('Injected download failure');};
  else w.HTMLAnchorElement.prototype.click=()=>{throw new Error('Injected anchor failure');};
  $('export-selected-library').click();assert.equal(urls.length,failedBlobs);assert.match($('notice').textContent,/Injected/);
  assert.match($('library-selection-status').textContent,/已选 2 份/);assert.equal($('export-selected-library').disabled,false);
  assert.equal($('library').querySelector('[data-document-key="shelf-0"] .library-select').checked,true);
  assert.equal($('library').querySelector('[data-document-key="shelf-2"] .library-select').checked,true);
  assert.equal(w.document.querySelector('a[download="coconut-selected-library.json"]'),null);assert.equal(w.localStorage.getItem(KEY),before);
  w.JSON.stringify=stringify;w.URL.createObjectURL=originalURL;w.HTMLAnchorElement.prototype.click=originalClick;
  $('export-selected-library').click();assert.equal(urls.length,failedBlobs+1);const payload=JSON.parse(await urls.at(-1).text());
  assert.deepEqual(payload.documents.map(doc=>doc.key),['shelf-0','shelf-2']);assert.equal(payload.active,'shelf-0');assert.equal(w.localStorage.getItem(KEY),before);
 }finally{await w.happyDOM.close();}
});


// Unlike libraryHarness, this path uses the frozen production adapter without
// the generic save-pipeline test wrapper. It reproduces the native CI boundary.
function nativeAdapterHarness({installProbe=false}={}) {
 const w=new Window({url:'https://coconut.example/'}),root=new URL('../',import.meta.url);
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});w.localStorage.setItem(KEY,JSON.stringify({documents:largeLibraryFixture(3),active:'shelf-0'}));
 w.fetch=async()=>{throw new Error('Unexpected network request');};w.HTMLElement.prototype.scrollIntoView=function(){};
 for(const name of ['summary','core','passages','passage-playback','library-store'])w.eval(fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8'));
 if(installProbe)w.eval('('+installSelectedBackupWriteProbe.toString()+')(window);');
 w.eval(['app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+'\nwindow.nativeBackup={adapter:libraryAdapter,store:libraryStore};');
 return {w,$:id=>w.document.getElementById(id)};
}

test('native frozen legacy adapter rejects late writer replacement: the old browser hook never held the removal',async()=>{
 const {w,$}=nativeAdapterHarness();try{
  $('library-options').open=true;$('library-selection-mode').click();select($,'shelf-1');select($,'shelf-2');
  assert.equal(Object.isFrozen(w.nativeBackup.adapter),true);const original=w.nativeBackup.adapter.write;
  // page.evaluate executes this assignment without strict mode, so it silently
  // leaves the real frozen writer intact instead of installing the requested hold.
  w.eval('window.badWriteProbe={writes:[]};window.nativeBackup.adapter.write=function(){badWriteProbe.writes.push(1);return new Promise(()=>{});};');
  assert.equal(w.nativeBackup.adapter.write,original);
  $('library').querySelector('[data-document-key="shelf-1"] .library-remove').click();await $('confirm-removal').onclick();
  assert.equal(w.badWriteProbe.writes.length,0);assert.equal($('save-status').dataset.state,'saved');
  assert.deepEqual(JSON.parse(w.localStorage.getItem(KEY)).documents.map(doc=>doc.key),['shelf-0','shelf-2']);
  assert.match($('library-selection-status').textContent,/已选 1 份/);assert.equal($('export-selected-library').disabled,false);
 }finally{await w.happyDOM.close();}
});

test('browser loading-time hook holds a frozen real adapter and release commits the original write exactly once',async()=>{
 const {w,$}=nativeAdapterHarness({installProbe:true});try{
  const proof=w.selectedBackupWriteProof,adapter=w.nativeBackup.adapter;
  assert.equal(proof.created,1);assert.equal(proof.originalFrozen,true);assert.equal(proof.wrapperFrozen,true);assert.equal(Object.isFrozen(adapter),true);assert.equal(adapter.write,proof.write);
  $('library-options').open=true;$('library-selection-mode').click();select($,'shelf-1');select($,'shelf-2');
  const before=w.localStorage.getItem(KEY);proof.hold=true;
  $('library').querySelector('[data-document-key="shelf-1"] .library-remove').click();const removing=$('confirm-removal').onclick();await settle();
  assert.equal(proof.writes.length,1);assert.equal(proof.captures,1);assert.equal(proof.releases,0);
  assert.equal(w.localStorage.getItem(KEY),before);assert.equal($('save-status').dataset.state,'pending');assert.equal($('export-selected-library').disabled,true);assert.match($('library-selection-status').textContent,/已选 2 份.*正在移除或恢复/);
  proof.hold=false;proof.writes[0].commit();await removing;
  assert.equal(proof.releases,1);assert.equal($('save-status').dataset.state,'saved');assert.equal($('export-selected-library').disabled,false);assert.match($('library-selection-status').textContent,/已选 1 份.*已取消 1 份/);
  assert.deepEqual(JSON.parse(w.localStorage.getItem(KEY)).documents.map(doc=>doc.key),['shelf-0','shelf-2']);assert.throws(()=>proof.writes[0].commit(),/already released/);
 }finally{await w.happyDOM.close();}
});

test('held browser writer preserves the real adapter cancellation signal and leaves disk untouched',async()=>{
 const {w}=nativeAdapterHarness({installProbe:true});try{
  const before=w.localStorage.getItem(KEY),proof=w.selectedBackupWriteProof,controller=new w.AbortController();proof.hold=true;
  const pending=w.nativeBackup.adapter.write('{"documents":[]}',{signal:controller.signal});controller.abort();proof.writes[0].commit();
  const receipt=await pending;assert.equal(receipt.ok,false);assert.equal(receipt.status,'cancelled');assert.equal(w.localStorage.getItem(KEY),before);assert.equal(proof.releases,1);
 }finally{await w.happyDOM.close();}
});

function shelfFocusGeometry({atEnd=true}={}) {
 const env=libraryHarness(largeLibraryFixture(3),{probe:true}),{w,$}=env,frames=[],scrolls=[],windowScrolls=[];
 w.happyDOM.setViewport({width:390,height:844});w.requestAnimationFrame=fn=>{frames.push(fn);return frames.length;};w.scrollBy=value=>windowScrolls.push(value);
 $('library-selection-mode').click();const target=$('library').querySelector('[data-document-key="shelf-1"] .library-select'),label=target.closest('label'),host=$('library-list');
 const initialTop=281;host.scrollTop=initialTop;target.style.outline='3px solid red';target.style.outlineOffset='3px';
 Object.defineProperty(host,'clientHeight',{configurable:true,get:()=>719});Object.defineProperty(host,'clientTop',{configurable:true,get:()=>0});
 Object.defineProperty(host,'scrollHeight',{configurable:true,get:()=>(atEnd?1000:1100)+(parseFloat(host.style.getPropertyValue('--library-keyboard-space'))||0)});
 host.getBoundingClientRect=()=>({left:14,right:376,top:116,bottom:835,width:362,height:719});
 const rect=(top,bottom,left,right)=>({left,right,top:top-(host.scrollTop-initialTop),bottom:bottom-(host.scrollTop-initialTop),width:right-left,height:bottom-top});
 target.getBoundingClientRect=()=>rect(753.234375,773.234375,28,48);label.getBoundingClientRect=()=>rect(741.234375,785.234375,20,370);
 $('reading-feedback').getBoundingClientRect=()=>({left:12,right:378,top:770,bottom:832,width:366,height:62});$('media-dock').hidden=true;
 host.scrollTo=options=>{scrolls.push(options);host.scrollTop=Math.min(host.scrollHeight-host.clientHeight,Math.max(0,options.top));};
 const flush=()=>frames.splice(0).forEach(fn=>fn());
 const tab=(shiftKey=false)=>{$('title').focus();w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',shiftKey,bubbles:true}));target.focus();};
 return {...env,target,label,host,frames,scrolls,windowScrolls,flush,tab};
}

test('real Tab and Shift+Tab reveal the complete checkbox label above live feedback using only minimal bounded shelf scrolling',async()=>{
 const {w,$,pipeline,target,label,host,scrolls,windowScrolls,flush,tab}=shelfFocusGeometry();try{
  const disk=w.localStorage.getItem(KEY);tab();assert.equal(scrolls.length,0);flush();
  assert.equal(scrolls.length,1);assert.equal(scrolls[0].top,300);assert.equal(label.getBoundingClientRect().bottom,766.234375);assert.equal(w.document.activeElement,target);
  assert.equal(parseFloat(host.style.getPropertyValue('--library-keyboard-space')),19);assert.equal(windowScrolls.length,0);assert.equal(w.localStorage.getItem(KEY),disk);
  // Space changes selection, not the scroll owner; save/resize refreshes are passive.
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true}));target.click();w.libraryProbe.renderLibrary();w.dispatchEvent(new w.Event('resize'));flush();assert.equal(scrolls.length,1);assert.equal(host.scrollTop,300);
  const doc=w.libraryProbe.documents[1];doc.notes[doc.segments[0].id]='Legitimate note save';pipeline.store.queueDocument(doc.key,doc);await pipeline.store.flush();await settle();flush();assert.equal(scrolls.length,1);assert.equal(host.scrollTop,300);assert.equal(windowScrolls.length,0);
  tab(true);flush();assert.equal(scrolls.length,1);assert.equal(parseFloat(host.style.getPropertyValue('--library-keyboard-space')),19);
  $('library-selection-mode').click();assert.equal(host.style.getPropertyValue('--library-keyboard-space'),'');
 }finally{await w.happyDOM.close();}
});

test('existing shelf scroll range is used without adding trailing space and hidden or horizontally unrelated overlays do not move focus',async()=>{
 const {w,$,target,host,scrolls,flush,tab}=shelfFocusGeometry({atEnd:false});try{
  tab(true);flush();assert.equal(scrolls[0].top,300);assert.equal(host.style.getPropertyValue('--library-keyboard-space'),'');
  host.scrollTop=281;$('reading-feedback').style.visibility='hidden';tab();flush();assert.equal(scrolls.length,1);
  $('reading-feedback').style.visibility='visible';$('reading-feedback').getBoundingClientRect=()=>({left:400,right:500,top:770,bottom:832,width:100,height:62});tab();flush();assert.equal(scrolls.length,1);
  assert.equal(w.document.activeElement,target);
 }finally{await w.happyDOM.close();}
});

for(const interruption of ['pointer','space','focus','replace','remove','cancel'])test(`deferred shelf focus reveal respects ${interruption} before its animation frame`,async()=>{
 const {w,$,target,host,scrolls,windowScrolls,flush,tab}=shelfFocusGeometry();try{
  tab();
  if(interruption==='pointer')w.document.dispatchEvent(new w.Event('pointerdown',{bubbles:true}));
  if(interruption==='space')w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:' ',bubbles:true}));
  if(interruption==='focus')$('library-search').focus();
  if(interruption==='replace')w.libraryProbe.documents[1]={...w.libraryProbe.documents[1]};
  if(interruption==='remove')target.closest('.library-entry').remove();
  if(interruption==='cancel')$('library-selection-mode').click();
  flush();assert.equal(scrolls.length,0);assert.equal(windowScrolls.length,0);assert.equal(host.style.getPropertyValue('--library-keyboard-space'),'');
 }finally{await w.happyDOM.close();}
});

test('programmatic shelf checkbox focus never triggers keyboard correction',async()=>{
 const {w,target,scrolls,flush}=shelfFocusGeometry();try{target.focus();flush();assert.equal(scrolls.length,0);}finally{await w.happyDOM.close();}
});


test('browser organizing controls target the direct summary despite nested backup details',async()=>{
 const {w,$}=libraryHarness(largeLibraryFixture(1));try{
  assert.equal($('library-options').querySelectorAll('summary').length,2);assert.equal($('library-options').querySelectorAll(':scope > summary').length,1);
  for(const name of ['reading-keyboard-browser.mjs','recent-reading-browser.mjs']){
   const source=fs.readFileSync(new URL(name,import.meta.url),'utf8');assert.ok(source.includes("options.locator(':scope > summary')"));assert.equal(source.includes("options.locator('summary')"),false);
  }
 }finally{await w.happyDOM.close();}
});

test('shelf focus correction includes an outline larger than its label and the entire visible dock stack',async()=>{
 const {w,$,target,host,scrolls,flush,tab}=shelfFocusGeometry();try{
  target.style.outlineWidth='14px';tab();flush();assert.equal(scrolls[0].top,305);
  host.scrollTop=281;target.style.outlineWidth='3px';$('media-dock').hidden=false;$('media-dock').style.display='flex';
  $('media-dock').getBoundingClientRect=()=>({left:12,right:378,top:730,bottom:844,width:366,height:114});tab(true);flush();
  assert.equal(scrolls[1].top,340);assert.equal(parseFloat(host.style.getPropertyValue('--library-keyboard-space')),59);
 }finally{await w.happyDOM.close();}
});
