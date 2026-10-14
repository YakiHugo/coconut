/** Request UI uses authored source and injected replies; no model or provider calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url);
const fixture=(count=65)=>({title:'Action-specific reading',language:'en',notes:{'cue-0':'PRIVATE NOTE'},segments:Array.from({length:count},(_,i)=>({id:'cue-'+i,start:i*3,end:i*3+3,speaker:'Speaker',text:`Original sentence ${i}.`}))});
function setup(stored){
 const w=new Window({url:'http://127.0.0.1:8080/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});if(stored)w.localStorage.setItem('coconut-reader-v1',stored);
 const requests=[];
 w.fetch=async(url,options)=>{
  if(url.endsWith('language-tools'))return {ok:true,json:async()=>({local_translation:true,ai:{codex:{ready:true,model_selection:{supported:true}},claude:{ready:true,model_selection:{supported:true}}}})};
  const body=JSON.parse(options.body);requests.push({url,body});
  if(url.endsWith('translate-subscription'))return {ok:true,json:async()=>({translations:body.segments.map(s=>({id:s.id,source_text:s.text,text:'Injected translation.'}))})};
  return {ok:true,json:async()=>({answer:'Injected answer.',citations:[body.segments[0].id],provider:'fixture'})};
 };
 w.eval(['summary','core','passages','passage-playback','library-store','app','language'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
 const $=id=>w.document.getElementById(id),task=value=>{$('ai-task').value=value;$('ai-task').onchange();};
 return {w,$,task,requests};
}
async function importDocument(w,doc){
 const file=w.document.getElementById('file'),text=JSON.stringify(doc);
 Object.defineProperty(file,'files',{configurable:true,value:[{name:'authored.json',size:text.length,text:async()=>text}]});await file.onchange();
}
const choose=($,name)=>{$('ai-model').value=name;$('ai-model').oninput();};
const stored=w=>JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];
test('per-provider explicit model reaches questions and survives history round-trip',async()=>{
 const {w,$,task,requests}=setup();try{
  await importDocument(w,fixture(2));await $('check-ai').onclick();task('question');choose($,'codex-test');
  $('ai-provider').value='claude';$('ai-provider').onchange();assert.equal($('ai-model').value,'');choose($,'claude-test');
  $('ai-provider').value='codex';$('ai-provider').onchange();assert.equal($('ai-model').value,'codex-test');
  $('ai-question').value='Explain.';$('ai-question').oninput();$('ai-consent').checked=true;await $('ask-ai').onclick();
  assert.equal(requests[0].body.model,'codex-test');assert.equal(stored(w).ai_answers[0].requested_model,'codex-test');
  assert.match($('ai-answers').textContent,/请求模型：codex-test/);assert.match($('ai-model-help').textContent,/不证明模型可用/);
  choose($,'');$('ai-consent').checked=true;await $('ask-ai').onclick();assert.equal('model' in requests[1].body,false);
 }finally{await w.happyDOM.close();}
});
test('translation and all summary batches send captured model and retain requested provenance',async()=>{
 for(const action of ['translation','summary']){
  const {w,$,task,requests}=setup();try{
   await importDocument(w,fixture(action==='summary'?801:65));await $('check-ai').onclick();task(action);choose($,'model-test');
   $('ai-consent').checked=true;await $(action==='translation'?'subscription-translate':'ask-ai').onclick();
   assert.ok(requests.length>1);assert.ok(requests.every(r=>r.body.model==='model-test'));
   const doc=stored(w);if(action==='summary')assert.equal(doc.ai_answers[0].requested_model,'model-test');
   else assert.ok(doc.segments.every(s=>s.translations.zh.requested_model==='model-test'));
  }finally{await w.happyDOM.close();}
 }
});
test('model edits clear consent and stop subsequent foreground batches without relabeling inflight output',async()=>{
 const {w,$,task,requests}=setup();try{
  await importDocument(w,fixture(801));await $('check-ai').onclick();task('summary');choose($,'first-model');
  const fetch=w.fetch;let release,started;const entered=new Promise(r=>started=r),held=new Promise(r=>release=r);
  w.fetch=async(...args)=>{const result=await fetch(...args);started();await held;return result;};
  $('ai-consent').checked=true;const run=$('ask-ai').onclick();await entered;choose($,'second-model');assert.equal($('ai-consent').checked,false);release();await run;
  assert.equal(requests.length,1);assert.equal(requests[0].body.model,'first-model');assert.equal(stored(w).summary_job.model,'first-model');
  assert.equal($('ask-ai').disabled,true);assert.match($('summary-job-state').textContent,/模型已改变/);
 }finally{await w.happyDOM.close();}
});
test('invalid model names never send even if consent is manually checked',async()=>{
 const {w,$,task,requests}=setup();try{
  await importDocument(w,fixture(2));await $('check-ai').onclick();task('question');$('ai-question').value='Explain';$('ai-question').oninput();
  for(const model of ['--flag','http://host','a b','x'.repeat(121)]){choose($,model);$('ai-consent').checked=true;await $('ask-ai').onclick();assert.equal(requests.length,0);}
 }finally{await w.happyDOM.close();}
});

test('task submission and recovery bind model to receipt and preserve absent legacy model',async()=>{
 const {createRequire}=await import('node:module'),require=createRequire(import.meta.url),T=require('../reader/task-client.js');
 const doc={key:'doc',...fixture(2)},payload=T.submission(doc,{revision:'r',provider:'codex',model:'test-model',idempotencyKey:'key',consent:true});assert.equal(payload.model,'test-model');
 const result={purpose:'summary',answer:'mock',citations:['cue-0'],requested_model:'test-model',input_snapshot:{version:1,segments:payload.segments}};
 const task={taskId:'task',kind:'summary',status:'succeeded',provider:'codex',model:'test-model',document:payload.document,result};
 assert.equal(T.matchesResult(task,doc,'r'),true);assert.equal(T.recoveryFor(task).result.requested_model,'test-model');
 assert.equal(T.matchesResult({...task,model:'other'},doc,'r'),false);assert.equal(T.recoveryFor({...task,model:'other'}),null);
 delete task.model;delete result.requested_model;assert.equal(T.matchesResult(task,doc,'r'),true);assert.equal('model' in T.recoveryFor(task).task,false);
});

test('old foreground service cannot silently ignore explicit model; blank stays compatible',async()=>{
 const {w,$,task,requests}=setup();try{
  await importDocument(w,fixture(2));const original=w.fetch;
  w.fetch=async(url,...args)=>url.endsWith('language-tools')?{ok:true,json:async()=>({ai:{codex:{ready:true}}})}:original(url,...args);
  await $('check-ai').onclick();task('question');$('ai-question').value='Explain';$('ai-question').oninput();choose($,'explicit-model');
  assert.match($('ai-consent-copy').textContent,/无法核验提供商计费.*额外付费额度/);
  $('ai-consent').checked=true;await $('ask-ai').onclick();assert.equal(requests.length,0);assert.equal($('ai-consent').checked,false);
  choose($,'');$('ai-consent').checked=true;await $('ask-ai').onclick();assert.equal(requests.length,1);assert.equal('model' in requests[0].body,false);
 }finally{await w.happyDOM.close();}
});
