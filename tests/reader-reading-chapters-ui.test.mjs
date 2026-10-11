import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
import {splitCueFixture} from './helpers/split-cue-fixture.mjs';
import {settle} from './helpers/save-pipeline.mjs';
function fixture(){const doc=largeLibraryFixture(1,{cues:260})[0];doc.readingPosition=doc.segments[19].id;doc.notes[doc.segments[5].id]='Retained private thought';return doc;}
function open($){$('open-chapters').click();}
function chapterRows($){return [...$('chapter-list').children];}
async function create($,number,title){$('chapter-add').click();$('chapter-cue-number').value=String(number);$('chapter-cue-number').oninput();$('chapter-title').value=title;$('chapter-save').click();await settle();}
const cueRows=w=>[...w.document.querySelectorAll('#transcript .segment')];
test('create chapters out of order, rename, retarget and remove without ordinary bookmark or capture duplication',async()=>{
 const {w,$,pipeline}=libraryHarness([fixture()],{probe:true});try{
  $('mode-transcript').click();open($);await create($,220,'Closing');await create($,10,'Opening');await create($,150,'Middle');
  const doc=w.libraryProbe.documents[0],before=doc.readingPosition;assert.deepEqual(chapterRows($).map(row=>row.querySelector('strong').textContent),['Opening','Middle','Closing']);assert.equal(doc.timestamp_bookmarks,undefined);assert.equal(w.Coconut.libraryCaptures([doc]).length,1);
  chapterRows($)[1].querySelector('.chapter-rename').click();$('chapter-title').value='Renamed middle';$('chapter-save').click();assert.equal(chapterRows($)[1].querySelector('strong').textContent,'Renamed middle');
  chapterRows($)[1].querySelector('.chapter-relocate').click();$('chapter-cue-number').value='2';$('chapter-cue-number').oninput();$('chapter-save').click();assert.equal(chapterRows($)[0].querySelector('strong').textContent,'Renamed middle');
  await create($,10,'Duplicate');assert.equal($('chapter-editor').open,true);assert.match($('chapter-editor-status').textContent,/同一片段/);$('chapter-cancel').click();assert.equal(doc.reading_chapters.length,3);
  chapterRows($)[0].querySelector('.chapter-remove').click();assert.equal(doc.reading_chapters.length,2);assert.equal(w.document.activeElement,$('chapter-add'));assert.equal(doc.readingPosition,before);await pipeline.store.flush();assert.equal($('chapter-save-status').dataset.state,'saved');
 }finally{await w.happyDOM.close();}
});
test('filtered late-page chapter navigation returns exact query page and reading bookmark without persistence writes',async()=>{
 const source=fixture();source.segments.forEach(cue=>cue.text+=' needle');
 const {w,$,pipeline}=libraryHarness([source],{probe:true});try{
  $('mode-transcript').click();open($);await create($,2,'Early');await create($,220,'Late');$('chapter-close').click();await pipeline.store.flush();
  $('search').value='needle';$('search').oninput();$('next-page').click();const first=cueRows(w)[0].dataset.segmentId,bookmark=w.libraryProbe.documents[0].readingPosition,before=w.localStorage.getItem('coconut-reader-v1');
  open($);chapterRows($)[1].querySelector('.chapter-open').click();assert.equal($('search').value,'');assert.equal($('chapter-return').hidden,false);assert.equal(w.document.activeElement.dataset.segmentId,source.segments[219].id);assert.equal(w.libraryProbe.documents[0].readingPosition,bookmark);
  $('return-from-chapter').click();assert.equal($('search').value,'needle');assert.equal(cueRows(w)[0].dataset.segmentId,first);assert.equal($('chapter-return').hidden,true);assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);
 }finally{await w.happyDOM.close();}
});
test('passage chapter landing targets the exact cue span, including valid empty cue identity, and returns to passage view',async()=>{
 const source=splitCueFixture(40);source.key='passage';source.segments[3].id='';
 const {w,$,pipeline}=libraryHarness([source],{probe:true});try{open($);await create($,4,'Inside passage');$('chapter-close').click();$('mode-passages').click();await pipeline.store.flush();const bookmark=w.libraryProbe.documents[0].readingPosition;
  let scrolled;w.HTMLElement.prototype.scrollIntoView=function(){scrolled=this;};open($);chapterRows($)[0].querySelector('.chapter-open').click();const target=w.document.activeElement;
  assert.equal(target.classList.contains('passage-cue'),true);assert.equal(target.dataset.cueId,'');assert.equal(scrolled,target);assert.equal(target.classList.contains('chapter-target'),true);assert.equal(w.libraryProbe.documents[0].readingPosition,bookmark);
  $('return-from-chapter').click();assert.equal($('mode-passages').getAttribute('aria-pressed'),'true');assert.equal(w.libraryProbe.documents[0].readingPosition,bookmark);
 }finally{await w.happyDOM.close();}
});
test('missing anchors are explicit and never guessed, but can be renamed or explicitly relocated',async()=>{
 const source=fixture();source.reading_chapters=[{id:'missing',title:'Lost chapter',cue_id:'no-such-cue',time:12,note:''}];
 const {w,$}=libraryHarness([source],{probe:true});try{open($);assert.equal(chapterRows($)[0].querySelector('.chapter-open').disabled,true);assert.match(chapterRows($)[0].textContent,/已不存在/);
  chapterRows($)[0].querySelector('.chapter-rename').click();$('chapter-title').value='Retained missing chapter';$('chapter-save').click();assert.equal(w.libraryProbe.documents[0].reading_chapters[0].cue_id,'no-such-cue');
  chapterRows($)[0].querySelector('.chapter-relocate').click();$('chapter-cue-number').value='100';$('chapter-cue-number').oninput();$('chapter-save').click();assert.equal(w.libraryProbe.documents[0].reading_chapters[0].cue_id,source.segments[99].id);assert.equal(chapterRows($)[0].querySelector('.chapter-open').disabled,false);
 }finally{await w.happyDOM.close();}
});
test('chapter title drafts survive closing, block replacement, and cancel explicitly; stale target object cannot save',async()=>{
 const {w,$}=libraryHarness([fixture()],{probe:true});try{open($);$('chapter-add').click();$('chapter-title').value='Keep draft';$('chapter-editor-close').click();$('chapter-add').click();assert.equal($('chapter-title').value,'Keep draft');assert.match($('chapter-editor-status').textContent,/已有未提交/);$('chapter-cancel').click();$('chapter-add').click();assert.equal($('chapter-title').value,'');
  $('chapter-title').value='Stale target';const doc=w.libraryProbe.documents[0];const index=Number($('chapter-cue-number').value)-1;doc.segments[index]={...doc.segments[index]};$('chapter-save').click();assert.match($('chapter-editor-status').textContent,/已变化/);assert.equal(doc.reading_chapters,undefined);
 }finally{await w.happyDOM.close();}
});
test('failed save preserves chapters and title caret, supports retry and full JSON rescue',async()=>{
 const {w,$,pipeline}=libraryHarness([fixture()],{probe:true});try{open($);await create($,20,'Saved in memory');pipeline.hold();const flush=pipeline.store.flush();await settle();assert.equal(pipeline.writes.length,1);chapterRows($)[0].querySelector('.chapter-rename').click();$('chapter-title').value='Unsubmitted new name';$('chapter-title').setSelectionRange(2,5);pipeline.writes[0].fail();await flush;
  assert.equal($('chapter-save-status').dataset.state,'failed');assert.equal(w.document.activeElement,$('chapter-title'));assert.equal($('chapter-title').selectionStart,2);$('chapter-editor-close').click();
  let blob;w.URL.createObjectURL=value=>{blob=value;return 'blob:chapters';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};$('chapter-backup').click();const backup=JSON.parse(await blob.text());assert.equal(backup.documents[0].reading_chapters[0].title,'Saved in memory');assert.equal(backup.documents[0].readingPosition,fixture().readingPosition);assert.equal(w.Coconut.mergeLibraryBackup({documents:[],active:null},backup).documents[0].reading_chapters.length,1);
  pipeline.hold(false);await $('chapter-retry').onclick();assert.equal($('chapter-save-status').dataset.state,'saved');
 }finally{await w.happyDOM.close();}
});
test('chapter-only notebook export is enabled and directory DOM stays bounded',async()=>{
 const source=fixture();source.notes={};source.reading_chapters=Array.from({length:25},(_,i)=>({id:'chapter-'+i,title:'Chapter '+i,cue_id:source.segments[i].id,time:source.segments[i].start,note:''}));
 const {w,$}=libraryHarness([source],{probe:true});try{assert.equal($('export-notebook').disabled,false);open($);assert.equal(chapterRows($).length,20);$('chapter-list-next').click();assert.equal(chapterRows($).length,5);assert.equal($('chapter-list-next').disabled,true);
  let blob;w.URL.createObjectURL=value=>{blob=value;return 'blob:notes';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};$('chapter-close').click();$('export-notebook').click();assert.match(await blob.text(),/Chapter 24/);assert.equal(w.Coconut.libraryCaptures(w.libraryProbe.documents).length,0);
 }finally{await w.happyDOM.close();}
});
test('chapter steps use full cue order for equal timestamps and long IDs, and restore bilingual speaker/excerpt filters',async()=>{
 const source=splitCueFixture(60);source.key='chapter-filter';source.segments.forEach((cue,i)=>{cue.saved_excerpt=i%2===0;});source.segments[3].id='id-'.repeat(120);source.segments[3].start=5.4;source.segments[3].end=7.1;source.segments[4].start=5.4;source.segments[4].end=7.1;source.segments[59].start=700001;source.segments[59].end=700002;
 const {w,$}=libraryHarness([source],{probe:true});try{$('mode-bilingual').click();open($);await create($,4,'Same time earlier');await create($,5,'Same time later');await create($,60,'After a week');$('chapter-close').click();
  $('filter-excerpts').click();$('speaker-filter').value=JSON.stringify('Mina');$('speaker-filter').onchange();const before=cueRows(w).map(row=>row.dataset.segmentId);open($);chapterRows($)[0].querySelector('.chapter-open').click();assert.equal(w.document.activeElement.dataset.segmentId,source.segments[3].id);open($);assert.match($('chapter-current').textContent,/Same time earlier/);$('chapter-next').click();assert.equal(w.document.activeElement.dataset.segmentId,source.segments[4].id);
  $('return-from-chapter').click();assert.deepEqual(cueRows(w).map(row=>row.dataset.segmentId),before);assert.equal($('speaker-filter').value,JSON.stringify('Mina'));assert.equal($('filter-excerpts').getAttribute('aria-pressed'),'true');assert.equal($('mode-bilingual').getAttribute('aria-pressed'),'true');assert.equal(w.libraryProbe.documents[0].reading_chapters[2].time,700001);
 }finally{await w.happyDOM.close();}
});
test('chapter draft blocks destructive source removal until explicitly cancelled',async()=>{
 const {w,$}=libraryHarness([fixture()],{probe:true});try{open($);$('chapter-add').click();$('chapter-title').value='Unsubmitted chapter';$('chapter-editor-close').click();$('chapter-close').click();$('library-options').open=true;$('library-options').dispatchEvent(new w.Event('toggle'));$('library').querySelector('.library-remove').click();assert.equal($('remove-document-dialog').open,false);assert.equal($('chapter-editor').open,true);assert.match($('chapter-editor-status').textContent,/草稿/);assert.equal($('chapter-title').value,'Unsubmitted chapter');$('chapter-cancel').click();$('library').querySelector('.library-remove').click();assert.equal($('remove-document-dialog').open,true);
 }finally{await w.happyDOM.close();}
});
test('chapter dialogs own native Tab boundaries and Escape preserves drafts while returning to the visible opener',async()=>{
 const {w,$}=libraryHarness([fixture()],{probe:true});try{open($);$('chapter-close').focus();let event=new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});$('chapter-close').dispatchEvent(event);assert.equal(event.defaultPrevented,true);assert.equal(w.document.activeElement,$('chapter-add'));
  event=new w.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true});$('chapter-add').dispatchEvent(event);assert.equal(w.document.activeElement,$('chapter-close'));
  $('chapter-add').click();$('chapter-title').value='Escaped draft';$('chapter-editor-close').focus();$('chapter-editor-close').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));assert.equal(w.document.activeElement,$('chapter-title'));$('chapter-title').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));assert.equal(w.document.activeElement,$('chapter-editor-close'));
  $('chapter-editor').dispatchEvent(new w.Event('cancel',{cancelable:true}));assert.equal($('chapter-editor').open,false);assert.equal(w.document.activeElement,$('chapter-add'));$('chapter-add').click();assert.equal($('chapter-title').value,'Escaped draft');$('chapter-cancel').click();
 }finally{await w.happyDOM.close();}
});
test('recent exact chapter anchor prevents B-to-B loops and expires after ordinary reading rerender',async()=>{
 const {w,$}=libraryHarness([fixture()],{probe:true});try{$('mode-transcript').click();open($);await create($,2,'A');await create($,20,'B');await create($,40,'C');chapterRows($)[1].querySelector('.chapter-open').click();open($);assert.match($('chapter-current').textContent,/最近定位章节：B/);$('chapter-next').click();assert.equal(w.document.activeElement.dataset.segmentId,fixture().segments[39].id);open($);$('chapter-previous').click();open($);$('chapter-previous').click();assert.equal(w.document.activeElement.dataset.segmentId,fixture().segments[1].id);
  $('return-from-chapter').click();$('filter-all').click();open($);assert.doesNotMatch($('chapter-current').textContent,/最近定位/);
 }finally{await w.happyDOM.close();}
});

test('explicit creation and retargeting across chapter pages focus the saved identity without background save page jumps',async()=>{
 const source=fixture();source.reading_chapters=Array.from({length:25},(_,i)=>({id:'chapter-'+i,title:'Chapter '+i,cue_id:source.segments[i].id,time:source.segments[i].start,note:''}));
 const {w,$,pipeline}=libraryHarness([source],{probe:true});try{open($);chapterRows($)[0].querySelector('.chapter-relocate').click();$('chapter-cue-number').value='200';$('chapter-cue-number').oninput();$('chapter-save').click();assert.equal(chapterRows($).length,5);assert.equal(w.document.activeElement.closest('.chapter-entry').dataset.chapterId,'chapter-0');
  $('chapter-list-previous').click();await pipeline.store.flush();assert.equal(chapterRows($).length,20);await create($,250,'New last chapter');assert.equal(chapterRows($).length,6);assert.equal(w.document.activeElement.closest('.chapter-entry').querySelector('strong').textContent,'New last chapter');
 }finally{await w.happyDOM.close();}
});
test('untouched imported title survives input normalization and a replaced cue opener has a visible focus fallback',async()=>{
 const source=fixture();source.reading_chapters=[{id:'raw-title',title:'Raw\nimported title',cue_id:source.segments[0].id,time:0,note:''}];
 const {w,$}=libraryHarness([source],{probe:true});try{$('mode-transcript').click();open($);chapterRows($)[0].querySelector('.chapter-rename').click();$('chapter-save').click();assert.equal(w.libraryProbe.documents[0].reading_chapters[0].title,'Raw\nimported title');chapterRows($)[0].querySelector('.chapter-rename').click();$('chapter-editor-close').click();$('chapter-add').click();assert.equal($('chapter-title').value,'');$('chapter-cancel').click();$('chapter-close').click();
  const cue=cueRows(w)[0],id=cue.dataset.segmentId;cue.querySelector('.chapter-create').click();w.libraryProbe.render();$('chapter-cancel').click();assert.equal(w.document.activeElement.classList.contains('chapter-create'),true);assert.equal(w.document.activeElement.closest('.segment').dataset.segmentId,id);
 }finally{await w.happyDOM.close();}
});
test('exact passage chapter landing reserves the wrapped sticky return bar and focus ring only on navigation',async()=>{
 const source=splitCueFixture(40);source.key='sticky-chapter';source.reading_chapters=[{id:'inside',title:'Inside',cue_id:source.segments[3].id,time:source.segments[3].start,note:''}];
 const {w,$,pipeline}=libraryHarness([source],{probe:true});try{
  $('mode-passages').click();await pipeline.store.flush();const before=w.localStorage.getItem('coconut-reader-v1'),bar=$('chapter-return');
  bar.style.top='6px';let height=122;bar.getBoundingClientRect=()=>({height});let scrolls=[];
  const nativeStyle=w.getComputedStyle.bind(w);w.getComputedStyle=node=>{const style=nativeStyle(node);if(node.classList?.contains('chapter-target'))return {outlineWidth:'2px',outlineOffset:'3px'};return style;};
  w.HTMLElement.prototype.scrollIntoView=function(options){if(this.classList.contains('chapter-target'))scrolls.push({node:this,margin:this.style.scrollMarginTop,barHidden:bar.hidden,options});};
  open($);chapterRows($)[0].querySelector('.chapter-open').click();assert.equal(scrolls.length,1);assert.equal(scrolls[0].margin,'135px');assert.equal(scrolls[0].barHidden,false);assert.equal(scrolls[0].options.block,'start');assert.equal(w.document.activeElement,scrolls[0].node);
  // The CI failure placed the first glyph at 19.9375px with a 20px margin.
  // This DOM replay verifies the computed correction, not browser geometry.
  assert.ok(19.9375+(135-20)-5>=6+122+1);
  await pipeline.store.flush();w.dispatchEvent(new w.Event('resize'));await settle();assert.equal(scrolls.length,1);assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);
  height=48;open($);chapterRows($)[0].querySelector('.chapter-open').click();assert.equal(scrolls.length,2);assert.equal(scrolls[1].margin,'61px');assert.equal(w.libraryProbe.documents[0].readingPosition,source.readingPosition);
 }finally{await w.happyDOM.close();}
});
