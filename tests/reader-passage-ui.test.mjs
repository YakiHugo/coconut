import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {passageReadingFixture,irregularPassageFixture} from './helpers/passage-reading-fixture.mjs';
const root=new URL('../',import.meta.url),key='coconut-reader-v1';
function setup(saved){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});if(saved)w.localStorage.setItem(key,saved);
 const calls=[];w.fetch=async(...args)=>{calls.push(args);throw new Error('Unexpected request');};
 for(const name of ['summary','core','passages','passage-playback'])w.eval(fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8'));
 w.eval(['app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
 const $=id=>w.document.getElementById(id);w.HTMLElement.prototype.scrollIntoView=function(){w.lastScrolled=this;};
 return {w,$,calls,close:async()=>{w.dispatchEvent(new w.Event('pagehide'));await w.happyDOM.close();}};
}
async function load(env,fixture=passageReadingFixture()){
 const text=JSON.stringify(fixture);Object.defineProperty(env.$('file'),'files',{configurable:true,value:[{name:'authored.json',size:Buffer.byteLength(text),text:async()=>text}]});await env.$('file').onchange();return fixture;
}
function saved(env){const shelf=JSON.parse(env.w.localStorage.getItem(key));return shelf.documents.find(doc=>doc.key===shelf.active);}
const passages=env=>[...env.$('passage-body').querySelectorAll('.passage')];
const cue= (env,id)=>env.w.document.querySelector('.segment[data-segment-id="'+id+'"]');
async function media(env){
 const {$,w}=env;if($('episode-media').hidden)$('toggle-reader-media').click();$('attach-reader-media').click();
 w.URL.createObjectURL=()=> 'blob:authored';w.URL.revokeObjectURL=()=>{};
 const file={name:'authored.wav',type:'audio/wav',size:128,slice:()=>({text:async()=> 'RIFF authored fixture'})};
 Object.defineProperty($('reader-media-file'),'files',{configurable:true,value:[file]});await $('reader-media-file').onchange();
 const player=$('source-media').querySelector('audio');
 Object.defineProperty(player,'duration',{configurable:true,value:180});Object.defineProperty(player,'paused',{configurable:true,writable:true,value:true});
 player.play=async()=>{player.paused=false;player.dispatchEvent(new w.Event('play'));};player.pause=()=>{player.paused=true;player.dispatchEvent(new w.Event('pause'));};
 player.currentTime=40;player.onloadedmetadata();return player;
}

test('long captions open as contiguous first passages, retaining source identities and annotations without network',async()=>{
 const env=setup();try{const fixture=await load(env);const {$,w}=env;
  assert.equal($('passage-workspace').hidden,false);assert.equal($('transcript-layout').hidden,true);assert.equal($('mode-passages').getAttribute('aria-pressed'),'true');assert.ok(passages(env).length<=8);
  const first=passages(env)[0];assert.equal(first.dataset.firstCueId,'split-0');
  assert.deepEqual([...first.querySelectorAll('.passage-original .passage-cue')].map(node=>node.dataset.cueId),fixture.segments.slice(0,6).map(c=>c.id));
  assert.equal(first.querySelector('.passage-original').textContent,fixture.segments.slice(0,6).map(c=>c.text).join(' '));
  assert.equal(first.querySelector('.passage-translation').textContent,fixture.segments.slice(0,6).map(c=>c.translations.zh.text).join(''));
  assert.match(first.querySelector('.passage-annotation').textContent,/导入时已有的笔记/);assert.equal(first.querySelector('.passage-listen').disabled,true);
  assert.deepEqual(saved(env).segments.map(({id,start,end,text})=>({id,start,end,text})),fixture.segments.map(({id,start,end,text})=>({id,start,end,text})));
  assert.equal(saved(env).readingPosition,'split-19');assert.equal(env.calls.length,0);
 }finally{await env.close();}
});

test('continuous translations show exact gaps and never reuse stale wording',async()=>{
 const env=setup();try{await load(env);const {$}=env;
  assert.equal($('passage-body').querySelector('[data-cue-id="split-8"][data-state="stale"]').className,'passage-translation-gap');
  assert.ok($('passage-body').querySelector('[data-cue-id="split-10"][data-state="missing"]'));
  assert.doesNotMatch($('passage-body').textContent,/这句旧译文不应混进/);
  $('passage-toggle-translation').click();assert.equal($('passage-body').querySelectorAll('.passage-translation').length,0);assert.equal($('passage-toggle-translation').getAttribute('aria-pressed'),'false');
  $('passage-toggle-translation').click();assert.ok($('passage-body').querySelector('.passage-translation-gap'));
 }finally{await env.close();}
});

test('cue details reuse existing editing and notes, then restore same source passage and viewport anchor',async()=>{
 const env=setup();try{await load(env);const {$,w}=env,first=passages(env)[0];first.getBoundingClientRect=()=>({top:73});
  first.querySelector('.passage-details').click();assert.equal($('passage-return-bar').hidden,false);assert.equal($('transcript-layout').hidden,false);assert.equal(w.document.activeElement.dataset.segmentId,'split-0');
  cue(env,'split-1').querySelector('.note-button').click();$('note').value='A source-linked observation';$('note').oninput();$('return-excerpt').click();assert.equal($('passage-return-bar').hidden,false);
  cue(env,'split-1').querySelector('.edit-button').click();$('edit-segment').value='but we had initially left out';$('save-edit').click();
  cue(env,'split-1').querySelector('.bookmark-button').click();let scroll;
  w.scrollBy=(x,y)=>{scroll={x,y};};$('return-to-passages').click();
  assert.equal($('passage-workspace').hidden,false);assert.equal($('passage-return-bar').hidden,true);assert.deepEqual(scroll,{x:0,y:-73});
  assert.equal(w.document.activeElement.closest('.passage').dataset.firstCueId,'split-0');
  assert.equal($('passage-body').querySelector('.passage-original [data-cue-id="split-1"]').textContent,'but we had initially left out');assert.ok($('passage-body').querySelector('[data-cue-id="split-1"][data-state="stale"]'));
  assert.equal(saved(env).notes['split-1'],'A source-linked observation');assert.equal(saved(env).readingPosition,'split-1');assert.equal(saved(env).segments.length,1771);
 }finally{await env.close();}
});

test('actual-time skim remains beside saved summary and reaches sparse late source positions',async()=>{
 const env=setup();try{const fixture=await load(env,irregularPassageFixture()),{$,w}=env;$('mode-summary').click();
  assert.equal($('source-overview').hidden,false);assert.equal($('summary-body').textContent,fixture.ai_answers[0].answer);
  const buttons=[...$('overview-segments').querySelectorAll('button')];assert.ok(buttons.some(button=>fixture.segments.find(cue=>cue.id===button.dataset.cueId).start===2400));
  buttons.at(-1).click();assert.equal($('passage-workspace').hidden,false);assert.ok($('passage-body').querySelector('.passage-cue[data-cue-id="split-35"]'));assert.equal(w.document.activeElement.dataset.firstCueId,'split-35');
  assert.ok(Number($('passage-time-range').max)>=3600);$('passage-time-range').value='600';$('passage-time-range').onchange();assert.equal(w.document.activeElement.dataset.firstCueId,'split-31');assert.equal(env.calls.length,0);
 }finally{await env.close();}
});

test('passage pagination is bounded and keeps every neighboring cue available',async()=>{
 const env=setup();try{await load(env);const {$,w}=env;assert.equal(passages(env)[0].dataset.firstCueId,'split-0');$('passage-next').click();assert.equal(passages(env)[0].dataset.firstCueId,'split-48');assert.equal(w.document.activeElement.dataset.firstCueId,'split-48');$('passage-previous').click();assert.equal(passages(env)[0].dataset.firstCueId,'split-0');assert.equal($('passage-previous').disabled,true);
 }finally{await env.close();}
});

test('new document clears the old detail return, while library bookmarks resume in passages',async()=>{
 const env=setup();try{await load(env);const {$}=env;passages(env)[0].querySelector('.passage-details').click();assert.equal($('passage-return-bar').hidden,false);
  const other=irregularPassageFixture();other.title='Second';await load(env,other);assert.equal($('passage-return-bar').hidden,true);
  $('library').firstElementChild.click();assert.equal($('passage-workspace').hidden,false);assert.ok($('passage-body').querySelector('.passage-cue[data-cue-id="split-19"]'));
 }finally{await env.close();}
});

test('media setup is disclosed without leaving the passage, and playback controls remain outside hidden modes',async()=>{
 const env=setup();try{await load(env);const {$}=env;assert.equal($('episode-media').hidden,true);assert.equal($('toggle-reader-media').hidden,false);$('toggle-reader-media').click();assert.equal($('episode-media').hidden,false);assert.equal($('passage-workspace').hidden,false);$('toggle-reader-media').click();assert.equal($('episode-media').hidden,true);
  const player=await media(env);passages(env)[0].querySelector('.passage-listen').click();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(player.paused,false);assert.equal($('passage-playback-controls').dataset.state,'playing');assert.equal($('passage-playback-controls').closest('#passage-workspace'),null);
  passages(env)[0].querySelector('.passage-details').click();assert.equal($('passage-playback-controls').hidden,false);assert.equal($('passage-return-bar').hidden,false);
  $('passage-return-playback').click();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(player.currentTime,40);assert.equal(player.paused,true);assert.equal($('passage-playback-controls').hidden,true);
 }finally{await env.close();}
});

test('ordinary cue seek exits listen-once ownership before seeking to that cue',async()=>{
 const env=setup();try{await load(env);const player=await media(env),{$,w}=env;
  // Create the bound preview through the same controller while keeping the test player stable.
  passages(env)[0].querySelector('.passage-listen').click();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal($('passage-playback-controls').dataset.state,'playing');passages(env)[0].querySelector('.passage-details').click();cue(env,'split-0').querySelector('.time > button').click();assert.equal($('passage-playback-controls').dataset.state,'idle');assert.equal(player.currentTime,0);
 }finally{await env.close();}
});

test('the existing authored trial exposes the continuous reading mode without changing demo source',async()=>{
 const env=setup();try{const {$}=env;await $('sample').onclick();assert.equal(saved(env).segments.length,3);assert.equal($('mode-passages').hidden,false);$('mode-passages').click();assert.equal($('passage-workspace').hidden,false);assert.equal($('passage-body').querySelectorAll('.passage-original .passage-cue').length,3);assert.equal(env.calls.length,0);
 }finally{await env.close();}
});


test('compact-height note editing pauses a bounded preview and keeps its return available after closing',async()=>{
 const env=setup();try{await load(env);const player=await media(env),{$,w}=env;w.happyDOM.setViewport({width:540,height:320});
  passages(env)[0].querySelector('.passage-listen').click();await new Promise(resolve=>setTimeout(resolve,0));
  passages(env)[0].querySelector('.passage-details').click();cue(env,'split-0').querySelector('.note-button').click();
  assert.equal(player.paused,true);assert.equal($('passage-playback-controls').dataset.state,'paused');assert.equal($('notes-panel').hidden,false);
  $('close-note').click();assert.equal($('passage-playback-controls').hidden,false);assert.equal($('passage-return-playback').hidden,false);
 }finally{await env.close();}
});

test('page lifecycle cancellation does not leave a restored page with an unusable listening controller',async()=>{
 const env=setup();try{await load(env);const player=await media(env),{$,w}=env;
  passages(env)[0].querySelector('.passage-listen').click();await new Promise(resolve=>setTimeout(resolve,0));w.dispatchEvent(new w.Event('pagehide'));
  assert.equal(player.paused,true);assert.equal($('passage-playback-controls').dataset.state,'idle');
  passages(env)[0].querySelector('.passage-listen').click();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(player.paused,false);assert.equal($('passage-playback-controls').dataset.state,'playing');
 }finally{await env.close();}
});

test('opening the reading surface closes the AI request panel and revokes pending consent',async()=>{
 const env=setup();try{await load(env);const {$}=env;$('mode-transcript').click();$('language-panel').open=true;$('ai-consent').checked=true;
  $('mode-passages').click();assert.equal($('language-panel').open,false);assert.equal($('language-panel').hidden,true);assert.equal($('ai-consent').checked,false);assert.equal(env.calls.length,0);
 }finally{await env.close();}
});


test('confirmed import success is a complete status message, while a later failure resets its subdued treatment',async()=>{
 const env=setup();try{await load(env);const {$}=env;
  assert.equal($('notice').dataset.kind,'success');assert.equal($('notice').getAttribute('role'),'status');
  assert.equal($('notice').textContent,'已导入并保存在本机浏览器。没有向服务器上传文件。');
  Object.defineProperty($('file'),'files',{configurable:true,value:[{name:'broken.json',size:2,text:async()=> '{bad'}]});await $('file').onchange();
  assert.equal($('notice').dataset.kind,'');assert.match($('notice').textContent,/导入失败/);assert.equal($('notice').hidden,false);assert.equal($('passage-workspace').hidden,false);
 }finally{await env.close();}
});
