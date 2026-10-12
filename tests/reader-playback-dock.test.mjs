import {installSavePipeline,settle} from './helpers/save-pipeline.mjs';
import {evaluateNativeIMEPointer} from './helpers/native-ime-proof.mjs';
import {installDockViewportObserver} from './helpers/dock-viewport-observer.mjs';
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
 const pipeline=installSavePipeline(w);
 const frames=new Map(),scrolls=[];let frameId=0;
 w.requestAnimationFrame=fn=>{frames.set(++frameId,fn);return frameId;};w.cancelAnimationFrame=id=>frames.delete(id);
 const tick=()=>{for(const [id,fn] of [...frames]){frames.delete(id);fn();}};
 w.HTMLElement.prototype.scrollIntoView=function(options){scrolls.push({id:this.id,cue:this.dataset.segmentId||this.dataset.cueId,options});};
 w.eval(['summary','core','passages','passage-playback','app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+`\nwindow.dockTest={doc:()=>active(),navigation:()=>({selected,pageStart,readingMode,passageAnchor,searchFocusedId,query:$('search').value,readingPosition:active()?.readingPosition}),listen:range=>passagePlayback.listen(range),preview:()=>passagePlayback.getState(),loop:cue=>toggleRepeat(cue),loopState:()=>repeating,closing:value=>{readerClosing=value;},offset:value=>{browserMedia.set(active().key,{origin:'local',identity:'file-candidate-v1:authored',url:followPlayer().getAttribute('src'),kind:'audio'});active().media_timing={version:1,identity:'file-candidate-v1:authored',offset:value};}};`);
 return {w,$:id=>w.document.getElementById(id),calls,pipeline,tick,scrolls};
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
  m.player.currentTime=699;m.refresh();assert.equal($('dock-locate').disabled,true);assert.equal($('dock-locate-full').textContent,'此刻无字幕');assert.equal($('dock-locate-short').textContent,'无字幕');assert.equal($('dock-locate').getAttribute('aria-label'),'当前时间没有字幕');
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
test('dock playback errors follow selection and source ownership while current failures remain visible',async()=>{
 for(const action of ['reselect','source','current']){
  const env=setup();try{const {$,w}=env,m=await media(env);let rejectPlay;
   m.player.play=()=>new Promise((resolve,reject)=>{rejectPlay=reject;});
   const pending=$('dock-play').onclick();
   if(action==='reselect')$('library').querySelector('.library-open').click();
   if(action==='source')m.player.setAttribute('src','blob:authored-replacement');
   const before=$('notice').textContent;
   rejectPlay(Object.assign(new Error('play permission denied'),{name:'NotAllowedError'}));await pending;
   assert.equal($('source-media').querySelector('audio'),m.player);
   assert.equal($('notice').textContent,action==='current'?'媒体暂时无法播放，请回到播放器检查文件或重试。':before,action);
  }finally{await env.w.happyDOM.close();}
 }
});

// HappyDOM event paths below are CPU ownership regressions. Native pointer,
// composition, font metrics and decoded media are separately covered in CI.
const input=(env,node,value)=>{node.value=value;node.dispatchEvent(new env.w.Event('input',{bubbles:true}));};
const rewind=env=>{
 const button=env.$('dock-rewind');
 button.dispatchEvent(new env.w.PointerEvent('pointerdown',{bubbles:true}));button.focus();button.click();
};
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await settle();await new Promise(resolve=>setImmediate(resolve));}assert.fail('Expected persistence boundary');}

test('dock rewind is a single named action and repeated paused clicks use physical seconds and clamp at zero',async()=>{
 const env=setup();try{const {$,w}=env,m=await media(env);
  assert.equal(w.document.querySelectorAll('#dock-rewind').length,1);assert.equal($('dock-rewind').textContent,'−10秒');
  assert.equal($('dock-rewind').getAttribute('aria-label'),'后退10秒');assert.equal($('dock-rewind').title,'后退10秒');
  assert.equal($('dock-rewind').nextElementSibling,$('dock-play'));assert.equal($('dock-rewind').disabled,false);
  w.dockTest.offset(8);m.player.currentTime=40;m.player.playbackRate=1.5;m.player.volume=.35;const source=m.player.getAttribute('src');
  rewind(env);assert.equal(m.player.currentTime,30);rewind(env);assert.equal(m.player.currentTime,20);
  m.player.currentTime=3;rewind(env);assert.equal(m.player.currentTime,0);rewind(env);assert.equal(m.player.currentTime,0);
  assert.equal(m.player.paused,true);assert.equal(m.played,0);assert.equal(m.pauses,0);assert.equal(m.player.playbackRate,1.5);assert.equal(m.player.volume,.35);
  assert.equal(m.player.getAttribute('src'),source);assert.equal($('source-media').querySelector('audio'),m.player);assert.equal(env.calls.length,0);
 }finally{await env.w.happyDOM.close();}
});

test('playing rewind adds no play or pause request, and ended media stays paused after seeking',async()=>{
 const env=setup();try{const {$,w}=env,m=await media(env);await m.player.play();m.player.currentTime=500;rewind(env);
  assert.equal(m.player.currentTime,490);assert.equal(m.player.paused,false);assert.equal(m.played,1);assert.equal(m.pauses,0);assert.equal($('dock-current').textContent,'08:10');
  m.player.pause();Object.defineProperty(m.player,'ended',{configurable:true,value:true});m.player.currentTime=700;m.refresh();rewind(env);
  assert.equal(m.player.currentTime,690);assert.equal(m.player.paused,true);assert.equal(m.played,1);assert.equal(m.pauses,1);assert.equal(w.document.querySelectorAll('audio,video').length,1);
 }finally{await env.w.happyDOM.close();}
});

for(const status of ['playing','paused','finished'])test('dock rewind releases '+status+' bounded preview and queued range events cannot retake the clock',async()=>{
 const env=setup();try{const {w,$}=env,m=await media(env);m.player.currentTime=450;
  await w.dockTest.listen({id:'authored-range',start:480,end:484,label:'Authored range'});
  if(status==='paused')m.player.pause();
  if(status==='finished'){m.player.currentTime=485;m.refresh();assert.equal(w.dockTest.preview().status,'finished');}
  const wasPaused=m.player.paused,plays=m.played,pauses=m.pauses,time=m.player.currentTime;rewind(env);
  assert.equal(m.player.currentTime,time-10);assert.equal(w.dockTest.preview().range,null);assert.equal(w.dockTest.preview().returnPosition,null);
  assert.equal(m.player.paused,wasPaused);assert.equal(m.played,plays);assert.equal(m.pauses,pauses);
  m.player.dispatchEvent(new w.Event('seeked'));m.refresh();assert.equal(m.player.currentTime,time-10);assert.equal(m.pauses,pauses);assert.equal($('passage-return-playback').hidden,true);
 }finally{await env.w.happyDOM.close();}
});

test('rewind releases cue loop ownership before stale seeked and timeupdate events',async()=>{
 const env=setup();try{const {$,w}=env,m=await media(env);w.dockTest.loop(w.dockTest.doc().segments[125]);assert.ok(w.dockTest.loopState());
  const plays=m.played;rewind(env);assert.equal(m.player.currentTime,490);assert.equal(w.dockTest.loopState(),null);assert.equal($('stop-repeat').hidden,true);
  m.player.dispatchEvent(new w.Event('seeked'));m.player.currentTime=510;m.refresh();assert.equal(m.player.currentTime,510);assert.equal(m.played,plays);assert.equal(m.player.paused,false);
 }finally{await env.w.happyDOM.close();}
});

test('rewind does not swallow seek failures or let canceled preview overwrite the saved listening checkpoint',async()=>{
 const env=setup();try{const {$,w}=env,m=await media(env);await m.player.play();m.player.currentTime=450;m.player.pause();
  const key=Object.keys(w.localStorage).find(key=>key.startsWith('coconut-listening-v1:'));assert.equal(JSON.parse(w.localStorage.getItem(key)).time,450);
  await w.dockTest.listen({id:'range',start:480,end:490});const plays=m.played;
  Object.defineProperty(m.player,'currentTime',{configurable:true,get:()=>482,set(){throw new Error('Authored seek failure');}});
  rewind(env);assert.equal(w.dockTest.preview().range,null);assert.match($('playback-status').textContent,/媒体暂时无法定位/);assert.equal(m.played,plays);
  w.dispatchEvent(new w.Event('pagehide'));assert.equal(JSON.parse(w.localStorage.getItem(key)).time,450);
 }finally{await env.w.happyDOM.close();}
});

for(const outcome of ['commit','fail'])test('rewind preserves exact note, selection, source DOM and navigation across a held '+outcome+' receipt',async()=>{
 const env=setup();try{const {$,w,pipeline,tick,scrolls}=env,m=await media(env);await w.flushContentForTest();
  $('reading-jump').value='cue-126';$('reading-jump').onchange();w.document.querySelector('.segment[data-segment-id="cue-126"] .note-button').click();
  const note=$('note');input(env,note,'  Authored exact note\n候选文字与空白  ');note.setSelectionRange(8,15);note.focus();
  // Synthetic composition guards character shortcuts; it does not claim native IME.
  note.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true,data:'候选'}));
  m.player.currentTime=500;note.dispatchEvent(new w.KeyboardEvent('keydown',{key:'j',bubbles:true,isComposing:true}));assert.equal(m.player.currentTime,500);
  note.dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true,data:'候选'}));
  pipeline.hold();const saving=w.flushContentForTest();await until(()=>pipeline.writes.length===1);
  const value=note.value,selection=[note.selectionStart,note.selectionEnd],doc=JSON.stringify(w.dockTest.doc()),navigation=JSON.stringify(w.dockTest.navigation()),rows=[...w.document.querySelectorAll('.segment')];
  tick();scrolls.length=0;rewind(env);m.refresh();tick();
  assert.equal(m.player.currentTime,490);assert.equal(w.document.activeElement,$('dock-rewind'));assert.equal($('note'),note);assert.equal(note.value,value);assert.deepEqual([note.selectionStart,note.selectionEnd],selection);
  pipeline.writes[0][outcome]();await saving;await settle();tick();
  assert.equal($('note'),note);assert.equal(note.value,value);assert.deepEqual([note.selectionStart,note.selectionEnd],selection);assert.equal(w.document.activeElement,$('dock-rewind'));
  assert.deepEqual([...w.document.querySelectorAll('.segment')],rows);assert.equal(JSON.stringify(w.dockTest.doc()),doc);assert.equal(JSON.stringify(w.dockTest.navigation()),navigation);assert.deepEqual(scrolls,[]);
  assert.equal(env.calls.length,0);
 }finally{await env.w.happyDOM.close();}
});

test('rewind preserves armed or suspended Follow through pointer, touch and click capture',async()=>{
 const env=setup();try{const {$,w,tick}=env,m=await media(env);m.player.currentTime=500;
  $('dock-follow').click();tick();assert.equal($('dock-follow').textContent,'跟随待播放');
  $('dock-rewind').dispatchEvent(new w.Event('touchstart',{bubbles:true}));rewind(env);tick();assert.equal($('dock-follow').dataset.state,'following');assert.equal(m.player.currentTime,490);assert.equal(m.played,0);
  await m.player.play();tick();rewind(env);m.refresh();tick();assert.equal(m.player.currentTime,480);assert.equal($('dock-follow').dataset.state,'following');assert.equal(w.document.activeElement,$('dock-rewind'));
  w.dispatchEvent(new w.WheelEvent('wheel'));assert.equal($('dock-follow').dataset.state,'suspended');const rows=[...w.document.querySelectorAll('.segment')];rewind(env);m.refresh();tick();assert.equal($('dock-follow').dataset.state,'suspended');assert.deepEqual([...w.document.querySelectorAll('.segment')],rows);
 }finally{await env.w.happyDOM.close();}
});

test('rewind is unavailable for unusable media, hidden workspace, modal, inert and native-close barriers',async()=>{
 const env=setup();try{const {$,w}=env,m=await media(env);m.player.currentTime=40;
  for(const duration of [0,NaN,Infinity]){m.duration=duration;assert.equal($('dock-rewind').disabled,true);$('dock-rewind').onclick();assert.equal(m.player.currentTime,40);}
  m.duration=700;m.error={code:3};assert.equal($('dock-rewind').disabled,true);$('dock-rewind').onclick();assert.equal(m.player.currentTime,40);m.error=null;
  $('edit-dialog').showModal();m.refresh();$('dock-rewind').onclick();assert.equal(m.player.currentTime,40);$('edit-dialog').close();assert.equal($('dock-rewind').disabled,false,'closing a paused modal needs no new media event');
  w.document.body.inert=true;$('dock-rewind').onclick();assert.equal(m.player.currentTime,40);w.document.body.inert=false;
  w.dockTest.closing(true);$('dock-rewind').onclick();assert.equal(m.player.currentTime,40);w.dockTest.closing(false);
  $('add-content').click();assert.equal($('dock-rewind').disabled,true);$('dock-rewind').onclick();assert.equal(m.player.currentTime,40);$('back-reading').click();rewind(env);assert.equal(m.player.currentTime,30);assert.equal(m.played,0);
 }finally{await env.w.happyDOM.close();}
});

test('rewind resolves current player after document/source replacement; retired play completion and events cannot touch replacement',async()=>{
 const env=setup();try{const {$,w}=env,m=await media(env);m.player.currentTime=500;let complete;
  m.player.play=()=>new Promise(resolve=>{complete=resolve;});const pending=$('dock-play').onclick();
  await add($,{...fixture,title:'Replacement authored source',source_media:{job_id:'b'.repeat(32),kind:'audio'}});
  const replacement=$('source-media').querySelector('audio');assert.notEqual(replacement,m.player);
  Object.defineProperties(replacement,{duration:{configurable:true,value:700},paused:{configurable:true,value:true}});replacement.currentTime=80;replacement.dispatchEvent(new w.Event('loadedmetadata'));rewind(env);assert.equal(replacement.currentTime,70);assert.equal(m.player.currentTime,500);
  complete();await pending;for(const name of ['timeupdate','seeked','ended','loadedmetadata'])m.player.dispatchEvent(new w.Event(name));assert.equal(replacement.currentTime,70);assert.equal(replacement.paused,true);
  replacement.setAttribute('src','blob:replacement-on-same-element');replacement.currentTime=40;rewind(env);assert.equal(replacement.currentTime,30);assert.equal($('source-media').querySelector('audio'),replacement);
  await add($,{title:'No original media',segments:[{id:'one',start:0,end:2,text:'Authored text'}]});assert.equal($('dock-rewind').disabled,true);$('dock-rewind').onclick();assert.equal(replacement.currentTime,30);assert.equal(env.calls.length,0);
 }finally{await env.w.happyDOM.close();}
});

test('audio-only local project retains rewind while transcript-specific locate is hidden',async()=>{
 const env=setup();try{const {$,w}=env;w.URL.createObjectURL=()=> 'blob:authored-audio-only';w.URL.revokeObjectURL=()=>{};
  const file=new w.File(['RIFF authored audio'],'authored.wav',{type:'audio/wav',lastModified:7});$('open-local-media').click();Object.defineProperty($('local-media-file'),'files',{configurable:true,value:[file]});await $('local-media-file').onchange();
  const player=$('source-media').querySelector('audio');assert.ok(player);Object.defineProperties(player,{duration:{configurable:true,value:180},paused:{configurable:true,value:true}});
  $('episode-media').getBoundingClientRect=()=>({bottom:-20});player.currentTime=40;player.dispatchEvent(new w.Event('loadedmetadata'));
  assert.equal($('dock-locate').hidden,true);assert.equal($('dock-follow').textContent,'跟随不可用');assert.equal($('dock-rewind').disabled,false);rewind(env);assert.equal(player.currentTime,30);assert.equal(player.paused,true);assert.equal(w.document.querySelectorAll('audio,video').length,1);assert.equal(env.calls.length,0);
 }finally{await env.w.happyDOM.close();}
});

test('successful paused rewind uses the existing seeked listening checkpoint without changing document readingPosition',async()=>{
 const env=setup();try{const {$,w}=env,m=await media(env);const before=JSON.stringify(w.dockTest.doc());
  m.player.currentTime=450;rewind(env);m.player.dispatchEvent(new w.Event('seeked'));
  const key=Object.keys(w.localStorage).find(key=>key.startsWith('coconut-listening-v1:'));
  assert.equal(JSON.parse(w.localStorage.getItem(key)).time,440);assert.equal(JSON.stringify(w.dockTest.doc()),before);assert.equal(m.player.paused,true);assert.equal(m.played,0);
 }finally{await env.w.happyDOM.close();}
});

test('active native IME pointer proof uses the browser baseline and rejects inactive, duplicate, lost or synthetic outcomes',()=>{
 const text='路标',selection={selectionStart:2,selectionEnd:2,selectionDirection:'forward'};
 const entry=[{type:'compositionstart',data:''},{type:'compositionupdate',data:text},{type:'beforeinput',data:text,inputType:'insertCompositionText',isComposing:true},{type:'input',data:text,inputType:'insertCompositionText',isComposing:true}].map((e,i)=>({...e,trusted:true,same:true,currentNodeSame:true,connected:true,focused:true,value:i<2?'':text,selectionStart:i<2?0:2,selectionEnd:i<2?0:2,selectionDirection:'forward'}));
 const make=(commits=true,trustedEnd=false)=>{
  const events=[...structuredClone(entry),...(commits?[{type:'compositionend',data:text,trusted:trustedEnd,same:true,currentNodeSame:true,connected:true,focused:true,value:text,...selection}]:[]),...['blur','focusout'].map(type=>({type,data:null,trusted:true,same:true,currentNodeSame:true,connected:true,focused:false,value:text,...selection}))];
  return {beforePointer:{events:structuredClone(entry),composing:true,focused:true,same:true,value:text,...selection},events,pointerEvents:['pointerdown','pointerup','click'].map((type,i)=>({type,trusted:true,same:true,originalSame:true,connected:true,focused:i===0,buttonFocused:i!==0,composing:i===0||!commits,value:text,...selection})),value:text,...selection,same:true,focused:false,buttonFocused:true,composing:!commits,manualDispatches:[]};
 };
 const valid=(baseline,actual)=>Object.values(evaluateNativeIMEPointer({baseline,actual,text})).every(Boolean);
 for(const baseline of [make(true,false),make(true,true),make(false)])assert.equal(valid(baseline,structuredClone(baseline)),true,'the same observed native commit/end flag or retained composition is valid');
 const baseline=make(),clone=()=>structuredClone(baseline);
 for(const mutate of [
  a=>{a.beforePointer.composing=false;},a=>{a.beforePointer.focused=false;},a=>{a.beforePointer.same=false;},a=>{a.beforePointer.events=[];},
  a=>{a.events.splice(2,1);},a=>{a.events.push({...a.events.at(-1)});},a=>{a.events[0].trusted=false;},a=>{a.events[4].trusted=true;},a=>{a.events[4].data='other';},
  a=>{a.events.at(-1).trusted=false;},a=>{a.events.at(-1).same=false;},a=>{a.events.at(-1).currentNodeSame=false;},a=>{a.events.at(-1).connected=false;},
  a=>{a.pointerEvents[0].trusted=false;},a=>{a.pointerEvents[0].originalSame=false;},a=>{a.pointerEvents.pop();},a=>{a.pointerEvents.push({...a.pointerEvents.at(-1)});},
  a=>{a.value='路';},a=>{a.value='路标路标';},a=>{a.selectionStart=0;},a=>{a.selectionDirection='backward';},a=>{a.composing=true;},a=>{a.same=false;},a=>{a.focused=true;},a=>{a.buttonFocused=false;},a=>{a.manualDispatches.push('click');}
 ]){const actual=clone();mutate(actual);assert.equal(valid(baseline,actual),false,'pointer proof cannot weaken event, text, caret, composition, node or focus ownership');}
 const inactive=clone();inactive.beforePointer.composing=false;assert.equal(valid(inactive,structuredClone(inactive)),false,'matching already committed inputs do not exercise the requested boundary');
 const untrusted=clone();untrusted.pointerEvents[0].trusted=false;assert.equal(valid(untrusted,structuredClone(untrusted)),false,'matching untrusted pointers do not establish native proof');
 const dropped=clone();dropped.value='路';assert.equal(valid(dropped,structuredClone(dropped)),false,'matching text loss is still unacceptable');
 const noBlur=clone();noBlur.events=noBlur.events.filter(e=>!['blur','focusout'].includes(e.type));assert.equal(valid(noBlur,structuredClone(noBlur)),false,'a pointer trace must include actual editor blur');
});


test('native dock inset follows actual lower occlusion, clears on retirement and never scrolls',async()=>{
 const env=setup();try{
  const {w,$,scrolls}=env,m=await media(env),root=w.document.documentElement;
  w.happyDOM.setWindowSize({width:390,height:480});
  $('media-dock').getBoundingClientRect=()=>({top:404,bottom:468,height:64});scrolls.length=0;
  m.refresh();assert.equal(root.style.getPropertyValue('--reading-dock-inset'),'92px');assert.equal(scrolls.length,0);
  const observer=new w.MutationObserver(()=>{});observer.observe(root,{attributes:true});m.refresh();assert.equal(observer.takeRecords().length,0);observer.disconnect();
  w.happyDOM.setWindowSize({width:1360,height:1000});$('media-dock').getBoundingClientRect=()=>({top:914,bottom:984,height:70});m.refresh();
  assert.equal(root.style.getPropertyValue('--reading-dock-inset'),'102px');assert.equal(scrolls.length,0);
  $('media-dock').getBoundingClientRect=()=>({top:913.625,bottom:983.625,height:70});m.refresh();
  assert.equal(root.style.getPropertyValue('--reading-dock-inset'),'103px','fractional obstruction rounds outward before adding the reading gutter');assert.equal(scrolls.length,0);
  m.headerBottom=100;assert.equal(root.style.getPropertyValue('--reading-dock-inset'),'0px');assert.equal(scrolls.length,0);
 }finally{await env.w.happyDOM.close();}
});
test('ended rewind recreates a real checkpoint in a reserved grid row without changing hidden semantics',async()=>{
 const env=setup();try{
  const {w,$}=env,m=await media(env);await m.player.play();m.player.currentTime=700;m.player.pause();m.player.dispatchEvent(new w.Event('ended'));
  assert.equal($('resume-listening').hidden,true);const button=$('resume-listening'),parent=button.parentElement;
  rewind(env);m.player.dispatchEvent(new w.Event('seeked'));
  assert.equal(m.player.currentTime,690);assert.equal(m.player.paused,true);assert.equal($('resume-listening'),button);assert.equal(button.parentElement,parent);assert.equal(button.hidden,false);assert.match(button.textContent,/11:30/);
  const style=w.document.createElement('style');style.textContent=fs.readFileSync(new URL('reader/style.css',root),'utf8');w.document.head.append(style);
  assert.equal(w.getComputedStyle(parent).display,'grid');assert.equal(w.getComputedStyle(parent).gridTemplateRows,'minmax(44px, auto) auto');
  m.player.currentTime=700;m.player.dispatchEvent(new w.Event('ended'));assert.equal(button.hidden,true);assert.equal(w.getComputedStyle(button).display,'none');assert.equal(w.getComputedStyle(parent).gridTemplateRows,'minmax(44px, auto) auto');
 }finally{await env.w.happyDOM.close();}
});
test('dock viewport diagnostics observe actual scroll owner, resume mutation and calls without controlling them',async()=>{
 const env=setup();try{
  const {w,$}=env;await media(env);const scrolls=[];w.scrollBy=(...args)=>scrolls.push(args);const original=w.scrollBy;
  w.eval('('+installDockViewportObserver.toString()+')()');const audit=w.__dockViewportObserver;
  assert.equal(audit.events[0].type,'installed');$('dock-rewind').focus();w.scrollBy(0,7);assert.deepEqual(scrolls,[[0,7]]);
  assert.ok(audit.calls.some(call=>call.type==='focus'&&call.target==='dock-rewind'));assert.ok(audit.calls.some(call=>call.type==='scrollBy'));
  $('resume-listening').hidden=false;await Promise.resolve();await Promise.resolve();assert.ok(audit.events.some(event=>event.type==='resume-mutation'));
  audit.stop();assert.equal(w.scrollBy,original);const count=audit.events.length;w.scrollBy(0,3);assert.equal(audit.events.length,count);
 }finally{await env.w.happyDOM.close();}
});

test('docked native source margins share the measured sticky stack and preserve undocked/context defaults',async()=>{
 const html=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0],css=fs.readFileSync(new URL('reader/style.css',root),'utf8');
 for(const docked of [false,true])for(const context of [false,true]){
  const w=new Window();try{
   w.document.body.innerHTML=html;w.document.body.dataset.mediaDocked=String(docked);
   const $=id=>w.document.getElementById(id),workspace=$('reader-workspace');workspace.style.setProperty('--reading-sticky-inset','194px');
   if(context){$('reading-context').hidden=false;workspace.insertBefore($('reading-context'),$('passage-workspace'));}
   const segment=w.document.createElement('section');segment.className='segment';$('transcript').append(segment);
   const passage=w.document.createElement('section');passage.className='passage';$('passage-body').append(passage);
   const unrelated=w.document.createElement('section');unrelated.className='segment';$('passage-question-dialog').append(unrelated);
   const style=w.document.createElement('style');style.textContent=css;w.document.head.append(style);
   assert.equal(w.getComputedStyle(segment).scrollMarginTop,docked?'max(24px, 194px)':'24px');
   assert.equal(w.getComputedStyle(passage).scrollMarginTop,docked?(context?'max(112px, 194px)':'max(20px, 194px)'):(context?'112px':'20px'));
   assert.equal(w.getComputedStyle(unrelated).scrollMarginTop,'24px','nested dialog nodes never acquire root source margins');
  }finally{await w.happyDOM.close();}
 }
});


test('explicit centered landings include the root bottom inset in their tall-target cutoff without changing top margins',async()=>{
 for(const bottom of [0,84])for(const context of [false,true]){
  const env=setup();try{
   const {w,$}=env;await media(env);w.happyDOM.setWindowSize({width:390,height:480});w.document.documentElement.style.scrollPaddingBottom=bottom+'px';
   $('reading-mode-toolbar').getBoundingClientRect=()=>({top:6,bottom:94,height:88});
   if(context){$('reading-context').hidden=false;$('reading-context').getBoundingClientRect=()=>({top:100,bottom:188,height:88});}
   const target=$('transcript').querySelector('.segment'),height=context?250:360,margin=context?194:100;let top=1800,calls=0,corrections=0;
   target.style.setProperty('scroll-margin-top','31px','important');target.getBoundingClientRect=()=>({top,bottom:top+height,height});
   target.scrollIntoView=options=>{calls++;assert.equal(options.block,bottom?'start':'center');assert.equal(target.style.scrollMarginTop,margin+'px');assert.equal(target.style.getPropertyPriority('scroll-margin-top'),'important');top=margin;};
   w.scrollBy=()=>{corrections++;};w.__dockMarginTarget=target;w.eval('scrollReadingTarget(window.__dockMarginTarget,{block:"center",behavior:"auto"})');
   assert.equal(calls,1);assert.equal(corrections,0);assert.equal(target.style.scrollMarginTop,'31px');assert.equal(target.style.getPropertyPriority('scroll-margin-top'),'important');assert.equal($('dock-follow').dataset.state,'off');
  }finally{await env.w.happyDOM.close();}
 }
});
