import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
const C=createRequire(import.meta.url)('../reader/core.js');
function fixture(){const docs=largeLibraryFixture(2,{cues:65});for(const doc of docs){doc.segments.forEach((cue,i)=>{cue.id='shared-'+i;cue.saved_excerpt=true;});doc.notes={'shared-64':'Private last note '+doc.key};}return docs;}
const rows=$=>[...$('notebook-captures').children];
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
