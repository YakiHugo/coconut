// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import C from '../reader/core.js';

const makeDoc=(count=12,key='owner')=>({key,title:'Authored source '+key,language:'en',translation_view:'de',readingPosition:'cue-2',segments:Array.from({length:count},(_,i)=>({id:'cue-'+i,text:'Original sentence '+i,start:i*2,end:i*2+2,translations:{}})),notes:{}});

function translate(doc,index,language,text,extra={}){const cue=doc.segments[index];cue.translations[language]={text,source_text:cue.text,source_language:'en',document_language:'en',provider:'Authored fixture',...extra};}

function control(docs){const tasks=[];let changes=0;const search=C.createLibrarySearch({getDocuments:()=>docs,schedule:fn=>tasks.push(fn),now:()=>0,workSize:1,onChange:()=>changes++});return {search,step:()=>tasks.shift()(),get changes(){return changes;},get pending(){return tasks.length;},drain(){let guard=100000;while(tasks.length){assert.ok(guard-->0);tasks.shift()();}}};}

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

function validHit(hit,documents){const iterator=C.libraryTranslationHitCurrentSteps(hit,documents);let result;do{result=iterator.next();}while(!result.done);return result.value;}

test('final activation checks every shared phrase contributor and frozen translated text without quadratic evidence copies',()=>{
 for(const mutation of ['firstText','secondText','secondItem','secondSource','secondTime','secondSpeaker','ownerKey']){
  const doc=makeDoc();translate(doc,0,'fr','bonjour');translate(doc,1,'fr','monde');const c=control([doc]),job=c.search.request('bonjour monde','all','translations'),hit=job.translationHits.get(doc)[0].hits[0];assert.equal(validHit(hit,[doc]),true);
  if(mutation==='firstText')doc.segments[0].translations.fr.text='different';if(mutation==='secondText')doc.segments[1].translations.fr.text='different';if(mutation==='secondItem')doc.segments[1].translations.fr={...doc.segments[1].translations.fr};if(mutation==='secondSource')doc.segments[1].text='corrected';if(mutation==='secondTime')doc.segments[1].start+=0.1;if(mutation==='secondSpeaker')doc.segments[1].speaker='Another';if(mutation==='ownerKey')doc.key='another';assert.equal(validHit(hit,[doc]),false,mutation);
 }
 const doc=makeDoc(1000);for(let i=0;i<1000;i++)translate(doc,i,'fr','a');const c=control([doc]),job=c.search.request(Array(501).fill('a').join(' '),'all','translations');c.drain();const hits=job.translationHits.get(doc)[0].hits;assert.equal(hits.length,500);const check=C.libraryTranslationHitCurrentSteps(hits[0],[doc]);assert.equal(check.next().done,false);check.return();
});
