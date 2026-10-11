import {installSavePipeline} from './helpers/save-pipeline.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {splitCueFixture} from './helpers/split-cue-fixture.mjs';
const root = new URL('../', import.meta.url);
function setup() {
 const w = new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});
 const calls=[];w.fetch=async(...args)=>{calls.push(args);throw new Error('Unexpected network request');};
 w.eval(fs.readFileSync(new URL('reader/summary.js',root),'utf8'));
 w.eval(fs.readFileSync(new URL('reader/core.js',root),'utf8'));
 w.eval(fs.readFileSync(new URL('reader/passages.js',root),'utf8'));
 w.eval(fs.readFileSync(new URL('reader/passage-playback.js',root),'utf8'));
 installSavePipeline(w);
 w.eval(['app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
 w.HTMLElement.prototype.scrollIntoView=function(options){w.scrolled=this.dataset.segmentId;w.lastScrollOptions=options;};
 return {w,$:id=>w.document.getElementById(id),calls};
}
async function load($,doc=splitCueFixture()) {
 const text=JSON.stringify(doc);Object.defineProperty($('file'),'files',{configurable:true,value:[{name:'split.json',size:text.length,text:async()=>text}]});
 await $('file').onchange();$('mode-bilingual').click();
}
const rows=w=>[...w.document.querySelectorAll('#transcript .segment')];
const row=(w,id)=>rows(w).find(node=>node.dataset.segmentId===id);
const search=($,query)=>{$('search').value=query;$('search').oninput();};
const stored=w=>JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents;


test('source-backed snippets respect scope, Unicode and a strict preview cap',()=>{
 const {w}=setup();try{
  const d=splitCueFixture(10);d.segments.forEach(s=>s.text='前缀😀İ HELLO <img src=x> 后文');d.notes['split-0']='hello note';d.project_note='hello project';
  const C=w.Coconut;
  assert.equal(C.libraryHits(d,'hello','title').length,0);assert.equal(C.libraryHits(d,'  ','text').length,0);assert.equal(C.libraryHits(d,'absent','text').length,0);
  const hits=C.libraryHits(d,'hello','text');assert.equal(hits.length,3);assert.deepEqual(Array.from(hits,h=>h.kind),['project-note','note','text']);
  assert.equal(C.libraryHits(d,'HELLO','notes').length,2);
  const clipped=C.librarySnippet('x'+'a'.repeat(89),'x');assert.equal(clipped.after,'a'.repeat(65)+'…');
  const exact=C.librarySnippet('x'+'a'.repeat(65),'x');assert.equal(exact.after,'a'.repeat(65));
  assert.equal(C.librarySnippet('😀İ abc','abc').match,'abc');assert.equal(C.librarySnippet('😀İ abc','😀').match,'😀');
  const long=C.librarySnippet('a'.repeat(500)+'命中'+'z'.repeat(500),'命中');assert.equal(long.match,'命中');assert.ok(long.before.startsWith('…'));assert.ok(long.after.endsWith('…'));assert.ok(JSON.stringify(long).length<250);
 }finally{w.happyDOM.close();}
});

test('cross-document late source hit clears old filters, focuses real cue and retains library search',async()=>{
 const {w,$,calls}=setup();try{
  await load($);const other=splitCueFixture(4);other.title='Other document';await load($,other);
  $('filter-notes').click();search($,'old filter');
  $('library-scope').value='text';$('library-search').value='crossing-marker';$('library-search').oninput();
  assert.equal($('library').children.length,1);assert.equal($('library').querySelectorAll('.library-hit').length,1);
  const before=stored(w).find(d=>d.segments.length>100).readingPosition;
  $('library').querySelector('.library-hit').click();
  assert.equal($('search').value,'');assert.equal(w.document.activeElement.dataset.segmentId,'split-1750');assert.ok(row(w,'split-1749'));assert.ok(rows(w).length<=100);
  assert.equal($('library-search').value,'crossing-marker');assert.equal(stored(w).find(d=>d.segments.length>100).readingPosition,before);assert.equal(calls.length,0);
  $('toggle-library').click();assert.equal($('library').querySelector('mark').textContent,'crossing-marker');
  $('library-kind').value='audio';$('library-kind').onchange();assert.equal($('library').children.length,0);
 }finally{await w.happyDOM.close();}
});

test('note hits open the exact note editor and never interpret note HTML',async()=>{
 const {w,$}=setup();try{
  const d=splitCueFixture();d.notes['split-1751']='private <img src=x onerror=bad()> needle';await load($,d);
  $('library-scope').value='notes';$('library-search').value='<img';$('library-search').oninput();
  assert.equal($('library').querySelector('img'),null);assert.equal($('library').querySelector('mark').textContent,'<img');
  $('library').querySelector('.library-hit').click();assert.equal(w.document.activeElement,$('note'));assert.match($('note').value,/private/);assert.match($('note-time').textContent,/52:31/);
 }finally{await w.happyDOM.close();}
});

test('annotation hits clear stale bookmark filters and focus notes for audio and attached projects',async()=>{
 for(const attached of [false,true]){
  const {w,$,calls}=setup();try{
   const d=splitCueFixture(4);d.project_note='needle project';d.timestamp_bookmarks=[{id:'bookmark-1',time:3,note:'needle bookmark'}];
   if(!attached){d.project_kind='audio_only';d.segments=[];d.media_duration=30;d.podcast_source={feed_url:'https://example.com/feed',episode_id:'a'.repeat(64),media_url:'https://example.com/a.mp3',media_kind:'audio'};}
   await load($,d);$('audio-bookmark-search').value='stale';$('audio-bookmark-search').oninput();
   $('library-scope').value='notes';$('library-search').value='needle';$('library-search').oninput();
   assert.equal($('library').querySelectorAll('.library-hit').length,2);
   $('library').querySelector('[data-hit-kind="project-note"]').click();assert.equal(w.document.activeElement,$('project-note'));assert.equal($('audio-project').hidden,false);
   $('library').querySelector('[data-hit-kind="bookmark"]').click();assert.equal(w.document.activeElement.value,'needle bookmark');assert.equal($('audio-bookmark-search').value,'');assert.equal(calls.length,0);
  }finally{await w.happyDOM.close();}
 }
});

test('multiple matching documents retain title ordering and ordinary opens use saved reading position',async()=>{
 const {w,$}=setup();try{
  for(const title of ['Zulu needle','Alpha needle']){const d=splitCueFixture(120);d.title=title;d.segments[110].text='needle source';await load($,d);}
  $('library-search').value='needle';$('library-sort').value='title';$('library-scope').value='text';$('library-search').oninput();
  assert.deepEqual(Array.from($('library').querySelectorAll('.library-title'),el=>el.textContent),['Alpha needle','Zulu needle']);
  assert.equal($('library').querySelectorAll('.library-hit').length,2);
  $('library-scope').value='title';$('library-scope').onchange();assert.equal($('library').querySelectorAll('.library-hit').length,0);
  $('library').querySelector('.library-open').click();assert.equal($('title').textContent,'Alpha needle');assert.equal(stored(w).find(d=>d.title==='Alpha needle').readingPosition,'split-19');
  $('library-search').value='   ';$('library-search').oninput();assert.equal($('library').children.length,2);assert.equal($('library').querySelectorAll('.library-hit').length,0);
 }finally{await w.happyDOM.close();}
});


test('library options use a native disclosure and mobile library reopening preserves the search controls',async()=>{
 const {w,$}=setup();try{
  await load($);const disclosure=$('library-scope').closest('details');
  assert.ok(disclosure.classList.contains('library-options'));assert.equal(disclosure.open,false);
  disclosure.querySelector('summary').click();assert.equal(disclosure.open,true);
  $('library-scope').value='text';$('library-search').value='crossing-marker';$('library-search').oninput();
  $('toggle-library').click();assert.equal($('toggle-library').getAttribute('aria-expanded'),'true');
  $('library').querySelector('.library-hit').click();assert.equal($('toggle-library').getAttribute('aria-expanded'),'false');
  $('toggle-library').click();assert.equal($('toggle-library').getAttribute('aria-expanded'),'true');
  assert.equal(disclosure.open,true);assert.equal($('library-search').value,'crossing-marker');assert.equal($('library-scope').value,'text');
  assert.equal($('library').querySelectorAll('.library-hit').length,1);
 }finally{await w.happyDOM.close();}
});

// Saved evidence has a separate navigation contract from a current cue hit.
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {settle} from './helpers/save-pipeline.mjs';
function savedHarness(){
 const doc={key:'saved-owner',title:'Historical owner',language:'en',segments:Array.from({length:40},(_,i)=>({id:'cue-'+i,start:i,end:i+1,text:'Historical needle quotation '+i})),notes:Object.fromEntries(Array.from({length:40},(_,i)=>['cue-'+i,'needle current note '+i]))};
 const other={key:'other',title:'Keep reading here',language:'en',segments:[{id:'other-cue',start:0,end:1,text:'Other reading'}],notes:{}};
 const env=libraryHarness([other,doc],{probe:true,configureCore:w=>w.eval(fs.readFileSync(new URL('reader/quotation.js',root),'utf8'))});
 const live=env.w.libraryProbe.documents.find(d=>d.key===doc.key);
 live.exact_excerpts=Array.from({length:5},(_,i)=>env.w.Coconut.exactExcerptSnapshot(live,[live.segments[i]],[],0,live.segments[i].text.length,{id:'saved-'+i,createdAt:'2026-10-11T00:00:00.000Z'}));
 live.exact_excerpt_notes={'saved-0':'needle personal <img> thought'};
 live.segments[0].text='Corrected away';env.w.Coconut.invalidateSearch(live);env.w.libraryProbe.renderLibrary();
 return {...env,doc:live};
}
const shelfSearch=($,q,scope='text')=>{$('library-scope').value=scope;$('library-search').value=q;$('library-search').oninput();};
const readySaved=async()=>{await settle();await new Promise(resolve=>setTimeout(resolve,0));};

test('saved previews remain separate; keyboard target resolves beyond notebook page one without source navigation',async()=>{
 const {w,$,doc}=savedHarness();try{
  $('open-library-notebook').click();$('notebook-kind').value='note';$('notebook-search').value='old filter';$('notebook-search').oninput();$('notebook-close').click();
  shelfSearch($,'needle');
  assert.equal($('library').querySelectorAll('.library-hit').length,3);assert.equal($('library').querySelectorAll('.library-saved-hit').length,3);
  assert.match($('library').querySelector('.library-saved-more').textContent,/5/);
  const hit=$('library').querySelector('.library-saved-hit'),before=doc.readingPosition,title=$('title').textContent;
  assert.match(hit.textContent,/历史快照/);assert.equal(hit.querySelectorAll('.library-hit-preview').length,2);assert.equal(hit.querySelector('img'),null);
  hit.focus();hit.click();await readySaved();
  assert.equal($('notebook-kind').value,'all');assert.equal($('notebook-search').value,'needle');assert.match($('notebook-status').textContent,/31–45/);
  const target=$('notebook-captures').querySelector('[data-capture-id="saved-0"]');assert.ok(target.querySelector('.notebook-details').open);assert.equal(w.document.activeElement,target.querySelector('.notebook-details > summary'));
  assert.equal($('title').textContent,title);assert.equal(doc.readingPosition,before);assert.equal(w.document.querySelector('audio'),null);
  $('notebook-close').click();await readySaved();assert.equal(w.document.activeElement,hit);
  $('library').querySelector('.library-saved-more').click();assert.equal($('notebook-search').value,'needle');assert.equal($('notebook-kind').value,'all');
 }finally{await w.happyDOM.close();}
});

test('saved results survive missing source, reject replaced/deleted owners and stale detached actions',async()=>{
 const {w,$,doc}=savedHarness();try{
  delete doc.notes['cue-0'];doc.segments.shift();w.Coconut.invalidateSearch(doc);shelfSearch($,'Historical needle quotation 0');
  const hit=$('library').querySelector('.library-saved-hit');hit.click();await readySaved();
  assert.equal($('notebook-captures').querySelector('.notebook-open').disabled,true);assert.match($('notebook-captures').textContent,/原位置已删除/);$('notebook-close').click();
  const old=$('library').querySelector('.library-saved-hit');doc.exact_excerpts=doc.exact_excerpts.filter(r=>r.id!=='saved-0');old.click();assert.equal($('library-notebook').open,false);assert.match($('notice').textContent,/已变动/);
  shelfSearch($,'needle');const detached=$('library').querySelector('.library-saved-hit');shelfSearch($,'nothing');detached.click();assert.equal($('library-notebook').open,false);
  shelfSearch($,'needle');const replacementHit=$('library').querySelector('.library-saved-hit');w.libraryProbe.documents.splice(1,1,{...doc});replacementHit.click();assert.equal($('library-notebook').open,false);
 }finally{await w.happyDOM.close();}
});

test('saving and removing personal notes refreshes visible shelf results without disturbing the note editor',async()=>{
 const {w,$}=savedHarness();try{
  shelfSearch($,'personal','notes');assert.match($('library-search').placeholder,/摘录笔记/);
  $('library').querySelector('.library-saved-hit').click();await readySaved();$('notebook-captures').querySelector('.notebook-edit-exact-note').click();
  const input=$('exact-note-text');input.value='replacement thought';input.oninput();input.setSelectionRange(4,4);await $('exact-note-save').onclick();await readySaved();
  assert.equal($('library').querySelectorAll('.library-saved-hit').length,0);assert.equal($('exact-note-dialog').open,true);assert.equal(w.document.activeElement,input);assert.equal(input.selectionStart,4);assert.equal(input.value,'replacement thought');
  $('exact-note-close').click();$('notebook-close').click();await readySaved();assert.equal(w.document.activeElement,$('library-search'));
  shelfSearch($,'replacement','notes');$('library').querySelector('.library-saved-hit').click();await readySaved();$('notebook-captures').querySelector('.notebook-edit-exact-note').click();input.value='';input.oninput();await $('exact-note-save').onclick();await readySaved();assert.equal($('library').querySelectorAll('.library-saved-hit').length,0);assert.equal(w.document.activeElement,input);
 }finally{await w.happyDOM.close();}
});

test('closing or replacing a pending historical reveal cannot later steal focus',async()=>{
 const {w,$,doc}=savedHarness();try{
  // Notebook admission is large even though a title lookup was cheap.
  doc.exact_excerpts.push(...Array.from({length:4100},(_,i)=>({...doc.exact_excerpts[1],id:'bulk-'+i})));
  shelfSearch($,'personal','notes');
  for(let i=0;i<100&&$('library').hidden;i++)await new Promise(resolve=>setTimeout(resolve,5));
  const hit=$('library').querySelector('.library-saved-hit');assert.ok(hit);hit.click();assert.equal($('notebook-captures').getAttribute('aria-busy'),'true');
  $('notebook-close').click();$('library-search').focus();await readySaved();assert.equal(w.document.activeElement,$('library-search'));assert.equal($('library-notebook').open,false);
  hit.click();$('notebook-search').value='new unmatched query';$('notebook-search').oninput();
  for(let i=0;i<100&&$('notebook-captures').getAttribute('aria-busy')==='true';i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(w.document.activeElement,$('notebook-search'));assert.equal($('notebook-captures').children.length,0);
 }finally{await w.happyDOM.close();}
});

test('saved reveal relinquishes focus permanently and stale pending targets report a refresh',async()=>{
 const {w,$,doc}=savedHarness();try{
  doc.exact_excerpts.push(...Array.from({length:4100},(_,i)=>({...doc.exact_excerpts[1],id:'more-'+i})));
  shelfSearch($,'personal','notes');
  for(let i=0;i<100&&$('library').hidden;i++)await new Promise(resolve=>setTimeout(resolve,5));
  $('library').querySelector('.library-saved-hit').click();$('notebook-kind').focus();$('notebook-search').focus();
  for(let i=0;i<100&&$('notebook-captures').getAttribute('aria-busy')==='true';i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(w.document.activeElement,$('notebook-search'));assert.ok($('notebook-captures').querySelector('.notebook-details').open);$('notebook-close').click();
  // Force a new notebook job and change the owner while its target is resolving.
  doc.exact_excerpts=[...doc.exact_excerpts];w.libraryProbe.renderLibrary();
  for(let i=0;i<100&&$('library').hidden;i++)await new Promise(resolve=>setTimeout(resolve,5));
  $('library').querySelector('.library-saved-hit').click();doc.exact_excerpt_notes={...doc.exact_excerpt_notes,'saved-0':'different note'};
  for(let i=0;i<100&&!/已变动/.test($('notebook-status').textContent);i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.match($('notebook-status').textContent,/已变动/);assert.equal(w.document.activeElement,$('notebook-search'));assert.equal($('notebook-captures').querySelector('[open]'),null);
 }finally{await w.happyDOM.close();}
});
