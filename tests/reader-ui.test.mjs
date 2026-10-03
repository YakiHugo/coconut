import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url);
function setup(stored, fetchMock){
  const window=new Window({url:'https://coconut.example/'});
  window.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
  Object.defineProperty(window,'crypto',{value:webcrypto});
  if(stored!==undefined)window.localStorage.setItem('coconut-reader-v1',stored);
  window.eval(fs.readFileSync(new URL('reader/core.js',root),'utf8'));
  if(fetchMock)window.fetch=fetchMock;
  window.eval(fs.readFileSync(new URL('reader/app.js',root),'utf8') + '\n' + fs.readFileSync(new URL('reader/language.js',root),'utf8') + (fetchMock ? '\n' + fs.readFileSync(new URL('reader/jobs.js',root),'utf8') : ''));
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
 const w=setup();try{
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
 }finally{await w.happyDOM.close();}
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
  w.document.querySelectorAll('.bookmark-button')[150].click();stored=w.localStorage.getItem('coconut-reader-v1');
  assert.equal(w.Coconut.validate(JSON.parse(stored).documents[0]).readingPosition,'s150');
 }finally{await w.happyDOM.close();}
 const restored=setup(stored);try{
  const $=id=>restored.document.getElementById(id);$('resume').click();
  assert.equal(restored.document.activeElement.dataset.segmentId,'s150');assert.equal(restored.document.querySelectorAll('.segment').length,200);
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
  $('translation-target').value='fr';assert.match($('subscription-translation-scope').textContent,/ChatGPT\/Codex.*English.*中文/);
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
  assert.equal($('local-setup').open,true);assert.match($('local-setup').textContent,/git clone[\s\S]*\.\/install.sh[\s\S]*\.\/coconut/);
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
  w.document.querySelector('.note-button').click();$('note').value='Keep my thought';$('note').oninput();$('ai-consent').checked=true;
  assert.equal($('ask-ai').disabled,false);
  queueOnline=false;await $('retry-worker').onclick();
  assert.equal($('process-url').disabled,true);assert.equal($('import-media').disabled,true);assert.equal($('jobs').querySelector('button').disabled,true);
  assert.match($('worker-status').textContent,/上次任务状态/);assert.equal($('ask-ai').disabled,true);assert.equal($('ai-consent').checked,false);
  $('ai-provider').value='claude';$('ai-provider').onchange();assert.equal($('ask-ai').disabled,true);
  queueOnline=true;await $('retry-worker').onclick();await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal($('process-url').disabled,false);assert.equal($('jobs').querySelector('button').disabled,false);assert.equal($('ai-consent').checked,false);
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
 const w=setup('{damaged');try{
  const $=id=>w.document.getElementById(id);await $('sample').onclick();assert.equal($('save-status').hidden,false);
  w.URL.createObjectURL=()=> 'blob:https://coconut.example/backup';w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};
  $('export').onclick();assert.match($('notice').textContent,/备份下载/);assert.equal($('save-status').hidden,false);assert.match($('save-status').textContent,/自动保存已暂停/);
  assert.equal(w.localStorage.getItem('coconut-reader-v1'),'{damaged');
 }finally{await w.happyDOM.close();}
});
