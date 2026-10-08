import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url);
function setup(){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});
 const calls=[];w.fetch=async(...args)=>{calls.push(args);throw new Error('No source or AI request authorized');};
 w.eval(['summary','core','app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
 return {w,$:id=>w.document.getElementById(id),calls};
}
async function add($,doc){
 const text=JSON.stringify(doc);Object.defineProperty($('file'),'files',{configurable:true,value:[{name:'authored-dock.json',size:text.length,text:async()=>text}]});await $('file').onchange();
}
const fixture={title:'长标题的原声阅读 · 这是自己的测试资料',language:'en',source_media:{job_id:'a'.repeat(32),kind:'audio'},segments:Array.from({length:151},(_,i)=>({id:'cue-'+i,start:i*4,end:i*4+4,text:'Original authored cue '+i}))};
async function media(env){
 const {w,$}=env;await add($,fixture);w.dispatchEvent(new w.Event('coconut-worker-ready'));$('mode-transcript').click();
 const player=$('source-media').querySelector('audio');let duration=700,paused=true,error=null,played=0,pauses=0,headerBottom=-20;
 Object.defineProperties(player,{duration:{configurable:true,get:()=>duration},paused:{configurable:true,get:()=>paused},error:{configurable:true,get:()=>error}});
 player.play=async()=>{played++;paused=false;player.dispatchEvent(new w.Event('play'));};
 player.pause=()=>{pauses++;paused=true;player.dispatchEvent(new w.Event('pause'));};
 $('episode-media').getBoundingClientRect=()=>({bottom:headerBottom});
 const refresh=()=>player.dispatchEvent(new w.Event('timeupdate'));
 refresh();
 return {player,refresh,get played(){return played;},get pauses(){return pauses;},set duration(value){duration=value;refresh();},set error(value){error=value;refresh();},set headerBottom(value){headerBottom=value;refresh();}};
}

test('dock appears only for a usable real player outside the reading viewport',async()=>{
 const env=setup();try{
  const {w,$}=env;assert.equal($('media-dock').hidden,true);const m=await media(env);
  assert.equal($('media-dock').hidden,false);assert.equal(m.played,0);
  m.headerBottom=300;assert.equal($('media-dock').hidden,true);
  m.headerBottom=-20;m.duration=NaN;assert.equal($('media-dock').hidden,true);
  m.duration=700;assert.equal($('media-dock').hidden,false);
  m.error={message:'fixture error'};assert.equal($('media-dock').hidden,true);
  assert.equal(env.calls.length,0);assert.equal(w.document.querySelectorAll('audio,video').length,1);
 }finally{await env.w.happyDOM.close();}
});

test('dock controls the existing player and mirrors its actual clock and rate without autostart',async()=>{
 const env=setup();try{
  const {$,w}=env,m=await media(env),original=m.player;
  assert.equal(m.played,0);assert.equal($('dock-play').textContent,'播放');
  await $('dock-play').onclick();assert.equal(m.played,1);assert.equal($('dock-play').textContent,'暂停');
  original.currentTime=125;original.playbackRate=1.5;m.refresh();
  assert.equal($('dock-current').textContent,'02:05');assert.match($('dock-total').textContent,/11:40/);assert.match($('dock-rate').textContent,/1.5×/);
  await $('dock-play').onclick();assert.equal(m.pauses,1);assert.equal($('dock-play').textContent,'播放');
  assert.equal($('source-media').querySelector('audio'),original);assert.equal(w.document.querySelectorAll('audio,video').length,1);
  assert.equal(env.calls.length,0);
 }finally{await env.w.happyDOM.close();}
});

test('dock locates a source cue across pages while preserving the same playback element',async()=>{
 const env=setup();try{
  const {$,w}=env,m=await media(env);m.player.currentTime=500;m.refresh();
  $('search').value='not present';$('search').oninput();assert.equal(w.document.querySelectorAll('.segment').length,0);
  assert.equal($('dock-locate').disabled,false);$('dock-locate').click();
  assert.equal($('search').value,'');assert.equal(w.document.activeElement.dataset.segmentId,'cue-125');
  assert.equal($('source-media').querySelector('audio'),m.player);assert.equal(m.player.currentTime,500);assert.equal(m.played,0);
 }finally{await env.w.happyDOM.close();}
});

test('returning to the native player restores focus without starting playback',async()=>{
 const env=setup();try{
  const {$,w}=env,m=await media(env);let scrolled=false;
  $('source-media').scrollIntoView=()=>{scrolled=true;m.headerBottom=300;};
  $('dock-return').focus();$('dock-return').click();
  assert.equal(scrolled,true);assert.equal(w.document.activeElement,m.player);assert.equal($('media-dock').hidden,true);assert.equal(m.played,0);
 }finally{await env.w.happyDOM.close();}
});

test('changing workspace or document removes the dock and never transfers old media controls',async()=>{
 const env=setup();try{
  const {$,w}=env,m=await media(env);await $('dock-play').onclick();
  $('add-content').click();assert.equal($('media-dock').hidden,true);assert.ok(m.pauses>=1);
  $('back-reading').click();assert.equal($('media-dock').hidden,false);assert.equal($('dock-play').textContent,'播放');
  await add($,{title:'Different source',segments:[{id:'different',start:0,end:1,text:'A different source.'}]});
  assert.equal($('media-dock').hidden,true);assert.equal($('source-media').querySelector('audio'),null);
  assert.equal(w.document.body.dataset.mediaDocked,'false');assert.equal(m.played,1);assert.equal(env.calls.length,0);
 }finally{await env.w.happyDOM.close();}
});


test('an intentional quick pause does not report the interrupted play promise as a file failure',async()=>{
 const env=setup();try{
  const {$,w}=env,m=await media(env);const before=$('notice').textContent;let rejectPlay;
  const beginPlay=m.player.play;
  m.player.play=()=>{beginPlay();return new Promise((_,reject)=>{rejectPlay=reject;});};
  const pending=$('dock-play').onclick();
  // Native play() can remain pending while the user immediately pauses it.
  await $('dock-play').onclick();assert.equal(m.pauses,1);assert.equal(m.player.paused,true);
  rejectPlay(Object.assign(new Error('play interrupted'),{name:'AbortError'}));await pending;
  assert.equal($('notice').textContent,before);assert.equal($('source-media').querySelector('audio'),m.player);
  m.player.currentTime=699;m.refresh();assert.equal($('dock-locate').disabled,true);assert.equal($('dock-locate').textContent,'此刻无字幕');
 }finally{await env.w.happyDOM.close();}
});


test('subsecond time events do not rewrite the dock or reset its focused controls',async()=>{
 const env=setup();try{
  const {$,w}=env,m=await media(env);m.player.currentTime=1.1;m.refresh();$('dock-play').focus();
  const observer=new w.MutationObserver(()=>{});observer.observe($('media-dock'),{subtree:true,attributes:true,childList:true,characterData:true});
  m.player.currentTime=1.2;m.refresh();assert.equal(observer.takeRecords().length,0);
  assert.equal(w.document.activeElement,$('dock-play'));
  m.player.currentTime=2.1;m.refresh();assert.ok(observer.takeRecords().length>0);assert.equal($('dock-current').textContent,'00:02');observer.disconnect();
 }finally{await env.w.happyDOM.close();}
});
