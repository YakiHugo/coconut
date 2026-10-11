import test from 'node:test';
import assert from 'node:assert/strict';
import C from '../reader/core.js';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {settle} from './helpers/save-pipeline.mjs';
const makeDoc=(count=12,key='owner')=>({key,title:'Authored source '+key,language:'en',translation_view:'de',readingPosition:'cue-2',segments:Array.from({length:count},(_,i)=>({id:'cue-'+i,text:'Original sentence '+i,start:i*2,end:i*2+2,translations:{}})),notes:{}});
function translate(doc,index,language,text,extra={}){const cue=doc.segments[index];cue.translations[language]={text,source_text:cue.text,source_language:'en',document_language:'en',provider:'Authored fixture',...extra};}
function control(docs){const tasks=[];let changes=0;const search=C.createLibrarySearch({getDocuments:()=>docs,schedule:fn=>tasks.push(fn),now:()=>0,workSize:1,onChange:()=>changes++});return {search,step:()=>tasks.shift()(),get changes(){return changes;},get pending(){return tasks.length;},drain(){let guard=100000;while(tasks.length){assert.ok(guard-->0);tasks.shift()();}}};}
const searchShelf=($,query)=>{$('library-scope').value='translations';$('library-search').value=query;$('library-search').oninput();};
const group=(w,language)=>w.document.querySelector(`.library-translation-group[data-language="${language}"]`);

test('translation scope searches every current language, not source, title, notes, view or historical evidence',()=>{
 const doc=makeDoc();doc.title='needle title';doc.notes['cue-0']='needle note';doc.segments[0].text='needle source';
 translate(doc,1,'zh','needle 中文 needle');translate(doc,1,'fr','needle français');translate(doc,3,'ja','needle 日本語');translate(doc,4,'zh','stale needle',{source_text:'obsolete'});
 translate(doc,5,'ko','context needle',{provider:'claude_subscription_translation'});
 const c=control([doc]);const job=c.search.request('needle','all','translations');c.drain();
 assert.deepEqual(job.docs,[doc]);const groups=job.translationHits.get(doc);assert.deepEqual(groups.map(g=>g.language),['zh','fr','ja']);assert.deepEqual(groups.map(g=>g.hits.length),[1,1,1]);
 assert.equal(groups[0].hits[0].source,'Original sentence 1');assert.equal(groups[0].hits[0].time,2);assert.equal(C.libraryHits(doc,'needle','translations').length,0);
 assert.equal(C.libraryMatches(doc,'title','all','translations'),false);assert.equal(C.libraryMatches(doc,'note','all','translations'),false);assert.equal(C.libraryMatches(doc,'source','all','translations'),false);
 assert.equal(C.libraryMatches(doc,'','all','translations'),true);assert.equal(C.libraryMatches(doc,'needle','audio','translations'),false);assert.equal(C.libraryMatches(doc,'needle','annotated','translations'),true);
 assert.equal(C.libraryMatches(doc,'中文','all','text'),false);doc.translation_view='ja';assert.equal(c.search.request('needle','all','translations'),job);
});

test('Unicode cross-cue phrases keep source time and language ownership; missing/stale/context boundaries break phrases',()=>{
 const doc=makeDoc();translate(doc,0,'zh','中文');translate(doc,1,'zh','短语');translate(doc,2,'fr','İ😀 bonjour');translate(doc,3,'fr','monde');
 const context=[0,1].map(position=>{const s=doc.segments[position];return {id:s.id,text:s.text,start:s.start,end:s.end,position,speaker:null};});
 doc.translation_contexts={pair:context};for(const index of [0,1])Object.assign(doc.segments[index].translations.zh,{context_id:'pair',target_language:'zh',glossary_snapshot:[]});
 const c=control([doc]);let job=c.search.request('中文短语','all','translations');c.drain();let hit=job.translationHits.get(doc)[0].hits[0];assert.equal(hit.id,'cue-0');assert.equal(hit.lastId,'cue-1');assert.equal(hit.cueCount,2);assert.equal(hit.snippet.match,'中文短语');
 job=c.search.request('i̇😀 bonjour monde','all','translations');c.drain();assert.equal(job.translationHits.get(doc)[0].hits[0].snippet.match,'İ😀 bonjour monde');
 doc.segments[0].text='Corrected';C.invalidateSearch(doc);assert.equal(C.libraryTranslationHitCurrent(hit,[doc]),false);job=c.search.request('中文短语','all','translations');c.drain();assert.deepEqual(job.docs,[]);
 doc.segments[0].text=context[0].text;C.invalidateSearch(doc);doc.translation_contexts={pair:context.map(c=>({...c,text:'obsolete context'}))};job=c.search.request('中文短语','all','translations');c.drain();assert.deepEqual(job.docs,[]);
 delete doc.segments[3].translations.fr;C.invalidateSearch(doc);assert.equal(C.libraryMatches(doc,'bonjour monde','all','translations'),false);
});

test('cooperative translation selection publishes complete groups, handles giant single fields and retains warm pages',()=>{
 const doc=makeDoc(6000);for(let i=0;i<6000;i++)translate(doc,i,'zh','命中 '+i);let reads=0;
 for(const s of doc.segments){const value=s.translations.zh.text;Object.defineProperty(s.translations.zh,'text',{get(){reads++;return value;}});}
 const c=control([doc]),job=c.search.request('命中','all','translations');assert.equal(job.pending,true);assert.equal(reads,0);
 let slices=0;while(c.pending){const before=reads;c.step();assert.ok(reads-before<=256);if(job.pending){assert.equal(job.translationHits.size,0);assert.equal(job.docs.length,0);}slices++;}
 assert.ok(slices>50);assert.equal(job.translationHits.get(doc)[0].hits.length,6000);assert.equal(job.translationHits.get(doc)[0].positions.get('cue-5999'),5999);const before=reads;assert.equal(c.search.request('命中','all','translations'),job);assert.equal(reads,before);
 const giant=makeDoc(1);translate(giant,0,'fr','x'.repeat(70000)+' needle');const big=control([giant]),pending=big.search.request('needle','all','translations');assert.equal(pending.pending,true);assert.equal(pending.scanned,0);big.drain();assert.deepEqual(pending.docs,[giant]);
});

test('cancel, replacement query, source/context/glossary and owner changes reject late work and retained hits',()=>{
 for(const action of ['cancel','query','source','contexts','glossary','owner']){
  const doc=makeDoc(5000);translate(doc,4999,'fr','needle');const docs=[doc],c=control(docs),old=c.search.request('needle','all','translations');c.step();assert.equal(old.pending,true);
  if(action==='cancel')c.search.cancel();if(action==='query')c.search.request('missing','all','translations');if(action==='source'){doc.segments[4999].text='changed';C.invalidateSearch(doc);}if(action==='contexts')doc.translation_contexts={};if(action==='glossary')doc.translation_glossary={};if(action==='owner')docs[0]={...doc};
  c.drain();assert.equal(old.docs.length,0);assert.equal(old.translationHits.size,0);assert.equal(c.search.isCurrent(old),false);
 }
 const doc=makeDoc();translate(doc,2,'zh','needle');const c=control([doc]),job=c.search.request('needle','all','translations'),hit=job.translationHits.get(doc)[0].hits[0];assert.equal(C.libraryTranslationHitCurrent(hit,[doc]),true);assert.equal(C.libraryTranslationHitCurrent(hit,[{...doc}]),false);
 doc.segments[2]={...doc.segments[2]};assert.equal(C.libraryTranslationHitCurrent(hit,[doc]),false);
});

test('language-specific paging opens the exact bilingual cue without changing reading position, including shelf pagination',async()=>{
 const docs=Array.from({length:45},(_,i)=>makeDoc(125,'doc-'+i));for(const doc of docs){translate(doc,2,'zh','needle 中文');translate(doc,110,'zh','needle 后一处');translate(doc,2,'fr','needle français');}
 const h=libraryHarness(docs,{probe:true}),{w,$}=h;let plays=0;w.HTMLMediaElement.prototype.play=function(){plays++;return Promise.resolve();};
 try{
  searchShelf($,'needle');for(let i=0;i<200&&$('library').hidden;i++)await new Promise(r=>setTimeout(r,2));assert.equal($('library').children.length,40);assert.match($('library-page-status').textContent,/45/);$('library-next').click();assert.equal($('library').children.length,5);
  let region=group(w,'zh');assert.equal(region.querySelectorAll('.library-translation-hit').length,1);region.querySelector('.library-translation-next').click();assert.equal(region.querySelector('.library-translation-hit').dataset.hitId,'cue-110');assert.equal(w.document.activeElement,region.querySelector('.library-translation-hit'));
  w.libraryProbe.renderLibrary();region=group(w,'zh');assert.equal(region.querySelector('.library-translation-hit').dataset.hitId,'cue-110');assert.ok(group(w,'fr'));const key=region.closest('.library-entry').dataset.documentKey;
  region.querySelector('.library-translation-hit').click();const doc=w.libraryProbe.documents.find(d=>d.key===key);assert.equal(doc.translation_view,'zh');assert.equal(doc.readingPosition,'cue-2');assert.equal(w.document.activeElement.dataset.segmentId,'cue-110');assert.match(w.document.activeElement.querySelector('.translation').textContent,/后一处/);assert.match(w.document.activeElement.querySelector('.words').textContent,/Original sentence 110/);assert.equal($('search').value,'');assert.equal($('library-scope').value,'translations');assert.equal(plays,0);assert.ok($('transcript').querySelectorAll('.segment').length<=100);
  await w.flushContentForTest();await settle();const saved=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents.find(d=>d.key===key);assert.equal(saved.readingPosition,'cue-2');assert.equal(saved.translation_view,'zh');
 }finally{await w.happyDOM.close();}
});

test('old query buttons and replaced owner or translation evidence never navigate',async()=>{
 for(const action of ['query','owner','translation','source']){
  const doc=makeDoc();translate(doc,7,'zh','needle 中文');const h=libraryHarness([doc],{probe:true}),{w,$}=h;
  try{searchShelf($,'needle');const button=group(w,'zh').querySelector('.library-translation-hit'),live=w.libraryProbe.documents[0];
   if(action==='query')searchShelf($,'absent');if(action==='owner')w.libraryProbe.documents[0]={...live};if(action==='translation')live.segments[7].translations.zh={...live.segments[7].translations.zh,text:'different'};if(action==='source'){live.segments[7].text='Corrected';w.Coconut.invalidateSearch(live);}
   const focus=w.document.activeElement;button.click();assert.match($('notice').textContent,/已变动/);assert.equal(live.translation_view,'de');assert.equal(live.readingPosition,'cue-2');assert.notEqual(w.document.activeElement.dataset.segmentId,'cue-7');
  }finally{await w.happyDOM.close();}
 }
});


test('an oversized translated cue reveals its exact Unicode match, retained through receipt renders',async()=>{
 const doc=makeDoc();translate(doc,4,'fr','Préface '.repeat(600)+'İ😀 needle fin');const h=libraryHarness([doc],{probe:true}),{w,$}=h,scrolls=[];
 w.HTMLElement.prototype.scrollIntoView=function(){scrolls.push({tag:this.tagName,text:this.textContent});};
 try{searchShelf($,'i̇😀 needle');group(w,'fr').querySelector('.library-translation-hit').click();assert.equal(w.document.activeElement.dataset.segmentId,'cue-4');assert.equal(w.document.activeElement.querySelector('.translation mark').textContent,'İ😀 needle');assert.equal(scrolls.at(-1).tag,'MARK');assert.equal(scrolls.at(-1).text,'İ😀 needle');w.libraryProbe.render();assert.equal(w.document.querySelector('.translation mark').textContent,'İ😀 needle');assert.equal(w.libraryProbe.documents[0].readingPosition,'cue-2');}finally{await w.happyDOM.close();}
});


function validHit(hit,documents){const iterator=C.libraryTranslationHitCurrentSteps(hit,documents);let result;do{result=iterator.next();}while(!result.done);return result.value;}
test('final activation checks every shared phrase contributor and frozen translated text without quadratic evidence copies',()=>{
 for(const mutation of ['firstText','secondText','secondItem','secondSource','secondTime','secondSpeaker','ownerKey']){
  const doc=makeDoc();translate(doc,0,'fr','bonjour');translate(doc,1,'fr','monde');const c=control([doc]),job=c.search.request('bonjour monde','all','translations'),hit=job.translationHits.get(doc)[0].hits[0];assert.equal(validHit(hit,[doc]),true);
  if(mutation==='firstText')doc.segments[0].translations.fr.text='different';if(mutation==='secondText')doc.segments[1].translations.fr.text='different';if(mutation==='secondItem')doc.segments[1].translations.fr={...doc.segments[1].translations.fr};if(mutation==='secondSource')doc.segments[1].text='corrected';if(mutation==='secondTime')doc.segments[1].start+=0.1;if(mutation==='secondSpeaker')doc.segments[1].speaker='Another';if(mutation==='ownerKey')doc.key='another';assert.equal(validHit(hit,[doc]),false,mutation);
 }
 const doc=makeDoc(1000);for(let i=0;i<1000;i++)translate(doc,i,'fr','a');const c=control([doc]),job=c.search.request(Array(501).fill('a').join(' '),'all','translations');c.drain();const hits=job.translationHits.get(doc)[0].hits;assert.equal(hits.length,500);const check=C.libraryTranslationHitCurrentSteps(hits[0],[doc]);assert.equal(check.next().done,false);check.return();
});

test('stale cross-cue activation refreshes actual results and a long verification yields to newer navigation',async()=>{
 const doc=makeDoc(600);for(let i=0;i<600;i++)translate(doc,i,'fr','a');translate(doc,0,'zh','中文');translate(doc,1,'zh','短语');const h=libraryHarness([doc],{probe:true}),{w,$}=h;
 try{
  searchShelf($,'中文短语');const stale=group(w,'zh').querySelector('.library-translation-hit');w.libraryProbe.documents[0].segments[1].translations.zh.text='已改';stale.click();assert.match($('notice').textContent,/已变动/);assert.equal(group(w,'zh'),null);assert.equal(w.libraryProbe.documents[0].translation_view,'de');
  searchShelf($,Array(501).fill('a').join(' '));const pending=group(w,'fr').querySelector('.library-translation-hit');pending.click();$('mode-summary').click();await new Promise(r=>setTimeout(r,20));assert.equal(w.document.body.dataset.readingMode,'summary');assert.equal(w.libraryProbe.documents[0].translation_view,'de');assert.equal(w.libraryProbe.documents[0].readingPosition,'cue-2');
 }finally{await w.happyDOM.close();}
});


test('paging a long pending activation cannot navigate to the previously displayed hit',async()=>{
 const doc=makeDoc(600);for(let i=0;i<600;i++)translate(doc,i,'fr','a');const h=libraryHarness([doc],{probe:true}),{w,$}=h;
 try{searchShelf($,Array(501).fill('a').join(' '));const region=group(w,'fr'),button=region.querySelector('.library-translation-hit');button.focus();button.click();region.querySelector('.library-translation-next').click();assert.equal(button.dataset.hitId,'cue-1');await new Promise(r=>setTimeout(r,20));assert.equal(w.libraryProbe.documents[0].translation_view,'de');assert.equal(w.document.activeElement,button);assert.equal(w.libraryProbe.documents[0].readingPosition,'cue-2');}finally{await w.happyDOM.close();}
});

for(const direction of ['down','up','end','down-tight','up-tight'])test(`translation keyboard ring survives native scroll quantization at a fractional ${direction} clip edge`,async()=>{
 const doc=makeDoc();translate(doc,1,'de','needle Schild');const h=libraryHarness([doc],{probe:true}),{w,$}=h,frames=[],scrolls=[],globalScrolls=[];
 w.happyDOM.setViewport({width:1360,height:1000});w.requestAnimationFrame=fn=>{frames.push(fn);return frames.length;};w.scrollBy=options=>globalScrolls.push(options);w.scrollTo=options=>globalScrolls.push(options);
 try{
  searchShelf($,'needle');const button=group(w,'de').querySelector('.library-translation-hit'),host=$('library-search-results'),initialTop=100;
  host.scrollTop=initialTop;button.style.outline='2px solid black';button.style.outlineOffset='2px';
  Object.defineProperty(host,'clientHeight',{configurable:true,get:()=>729});Object.defineProperty(host,'clientTop',{configurable:true,get:()=>0});
  Object.defineProperty(host,'scrollHeight',{configurable:true,get:()=>Math.round((direction==='end'?829:1500)+(parseFloat(host.style.getPropertyValue('--library-keyboard-space'))||0))});
  host.getBoundingClientRect=()=>({left:14,right:209,top:181.59375,bottom:910.59375,width:195,height:729});
  // Exact bottom edge from failed real Chromium desktop-de geometry. The
  // reverse case mirrors its 1/32px overlap; the native mock quantizes offsets.
  const top=direction.startsWith('up')?185.5625:direction==='down-tight'?186.875:779.28125,bottom=direction==='up-tight'?905.3125:direction==='up'?312.90625:906.625;
  button.getBoundingClientRect=()=>({left:25,right:198,top:top-(host.scrollTop-initialTop),bottom:bottom-(host.scrollTop-initialTop),width:173,height:bottom-top});
  $('reading-feedback').hidden=true;$('media-dock').hidden=true;
  host.scrollTo=options=>{scrolls.push(options);host.scrollTop=Math.round(Math.min(host.scrollHeight-host.clientHeight,Math.max(0,options.top)));};
  const before=JSON.stringify(w.libraryProbe.documents);$('title').focus();w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',shiftKey:direction.startsWith('up'),bubbles:true}));button.focus();frames.splice(0).forEach(fn=>fn());
  const rect=button.getBoundingClientRect(),area=host.getBoundingClientRect();
  assert.ok(rect.top-4>=area.top&&rect.bottom+4<=area.bottom,'entire ring is inside the actual clip with zero tolerance');
  assert.equal(scrolls.length,1);assert.equal(Number.isInteger(scrolls[0].top),true);assert.equal(globalScrolls.length,0);assert.equal(w.document.activeElement,button);assert.equal(JSON.stringify(w.libraryProbe.documents),before);
  if(direction==='end')assert.equal(parseFloat(host.style.getPropertyValue('--library-keyboard-space')),2);
 }finally{await w.happyDOM.close();}
});


test('compact translation counts preserve complete accessible language and position on every page',async()=>{
 const doc=makeDoc();translate(doc,1,'zh','needle 中文');translate(doc,5,'zh','needle 后文');const h=libraryHarness([doc]),{w,$}=h;
 try{searchShelf($,'needle');const region=group(w,'zh'),status=region.querySelector('.library-translation-status');assert.equal(status.textContent,'第 1 / 2 处');assert.equal(status.getAttribute('aria-label'),'中文译文：第 1 / 2 个匹配片段');region.querySelector('.library-translation-next').click();assert.equal(status.textContent,'第 2 / 2 处');assert.equal(status.getAttribute('aria-label'),'中文译文：第 2 / 2 个匹配片段');assert.match($('search-help').textContent,/跨篇译文请用书架的「译文」范围/);assert.doesNotMatch($('search-help').textContent,/不包含译文/);}finally{await w.happyDOM.close();}
});
