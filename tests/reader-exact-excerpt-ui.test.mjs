import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {settle} from './helpers/save-pipeline.mjs';
const quotation=fs.readFileSync(new URL('../reader/quotation.js',import.meta.url),'utf8');
const fixture=()=>({key:'precise',title:'Authored source',language:'en',segments:[{id:'a',text:'Repeated repeated 🌴',start:1,end:8},{id:'b',text:'words 中文。',start:2,end:4}],notes:{}});
function setup(doc=fixture()){const env=libraryHarness([doc],{probe:true,configureCore:w=>w.eval(quotation)});env.$('mode-passages').click();return env;}
function preview(env,from=9,to=26){const {$,w}=env;w.getSelection().removeAllRanges();w.document.querySelector('.passage-quote').click();$('quotation-source').setSelectionRange(from,to);$('quotation-preview-selection').click();}
async function ready(){await settle();await new Promise(r=>setTimeout(r,0));}

test('exact save waits for its receipt, dedupes repeated clicks and supports retry without changing whole-cue excerpts',async()=>{
 const env=setup(),{w,$,pipeline}=env;try{
  pipeline.hold();preview(env);$('quotation-save').click();$('quotation-save').click();await settle();
  const doc=w.libraryProbe.documents[0];assert.equal(doc.exact_excerpts.length,1);assert.equal(doc.exact_excerpts[0].text,'repeated 🌴 words');assert.equal(doc.segments[0].saved_excerpt,undefined);assert.match($('quotation-save-status').textContent,/保存中/);assert.equal(pipeline.writes.length,1);
  pipeline.writes[0].fail();await ready();assert.match($('quotation-save-status').textContent,/仅在本页/);assert.equal($('quotation-save').disabled,false);
  $('quotation-save').click();await settle();assert.equal(doc.exact_excerpts.length,1);pipeline.writes[1].commit();await ready();assert.match($('quotation-save-status').textContent,/已保存到本机/);
  $('quotation-close').click();preview(env);$('quotation-save').click();await ready();assert.equal(doc.exact_excerpts.length,1);assert.equal(pipeline.writes.length,2);
 }finally{await w.happyDOM.close();}
});

test('late receipts cannot change a newer quotation, status or focus',async()=>{
 const env=setup(),{w,$,pipeline}=env;try{
  pipeline.hold();preview(env);$('quotation-save').click();await settle();$('quotation-close').click();preview(env,0,4);const focus=w.document.activeElement,status=$('quotation-save-status').textContent;
  pipeline.writes[0].commit();await ready();assert.equal(w.document.activeElement,focus);assert.equal($('quotation-save-status').textContent,status);assert.equal($('quotation-save').disabled,false);
 }finally{await w.happyDOM.close();}
});

test('grapheme splits and changed cue adjacency reject saving before mutation',async()=>{
 const doc=fixture();doc.segments[0].text='a e\u0301 test';const env=setup(doc),{w,$}=env;try{
  preview(env,2,3);$('quotation-save').click();await ready();assert.equal(w.libraryProbe.documents[0].exact_excerpts?.length||0,0);
  $('quotation-close').click();preview(env,0,5);w.libraryProbe.documents[0].segments.splice(1,0,{id:'inserted',text:'new',start:1,end:2});$('quotation-save').click();await ready();assert.equal(w.libraryProbe.documents[0].exact_excerpts?.length||0,0);assert.match($('quotation-status').textContent,/已变化/);
 }finally{await w.happyDOM.close();}
});

test('notebook preserves captured corrected text, source and context after source deletion, exports and removes exact records',async()=>{
 const doc=fixture();doc.segments[0].original_text='Before correction';const env=setup(doc),{w,$}=env;try{
  preview(env);$('quotation-save').click();await ready();$('quotation-close').click();const live=w.libraryProbe.documents[0];
  live.title='Renamed source';live.segments=[];w.libraryProbe.render();$('open-library-notebook').click();await ready();
  const row=$('notebook-captures').querySelector('.notebook-capture');assert.ok(row);const details=row.querySelector('details');details.open=true;details.dispatchEvent(new w.Event('toggle'));const history=details.querySelector('.notebook-history');history.open=true;history.dispatchEvent(new w.Event('toggle'));assert.match(row.textContent,/所选文字摘录 · 历史快照/);assert.match(row.textContent,/Authored source/);assert.match(row.textContent,/Before correction/);assert.match(row.textContent,/Repeated repeated 🌴 words 中文/);assert.equal(row.querySelector('.notebook-open').disabled,true);
  $('notebook-search').value='repeated';$('notebook-search').dispatchEvent(new w.Event('input'));await ready();assert.equal($('notebook-captures').children.length,1);
  assert.match(w.Coconut.notebookMarkdown(live),/repeated 🌴 words/);assert.equal($('export-notebook').disabled,false);
  $('notebook-captures').querySelector('.notebook-remove').click();await ready();assert.equal(live.exact_excerpts,undefined);assert.equal(w.document.activeElement,$('notebook-search'));
 }finally{await w.happyDOM.close();}
});

test('reopening a pending exact range shares its in-flight receipt and global retry updates only its own preview',async()=>{
 const env=setup(),{w,$,pipeline}=env;try{
  pipeline.hold();preview(env);$('quotation-save').click();await settle();$('quotation-close').click();preview(env);$('quotation-save').click();await settle();assert.equal(pipeline.writes.length,1);assert.equal(w.libraryProbe.documents[0].exact_excerpts.length,1);
  pipeline.writes[0].fail();await ready();assert.match($('quotation-save-status').textContent,/仅在本页/);
  $('retry-save').click();await settle();pipeline.writes[1].commit();await ready();assert.match($('quotation-save-status').textContent,/已保存到本机/);assert.equal($('quotation-save').disabled,true);
 }finally{await w.happyDOM.close();}
});

test('current exact notebook navigation targets the selected cue and returns to its record',async()=>{
 const env=setup(),{w,$}=env;try{
  preview(env,21,26);$('quotation-save').click();await ready();$('quotation-close').click();$('open-library-notebook').click();await ready();
  $('notebook-captures').querySelector('.notebook-open').click();assert.equal($('library-notebook').open,false);assert.equal(w.libraryProbe.documents[0].readingPosition,undefined);assert.equal(w.document.activeElement.closest('.segment')?.dataset.segmentId,'b');
  $('return-library-notebook').click();await ready();assert.equal($('library-notebook').open,true);assert.equal(w.document.activeElement.classList.contains('notebook-open'),true);
 }finally{await w.happyDOM.close();}
});

test('notebook batches freshness per document and mounts captured context only in bounded explicit expansions',async()=>{
 const doc=fixture();doc.segments=[{id:'long',text:'Beginning '+('🌴'.repeat(15000))+' finish',start:0,end:10}];const env=setup(doc),{w,$}=env;try{
  const live=w.libraryProbe.documents[0];live.exact_excerpts=Array.from({length:30},(_,i)=>w.Coconut.exactExcerptSnapshot(live,live.segments,[],10+i*2,12+i*2,{id:'e'+i,createdAt:'2026-10-11T00:00:00.000Z'}));
  let batches=0;const batch=w.Coconut.exactExcerptStateBatch;w.Coconut.exactExcerptStateBatch=(...args)=>{batches++;return batch(...args);};
  $('open-library-notebook').click();await ready();assert.equal(batches,1);assert.equal($('notebook-captures').children.length,30);assert.ok($('notebook-captures').textContent.length<20000);
  const details=$('notebook-captures').querySelector('details');details.open=true;details.dispatchEvent(new w.Event('toggle'));const history=details.querySelector('.notebook-history');assert.equal(history.querySelector('.notebook-content'),null);history.open=true;history.dispatchEvent(new w.Event('toggle'));const more=details.querySelector('.notebook-more-context'),context=more.previousElementSibling;
  assert.ok(context.textContent.length<8100);assert.equal(more.hidden,false);assert.equal(/[\uD800-\uDBFF]$/.test(context.textContent),false);
  const focus=$('notebook-search');focus.focus();more.click();assert.ok(context.textContent.length<16100);assert.equal(w.document.activeElement,focus);
  more.focus();while(more.getAttribute('aria-disabled')!=='true')more.click();assert.equal(context.textContent,'摘录时上下文：\n'+live.segments[0].text);assert.equal(w.document.activeElement,more);assert.equal(more.hidden,false);focus.focus();assert.equal(more.hidden,true);
 }finally{await w.happyDOM.close();}
});


test('same-dialog reselection can save a new exact range while an older receipt is pending',async()=>{
 const env=setup(),{w,$,pipeline}=env;try{
  pipeline.hold();preview(env);$('quotation-save').click();await settle();
  $('quotation-reselect').click();$('quotation-source').setSelectionRange(0,4);$('quotation-preview-selection').click();$('quotation-save').click();await settle();
  assert.equal(w.libraryProbe.documents[0].exact_excerpts.length,2);assert.equal($('quotation-save').disabled,true);const status=$('quotation-save-status').textContent;
  pipeline.writes[0].commit();await ready();assert.equal($('quotation-save-status').textContent,status);assert.equal($('quotation-save').disabled,true);assert.equal(pipeline.writes.length,2);
  pipeline.writes[1].commit();await ready();assert.match($('quotation-save-status').textContent,/已保存到本机/);assert.equal(w.libraryProbe.documents[0].exact_excerpts.length,2);
 }finally{await w.happyDOM.close();}
});


test('production bootstrap admits separate shipped scripts before exact save, durable receipt and notebook history',async()=>{
 const root=new URL('../',import.meta.url),html=fs.readFileSync(new URL('reader/index.html',root),'utf8');
 const w=new Window({url:'http://127.0.0.1:8080/'}),$=id=>w.document.getElementById(id),context=vm.createContext(w),admitted=[],requests=[];
 const run=source=>vm.runInContext(source,context);
 try{
  w.document.body.innerHTML=html.split('<body>')[1].split('</body>')[0];Object.defineProperty(w,'crypto',{value:webcrypto});w.HTMLElement.prototype.scrollIntoView=function(){};
  w.coconutUpdates={state:async()=>({status:'idle',version:'test',arch:'arm64'}),subscribe:()=>{}};
  w.fetch=async url=>{if(url==='api/health')return {ok:true,json:async()=>({})};requests.push(url);throw Error('Unexpected request');};
  w.document.head.innerHTML=[...html.matchAll(/<script\b[^>]*data-reader-script[^>]*>[\s\S]*?<\/script>/g)].map(match=>match[0]).join('');
  w.document.head.append=script=>{const name=new URL(script.src).pathname.slice(1);admitted.push(name);try{run(fs.readFileSync(new URL('reader/'+name,root),'utf8'));queueMicrotask(()=>script.onload());}catch(error){script.onerror(error);}};
  for(const name of ['appearance','summary','core','passages','quotation','passage-playback','library-store','indexeddb-document-adapter','storage-provider','storage-bootstrap'])run(fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8'));
  for(let i=0;i<100&&w.CoconutStorageBootstrap.phase==='loading';i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(w.CoconutStorageBootstrap.phase,'ready');assert.deepEqual(admitted,['app.js','language.js','translation-review.js','podcasts.js','jobs.js','updates.js']);
  const value=JSON.stringify(fixture());Object.defineProperty($('file'),'files',{configurable:true,value:[{name:'authored-exact.json',size:value.length,text:async()=>value}]});await $('file').onchange();
  $('mode-passages').click();preview({w,$});await $('quotation-save').onclick();
  assert.match($('quotation-save-status').textContent,/已保存到本机/);assert.equal(run('active().exact_excerpts.length'),1);assert.equal(run('active().exact_excerpts[0].text'),'repeated 🌴 words');
  await run('libraryStore.flush()');const persisted=JSON.parse(w.localStorage.getItem('coconut-reader-v1'));assert.equal(persisted.documents[0].exact_excerpts[0].text,'repeated 🌴 words');
  $('quotation-close').click();$('open-library-notebook').click();await ready();const row=$('notebook-captures').querySelector('.notebook-capture');assert.match(row.textContent,/所选文字摘录 · 历史快照/);
  const details=row.querySelector('details');details.open=true;details.dispatchEvent(new w.Event('toggle'));assert.match(details.textContent,/Authored source/);assert.match(details.textContent,/摘录时上下文/);assert.equal(row.querySelector('.notebook-open').disabled,false);
  assert.equal(requests.length,0);
 }finally{w.dispatchEvent(new w.Event('pagehide'));await w.happyDOM.close();}
});


for(const change of ['title','text'])test('historical exact excerpts navigate clearly labeled corresponding current source after '+change+' correction',async()=>{
 const env=setup(),{w,$}=env;try{
  preview(env);await $('quotation-save').onclick();$('quotation-close').click();const live=w.libraryProbe.documents[0],historical=JSON.stringify(live.exact_excerpts[0]);
  if(change==='title')live.title='Corrected document title';else live.segments[0].text='Corrected source text';
  w.libraryProbe.render();$('open-library-notebook').click();await ready();const row=$('notebook-captures').querySelector('.notebook-capture'),open=row.querySelector('.notebook-open');
  assert.equal(open.disabled,false);assert.equal(open.textContent,'查看当前对应原文');assert.match(row.textContent,/原文或出处已变化/);assert.match(row.textContent,/repeated 🌴 words/);
  open.click();assert.equal($('library-notebook').open,false);assert.equal(w.document.activeElement.closest('.segment')?.dataset.segmentId,'a');assert.equal(JSON.stringify(live.exact_excerpts[0]),historical);
 }finally{await w.happyDOM.close();}
});
for(const change of ['missing','reordered','inserted'])test('exact notebook refuses ambiguous current location after source is '+change,async()=>{
 const env=setup(),{w,$}=env;try{
  preview(env);await $('quotation-save').onclick();$('quotation-close').click();const live=w.libraryProbe.documents[0];
  if(change==='missing')live.segments.pop();else if(change==='reordered')live.segments.reverse();else live.segments.splice(1,0,{id:'new',text:'Inserted source',start:1,end:2});
  w.libraryProbe.render();$('open-library-notebook').click();await ready();const row=$('notebook-captures').querySelector('.notebook-capture');assert.equal(row.querySelector('.notebook-open').disabled,true);assert.match(row.textContent,/repeated 🌴 words/);
 }finally{await w.happyDOM.close();}
});

test('notebook note, whole-cue and exact records show one full quote with optional diagnostics and preserve disclosure focus',async()=>{
 const doc=fixture();doc.notes={a:'A separate personal observation'};doc.segments[1].saved_excerpt=true;const env=setup(doc),{w,$}=env;try{
  preview(env);await $('quotation-save').onclick();$('quotation-close').click();const live=w.libraryProbe.documents[0],before=JSON.stringify(live),record=live.exact_excerpts[0];
  live.title='Current shelf title';const changed=JSON.stringify(live);$('open-library-notebook').click();await ready();
  const rows=[...$('notebook-captures').children];assert.equal(rows.length,3);
  for(const row of rows){
   assert.equal(row.dataset.documentKey,live.key);assert.ok(row.dataset.captureId);assert.ok(row.dataset.captureType);assert.equal(row.querySelectorAll('.notebook-preview').length,1);
   const details=row.querySelector('.notebook-details'),summary=details.firstElementChild,preview=row.querySelector('.notebook-preview'),technical=row.querySelector('.notebook-technical');
   assert.equal(details.open,false);assert.equal(technical.open,false);assert.match(technical.textContent,new RegExp(row.dataset.captureId));
   summary.focus();details.open=true;details.dispatchEvent(new w.Event('toggle'));assert.equal(w.document.activeElement,summary);assert.equal(preview.hidden,true);assert.equal(details.querySelectorAll('.notebook-quote').length,1);
   if(row.dataset.captureType==='exact-excerpt'){
    assert.equal(details.querySelector('.notebook-quote').textContent,record.text);assert.match(details.querySelector('.notebook-metadata').textContent,/Authored source/);assert.doesNotMatch(details.querySelector('.notebook-metadata').textContent,/Current shelf title/);
    const history=details.querySelector('.notebook-history');assert.equal(history.open,false);assert.equal(history.querySelector('.notebook-content'),null);
    history.firstElementChild.focus();details.open=false;details.dispatchEvent(new w.Event('toggle'));assert.equal(w.document.activeElement,summary);
   }else{details.open=false;details.dispatchEvent(new w.Event('toggle'));}
   assert.equal(preview.hidden,false);details.open=true;details.dispatchEvent(new w.Event('toggle'));assert.equal(details.querySelectorAll('.notebook-quote').length,1);assert.equal(details.querySelectorAll('.notebook-technical').length,1);
  }
  assert.notEqual(changed,before);assert.equal(JSON.stringify(live),changed);
 }finally{await w.happyDOM.close();}
});

test('compact notebook preview never truncates stored, expanded or exported source text',async()=>{
 const doc=fixture();doc.segments=[{id:'long',start:0,end:5,text:'x'.repeat(359)+'🌴 untouched ending'}];doc.notes={};doc.segments[0].saved_excerpt=true;const env=setup(doc),{w,$}=env;try{
  const live=w.libraryProbe.documents[0],before=JSON.stringify(live);$('open-library-notebook').click();await ready();const row=$('notebook-captures').firstElementChild,preview=row.querySelector('.notebook-preview');
  assert.equal(preview.textContent,'x'.repeat(359)+'…');const details=row.querySelector('.notebook-details');details.open=true;details.dispatchEvent(new w.Event('toggle'));assert.equal(row.querySelector('.notebook-quote').textContent,doc.segments[0].text);assert.ok(w.Coconut.notebookMarkdown(live).includes('🌴 untouched ending'));assert.equal(JSON.stringify(live),before);
 }finally{await w.happyDOM.close();}
});
