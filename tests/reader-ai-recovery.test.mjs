/** Authored source and injected responses only: lifecycle evidence, not model-quality evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url);
const KEY='coconut-reader-v1';
const fixture=(title='A field guide to careful reading',count=65)=>({title,language:'en',notes:{'cue-0':'A private note that is never model input.'},segments:Array.from({length:count},(_,i)=>({id:'cue-'+i,start:i*4,end:i*4+4,text:`Observation ${i+1}: check the original statement before accepting an interpretation.`}))});
function setup(stored){
 const w=new Window({url:'http://127.0.0.1:8080/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});if(stored)w.localStorage.setItem(KEY,stored);
 w.fetch=async()=>{throw new Error('No automatic request is allowed in this fixture');};
 w.eval(['summary','core','passages','passage-playback','app','language'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
 return {w,$:id=>w.document.getElementById(id)};
}
async function importDocument(w,doc){
 const input=w.document.getElementById('file'),text=JSON.stringify(doc);
 Object.defineProperty(input,'files',{configurable:true,value:[{name:'authored.json',size:text.length,text:async()=>text}]});await input.onchange();
}
const storedDocument=(w,title='A field guide to careful reading')=>JSON.parse(w.localStorage.getItem(KEY)).documents.find(d=>d.title===title);
const translated=doc=>doc.segments.filter(cue=>cue.translations?.zh);
function translationResponse(request){return {ok:true,json:async()=>({translations:request.segments.map(cue=>({id:cue.id,source_text:cue.text,text:'仅供流程测试的预置译文。',provider:'injected-test-fixture'}))})};}
function injectedTranslation(w,{hold=1,fail=0}={}){
 const task=w.document.getElementById('ai-task');task.value='translation';task.onchange();
 const requests=[];let release;
 w.fetch=async(url,options)=>{
  if(url.endsWith('language-tools'))return {ok:true,json:async()=>({local_translation:true,ai:{codex:{ready:true},claude:{ready:true}}})};
  assert.match(url,/api\/translate(?:-subscription)?$/);
  const request=JSON.parse(options.body);requests.push(request);assert.ok(!JSON.stringify(request).includes('A private note'));
  if(requests.length===hold)await new Promise(resolve=>{release=resolve;});
  if(requests.length===fail)throw new Error('Injected network rejection');
  return translationResponse(request);
 };
 return {requests,release:()=>release?.()};
}
async function prepareTranslation(w,$,demo=false){const doc=fixture();if(demo)doc.provenance={kind:'authored_demo'};await importDocument(w,doc);$('mode-transcript').click();if(demo)$('toggle-demo-tools').click();$('language-panel').open=true;await $('check-ai').onclick();$('ai-consent').checked=true;}
async function leave(w,$,reason){
 if(reason==='pagehide')w.dispatchEvent(new w.Event('pagehide'));
 if(reason==='close-panel'){$('language-panel').open=false;$('language-panel').dispatchEvent(new w.Event('toggle'));$('language-panel').open=true;}
 if(reason==='demo-tools'){$('toggle-demo-tools').click();$('toggle-demo-tools').click();}
 if(reason==='undelivered-toggle'){$('language-panel').addEventListener('toggle',event=>event.stopImmediatePropagation(),{capture:true});$('language-panel').open=false;}
 if(reason==='add-workspace'){$('add-content').click();$('back-reading').click();}
 if(reason==='passages-tab'){$('mode-passages').click();$('mode-transcript').click();$('language-panel').open=true;}
 if(reason==='summary-tab'){$('mode-summary').click();$('mode-transcript').click();}
 if(reason==='other-document')await importDocument(w,fixture('An unrelated second episode',1));
 if(reason==='consent-revoked'){$('ai-consent').checked=false;$('ai-consent').dispatchEvent(new w.Event('change'));}
 // A newly checked shared control must never resurrect the canceled old plan.
 $('ai-consent').checked=true;
}

for(const mode of ['subscription','offline'])for(const reason of ['pagehide','close-panel','demo-tools','undelivered-toggle','add-workspace','summary-tab','passages-tab','other-document',...(mode==='subscription'?['consent-revoked']:[])]){
 test(`${mode} translation stops after its current batch on ${reason}, even after reopening`,async()=>{
  const {w,$}=setup();let mock;
  try{
   mock=injectedTranslation(w);await prepareTranslation(w,$,reason==='demo-tools');
   const run=$(mode==='subscription'?'subscription-translate':'translate-document').onclick();assert.equal(mock.requests.length,1);assert.equal($('ask-ai').disabled,true);
   await leave(w,$,reason);mock.release();await run;
   assert.equal(mock.requests.length,1,'leaving cannot allow the remaining two requests');
   const doc=storedDocument(w);assert.equal(translated(doc).length,32);assert.equal(doc.notes['cue-0'],'A private note that is never model input.');
   assert.equal(doc.segments[32].translations.zh,undefined);assert.equal($('ai-consent').checked,false);
   if(reason==='other-document'){
    assert.equal(translated(storedDocument(w,'An unrelated second episode')).length,0);
    assert.doesNotMatch($(mode==='subscription'?'ai-progress':'language-status').textContent,/保存 32|保存 65|翻译完成/,'another episode must not display the old operation outcome');
    [...$('library').querySelectorAll('button')].find(button=>button.textContent.includes(doc.title)).click();
   }
   assert.match($(mode==='subscription'?'ai-progress':'language-status').textContent,/已停止后续/);
   const firstBatch=structuredClone(doc.segments.slice(0,32));$('language-panel').open=true;
   if(mode==='subscription'){await $('subscription-translate').onclick();assert.equal(mock.requests.length,1);$('ai-consent').checked=true;}
   await $(mode==='subscription'?'subscription-translate':'translate-document').onclick();
   assert.equal(mock.requests.length,3);assert.equal(translated(storedDocument(w)).length,65);
   assert.deepEqual(mock.requests.slice(1).flatMap(request=>request.segments.map(cue=>cue.id)),Array.from({length:33},(_,i)=>'cue-'+(i+32)));
   assert.deepEqual(storedDocument(w).segments.slice(0,32),firstBatch,'resuming retains completed target translations');
  }finally{mock?.release();await w.happyDOM.close();}
 });
}

test('final subscription batch failure returns usable controls; reload and retry require fresh consent and keep prior targets',async()=>{
 const first=setup();let snapshot;
 try{
  const {w,$}=first,mock=injectedTranslation(w,{hold:0,fail:3});await prepareTranslation(w,$);await $('subscription-translate').onclick();
  assert.equal(mock.requests.length,3);assert.equal(translated(storedDocument(w)).length,64);assert.match($('ai-progress').textContent,/Injected network rejection/);
  assert.equal($('subscription-translate').disabled,false);assert.equal($('ask-ai').disabled,true);assert.equal($('ask-ai').hidden,true);assert.equal($('stop-subscription-translation').hidden,true);assert.equal($('ai-consent').checked,false);
  await $('subscription-translate').onclick();assert.equal(mock.requests.length,3,'a failed request is not retried automatically');snapshot=w.localStorage.getItem(KEY);
 }finally{await first.w.happyDOM.close();}
 const {w,$}=setup(snapshot);
 try{
  const before=structuredClone(translated(storedDocument(w))),mock=injectedTranslation(w,{hold:0});assert.equal(mock.requests.length,0);assert.equal($('ai-consent').checked,false);
  await $('check-ai').onclick();await $('subscription-translate').onclick();assert.equal(mock.requests.length,0);
  $('ai-consent').checked=true;await $('subscription-translate').onclick();assert.equal(mock.requests.length,1);assert.deepEqual(mock.requests[0].segments.map(cue=>cue.id),['cue-64']);
  assert.equal(translated(storedDocument(w)).length,65);assert.deepEqual(storedDocument(w).segments.slice(0,64),before);assert.equal($('ai-consent').checked,false);
 }finally{await w.happyDOM.close();}
});

for(const operation of ['question','summary'])test(`${operation} outcome stays with its source when another document opens`,async()=>{
 const {w,$}=setup();let release,pending;
 try{
  await importDocument(w,fixture('A field guide to careful reading',1));
  w.fetch=async(url,options)=>{if(url.endsWith('language-tools'))return {ok:true,json:async()=>({ai:{codex:{ready:true}}})};const request=JSON.parse(options.body);await new Promise(resolve=>{release=resolve;});return {ok:true,json:async()=>({answer:'An injected answer for the first episode.',citations:[request.segments[0].id],provider:'injected-test-fixture'})};};
  await $('check-ai').onclick();if(operation==='summary')$('prepare-summary').click();else $('ai-question').value='What should a reader verify?';$('ai-consent').checked=true;
  pending=$('ask-ai').onclick();await importDocument(w,fixture('An unrelated second episode',1));
  assert.match($('ai-progress').textContent,/A field guide to careful reading/,'blocked controls must explain which earlier document still has a request');
  release();await pending;assert.equal(storedDocument(w).ai_answers.length,1);assert.equal(storedDocument(w,'An unrelated second episode').ai_answers.length,0);
  assert.doesNotMatch($('ai-progress').textContent,/已保存|完成|injected answer/);
  [...$('library').querySelectorAll('button')].find(button=>button.textContent.includes('A field guide')).click();assert.match($('ai-progress').textContent,/已保存/);
 }finally{release?.();await pending;await w.happyDOM.close();}
});

for(const mode of ['subscription','offline'])test(`${mode} full-source translation permits same-document reading jumps while pending`,async()=>{
 const {w,$}=setup();let mock,run;
 try{
  mock=injectedTranslation(w);await prepareTranslation(w,$);
  run=$(mode==='subscription'?'subscription-translate':'translate-document').onclick();
  $('reading-jump').value='cue-64';$('reading-jump').onchange();
  assert.equal($('language-panel').open,true);assert.equal($('language-panel').hidden,false);assert.equal($('search').value,'');
  mock.release();await run;assert.equal(mock.requests.length,3,'a source jump is not a cancellation when full confirmed scope remains unchanged');assert.equal(translated(storedDocument(w)).length,65);
 }finally{mock?.release();await run;await w.happyDOM.close();}
});

test('jumping from a filtered translation to full source latches a scope change even if consent is rechecked',async()=>{
 const {w,$}=setup();let mock,run;
 try{
  const doc=fixture();doc.segments.slice(0,64).forEach(cue=>{cue.saved_excerpt=true;});await importDocument(w,doc);$('mode-transcript').click();$('language-panel').open=true;$('filter-excerpts').click();
  mock=injectedTranslation(w);await $('check-ai').onclick();$('ai-consent').checked=true;run=$('subscription-translate').onclick();
  $('reading-jump').value='cue-64';$('reading-jump').onchange();assert.equal($('ai-consent').checked,false);$('ai-consent').checked=true;
  mock.release();await run;assert.equal(mock.requests.length,1);assert.equal(translated(storedDocument(w)).length,32);assert.equal(storedDocument(w).segments[64].translations.zh,undefined);
 }finally{mock?.release();await run;await w.happyDOM.close();}
});

for(const mode of ['subscription','offline'])test(`${mode} full-source translation continues across original and bilingual views`,async()=>{
 const {w,$}=setup();let mock,run;
 try{
  mock=injectedTranslation(w);await prepareTranslation(w,$);
  run=$(mode==='subscription'?'subscription-translate':'translate-document').onclick();
  $('mode-bilingual').click();$('mode-transcript').click();assert.equal($('language-panel').open,true);assert.equal($('ai-consent').checked,true);
  mock.release();await run;assert.equal(mock.requests.length,3);assert.equal(translated(storedDocument(w)).length,65);
 }finally{mock?.release();await run;await w.happyDOM.close();}
});

function oldTranslationSearchFixture(){
 const doc=fixture();doc.translation_view='zh';
 for(const cue of doc.segments)cue.translations={zh:{text:'old-needle draft',source_text:cue.text,source_language:'en',document_language:'en',provider:'local'}};
 return doc;
}
test('own translation writes may change visible search matches without changing confirmed request targets',async()=>{
 const {w,$}=setup();let mock,run;
 try{
  await importDocument(w,oldTranslationSearchFixture());$('mode-bilingual').click();$('language-panel').open=true;$('search').value='old-needle';$('search').dispatchEvent(new w.Event('input'));
  mock=injectedTranslation(w);await $('check-ai').onclick();$('ai-consent').checked=true;run=$('subscription-translate').onclick();mock.release();await run;
  assert.equal(mock.requests.length,3);assert.deepEqual(mock.requests.flatMap(request=>request.segments.map(cue=>cue.id)),Array.from({length:65},(_,i)=>'cue-'+i));
  assert.equal(storedDocument(w).segments.filter(cue=>cue.translations.zh.provider==='chatgpt_subscription_translation').length,65);assert.equal($('transcript').querySelectorAll('.segment').length,0);
 }finally{mock?.release();await run;await w.happyDOM.close();}
});

test('user filter changes after an output-driven match change still latch the original plan stopped',async()=>{
 const {w,$}=setup();let mock,run;
 try{
  await importDocument(w,oldTranslationSearchFixture());$('mode-bilingual').click();$('language-panel').open=true;$('search').value='old-needle';$('search').dispatchEvent(new w.Event('input'));
  mock=injectedTranslation(w,{hold:2});await $('check-ai').onclick();$('ai-consent').checked=true;run=$('subscription-translate').onclick();
  for(let tick=0;mock.requests.length<2&&tick<100;tick++)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(mock.requests.length,2);
  $('search').value='';$('search').dispatchEvent(new w.Event('input'));$('search').value='old-needle';$('search').dispatchEvent(new w.Event('input'));$('ai-consent').checked=true;
  mock.release();await run;assert.equal(mock.requests.length,2);assert.equal(storedDocument(w).segments.filter(cue=>cue.translations.zh.provider==='chatgpt_subscription_translation').length,64);
 }finally{mock?.release();await run;await w.happyDOM.close();}
});

for(const change of ['query','notes-filter','excerpts-filter','speaker-filter','note-input','excerpt-toggle'])test(`explicit ${change} scope change stops pending subscription even after consent is rechecked`,async()=>{
 const {w,$}=setup();let mock,run;
 try{
  const doc=fixture();doc.segments.forEach((cue,index)=>{cue.speaker=index<32?'Host':'Guest';cue.saved_excerpt=true;if(change==='note-input')doc.notes[cue.id]='selected note';});
  await importDocument(w,doc);$('mode-transcript').click();$('language-panel').open=true;
  if(change==='note-input'){$('search').value='selected note';$('search').dispatchEvent(new w.Event('input'));}
  if(change==='excerpt-toggle')$('filter-excerpts').click();
  mock=injectedTranslation(w);await $('check-ai').onclick();$('ai-consent').checked=true;run=$('subscription-translate').onclick();assert.equal(mock.requests.length,1);
  if(change==='query'){$('search').value='Observation 65';$('search').dispatchEvent(new w.Event('input'));}
  if(change==='notes-filter')$('filter-notes').click();
  if(change==='excerpts-filter')$('filter-excerpts').click();
  if(change==='speaker-filter'){$('speaker-filter').value=JSON.stringify('Host');$('speaker-filter').dispatchEvent(new w.Event('change'));}
  if(change==='note-input'){w.document.querySelector('.note-button').click();$('note').value='Changed note without the search words';$('note').dispatchEvent(new w.Event('input'));await Promise.resolve();}
  if(change==='excerpt-toggle')w.document.querySelector('.excerpt-button').click();
  assert.equal($('ai-consent').checked,false);$('ai-consent').checked=true;mock.release();await run;
  assert.equal(mock.requests.length,1);assert.equal(translated(storedDocument(w)).length,32);
 }finally{mock?.release();await run;await w.happyDOM.close();}
});
