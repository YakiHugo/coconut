import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
import {settle} from './helpers/save-pipeline.mjs';
const C=createRequire(import.meta.url)('../reader/core.js');
function fixture(){const docs=largeLibraryFixture(2,{cues:65});for(const doc of docs){doc.segments.forEach((cue,i)=>{cue.id='shared-'+i;cue.saved_excerpt=true;});doc.notes={'shared-64':'Private last note '+doc.key};}return docs;}
const rows=$=>[...$('notebook-captures').children];
const selectionDoc=(key,label)=>({key,title:label,segments:[{id:'cue',start:0,end:3,text:label+' source'}],notes:{cue:label+' note'}});
function selectionDownloads(w){const blobs=[];w.URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:notebook-selection';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};return blobs;}
function selectNotebookDocument($,key){rows($).find(row=>row.dataset.documentKey===key).querySelector('input').click();}
async function restoreSelectionDocument($,doc){
 const data={format:'coconut-library',version:1,documents:[doc],active:null};
 Object.defineProperty($('library-file'),'files',{configurable:true,value:[{name:'restored-notebook.json',size:1000,text:async()=>JSON.stringify(data)}]});
 await $('library-file').onchange();
}
for(const keepOtherSelected of [false,true])test(`notebook export selection never transfers to a restored document reusing a removed key (${keepOtherSelected?'multiple':'single'} selection)`,async()=>{
 const {w,$}=libraryHarness([selectionDoc('reused','Original selected'),selectionDoc('other','Surviving document')],{probe:true});try{
  const blobs=selectionDownloads(w);$('open-library-notebook').click();selectNotebookDocument($,'reused');if(keepOtherSelected)selectNotebookDocument($,'other');
  $('notebook-close').click();$('open-library-notebook').click();assert.equal(rows($).find(row=>row.dataset.documentKey==='reused').querySelector('input').checked,true,'closing does not retire a live selection');$('notebook-close').click();
  $('library').querySelector('[data-document-key="reused"] .library-remove').click();await $('confirm-removal').onclick();
  await restoreSelectionDocument($,selectionDoc('reused','Never selected replacement'));
  $('open-library-notebook').click();
  const replacement=rows($).find(row=>row.dataset.documentKey==='reused').querySelector('input');
  assert.equal(replacement.checked,false,'a replacement is not the selected original document');
  assert.match($('notebook-export-scope').textContent,new RegExp('已选 '+Number(keepOtherSelected)+' 篇'));
  $('notebook-export').onclick();assert.equal(blobs.length,Number(keepOtherSelected));
  if(keepOtherSelected){const text=await blobs[0].text();assert.match(text,/Surviving document note/);assert.doesNotMatch(text,/Never selected replacement|Original selected/);}
  replacement.click();$('notebook-export').click();assert.match(await blobs.at(-1).text(),/Never selected replacement note/,'the user can explicitly select the replacement');
 }finally{await w.happyDOM.close();}
});
test('notebook selection preserves same-object note edits across close and reopen',async()=>{
 const {w,$}=libraryHarness([selectionDoc('selected','Original selected')],{probe:true});try{
  const blobs=selectionDownloads(w),original=w.libraryProbe.documents[0];$('open-library-notebook').click();selectNotebookDocument($,'selected');
  rows($)[0].querySelector('.notebook-open').click();$('note').value='Revised note on the same document';$('note').oninput();
  $('return-library-notebook').click();assert.equal(w.libraryProbe.documents[0],original);assert.equal(rows($)[0].querySelector('input').checked,true);
  $('notebook-export').click();assert.match(await blobs[0].text(),/Revised note on the same document/);assert.doesNotMatch(await blobs[0].text(),/Original selected note/);
 }finally{await w.happyDOM.close();}
});
test('notebook selection blocks pending removal and survives the original identity rollback',async()=>{
 const {w,$,pipeline}=libraryHarness([selectionDoc('selected','Original selected'),selectionDoc('other','Survivor')],{probe:true});try{
  const blobs=selectionDownloads(w),original=w.libraryProbe.documents[0];$('open-library-notebook').click();selectNotebookDocument($,'selected');$('notebook-close').click();pipeline.hold();
  $('library').querySelector('[data-document-key="selected"] .library-remove').click();const removing=$('confirm-removal').onclick();await settle();
  $('open-library-notebook').click();assert.match($('notebook-export-scope').textContent,/已选 1 篇/);assert.equal($('notebook-export').disabled,true);
  $('notebook-export').onclick();assert.equal(blobs.length,0);assert.match($('notebook-status').textContent,/来源正在变动/);
  pipeline.writes[0].fail();await removing;
  assert.equal(w.libraryProbe.documents[0],original);assert.equal($('library-notebook').open,true,'the receipt updates the open notebook without another user action');
  assert.equal(rows($).find(row=>row.dataset.documentKey==='selected').querySelector('input').checked,true);assert.equal($('notebook-export').disabled,false);
  $('notebook-export').click();assert.match(await blobs[0].text(),/Original selected note/);
 }finally{await w.happyDOM.close();}
});
test('successful removal refreshes the open notebook and exports only the surviving selected identity',async()=>{
 const {w,$,pipeline}=libraryHarness([selectionDoc('selected','Removed selected'),selectionDoc('other','Surviving selected')],{probe:true});try{
  const blobs=selectionDownloads(w);$('open-library-notebook').click();selectNotebookDocument($,'selected');selectNotebookDocument($,'other');$('notebook-close').click();pipeline.hold();
  $('library').querySelector('[data-document-key="selected"] .library-remove').click();const removing=$('confirm-removal').onclick();await settle();
  $('open-library-notebook').click();assert.equal($('notebook-export').disabled,true);pipeline.writes[0].commit();await removing;
  assert.equal($('library-notebook').open,true);assert.match($('notebook-export-scope').textContent,/已选 1 篇/);assert.equal($('notebook-export').disabled,false);
  assert.equal(rows($).length,1);assert.equal(rows($)[0].querySelector('input').checked,true);
  $('notebook-export').click();const text=await blobs[0].text();assert.match(text,/Surviving selected note/);assert.doesNotMatch(text,/Removed selected/);
 }finally{await w.happyDOM.close();}
});
test('notebook export revalidates identities before download and ignores a detached old selection control',async()=>{
 const {w,$}=libraryHarness([selectionDoc('reused','Original selected'),selectionDoc('other','Survivor')],{probe:true});try{
  const blobs=selectionDownloads(w);$('open-library-notebook').click();selectNotebookDocument($,'reused');selectNotebookDocument($,'other');
  const old=rows($).find(row=>row.dataset.documentKey==='reused').querySelector('input');
  w.libraryProbe.documents[0]={...w.libraryProbe.documents[0],title:'Replacement without rendering',notes:{cue:'Unselected replacement note'}};
  $('notebook-export').onclick();assert.equal(blobs.length,0,'an unrendered replacement first requires the changed selection to be shown');assert.match($('notebook-status').textContent,/移除或替换/);
  $('notebook-close').click();$('open-library-notebook').click();old.checked=true;old.onchange();
  assert.equal(rows($).find(row=>row.dataset.documentKey==='reused').querySelector('input').checked,false);assert.match($('notebook-export-scope').textContent,/已选 1 篇/);
  $('notebook-export').click();const text=await blobs[0].text();assert.match(text,/Survivor note/);assert.doesNotMatch(text,/Unselected replacement/);
 }finally{await w.happyDOM.close();}
});
test('captures use document-qualified ownership, merge cue annotations once, and include blank bookmarks',()=>{
 const docs=fixture();docs.push({key:'audio',title:'Recording',segments:[],project_kind:'audio_only',project_note:'Audio thought',timestamp_bookmarks:[{id:'shared-64',time:90,note:''}]});
 const all=C.libraryCaptures(docs);assert.equal(all.length,132);assert.equal(new Set(all.map(c=>c.key)).size,132);
 assert.equal(all[64].excerpt,true);assert.equal(all[64].note,'Private last note shelf-0');assert.equal(C.libraryCaptures(docs,'','note').length,3);
 assert.equal(C.libraryCaptures(docs,'','excerpt').length,130);assert.equal(C.libraryCaptures(docs,'01:30').at(-1).type,'bookmark');
 assert.equal(C.libraryCaptures(docs,'Private last note shelf-1')[0].documentKey,'shelf-1');
});
test('selected-document export ignores query and duplicates, preserves corrected text and omits stale translation',()=>{
 const docs=fixture(),cue=docs[1].segments[64];cue.original_text='Before correction';docs[1].translation_view='zh';cue.translations={zh:{text:'STALE TEXT',source_text:'wrong'}};
 const output=C.libraryNotebookMarkdown(docs,['shelf-1','shelf-1','missing']);
 assert.match(output,/所选 1 篇/);assert.match(output,/shelf\\-1/);assert.match(output,/Before correction/);assert.match(output,/Private last note shelf/);assert.match(output,/译文已过期/);assert.doesNotMatch(output,/STALE TEXT|Authored document 0/);assert.match(output,/source sentence 0/);assert.match(output,/source sentence 64/);
});
test('opening and filtering leave active reader/media alone; late exact note navigation and return retain query, page and focus',async()=>{
 const {w,$}=libraryHarness(fixture());try{
  const title=$('title').textContent,transcript=$('transcript').innerHTML;const player=w.document.createElement('audio');let pauses=0;player.pause=()=>{pauses++;};$('source-media').append(player);
  $('open-library-notebook').click();assert.equal($('library-notebook').open,true);assert.equal(rows($).length,30);assert.equal($('title').textContent,title);assert.equal($('transcript').innerHTML,transcript);assert.equal(pauses,0);
  $('notebook-search').value='shelf-1';$('notebook-search').oninput();assert.equal(rows($).length,1); // only note text matches key
  $('notebook-search').value='Authored shelf 00001';$('notebook-search').oninput();$('notebook-next').click();$('notebook-next').click();assert.equal(rows($).length,5);
  const key=rows($).at(-1).dataset.captureKey;$('library-notebook').scrollTop=123;rows($).at(-1).querySelector('.notebook-open').click();
  assert.equal($('note').value,'Private last note shelf-1');assert.equal(w.document.activeElement,$('note'));assert.match($('title').textContent,/00001/);
  $('note').value='Changed retained note';$('note').oninput();$('return-library-notebook').click();
  assert.equal($('notebook-search').value,'Authored shelf 00001');assert.equal(rows($).length,5);assert.equal(w.document.activeElement.closest('li').dataset.captureKey,key);assert.equal($('library-notebook').scrollTop,123);assert.match(rows($).at(-1).textContent,/Changed retained note/);
 }finally{await w.happyDOM.close();}
});
test('selection spans pages and exports complete selected documents, independent of search',async()=>{
 const {w,$}=libraryHarness(fixture());try{
  let blob;w.URL.createObjectURL=value=>{blob=value;return 'blob:notes';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};
  $('open-library-notebook').click();rows($)[0].querySelector('input').click();assert.ok(rows($).every(row=>row.querySelector('input').checked));
  $('notebook-search').value='Private last note shelf-1';$('notebook-search').oninput();assert.equal(rows($).length,1);rows($)[0].querySelector('input').click();
  $('notebook-export').click();const text=await blob.text();assert.match(text,/所选 2 篇/);assert.match(text,/Authored document 0/);assert.match(text,/Authored document 1/);assert.match(text,/source sentence 0/);
  $('notebook-clear-selection').click();assert.equal($('notebook-export').disabled,true);
 }finally{await w.happyDOM.close();}
});
test('audio-only project and bookmark open exact source; removal and Undo recompute current captures',async()=>{
 const audio={key:'audio',title:'Recording',project_kind:'audio_only',podcast_source:{kind:'direct_media',media_url:'https://example.org/a.mp3',media_kind:'audio'},segments:[],project_note:'Audio project thought',timestamp_bookmarks:[{id:'same',time:90,note:'Bookmark thought'}]};
 const {w,$}=libraryHarness([...fixture(),audio]);try{
  $('open-library-notebook').click();$('notebook-search').value='Bookmark thought';$('notebook-search').oninput();rows($)[0].querySelector('.notebook-open').click();assert.equal(w.document.activeElement.value,'Bookmark thought');assert.equal(w.document.activeElement.closest('section').dataset.bookmarkId,'same');
  $('return-library-notebook').click();$('notebook-close').click();$('library-options').open=true;$('library-options').dispatchEvent(new w.Event('toggle'));[...$('library').children].at(-1).querySelector('.library-remove').click();await $('confirm-removal').onclick();
  $('open-library-notebook').click();assert.equal(rows($).length,0);$('notebook-close').click();await $('undo-removal').onclick();$('open-library-notebook').click();assert.equal(rows($).length,1);assert.match(rows($)[0].textContent,/Bookmark thought/);
 }finally{await w.happyDOM.close();}
});

test('current translation appears in full capture and export, stale replacement is explicitly excluded',async()=>{
 const docs=fixture(),cue=docs[0].segments[0];docs[0].translation_view='zh';cue.translations={zh:{text:'Fresh authored translation',source_text:cue.text,provider:'fixture'}};
 assert.match(C.libraryNotebookMarkdown(docs,['shelf-0']),/Fresh authored translation/);
 const {w,$}=libraryHarness(docs,{probe:true});try{
  $('open-library-notebook').click();assert.match(rows($)[0].textContent,/Fresh authored translation/);$('notebook-close').click();
  w.libraryProbe.documents[0].segments[0].text='Changed source';$('open-library-notebook').click();assert.doesNotMatch(rows($)[0].textContent,/Fresh authored translation/);assert.match(rows($)[0].textContent,/译文已过期/);
 }finally{await w.happyDOM.close();}
});

test('stale capture callbacks cannot navigate to reused cue IDs or a replacement document',async()=>{
 const {w,$}=libraryHarness(fixture(),{probe:true});try{
  const title=$('title').textContent;$('open-library-notebook').click();$('notebook-search').value='Private last note shelf-1';$('notebook-search').oninput();
  const stale=rows($)[0].querySelector('.notebook-open');const doc=w.libraryProbe.documents[1];doc.segments[64]={...doc.segments[64],text:'Replacement source with reused cue ID'};
  stale.click();assert.equal($('library-notebook').open,true);assert.equal($('title').textContent,title);assert.match($('notebook-status').textContent,/来源已变动/);assert.equal(w.document.activeElement,$('notebook-search'));
  const replaced=rows($)[0].querySelector('.notebook-open');w.libraryProbe.documents[1]={...doc,title:'Replacement document with same key'};
  replaced.click();assert.equal($('title').textContent,title);assert.equal($('library-notebook').open,true);assert.match($('notebook-status').textContent,/来源已变动/);
 }finally{await w.happyDOM.close();}
});
test('paused audio stays owned until explicit notebook navigation and notebook return never resumes it',async()=>{
 const audio={key:'audio',title:'Recording',project_kind:'audio_only',podcast_source:{kind:'direct_media',media_url:'https://example.org/a.mp3',media_kind:'audio'},segments:[],project_note:'Owned audio note',timestamp_bookmarks:[]};
 const {w,$}=libraryHarness([...fixture(),audio]);try{
  const player=w.document.createElement('audio');let plays=0,pauses=0;player.currentTime=37;player.play=()=>{plays++;return Promise.resolve();};player.pause=()=>{pauses++;};$('source-media').append(player);
  const title=$('title').textContent;$('open-library-notebook').click();$('notebook-search').value='Owned audio note';$('notebook-search').oninput();assert.equal($('title').textContent,title);assert.equal(player.currentTime,37);assert.equal(pauses,0);assert.equal(plays,0);
  rows($)[0].querySelector('.notebook-open').click();assert.equal($('title').textContent,'Recording');assert.equal(w.document.activeElement,$('project-note'));assert.equal($('project-note').value,'Owned audio note');assert.ok(pauses>0);assert.equal(plays,0);assert.equal(player.currentTime,37);
  $('return-library-notebook').click();assert.equal($('title').textContent,'Recording');assert.equal(plays,0);assert.equal(rows($).length,1);
  assert.equal($('open-library-notebook').closest('#library-list'),$('library-list'));assert.ok($('return-library-notebook').closest('#reader-workspace'));assert.equal($('return-library-notebook').closest('aside'),null);
 }finally{await w.happyDOM.close();}
});

test('notebook labels user-written translation provenance and still suppresses stale source',async()=>{
 const docs=fixture(),cue=docs[0].segments[0];docs[0].translation_view='zh';delete cue.translations;
 C.saveManualTranslation(docs[0],cue,'zh','A user-written translation',C.manualReviewSnapshot(docs[0],cue,'zh'),undefined);
 const {w,$}=libraryHarness(docs,{probe:true});try{
  $('open-library-notebook').click();assert.match(rows($)[0].textContent,/用户自己写的译文/);assert.match(rows($)[0].textContent,/A user-written translation/);assert.doesNotMatch(rows($)[0].textContent,/机器生成|用户已核对/);
  $('notebook-close').click();w.libraryProbe.documents[0].segments[0].text='Changed underlying source';$('open-library-notebook').click();assert.match(rows($)[0].textContent,/译文已过期/);assert.doesNotMatch(rows($)[0].textContent,/A user-written translation|用户自己写的译文/);
 }finally{await w.happyDOM.close();}
});

for(const audioOnly of [false,true])test(`shelf annotation hits reveal exact visible editors (${audioOnly?'audio-only':'transcript-bearing'}) without playback`,async()=>{
 const doc=fixture()[0];doc.project_note='Needle project thought';doc.timestamp_bookmarks=[{id:'timestamp',time:90,note:'Needle timestamp thought'}];
 if(audioOnly){doc.project_kind='audio_only';doc.segments=[];doc.podcast_source={kind:'direct_media',media_url:'https://example.org/a.mp3',media_kind:'audio'};}
 const {w,$}=libraryHarness([doc]);try{
  let plays=0;w.HTMLMediaElement.prototype.play=async()=>{plays++;};
  $('library-scope').value='notes';$('library-scope').onchange();$('library-search').value='Needle';$('library-search').oninput();
  for(const kind of ['project-note','bookmark']){
   const hit=w.document.querySelector(`.library-hit[data-hit-kind="${kind}"]`);assert.ok(hit);hit.click();
   const target=kind==='project-note'?$('project-note'):$('audio-bookmarks').querySelector('textarea');
   assert.equal(Boolean(target.closest('[hidden]')),false,'matched editor must be visible');assert.equal(w.document.activeElement,target);
   assert.equal($('title').textContent,doc.title);assert.equal(plays,0);
  }
 }finally{await w.happyDOM.close();}
});
function bookmarkFixture(){return {key:'audio',title:'Notebook recording',project_kind:'audio_only',podcast_source:{kind:'direct_media',media_url:'https://example.org/a.mp3',media_kind:'audio'},segments:[],project_note:'',timestamp_bookmarks:Array.from({length:65},(_,i)=>({id:'b'+i,time:i*10+10,note:'Retained bookmark '+i}))};}
function openLastBookmark($){
 $('open-library-notebook').click();$('notebook-search').value='Retained';$('notebook-search').oninput();$('notebook-kind').value='note';$('notebook-kind').onchange();
 $('notebook-next').click();$('notebook-next').click();$('library-notebook').scrollTop=123;
 const row=rows($).at(-1),key=row.dataset.captureKey;row.querySelector('.notebook-open').click();return key;
}
test('notebook return follows stable bookmark identity onto its new filtered page after time correction',async()=>{
 const {w,$}=libraryHarness([bookmarkFixture()]);try{
  let plays=0;w.HTMLMediaElement.prototype.play=async()=>{plays++;};
  const key=openLastBookmark($),source=[...$('audio-bookmarks').children].find(row=>row.dataset.bookmarkId==='b64');
  source.querySelector('.edit-bookmark-time').click();const form=source.querySelector('form');form.querySelector('input').value='1';await form.onsubmit(new w.Event('submit',{cancelable:true}));
  $('return-library-notebook').click();
  assert.equal($('notebook-search').value,'Retained');assert.equal($('notebook-kind').value,'note');assert.match($('notebook-status').textContent,/1–30 \/ 65/);
  assert.equal(rows($)[0].dataset.captureKey,key);assert.equal(w.document.activeElement,rows($)[0].querySelector('.notebook-open'));assert.equal($('library-notebook').scrollTop,0);assert.equal(plays,0);
 }finally{await w.happyDOM.close();}
});
for(const action of ['delete','no-longer-match'])test(`notebook return retains filtered page and safe focus when bookmark is ${action}`,async()=>{
 const {w,$}=libraryHarness([bookmarkFixture()]);try{
  const key=openLastBookmark($),source=[...$('audio-bookmarks').children].find(row=>row.dataset.bookmarkId==='b64');
  if(action==='delete')[...source.querySelectorAll('button')].find(button=>button.textContent==='删除书签').click();
  else{const note=source.querySelector('textarea');note.value='Changed idea';note.oninput();}
  $('return-library-notebook').click();
  assert.equal($('notebook-search').value,'Retained');assert.equal($('notebook-kind').value,'note');assert.match($('notebook-status').textContent,/61–64 \/ 64/);
  assert.ok(rows($).every(row=>row.dataset.captureKey!==key));assert.equal(w.document.activeElement,$('notebook-search'));
 }finally{await w.happyDOM.close();}
});

function returnIdentityDoc(key,title,count=35){return {key,title,language:'en',segments:Array.from({length:count},(_,i)=>({id:'cue-'+i,start:i,end:i+1,text:'Source '+i,speaker:'Original speaker'})),notes:Object.fromEntries(Array.from({length:count},(_,i)=>['cue-'+i,'shared return token '+i]))};}
function openReturnIdentity($,key='reused',id='cue-34'){
 $('open-library-notebook').click();$('notebook-search').value='shared return token';$('notebook-search').oninput();$('notebook-next').click();
 const row=rows($).find(row=>row.dataset.documentKey===key&&row.dataset.captureId===id);assert.ok(row);row.querySelector('.notebook-open').click();
}
test('notebook return does not target a restored replacement sharing the old document and capture keys',async()=>{
 const {w,$}=libraryHarness([returnIdentityDoc('reused','Original A'),returnIdentityDoc('other','Survivor')],{probe:true});try{
  openReturnIdentity($);assert.equal($('title').textContent,'Original A');
  $('library').querySelector('[data-document-key="reused"] .library-remove').click();await $('confirm-removal').onclick();
  await restoreSelectionDocument($,returnIdentityDoc('reused','Replacement B'));
  $('return-library-notebook').click();
  assert.equal($('notebook-search').value,'shared return token');assert.match($('notebook-status').textContent,/31–60 \/ 70/);
  assert.match($('notebook-status').textContent,/原返回记录已移除、替换或不再匹配/);assert.equal(w.document.activeElement===$('notebook-search'),true);
  assert.equal(rows($).some(row=>row.dataset.documentKey==='reused'&&row.dataset.captureId==='cue-34'),false,'must not jump to the replacement’s later page');
  // Explicitly opening B establishes a new owner and a new legitimate return.
  $('notebook-next').click();rows($).at(-1).querySelector('.notebook-open').click();assert.equal($('title').textContent,'Replacement B');
  $('return-library-notebook').click();assert.equal(w.document.activeElement.closest('li')?.dataset.captureId,'cue-34');assert.doesNotMatch($('notebook-status').textContent,/原返回记录/);
 }finally{await w.happyDOM.close();}
});
for(const type of ['cue','bookmark','exact-excerpt','project-note'])test(`notebook return rejects a replacement ${type} owner even with equal displayed fields`,async()=>{
 const {w,$}=libraryHarness([returnIdentityDoc('owner','Return owner',1)],{probe:true});try{
  const doc=w.libraryProbe.documents[0];let id='cue-0';
  if(type!=='cue')doc.notes={};
  if(type==='bookmark'){doc.project_note='';doc.timestamp_bookmarks=[{id:'record',time:10,note:'shared return token'}];id='record';}
  if(type==='project-note'){doc.project_note='shared return token';doc.timestamp_bookmarks=[];id='';}
  if(type==='exact-excerpt'){doc.exact_excerpts=[w.Coconut.exactExcerptSnapshot(doc,doc.segments,[],0,doc.segments[0].text.length,{id:'record',createdAt:'2026-10-11T00:00:00.000Z'})];doc.exact_excerpt_notes={record:'shared return token'};id='record';}
  $('open-library-notebook').click();$('notebook-search').value='shared return token';$('notebook-search').oninput();
  assert.equal(rows($).length,1);assert.equal(rows($)[0].dataset.captureType,type);rows($)[0].querySelector('.notebook-open').click();
  if(type==='cue')doc.segments[0]={...doc.segments[0]};
  if(type==='bookmark')doc.timestamp_bookmarks[0]={...doc.timestamp_bookmarks[0]};
  if(type==='exact-excerpt')doc.exact_excerpts[0]={...doc.exact_excerpts[0]};
  if(type==='project-note')w.libraryProbe.documents[0]={...doc};
  $('return-library-notebook').click();
  assert.equal(rows($).length,1);assert.equal(rows($)[0].dataset.captureId,id);assert.equal(w.document.activeElement===$('notebook-search'),true);
  assert.match($('notebook-status').textContent,/原返回记录已移除、替换或不再匹配/);assert.equal($('notebook-search').value,'shared return token');
 }finally{await w.happyDOM.close();}
});
for(const operation of ['single-source','batch-source','batch-undo','speaker'])test(`notebook return follows the same owned cue after explicit ${operation} editing`,async()=>{
 const {w,$}=libraryHarness([returnIdentityDoc('reused','Original A')],{probe:true});try{
  openReturnIdentity($);const original=w.libraryProbe.documents[0].segments[34];
  if(operation==='single-source'){
   w.document.querySelector('[data-segment-id="cue-34"] .edit-button').click();$('edit-segment').value='Corrected source';$('save-edit').click();
  }else if(operation==='speaker'){
   w.document.querySelector('[data-segment-id="cue-34"] .speaker-correction-button').click();$('speaker-name').value='Corrected speaker';$('speaker-name').dispatchEvent(new w.Event('input',{bubbles:true}));$('save-speaker').click();
  }else{
   $('open-source-correction').click();for(const [id,value] of [['source-find','Source 34'],['source-replace','Corrected source']]){$(id).value=value;$(id).dispatchEvent(new w.Event('input',{bubbles:true}));}
   $('preview-source-correction').click();$('apply-source-correction').click();if(operation==='batch-undo')$('undo-source-correction').click();$('close-source-correction').click();
  }
  const live=w.libraryProbe.documents[0].segments[34];assert.equal(live===original,operation==='single-source');
  $('return-library-notebook').click();assert.equal(w.document.activeElement.closest('li')?.dataset.captureId,'cue-34');assert.equal($('notebook-search').value,'shared return token');assert.doesNotMatch($('notebook-status').textContent,/原返回记录/);
  await w.flushContentForTest();
 }finally{await w.happyDOM.close();}
});
