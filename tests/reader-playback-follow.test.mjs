import {installSavePipeline,settle} from './helpers/save-pipeline.mjs';
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
 const frames=new Map();let frameId=0;w.requestAnimationFrame=fn=>{frames.set(++frameId,fn);return frameId;};w.cancelAnimationFrame=id=>frames.delete(id);
 const tick=()=>{const queued=[...frames.values()];frames.clear();for(const fn of queued)fn();};
 const scrolls=[];w.HTMLElement.prototype.scrollIntoView=function(options){scrolls.push({id:this.dataset.segmentId||this.dataset.cueId,options});w.dispatchEvent(new w.Event('scroll'));};
 const calls=[];w.fetch=async(...args)=>{calls.push(args);throw new Error('No source or AI request authorized');};
 const pipeline=installSavePipeline(w);
 const shelfTasks=[];
 w.eval(['summary','core'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
 const createSearch=w.Coconut.createLibrarySearch;w.Coconut.createLibrarySearch=options=>createSearch({...options,schedule:fn=>shelfTasks.push(fn),now:()=>0,batchSize:7});
 w.eval(['passages','passage-playback','app','language','translation-review','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+`\nwindow.followTest={doc:()=>active(),seedShelf:()=>{for(let i=0;i<181;i++)state.documents.push({...Coconut.validate({title:"Shelf "+i,segments:[{id:"shelf-cue",start:0,end:1,text:"authored shelf needle"}]}),key:"shelf-"+i});renderLibrary();},queue:()=>queueDocument(active()),render:()=>render(),replace:()=>{active().segments=[...active().segments];render();},offset:value=>{browserMedia.set(active().key,{origin:'local',identity:'file-candidate-v1:authored',url:followPlayer().getAttribute('src'),kind:'audio'});active().media_timing={version:1,identity:'file-candidate-v1:authored',offset:value};},media:()=>{browserMedia.set(active().key,{origin:'local',identity:'replacement',url:followPlayer().getAttribute('src'),kind:'audio'});render();},range:()=>passagePageStart};`);
 return {w,$:id=>w.document.getElementById(id),calls,tick,scrolls,pipeline,shelfTasks};
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


function enable(env){env.$('follow-playback').focus();env.$('follow-playback').click();env.tick();}
function seek(env,m,time){m.player.currentTime=time;m.refresh();env.tick();}
test('off by default; enabling never plays; playing crosses bounded pages without focus or bookmarks',async()=>{
 const env=setup();try{const m=await media(env),{$,w,tick,scrolls}=env;seek(env,m,500);assert.equal(scrolls.length,0);assert.equal($('follow-playback').getAttribute('aria-pressed'),'false');
 enable(env);assert.equal(m.played,0);assert.equal(scrolls.length,0);assert.equal($('follow-playback').textContent,'跟随待播放');
 const before=w.followTest.doc().readingPosition;await m.player.play();tick();assert.equal(w.document.querySelector('.segment').dataset.segmentId,'cue-100');assert.equal(scrolls.at(-1).id,'cue-125');assert.equal(w.document.activeElement,$('follow-playback'));assert.equal(w.followTest.doc().readingPosition,before);assert.equal($('follow-playback').dataset.state,'following');
 }finally{await env.w.happyDOM.close();}
});
test('manual wheel cancels pending correction, programmatic scroll does not, resume and rapid toggles are deterministic',async()=>{
 const env=setup();try{const m=await media(env),{$,w,tick,scrolls}=env;await m.player.play();enable(env);const before=scrolls.length;
 m.player.currentTime=500;m.refresh();w.dispatchEvent(new w.WheelEvent('wheel'));tick();assert.equal(scrolls.length,before);assert.equal($('dock-follow').textContent,'恢复跟随');
 enable(env);assert.equal(scrolls.at(-1).id,'cue-125');assert.equal($('dock-follow').dataset.state,'following');
 $('follow-playback').click();$('follow-playback').click();$('follow-playback').click();tick();assert.equal($('dock-follow').dataset.state,'off');
 }finally{await env.w.happyDOM.close();}
});
test('search mismatch, dialogs and exact note drafts suspend without clearing filters or caret',async()=>{
 const env=setup();try{const m=await media(env),{$,w,tick,scrolls}=env;await m.player.play();$('search').value='not present';$('search').oninput();enable(env);assert.equal($('dock-follow').dataset.state,'suspended');assert.equal($('search').value,'not present');assert.equal(scrolls.length,0);
 $('search').value='';$('search').oninput();enable(env);$('edit-dialog').showModal();const count=scrolls.length;seek(env,m,500);assert.equal(scrolls.length,count);assert.equal($('dock-follow').dataset.state,'suspended');$('edit-dialog').close();
 $('reading-jump').value='cue-0';$('reading-jump').onchange();w.document.querySelector('.note-button').click();$('note').value='  exact\n  draft  ';$('note').selectionStart=4;$('note').selectionEnd=7;enable(env);seek(env,m,500);assert.equal($('note').value,'  exact\n  draft  ');assert.equal($('note').selectionStart,4);assert.equal($('note').selectionEnd,7);assert.equal($('dock-follow').dataset.state,'suspended');
 }finally{await env.w.happyDOM.close();}
});
test('pause, stop and background receipts never move the viewport; replacement retires old pending ownership',async()=>{
 const env=setup();try{const m=await media(env),{$,w,tick,scrolls}=env;await m.player.play();enable(env);m.player.currentTime=500;m.refresh();m.player.pause();tick();const count=scrolls.length;w.followTest.render();tick();assert.equal(scrolls.length,count);assert.equal(w.document.querySelector('.segment').dataset.segmentId,'cue-0');
 await m.player.play();w.followTest.replace();tick();assert.equal($('dock-follow').dataset.state,'off');assert.equal(scrolls.length,count);
 enable(env);m.player.currentTime=550;m.refresh();await add($,{title:'Other',segments:[{id:'new',start:0,end:3,text:'Other source.'}]});tick();assert.equal($('dock-follow').getAttribute('aria-pressed'),'false');assert.equal($('follow-playback').disabled,true);
 }finally{await env.w.happyDOM.close();}
});
test('passage mode crosses its bounded pages without changing return navigation or focus',async()=>{
 const env=setup();try{const m=await media(env),{$,w,tick,scrolls}=env;$('mode-passages').click();await m.player.play();enable(env);seek(env,m,590);assert.ok(w.followTest.range()>0);assert.equal(scrolls.at(-1).id,'cue-147');assert.equal(w.document.activeElement,$('follow-playback'));assert.ok(w.document.querySelectorAll('.passage').length<=8);
 }finally{await env.w.happyDOM.close();}
});

test('inverse calibrated clock selects the cue; same-path local replacement retires ownership',async()=>{
 const env=setup();try{const m=await media(env),{$,w,tick,scrolls}=env;w.followTest.offset(8);await m.player.play();enable(env);seek(env,m,508);assert.equal(scrolls.at(-1).id,'cue-125');assert.equal(m.player.currentTime,508);
 m.player.currentTime=520;m.refresh();const count=scrolls.length;w.followTest.media();tick();assert.equal(scrolls.length,count);assert.equal($('dock-follow').dataset.state,'off');
 }finally{await env.w.happyDOM.close();}
});
test('comfortable cue stays put; pointer, touch, keyboard and typing intent suspend immediately',async()=>{
 const env=setup();try{const m=await media(env),{$,w,tick,scrolls}=env;await m.player.play();enable(env);const row=w.document.querySelector('.segment');row.getBoundingClientRect=()=>({top:180,bottom:240,height:60});const count=scrolls.length;seek(env,m,1);assert.equal(scrolls.length,count);
 for(const event of [new w.PointerEvent('pointerdown',{bubbles:true}),new w.Event('touchstart',{bubbles:true}),new w.KeyboardEvent('keydown',{bubbles:true,key:'PageDown'}),new w.Event('input',{bubbles:true})]){w.document.body.dispatchEvent(event);assert.equal($('dock-follow').dataset.state,'suspended');enable(env);}
 Object.defineProperty(m.player,'ended',{configurable:true,value:true});seek(env,m,500);assert.equal(w.document.querySelector('.segment').dataset.segmentId,'cue-0');
 }finally{await env.w.happyDOM.close();}
});

test('scrollbar or assistive scrolling to an unowned position suspends without a wheel event',async()=>{
 const env=setup();try{const m=await media(env),{$,w}=env;await m.player.play();enable(env);Object.defineProperty(w,'scrollY',{configurable:true,value:230});w.dispatchEvent(new w.Event('scroll'));assert.equal($('dock-follow').dataset.state,'suspended');
 }finally{await env.w.happyDOM.close();}
});

test('touch taps can turn follow off and native transport does not suspend it',async()=>{
 const env=setup();try{const m=await media(env),{$,w}=env;await m.player.play();enable(env);$('dock-play').dispatchEvent(new w.Event('touchstart',{bubbles:true}));assert.equal($('dock-follow').dataset.state,'following');$('follow-playback').dispatchEvent(new w.Event('touchstart',{bubbles:true}));$('follow-playback').click();assert.equal($('dock-follow').dataset.state,'off');
 }finally{await env.w.happyDOM.close();}
});

test('deferred backward following keeps the focused dock visible until explicit blur',async()=>{
 const env=setup();try{const m=await media(env),{$,w,tick}=env;await m.player.play();m.player.currentTime=500;enable(env);tick();$('dock-follow').focus();let bottom=-20;$('episode-media').getBoundingClientRect=()=>({bottom});
 const original=w.HTMLElement.prototype.scrollIntoView;w.HTMLElement.prototype.scrollIntoView=function(options){bottom=300;original.call(this,options);};
 seek(env,m,0);tick();assert.equal($('media-dock').hidden,false);assert.equal(w.document.activeElement,$('dock-follow'));assert.equal($('dock-follow').isConnected,true);assert.equal($('follow-playback').dataset.state,'following');
 $('follow-playback').focus();tick();assert.equal($('media-dock').hidden,true);assert.equal(w.document.activeElement,$('follow-playback'));
 }finally{await env.w.happyDOM.close();}
});

test('native same-element reload retires follow; media errors suspend rather than silently resume',async()=>{
 const env=setup();try{const m=await media(env),{$,w,tick,scrolls}=env;await m.player.play();enable(env);m.player.dispatchEvent(new w.Event('error'));assert.equal($('dock-follow').dataset.state,'suspended');enable(env);m.player.currentTime=500;m.refresh();const count=scrolls.length;m.player.dispatchEvent(new w.Event('emptied'));tick();assert.equal($('dock-follow').dataset.state,'off');assert.equal(scrolls.length,count);
 }finally{await env.w.happyDOM.close();}
});


test('combined autosave receipts and cooperative shelf completion cannot drive follow or steal focus',async()=>{
 const env=setup();try{const m=await media(env),{$,w,tick,scrolls,pipeline,shelfTasks}=env;
 await w.flushContentForTest();await settle();w.followTest.seedShelf();
 $('library-scope').value='text';$('library-search').value='needle';$('library-search').oninput();
 assert.ok(shelfTasks.length);await m.player.play();enable(env);
 const focused=w.document.activeElement,count=scrolls.length,first=w.document.querySelector('.segment');
 // A changed clock without a media event must not be consumed by background work.
 m.player.currentTime=500;pipeline.hold();w.followTest.doc().project_note='Saved background annotation';w.followTest.queue();
 const flush=w.flushContentForTest();await settle();assert.equal(pipeline.writes.length,1);
 pipeline.writes[0].commit();await flush;await settle();
 let guard=1000;while(shelfTasks.length){assert.ok(guard-->0);shelfTasks.shift()();}tick();
 assert.equal($('library').children.length,40);assert.match($('library-page-status').textContent,/181/);
 assert.equal(w.document.activeElement,focused);assert.equal(scrolls.length,count);assert.equal(w.document.querySelector('.segment'),first);
 assert.equal($('dock-follow').dataset.state,'following');assert.equal(pipeline.store.status().pending,0);
 }finally{await env.w.happyDOM.close();}
});
test('combined notebook and manual translation editing interrupt queued follow while preserving exact drafts',async()=>{
 const env=setup();try{const m=await media(env),{$,w,tick,scrolls}=env;
 await m.player.play();enable(env);m.player.currentTime=500;m.refresh();const count=scrolls.length;
 $('open-library-notebook').click();tick();assert.equal($('library-notebook').open,true);assert.equal($('dock-follow').dataset.state,'suspended');assert.equal(scrolls.length,count);
 $('notebook-search').value='  exact notebook query  ';$('notebook-search').oninput();$('notebook-close').click();
 enable(env);m.player.currentTime=550;m.refresh();
 w.CoconutTranslationReview.openEditor(w.followTest.doc().key,'cue-0','zh');
 const editor=$('translation-edit-text');editor.value='  exact\n human draft  ';editor.dispatchEvent(new w.Event('input',{bubbles:true}));editor.focus();editor.selectionStart=3;editor.selectionEnd=8;
 tick();assert.equal($('dock-follow').dataset.state,'suspended');const after=scrolls.length;
 seek(env,m,580);assert.equal(scrolls.length,after);assert.equal(w.document.activeElement,editor);assert.equal(editor.value,'  exact\n human draft  ');assert.equal(editor.selectionStart,3);assert.equal(editor.selectionEnd,8);
 assert.equal($('notebook-search').value,'  exact notebook query  ');assert.equal(env.calls.length,0);
 }finally{await env.w.happyDOM.close();}
});
