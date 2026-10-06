import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url);
function setup(stored, fetchMock, layout, contextControls=false){
  const window=new Window({url:'https://coconut.example/'});
  window.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
  if(contextControls&&!window.document.getElementById('translation-glossary'))window.document.body.insertAdjacentHTML('beforeend','<textarea id="translation-glossary"></textarea><button id="save-translation-glossary"></button><p id="translation-quality"></p><select id="ai-task"><option value="question">提问</option><option value="summary">整篇摘要</option></select>');
  Object.defineProperty(window,'crypto',{value:webcrypto});
  if(stored!==undefined)window.localStorage.setItem('coconut-reader-v1',stored);
  if(layout!==undefined)window.localStorage.setItem('coconut-reading-layout-v1',layout);
  window.eval(fs.readFileSync(new URL('reader/core.js',root),'utf8'));
  if(fetchMock)window.fetch=fetchMock;
  window.eval(fs.readFileSync(new URL('reader/app.js',root),'utf8') + '\n' + fs.readFileSync(new URL('reader/language.js',root),'utf8') + '\n' + fs.readFileSync(new URL('reader/podcasts.js',root),'utf8') + (fetchMock ? '\n' + fs.readFileSync(new URL('reader/jobs.js',root),'utf8') : ''));
  return window;
}
async function importDocument(w, document) {
  const input=w.document.getElementById('file');
  const text=JSON.stringify(document);
  Object.defineProperty(input,'files',{configurable:true,value:[{name:'backup.json',size:text.length,text:async()=>text}]});
  await input.onchange();
}
test('editing B does not redirect the open A note',async()=>{
  const w=setup();try{
    await w.document.getElementById('sample').onclick();
    let rows=w.document.querySelectorAll('.segment');rows[0].querySelectorAll('button')[1].click();
    const note=w.document.getElementById('note');note.value='First note';note.oninput();
    rows=w.document.querySelectorAll('.segment');rows[1].querySelector('button').click();
    w.document.getElementById('edit-segment').value='Corrected second segment';w.document.getElementById('save-edit').click();
    note.value='Still first note';note.oninput();
    const stored=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];
    assert.equal(stored.notes['demo-1'],'Still first note');assert.equal(stored.notes['demo-2'],undefined);
    assert.equal(stored.segments[1].text,'Corrected second segment');assert.ok(stored.segments[1].original_text);
  }finally{await w.happyDOM.close();}
});
test('damaged saved data remains intact while temporary reading works',async()=>{
  for(const original of ['{broken','{"unexpected":"data"}']){
    const w=setup(original);try{await w.document.getElementById('sample').onclick();
      assert.equal(w.localStorage.getItem('coconut-reader-v1'),original);
      assert.equal(w.document.querySelectorAll('.segment').length,3);
    }finally{await w.happyDOM.close();}
  }
});
test('notes survive restore and can be searched',async()=>{
  const first=setup();let stored;try{
    await first.document.getElementById('sample').onclick();
    first.document.querySelector('.segment').querySelectorAll('button')[1].click();
    const note=first.document.getElementById('note');note.value='My unique memory';note.oninput();
    stored=first.localStorage.getItem('coconut-reader-v1');
  }finally{await first.happyDOM.close();}
  const restored=setup(stored);try{
    const search=restored.document.getElementById('search');search.value='unique memory';search.oninput();
    assert.equal(restored.document.querySelectorAll('.segment').length,1);
    assert.equal(restored.document.querySelector('.saved-note').textContent,'My unique memory');
  }finally{await restored.happyDOM.close();}
});

test('leaving the note editor preserves the pending row click target',async()=>{
 const w=setup();try{
  await w.document.getElementById('sample').onclick();
  w.document.querySelector('.segment').querySelectorAll('button')[1].click();
  const note=w.document.getElementById('note');note.value='Live preview';note.oninput();
  const target=w.document.querySelectorAll('.segment')[1].querySelector('button');
  note.blur();
  assert.ok(target.isConnected,'blur must not replace the pending pointer target');
  target.click();
  assert.ok(w.document.getElementById('edit-dialog').open);
  assert.equal(w.document.querySelector('.saved-note').textContent,'Live preview');
 }finally{await w.happyDOM.close();}
});

test('stale tabs cannot overwrite newer persisted notes',async()=>{
 const w=setup();try{
  await w.document.getElementById('sample').onclick();
  const newest=JSON.parse(w.localStorage.getItem('coconut-reader-v1'));
  newest.documents[0].notes['demo-1']='Newer note from another tab';
  const external=JSON.stringify(newest);w.localStorage.setItem('coconut-reader-v1',external);
  w.document.getElementById('library').querySelector('button').click();
  assert.equal(w.localStorage.getItem('coconut-reader-v1'),external);
  assert.match(w.document.getElementById('notice').textContent,/另一个页面/);
 }finally{await w.happyDOM.close();}
});

test('local source playback activates only with the local worker and seeks to source time',async()=>{
 const id='a'.repeat(32);
 const stored=JSON.stringify({active:'local-doc',documents:[{key:'local-doc',schema_version:1,title:'Local source',source_url:'',source_media:{job_id:id,kind:'audio'},provenance:{kind:'local_asr',model:'small'},notes:{},segments:[{id:'one',start:12,end:15,text:'A verifiable phrase'}]}]});
 const w=setup(stored);try{
  assert.equal(w.document.querySelector('audio'),null);
  assert.match(w.document.getElementById('provenance').textContent,/本机语音识别.*small/);
  w.dispatchEvent(new w.Event('coconut-worker-ready'));
  const player=w.document.querySelector('audio');assert.ok(player);
  assert.equal(player.getAttribute('src'),'/api/jobs/'+id+'/media');
  let played=false;player.play=async()=>{played=true;};
  w.document.querySelector('.time button').click();
  assert.equal(player.currentTime,12);assert.equal(played,true);
  w.document.querySelector('.note-button').click();
  assert.equal(w.document.querySelector('audio'),player,'note edits must not reload the source');
 }finally{await w.happyDOM.close();}
});

test('source dialog saves to its original document even if another import becomes active',async()=>{
 const w=setup();try{
  await w.document.getElementById('sample').onclick();
  const firstKey=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).active;
  w.document.getElementById('source').click();
  await importDocument(w,{title:'Second document',segments:[{start:0,end:1,text:'Second'}]});
  w.document.getElementById('source-url').value='https://www.youtube.com/watch?v=jNQXAC9IVRw';
  w.document.getElementById('save-source').click();
  const stored=JSON.parse(w.localStorage.getItem('coconut-reader-v1'));
  assert.equal(stored.documents.find(d=>d.key===firstKey).source_url,'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  assert.equal(stored.documents.find(d=>d.key===stored.active).source_url,'');
 }finally{await w.happyDOM.close();}
});

test('new import clears the previous document search',async()=>{
 const w=setup();try{
  await w.document.getElementById('sample').onclick();
  const search=w.document.getElementById('search');search.value='absent word';search.oninput();
  await importDocument(w,{title:'Second document',segments:[{start:0,end:1,text:'Second'}]});
  assert.equal(search.value,'');assert.equal(w.document.querySelectorAll('.segment').length,1);
 }finally{await w.happyDOM.close();}
});

test('backup requests a connected download and restores corrections, notes and provenance',async()=>{
 const w=setup();const originalClick=w.HTMLAnchorElement.prototype.click;try{
  await importDocument(w,{title:'A/B',provenance:{kind:'local_asr',model:'small'},source_url:'https://youtu.be/jNQXAC9IVRw',segments:[{id:'one',start:2,end:4,text:'Correction',original_text:'Original'}],notes:{one:'Keep this'}});
  let backup,clicked=false;
  w.URL.createObjectURL=blob=>{backup=blob;return 'blob:https://coconut.example/backup';};
  w.URL.revokeObjectURL=()=>{};
  w.HTMLAnchorElement.prototype.click=function(){assert.ok(this.isConnected);assert.equal(this.download,'A_B.coconut.json');clicked=true;};
  w.document.getElementById('export').onclick();
  assert.ok(clicked);
  const doc=w.Coconut.parse(await backup.text(),'backup.json');
  assert.equal(doc.segments[0].original_text,'Original');assert.equal(doc.segments[0].text,'Correction');
  assert.equal(doc.notes.one,'Keep this');assert.equal(doc.provenance.model,'small');assert.equal(doc.segments[0].start,2);
  assert.match(w.document.getElementById('notice').textContent,/检查.*下载/);
  assert.doesNotMatch(w.document.getElementById('notice').textContent,/已导出/);
  assert.equal(w.document.querySelectorAll('a[download]').length,0);
 }finally{w.HTMLAnchorElement.prototype.click=originalClick;await w.happyDOM.close();}
});

test('failed backup creation keeps the document and gives a retryable error',async()=>{
 const w=setup();try{
  await w.document.getElementById('sample').onclick();const before=w.localStorage.getItem('coconut-reader-v1');
  w.URL.createObjectURL=()=>{throw new Error('unavailable');};
  assert.doesNotThrow(()=>w.document.getElementById('export').onclick());
  assert.match(w.document.getElementById('notice').textContent,/导出.*失败/);
  assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);
 }finally{await w.happyDOM.close();}
});

test('add and reading spaces preserve query, note and unfinished source input',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);
  assert.equal($('add-workspace').hidden,false);assert.equal($('reader-workspace').hidden,true);
  await $('sample').onclick();assert.equal($('add-workspace').hidden,true);
  w.document.querySelector('.note-button').click();$('note').value='Keep my thought';$('note').oninput();
  $('search').value='演示';$('search').oninput();
  $('add-content').click();$('video-url').value='https://youtu.be/example';
  $('back-reading').click();assert.equal($('search').value,'演示');assert.equal($('note').value,'Keep my thought');
  $('add-content').click();assert.equal($('video-url').value,'https://youtu.be/example');
  $('back-reading').click();assert.equal($('reader-workspace').hidden,false);
 }finally{await w.happyDOM.close();}
});

test('search excluding an open note closes stale selection without losing saved text',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();
  w.document.querySelector('.note-button').click();$('note').value='Persist me';$('note').oninput();
  $('search').value='查证';$('search').oninput();
  assert.equal($('notes-panel').hidden,true);assert.equal(w.document.querySelector('.selected'),null);
  $('clear-search').click();w.document.querySelector('.note-button').click();assert.equal($('note').value,'Persist me');
  $('close-note').click();assert.equal($('notes-panel').hidden,true);assert.equal(w.document.activeElement.className,'note-button');
  w.document.querySelector('.note-button').click();w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape'}));
  assert.equal($('notes-panel').hidden,true);
 }finally{await w.happyDOM.close();}
});

test('notes view and return to excerpt clear filters and keep note provenance',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();
  w.document.querySelectorAll('.note-button')[1].click();$('note').value='Reference';$('note').oninput();
  $('filter-notes').click();assert.equal(w.document.querySelectorAll('.segment').length,1);
  $('search').value='Reference';$('search').oninput();$('return-excerpt').click();
  assert.equal($('search').value,'');assert.equal(w.document.querySelectorAll('.segment').length,3);
  assert.equal(w.document.activeElement.dataset.segmentId,'demo-2');assert.equal($('notes-panel').hidden,true);
  assert.equal(JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0].notes['demo-2'],'Reference');
 }finally{await w.happyDOM.close();}
});

test('reading position beyond first page survives reload, backup validation and repeated document navigation',async()=>{
 const w=setup();let stored;try{
  const $=id=>w.document.getElementById(id);
  await importDocument(w,{title:'Long document',segments:Array.from({length:205},(_,i)=>({id:'s'+i,start:i,end:i+1,text:'Part '+i}))});
  [...$('transcript').querySelectorAll('button')].find(b=>b.textContent==='继续阅读后面的片段').click();
  w.document.querySelectorAll('.bookmark-button')[50].click();stored=w.localStorage.getItem('coconut-reader-v1');
  assert.equal(w.Coconut.validate(JSON.parse(stored).documents[0]).readingPosition,'s150');
 }finally{await w.happyDOM.close();}
 const restored=setup(stored);try{
  const $=id=>restored.document.getElementById(id);$('resume').click();
  assert.equal(restored.document.activeElement.dataset.segmentId,'s150');assert.equal(restored.document.querySelectorAll('.segment').length,100);
  await $('sample').onclick();$('library-search').value='Long';$('library-search').oninput();
  assert.equal($('library').querySelectorAll('button').length,1);$('library').querySelector('button').click();
  assert.equal(restored.document.activeElement.dataset.segmentId,'s150');
  $('library').querySelector('button').click();assert.equal(restored.document.activeElement.dataset.segmentId,'s150');
 }finally{await restored.happyDOM.close();}
});

test('static preview hides processing fields; local worker exposes queue without interrupting reading',async()=>{
 for(const connected of [false,true]){
  const w=setup(undefined,async url=>({ok:true,json:async()=>url.endsWith('health')?{local_worker:connected}:{jobs:[{id:'x',title:'Pending',status:'queued',stage:'waiting'}]}}));try{
   const $=id=>w.document.getElementById(id);await $('sample').onclick();
   await new Promise(resolve=>setTimeout(resolve,10));
   assert.equal($('url-form').hidden,!connected);assert.equal($('show-jobs').hidden,!connected);
   assert.equal($('reader-workspace').hidden,false);
   if(connected){assert.equal($('job-count').textContent,'1');$('show-jobs').click();assert.equal($('add-workspace').hidden,false);assert.equal($('jobs').querySelector('button').textContent,'取消');$('back-reading').click();assert.equal($('reader-workspace').hidden,false);}
  }finally{await w.happyDOM.close();}
 }
});

test('worker reconnection recovers controls and cancel/retry/open preserve the active reader',async()=>{
 let connected=false;
 let status='queued';const calls=[];
 const w=setup(undefined,async (url,options)=>{
  calls.push([url,options?.method]);
  if(url.endsWith('health')){if(!connected)throw new Error('offline');return {ok:true,json:async()=>({local_worker:true})};}
  if(url.endsWith('/cancel'))status='cancelled';
  if(url.endsWith('/retry'))status='queued';
  return {ok:true,json:async()=>({jobs:[{id:'job',title:'My import',status,stage:status}]})};
 });try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();
  w.document.querySelector('.note-button').click();$('note').value='Not interrupted';$('note').oninput();
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal($('retry-worker').hidden,false);
  connected=true;await $('retry-worker').onclick();assert.equal($('url-form').hidden,false);
  $('show-jobs').click();await $('jobs').querySelector('button').onclick();
  assert.equal($('jobs').querySelector('button').textContent,'重试');
  await $('jobs').querySelector('button').onclick();assert.equal($('jobs').querySelector('button').textContent,'取消');
  $('back-reading').click();assert.equal($('note').value,'Not interrupted');assert.equal($('notes-panel').hidden,false);
  assert.ok(calls.some(([url,method])=>url.endsWith('/cancel')&&method==='POST'));
  assert.ok(calls.some(([url,method])=>url.endsWith('/retry')&&method==='POST'));
 }finally{await w.happyDOM.close();}
});

test('closing a deleted note reconciles notes-only results without swallowing clicks',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();
  w.document.querySelector('.note-button').click();$('note').value='Temporary';$('note').oninput();$('filter-notes').click();
  $('note').value='';$('note').oninput();const close=$('close-note');$('note').blur();assert.equal(close.isConnected,true);close.click();
  assert.equal($('notes-panel').hidden,true);assert.equal(w.document.querySelectorAll('.segment').length,0);assert.equal($('note-count').textContent,'0');
 }finally{await w.happyDOM.close();}
});

test('local playback takes priority over source URL and highlights the matching cue',async()=>{
 const id='b'.repeat(32);const w=setup();try{
  await importDocument(w,{title:'Video',source_url:'https://x.com/example/status/123',source_media:{job_id:id,kind:'video'},segments:[{id:'a',start:2,end:4,text:'First'},{id:'b',start:5,end:8,text:'Second'}]});
  w.dispatchEvent(new w.Event('coconut-worker-ready'));const player=w.document.querySelector('video');assert.ok(player);
  player.play=async()=>{};w.document.querySelector('.time button').click();assert.equal(player.currentTime,2);assert.equal(w.document.querySelector('.original-source').href,'https://x.com/example/status/123?t=2');
  player.currentTime=6;player.ontimeupdate();assert.equal(w.document.querySelector('.playing').dataset.segmentId,'b');w.document.getElementById('locate-playback').click();assert.equal(w.document.activeElement.dataset.segmentId,'b');
 }finally{await w.happyDOM.close();}
});

test('translation text is searchable, stale translations are labelled after correction',async()=>{
 const w=setup();try{await importDocument(w,{translation_view:'zh',segments:[{id:'a',start:1,end:2,text:'Source',translations:{zh:{text:'唯一译文',source_text:'Source',provider:'local'}}}]});
  const search=w.document.getElementById('search');search.value='唯一译文';search.oninput();assert.equal(w.document.querySelectorAll('.segment').length,1);
  w.document.querySelector('.segment button').click();w.document.getElementById('edit-segment').value='Corrected';w.document.getElementById('save-edit').click();
  search.value='';search.oninput();assert.match(w.document.querySelector('.translation.stale').textContent,/需要重新生成/);
 }finally{await w.happyDOM.close();}
});

test('translation and subscription UI preserve scoped results and explicit consent',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{title:'Bilingual',language:'en',segments:[{id:'a',start:2,end:4,text:'Source'}]});
  let asked=0;
  w.fetch=async(url,options)=>({ok:true,json:async()=>{
   if(url.endsWith('language-tools'))return {ai:{codex:{ready:true,reason:'test subscription'}}};
   const request=JSON.parse(options.body);
   if(url.endsWith('translate'))return {translations:request.segments.map(s=>({...s,text:'译文',source_text:s.text,provider:'local-test'}))};
   asked++;assert.equal(request.provider,'codex');return {answer:'Reading answer',citations:['a'],provider:'chatgpt_subscription'};
  }});
  await $('check-ai').onclick();await $('translate-document').onclick();assert.equal(w.document.querySelector('.translation').textContent,'译文');
  $('ai-question').value='Question';await $('ask-ai').onclick();assert.equal(asked,0);
  $('ai-consent').checked=true;await $('ask-ai').onclick();assert.equal(asked,1);assert.equal($('ai-consent').checked,false);
  const stored=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.equal(stored.ai_answers[0].answer,'Reading answer');assert.equal(stored.segments[0].translations.zh.source_text,'Source');
  $('ai-answers').querySelector('button').click();assert.equal(w.document.activeElement.dataset.segmentId,'a');
 }finally{await w.happyDOM.close();}
});

test('AI filtered scope matches bilingual and notes-only reader filters; edited citations are stale',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{language:'en',notes:{a:'Saved'},segments:[{id:'a',start:1,end:2,text:'Source A',translations:{zh:{text:'中文匹配',source_text:'Source A',provider:'local'}}},{id:'b',start:3,end:4,text:'Source B',translations:{zh:{text:'中文匹配',source_text:'Source B',provider:'local'}}}]});
  let sent;
  w.fetch=async(url,options)=>({ok:true,json:async()=>url.endsWith('language-tools')?{ai:{codex:{ready:true}}}:(sent=JSON.parse(options.body),{answer:'A',citations:['a'],provider:'chatgpt_subscription'})});
  await $('check-ai').onclick();$('filter-notes').click();$('search').value='中文匹配';$('search').oninput();assert.equal(w.document.querySelectorAll('.segment').length,1);
  $('ai-filtered').checked=true;$('ai-consent').checked=true;$('ai-question').value='Q';await $('ask-ai').onclick();assert.deepEqual(sent.segments.map(s=>s.id),['a']);
  $('clear-search').click();w.document.querySelector('.segment button').click();$('edit-segment').value='Updated source';$('save-edit').click();assert.match($('ai-answers').textContent,/依据可能过期/);
 }finally{await w.happyDOM.close();}
});

test('subscription translation pauses after quota failure and resumes only with fresh consent',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{language:'en',segments:Array.from({length:33},(_,i)=>({id:'s'+i,start:i,end:i+1,text:'Source '+i}))});
  let requests=0,fail=true;
  w.fetch=async(url,options)=>{
   if(url.endsWith('language-tools'))return {ok:true,json:async()=>({ai:{codex:{ready:true}}})};
   requests++;const request=JSON.parse(options.body);assert.equal(request.consent,true);
   if(fail&&requests===2)return {ok:false,json:async()=>({error:'quota exhausted'})};
   return {ok:true,json:async()=>({translations:request.segments.map(s=>({id:s.id,text:'译文 '+s.id,source_text:s.text,provider:'chatgpt_subscription_translation'}))})};
  };
  await $('check-ai').onclick();await $('subscription-translate').onclick();assert.equal(requests,0);
  $('ai-consent').checked=true;await $('subscription-translate').onclick();assert.equal(requests,2);assert.equal($('ai-consent').checked,false);
  let doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.equal(doc.segments.filter(s=>s.translations?.zh).length,32);assert.match($('ai-progress').textContent,/quota exhausted/);
  fail=false;await $('subscription-translate').onclick();assert.equal(requests,2);
  $('ai-consent').checked=true;await $('subscription-translate').onclick();assert.equal(requests,3);
  doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.equal(doc.segments.filter(s=>s.translations?.zh).length,33);
 }finally{await w.happyDOM.close();}
});

test('incomplete subscription translation response does not overwrite any old cue translations',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{language:'en',segments:[{id:'a',start:0,end:1,text:'A',translations:{zh:{text:'旧稿',source_text:'A',provider:'local',source_language:'en'}}},{id:'b',start:1,end:2,text:'B'}]});
  w.fetch=async(url)=>({ok:true,json:async()=>url.endsWith('language-tools')?{ai:{codex:{ready:true}}}:{translations:[{id:'a',text:'新稿',source_text:'A'}]}});
  await $('check-ai').onclick();$('ai-consent').checked=true;await $('subscription-translate').onclick();const doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.equal(doc.segments[0].translations.zh.text,'旧稿');assert.equal(doc.segments[1].translations.zh,undefined);
 }finally{await w.happyDOM.close();}
});

test('in-flight subscription translation blocks offline writer and reports captured provider/languages',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{language:'en',segments:[{id:'a',start:0,end:1,text:'Source'}]});
  let finish,offline=0;
  w.fetch=async(url,options)=>{
   if(url.endsWith('language-tools'))return {ok:true,json:async()=>({ai:{codex:{ready:true}}})};
   if(url.endsWith('translate-subscription'))return new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>({translations:[{id:'a',text:'订阅译文',source_text:'Source'}]})});});
   offline++;throw new Error('Offline must not start');
  };
  await $('check-ai').onclick();$('ai-consent').checked=true;const pending=$('subscription-translate').onclick();
  assert.equal($('translate-document').disabled,true);await $('translate-document').onclick();assert.equal(offline,0);
  $('translation-target').value='fr';assert.match($('subscription-translation-scope').textContent,/ChatGPT\/Codex.*英语.*中文/);
  finish();await pending;const doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.equal(doc.segments[0].translations.zh.text,'订阅译文');assert.equal(doc.segments[0].translations.fr,undefined);
 }finally{await w.happyDOM.close();}
});

test('storage conflict stops subsequent subscription batches without overwriting another tab',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{language:'en',segments:Array.from({length:33},(_,i)=>({id:'s'+i,start:i,end:i+1,text:'Source '+i}))});
  let calls=0,external;
  w.fetch=async(url,options)=>({ok:true,json:async()=>{
   if(url.endsWith('language-tools'))return {ai:{codex:{ready:true}}};
   calls++;const doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1'));doc.documents[0].notes.s0='newer tab';external=JSON.stringify(doc);w.localStorage.setItem('coconut-reader-v1',external);
   return {translations:JSON.parse(options.body).segments.map(s=>({id:s.id,text:'译文',source_text:s.text}))};
  }});
  await $('check-ai').onclick();$('ai-consent').checked=true;await $('subscription-translate').onclick();
  assert.equal(calls,1);assert.equal(w.localStorage.getItem('coconut-reader-v1'),external);assert.match($('ai-progress').textContent,/浏览器保存未成功/);
 }finally{await w.happyDOM.close();}
});

test('public setup is actionable and explains separate bookshelf storage',async()=>{
 const w=setup(undefined,async()=>{throw new Error('static page');});try{
  await new Promise(resolve=>setTimeout(resolve,10));const $=id=>w.document.getElementById(id);
  assert.equal($('local-setup').open,false);assert.match($('local-setup').textContent,/git clone[\s\S]*\.\/install.sh[\s\S]*\.\/coconut/);
  assert.match($('local-setup').textContent,/公开预览不会自动连接/);assert.match($('local-setup').textContent,/先在原页面导出/);
  assert.ok($('local-setup').querySelector('a[href="http://127.0.0.1:8080/"]'));
  assert.equal($('process-url').disabled,true);assert.equal($('retry-worker').textContent,'重新检查此页面');
 }finally{await w.happyDOM.close();}
});

test('queue disconnection disables stale actions and restores without resubmission or losing notes',async()=>{
 let queueOnline=true;const calls=[];
 const w=setup(undefined,async(url,options)=>{
  calls.push([url,options?.method]);
  if(url.endsWith('health'))return {ok:true,json:async()=>({local_worker:true})};
  if(url.endsWith('language-tools'))return {ok:true,json:async()=>({ai:{codex:{ready:true},claude:{ready:true}}})};
  if(!queueOnline)throw new Error('Disconnected');
  return {ok:true,json:async()=>({jobs:[{id:'job',title:'Existing job',status:'queued',stage:'waiting'}]})};
 });try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal($('ask-ai').disabled,true);await $('check-ai').onclick();
  w.document.querySelector('.note-button').click();$('note').value='Keep my thought';$('note').oninput();$('ai-consent').checked=true;
  assert.equal($('ask-ai').disabled,false);
  queueOnline=false;await $('retry-worker').onclick();
  assert.equal($('process-url').disabled,true);assert.equal($('import-media').disabled,true);assert.equal($('jobs').querySelector('button').disabled,true);
  assert.match($('worker-status').textContent,/上次任务状态/);assert.equal($('ask-ai').disabled,true);assert.equal($('ai-consent').checked,false);
  $('ai-provider').value='claude';$('ai-provider').onchange();assert.equal($('ask-ai').disabled,true);
  queueOnline=true;await $('retry-worker').onclick();await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal($('process-url').disabled,false);assert.equal($('jobs').querySelector('button').disabled,false);assert.equal($('ai-consent').checked,false);
  assert.equal($('ask-ai').disabled,true,'reconnection needs an explicit CLI check');
  assert.equal($('note').value,'Keep my thought');assert.equal($('reader-workspace').hidden,false);
  assert.equal(calls.some(([,method])=>method==='POST'),false,'reconnection never resubmits a mutation');
 }finally{await w.happyDOM.close();}
});

test('a delayed subscription check cannot revive stale readiness after disconnection',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();let resolve;
  w.fetch=()=>new Promise(done=>{resolve=done;});
  const checking=$('check-ai').onclick();w.dispatchEvent(new w.Event('coconut-worker-disconnected'));
  resolve({ok:true,json:async()=>({ai:{codex:{ready:true}}})});await checking;
  assert.equal($('ask-ai').disabled,true);assert.equal($('translate-document').disabled,true);assert.equal($('check-ai').disabled,true);
 }finally{await w.happyDOM.close();}
});

test('source guidance distinguishes absent media, external time links and actual local seek',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();assert.match($('search-status').textContent,/尚未关联音视频/);
  $('source').click();assert.ok($('source-dialog').open);assert.match($('source-dialog').textContent,/可能不会自动定位/);
  await importDocument(w,{schema_version:1,title:'External',source_url:'https://x.com/example/status/123',segments:[{id:'a',start:251,end:252,text:'Source cue'}]});
  assert.match($('search-status').textContent,/若平台未自动定位/);assert.match(w.document.querySelector('.time a').href,/t=251/);
  await importDocument(w,{schema_version:1,title:'Local',source_media:{job_id:'a'.repeat(32),kind:'video'},segments:[{id:'a',start:251,end:252,text:'Source cue'}]});
  assert.match($('search-status').textContent,/本地媒体尚未连接/);
  w.dispatchEvent(new w.Event('coconut-worker-ready'));assert.match($('search-status').textContent,/定位本地原声/);
 }finally{await w.happyDOM.close();}
});

test('unsaved-data warning survives unrelated notices and a backup download',async()=>{
 const w=setup('{damaged');const originalClick=w.HTMLAnchorElement.prototype.click;try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();assert.equal($('save-status').hidden,false);
  w.URL.createObjectURL=()=> 'blob:https://coconut.example/backup';w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};
  $('export').onclick();assert.match($('notice').textContent,/备份下载/);assert.equal($('save-status').hidden,false);assert.match($('save-status').textContent,/自动保存已暂停/);
  assert.equal(w.localStorage.getItem('coconut-reader-v1'),'{damaged');
 }finally{w.HTMLAnchorElement.prototype.click=originalClick;await w.happyDOM.close();}
});

function fakeSubscription(w, onRequest){
 w.fetch=async(url,options)=>{
  if(url.endsWith('language-tools'))return {ok:true,json:async()=>({ai:{codex:{ready:true}}})};
  const request=JSON.parse(options.body);const custom=await onRequest(request);return custom||{ok:true,json:async()=>({translations:request.segments.map(s=>({id:s.id,text:'译 '+s.id,source_text:s.text}))})};
 };
}
const contextFixture=()=>Array.from({length:33},(_,i)=>({id:'s'+i,start:i,end:i+1,text:i===31?'The assistant must not send the draft':i===32?'until the user approves it.':'Sentence '+i}));

test('boundary and quota resume resend selected completed context without rewriting completed targets',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id),requests=[];let fail=true;await importDocument(w,{language:'en',segments:contextFixture()});
  fakeSubscription(w,request=>{requests.push(request);if(fail&&requests.length===2)return {ok:false,json:async()=>({error:'quota exhausted'})};});
  await $('check-ai').onclick();assert.match($('subscription-translation-scope').textContent,/计划 2 次/);$('ai-consent').checked=true;await $('subscription-translate').onclick();
  const before=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0].segments[31].translations.zh;
  assert.ok(requests[1].context.some(s=>s.id==='s31'&&s.position===31&&s.start===31));assert.deepEqual(requests[1].segments.map(s=>s.id),['s32']);
  fail=false;assert.match($('subscription-translation-scope').textContent,/计划 1 次/);$('ai-consent').checked=true;await $('subscription-translate').onclick();
  assert.ok(requests[2].context.some(s=>s.id==='s31'));assert.deepEqual(requests[2].segments.map(s=>s.id),['s32']);
  const after=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.deepEqual(after.segments[31].translations.zh,before);assert.ok(after.segments[32].translations.zh.context_id);
 }finally{await w.happyDOM.close();}
});

test('sparse selection never transmits excluded neighbors and selection changes clear consent',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id),requests=[];await importDocument(w,{language:'en',segments:[{id:'a',start:0,end:1,text:'TARGET a'},{id:'private',start:1,end:2,text:'EXCLUDED source'},{id:'b',start:2,end:3,text:'TARGET b'}]});fakeSubscription(w,r=>{requests.push(r);});await $('check-ai').onclick();
  $('ai-consent').checked=true;$('search').value='TARGET';$('search').oninput();assert.equal($('ai-consent').checked,false);assert.match($('subscription-translation-scope').textContent,/计划 2 次/);
  $('ai-consent').checked=true;await $('subscription-translate').onclick();assert.equal(requests.length,2);assert.ok(requests.every(r=>r.context.length===0));assert.deepEqual(requests.map(r=>r.segments[0].position),[0,2]);assert.ok(!JSON.stringify(requests).includes('EXCLUDED'));
 }finally{await w.happyDOM.close();}
});

test('editing context-only cue in flight rejects all target writes and marks old dependencies stale',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{language:'en',segments:contextFixture()});let calls=0,finish;
  fakeSubscription(w,request=>{calls++;if(calls===2)return new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>({translations:request.segments.map(s=>({id:s.id,text:'Second window',source_text:s.text}))})});});});
  await $('check-ai').onclick();$('ai-consent').checked=true;const running=$('subscription-translate').onclick();
  while(!finish)await new Promise(r=>setTimeout(r,1));
  w.document.querySelector('[data-segment-id="s31"]').querySelector('button').click();$('edit-segment').value='Changed meaning';$('save-edit').click();finish();await running;
  const doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.equal(doc.segments[32].translations.zh,undefined);assert.match($('ai-progress').textContent,/上下文已修改/);
  assert.equal(w.Coconut.translationCurrent(doc.segments[0],doc,doc.segments[0].translations.zh),false);
 }finally{await w.happyDOM.close();}
});

test('stop finishes current target window only and long-cue request estimate matches execution',async()=>{
 for(const stop of [false,true]){const w=setup();try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{language:'en',segments:Array.from({length:25},(_,i)=>({id:'s'+i,start:i,end:i+1,text:'x'.repeat(4000)}))});let calls=0;
  fakeSubscription(w,r=>{calls++;assert.ok([...r.segments,...r.context].reduce((n,s)=>n+s.text.length,0)<=40000);if(stop)$('stop-subscription-translation').click();});await $('check-ai').onclick();assert.match($('subscription-translation-scope').textContent,/计划 5 次/);$('ai-consent').checked=true;await $('subscription-translate').onclick();
  assert.equal(calls,stop?1:5);const doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.equal(doc.segments.filter(s=>s.translations.zh).length,stop?6:25);if(stop)assert.match($('ai-progress').textContent,/已停止/);
 }finally{await w.happyDOM.close();}}
});

test('offline translation can repair context-stale and legacy subscription outputs',async()=>{
 for(const legacy of [false,true]){const w=setup();try{
  const $=id=>w.document.getElementById(id),contextId='11111111-1111-4111-8111-111111111111';
  const snapshot=[{id:'a',text:'Do not send',position:0,start:0,end:1},{id:'b',text:'until approved',position:1,start:1,end:2}];
  await importDocument(w,{language:'en',translation_view:'zh',translation_contexts:{[contextId]:snapshot},segments:snapshot.map(s=>({...s,text:s.id==='a'?'Changed meaning':s.text,translations:{zh:{text:'旧译文',source_text:s.id==='a'?'Changed meaning':s.text,source_language:'en',provider:'chatgpt_subscription_translation',...(legacy?{}:{context_id:contextId})}}}))});
  let requests=0;w.fetch=async(url,options)=>{
   if(url.endsWith('language-tools'))return {ok:true,json:async()=>({ai:{}})};
   assert.ok(url.endsWith('/translate'));requests++;const request=JSON.parse(options.body);assert.equal(request.segments.length,2);
   return {ok:true,json:async()=>({translations:request.segments.map(s=>({id:s.id,text:'离线新译',source_text:s.text,provider:'local_test'}))})};
  };
  await $('check-ai').onclick();await $('translate-document').onclick();assert.equal(requests,1);assert.equal(w.document.querySelectorAll('.translation.stale').length,0);assert.equal(w.document.querySelectorAll('.translation').length,2);
 }finally{await w.happyDOM.close();}}
});

test('one-click excerpts preserve note-only semantics, reading position and JSON reload',async()=>{
 const w=setup();let stored;try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();
  assert.equal($('export-notebook').disabled,true);
  w.document.querySelectorAll('.bookmark-button')[2].click();
  w.document.querySelectorAll('.excerpt-button')[0].click();
  assert.equal(w.document.querySelector('.excerpted').dataset.segmentId,'demo-1');
  assert.equal(w.document.querySelector('.excerpt-button').getAttribute('aria-pressed'),'true');
  assert.equal(w.document.activeElement.className,'excerpt-button');
  assert.equal($('note-count').textContent,'0');assert.equal($('excerpt-count').textContent,'1');
  assert.equal($('notes-panel').hidden,true);assert.equal($('export-notebook').disabled,false);
  $('filter-notes').click();assert.equal(w.document.querySelectorAll('.segment').length,0);
  $('filter-excerpts').click();assert.equal(w.document.querySelectorAll('.segment').length,1);
  assert.equal($('filter-notes').getAttribute('aria-pressed'),'false');
  stored=w.localStorage.getItem('coconut-reader-v1');
  const doc=w.Coconut.parse(JSON.stringify(JSON.parse(stored).documents[0]),'backup.json');
  assert.equal(doc.segments[0].saved_excerpt,true);assert.equal(doc.readingPosition,'demo-3');
 }finally{await w.happyDOM.close();}
 const restored=setup(stored);try{
  assert.equal(restored.document.getElementById('excerpt-count').textContent,'1');
  restored.document.getElementById('filter-excerpts').click();
  assert.equal(restored.document.querySelector('.segment').dataset.segmentId,'demo-1');
  restored.document.getElementById('resume').click();
  assert.equal(restored.document.querySelectorAll('.segment').length,3);
  assert.equal(restored.document.activeElement.dataset.segmentId,'demo-3');
 }finally{await restored.happyDOM.close();}
});

test('excerpt removal, repeated toggles and correction cancel never erase the note or original cue',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();
  w.document.querySelector('.note-button').click();$('note').value='Keep this note';$('note').oninput();
  const target=w.document.querySelector('.excerpt-button');$('note').blur();assert.ok(target.isConnected);target.click();
  w.document.querySelector('.segment button').click();$('edit-segment').value='Cancelled edit';$('edit-dialog').close();
  assert.doesNotMatch(w.document.querySelector('.words').textContent,/Cancelled/);
  w.document.querySelector('.segment button').click();$('edit-segment').value='Corrected excerpt';$('save-edit').click();
  assert.equal(w.document.querySelector('.excerpt-button').getAttribute('aria-pressed'),'true');
  $('filter-excerpts').click();w.document.querySelector('.excerpt-button').click();
  assert.equal(w.document.querySelectorAll('.segment').length,0);assert.equal($('notes-panel').hidden,true);
  assert.equal(w.document.activeElement.id,'filter-excerpts');assert.equal($('export-notebook').disabled,false);
  $('filter-notes').click();assert.equal(w.document.querySelectorAll('.segment').length,1);assert.equal(w.document.querySelector('.saved-note').textContent,'Keep this note');
  for(let i=0;i<4;i++)w.document.querySelector('.excerpt-button').click();
  const doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];
  assert.equal(doc.segments[0].saved_excerpt,undefined);assert.equal(doc.notes['demo-1'],'Keep this note');
  assert.equal(doc.segments[0].text,'Corrected excerpt');assert.ok(doc.segments[0].original_text);
 }finally{await w.happyDOM.close();}
});

test('excerpt search beyond first page and document switching preserve exact saved identities',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);
  await importDocument(w,{title:'Long excerpt source',segments:Array.from({length:205},(_,i)=>({id:'s'+i,start:i,end:i+1,text:'Part '+i,saved_excerpt:i===150||i===204}))});
  $('filter-excerpts').click();assert.deepEqual([...w.document.querySelectorAll('.segment')].map(r=>r.dataset.segmentId),['s150','s204']);
  $('search').value='204';$('search').oninput();assert.equal(w.document.querySelector('.segment').dataset.segmentId,'s204');
  w.document.querySelector('.note-button').click();$('return-excerpt').click();
  assert.equal(w.document.activeElement.dataset.segmentId,'s204');assert.equal(w.document.querySelectorAll('.segment').length,5);
  await $('sample').onclick();assert.equal($('excerpt-count').textContent,'0');assert.equal($('filter-all').getAttribute('aria-pressed'),'true');
  $('library-search').value='Long excerpt source';$('library-search').oninput();$('library').querySelector('button').click();
  assert.equal($('excerpt-count').textContent,'2');assert.equal($('filter-excerpts').getAttribute('aria-pressed'),'false');
 }finally{await w.happyDOM.close();}
});

test('notebook download includes every kept cue despite search and is only requested on click',async()=>{
 const w=setup();const originalClick=w.HTMLAnchorElement.prototype.click;try{
  let blob,clicks=0;w.URL.createObjectURL=value=>{blob=value;return 'blob:https://coconut.example/notebook';};w.URL.revokeObjectURL=()=>{};
  w.HTMLAnchorElement.prototype.click=function(){assert.ok(this.isConnected);assert.equal(this.download,'Notes_Test.notes.md');clicks++;};
  const $=id=>w.document.getElementById(id);
  await importDocument(w,{title:'Notes/Test',source_url:'https://youtu.be/demo',notes:{note:'Remember me'},segments:[{id:'saved',start:0,end:1,text:'Saved quote',saved_excerpt:true},{id:'note',start:2,end:3,text:'Note source'},{id:'neither',start:4,end:5,text:'Not kept'}]});
  assert.equal(clicks,0);assert.equal($('export-notebook').textContent,'导出阅读笔记（2 段）');
  $('filter-excerpts').click();$('search').value='no match';$('search').oninput();assert.equal(w.document.querySelectorAll('.segment').length,0);
  $('export-notebook').click();const markdown=await blob.text();assert.equal(clicks,1);
  assert.match(markdown,/Saved quote/);assert.match(markdown,/Note source/);assert.match(markdown,/Remember me/);assert.doesNotMatch(markdown,/Not kept/);
  assert.equal(w.document.querySelectorAll('a[download]').length,0);assert.match($('notice').textContent,/检查浏览器下载记录/);
 }finally{w.HTMLAnchorElement.prototype.click=originalClick;await w.happyDOM.close();}
});

test('excerpt storage conflict or quota failure leaves recoverable data with a persistent warning',async()=>{
 for(const failure of ['conflict','quota']){const w=setup();const originalClick=w.HTMLAnchorElement.prototype.click;try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();
  const before=w.localStorage.getItem('coconut-reader-v1');let persisted=before;
  if(failure==='conflict'){persisted=JSON.stringify({active:'external',documents:[]});w.localStorage.setItem('coconut-reader-v1',persisted);}
  else Object.defineProperty(w,'localStorage',{value:{getItem:()=>persisted,setItem:()=>{throw new Error('quota exceeded');}}});
  w.document.querySelector('.excerpt-button').click();assert.equal($('save-status').hidden,false);
  assert.equal(w.localStorage.getItem('coconut-reader-v1'),persisted);
  let backup;w.URL.createObjectURL=blob=>{backup=blob;return 'blob:https://coconut.example/backup';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=()=>{};
  $('export').click();const doc=w.Coconut.parse(await backup.text(),'recover.json');assert.equal(doc.segments[0].saved_excerpt,true);
  assert.equal($('save-status').hidden,false);
  w.URL.createObjectURL=()=>{throw new Error('download unavailable');};$('export-notebook').click();
  assert.match($('notice').textContent,/导出失败/);assert.equal($('save-status').hidden,false);assert.equal(w.document.querySelector('.excerpt-button').getAttribute('aria-pressed'),'true');
 }finally{w.HTMLAnchorElement.prototype.click=originalClick;await w.happyDOM.close();}}
});

test('excerpt filter scopes both AI reading and subscription translation without sending excluded cues',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);const calls=[];
  await importDocument(w,{language:'en',segments:[{id:'a',start:0,end:1,text:'Saved A',saved_excerpt:true},{id:'b',start:1,end:2,text:'Private excluded neighbor'},{id:'c',start:2,end:3,text:'Saved C',saved_excerpt:true}]});
  w.fetch=async(url,options)=>{
   if(url.endsWith('language-tools'))return {ok:true,json:async()=>({ai:{codex:{ready:true}}})};
   const request=JSON.parse(options.body);calls.push({url,request});
   if(url.endsWith('/ask'))return {ok:true,json:async()=>({answer:'A saved insight',citations:['a'],provider:'test'})};
   return {ok:true,json:async()=>({translations:request.segments.map(s=>({id:s.id,text:'译文',source_text:s.text}))})};
  };
  await $('check-ai').onclick();$('filter-excerpts').click();
  assert.match($('subscription-translation-scope').textContent,/当前筛选 2 段/);
  $('ai-filtered').checked=true;$('ai-question').value='Summarize';$('ai-consent').checked=true;await $('ask-ai').onclick();
  assert.deepEqual(calls[0].request.segments.map(s=>s.id),['a','c']);
  $('ai-consent').checked=true;await $('subscription-translate').onclick();
  assert.deepEqual(calls.slice(1).flatMap(c=>c.request.segments.map(s=>s.id)),['a','c']);
  assert.ok(calls.slice(1).every(c=>c.request.context.length===0));
  $('ai-consent').checked=true;w.document.querySelector('.excerpt-button').click();assert.equal($('ai-consent').checked,false);
  assert.match($('subscription-translation-scope').textContent,/当前筛选 1 段/);
 }finally{await w.happyDOM.close();}
});

test('changing filtered versus full-document AI scope revokes consent for both AI actions',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id),calls=[];
  await importDocument(w,{language:'en',segments:[{id:'saved',start:0,end:1,text:'Approved excerpt',saved_excerpt:true},{id:'excluded',start:1,end:2,text:'Excluded neighbor'}]});
  w.fetch=async(url,options)=>{
   if(url.endsWith('language-tools'))return {ok:true,json:async()=>({ai:{codex:{ready:true}}})};
   const request=JSON.parse(options.body);calls.push({url,request});
   if(url.endsWith('/ask'))return {ok:true,json:async()=>({answer:'Insight',citations:['saved'],provider:'test'})};
   return {ok:true,json:async()=>({translations:request.segments.map(s=>({id:s.id,text:'译文',source_text:s.text}))})};
  };
  await $('check-ai').onclick();$('filter-excerpts').click();$('ai-question').value='Summarize';
  $('ai-filtered').checked=true;$('ai-filtered').dispatchEvent(new w.Event('change'));$('ai-consent').checked=true;
  $('ai-filtered').checked=false;$('ai-filtered').dispatchEvent(new w.Event('change'));
  assert.equal($('ai-consent').checked,false,'broadening to the full document needs new consent');
  await $('ask-ai').onclick();await $('subscription-translate').onclick();assert.equal(calls.length,0);
  $('ai-consent').checked=true;$('ai-filtered').checked=true;$('ai-filtered').dispatchEvent(new w.Event('change'));
  assert.equal($('ai-consent').checked,false,'narrowing scope also clears the shared single-request consent');
  await $('ask-ai').onclick();await $('subscription-translate').onclick();assert.equal(calls.length,0);
  $('ai-consent').checked=true;await $('ask-ai').onclick();assert.deepEqual(calls[0].request.segments.map(s=>s.id),['saved']);
  $('ai-consent').checked=true;await $('subscription-translate').onclick();assert.deepEqual(calls[1].request.segments.map(s=>s.id),['saved']);assert.deepEqual(calls[1].request.context,[]);
 }finally{await w.happyDOM.close();}
});

test('changing AI scope invalidates queued subscription batches even if consent is checked again',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id),calls=[];let release;
  await importDocument(w,{language:'en',segments:[...Array.from({length:35},(_,i)=>({id:'s'+i,start:i,end:i+1,text:'Saved '+i,saved_excerpt:true})),{id:'secret',start:35,end:36,text:'Excluded neighbor'}]});
  w.fetch=async(url,options)=>{
   if(url.endsWith('language-tools'))return {ok:true,json:async()=>({ai:{codex:{ready:true}}})};
   const request=JSON.parse(options.body);calls.push(request);
   if(calls.length===1)await new Promise(resolve=>{release=resolve;});
   return {ok:true,json:async()=>({translations:request.segments.map(s=>({id:s.id,text:'译文',source_text:s.text}))})};
  };
  await $('check-ai').onclick();$('filter-excerpts').click();$('ai-consent').checked=true;
  const pending=$('subscription-translate').onclick();assert.equal(calls.length,1);
  $('ai-filtered').checked=true;$('ai-filtered').dispatchEvent(new w.Event('change'));
  assert.equal($('ai-consent').checked,false);$('ai-consent').checked=true;
  release();await pending;
  assert.equal(calls.length,1,'the prior queued plan cannot continue under changed scope');
  assert.ok([...calls[0].segments,...calls[0].context].every(s=>s.id!=='secret'));
  const doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];
  assert.equal(doc.segments.filter(s=>s.translations?.zh).length,32);assert.equal($('ai-consent').checked,false);
 }finally{await w.happyDOM.close();}
});

test('late resume and playback re-renders keep a bounded reading window and active cue',async()=>{
 const segments=Array.from({length:1771},(_,i)=>({id:'long-'+i,start:i*2,end:i*2+2,text:'Transcript cue '+i}));
 const w=setup();try{
  const $=id=>w.document.getElementById(id);
  await importDocument(w,{title:'Long transcript',readingPosition:'long-1750',source_media:{job_id:'a'.repeat(32),kind:'video'},segments});
  w.dispatchEvent(new w.Event('coconut-worker-ready'));
  const player=w.document.querySelector('video');
  player.currentTime=3501;player.ontimeupdate();
  $('resume').click();
  assert.equal(w.document.activeElement.dataset.segmentId,'long-1750');
  assert.ok(w.document.querySelectorAll('.segment').length<=100,'late jumps must not mount all preceding cues');
  assert.equal(w.document.querySelector('.playing')?.dataset.segmentId,'long-1750','paused playback survives rendering');
  w.document.querySelector('[data-segment-id="long-1750"] .note-button').click();
  assert.equal(w.document.querySelector('.playing')?.dataset.segmentId,'long-1750');
  assert.equal(w.document.querySelector('video'),player);
  assert.equal(player.currentTime,3501);
 }finally{await w.happyDOM.close();}
});

test('paging traverses every cue once in both directions and preserves saved notes',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);
  await importDocument(w,{title:'Paged reading',segments:Array.from({length:205},(_,i)=>({id:'p'+i,start:i,end:i+1,text:'Part '+i}))});
  const ids=()=>[...w.document.querySelectorAll('.segment')].map(row=>row.dataset.segmentId);
  assert.equal($('previous-page').disabled,true);
  const visited=[...ids()];
  $('next-page').click();assert.equal(w.document.activeElement.dataset.segmentId,'p100');
  visited.push(...ids());
  w.document.querySelector('.note-button').click();$('note').value='Middle page note';$('note').oninput();$('close-note').click();
  $('next-page').click();visited.push(...ids());
  assert.equal($('next-page').disabled,true);assert.match(w.document.querySelector('.reading-pages').textContent,/201–205 \/ 205/);
  assert.deepEqual(visited,Array.from({length:205},(_,i)=>'p'+i));
  $('previous-page').click();assert.equal(w.document.activeElement.dataset.segmentId,'p100');
  assert.equal(w.document.querySelector('.saved-note').textContent,'Middle page note');
  $('previous-page').click();assert.equal(w.document.activeElement.dataset.segmentId,'p0');assert.equal(ids().length,100);
 }finally{await w.happyDOM.close();}
});

test('search and AI scope include off-page matches while page changes preserve consent',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);
  await importDocument(w,{title:'Full search',language:'en',segments:Array.from({length:305},(_,i)=>({id:'s'+i,start:i,end:i+1,text:(i%2?'Other ':'Match ')+i}))});
  let sent;
  w.fetch=async(url,options)=>({ok:true,json:async()=>url.endsWith('language-tools')?{ai:{codex:{ready:true}}}:(sent=JSON.parse(options.body),{answer:'Cited final match',citations:['s304'],provider:'test'})});
  await $('check-ai').onclick();
  $('search').value='Match';$('search').oninput();
  assert.match($('search-status').textContent,/153 个片段/);
  $('ai-filtered').checked=true;$('ai-filtered').onchange();$('ai-consent').checked=true;
  $('next-page').click();
  assert.equal(w.document.querySelector('.segment').dataset.segmentId,'s200');assert.equal(w.document.querySelectorAll('.segment').length,53);
  assert.equal($('ai-consent').checked,true,'paging does not change the consented matching set');
  $('ai-question').value='What matters?';await $('ask-ai').onclick();
  assert.deepEqual(sent.segments.map(s=>s.id),Array.from({length:153},(_,i)=>'s'+i*2));
  $('ai-answers').querySelector('button').click();
  assert.equal($('search').value,'');assert.equal(w.document.activeElement.dataset.segmentId,'s304');
  assert.equal(w.document.querySelectorAll('.segment').length,5);
  $('search').value='no results';$('search').oninput();assert.equal(w.document.querySelectorAll('.segment').length,0);assert.equal($('next-page'),null);
  $('clear-search').click();assert.equal(w.document.querySelector('.segment').dataset.segmentId,'s0');
 }finally{await w.happyDOM.close();}
});

test('removing the only excerpt on the final page returns to a valid page and keyboard target',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);
  await importDocument(w,{title:'Excerpt pages',segments:Array.from({length:101},(_,i)=>({id:'e'+i,start:i,end:i+1,text:'Excerpt '+i,saved_excerpt:true}))});
  $('filter-excerpts').click();$('next-page').click();
  assert.equal(w.document.querySelectorAll('.segment').length,1);
  w.document.querySelector('.excerpt-button').click();
  assert.equal(w.document.querySelectorAll('.segment').length,100);assert.equal($('next-page'),null);
  assert.equal(w.document.activeElement.closest('.segment').dataset.segmentId,'e0');
  assert.match($('search-status').textContent,/100 个片段/);
  $('filter-all').click();$('next-page').click();
  assert.equal(w.document.querySelector('.segment').dataset.segmentId,'e100');assert.equal(w.document.querySelector('.excerpt-button').getAttribute('aria-pressed'),'false');
 }finally{await w.happyDOM.close();}
});

test('saving a correction returns keyboard focus to the edited cue on a later page',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);
  await importDocument(w,{title:'Keyboard corrections',segments:Array.from({length:205},(_,i)=>({id:'k'+i,start:i,end:i+1,text:'Part '+i}))});
  $('next-page').click();
  const edit=w.document.querySelector('[data-segment-id="k150"] button');
  edit.focus();edit.click();
  $('edit-segment').focus();$('edit-segment').value='Corrected part';$('save-edit').click();
  assert.equal($('edit-dialog').open,false);
  assert.equal(w.document.activeElement.closest('.segment')?.dataset.segmentId,'k150');
  assert.equal(w.document.activeElement.textContent,'修正文字');
  assert.equal(w.document.querySelector('.segment').dataset.segmentId,'k100');
  const saved=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0].segments[150];
  assert.equal(saved.text,'Corrected part');assert.equal(saved.original_text,'Part 150');
 }finally{await w.happyDOM.close();}
});

test('correcting away a search match keeps focus in the remaining results or search',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);
  await importDocument(w,{title:'Filtered corrections',segments:[{id:'a',start:0,end:1,text:'Match one'},{id:'b',start:1,end:2,text:'Match two'}]});
  $('search').value='Match';$('search').oninput();
  for(const expected of ['b',null]){
   const edit=w.document.querySelector('.segment button');edit.focus();edit.click();
   $('edit-segment').focus();$('edit-segment').value='Corrected';$('save-edit').click();
   assert.equal($('search').value,'Match','saving must preserve the reader’s search');
   if(expected)assert.equal(w.document.activeElement.closest('.segment')?.dataset.segmentId,expected);
   else assert.equal(w.document.activeElement,$('search'));
  }
 }finally{await w.happyDOM.close();}
});

test('correction dialog has an accessible heading and initial editor target',async()=>{
 const w=setup();try{
  const dialog=w.document.getElementById('edit-dialog');
  assert.equal(w.document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent,'修正这一段');
  assert.equal(dialog.querySelector('[autofocus]')?.id,'edit-segment');
 }finally{await w.happyDOM.close();}
});

test('correction focus survives the final search page collapsing and a repeated edit',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);
  await importDocument(w,{title:'Search page corrections',segments:Array.from({length:101},(_,i)=>({id:'c'+i,start:i,end:i+1,text:'Match '+i}))});
  $('search').value='Match';$('search').oninput();$('next-page').click();
  w.document.querySelector('.edit-button').click();
  $('edit-segment').value='Rewritten cue';$('save-edit').click();
  assert.equal($('next-page'),null);
  assert.equal(w.document.querySelectorAll('.segment').length,100);
  assert.equal(w.document.activeElement.closest('.segment')?.dataset.segmentId,'c0');
  w.document.activeElement.click();
  $('edit-segment').value='';$('save-edit').click();
  assert.equal($('edit-dialog').open,true);
  assert.equal($('edit-error').textContent,'文字不能为空');
  assert.equal(w.document.querySelector('.words').textContent,'Match 0');
  $('edit-segment').value='Match corrected again';$('save-edit').click();
  assert.equal(w.document.activeElement.closest('.segment')?.dataset.segmentId,'c0');
  assert.equal(w.document.querySelector('.words').textContent,'Match corrected again');
 }finally{await w.happyDOM.close();}
});

test('saved answers track uncited submitted cues through corrections and reload without automatic requests',async()=>{
 const w=setup();let stored,requests=0;
 try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();
  w.fetch=async(url,options)=>({ok:true,json:async()=>{requests++;assert.equal(JSON.parse(options.body).segments.length,3);return {answer:'Saved answer',citations:['demo-1']};}});
  $('ai-question').value='Q';$('ai-consent').checked=true;await $('ask-ai').onclick();
  assert.doesNotMatch($('ai-answers').textContent,/依据可能过期|无法确认/);
  w.document.querySelectorAll('.segment .edit-button')[1].click();$('edit-segment').value='Contradictory uncited context';$('save-edit').click();
  assert.match($('ai-answers').textContent,/依据可能过期/);assert.equal(requests,1);
  stored=w.localStorage.getItem('coconut-reader-v1');
 }finally{await w.happyDOM.close();}
 const restored=setup(stored);try{assert.match(restored.document.getElementById('ai-answers').textContent,/依据可能过期/);}finally{await restored.happyDOM.close();}
});

test('answer evidence follows exact filtered scope, independent of citations, notes, translations and reader window',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);
  const segments=Array.from({length:205},(_,i)=>({id:'s'+i,start:i,end:i+1,text:'Source '+i,...(i%2===0?{saved_excerpt:true}:{}),translations:{zh:{text:'匹配',source_text:'Source '+i,provider:'local'}}}));
  await importDocument(w,{segments});let requests=0,sent;
  w.fetch=async(url,options)=>({ok:true,json:async()=>{requests++;sent=JSON.parse(options.body);return {answer:'No citations answer',citations:[]};}});
  $('filter-excerpts').click();$('search').value='匹配';$('search').oninput();$('ai-filtered').checked=true;$('ai-question').value='Q';$('ai-consent').checked=true;await $('ask-ai').onclick();
  assert.equal(sent.segments.length,103);assert.equal(sent.segments.at(-1).id,'s204');
  let doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.deepEqual(doc.ai_answers[0].input_snapshot.segments,sent.segments);
  assert.doesNotMatch($('ai-answers').textContent,/依据可能过期|无法确认/);
  doc.segments[1].text='Unsent changed';doc.segments[0].translations.zh.text='Revised translation';doc.notes.s0='New note';
  await importDocument(w,doc);assert.doesNotMatch($('ai-answers').textContent,/依据可能过期|无法确认/);
  doc.segments[204].text='Sent but beyond first page changed';await importDocument(w,doc);assert.match($('ai-answers').textContent,/依据可能过期/);assert.equal(requests,1);
 }finally{await w.happyDOM.close();}
});

test('legacy answers are readable but unverified and cannot rerun without consent',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);let requests=0;w.fetch=async()=>{requests++;throw Error('No automatic request');};
  await importDocument(w,{segments:[{id:'a',text:'A',start:0,end:1}],ai_answers:[{question:'Q',answer:'Legacy answer',citations:['a'],source_snapshot:{a:'A'}}]});
  assert.match($('ai-answers').textContent,/Legacy answer/);assert.match($('ai-answers').textContent,/无法确认/);
  $('ai-question').value='Q';await $('ask-ai').onclick();assert.equal(requests,0);
 }finally{await w.happyDOM.close();}
});

test('uncited in-flight edits reject an answer and quota errors leave full evidence recoverable',async()=>{
 for(const quota of [false,true]){
  const w=setup();try{
   const $=id=>w.document.getElementById(id);await $('sample').onclick();let resolve;
   w.fetch=()=>new Promise(r=>resolve=r);$('ai-question').value='Q';$('ai-consent').checked=true;const pending=$('ask-ai').onclick();
   if(quota){const stored=w.localStorage.getItem('coconut-reader-v1');Object.defineProperty(w,'localStorage',{value:{getItem:()=>stored,setItem:()=>{throw Error('QuotaExceededError');}}});}
   else {w.document.querySelectorAll('.segment .edit-button')[1].click();$('edit-segment').value='Changed in flight';$('save-edit').click();}
   resolve({ok:true,json:async()=>({answer:'A',citations:['demo-1']})});await pending;
   if(quota){assert.match($('ai-progress').textContent,/保存未成功/);let backup;w.URL.createObjectURL=b=>{backup=b;return 'blob:backup';};w.URL.revokeObjectURL=()=>{};$('export').onclick();const doc=w.Coconut.parse(await backup.text(),'backup.json');assert.equal(doc.ai_answers[0].input_snapshot.segments.length,3);assert.equal(w.Coconut.answerFreshness(doc.ai_answers[0],doc),'current');}
   else {assert.match($('ai-progress').textContent,/请求期间原文已修改/);assert.equal($('ai-answers').children.length,0);}
  }finally{await w.happyDOM.close();}
 }
});

test('whole bookshelf export and additive recovery retain both documents and report quota failures',async()=>{
 const w=setup();let backup;
 try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();
  await importDocument(w,{title:'Second',segments:[{id:'a',text:'A',start:0,end:1}],notes:{a:'Keep'},readingPosition:'a',ai_answers:[{question:'Q',answer:'A',citations:['a'],input_snapshot:{version:1,segments:[{id:'a',text:'A'}]}}]});
  w.URL.createObjectURL=blob=>{backup=blob;return 'blob:backup';};w.URL.revokeObjectURL=()=>{};$('export-library').click();
  const payload=JSON.parse(await backup.text());assert.equal(payload.documents.length,2);
  const restore=async text=>{Object.defineProperty($('library-file'),'files',{configurable:true,value:[{size:text.length,text:async()=>text}]});await $('library-file').onchange();};
  await restore(JSON.stringify(payload));assert.equal($('library-total').textContent,'2');
  payload.documents[1].title='Changed version';await restore(JSON.stringify(payload));assert.equal($('library-total').textContent,'3');
  assert.match($('ai-answers').textContent,/Q/);assert.equal($('resume').hidden,false);
  payload.documents.push({key:'broken',segments:[]});await restore(JSON.stringify(payload));assert.equal($('library-total').textContent,'3');assert.match($('notice').textContent,/恢复失败/);
  payload.documents.pop();payload.documents[1].title='Quota copy';const old=w.localStorage.getItem('coconut-reader-v1');Object.defineProperty(w,'localStorage',{value:{getItem:()=>old,setItem:()=>{throw Error('quota');}}});
  await restore(JSON.stringify(payload));assert.equal($('library-total').textContent,'4');assert.match($('save-status').textContent,/尚未保存/);assert.doesNotMatch($('notice').textContent,/已恢复/);
 }finally{await w.happyDOM.close();}
});

test('oversized library export refuses to create a backup that recovery cannot accept',async()=>{
 const seed={documents:Array.from({length:501},(_,i)=>({key:'k'+i,title:'Book '+i,segments:[{start:0,end:1,text:'A'}]})),active:'k0'};
 const w=setup(JSON.stringify(seed));try{
  let downloads=0;w.URL.createObjectURL=()=>{downloads++;return 'blob:bad';};
  w.document.getElementById('export-library').click();assert.equal(downloads,0);assert.match(w.document.getElementById('notice').textContent,/逐份文字稿备份/);
 }finally{await w.happyDOM.close();}
});

test('subtitle download exports full document despite active search and handles download failure',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();$('search').value='不会匹配';$('search').oninput();
  let blob;w.URL.createObjectURL=value=>{blob=value;return 'blob:subtitles';};w.URL.revokeObjectURL=()=>{};
  $('subtitle-format').value='vtt';$('export-subtitles').click();assert.equal(w.Coconut.parse(await blob.text(),'export.vtt').segments.length,3);assert.match($('notice').textContent,/3 段/);
  w.URL.createObjectURL=()=>{throw Error('blocked');};$('export-subtitles').click();assert.match($('notice').textContent,/导出失败/);
 }finally{await w.happyDOM.close();}
});

test('document details persist and target the document that opened the dialog',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{title:'Original',language:'it',segments:[{id:'a',start:0,end:1,text:'A'}],notes:{a:'Keep'}});
  const key=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).active;
  $('document-details').click();assert.equal($('document-language').value,'it');$('document-title').value=' ';$('save-details').click();assert.equal($('details-dialog').open,true);
  await importDocument(w,{title:'Other',segments:[{start:0,end:1,text:'B'}]});$('document-title').value='<New title>'; $('document-language').value='en';$('save-details').click();
  const stored=JSON.parse(w.localStorage.getItem('coconut-reader-v1'));const doc=stored.documents.find(d=>d.key===key);
  assert.equal(doc.title,'<New title>');assert.equal(doc.language,'en');assert.equal(doc.notes.a,'Keep');assert.equal($('title').textContent,'Other');assert.equal($('library').querySelector('New'),null);
  $('library-search').value='new title';$('library-search').oninput();assert.equal($('library').children.length,1);$('library').firstElementChild.click();assert.equal($('title').textContent,'<New title>');
  $('document-details').click();$('document-title').value='Not saved';$('details-dialog').close();assert.equal($('title').textContent,'<New title>');
 }finally{await w.happyDOM.close();}
});

test('time navigation leaves filters and opens the correct long transcript page without network',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{segments:Array.from({length:205},(_,i)=>({id:'s'+i,start:i*2,end:i*2+1,text:'Cue '+i}))});
  let requests=0;w.fetch=()=>{requests++;throw Error('No requests');};$('filter-notes').click();$('reading-time').value='6:41';$('time-navigation').dispatchEvent(new w.Event('submit',{cancelable:true}));
  assert.equal(w.document.activeElement.dataset.segmentId,'s200');assert.equal($('filter-all').getAttribute('aria-pressed'),'true');assert.match($('time-navigation-status').textContent,/已定位/);assert.equal(requests,0);
  $('reading-time').value='99:00';$('time-navigation').dispatchEvent(new w.Event('submit',{cancelable:true}));assert.match($('time-navigation-status').textContent,/超出/);
  $('reading-time').value='1:99';$('time-navigation').dispatchEvent(new w.Event('submit',{cancelable:true}));assert.match($('time-navigation-status').textContent,/请输入/);
 }finally{await w.happyDOM.close();}
});


test('reading comfort persists independently of books and handles unknown or unavailable storage',async()=>{
 let saved,library;const w=setup();try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();library=w.localStorage.getItem('coconut-reader-v1');
  $('reading-layout').value='spacious';$('reading-layout').onchange();assert.equal(w.document.documentElement.dataset.readingLayout,'spacious');
  saved=w.localStorage.getItem('coconut-reading-layout-v1');assert.equal(w.localStorage.getItem('coconut-reader-v1'),library);
  Object.defineProperty(w,'localStorage',{value:{setItem:()=>{throw Error('blocked');}}});$('reading-layout').value='large';$('reading-layout').onchange();assert.equal(w.document.documentElement.dataset.readingLayout,'large');assert.match($('layout-status').textContent,/未能保存/);
 }finally{await w.happyDOM.close();}
 for(const [value,expected] of [[saved,'spacious'],['url(javascript:evil)','standard']]){
  const restored=setup(library,undefined,value);try{assert.equal(restored.document.documentElement.dataset.readingLayout,expected);assert.equal(restored.document.getElementById('reading-layout').value,expected);}finally{await restored.happyDOM.close();}
 }
});

test('local playback controls clamp seeks, retain speed across renders and stay hidden without media',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();assert.equal($('playback-controls').hidden,true);
  await importDocument(w,{title:'Audio',source_media:{job_id:'a'.repeat(32),kind:'audio'},segments:[{start:0,end:20,text:'A'}]});w.dispatchEvent(new w.Event('coconut-worker-ready'));
  const player=w.document.querySelector('audio');assert.equal($('playback-controls').hidden,false);assert.equal($('skip-back').disabled,true);
  Object.defineProperty(player,'duration',{value:20,configurable:true});player.onloadedmetadata();assert.equal($('skip-back').disabled,false);
  player.currentTime=3;$('skip-back').click();assert.equal(player.currentTime,0);player.currentTime=18;$('skip-forward').click();assert.equal(player.currentTime,20);
  $('playback-rate').value='1.5';$('playback-rate').onchange();assert.equal(player.playbackRate,1.5);assert.equal(player.defaultPlaybackRate,1.5);assert.equal(w.localStorage.getItem('coconut-playback-rate-v1'),'1.5');
  player.playbackRate=1;player.onloadedmetadata();assert.equal(player.playbackRate,1.5);assert.equal($('playback-rate').value,'1.5');
  player.playbackRate=.5;player.onratechange();assert.equal($('playback-rate').value,'0.5');player.onloadedmetadata();

  w.document.querySelector('.note-button').click();assert.equal(w.document.querySelector('audio'),player);assert.equal(player.playbackRate,1.5);
  await importDocument(w,{title:'Another audio',source_media:{job_id:'b'.repeat(32),kind:'audio'},segments:[{start:0,end:1,text:'B'}]});assert.equal(w.document.querySelector('audio').playbackRate,1.5);
  await $('sample').onclick();assert.equal($('playback-controls').hidden,true);assert.equal($('skip-back').disabled,true);
 }finally{await w.happyDOM.close();}
});

test('repeat listening respects cue bounds and clears on skip, repeated click and document switch',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{title:'Loop',source_media:{job_id:'a'.repeat(32),kind:'audio'},segments:[{id:'a',start:2,end:4,text:'A'},{id:'b',start:4,end:8,text:'B'}]});w.dispatchEvent(new w.Event('coconut-worker-ready'));
  const player=w.document.querySelector('audio');Object.defineProperty(player,'duration',{value:10});player.play=async()=>{};player.onloadedmetadata();
  const button=w.document.querySelector('.repeat-button');button.click();assert.equal(player.currentTime,2);assert.equal(button.getAttribute('aria-pressed'),'true');
  player.currentTime=4.1;player.ontimeupdate();assert.equal(player.currentTime,2);assert.equal($('stop-repeat').hidden,false);
  button.click();assert.equal($('stop-repeat').hidden,true);player.currentTime=5;player.ontimeupdate();assert.equal(player.currentTime,5);
  button.click();$('skip-forward').click();assert.equal($('stop-repeat').hidden,true);assert.equal(player.currentTime,10);
  button.click();await $('sample').onclick();assert.equal($('stop-repeat').hidden,true);assert.equal($('repeat-status').textContent,'');
 }finally{await w.happyDOM.close();}
});

test('failed repeat playback resets controls without restarting media automatically',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{source_media:{job_id:'a'.repeat(32),kind:'audio'},segments:[{start:0,end:2,text:'A'}]});w.dispatchEvent(new w.Event('coconut-worker-ready'));
  const player=w.document.querySelector('audio');const button=w.document.querySelector('.repeat-button');button.click();assert.match($('repeat-status').textContent,/等待/);
  Object.defineProperty(player,'duration',{value:2});player.play=async()=>{throw Error('blocked');};button.click();await Promise.resolve();await Promise.resolve();assert.equal($('stop-repeat').hidden,true);assert.equal(button.getAttribute('aria-pressed'),'false');
 }finally{await w.happyDOM.close();}
});

test('events from a detached media player cannot restart a new source loop',async()=>{
 const w=setup();try{
  const doc=letter=>({title:letter,source_media:{job_id:letter.repeat(32),kind:'audio'},segments:[{start:0,end:5,text:letter}]});
  await importDocument(w,doc('a'));w.dispatchEvent(new w.Event('coconut-worker-ready'));const old=w.document.querySelector('audio');
  await importDocument(w,doc('b'));const player=w.document.querySelector('audio');Object.defineProperty(player,'duration',{value:5});let plays=0;player.play=async()=>{plays++;};
  w.document.querySelector('.repeat-button').click();player.currentTime=3;old.onended();old.ontimeupdate();assert.equal(player.currentTime,3);assert.equal(plays,1);
 }finally{await w.happyDOM.close();}
});

test('literal search highlights text safely and navigates all matches across page boundaries',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{segments:Array.from({length:205},(_,i)=>({id:'s'+i,start:i,end:i+1,text:'Cue <tag> [a.*] '+i}))});
  $('search').value='[a.*]';$('search').oninput();assert.equal(w.document.querySelectorAll('.words mark').length,100);assert.equal(w.document.querySelector('tag'),null);assert.equal(w.document.querySelector('.words mark').textContent,'[a.*]');
  $('previous-match').click();assert.equal(w.document.activeElement.dataset.segmentId,'s204');assert.equal(w.document.querySelectorAll('.segment').length,5);assert.match($('match-position').textContent,/205 \/ 205/);
  $('next-match').click();assert.equal(w.document.activeElement.dataset.segmentId,'s0');assert.match($('match-position').textContent,/1 \/ 205/);
  $('search').value='not present';$('search').oninput();assert.equal($('next-match').disabled,true);assert.match($('match-position').textContent,/0 \/ 0/);
  $('clear-search').click();assert.equal($('search-navigation').hidden,true);assert.equal(w.document.querySelectorAll('mark').length,0);
 }finally{await w.happyDOM.close();}
});

test('AI reading report exports all saved answers independently of current filtering without requests',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();assert.equal($('export-ai-reading').disabled,true);
  await importDocument(w,{title:'Report',segments:[{id:'a',start:0,end:1,text:'A'}],ai_answers:[{question:'First Q',answer:'First A',citations:['a']},{question:'Second Q',answer:'Second A',citations:[]}]});
  $('search').value='missing';$('search').oninput();let blob,requests=0;w.fetch=()=>{requests++;throw Error('No request');};w.URL.createObjectURL=value=>{blob=value;return 'blob:report';};w.URL.revokeObjectURL=()=>{};
  assert.equal($('export-ai-reading').disabled,false);$('export-ai-reading').click();const output=await blob.text();assert.match(output,/First Q/);assert.match(output,/Second Q/);assert.equal(requests,0);
  w.URL.createObjectURL=()=>{throw Error('blocked');};$('export-ai-reading').click();assert.match($('notice').textContent,/导出失败/);assert.equal($('ai-answers').children.length,2);
 }finally{await w.happyDOM.close();}
});

test('metadata language corrections update translation selection and revoke pending consent without requests',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{title:'Book',language:'en',provenance:{language:'en'},segments:[{start:0,end:1,text:'A'}]});assert.equal($('translation-source').value,'en');
  let requests=0;w.fetch=()=>{requests++;throw Error('No automatic request');};$('translation-source').value='ja';$('translation-source').onchange();
  $('document-details').click();$('document-title').value='Renamed';$('save-details').click();assert.equal($('translation-source').value,'ja','renaming alone preserves explicit source choice');
  $('ai-consent').checked=true;$('document-details').click();$('document-language').value='fr';$('save-details').click();assert.equal($('translation-source').value,'fr');assert.equal($('ai-consent').checked,false);
  $('document-details').click();$('document-language').value='';$('save-details').click();assert.equal($('translation-source').value,'');assert.equal(requests,0);
 }finally{await w.happyDOM.close();}
});

test('changing metadata language stops later offline translation batches while retaining completed work',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{language:'en',segments:Array.from({length:33},(_,i)=>({id:'s'+i,start:i,end:i+1,text:'Source '+i}))});
  w.fetch=async()=>({ok:true,json:async()=>({ai:{}})});await $('check-ai').onclick();
  let resolve,body,requests=0;w.fetch=async(url,options)=>{requests++;body=JSON.parse(options.body);return new Promise(r=>resolve=r);};
  const pending=$('translate-document').onclick();$('document-details').click();$('document-language').value='fr';$('save-details').click();
  resolve({ok:true,json:async()=>({translations:body.segments.map(s=>({id:s.id,source_text:s.text,text:'Draft '+s.id,provider:'mock'}))})});await pending;
  assert.equal(requests,1);assert.equal($('translation-source').value,'fr');assert.match($('language-status').textContent,/已停止后续批次/);
  const stored=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.equal(stored.segments[0].translations.zh.source_language,'en');assert.equal(stored.segments[32].translations.zh,undefined);
 }finally{await w.happyDOM.close();}
});

test('independent metadata language revocation stops prior subscription plan',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id),calls=[];let release;
  await importDocument(w,{language:'en',segments:[...Array.from({length:35},(_,i)=>({id:'s'+i,start:i,end:i+1,text:'Saved '+i,saved_excerpt:true})),{id:'secret',start:35,end:36,text:'Excluded neighbor'}]});
  w.fetch=async(url,options)=>{
   if(url.endsWith('language-tools'))return {ok:true,json:async()=>({ai:{codex:{ready:true}}})};
   const request=JSON.parse(options.body);calls.push(request);
   if(calls.length===1)await new Promise(resolve=>{release=resolve;});
   return {ok:true,json:async()=>({translations:request.segments.map(s=>({id:s.id,text:'译文',source_text:s.text}))})};
  };
  await $('check-ai').onclick();$('filter-excerpts').click();$('ai-consent').checked=true;
  const pending=$('subscription-translate').onclick();assert.equal(calls.length,1);
  $('document-details').click();$('document-language').value='fr';$('save-details').click();
  assert.equal($('ai-consent').checked,false);$('ai-consent').checked=true;
  release();await pending;
  assert.equal(calls.length,1,'the prior queued plan cannot continue under changed scope');
  assert.ok([...calls[0].segments,...calls[0].context].every(s=>s.id!=='secret'));
  const doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];
  assert.equal(doc.segments.filter(s=>s.translations?.zh).length,32);assert.equal($('ai-consent').checked,false);
 }finally{await w.happyDOM.close();}
});

test('finished transcript stays readable and missing optional playback can be retried explicitly',async()=>{
 const calls=[];let status='done';
 const w=setup(undefined,async(url,options={})=>{
  calls.push([url,options.method]);
  if(url.endsWith('health'))return {ok:true,json:async()=>({local_worker:true})};
  if(url.endsWith('/retry'))status='queued';
  return {ok:true,json:async()=>({jobs:[{id:'job',title:'Saved transcript',status,stage:status,playback_retryable:status==='done'}]})};
 });try{
  await new Promise(r=>setTimeout(r,20));
  const buttons=[...w.document.getElementById('jobs').querySelectorAll('button')];
  assert.deepEqual(buttons.map(b=>b.textContent),['打开阅读','重试本地视频']);
  assert.match(w.document.getElementById('jobs').textContent,/复用已完成的文字稿/);
  assert.equal(calls.filter(([url])=>url.endsWith('/retry')).length,0);
  await buttons[1].onclick();
  assert.equal(calls.filter(([url,method])=>url.endsWith('/retry')&&method==='POST').length,1);
  assert.equal(w.document.getElementById('jobs').querySelector('button').textContent,'取消');
 }finally{await w.happyDOM.close();}
});

test('unchanged queue polls preserve task buttons and keyboard focus',async()=>{
 const w=setup(undefined,async url=>({ok:true,json:async()=>url.endsWith('health')?{local_worker:true}:{jobs:[{id:'job',title:'Pending',status:'queued',stage:'waiting',updated:Date.now()}]}}));
 try{
  await new Promise(r=>setTimeout(r,20));
  w.document.getElementById('show-jobs').click();const button=w.document.getElementById('jobs').querySelector('button');button.focus();
  await w.document.getElementById('retry-worker').onclick();
  assert.ok(w.document.getElementById('jobs').querySelector('button')===button);
  assert.equal(w.document.activeElement,button);
 }finally{await w.happyDOM.close();}
});

test('task actions remain single flight across queue refresh and recover after failure',async()=>{
 let release,pending,requests=0,stage='waiting';
 const w=setup(undefined,async url=>{
  if(url.endsWith('/cancel')){requests++;await new Promise(resolve=>release=resolve);throw new Error('temporary failure');}
  return {ok:true,json:async()=>url.endsWith('health')?{local_worker:true}:{jobs:[{id:'job',title:'Pending',status:'queued',stage}]}};
 });try{
  await new Promise(r=>setTimeout(r,20));
  const old=w.document.getElementById('jobs').querySelector('button');pending=old.onclick();
  stage='new progress';await w.document.getElementById('retry-worker').onclick();
  const refreshed=w.document.getElementById('jobs').querySelector('button');
  assert.equal(refreshed.disabled,true);
  await refreshed.onclick();assert.equal(requests,1);
  release();await pending;
  assert.equal(w.document.getElementById('jobs').querySelector('button').disabled,false);
  assert.match(w.document.getElementById('notice').textContent,/temporary failure/);
 }finally{release?.();await pending;await w.happyDOM.close();}
});

test('queue progress preserves focused action and removed actions land on their task row',async()=>{
 let status='running',stage='starting',jobs=true;
 const w=setup(undefined,async url=>({ok:true,json:async()=>url.endsWith('health')?{local_worker:true}:{jobs:jobs?[{id:'job',title:'Import',status,stage}]:[]}}));
 try{
  await new Promise(r=>setTimeout(r,20));
  w.document.getElementById('show-jobs').click();w.document.getElementById('jobs').querySelector('button').focus();
  stage='recognizing';await w.document.getElementById('retry-worker').onclick();
  assert.equal(w.document.activeElement.textContent,'取消');
  status='done';stage='Ready';await w.document.getElementById('retry-worker').onclick();
  assert.equal(w.document.activeElement.dataset.jobId,'job');
  assert.equal(w.document.activeElement.getAttribute('tabindex'),'-1');
  w.document.getElementById('video-url').focus();stage='Ready again';await w.document.getElementById('retry-worker').onclick();
  assert.equal(w.document.activeElement.id,'video-url','background refresh must not steal unrelated focus');
  jobs=false;await w.document.getElementById('retry-worker').onclick();assert.equal(w.document.getElementById('jobs').children.length,0);
 }finally{await w.happyDOM.close();}
});

test('older queue responses and errors cannot undo the newest action result',async()=>{
 for(const oldFails of [false,true]){
  let listCalls=0,release,ready;
  const waiting=new Promise(resolve=>ready=resolve);
  const w=setup(undefined,async url=>{
   if(url.endsWith('health'))return {ok:true,json:async()=>({local_worker:true})};
   if(url.endsWith('/cancel'))return {ok:true,json:async()=>({status:'cancelled'})};
   if(url.endsWith('jobs')){
    const call=++listCalls;
    if(call===2){ready();await new Promise(resolve=>release=resolve);if(oldFails)throw new Error('old request offline');}
    const status=call>=3?'cancelled':'running';
    return {ok:true,json:async()=>({jobs:[{id:'job',title:'Import',status,stage:status}]})};
   }
   return {ok:true,json:async()=>({})};
  });let oldPoll;
  try{
   await new Promise(r=>setTimeout(r,20));
   oldPoll=w.document.getElementById('retry-worker').onclick();await waiting;
   await w.document.getElementById('jobs').querySelector('button').onclick();
   release();await oldPoll;
   const button=w.document.getElementById('jobs').querySelector('button');
   assert.equal(button.textContent,'重试');assert.equal(button.disabled,false);
   assert.equal(w.document.getElementById('worker-status').textContent,'本地处理服务已连接');
  }finally{release?.();await oldPoll;await w.happyDOM.close();}
 }
});

test('Chinese reading canvas keeps essential content visible and secondary tools in disclosures',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);
  const ids=[...w.document.querySelectorAll('[id]')].map(node=>node.id);
  assert.equal(new Set(ids).size,ids.length,'each existing control needs one unambiguous target');
  assert.equal($('export-menu').hidden,true);
  await $('sample').onclick();
  assert.equal($('export-menu').hidden,false);
  for(const id of ['export-menu','reading-settings','language-panel','local-setup'])assert.equal($(id).open,false);
  for(const id of ['title','provenance','search','filter-all','transcript'])assert.equal($(id).closest('details'),null,id+' must remain on the main canvas');
  for(const id of ['document-details','source','reading-layout','reading-time'])assert.equal($(id).closest('details').id,'reading-settings');
  for(const id of ['export','export-notebook','export-subtitles','subtitle-format','subtitle-bilingual'])assert.equal($(id).closest('details').id,'export-menu');
  assert.match($('search-status').textContent,/阅读设置/);
  for(const id of ['import-language','document-language','translation-source','translation-target','translation-view']){
   const label=$(id).querySelector('option[value="en"]').textContent;
   assert.match(label,/英语/);assert.doesNotMatch(label,/English/);
  }
 }finally{await w.happyDOM.close();}
});

test('export disclosure dismisses independently of an open note and restores keyboard focus',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();
  w.document.querySelector('.note-button').click();$('note').value='Keep this note';$('note').oninput();
  $('export-menu').open=true;$('export').focus();
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape'}));
  assert.equal($('export-menu').open,false);assert.equal($('notes-panel').hidden,false);
  assert.equal(w.document.activeElement,$('export-menu').querySelector('summary'));
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape'}));
  assert.equal($('notes-panel').hidden,true);
  assert.equal(JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0].notes['demo-1'],'Keep this note');
  $('export-menu').open=true;$('search').click();assert.equal($('export-menu').open,false);
  $('export-menu').open=true;$('add-content').click();assert.equal($('export-menu').open,false);assert.equal($('export-menu').hidden,true);
  $('back-reading').click();assert.equal($('export-menu').hidden,false);assert.equal($('export-menu').open,false);
 }finally{await w.happyDOM.close();}
});

test('opening reading settings is local and preserves search, notes and document data',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();let calls=0;w.fetch=async()=>{calls++;throw new Error('must not request');};
  $('search').value='时间戳';$('search').oninput();
  const before=w.localStorage.getItem('coconut-reader-v1');
  $('reading-settings').open=true;$('reading-layout').value='large';$('reading-layout').onchange();
  $('reading-settings').open=false;
  assert.equal($('search').value,'时间戳');assert.equal(calls,0);assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);
  $('reading-settings').open=true;$('document-details').click();assert.equal($('details-dialog').open,true);
 }finally{await w.happyDOM.close();}
});

test('setup disclosure stays user-controlled while public requests stay disabled',async()=>{
 const w=setup(undefined,async()=>{throw new Error('static page');});try{
  await new Promise(resolve=>setTimeout(resolve,10));const $=id=>w.document.getElementById(id);
  assert.equal($('local-setup').open,false);assert.equal($('url-form').hidden,true);assert.equal($('process-url').disabled,true);
  $('local-setup').open=true;await $('retry-worker').onclick();assert.equal($('local-setup').open,true);
  $('local-setup').open=false;await $('retry-worker').onclick();assert.equal($('local-setup').open,false);
  await $('sample').onclick();$('language-setup').click();
  assert.equal($('add-workspace').hidden,false);assert.equal($('local-setup').open,true);
  assert.equal(w.document.activeElement,$('local-setup').querySelector('summary'));
 }finally{await w.happyDOM.close();}
});

test('adding content focuses the video link only when the local form is available',async()=>{
 const w=setup(undefined,async url=>({ok:true,json:async()=>url.endsWith('health')?{local_worker:true}:url.endsWith('jobs')?{jobs:[]}:{ai:{}}}));try{
  await new Promise(resolve=>setTimeout(resolve,10));const $=id=>w.document.getElementById(id);
  await $('sample').onclick();$('add-content').click();
  assert.equal($('url-form').hidden,false);assert.equal(w.document.activeElement,$('video-url'));
  assert.equal(w.document.querySelector('.import-settings').open,false);
  assert.equal($('keep-media').checked,true);assert.equal($('force-asr').checked,false);
 }finally{await w.happyDOM.close();}
});

test('successful export clicks keep the disclosure and keyboard focus available',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();
  w.document.querySelector('.excerpt-button').click();
  w.URL.createObjectURL=()=> 'blob:https://coconut.example/download';w.URL.revokeObjectURL=()=>{};
  let downloads=0;
  w.document.addEventListener('click',event=>{if(event.target.matches?.('a[download]')){downloads++;event.preventDefault();}});
  for(const id of ['export','export-subtitles','export-notebook']){
   $('export-menu').open=true;$(id).focus();$(id).click();
   assert.equal($('export-menu').open,true,id+' must not treat a generated download as a dismissal');
   assert.equal(w.document.activeElement,$(id));assert.equal(w.document.querySelector('a[download]'),null);
  }
  assert.equal(downloads,3,'exercise real bubbling link clicks rather than replacing anchor.click');
  $('title').click();assert.equal($('export-menu').open,false);
  assert.equal(w.document.activeElement,$('export-menu').querySelector('summary'));
  $('export-menu').open=true;$('export').focus();$('search').focus();$('search').click();
  assert.equal($('export-menu').open,false);assert.equal(w.document.activeElement,$('search'));
 }finally{await w.happyDOM.close();}
});

test('summary is the first reading mode and never relabels saved questions as summaries',async()=>{
 const w=setup();try{
  await importDocument(w,{title:'Podcast',segments:[{id:'one',start:0,end:10,text:'Original statement'}],ai_answers:[{question:'A question',answer:'A question answer',citations:['one']}]});
  const $=id=>w.document.getElementById(id);
  assert.equal($('summary-workspace').hidden,false);assert.equal($('transcript-layout').hidden,true);
  assert.equal($('summary-state').textContent,'未生成');assert.equal($('summary-body').textContent,'');
  $('summary-open-transcript').click();assert.equal($('transcript-layout').hidden,false);assert.equal($('summary-workspace').hidden,true);
  $('mode-summary').click();assert.equal($('summary-workspace').hidden,false);
  $('prepare-summary').click();assert.equal($('language-panel').open,true);assert.equal($('ai-task').value,'summary');assert.equal($('ai-consent').checked,false);
 }finally{await w.happyDOM.close();}
});

test('saved summary citations return to source and edits mark the summary stale',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);
  await importDocument(w,{title:'Podcast',segments:[{id:'one',start:0,end:10,text:'Original'}],ai_answers:[{purpose:'summary',question:'Summary',answer:'<img src=x> Main point',citations:['one'],provider:'codex',input_snapshot:{version:1,segments:[{id:'one',text:'Original'}]}}]});
  assert.equal($('summary-body').textContent,'<img src=x> Main point');assert.equal($('summary-body').querySelector('img'),null);
  assert.match($('summary-state').textContent,/已保存/);$('summary-citations').querySelector('button').click();
  assert.equal($('transcript-layout').hidden,false);assert.equal(w.document.activeElement.dataset.segmentId,'one');
  w.document.querySelector('.edit-button').click();$('edit-segment').value='Changed';$('save-edit').click();
  $('mode-summary').click();assert.equal($('summary-state').textContent,'原文有更新');assert.match($('summary-body').textContent,/Main point/);
 }finally{await w.happyDOM.close();}
});

test('static Web attaches audio and video without a worker, upload or persisted media URL',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);let calls=0,revoked=[];
  w.fetch=async()=>{calls++;throw new Error('No uploads permitted');};
  w.URL.createObjectURL=()=>`blob:https://coconut.example/local-${calls++}`;w.URL.revokeObjectURL=url=>revoked.push(url);
  await $('sample').onclick();$('mode-transcript').click();
  $('attach-reader-media').click();
  Object.defineProperty($('reader-media-file'),'files',{configurable:true,value:[{name:'episode.mp3',type:'audio/mpeg',size:10,slice:()=>({text:async()=> 'ID3 audio'})}]});
  await $('reader-media-file').onchange();
  const audio=w.document.querySelector('#source-media audio');assert.ok(audio);assert.match(audio.src,/^blob:/);
  assert.equal(calls,1,'only local object URL creation, no fetch');
  assert.doesNotMatch(w.localStorage.getItem('coconut-reader-v1'),/blob:|episode.mp3/);
  $('attach-reader-media').click();Object.defineProperty($('reader-media-file'),'files',{configurable:true,value:[{name:'episode.mp4',type:'video/mp4',size:10,slice:()=>({text:async()=> 'ftyp video'})}]});await $('reader-media-file').onchange();
  assert.ok(w.document.querySelector('#source-media video'));assert.equal(revoked.length,1);
  $('detach-reader-media').click();assert.equal(w.document.querySelector('#source-media video'),null);assert.equal(revoked.length,2);
 }finally{await w.happyDOM.close();}
});

test('media selection belongs to the document that opened the picker, with cancellation safe',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);w.URL.createObjectURL=()=> 'blob:https://coconut.example/selected';w.URL.revokeObjectURL=()=>{};
  await $('sample').onclick();$('attach-reader-media').click();
  await importDocument(w,{title:'Another',segments:[{start:0,end:1,text:'Other'}]});
  Object.defineProperty($('reader-media-file'),'files',{configurable:true,value:[{name:'episode.wav',type:'audio/wav',size:10,slice:()=>({text:async()=> 'RIFF WAVE'})}]});await $('reader-media-file').onchange();
  assert.equal(w.document.querySelector('audio'),null);$('library').querySelector('button').click();assert.ok(w.document.querySelector('audio'));
  const audio=w.document.querySelector('audio');$('attach-reader-media').click();Object.defineProperty($('reader-media-file'),'files',{configurable:true,value:[]});await $('reader-media-file').onchange();assert.equal(w.document.querySelector('audio'),audio);
 }finally{await w.happyDOM.close();}
});

test('lightweight bridge enables local agents without media jobs or Python processing',async()=>{
 const calls=[];
 const w=setup(undefined,async path=>{calls.push(path);return {ok:true,json:async()=>path==='api/health'?{local_worker:false,capabilities:{local_agents:true,media_import:false}}:{local_translation:false,ai:{codex:{ready:false,reason:'CLI unavailable'}}}};});
 try{
  await new Promise(resolve=>setTimeout(resolve,25));
  const $=id=>w.document.getElementById(id);
  assert.match($('worker-status').textContent,/轻量本地服务/);assert.equal($('url-form').hidden,true);assert.equal($('import-media').disabled,true);assert.equal($('show-jobs').hidden,true);assert.ok(!calls.includes('api/jobs'));
 }finally{await w.happyDOM.close();}
});

test('reselecting a playing document pauses hidden media and playlist inputs are rejected',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);let objects=0;w.URL.createObjectURL=()=> 'blob:https://coconut.example/'+(++objects);w.URL.revokeObjectURL=()=>{};
  await $('sample').onclick();$('attach-reader-media').click();
  Object.defineProperty($('reader-media-file'),'files',{configurable:true,value:[{name:'episode.mp3',type:'audio/mpeg',size:10,slice:()=>({text:async()=> 'ID3 audio'})}]});await $('reader-media-file').onchange();
  const player=w.document.querySelector('audio');let pauses=0;player.pause=()=>pauses++;player.play=async()=>{};Object.defineProperty(player,'duration',{value:68,configurable:true});w.document.querySelector('.repeat-button').click();assert.equal($('stop-repeat').hidden,false);
  $('library').querySelector('button').click();assert.equal($('summary-workspace').hidden,false);assert.ok(pauses>0);assert.equal($('stop-repeat').hidden,true);
  $('attach-reader-media').click();Object.defineProperty($('reader-media-file'),'files',{configurable:true,value:[{name:'disguised.mp3',type:'audio/mpeg',size:10,slice:()=>({text:async()=> '#EXTM3U\nhttps://example.org/remote.ts'})}]});await $('reader-media-file').onchange();
  assert.equal(objects,1);assert.match($('notice').textContent,/播放列表/);assert.equal(w.document.querySelector('audio'),player);
 }finally{await w.happyDOM.close();}
});

test('glossary save and contextual translation send only matching terms and persist review warnings',async()=>{
 const w=setup(undefined,undefined,undefined,true);try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{language:'en',segments:[{id:'a',start:0,end:3,speaker:'Speaker A',text:'Coconut sends 12 requests.'}]});
  const requests=[];w.fetch=async(url,options)=>({ok:true,json:async()=>{
   if(url.endsWith('language-tools'))return {local_translation:false,ai:{codex:{ready:true}}};
   const request=JSON.parse(options.body);requests.push(request);return {translations:request.segments.map(s=>({id:s.id,source_text:s.text,text:'Coconut 发送20次请求',quality_warnings:['numbers_changed'],input_revision:'a'.repeat(64)}))};
  }});
  await $('check-ai').onclick();assert.equal($('translate-document').disabled,true);await $('translate-document').onclick();assert.equal(requests.length,0);
  $('translation-glossary').value='Coconut = Coconut\nsecret = 隐藏术语';$('translation-glossary').oninput();$('ai-consent').checked=true;
  await $('subscription-translate').onclick();assert.equal(requests.length,0,'unsaved glossary cannot be sent accidentally');
  $('save-translation-glossary').click();assert.equal($('ai-consent').checked,false);$('ai-consent').checked=true;await $('subscription-translate').onclick();
  assert.deepEqual(requests[0].glossary,[{source:'Coconut',target:'Coconut'}]);assert.equal(requests[0].segments[0].speaker,'Speaker A');
  const doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.equal(doc.segments[0].translations.zh.context_version,2);assert.deepEqual(doc.segments[0].translations.zh.quality_warnings,['numbers_changed']);
  assert.match($('translation-quality').textContent,/1 段自动核对提示/);
  $('translation-glossary').value='Coconut = 椰子';$('translation-glossary').oninput();$('save-translation-glossary').click();
  assert.match(w.document.querySelector('.translation.stale').textContent,/需要重新生成/);assert.equal(requests.length,1);
 }finally{await w.happyDOM.close();}
});

test('editing saved glossary during an in-flight request prevents all target writes',async()=>{
 const w=setup(undefined,undefined,undefined,true);try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{language:'en',segments:[{id:'a',start:0,end:2,text:'Coconut works.'}]});
  let release;w.fetch=async(url,options)=>url.endsWith('language-tools')?{ok:true,json:async()=>({ai:{codex:{ready:true}}})}:new Promise(resolve=>{const request=JSON.parse(options.body);release=()=>resolve({ok:true,json:async()=>({translations:request.segments.map(s=>({id:s.id,source_text:s.text,text:'译文'}))})});});
  await $('check-ai').onclick();$('ai-consent').checked=true;const pending=$('subscription-translate').onclick();
  $('translation-glossary').value='Coconut = 椰子';$('translation-glossary').oninput();$('save-translation-glossary').click();release();await pending;
  const doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.equal(doc.segments[0].translations.zh,undefined);assert.match($('ai-progress').textContent,/本批全部不保存/);
 }finally{await w.happyDOM.close();}
});

test('summary task revokes consent and sends entire source despite reading filters',async()=>{
 const w=setup(undefined,undefined,undefined,true);try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{language:'en',segments:[{id:'a',start:0,end:1,text:'Selected source'},{id:'b',start:1,end:2,text:'Other source'}]});
  let sent;w.fetch=async(url,options)=>({ok:true,json:async()=>url.endsWith('language-tools')?{ai:{codex:{ready:true}}}:(sent=JSON.parse(options.body),{answer:'基于原文的摘要',citations:['a','b'],provider:'chatgpt_subscription'})});
  await $('check-ai').onclick();$('search').value='Selected';$('search').oninput();$('ai-filtered').checked=true;$('ai-consent').checked=true;$('ai-task').value='summary';$('ai-task').onchange();
  assert.equal($('ai-consent').checked,false);assert.equal($('ai-filtered').checked,false);assert.equal($('ai-filtered').disabled,true);assert.equal(sent,undefined);
  $('ai-consent').checked=true;await $('ask-ai').onclick();assert.deepEqual(sent.segments.map(s=>s.id),['a','b']);assert.match(sent.question,/完整原文/);assert.equal(sent.language,'zh');
  const doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.equal(doc.ai_answers[0].purpose,'summary');assert.deepEqual(doc.ai_answers[0].input_snapshot.segments.map(s=>s.id),['a','b']);
 }finally{await w.happyDOM.close();}
});

test('oversize summaries are blocked before consent and even manual invocation sends no request',async()=>{
 for(const segments of [
  Array.from({length:5001},(_,i)=>({id:'s'+i,start:i,end:i+1,text:i?'Other cue':'Unique selected source'})),
  [{id:'s0',start:0,end:1,text:'Unique selected source'},{id:'s1',start:1,end:2,text:'a'.repeat(250000)}]
 ]){
  const w=setup();try{
   const $=id=>w.document.getElementById(id);const sent=[];
   w.fetch=async(url,options)=>({ok:true,json:async()=>url.endsWith('language-tools')?{ai:{codex:{ready:true}}}:(sent.push(JSON.parse(options.body)),{answer:'Answer about the selected source only',citations:['s0'],provider:'test'})});
   await importDocument(w,{title:'Oversize source',language:'en',segments});
   assert.equal($('prepare-summary').disabled,true);assert.equal($('summary-readiness').hidden,false);assert.match($('summary-readiness').textContent,/整篇摘要暂不可用/);
   assert.equal($('ai-consent').checked,false);assert.equal(sent.length,0);
   $('ai-consent').checked=true;$('prepare-summary').onclick();
   assert.equal($('ai-consent').checked,false);assert.equal($('ai-task').value,'question','blocked preparation must not open a summary consent flow');
   await $('check-ai').onclick();$('ai-task').value='summary';$('ai-task').onchange();
   assert.equal($('ask-ai').disabled,true);assert.equal($('ai-request-readiness').hidden,false);assert.equal($('ai-select-excerpt').hidden,false);
   await $('ask-ai').onclick();assert.match($('notice').textContent,/整篇摘要暂不可用/,'size warning precedes consent prompt');
   $('ai-consent').checked=true;await $('ask-ai').onclick();assert.equal(sent.length,0);assert.equal($('ai-consent').checked,false);
   $('ai-select-excerpt').click();assert.equal($('ai-task').value,'question');assert.equal($('ai-filtered').checked,true);assert.equal($('ai-filtered').disabled,false);assert.equal($('transcript-layout').hidden,false);assert.equal($('ai-request-readiness').hidden,true);
   $('search').value='Unique selected';$('search').oninput();$('ai-question').value='What does this selected passage say?';$('ai-consent').checked=true;
   await $('ask-ai').onclick();assert.equal(sent.length,1);assert.deepEqual(sent[0].segments.map(s=>s.id),['s0']);
   const doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.equal(doc.ai_answers[0].purpose,'question');assert.equal(w.Coconut.latestSummary(doc),null);
   await importDocument(w,{title:'Short source',language:'en',segments:[{id:'new',start:0,end:1,text:'A valid summary source'}]});
   assert.equal($('prepare-summary').disabled,false);assert.equal($('summary-readiness').hidden,true);assert.equal($('summary-select-excerpt').hidden,true);
  }finally{await w.happyDOM.close();}
 }
});

test('imported glossary equality and quote terms survive unchanged UI saves',async()=>{
 const w=setup(undefined,undefined,undefined,true);try{
  const $=id=>w.document.getElementById(id),terms=[{source:'a = b',target:'a 等于 b'},{source:'say "hi"',target:'说“嗨”'},{source:'path\\name',target:'路径 = 名称'}];
  await importDocument(w,{language:'en',translation_glossary:{zh:terms},segments:[{start:0,end:1,text:'a = b'}]});
  $('save-translation-glossary').click();
  const doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.deepEqual(doc.translation_glossary.zh,terms);
 }finally{await w.happyDOM.close();}
});

test('changing AI task latches stop for active translation even if shared consent is rechecked',async()=>{
 const w=setup(undefined,undefined,undefined,true);try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{language:'en',segments:Array.from({length:33},(_,i)=>({id:'s'+i,start:i,end:i+1,text:'Fragment '+i}))});
  let release,requests=0;w.fetch=async(url,options)=>url.endsWith('language-tools')?{ok:true,json:async()=>({ai:{codex:{ready:true}}})}:new Promise(resolve=>{requests++;const request=JSON.parse(options.body);release=()=>resolve({ok:true,json:async()=>({translations:request.segments.map(s=>({id:s.id,source_text:s.text,text:'译文'}))})});});
  await $('check-ai').onclick();$('ai-consent').checked=true;const pending=$('subscription-translate').onclick();
  $('ai-task').value='summary';$('ai-task').onchange();$('ai-consent').checked=true;release();await pending;assert.equal(requests,1);assert.match($('ai-progress').textContent,/已停止/);
 }finally{await w.happyDOM.close();}
});

test('saved translation review flags stay visible next to valid text and in notebook export',async()=>{
 const w=setup();try{
  await importDocument(w,{title:'Review flags',language:'en',translation_view:'zh',notes:{a:'Keep'},segments:[{id:'a',start:0,end:1,text:'12 requests',translations:{zh:{text:'20 次请求',source_text:'12 requests',source_language:'en',document_language:'en',provider:'local',quality_warnings:['numbers_changed']}}}]});
  assert.match(w.document.querySelector('.translation-review').textContent,/数字/);
  const doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.match(w.Coconut.notebookMarkdown(doc),/译文待核对：.*数字/);
 }finally{await w.happyDOM.close();}
});

test('startup and reconnect do not probe local CLI until the user clicks check',async()=>{
 const calls=[];const w=setup(undefined,async path=>{calls.push(path);return {ok:true,json:async()=>path==='api/health'?{local_worker:false,capabilities:{local_agents:true,media_import:false}}:{local_translation:false,ai:{}}};});
 try{
  await new Promise(resolve=>setTimeout(resolve,20));const $=id=>w.document.getElementById(id);
  assert.deepEqual(calls,['api/health']);assert.equal($('check-ai').disabled,false);
  w.dispatchEvent(new w.Event('coconut-worker-disconnected'));w.dispatchEvent(new w.CustomEvent('coconut-worker-ready',{detail:{media_import:false}}));
  assert.deepEqual(calls,['api/health']);await $('check-ai').onclick();assert.deepEqual(calls,['api/health','api/language-tools']);
 }finally{await w.happyDOM.close();}
});

test('a generated summary is never labeled saved after browser persistence fails',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);await importDocument(w,{title:'Quota',language:'en',segments:[{id:'a',start:0,end:1,text:'Source'}]});
  w.fetch=async url=>({ok:true,json:async()=>url.endsWith('language-tools')?{ai:{codex:{ready:true}}}:{answer:'Generated test summary',citations:['a'],provider:'test'}});
  await $('check-ai').onclick();$('ai-task').value='summary';$('ai-task').onchange();$('ai-consent').checked=true;
  const before=w.localStorage.getItem('coconut-reader-v1');Object.defineProperty(w,'localStorage',{value:{getItem:()=>before,setItem:()=>{throw new Error('QuotaExceededError');}}});
  await $('ask-ai').onclick();assert.equal($('summary-state').dataset.state,'unsaved');assert.match($('summary-state').textContent,/请备份/);assert.match($('summary-status').textContent,/尚未保存/);assert.equal($('summary-body').textContent,'Generated test summary');assert.ok(!before.includes('Generated test summary'));
 }finally{await w.happyDOM.close();}
});

test('replacing a full service with a lightweight bridge removes stale processing capabilities',async()=>{
 let lightweight=false;const calls=[];
 const w=setup(undefined,async path=>{calls.push(path);if(path==='api/health')return {ok:true,json:async()=>lightweight?{local_worker:false,capabilities:{local_agents:true,media_import:false}}:{local_worker:true}};return lightweight?{ok:false,json:async()=>({error:'No processing queue'})}:{ok:true,json:async()=>({jobs:[{id:'old',title:'Old queued job',status:'queued',stage:'queued'}]})};});
 try{
  await new Promise(resolve=>setTimeout(resolve,20));const $=id=>w.document.getElementById(id);assert.equal($('import-media').disabled,false);
  lightweight=true;await new Promise(resolve=>setTimeout(resolve,3200));assert.equal($('import-media').disabled,true);
  await $('retry-worker').onclick();assert.equal($('url-form').hidden,true);assert.equal($('jobs').hidden,true);assert.equal($('show-jobs').hidden,true);assert.equal($('import-media').disabled,true);assert.match($('worker-status').textContent,/轻量/);assert.ok(calls.filter(p=>p==='api/health').length>=2);assert.ok(!calls.includes('api/language-tools'));
 }finally{await w.happyDOM.close();}
});

test('caption-only is the default submitted permission and conflicting force-ASR requires opting in',async()=>{
 const submitted=[];
 const w=setup(undefined,async(url,options)=>{
  if(options?.method==='POST')submitted.push(JSON.parse(options.body));
  return {ok:true,json:async()=>url.endsWith('health')?{local_worker:true}:{jobs:[]}};
 });try{
  await new Promise(resolve=>setTimeout(resolve,10));const $=id=>w.document.getElementById(id);
  assert.equal($('captions-only').checked,true);assert.equal($('force-asr').checked,false);assert.equal($('force-asr').disabled,true);
  $('video-url').value='https://x.com/example/status/123';
  await $('url-form').onsubmit({preventDefault(){}});
  assert.equal(submitted[0].options.captions_only,true);assert.equal(submitted[0].options.force_transcribe,false);
  $('captions-only').checked=false;$('captions-only').onchange();
  assert.equal($('force-asr').disabled,false);assert.match($('asr-option-help').textContent,/已允许.*首次可能下载模型/);
  $('force-asr').checked=true;await $('url-form').onsubmit({preventDefault(){}});
  assert.equal(submitted[1].options.captions_only,false);assert.equal(submitted[1].options.force_transcribe,true);
  $('captions-only').checked=true;$('captions-only').onchange();
  assert.equal($('force-asr').checked,false);assert.equal($('force-asr').disabled,true);
  await $('url-form').onsubmit({preventDefault(){}});
  assert.equal(submitted[2].options.captions_only,true);assert.equal(submitted[2].options.force_transcribe,false);
 }finally{await w.happyDOM.close();}
});

test('caption-only prevents a local media selection from silently starting recognition',async()=>{
 const uploads=[];const w=setup(undefined,async(url,options)=>{
  if(options?.method==='POST')uploads.push(url);
  return {ok:true,json:async()=>url.endsWith('health')?{local_worker:true}:{jobs:[]}};
 });try{
  await new Promise(resolve=>setTimeout(resolve,10));const $=id=>w.document.getElementById(id);let choices=0;
  $('media-file').click=()=>choices++;
  $('import-media').onclick();assert.equal(choices,0);assert.match($('notice').textContent,/取消.*仅使用现成字幕/);
  assert.equal(w.document.querySelector('.import-settings').open,true);assert.equal(w.document.activeElement,$('captions-only'));assert.equal($('captions-only').checked,true);
  Object.defineProperty($('media-file'),'files',{configurable:true,value:[{name:'sample.mp4',size:10}]});
  await $('media-file').onchange();assert.deepEqual(uploads,[]);
  $('captions-only').checked=false;$('captions-only').onchange();$('import-media').onclick();assert.equal(choices,1);
  await $('media-file').onchange();assert.equal(uploads.length,1);
 }finally{await w.happyDOM.close();}
});


test('leaving reading stops repeat before late media events can replay hidden audio',async()=>{
 const w=setup();try{
  const $=id=>w.document.getElementById(id);
  await importDocument(w,{title:'Hidden loop',source_media:{job_id:'a'.repeat(32),kind:'audio'},segments:[{id:'a',start:2,end:4,text:'A'}]});
  w.dispatchEvent(new w.Event('coconut-worker-ready'));$('mode-transcript').click();
  const player=w.document.querySelector('audio');let plays=0;player.play=async()=>{plays++;};player.pause=()=>{};Object.defineProperty(player,'duration',{value:10});
  w.document.querySelector('.repeat-button').click();assert.equal(plays,1);
  $('add-content').click();assert.equal($('stop-repeat').hidden,true);assert.equal($('reader-workspace').hidden,true);
  player.currentTime=4.2;player.onended();player.ontimeupdate();assert.equal(plays,1);assert.equal(player.currentTime,4.2);
 }finally{await w.happyDOM.close();}
});
