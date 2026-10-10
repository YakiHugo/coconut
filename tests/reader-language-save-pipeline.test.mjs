/** Real legacy adapter, deliberately delayed/failing receipts, and authored AI responses only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {translationReviewFixture} from './helpers/translation-review-fixture.mjs';
const root=new URL('../',import.meta.url),KEY='coconut-reader-v1';
const source=(count=1)=>({key:'source',title:'Receipt ownership fixture',language:'en',segments:Array.from({length:count},(_,i)=>({id:'cue-'+i,text:'Authored source sentence '+i+'.',start:i*3,end:i*3+3}))});
async function until(check,message='Expected asynchronous checkpoint'){
 for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,0));}
 assert.ok(check(),message);
}
function setup(doc=source(),{hold=0,fail=0}={}){
 const w=new Window({url:'http://127.0.0.1:8080/'}),$=id=>w.document.getElementById(id);
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});w.localStorage.setItem(KEY,JSON.stringify({documents:[doc]}));w.sessionStorage.setItem('coconut-reader-active-v1',doc.key);
 w.eval(['summary','core','passages','passage-playback','library-store'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
 const writes=[],requests=[];let release,failAt=fail,holdAt=hold;
 const create=w.CoconutLibraryStore.createLegacyAdapter;
 w.CoconutLibraryStore.createLegacyAdapter=options=>{
  const adapter=create(options);return {...adapter,async write(value,context){
   const index=writes.push(JSON.parse(value));if(index===holdAt)await new Promise(resolve=>release=resolve);
   if(index===failAt)return {ok:false,status:'failed',error:{code:'quota',message:'Injected quota rejection'}};
   return adapter.write(value,context);
  }};
 };
 w.fetch=async(url,options)=>{
  if(url.endsWith('language-tools'))return {ok:true,json:async()=>({local_translation:true,ai:{codex:{ready:true},claude:{ready:true}}})};
  const body=JSON.parse(options.body);requests.push({url,body});
  return {ok:true,json:async()=>url.endsWith('ask')?{answer:'Authored checkpoint answer',citations:[body.segments[0].id],provider:'fixture'}:{translations:body.segments.map(c=>({id:c.id,source_text:c.text,text:'Authored translation',provider:'fixture'}))}};
 };
 w.eval(['app','language','translation-review'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+`\nwindow.pipeline={doc:()=>active(),store:libraryStore,queue:queueDocument,commit:commitDocument,count:doc=>persistedAIAnswerCounts.get(doc)||0,asking:()=>asking,summary:()=>summaryScope,retire:retireLanguageOwners,render,replace(){const old=active(),doc={...old};state.documents[state.documents.indexOf(old)]=doc;return doc;}};`);
 return {w,$,writes,requests,release:()=>release?.(),failAt:value=>failAt=value,holdAt:value=>holdAt=value,disk:()=>JSON.parse(w.localStorage.getItem(KEY)).documents[0]};
}
async function ready(h,task='summary'){
 await h.$('check-ai').onclick();h.$('ai-task').value=task;h.$('ai-task').onchange();
 if(task==='question')h.$('ai-question').value='What is the authored source?';
 h.$('ai-consent').checked=true;
}
function input(h,id,text){h.$(id).value=text;h.$(id).dispatchEvent(new h.w.Event('input',{bubbles:true}));}

for(const [name,count,fail,calls] of [['plan',401,1,0],['in-flight marker',401,2,0],['batch result',401,3,1],['final answer',1,3,1]]){
 test(`summary ${name} failure stops at its own receipt without another model call`,async()=>{
  const h=setup(source(count),{fail});try{
   await ready(h);await h.$('ask-ai').onclick();
   assert.equal(h.requests.length,calls);assert.equal(h.writes.length,fail,'failed checkpoint is not retried behind the notice');
   assert.equal(h.w.pipeline.asking(),false);assert.equal(h.w.pipeline.summary(),null);assert.equal(h.$('ai-consent').checked,false);
   assert.match(h.$('ai-progress').textContent,/尚未保存|保存未成功|保存失败/);
   if(name==='final answer'){assert.equal(h.w.pipeline.doc().ai_answers.length,1);assert.equal(h.disk().ai_answers.length,0);assert.equal(h.w.pipeline.count(h.w.pipeline.doc()),0);}
  }finally{await h.w.happyDOM.close();}
 });
}

test('summary reserves one owner before a delayed plan receipt and cannot send early',async()=>{
 const h=setup(source(),{hold:1});let run;try{
  await ready(h);run=h.$('ask-ai').onclick();await until(()=>h.writes.length===1);
  const owner=h.w.pipeline.summary();assert.ok(owner);assert.equal(h.w.pipeline.asking(),true);assert.equal(h.requests.length,0);
  await h.$('ask-ai').onclick();assert.equal(h.w.pipeline.summary(),owner);assert.equal(h.writes.length,1);assert.equal(h.requests.length,0);
  h.release();await run;assert.equal(h.requests.length,1);assert.equal(h.w.pipeline.count(h.w.pipeline.doc()),1);
 }finally{h.release();await run;await h.w.happyDOM.close();}
});

for(const hold of [1,2,3])for(const change of ['consent','provider','source','task','panel','undelivered-toggle']){
 test(`${change} while summary checkpoint ${hold} waits never admits the next model request`,async()=>{
  const h=setup(source(401),{hold});let run;try{
   await ready(h);h.$('mode-transcript').click();h.$('language-panel').open=true;h.$('ai-consent').checked=true;run=h.$('ask-ai').onclick();await until(()=>h.writes.length===hold);
   if(change==='consent'){h.$('ai-consent').checked=false;h.$('ai-consent').onchange();}
   if(change==='provider'){h.$('ai-provider').value='claude';h.$('ai-provider').onchange();h.$('ai-provider').value='codex';h.$('ai-provider').onchange();}
   if(change==='source'){h.w.pipeline.doc().segments[0].text+=' changed';h.w.pipeline.queue(h.w.pipeline.doc());}
   if(change==='task'){h.$('ai-task').value='question';h.$('ai-task').onchange();h.$('ai-task').value='summary';h.$('ai-task').onchange();}
   if(change==='undelivered-toggle'){h.$('language-panel').addEventListener('toggle',event=>event.stopImmediatePropagation(),{capture:true});h.$('language-panel').open=false;}
   if(change==='panel'){h.$('language-panel').open=false;h.$('language-panel').dispatchEvent(new h.w.Event('toggle'));h.$('language-panel').open=true;}
   h.$('ai-consent').checked=true;h.release();await run;
   assert.equal(h.requests.length,hold===3?1:0);assert.equal(h.w.pipeline.asking(),false);assert.equal(h.w.pipeline.summary(),null);
  }finally{h.release();await run;await h.w.happyDOM.close();}
 });
}

for(const mode of ['subscription','offline'])test(`${mode} waits for its translation receipt and preserves a revoked stop across rechecking`,async()=>{
 const h=setup(source(65),{hold:1});let run;try{
  await ready(h,'translation');run=h.$(mode==='subscription'?'subscription-translate':'translate-document').onclick();await until(()=>h.writes.length===1);
  assert.equal(h.requests.length,1);h.$('ai-consent').checked=false;h.$('ai-consent').onchange();h.$('ai-consent').checked=true;
  h.release();await run;assert.equal(h.requests.length,1);assert.equal(h.disk().segments.filter(c=>c.translations?.zh).length,32);
 }finally{h.release();await run;await h.w.happyDOM.close();}
});

test('a delayed answer receipt acknowledges only its captured count, and a replacement starts without saved evidence',async()=>{
 const h=setup(source(),{hold:1});let run;try{
  await ready(h,'question');run=h.$('ask-ai').onclick();await until(()=>h.writes.length===1);
  const doc=h.w.pipeline.doc();assert.equal(doc.ai_answers.length,1);assert.equal(h.w.pipeline.count(doc),0);
  doc.ai_answers.push({...doc.ai_answers[0],answer:'A newer in-page answer'});h.w.pipeline.queue(doc);h.holdAt(2);
  h.release();await run;assert.equal(h.w.pipeline.count(doc),1);assert.equal(h.disk().ai_answers.length,1);assert.equal(doc.ai_answers.length,2);
  const replacement=h.w.pipeline.replace();assert.equal(h.w.pipeline.count(replacement),0);assert.notEqual(doc,replacement);
 }finally{h.release();await run;await h.w.happyDOM.close();}
});

test('retired summary owner cannot clear or mutate a newer owner when its receipt arrives',async()=>{
 const h=setup(source(),{hold:1});let oldRun,newRun;try{
  await ready(h);oldRun=h.$('ask-ai').onclick();await until(()=>h.writes.length===1);const oldOwner=h.w.pipeline.summary();
  h.w.pipeline.retire();assert.equal(oldOwner.retired,true);await ready(h);newRun=h.$('ask-ai').onclick();const newOwner=h.w.pipeline.summary();assert.notEqual(newOwner,oldOwner);
  h.release();await oldRun;assert.equal(h.w.pipeline.summary(),newOwner,'old finally leaves the new task busy');await newRun;
  assert.equal(h.requests.length,1);assert.equal(h.w.pipeline.doc().ai_answers.length,1);
 }finally{h.release();await oldRun;await newRun;await h.w.happyDOM.close();}
});

test('glossary receipt keeps a newer draft and does not move its focus',async()=>{
 const h=setup(source(),{hold:1});let run;try{
  input(h,'translation-glossary','source = 原文');run=h.$('save-translation-glossary').onclick();await until(()=>h.writes.length===1);
  input(h,'translation-glossary','source = 新草稿');h.$('translation-glossary').focus();h.release();await run;
  assert.equal(h.$('translation-glossary').value,'source = 新草稿');assert.equal(h.w.document.activeElement,h.$('translation-glossary'));
  assert.equal(h.disk().translation_glossary.zh[0].target,'原文');assert.doesNotMatch(h.$('notice').textContent,/术语表已保存/);
 }finally{h.release();await run;await h.w.happyDOM.close();}
});

test('manual-review receipt keeps newer typing in the same editor with the submitted revision on disk',async()=>{
 const doc={...translationReviewFixture(4),key:'review'};doc.translation_view='zh';const h=setup(doc,{hold:1});let run;try{
  h.w.CoconutTranslationReview.openEditor('review','review-1','zh');input(h,'translation-edit-text','Submitted manual revision');
  run=h.$('save-translation-edit').onclick(new h.w.Event('click'));await until(()=>h.writes.length===1);
  assert.equal(h.$('translation-edit-dialog').open,true);input(h,'translation-edit-text','A newer unsubmitted draft');h.$('translation-edit-text').focus();
  h.release();await run;assert.equal(h.$('translation-edit-dialog').open,true);assert.equal(h.$('translation-edit-text').value,'A newer unsubmitted draft');
  assert.equal(h.w.document.activeElement,h.$('translation-edit-text'));assert.equal(h.disk().segments[1].translations.zh.text,'Submitted manual revision');assert.equal(h.w.CoconutTranslationReview.hasDraft(),true);
  assert.match(h.$('translation-edit-error').textContent,/当前新修改仍是未提交草稿/);
 }finally{h.release();await run;await h.w.happyDOM.close();}
});

for(const mode of ['summary','question','subscription','offline','glossary','view','restart','manual'])test(`${mode} ingress is blocked before any mutation during a lifecycle barrier`,async()=>{
 const doc=mode==='manual'?{...translationReviewFixture(4),key:'source',translation_view:'zh'}:source();const h=setup(doc);try{
  await ready(h,['subscription','offline'].includes(mode)?'translation':mode==='question'?'question':'summary');
  if(mode==='manual'){h.w.CoconutTranslationReview.openEditor('source','review-1','zh');input(h,'translation-edit-text','Blocked manual draft');}
  if(mode==='glossary')input(h,'translation-glossary','source = 不得提交');
  const before=JSON.stringify(h.w.pipeline.doc()),token=h.w.pipeline.store.acquireBarrier('test-ingress');assert.ok(token);
  if(['summary','question'].includes(mode))await h.$('ask-ai').onclick();
  if(mode==='subscription')await h.$('subscription-translate').onclick();
  if(mode==='offline')await h.$('translate-document').onclick();
  if(mode==='glossary')await h.$('save-translation-glossary').onclick();
  if(mode==='view'){h.$('translation-view').value='zh';h.$('translation-view').onchange();}
  if(mode==='restart')await h.$('restart-summary').onclick();
  if(mode==='manual')await h.$('save-translation-edit').onclick(new h.w.Event('click'));
  assert.equal(JSON.stringify(h.w.pipeline.doc()),before);assert.equal(h.requests.length,0);assert.equal(h.writes.length,0);
  h.w.pipeline.store.releaseBarrier(token);
 }finally{await h.w.happyDOM.close();}
});

test('retiring an unrelated key does not revoke another document task or consent',async()=>{
 const h=setup(source(),{hold:1});let run;try{
  await ready(h);run=h.$('ask-ai').onclick();await until(()=>h.writes.length===1);const owner=h.w.pipeline.summary();
  h.w.pipeline.retire('another-key');assert.equal(h.w.pipeline.summary(),owner);assert.equal(owner.retired,false);assert.equal(h.$('ai-consent').checked,true);
  h.release();await run;assert.equal(h.requests.length,1);assert.equal(h.disk().ai_answers.length,1);
 }finally{h.release();await run;await h.w.happyDOM.close();}
});

test('a receipt updates history evidence in place without replacing a focused answer action',async()=>{
 const doc=source();doc.ai_answers=[{question:'Earlier question',purpose:'question',answer:'Earlier answer',provider:'fixture',citations:['cue-0'],input_snapshot:{version:1,segments:[{id:'cue-0',text:doc.segments[0].text}]}}];
 const h=setup(doc,{hold:1});let receipt;try{
  h.$('browse-ai-history').click();const button=h.$('ai-answers').querySelector('button');button.focus();
  h.w.pipeline.doc().notes['cue-0']='A queued note';receipt=h.w.pipeline.commit(h.w.pipeline.doc());await until(()=>h.writes.length===1);
  h.release();await receipt;assert.equal(h.w.document.activeElement,button);assert.equal(h.$('ai-answers').querySelector('button'),button);assert.match(h.$('ai-history-storage').textContent,/1 则均已保存/);
 }finally{h.release();await receipt;await h.w.happyDOM.close();}
});

test('failed removal retires a pending summary before rollback and never revives its old owner',async()=>{
 const h=setup(source(),{hold:1,fail:2});let run,removal;try{
  await ready(h);run=h.$('ask-ai').onclick();await until(()=>h.writes.length===1);const doc=h.w.pipeline.doc(),owner=h.w.pipeline.summary();
  h.w.document.querySelector('.library-remove').click();removal=h.$('confirm-removal').onclick();
  assert.equal(owner.retired,true);assert.equal(h.w.pipeline.summary(),null);assert.equal(h.requests.length,0);
  h.release();await removal;await run;
  assert.equal(h.w.pipeline.doc(),doc);assert.equal(h.requests.length,0);assert.equal(h.w.pipeline.summary(),null);assert.match(h.$('notice').textContent,/移除未保存/);
  h.failAt(0);await ready(h);await h.$('ask-ai').onclick();assert.equal(h.requests.length,1,'a new explicitly consented owner may resume the retained plan');
 }finally{h.release();await removal;await run;await h.w.happyDOM.close();}
});

test('an older manual receipt does not close a newer submission in the same editor',async()=>{
 const doc={...translationReviewFixture(4),key:'review',translation_view:'zh'},h=setup(doc,{hold:1});let first,second;try{
  h.w.CoconutTranslationReview.openEditor('review','review-1','zh');input(h,'translation-edit-text','First submission');first=h.$('save-translation-edit').onclick(new h.w.Event('click'));await until(()=>h.writes.length===1);
  input(h,'translation-edit-text','Second submission');second=h.$('save-translation-edit').onclick(new h.w.Event('click'));h.holdAt(2);h.release();await first;await until(()=>h.writes.length===2);
  assert.equal(h.$('translation-edit-dialog').open,true);assert.equal(h.$('translation-edit-text').value,'Second submission');assert.equal(h.disk().segments[1].translations.zh.text,'First submission');
  h.release();await second;assert.equal(h.disk().segments[1].translations.zh.text,'Second submission');assert.equal(h.$('translation-edit-dialog').open,false);
 }finally{h.release();await first;await second;await h.w.happyDOM.close();}
});

test('manual source drift during a receipt keeps the editor and never claims current reviewed evidence',async()=>{
 const doc={...translationReviewFixture(4),key:'review',translation_view:'zh'},h=setup(doc,{hold:1});let run;try{
  h.w.CoconutTranslationReview.openEditor('review','review-1','zh');input(h,'translation-edit-text','Submitted text');run=h.$('save-translation-edit').onclick(new h.w.Event('click'));await until(()=>h.writes.length===1);
  h.w.pipeline.doc().segments[1].text+=' New source';h.w.pipeline.queue(h.w.pipeline.doc());h.release();await run;
  assert.equal(h.$('translation-edit-dialog').open,true);assert.equal(h.$('translation-edit-text').value,'Submitted text');assert.match(h.$('translation-edit-error').textContent,/又有变化/);assert.doesNotMatch(h.$('notice').textContent,/已保存为用户人工核对/);
 }finally{h.release();await run;await h.w.happyDOM.close();}
});
