/** Authored documents and injected model replies only; no provider, media or browser harness. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';
import {Window} from 'happy-dom';
const C=createRequire(import.meta.url)('../reader/core.js');
const root=new URL('../',import.meta.url),KEY='coconut-reader-v1';
function fixture(count=245,title='Authored AI history'){
 const segments=Array.from({length:3},(_,i)=>({id:'cue-'+i,text:`Authored source ${i}.`,start:i*4,end:i*4+4}));
 return {title,language:'en',segments,notes:{'cue-0':'Private note, never model input.'},ai_answers:Array.from({length:count},(_,i)=>({
  question:`Question ${i+1}`,answer:`Historical answer ${i+1}`,provider:'authored-fixture',purpose:i===1||i===24?'summary':'question',citations:['cue-'+(i%3)],input_snapshot:{version:1,segments:segments.map(({id,text})=>({id,text}))}
 }))};
}
function setup(stored){
 const w=new Window({url:'http://127.0.0.1:8080/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});if(stored)w.localStorage.setItem(KEY,stored);
 const requests=[];w.fetch=async(url,options)=>{
  requests.push({url,options});throw new Error('Browsing/import/export must not make a request');
 };
 w.eval(['summary','core','passages','passage-playback','library-store','app','language'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
 return {w,$:id=>w.document.getElementById(id),requests};
}
async function importDocument(w,doc,inputId='file'){
 const input=w.document.getElementById(inputId),text=JSON.stringify(doc);
 Object.defineProperty(input,'files',{configurable:true,value:[{name:'authored-history.json',size:Buffer.byteLength(text),text:async()=>text}]});await input.onchange();
}
const storedDocument=w=>JSON.parse(w.localStorage.getItem(KEY)).documents.find(d=>d.key===w.sessionStorage.getItem('coconut-reader-active-v1'));
function captureDownloads(w){
 const blobs=[];w.URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:authored-history';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};
 return blobs;
}
function blockStorage(w,mode){
 const backing=w.localStorage;let blocked=true;
 Object.defineProperty(w,'localStorage',{configurable:true,value:{
  getItem:key=>backing.getItem(key),
  setItem(key,value){if(blocked)throw new w.DOMException('Injected storage rejection',mode);backing.setItem(key,value);}
 }});
 return {backing,unblock(){blocked=false;}};
}
function installModel(w,onAnswer=()=>{}){
 const requests=[];w.fetch=async(url,options)=>{
  if(url.endsWith('language-tools'))return {ok:true,json:async()=>({local_translation:false,ai:{codex:{ready:true}}})};
  assert.equal(url,'api/ask');const body=JSON.parse(options.body);requests.push(body);assert.equal(body.consent,true);assert.ok(!JSON.stringify(body).includes('Private note'));
  onAnswer(body);
  return {ok:true,json:async()=>({answer:'Authored injected answer '+requests.length,provider:'injected-fixture',citations:[body.segments[0].id]})};
 };
 return requests;
}
async function prepareAction($,action){
 await $('check-ai').onclick();$('ai-task').value=action;$('ai-task').onchange();
 if(action==='question'){$('ai-question').value='An explicitly confirmed authored question';$('ai-question').oninput();}
 $('ai-consent').checked=true;
}

test('all valid history, every summary and removed citation survive validation and both backup formats',()=>{
 const source=fixture(1205);source.ai_answers[0].citations=['removed-cue','cue-0'];
 source.ai_answers[0].input_snapshot.segments.push({id:'removed-cue',text:'Historical source retained after removal.'});
 delete source.ai_answers[2].input_snapshot;
 source.ai_answers.splice(17,0,null,{question:42,answer:'Invalid',citations:[]});
 const doc=C.validate(source),roundtrip=C.parse(JSON.stringify(doc),'history.json');
 assert.equal(doc.ai_answers.length,1205);assert.deepEqual(roundtrip.ai_answers,doc.ai_answers);
 assert.deepEqual(doc.ai_answers[0].citations,['removed-cue','cue-0']);assert.equal(C.answerFreshness(doc.ai_answers[0],doc),'stale');assert.equal(C.answerFreshness(doc.ai_answers[2],doc),'unknown');
 assert.equal(C.latestSummary(doc).answer,'Historical answer 25');assert.equal(doc.ai_answers.filter(a=>a.purpose==='summary').length,2);
 const backup={format:'coconut-library',version:1,active:'history',documents:[{...doc,key:'history'}]};
 const merged=C.mergeLibraryBackup({documents:[],active:null},JSON.parse(JSON.stringify(backup)));
 assert.deepEqual(merged.documents[0].ai_answers,doc.ai_answers);
 const report=C.aiReadingMarkdown(doc);assert.equal((report.match(/^## 回答 /gm)||[]).length,1205);assert.match(report,/Historical source retained after removal/);assert.match(report,/removed\\-cue · 原片段已移除/);
});

test('history mounts at most ten answers, reaches both ends and does not enumerate hidden answer evidence',async()=>{
 const {w,$,requests}=setup();try{
  await importDocument(w,fixture(245));assert.equal(storedDocument(w).ai_answers.length,245);
  assert.equal($('summary-body').textContent,'Historical answer 25');assert.match($('browse-ai-history').textContent,/245/);
  $('browse-ai-history').click();assert.equal($('language-panel').open,true);assert.equal($('language-panel').hidden,false);assert.equal(w.document.activeElement,$('ai-history-heading'));
  assert.equal(w.document.querySelectorAll('.ai-answer').length,10);assert.equal($('ai-answers').firstElementChild.dataset.answerNumber,'245');assert.equal($('ai-history-newer').disabled,true);
  let checks=0;const freshness=w.Coconut.answerFreshness;w.Coconut.answerFreshness=(...args)=>{checks++;return freshness(...args);};
  $('ai-history-older').click();assert.equal(checks,10);assert.equal($('ai-answers').firstElementChild.dataset.answerNumber,'235');assert.match($('ai-history-status').textContent,/共 245 则.*第 2 \/ 25 页/);
  $('ai-question').value='Draft only';$('ai-question').oninput();assert.equal($('ai-answers').firstElementChild.dataset.answerNumber,'235','ordinary renders keep the current page');
  $('ai-history-oldest').click();assert.equal(w.document.querySelectorAll('.ai-answer').length,5);assert.equal($('ai-answers').lastElementChild.dataset.answerNumber,'1');assert.equal($('ai-history-older').disabled,true);assert.equal($('ai-history-oldest').disabled,true);
  $('ai-history-newer').click();assert.equal($('ai-answers').firstElementChild.dataset.answerNumber,'15');
  $('ai-history-latest').click();assert.equal($('ai-answers').firstElementChild.dataset.answerNumber,'245');
  $('ai-history-oldest').click();await importDocument(w,fixture(2,'Second document'));assert.equal(w.document.querySelectorAll('.ai-answer').length,2);assert.equal($('ai-history-pages').hidden,true);
  [...$('library').querySelectorAll('button')].find(button=>button.textContent.includes('Authored AI history')).click();assert.equal($('ai-answers').firstElementChild.dataset.answerNumber,'245');
  assert.equal(requests.length,0);
 }finally{await w.happyDOM.close();}
});

test('old answers render missing references as text and preserve stale/unknown evidence without fabricated navigation',async()=>{
 const {w,$,requests}=setup();try{
  const source=fixture(35);source.ai_answers[0].citations=['removed-cue'];source.ai_answers[0].input_snapshot.segments.push({id:'removed-cue',text:'Removed original.'});
  source.ai_answers[1].input_snapshot.segments.pop();delete source.ai_answers[2].input_snapshot;
  source.ai_answers[3].question='<img src="https://tracker.test">';
  await importDocument(w,source);$('browse-ai-history').click();$('ai-history-oldest').click();
  const oldest=$('ai-answers').lastElementChild;assert.match(oldest.textContent,/原片段已不存在：removed-cue/);assert.equal(oldest.querySelector('button'),null);assert.match(oldest.textContent,/依据可能过期/);
  assert.match(w.document.querySelector('[data-answer-number="2"]').textContent,/全文范围已变化/);
  assert.match(w.document.querySelector('[data-answer-number="3"]').textContent,/无法确认依据/);assert.equal($('ai-answers').querySelector('img'),null);
  $('search').value='no matching cue';$('search').oninput();w.document.querySelector('[data-answer-number="5"] button').click();
  assert.equal($('search').value,'');assert.equal(w.document.activeElement.dataset.segmentId,'cue-1');assert.equal(requests.length,0);
 }finally{await w.happyDOM.close();}
});

test('all-history exports ignore displayed page and search, and a library backup reload keeps every entry',async()=>{
 const {w,$,requests}=setup();let snapshot;try{
  await importDocument(w,fixture(245));const blobs=captureDownloads(w);$('browse-ai-history').click();$('ai-history-oldest').click();$('search').value='source 0';$('search').oninput();
  $('export-ai-reading').click();const markdown=await blobs.at(-1).text();assert.equal((markdown.match(/^## 回答 /gm)||[]).length,245);assert.match(markdown,/Historical answer 1\n/);assert.match(markdown,/Historical answer 245\n/);
  $('export-ai-history-json').click();const document=JSON.parse(await blobs.at(-1).text());assert.equal(document.ai_answers.length,245);assert.equal(document.notes['cue-0'],'Private note, never model input.');
  $('export-library').click();const backup=JSON.parse(await blobs.at(-1).text());assert.equal(backup.documents[0].ai_answers.length,245);snapshot=w.localStorage.getItem(KEY);
  const restored=setup();try{await importDocument(restored.w,backup,'library-file');assert.deepEqual(storedDocument(restored.w).ai_answers,storedDocument(w).ai_answers);assert.match(restored.$('ai-history-status').textContent,/245/);}finally{await restored.w.happyDOM.close();}
  assert.equal(requests.length,0);
 }finally{await w.happyDOM.close();}
 const loaded=setup(snapshot);try{assert.equal(storedDocument(loaded.w).ai_answers.length,245);assert.equal(loaded.$('summary-body').textContent,'Historical answer 25');assert.equal(loaded.w.document.querySelectorAll('.ai-answer').length,10);assert.equal(loaded.requests.length,0);}finally{await loaded.w.happyDOM.close();}
});

for(const action of ['question','summary'])test(`a confirmed ${action} appends after hundreds of records, resets the visible page and preserves older summaries`,async()=>{
 const {w,$}=setup();try{
  await importDocument(w,fixture());const before=storedDocument(w).ai_answers,requests=installModel(w);await prepareAction($,action);
  $('ai-history-oldest').click();await $('ask-ai').onclick();
  const doc=storedDocument(w);assert.equal(doc.ai_answers.length,246);assert.deepEqual(doc.ai_answers.slice(0,-1),before);assert.equal(doc.ai_answers.at(-1).purpose,action);
  assert.equal($('ai-answers').firstElementChild.dataset.answerNumber,'246');assert.match($('ai-history-storage').textContent,/246 则均已保存/);
  assert.equal($('summary-body').textContent,action==='summary'?'Authored injected answer 1':'Historical answer 25');assert.equal(requests.length,1);assert.equal($('ai-consent').checked,false);
  await $('ask-ai').onclick();assert.equal(requests.length,1,'browsing and new results do not authorize another call');
 }finally{await w.happyDOM.close();}
});

for(const mode of ['QuotaExceededError','SecurityError'])for(const action of ['question','summary'])test(`${mode} after a ${action} keeps old disk history, an unsaved in-page answer and rescue exports`,async()=>{
 const {w,$}=setup();let storage;try{
  await importDocument(w,fixture());const before=storedDocument(w).ai_answers;let diskCheckpoint;
  const requests=installModel(w,()=>{diskCheckpoint=w.localStorage.getItem(KEY);storage=blockStorage(w,mode);});
  await prepareAction($,action);await $('ask-ai').onclick();assert.equal(requests.length,1);assert.equal(storage.backing.getItem(KEY),diskCheckpoint);
  assert.match($('ai-history-storage').textContent,/已保存 245 则 · 1 则仅在此页/);assert.equal($('ai-history-storage').dataset.state,'unsaved');assert.equal($('save-status').hidden,false);assert.match($('ai-progress').textContent,/尚未保存|保存未成功/);assert.doesNotMatch($('ai-progress').textContent,/回答已保存在|整篇摘要已保存/);
  if(action==='summary'){assert.equal($('summary-state').dataset.state,'unsaved');assert.equal($('summary-body').textContent,'Authored injected answer 1');}
  const blobs=captureDownloads(w);$('ai-history-oldest').click();$('export-ai-reading').click();assert.equal((await blobs.at(-1).text()).match(/^## 回答 /gm).length,246);
  $('export-ai-history-json').click();const rescue=JSON.parse(await blobs.at(-1).text());assert.equal(rescue.ai_answers.length,246);assert.deepEqual(rescue.ai_answers.slice(0,-1),before);
  assert.equal($('save-status').hidden,false);assert.equal(storage.backing.getItem(KEY),diskCheckpoint,'export cannot mark pending records saved or write them');
  const restored=setup();try{await importDocument(restored.w,rescue);assert.equal(storedDocument(restored.w).ai_answers.length,246);assert.match(restored.$('ai-history-storage').textContent,/246 则均已保存/);}finally{await restored.w.happyDOM.close();}
  storage.unblock();$('document-details').click();$('document-title').value='Recovered full history';await $('save-details').onclick(new w.Event('click'));
  assert.equal(storedDocument(w).ai_answers.length,246);assert.equal($('save-status').dataset.state,'saved');assert.match($('ai-history-storage').textContent,/246 则均已保存/);assert.equal(requests.length,1);
 }finally{storage?.unblock();await w.happyDOM.close();}
});

test('successive unsaved replies keep their sequence and a tab conflict never overwrites another saved version',async()=>{
 const {w,$}=setup();let storage;try{
  await importDocument(w,fixture(25));const disk=w.localStorage.getItem(KEY),before=storedDocument(w).ai_answers;
  const requests=installModel(w);storage=blockStorage(w,'QuotaExceededError');
  for(let i=0;i<2;i++){await prepareAction($,'question');await $('ask-ai').onclick();}
  assert.equal(requests.length,2);assert.equal(storage.backing.getItem(KEY),disk);assert.match($('ai-history-storage').textContent,/已保存 25 则 · 2 则仅在此页/);
  const blobs=captureDownloads(w);$('export-ai-history-json').click();const pending=JSON.parse(await blobs.at(-1).text());assert.equal(pending.ai_answers.length,27);assert.deepEqual(pending.ai_answers.slice(0,25),before);
  assert.deepEqual(pending.ai_answers.slice(-2).map(a=>a.answer),['Authored injected answer 1','Authored injected answer 2']);
  storage.unblock();const external=JSON.parse(disk);external.documents[0].title='Newer title saved by another tab';const changed=JSON.stringify(external);storage.backing.setItem(KEY,changed);
  await prepareAction($,'question');await $('ask-ai').onclick();assert.equal(requests.length,3);assert.equal(storage.backing.getItem(KEY),changed);
  assert.match($('ai-history-storage').textContent,/自动保存已暂停/);assert.equal($('ai-history-storage').dataset.state,'unsaved');
  $('export-ai-history-json').click();assert.equal(JSON.parse(await blobs.at(-1).text()).ai_answers.length,28);assert.equal(storage.backing.getItem(KEY),changed);
 }finally{storage?.unblock();await w.happyDOM.close();}
});

test('empty history stays explicit and export/summary browse controls remain unavailable without a request',async()=>{
 const {w,$,requests}=setup();try{
  await importDocument(w,fixture(0));assert.match($('ai-history-status').textContent,/还没有 AI 阅读记录/);assert.equal($('ai-answers').childElementCount,0);
  assert.equal($('export-ai-reading').disabled,true);assert.equal($('export-ai-history-json').disabled,true);assert.equal($('browse-ai-history').hidden,true);assert.equal($('ai-history-pages').hidden,true);assert.equal(requests.length,0);
 }finally{await w.happyDOM.close();}
});

async function removeHistoryDocument(w,title){
 const row=[...w.document.querySelectorAll('.library-entry')].find(row=>row.textContent.includes(title));
 assert.ok(row);row.querySelector('.library-remove').click();await w.document.getElementById('confirm-removal').onclick();
}
function unloadProtected(w){const event=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(event);return event.defaultPrevented;}

test('full history survives removal rescue, failed undo and retry with correct persistence counts',async()=>{
 const {w,$,requests}=setup();let storage;try{
  await importDocument(w,fixture(245));const original=storedDocument(w),blobs=captureDownloads(w);
  $('ai-history-oldest').click();await removeHistoryDocument(w,original.title);
  assert.equal(JSON.parse(w.localStorage.getItem(KEY)).documents.length,0);assert.equal(unloadProtected(w),true);
  $('export-removed-document').click();assert.deepEqual(JSON.parse(await blobs.at(-1).text()).ai_answers,original.ai_answers);
  storage=blockStorage(w,'QuotaExceededError');const disk=storage.backing.getItem(KEY);
  await $('undo-removal').onclick();assert.equal(storage.backing.getItem(KEY),disk);assert.equal($('reader-workspace').hidden,true);assert.equal(unloadProtected(w),true);
  $('export-removed-document').click();assert.deepEqual(JSON.parse(await blobs.at(-1).text()).ai_answers,original.ai_answers);
  storage.unblock();await $('undo-removal').onclick();assert.deepEqual(storedDocument(w).ai_answers,original.ai_answers);
  assert.match($('ai-history-storage').textContent,/245 则均已保存/);assert.equal($('ai-answers').firstElementChild.dataset.answerNumber,'245');assert.equal(unloadProtected(w),false);
  $('ai-history-oldest').click();assert.equal($('ai-answers').lastElementChild.dataset.answerNumber,'1');assert.equal(requests.length,0);
 }finally{storage?.unblock();await w.happyDOM.close();}
});

test('failed removal preserves pending full history and its saved count without claiming rescue succeeded',async()=>{
 const {w,$}=setup();let storage;try{
  await importDocument(w,fixture(245));const before=w.localStorage.getItem(KEY),requests=installModel(w);
  storage=blockStorage(w,'QuotaExceededError');await prepareAction($,'question');await $('ask-ai').onclick();
  await removeHistoryDocument(w,'Authored AI history');assert.equal(storage.backing.getItem(KEY),before);assert.equal($('removal-recovery').hidden,true);assert.equal($('remove-document-dialog').open,false);assert.match($('notice').textContent,/移除未保存/);
  $('cancel-removal').click();$('ai-history-latest').click();assert.match($('ai-history-storage').textContent,/已保存 245 则 · 1 则仅在此页/);
  const blobs=captureDownloads(w);$('export-ai-history-json').click();assert.equal(JSON.parse(await blobs.at(-1).text()).ai_answers.length,246);assert.equal(unloadProtected(w),true);
  storage.unblock();$('document-details').click();$('document-title').value='Recovered history after rollback';await $('save-details').onclick(new w.Event('click'));
  assert.equal(storedDocument(w).ai_answers.length,246);assert.match($('ai-history-storage').textContent,/246 则均已保存/);assert.equal(requests.length,1);
 }finally{storage?.unblock();await w.happyDOM.close();}
});

for(const action of ['question','summary'])test(`late ${action} cannot alter full history after removal and same-key undo`,async()=>{
 const {w,$}=setup();let release;try{
  await importDocument(w,fixture(245));let requests=0;
  w.fetch=async(url,options)=>{
   if(url.endsWith('language-tools'))return {ok:true,json:async()=>({local_translation:false,ai:{codex:{ready:true}}})};
   assert.equal(url,'api/ask');requests++;const body=JSON.parse(options.body);await new Promise(resolve=>{release=resolve;});
   return {ok:true,json:async()=>({answer:'Late authored result must be retired',provider:'injected-fixture',citations:[body.segments[0].id]})};
  };
  await prepareAction($,action);const pending=$('ask-ai').onclick();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(requests,1);
  const blobs=captureDownloads(w);await removeHistoryDocument(w,'Authored AI history');$('export-removed-document').click();const rescue=JSON.parse(await blobs.at(-1).text());
  assert.equal(rescue.ai_answers.length,245);await $('undo-removal').onclick();release();await pending;
  assert.deepEqual(storedDocument(w).ai_answers,rescue.ai_answers);assert.deepEqual(storedDocument(w).summary_job,rescue.summary_job);
  assert.match($('ai-history-storage').textContent,/245 则均已保存/);assert.equal($('summary-body').textContent,'Historical answer 25');assert.equal(requests,1);
  $('ai-history-oldest').click();assert.equal($('ai-answers').lastElementChild.dataset.answerNumber,'1');
 }finally{release?.();await w.happyDOM.close();}
});

for(const id of ['file','library-file'])test(`${id}: reviewed backup import retains 1,205 answers through quota failure, rescue and later save`,async()=>{
 const {w,$,requests}=setup();let storage,pending;try{
  await importDocument(w,fixture(2,'Previously saved history'));const disk=w.localStorage.getItem(KEY);
  const source=fixture(1205,'Reviewed complete history');source.ai_answers[0].citations=['removed-cue'];
  const payload=id==='file'?source:{format:'coconut-library',version:1,active:'reviewed',documents:[{...source,key:'reviewed'}]};
  const text=JSON.stringify(payload),input=$(id);let reads=0;
  // Byte thresholds are covered with real UTF-8 payloads by backup-budget tests;
  // this fixture isolates history ownership at that already-reviewed boundary.
  Object.defineProperty(input,'files',{configurable:true,value:[{name:'reviewed-history.json',size:50*1024*1024+1,text:async()=>{reads++;return text;}}]});
  pending=input.onchange();assert.equal($('large-backup-dialog').open,true);assert.equal(reads,0);$('cancel-large-backup').click();await pending;
  assert.equal(reads,0);assert.equal(w.localStorage.getItem(KEY),disk);
  storage=blockStorage(w,'QuotaExceededError');pending=input.onchange();assert.equal($('large-backup-dialog').open,true);$('continue-large-backup').click();await pending;
  assert.equal(reads,1);assert.equal(storage.backing.getItem(KEY),disk);assert.match($('ai-history-storage').textContent,/已保存 0 则 · 1205 则仅在此页/);
  const blobs=captureDownloads(w);$('export-ai-history-json').click();const recovered=JSON.parse(await blobs.at(-1).text());assert.equal(recovered.ai_answers.length,1205);assert.deepEqual(recovered.ai_answers[0].citations,['removed-cue']);
  $('export-ai-reading').click();assert.equal((await blobs.at(-1).text()).match(/^## 回答 /gm).length,1205);assert.equal(unloadProtected(w),true);
  storage.unblock();$('document-details').click();$('document-title').value='Persisted full reviewed history';await $('save-details').onclick(new w.Event('click'));
  assert.equal(storedDocument(w).ai_answers.length,1205);assert.match($('ai-history-storage').textContent,/1205 则均已保存/);assert.equal(requests.length,0);
 }finally{$('cancel-large-backup').onclick?.();await pending;storage?.unblock();await w.happyDOM.close();}
});
