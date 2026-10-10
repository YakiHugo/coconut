/** Authored sources and injected replies only. No browser, model, CLI or media. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {createRequire} from 'node:module';
import {passageReadingFixture} from './helpers/passage-reading-fixture.mjs';
const C=createRequire(import.meta.url)('../reader/core.js'),root=new URL('../',import.meta.url),KEY='coconut-reader-v1';
function fixture(title='Authored passage questions') {const doc=passageReadingFixture();doc.title=title;doc.segments=doc.segments.slice(0,120);return doc;}
function setup(saved){
 const w=new Window({url:'http://127.0.0.1:8080/'});w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});if(saved)w.localStorage.setItem(KEY,saved);
 w.coconutUpdates={state:async()=>({status:'idle',version:'test',arch:'arm64'}),subscribe:()=>{}};
 const requests=[],reads=[];let release=null,hold=false,answerOverride=null;
 w.fetch=async(url,options)=>{
  if(url.endsWith('language-tools')){reads.push(url);return {ok:true,json:async()=>({ai:{codex:{ready:true},claude:{ready:true}}})};}
  const body=JSON.parse(options.body);requests.push(body);assert.equal(url,'api/ask');
  if(hold)await new Promise(resolve=>{release=resolve;});
  return {ok:true,json:async()=>answerOverride||{answer:'Authored injected answer.',citations:[body.segments[0].id],provider:'fixture'}};
 };
 w.eval(['summary','core','passages','passage-playback','library-store','app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+'\nlet sourceSubmitting=false,sourceCaptionRequest=null;\n'+fs.readFileSync(new URL('reader/updates.js',root),'utf8')+'\nwindow.scopeTest={active:()=>active(),render,flush:()=>libraryStore.flush(),draft:()=>hasLanguageDrafts(),retire:()=>retireLanguageOwners()};');
 const $=id=>w.document.getElementById(id);w.HTMLElement.prototype.scrollIntoView=function(){};
 return {w,$,requests,reads,hold(){hold=true;},release(){release?.();hold=false;},badAnswer(value){answerOverride=value;},close:()=>w.happyDOM.close()};
}
async function load(env,doc=fixture()){const text=JSON.stringify(doc),file=env.$('file');Object.defineProperty(file,'files',{configurable:true,value:[{name:'authored.json',size:text.length,text:async()=>text}]});await file.onchange();return doc;}
function open(env,index=0){env.$('mode-passages').click();env.$('passage-body').querySelectorAll('.passage-ask')[index].click();}
function question(env,text='What does this passage say?'){env.$('ai-question').value=text;env.$('ai-question').oninput();}
function consent(env){env.$('ai-consent').checked=true;env.$('ai-consent').onchange();}
async function prepare(env,index=0){await load(env);open(env,index);await env.$('check-ai').onclick();question(env);consent(env);}
const saved=env=>JSON.parse(env.w.localStorage.getItem(KEY)).documents.find(doc=>doc.key===env.w.sessionStorage.getItem('coconut-reader-active-v1'));
const ids=env=>[...env.$('passage-question-preview').querySelectorAll('[data-cue-id]')].map(node=>node.dataset.cueId);
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('120-cue passage opens exact six-cue source preview, provider, keyboard target and no model request',async()=>{
 const env=setup();try{const source=await load(env);const {$,w}=env;$('ai-provider').value='claude';$('ai-provider').onchange();$('ai-filtered').checked=true;open(env);
  assert.equal($('passage-question-dialog').open,true);assert.equal(w.document.activeElement,$('passage-question-heading'));assert.equal($('ai-provider').value,'claude');
  assert.equal($('ai-request-panel').parentElement,$('passage-question-slot'));assert.equal(w.document.querySelectorAll('#ai-request-panel').length,1);
  assert.deepEqual(ids(env),source.segments.slice(0,6).map(c=>c.id));assert.deepEqual([...$('passage-question-preview').querySelectorAll('.passage-question-original')].map(node=>node.textContent),source.segments.slice(0,6).map(c=>c.text));
  assert.match($('passage-question-source').textContent,/6 个原片段/);assert.match($('passage-question-preview').textContent,/0–0.8 秒/);assert.equal($('question-scope').dataset.segmentCount,'6');
  assert.equal($('ai-filtered').parentElement.hidden,true);assert.equal(env.requests.length,0);assert.equal(env.reads.length,0);
  await $('check-ai').onclick();question(env);await $('ask-ai').onclick();assert.equal(env.requests.length,0);consent(env);await $('ask-ai').onclick();
  assert.deepEqual(env.requests[0].segments,source.segments.slice(0,6).map(({id,text})=>({id,text})));assert.equal(env.requests[0].provider,'claude');
  assert.doesNotMatch(JSON.stringify(env.requests),/导入时已有的笔记|翻译|source_url|speaker|start|end/);
  const answer=saved(env).ai_answers[0];assert.equal(answer.input_snapshot.scope.provider,'claude');assert.equal(answer.input_snapshot.scope.expanded,false);assert.equal(C.answerFreshness(answer,saved(env)),'current');
  assert.deepEqual(answer.input_snapshot.scope.cues,source.segments.slice(0,6).map(({id,start,end,speaker})=>({id,start,end,speaker:speaker??null})));
 }finally{await env.close();}
});

test('explicit neighboring expansion updates all preview/counts and revokes consent without changing reader filters',async()=>{
 const env=setup();try{await prepare(env,1);const {$}=env;$('search').value='A deliberately unmatched filter';
  assert.deepEqual(ids(env),Array.from({length:6},(_,i)=>'split-'+(i+6)));
  $('passage-question-neighbors').checked=true;$('passage-question-neighbors').onchange();assert.equal($('ai-consent').checked,false);assert.equal($('question-scope').dataset.segmentCount,'18');assert.equal(ids(env).length,18);
  await $('ask-ai').onclick();assert.equal(env.requests.length,0);consent(env);await $('ask-ai').onclick();assert.equal(env.requests[0].segments.length,18);assert.equal(saved(env).ai_answers[0].input_snapshot.scope.expanded,true);
  $('passage-question-neighbors').checked=false;$('passage-question-neighbors').onchange();assert.equal($('ai-consent').checked,false);assert.equal($('question-scope').dataset.segmentCount,'6');
  assert.equal($('search').value,'A deliberately unmatched filter');assert.deepEqual(saved(env).ai_answers[0].input_snapshot.scope.passage_ids,Array.from({length:6},(_,i)=>'split-'+(i+6)));
 }finally{await env.close();}
});

test('Escape restores shared general and translation composer, preserves draft, and a quick reopen ignores old close event',async()=>{
 const env=setup();try{await prepare(env);const {$,w}=env;const draft=$('ai-question').value;const event=new w.Event('cancel',{cancelable:true});$('passage-question-dialog').dispatchEvent(event);
  assert.equal(event.defaultPrevented,true);assert.equal($('passage-question-dialog').open,false);assert.equal($('ai-consent').checked,false);assert.equal(w.document.activeElement.className,'passage-ask');
  assert.equal($('ai-request-panel').parentElement,$('ai-request-home'));assert.equal($('ai-history').previousElementSibling,$('ai-request-home'));assert.equal($('ai-question').value,draft);assert.equal($('ai-task').disabled,false);
  open(env,1);await turn();assert.equal($('passage-question-dialog').open,true);assert.equal($('question-scope').dataset.segmentCount,'6');assert.equal($('ai-request-panel').parentElement,$('passage-question-slot'));
  $('close-passage-question').click();$('mode-transcript').click();$('language-panel').open=true;$('ai-task').value='translation';$('ai-task').onchange();assert.equal($('subscription-translate').hidden,false);assert.equal($('ai-filtered').parentElement.hidden,false);assert.equal(env.requests.length,0);
 }finally{await env.close();}
});

for(const change of ['question','provider','language','text','timing','speaker','source','title'])test(`scope revalidates ${change} and cannot send using old confirmation`,async()=>{
 const env=setup();try{await prepare(env);const {$,w}=env,doc=w.scopeTest.active();
  if(change==='question')$('ai-question').value='Changed without an input event';
  if(change==='provider')$('ai-provider').value='claude';
  if(change==='language')$('translation-target').value='ja';
  if(change==='text')doc.segments[0].text+=' changed';if(change==='timing')doc.segments[0].end+=.1;if(change==='speaker')doc.segments[0].speaker='Changed speaker';
  if(change==='source')doc.source_url='https://example.com/changed';if(change==='title')doc.title='Changed title';
  await $('ask-ai').onclick();assert.equal(env.requests.length,0);assert.equal($('ai-consent').checked,false);
  if(['text','timing','speaker','source','title'].includes(change)){assert.equal($('refresh-passage-question').hidden,false);$('refresh-passage-question').click();assert.equal($('refresh-passage-question').hidden,true);}
  consent(env);await $('ask-ai').onclick();assert.equal(env.requests.length,1);
 }finally{await env.close();}
});

test('citation detour returns to the exact expanded scope and newer question draft with no consent',async()=>{
 const env=setup();try{await prepare(env,1);const {$,w}=env;$('passage-question-neighbors').checked=true;$('passage-question-neighbors').onchange();consent(env);await $('ask-ai').onclick();
  const expected=ids(env);question(env,'My newer draft');consent(env);$('ai-answers').querySelector('button').click();
  assert.equal($('passage-question-dialog').open,false);assert.equal($('passage-question-return').hidden,false);assert.equal(w.document.activeElement.dataset.segmentId,'split-0');assert.equal($('ai-consent').checked,false);
  $('return-passage-question').click();assert.equal($('passage-question-dialog').open,true);assert.deepEqual(ids(env),expected);assert.equal($('ai-question').value,'My newer draft');assert.equal($('ai-consent').checked,false);assert.equal(env.requests.length,1);
 }finally{await env.close();}
});

test('history restores exact passage provenance after JSON reload and never labels changed timing current',async()=>{
 const env=setup();let snapshot;try{await prepare(env);await env.$('ask-ai').onclick();snapshot=env.w.localStorage.getItem(KEY);const doc=saved(env),answer=doc.ai_answers[0];
  assert.deepEqual(C.parse(JSON.stringify(doc),'backup.json').ai_answers,[answer]);assert.match(C.aiReadingMarkdown(doc),/范围：问这一段|请求时 00:00/);
  doc.segments[0].end+=1;assert.equal(C.answerFreshness(answer,doc),'stale');
 }finally{await env.close();}
 const restored=setup(snapshot);try{const {$}=restored;$('browse-ai-history').click();assert.match($('ai-answers').textContent,/查看当时的原文与来源/);$('ai-answers').querySelector('button').click();$('return-passage-question').click();assert.equal(ids(restored).length,6);assert.equal(restored.requests.length,0);assert.equal($('ai-consent').checked,false);
 }finally{await restored.close();}
});

for(const reason of ['close','navigation','source-edit','removal','pagehide','native-close','cancel'])test(`late response on ${reason} preserves exact source ownership and newer focus`,async()=>{
 const env=setup();try{await prepare(env);env.hold();const run=env.$('ask-ai').onclick();await turn();assert.equal(env.requests.length,1);const {$,w}=env,doc=w.scopeTest.active();
  if(reason==='close')$('close-passage-question').click();
  if(reason==='cancel')$('stop-question').click();
  if(reason==='navigation')await load(env,fixture('Another document'));
  if(reason==='source-edit'){doc.segments[0].text='Revised source';w.scopeTest.render();}
  if(reason==='removal'){w.dispatchEvent(new w.CustomEvent('coconut-document-retiring',{detail:{key:doc.key,bundle:{}}}));}
  if(reason==='pagehide')w.dispatchEvent(new w.Event('pagehide'));
  if(reason==='native-close'){const owner={id:1,kind:'close',expiresAt:Date.now()+60000};assert.equal(w.coconutPrepareClose('inspect').safe,false);assert.equal(await w.coconutPrepareClose('discard',owner),true);w.coconutPrepareClose('release',owner);}
  const focus=$('ai-question');focus.value='Newer edit stays';focus.focus();env.release();await run;
  assert.equal(doc.ai_answers.length,['close','navigation'].includes(reason)?1:0);assert.equal(focus.value,'Newer edit stays');assert.equal(w.document.activeElement,focus);
 }finally{env.release();await env.close();}
});

test('successful delayed response preserves newer draft, selected provider and focus while saving captured input',async()=>{
 const env=setup();try{await prepare(env);env.hold();const run=env.$('ask-ai').onclick();const {$,w}=env;question(env,'My next question');$('ai-provider').value='claude';$('ai-provider').onchange();$('ai-question').focus();env.release();await run;
  assert.equal($('ai-question').value,'My next question');assert.equal($('ai-provider').value,'claude');assert.equal(w.document.activeElement,$('ai-question'));assert.equal(saved(env).ai_answers[0].question,'What does this passage say?');assert.equal(saved(env).ai_answers[0].input_snapshot.scope.provider,'codex');assert.equal(env.requests.length,1);
 }finally{env.release();await env.close();}
});

test('native draft inspection is source-scoped and does not revoke consent or close the modal',async()=>{
 const env=setup();try{await prepare(env);const {$,w}=env;assert.equal(w.coconutPrepareClose('inspect').safe,false);assert.equal($('ai-consent').checked,true);assert.equal($('passage-question-dialog').open,true);
  await $('ask-ai').onclick();assert.equal(w.scopeTest.draft(),false);$('passage-question-neighbors').checked=true;$('passage-question-neighbors').onchange();assert.equal(w.scopeTest.draft(),true);assert.equal(w.coconutPrepareClose('inspect').safe,false);
 }finally{await env.close();}
});

test('a foreign citation is rejected and source metadata cannot be injected by a model reply',async()=>{
 const env=setup();try{await prepare(env);env.badAnswer({answer:'Invalid answer',citations:['split-119'],input_snapshot:{version:1,segments:[]}});await env.$('ask-ai').onclick();assert.equal(saved(env).ai_answers.length,0);assert.match(env.$('ai-progress').textContent,/引用无效/);
 }finally{await env.close();}
});

test('malformed or out-of-order scoped evidence cannot be treated as current or silently kept in backups',()=>{
 const doc=C.validate(fixture());const scope={kind:'passage',passage_ids:['split-0'],expanded:false,source_title:doc.title,source_url:doc.source_url||'',source_language:doc.language,provider:'codex',answer_language:'zh',cues:[{id:'split-0',start:0,end:.8,speaker:doc.segments[0].speaker??null}]};
 for(const invalid of [{...scope,passage_ids:['missing']},{...scope,cues:[{...scope.cues[0],start:-1}]},{...scope,cues:[{...scope.cues[0],id:'split-1'}]}]){
  const answer={question:'q',answer:'a',citations:['split-0'],input_snapshot:{version:1,segments:[{id:'split-0',text:doc.segments[0].text}],scope:invalid}};assert.equal(C.answerFreshness(answer,doc),'unknown');assert.equal(C.validate({...doc,ai_answers:[answer]}).ai_answers[0].input_snapshot,undefined);
 }
});


test('a general-history citation inside the modal also restores the exact current passage scope',async()=>{
 const env=setup();try{const doc=fixture();doc.ai_answers=[{question:'Older general question',answer:'Authored history',citations:['split-119'],input_snapshot:{version:1,segments:[{id:'split-119',text:doc.segments[119].text}]}}];await load(env,doc);open(env);const {$,w}=env;question(env,'My passage draft');
  $('ai-answers').querySelector('button').click();assert.equal($('passage-question-dialog').open,false);assert.equal(w.document.activeElement.dataset.segmentId,'split-119');assert.equal($('passage-question-return').hidden,false);
  $('return-passage-question').click();assert.equal(ids(env).length,6);assert.equal($('ai-question').value,'My passage draft');$('close-passage-question').click();assert.equal($('mode-passages').getAttribute('aria-pressed'),'true');assert.equal(w.document.activeElement.className,'passage-ask');assert.equal(w.document.activeElement.closest('.passage').dataset.firstCueId,'split-0');
 }finally{await env.close();}
});

test('inserting a new cue inside the captured passage makes historical scope stale',()=>{
 const doc=C.validate(fixture()),cue=doc.segments[0],next=doc.segments[1];const input={version:1,segments:[cue,next].map(({id,text})=>({id,text})),scope:{kind:'passage',passage_ids:[cue.id,next.id],expanded:false,source_title:doc.title,source_url:doc.source_url||'',source_language:doc.language,provider:'codex',answer_language:'zh',cues:[cue,next].map(({id,start,end,speaker})=>({id,start,end,speaker:speaker??null}))}};
 assert.equal(C.answerFreshness({input_snapshot:input},doc),'current');doc.segments.splice(1,0,{id:'inserted',text:'An inserted source cue',start:.1,end:.2,speaker:cue.speaker});assert.equal(C.answerFreshness({input_snapshot:input},doc),'stale');
});


test('disconnected passage request exposes existing local setup without sending or losing its draft',async()=>{
 const env=setup();try{await load(env);open(env);const {$}=env;question(env,'Keep this draft while connecting');assert.equal($('passage-question-connection').hidden,false);assert.match($('passage-question-connection-help').textContent,/本地|Codex/);$('passage-question-setup').click();assert.equal($('passage-question-dialog').open,false);assert.equal($('local-setup').open,true);assert.equal($('ai-question').value,'Keep this draft while connecting');assert.equal(env.requests.length,0);assert.equal($('ai-consent').checked,false);
 }finally{await env.close();}
});

test('queued keyboard-help close cannot steal the source-heading focus of a newer passage question',async()=>{
 const env=setup();try{await load(env);const {$,w}=env;$('keyboard-help-open').focus();$('keyboard-help-open').click();$('keyboard-help').open=false;open(env);assert.equal(w.document.activeElement,$('passage-question-heading'));
  $('keyboard-help').dispatchEvent(new w.Event('close'));assert.equal(w.document.activeElement,$('passage-question-heading'));assert.equal($('passage-question-dialog').open,true);assert.equal(env.requests.length,0);
 }finally{await env.close();}
});


test('a delayed native passage close allows valid background completion without stealing newer reader focus',async()=>{
 const env=setup();try{await prepare(env);env.hold();const run=env.$('ask-ai').onclick();const {$,w}=env;$('passage-question-dialog').open=false;$('passage-body').focus();$('passage-question-dialog').dispatchEvent(new w.Event('close'));
  assert.equal(w.document.activeElement,$('passage-body'));assert.equal($('ai-consent').checked,false);assert.equal($('ai-request-panel').parentElement,$('ai-request-home'));env.release();await run;assert.equal(saved(env).ai_answers.length,1);assert.equal(w.document.activeElement,$('passage-body'));
 }finally{env.release();await env.close();}
});


test('changing the prepared context keeps a sent immutable question and blocks a second request until it finishes',async()=>{
 const env=setup();try{await prepare(env,1);env.hold();const run=env.$('ask-ai').onclick();const {$}=env;$('passage-question-neighbors').checked=true;$('passage-question-neighbors').onchange();assert.equal($('ai-consent').checked,false);assert.equal(ids(env).length,18);consent(env);await $('ask-ai').onclick();assert.equal(env.requests.length,1);
  env.release();await run;assert.equal(saved(env).ai_answers.length,1);assert.equal(saved(env).ai_answers[0].input_snapshot.segments.length,6);assert.equal(saved(env).ai_answers[0].input_snapshot.scope.expanded,false);assert.equal(ids(env).length,18);assert.equal($('ai-consent').checked,false);
 }finally{env.release();await env.close();}
});


test('retiring a newer document composer cannot cancel an unrelated background question',async()=>{
 const env=setup();try{await prepare(env);const first=env.w.scopeTest.active();env.hold();const run=env.$('ask-ai').onclick();await load(env,fixture('Newer unrelated document'));open(env);const second=env.w.scopeTest.active();
  env.w.dispatchEvent(new env.w.CustomEvent('coconut-document-retiring',{detail:{key:second.key,bundle:{}}}));assert.equal(env.$('passage-question-dialog').open,false);env.release();await run;assert.equal(first.ai_answers.length,1);assert.equal(second.ai_answers.length,0);assert.equal(env.$('title').textContent,second.title);
 }finally{env.release();await env.close();}
});

for(const kind of ['local','published'])test(`${kind} audio-only annotations never become passage evidence; attached real captions do`,async()=>{
 const env=setup();try{const source=kind==='local'?{local_media_source:{version:1,kind:'audio',name:'Original.wav',size:64,last_modified:7,type:'audio/wav',fingerprint:'a'.repeat(64)}}:{podcast_source:{kind:'direct_media',media_url:'https://example.org/authored.mp3',media_kind:'audio'}};
  await load(env,{project_kind:'audio_only',title:'Authored audio-only '+kind,...source,project_note:'PRIVATE PROJECT NOTE',timestamp_bookmarks:[{id:'bookmark',time:3,note:'PRIVATE TIMESTAMP NOTE'}],segments:[]});
  const {$,w}=env,key=w.scopeTest.active().key;assert.equal($('passage-body').querySelectorAll('.passage-ask').length,0);await $('check-ai').onclick();question(env);consent(env);await $('ask-ai').onclick();assert.equal(env.requests.length,0);
  $('attach-project-transcript').click();const text=JSON.stringify(fixture('Real authored source'));Object.defineProperty($('project-transcript-file'),'files',{configurable:true,value:[{name:'actual.json',size:text.length,text:async()=>text}]});await $('project-transcript-file').onchange();
  assert.equal(w.scopeTest.active().key,key);assert.equal(w.scopeTest.active().project_note,'PRIVATE PROJECT NOTE');assert.equal(w.scopeTest.active().timestamp_bookmarks[0].note,'PRIVATE TIMESTAMP NOTE');open(env);question(env,'Ask only actual source');consent(env);await $('ask-ai').onclick();
  assert.equal(env.requests.length,1);assert.equal(env.requests[0].segments.length,6);assert.doesNotMatch(JSON.stringify(env.requests),/PRIVATE PROJECT NOTE|PRIVATE TIMESTAMP NOTE/);assert.deepEqual(env.requests[0].segments,fixture().segments.slice(0,6).map(({id,text})=>({id,text})));assert.equal(saved(env).ai_answers[0].input_snapshot.scope.source_title,'Authored audio-only '+kind);
 }finally{await env.close();}
});
