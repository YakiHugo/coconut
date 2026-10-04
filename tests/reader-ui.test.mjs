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
 const w=setup();try{
  let blob,clicks=0;w.URL.createObjectURL=value=>{blob=value;return 'blob:https://coconut.example/notebook';};w.URL.revokeObjectURL=()=>{};
  w.HTMLAnchorElement.prototype.click=function(){assert.ok(this.isConnected);assert.equal(this.download,'Notes_Test.notes.md');clicks++;};
  const $=id=>w.document.getElementById(id);
  await importDocument(w,{title:'Notes/Test',source_url:'https://youtu.be/demo',notes:{note:'Remember me'},segments:[{id:'saved',start:0,end:1,text:'Saved quote',saved_excerpt:true},{id:'note',start:2,end:3,text:'Note source'},{id:'neither',start:4,end:5,text:'Not kept'}]});
  assert.equal(clicks,0);assert.equal($('export-notebook').textContent,'导出阅读笔记（2 段）');
  $('filter-excerpts').click();$('search').value='no match';$('search').oninput();assert.equal(w.document.querySelectorAll('.segment').length,0);
  $('export-notebook').click();const markdown=await blob.text();assert.equal(clicks,1);
  assert.match(markdown,/Saved quote/);assert.match(markdown,/Note source/);assert.match(markdown,/Remember me/);assert.doesNotMatch(markdown,/Not kept/);
  assert.equal(w.document.querySelectorAll('a[download]').length,0);assert.match($('notice').textContent,/检查浏览器下载记录/);
 }finally{await w.happyDOM.close();}
});

test('excerpt storage conflict or quota failure leaves recoverable data with a persistent warning',async()=>{
 for(const failure of ['conflict','quota']){const w=setup();try{
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
 }finally{await w.happyDOM.close();}}
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
