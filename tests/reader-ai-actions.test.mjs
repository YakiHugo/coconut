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
  if(url.endsWith('language-tools'))return {ok:true,json:async()=>({local_translation:true,ai:{codex:{ready:true},claude:{ready:true}}})};
  const body=JSON.parse(options.body);requests.push({url,body});
  if(url.endsWith('translate-subscription'))return {ok:true,json:async()=>({translations:body.segments.map(s=>({id:s.id,source_text:s.text,text:'Injected translation.'}))})};
  return {ok:true,json:async()=>({answer:'Injected answer.',citations:[body.segments[0].id],provider:'fixture'})};
 };
 w.eval(['summary','core','passages','passage-playback','app','language'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
 const $=id=>w.document.getElementById(id),task=value=>{$('ai-task').value=value;$('ai-task').onchange();};
 return {w,$,task,requests};
}
async function importDocument(w,doc){
 const file=w.document.getElementById('file'),text=JSON.stringify(doc);
 Object.defineProperty(file,'files',{configurable:true,value:[{name:'authored.json',size:text.length,text:async()=>text}]});await file.onchange();
}
function visible(node){return !!node&&!node.closest('[hidden]');}
const planCounts=node=>({segments:Number(node.dataset.segmentCount),requests:Number(node.dataset.requestCount)});

test('each action exposes only its own controls, plan and submit in both composer locations',async()=>{
 const {w,$,task,requests}=setup();try{
  await importDocument(w,fixture());$('mode-transcript').click();$('language-panel').open=true;
  for(const action of ['translation','question','summary']){
   $('ai-consent').checked=true;task(action);assert.equal($('ai-consent').checked,false);
   assert.equal(visible($('ai-question')),action==='question');assert.equal(visible($('translation-source')),action==='translation');
   assert.equal(visible($('translation-target')),action!=='summary');assert.equal(visible($('translation-options')),action==='translation');
   assert.equal(visible($('summary-plan')),action==='summary');assert.equal(visible($('question-scope')),action==='question');assert.equal(visible($('subscription-translation-scope')),action==='translation');
   assert.equal(visible($('subscription-translate')),action==='translation');assert.equal(visible($('ask-ai')),action!=='translation');
   assert.equal($('ai-send-details').open,false);assert.equal($('translation-options').open,false);
  }
  $('mode-summary').click();$('prepare-summary').click();assert.equal($('ai-request-panel').parentElement,$('summary-request-slot'));
  assert.equal(visible($('ai-question')),false);assert.equal(visible($('subscription-translate')),false);assert.equal(visible($('summary-plan')),true);
  assert.equal(w.document.querySelectorAll('#ai-consent').length,1);assert.equal(requests.length,0);
 }finally{await w.happyDOM.close();}
});

test('bilingual entry chooses translation and focuses a visible language control without a request',async()=>{
 const {w,$,requests}=setup();try{
  await importDocument(w,fixture(2));$('mode-bilingual').click();$('prepare-bilingual').click();
  assert.equal($('ai-task').value,'translation');assert.equal($('language-panel').open,true);assert.equal(w.document.activeElement,$('translation-target'));
  assert.equal(visible(w.document.activeElement),true);assert.equal($('translation-options').open,false);assert.equal(requests.length,0);
 }finally{await w.happyDOM.close();}
});

test('question plan follows actual full versus filtered original input, including note matches',async()=>{
 const {w,$,task,requests}=setup();try{
  await importDocument(w,fixture());await $('check-ai').onclick();task('question');
  $('search').value='PRIVATE NOTE';$('search').oninput();$('ai-question').value='Explain this.';$('ai-question').oninput();
  assert.deepEqual(planCounts($('question-scope')),{segments:65,requests:1});
  $('ai-consent').checked=true;await $('ask-ai').onclick();assert.equal(requests[0].body.segments.length,65);
  $('ai-filtered').checked=true;$('ai-filtered').onchange();assert.deepEqual(planCounts($('question-scope')),{segments:1,requests:1});
  $('ai-consent').checked=true;await $('ask-ai').onclick();assert.deepEqual(requests[1].body.segments,[{id:'cue-0',text:'Original sentence 0.'}]);
  assert.ok(!JSON.stringify(requests).includes('PRIVATE NOTE'));assert.match($('ai-consent-copy').textContent,/问题和上述原文.*ChatGPT.*订阅额度/);
  $('search').value='no matching original';$('search').oninput();assert.equal($('ask-ai').disabled,true);assert.deepEqual(planCounts($('question-scope')),{segments:0,requests:0});
  $('ai-consent').checked=true;await $('ask-ai').onclick();assert.equal(requests.length,2);
 }finally{await w.happyDOM.close();}
});

test('translation plan counts distinguish unique original cues from repeated transmissions',async()=>{
 const {w,$,task,requests}=setup();try{
  await importDocument(w,fixture());await $('check-ai').onclick();task('translation');
  const selected=Number($('subscription-translation-scope').dataset.segmentCount),planned=Number($('subscription-translation-scope').dataset.requestCount),unique=Number($('subscription-translation-scope').dataset.sentCount),transmissions=Number($('subscription-translation-scope').dataset.transmissionCount);
  assert.equal(selected,65);assert.equal(planned,3);assert.equal(unique,65);assert.ok(transmissions>unique);
  assert.match($('subscription-translation-scope').textContent,/不同原文.*段次/);assert.match($('ai-consent-copy').textContent,/说话人标签.*匹配术语.*已有译文建议/);
  $('ai-consent').checked=true;await $('subscription-translate').onclick();
  assert.equal(requests.length,planned);const sent=requests.flatMap(({body})=>[...body.segments,...body.context]);
  assert.equal(new Set(sent.map(c=>c.id)).size,unique);assert.equal(sent.length,transmissions);assert.ok(!JSON.stringify(requests).includes('PRIVATE NOTE'));
  assert.equal($('ai-consent').checked,false);assert.equal($('subscription-translate').disabled,true);assert.match($('subscription-translate').textContent,/已译完/);
 }finally{await w.happyDOM.close();}
});

test('summary plan remains whole-document in filtered reading and contains no translation consent',async()=>{
 const {w,$,task,requests}=setup();try{
  await importDocument(w,fixture(801));await $('check-ai').onclick();$('search').value='sentence 8.';$('search').oninput();task('summary');
  assert.deepEqual(planCounts($('summary-plan')),{segments:801,requests:4});assert.match($('summary-plan').textContent,/3 个原文批次 \+ 1 次汇总/);
  assert.match($('ai-consent-copy').textContent,/全文.*分批笔记与引用/);assert.doesNotMatch($('ai-consent-copy').textContent,/术语|译文/);
  $('ai-consent').checked=true;await $('ask-ai').onclick();assert.equal(requests.length,4);assert.equal(requests.slice(0,3).reduce((n,r)=>n+r.body.segments.length,0),801);
  assert.equal(requests[3].body.segments.length,3);assert.equal($('summary-state').dataset.state,'current');assert.equal($('ai-consent').checked,false);
 }finally{await w.happyDOM.close();}
});

test('wrong-action handlers and unconfirmed actions cannot send or reuse another action consent',async()=>{
 const {w,$,task,requests}=setup();try{
  await importDocument(w,fixture(2));await $('check-ai').onclick();$('ai-question').value='Question';
  for(const action of ['question','summary','translation']){
   task(action);$('ai-consent').checked=true;
   if(action==='translation')await $('ask-ai').onclick();else {await $('subscription-translate').onclick();await $('translate-document').onclick();}
   assert.equal(requests.length,0,action);
  }
  task('question');assert.equal($('ai-consent').checked,false);await $('ask-ai').onclick();assert.equal(requests.length,0);
  $('ai-consent').checked=true;$('ai-question').value='A changed question';$('ai-question').oninput();assert.equal($('ai-consent').checked,false);
  $('ai-consent').checked=true;$('ai-provider').value='claude';$('ai-provider').onchange();assert.equal($('ai-consent').checked,false);assert.match($('ai-consent-copy').textContent,/Claude/);
 }finally{await w.happyDOM.close();}
});

test('question handler revalidates oversized input even when invoked without a DOM input event',async()=>{
 const {w,$,requests}=setup();try{
  await importDocument(w,fixture(2));await $('check-ai').onclick();$('ai-question').value='Q'.repeat(4001);$('ai-consent').checked=true;
  await $('ask-ai').onclick();assert.equal(requests.length,0);assert.match($('notice').textContent,/超过单次范围/);
 }finally{await w.happyDOM.close();}
});

for(const operation of ['translation','summary'])test(`switching away and back cannot revive an active ${operation} batch`,async()=>{
 const {w,$,task,requests}=setup();let release,run;try{
  await importDocument(w,fixture(operation==='summary'?801:65));await $('check-ai').onclick();task(operation);let calls=0;
  w.fetch=async(url,options)=>{calls++;const body=JSON.parse(options.body);await new Promise(resolve=>{release=resolve;});return {ok:true,json:async()=>operation==='summary'?{answer:'Injected batch',citations:[body.segments[0].id],provider:'fixture'}:{translations:body.segments.map(c=>({id:c.id,source_text:c.text,text:'Injected translation'}))}};};
  $('ai-consent').checked=true;run=$(operation==='summary'?'ask-ai':'subscription-translate').onclick();assert.equal(calls,1);
  task('question');task(operation);$('ai-consent').checked=true;release();await run;
  assert.equal(calls,1);assert.equal($('ai-consent').checked,false);assert.match($('ai-progress').textContent,/已停止/);
 }finally{release?.();await run;await w.happyDOM.close();}
});

for(const operation of ['question','translation'])test(`editing a note-only search match refreshes idle ${operation} scope and consent`,async()=>{
 const {w,$,task,requests}=setup();try{
  await importDocument(w,fixture(2));$('mode-transcript').click();task(operation);await $('check-ai').onclick();
  $('search').value='PRIVATE NOTE';$('search').oninput();
  if(operation==='question'){$('ai-filtered').checked=true;$('ai-filtered').onchange();$('ai-question').value='Explain.';}
  const scope=$(operation==='question'?'question-scope':'subscription-translation-scope');assert.equal(scope.dataset.segmentCount,'1');
  w.document.querySelector('.segment .note-button').click();$('ai-consent').checked=true;
  $('note').value='No longer a search match';$('note').dispatchEvent(new w.Event('input'));await Promise.resolve();
  assert.equal(scope.dataset.segmentCount,'0');assert.equal($('ai-consent').checked,false);
  await $(operation==='question'?'ask-ai':'subscription-translate').onclick();assert.equal(requests.length,0);
 }finally{await w.happyDOM.close();}
});

test('same-ID source edits revoke translation consent and refresh its visible plan',async()=>{
 const {w,$,task}=setup();try{
  await importDocument(w,fixture(2));$('mode-transcript').click();task('translation');await $('check-ai').onclick();$('ai-consent').checked=true;
  w.document.querySelector('.segment .edit-button').click();$('edit-segment').value='Changed original source';$('save-edit').click();
  assert.equal($('ai-consent').checked,false);assert.equal($('subscription-translation-scope').dataset.segmentCount,'2');
 }finally{await w.happyDOM.close();}
});
