/** Display-only manual chapters; Happy DOM does not prove native copy/layout. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {settle} from './helpers/save-pipeline.mjs';
const root=process.env.COCONUT_CHAPTER_SOURCE_ROOT?pathToFileURL(process.env.COCONUT_CHAPTER_SOURCE_ROOT+'/'):new URL('../',import.meta.url);
const quotation=fs.readFileSync(new URL('reader/quotation.js',root),'utf8');
function fixture(count=32){return {schema_version:1,key:'manual-markers',title:'Authored chapter markers',language:'en',translation_view:'zh',readingPosition:'c0',notes:{},segments:Array.from({length:count},(_,i)=>{
 const text='Source sentence '+i+'.';return {id:'c'+i,start:i,end:i+1,text,translations:{zh:{text:'自写译文'+i+'。',source_text:text,source_language:'en',document_language:'en',provider:'authored fixture'}}};
}),reading_chapters:[{id:'opening',title:'Opening idea',cue_id:'c0',time:0,note:''},{id:'change',title:'A different idea',cue_id:'c4',time:4,note:''}]};}
function setup(doc=fixture()){const env=libraryHarness([doc],{probe:true,sourceRoot:root,configureCore:w=>w.eval(quotation)});env.$('mode-passages').click();return env;}
const rows=w=>[...w.document.querySelectorAll('#transcript .segment')];
const passages=w=>[...w.document.querySelectorAll('#passage-body .passage')];
const labels=node=>[...node.querySelectorAll('.reading-chapter-label')];
const titles=node=>labels(node).map(label=>label.querySelector('.reading-chapter-title').textContent);
const original=w=>w.document.querySelector('.passage-original');
const sourceSpans=w=>[...original(w).querySelectorAll('.passage-cue')];
const own=env=>env.w.libraryProbe.documents[0];
function select(w,first,from,last,to){const range=w.document.createRange();range.setStart(first,from);range.setEnd(last,to);const selection=w.getSelection();selection.removeAllRanges();selection.addRange(range);return selection;}
function entry($,id){return [...$('chapter-list').children].find(node=>node.dataset.chapterId===id);}
function create($,number,title){$('chapter-add').click();$('chapter-cue-number').value=String(number);$('chapter-cue-number').oninput();$('chapter-title').value=title;$('chapter-save').click();}

test('two chapter starts inside one paragraph have outside-source titles and exact cue markers without recomposition',async()=>{
 const env=setup(),{w,$}=env;try{
  const doc=own(env),before=JSON.stringify(doc),first=passages(w)[0],p=original(w),cues=w.CoconutPassages.build(doc.segments)[0].cues;
  assert.deepEqual(Array.from(cues,c=>c.id),['c0','c1','c2','c3','c4','c5','c6','c7']);assert.deepEqual(titles(first),['Opening idea','A different idea']);
  assert.deepEqual(labels(first).map(n=>n.dataset.chapterKind),['start','start']);assert.equal(first.dataset.passageId,'passage:c0');
  assert.equal(p.textContent,w.CoconutQuotation.compose(cues,w.CoconutPassages.separator).text);assert.equal(p.children.length,8);assert.ok([...p.children].every(n=>n.className==='passage-cue'&&n.children.length===0));
  assert.deepEqual(sourceSpans(w).filter(n=>n.hasAttribute('data-reading-chapter-marker')).map(n=>[n.dataset.cueId,n.dataset.readingChapterMarker]),[['c0','1'],['c4','2']]);
  for(const node of sourceSpans(w).filter(n=>n.dataset.readingChapterMarker)){const description=$(node.getAttribute('aria-describedby'));assert.ok(description);assert.equal(p.contains(description),false);assert.match(description.textContent,/章节起点/);assert.ok(description.textContent.length<100);}
  assert.equal(first.querySelectorAll('.passage-translation [data-reading-chapter-marker]').length,0);assert.equal(JSON.stringify(doc),before);
  assert.equal(passages(w)[1].querySelector('.reading-chapter-label'),null,'do not repeat orientation on every paragraph');
 }finally{await w.happyDOM.close();}
});

for(const kind of ['absent','empty','missing'])test('no guessed markers for '+kind+' chapters',async()=>{
 const doc=fixture();if(kind==='absent')delete doc.reading_chapters;if(kind==='empty')doc.reading_chapters=[];if(kind==='missing')doc.reading_chapters=[{id:'lost',title:'Lost identical time',cue_id:'not-here',time:0,note:''}];
 const {w,$}=setup(doc);try{assert.equal(w.document.querySelectorAll('.reading-chapter-label,[data-reading-chapter-marker]').length,0);if(kind==='missing'){$('open-chapters').click();assert.equal(entry($,'lost').querySelector('.chapter-open').disabled,true);}}
 finally{await w.happyDOM.close();}
});

test('same-time, empty and long cue IDs are ordered by live source, including current rather than saved anchor time',async()=>{
 const doc=fixture();doc.segments[0].id='';doc.segments[4].id='id-'.repeat(200);for(const cue of doc.segments.slice(0,5)){cue.start=3;cue.end=4;}
 doc.reading_chapters=[{...doc.reading_chapters[1],cue_id:doc.segments[4].id,time:999},{...doc.reading_chapters[0],cue_id:'',time:999}];
 const {w,$}=setup(doc);try{
  const nodes=[...$('passage-body').querySelectorAll('[data-reading-chapter-marker]')];assert.deepEqual(nodes.map(n=>[n.dataset.cueId,n.dataset.readingChapterMarker]),[['','1'],[doc.segments[4].id,'2']]);
  assert.deepEqual(titles($('passage-body')),['Opening idea','A different idea']);assert.ok(labels($('passage-body')).every(n=>n.querySelector('.reading-chapter-location').textContent.startsWith('00:03')));
  $('mode-bilingual').click();assert.deepEqual(titles($('transcript')),['Opening idea','A different idea']);assert.equal(own({w}).reading_chapters[0].time,999);
 }finally{await w.happyDOM.close();}
});

test('source edits and reordering follow surviving cue identity and never invent a missing first chapter',async()=>{
 const env=setup(),{w,$}=env;try{
  const doc=own(env),saved=JSON.stringify(doc.reading_chapters);doc.segments.splice(0,1);doc.segments[3].text='Edited original';doc.segments[3].start=7;doc.segments[3].end=8;w.libraryProbe.render();
  assert.deepEqual(titles($('passage-body')),['A different idea']);assert.equal($('passage-body').querySelector('[data-reading-chapter-marker]').dataset.cueId,'c4');
  const moved=doc.segments.splice(3,1)[0];doc.segments.unshift(moved);w.libraryProbe.render();assert.equal(passages(w)[0].dataset.firstCueId,'c4');assert.equal(labels(passages(w)[0])[0].dataset.chapterKind,'start');assert.equal(JSON.stringify(doc.reading_chapters),saved);
 }finally{await w.happyDOM.close();}
});

test('page entry repeats only actual containing chapter, never a fabricated page-start chapter',async()=>{
 const {w,$}=setup(fixture(800));try{
  const before=own({w}).readingPosition;$('passage-next').click();const first=passages(w)[0],id=first.dataset.firstCueId;assert.notEqual(id,'c0');assert.deepEqual(titles(first),['A different idea']);assert.equal(labels(first)[0].dataset.chapterKind,'context');assert.equal(first.querySelector('[data-reading-chapter-marker]'),null);
  $('mode-transcript').click();$('next-page').click();assert.deepEqual(titles(rows(w)[0]),['A different idea']);assert.equal(labels(rows(w)[0])[0].dataset.chapterKind,'context');assert.equal(own({w}).readingPosition,before);
 }finally{await w.happyDOM.close();}
});

test('filtered bilingual results show chapter membership without faking skipped boundaries or matching titles',async()=>{
 const env=setup(),{w,$}=env;try{
  $('mode-bilingual').click();$('search').value='sentence 5.';$('search').oninput();assert.equal(rows(w).length,1);assert.equal(rows(w)[0].dataset.segmentId,'c5');assert.deepEqual(titles(rows(w)[0]),['A different idea']);assert.equal(labels(rows(w)[0])[0].dataset.chapterKind,'context');
  assert.equal(rows(w)[0].querySelectorAll('.translation').length,1);$('search').value='different idea';$('search').oninput();assert.equal(rows(w).length,0);assert.equal($('transcript').querySelectorAll('.reading-chapter-label').length,0);
 }finally{await w.happyDOM.close();}
});

test('Find return and continue preserve exact source, mode, page, chapter context and saved reading bookmark',async()=>{
 const doc=fixture(800);doc.readingPosition='c205';const env=setup(doc),{w,$}=env;try{
  const first=passages(w)[0].dataset.firstCueId,bookmark=own(env).readingPosition;$('passage-search').click();$('search').value='sentence 700.';$('search').oninput();$('next-match').click();assert.deepEqual(titles(rows(w)[0]),['A different idea']);
  $('return-before-search').click();assert.equal(passages(w)[0].dataset.firstCueId,first);assert.equal($('mode-passages').getAttribute('aria-pressed'),'true');assert.deepEqual(titles(passages(w)[0]),['A different idea']);
  $('passage-search').click();$('search').value='sentence 700.';$('search').oninput();$('next-match').click();$('continue-search-reading').click();assert.equal(w.document.activeElement.dataset.cueId,'c700');assert.equal(own(env).readingPosition,bookmark);assert.deepEqual(titles(passages(w)[0]),['A different idea']);
 }finally{await w.happyDOM.close();}
});

test('create rename relocate remove refresh only labels, preserving original text nodes, selection, player and focus ownership',async()=>{
 const doc=fixture();doc.reading_chapters=[];const env=setup(doc),{w,$}=env;try{
  const p=original(w),nodes=[...p.childNodes],spans=sourceSpans(w),player=w.document.createElement('audio');$('source-media').append(player);let mediaCalls=0,scrolls=0;player.play=()=>{mediaCalls++;return Promise.resolve();};player.pause=()=>{mediaCalls++;};w.scrollBy=w.scrollTo=()=>{scrolls++;};w.HTMLElement.prototype.scrollIntoView=function(){scrolls++;};
  select(w,spans[3].firstChild,2,spans[5].firstChild,8);const selected=w.getSelection().toString();$('open-chapters').click();create($,5,'New chapter');assert.equal($('chapter-editor').open,false);assert.deepEqual(titles(passages(w)[0]),['New chapter']);
  entry($,own(env).reading_chapters[0].id).querySelector('.chapter-rename').click();$('chapter-title').value='Renamed';$('chapter-save').click();assert.deepEqual(titles(passages(w)[0]),['Renamed']);assert.equal(w.document.activeElement.className,'chapter-rename');
  const id=own(env).reading_chapters[0].id;entry($,id).querySelector('.chapter-relocate').click();$('chapter-cue-number').value='6';$('chapter-cue-number').oninput();$('chapter-save').click();assert.equal(original(w).querySelector('[data-reading-chapter-marker]').dataset.cueId,'c5');
  entry($,id).querySelector('.chapter-remove').click();assert.equal(w.document.activeElement,$('chapter-add'));assert.equal(original(w).querySelector('[data-reading-chapter-marker]'),null);assert.equal(p,original(w));assert.deepEqual([...p.childNodes],nodes);assert.equal(w.getSelection().toString(),selected);assert.equal($('source-media').firstChild,player);assert.equal(mediaCalls,0);assert.equal(scrolls,0);
 }finally{await w.happyDOM.close();}
});

test('pending failed and retried chapter receipts never rescan labels or replace source nodes and caret',async()=>{
 const env=setup(),{w,$,pipeline}=env;try{
  $('open-chapters').click();pipeline.hold();entry($,'opening').querySelector('.chapter-rename').click();$('chapter-title').value='Pending title';$('chapter-save').click();const flush=pipeline.store.flush();await settle();
  const p=original(w),label=passages(w)[0].querySelector('.reading-chapter-label');entry($,'opening').querySelector('.chapter-rename').click();$('chapter-title').value='Unsubmitted title';$('chapter-title').setSelectionRange(2,5);let scans=0,scrolls=0;const scan=w.Coconut.readingChapters;w.Coconut.readingChapters=(...args)=>{scans++;return scan(...args);};w.scrollBy=w.scrollTo=()=>{scrolls++;};
  pipeline.writes[0].fail();await flush;assert.equal(w.document.activeElement,$('chapter-title'));assert.equal($('chapter-title').selectionStart,2);assert.equal(passages(w)[0].querySelector('.reading-chapter-label'),label);assert.equal(original(w),p);assert.equal(scans,0);assert.equal(scrolls,0);assert.match($('chapter-save-status').textContent,/尚未保存/);
  pipeline.hold(false);await $('chapter-retry').onclick();assert.equal(passages(w)[0].querySelector('.reading-chapter-label'),label);assert.equal(scans,0);assert.equal(scrolls,0);assert.equal($('chapter-title').value,'Unsubmitted title');
 }finally{await w.happyDOM.close();}
});

test('cross-chapter quotation retains exact native-DOM text and strict validation without including title or number',async()=>{
 const env=setup(),{w,$}=env;try{
  const doc=own(env),p=original(w),cues=w.CoconutPassages.build(doc.segments)[0].cues,model=w.CoconutQuotation.compose(cues,w.CoconutPassages.separator),spans=sourceSpans(w);
  const selection=select(w,spans[3].firstChild,2,spans[5].firstChild,8),expected=selection.toString(),quote=w.CoconutQuotation.domSelection(p,model,selection);
  assert.equal(quote.text,expected);assert.deepEqual(Array.from(quote.parts,part=>part.cue.id),['c3','c4','c5']);assert.doesNotMatch(quote.text,/Opening|different|\[2\]/);
  passages(w)[0].querySelector('.passage-quote').click();assert.equal($('quotation-original-text').value,expected);await $('quotation-save').onclick();assert.equal(doc.exact_excerpts.length,1);assert.equal(w.Coconut.exactExcerptText(doc.exact_excerpts[0]),expected);$('quotation-close').click();
  const injected=w.document.createElement('span');injected.textContent='Unexpected title';p.append(injected);select(w,spans[3].firstChild,2,spans[5].firstChild,8);assert.throws(()=>w.CoconutQuotation.domSelection(p,model,w.getSelection()));
 }finally{await w.happyDOM.close();}
});

test('chapter edits preserve passage questions, translation ownership, phrase search and exact excerpt freshness',async()=>{
 const env=setup(),{w,$}=env;try{
  const doc=own(env),cues=w.CoconutPassages.build(doc.segments)[0].cues,record=w.Coconut.exactExcerptSnapshot(doc,cues,Array(cues.length-1).fill(' '),4,75,{id:'proof',createdAt:'2026-10-11T00:00:00.000Z'}),search=w.Coconut.searchDocument(doc,'3. Source sentence 4.');
  const source=JSON.stringify(doc.segments),groups=w.CoconutPassages.build(doc.segments).map(p=>({key:p.key,ids:p.cues.map(c=>c.id),start:p.start,end:p.end}));
  $('open-chapters').click();entry($,'change').querySelector('.chapter-rename').click();$('chapter-title').value='Edited chapter';$('chapter-save').click();$('chapter-close').click();
  assert.equal(JSON.stringify(doc.segments),source);assert.equal(w.Coconut.searchDocument(doc,'3. Source sentence 4.'),search);assert.equal(w.Coconut.exactExcerptFreshness(record,doc),'current');assert.deepEqual(w.CoconutPassages.build(doc.segments).map(p=>({key:p.key,ids:p.cues.map(c=>c.id),start:p.start,end:p.end})),groups);assert.ok(doc.segments.every(c=>w.Coconut.translationCurrent(c,doc,c.translations.zh)));
  passages(w)[0].querySelector('.passage-ask').click();assert.deepEqual([...$('passage-question-preview').querySelectorAll('[data-cue-id]')].map(n=>n.dataset.cueId),Array.from(cues,c=>c.id));assert.doesNotMatch($('passage-question-preview').textContent,/Edited chapter|Opening idea/);
 }finally{await w.happyDOM.close();}
});

test('all mounted views share one source chapter lookup, while 2000 chapters stay bounded by page DOM',async()=>{
 const doc=fixture(16000);doc.reading_chapters=Array.from({length:2000},(_,i)=>({id:'ch'+i,title:'Chapter '+i,cue_id:'c'+(i*8),time:i*8,note:''}));const env=setup(doc),{w,$}=env;try{
  let scans=0;const originalScan=w.Coconut.readingChapters;w.Coconut.readingChapters=(...args)=>{scans++;return originalScan(...args);};w.libraryProbe.render();assert.equal(scans,1);assert.ok($('passage-body').querySelectorAll('.reading-chapter-label').length<=24);assert.ok($('transcript').querySelectorAll('.reading-chapter-label').length<=120);assert.equal(own(env).reading_chapters.length,2000);
 }finally{await w.happyDOM.close();}
});

test('titles render literally, retain imported linebreaks and wrap across themes without changing reading font settings',async()=>{
 const doc=fixture();doc.reading_chapters[0].title='<script>never()</script>\n'+('长标题🌴'.repeat(25));const {w,$}=setup(doc);try{
  const style=w.document.createElement('style');style.textContent=fs.readFileSync(new URL('reader/style.css',root),'utf8');w.document.head.append(style);const title=passages(w)[0].querySelector('.reading-chapter-title');assert.equal(title.textContent,doc.reading_chapters[0].title);assert.equal(title.children.length,0);assert.equal(w.getComputedStyle(title).overflowWrap,'anywhere');assert.equal(w.getComputedStyle(title).whiteSpace,'pre-wrap');
  for(const theme of ['light','dark'])for(const layout of ['standard','large','spacious']){w.document.documentElement.dataset.readerTheme=theme;w.document.documentElement.dataset.readingLayout=layout;assert.equal(titles(passages(w)[0])[0],doc.reading_chapters[0].title);assert.equal(w.document.documentElement.dataset.readingLayout,layout);}
 }finally{await w.happyDOM.close();}
});
