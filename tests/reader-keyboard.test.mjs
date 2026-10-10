import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url),shelfKey='coconut-reader-v1',preference='coconut-reading-shortcuts-v1';
function setup({saved,enabled,native=false}={}){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});
 if(saved)w.localStorage.setItem(shelfKey,saved);if(enabled!==undefined)w.localStorage.setItem(preference,enabled?'on':'off');
 const calls=[];w.fetch=async(...args)=>{calls.push(args);throw new Error('No remote operation authorized');};
 w.HTMLElement.prototype.scrollIntoView=function(){w.lastScrolled=this;};
 if(native)w.coconutUpdates={state:async()=>({status:'idle',version:'test',arch:'arm64'}),subscribe:()=>{}};
 w.eval(['summary','core','passages','passage-playback','app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+(native?'\nlet sourceSubmitting=false,sourceCaptionRequest=null;\n'+fs.readFileSync(new URL('reader/updates.js',root),'utf8'):''));
 const $=id=>w.document.getElementById(id);
 const press=(key,options={},target=w.document.activeElement)=>{const event=new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options});target.dispatchEvent(event);return event;};
 let nextRequestId=0;const request=(kind='close')=>({id:++nextRequestId,kind,expiresAt:Date.now()+60000});
 return {w,$,press,calls,request,close:async()=>{await new Promise(resolve=>setImmediate(resolve));w.dispatchEvent(new w.Event('pagehide'));await w.happyDOM.close();}};
}
const fixture=()=>({title:'Keyboard authored reading',language:'en',source_media:{job_id:'a'.repeat(32),kind:'audio'},readingPosition:'cue-19',notes:{'cue-2':'Saved reader note'},segments:Array.from({length:151},(_,i)=>({id:'cue-'+i,start:i*4,end:i*4+4,text:'Authored source needle '+i}))});
async function load(env,doc=fixture()){
 const text=JSON.stringify(doc);Object.defineProperty(env.$('file'),'files',{configurable:true,value:[{name:'authored.json',size:text.length,text:async()=>text}]});await env.$('file').onchange();
}
async function media(env,doc=fixture()){
 await load(env,doc);const {w,$}=env;w.dispatchEvent(new w.Event('coconut-worker-ready'));$('mode-transcript').click();
 const player=$('source-media').querySelector('audio');let paused=true,played=0,pauses=0,error=null,duration=700;
 Object.defineProperties(player,{duration:{configurable:true,get:()=>duration},paused:{configurable:true,get:()=>paused},error:{configurable:true,get:()=>error}});
 player.play=async()=>{played++;paused=false;player.dispatchEvent(new w.Event('play'));};
 player.pause=()=>{pauses++;paused=true;player.dispatchEvent(new w.Event('pause'));};
 player.currentTime=40;player.onloadedmetadata();$('transcript').focus();
 return {player,get played(){return played;},get pauses(){return pauses;},set error(value){error=value;},set duration(value){duration=value;}};
}
const saved=env=>JSON.parse(env.w.localStorage.getItem(shelfKey));
const row=(env,id)=>env.$('transcript').querySelector('[data-segment-id="'+id+'"]');

test('six reading keys reuse current button actions and one player without changing notes or reading marks',async()=>{
 const env=setup();try{const {w,$,press}=env,m=await media(env),before=w.localStorage.getItem(shelfKey),used=[];
 for(const id of ['skip-back','skip-forward','dock-play','locate-playback']){const original=$(id).onclick;$(id).onclick=(...args)=>{used.push(id);return original(...args);};}
 for(const [id,key] of [['skip-back','j'],['skip-forward','l'],['dock-play','k'],['locate-playback','g']]){$(id).disabled=true;assert.equal(press(key).defaultPrevented,false);$(id).disabled=false;}
 assert.equal(m.player.currentTime,40);assert.equal(m.played,0);assert.deepEqual(used,[]);
 assert.equal(press('j').defaultPrevented,true);assert.equal(m.player.currentTime,30);
 press('l');assert.equal(m.player.currentTime,40);press('k');assert.equal(m.player.paused,false);press('k');assert.equal(m.player.paused,true);
 m.player.currentTime=504;press('g');assert.equal(w.document.activeElement.dataset.segmentId,'cue-126');assert.equal(m.player.currentTime,504);assert.equal(m.player.paused,true);
 assert.deepEqual(used,['skip-back','skip-forward','dock-play','dock-play','locate-playback']);assert.equal(m.played,1);
 assert.equal($('source-media').querySelector('audio'),m.player);assert.equal(w.document.querySelectorAll('audio,video').length,1);
 assert.equal(w.localStorage.getItem(shelfKey),before);assert.equal(env.calls.length,0);
 }finally{await env.close();}
});

test('slash reveals existing search from passage, summary and collapsed demo without model actions',async()=>{
 const env=setup();try{const {w,$,press}=env;await load(env);$('passage-body').focus();
 assert.equal(press('/').defaultPrevented,true);assert.equal(w.document.activeElement,$('search'));assert.equal($('transcript-layout').hidden,false);
 $('search').value='needle';$('search').oninput();assert.equal(press('Enter').defaultPrevented,true);assert.equal(w.document.activeElement.dataset.segmentId,'cue-0');
 press('/');press('Enter',{shiftKey:true});assert.equal(w.document.activeElement.dataset.segmentId,'cue-150');assert.match($('match-position').textContent,/151 \/ 151/);
 press('/');press('Enter');assert.equal(w.document.activeElement.dataset.segmentId,'cue-0');
 $('mode-summary').click();$('reader-workspace').focus();press('/');assert.equal(w.document.activeElement,$('search'));assert.equal($('search').value,'needle');
 await $('sample').onclick();$('transcript').focus();press('/');assert.equal(w.document.activeElement,$('search'));assert.equal($('transcript-reading-tools').hidden,false);assert.equal($('toggle-demo-tools').getAttribute('aria-expanded'),'true');
 assert.equal(env.calls.length,0);
 }finally{await env.close();}
});

test('editing, widgets, native media and sidebar focus keep their own character keys',async()=>{
 const env=setup();try{const {w,$,press}=env,m=await media(env);
 row(env,'cue-2').querySelector('.note-button').click();$('note').value='jkl / ? g are my note';$('note').oninput();
 const controls=[$('note'),$('search'),$('reading-jump'),$('playback-rate'),$('keyboard-help-open'),$('reading-settings').querySelector('summary'),m.player,$('library-search'),$('source-url')];
 const edit=w.document.createElement('div');edit.contentEditable='true';edit.tabIndex=0;edit.innerHTML='<span><span id="editing-child">draft</span></span>';$('reader-workspace').append(edit);controls.push(edit);
 const widget=w.document.createElement('div');widget.setAttribute('role','slider');widget.tabIndex=0;$('reader-workspace').append(widget);controls.push(widget);
 const link=w.document.createElement('a');link.href='#';link.textContent='source';$('reader-workspace').append(link);controls.push(link);
 for(const control of controls){control.focus();for(const key of ['j','k','l','g','/','?',' '])assert.equal(press(key).defaultPrevented,false,control.tagName+' '+key);}
 edit.focus();assert.equal(press('k',{},$('editing-child')).defaultPrevented,false);
 $('transcript').focus();w.document.body.setAttribute('contenteditable','true');assert.equal(press('k').defaultPrevented,false);w.document.body.removeAttribute('contenteditable');
 assert.equal(m.played,0);assert.equal(m.player.currentTime,40);assert.equal($('keyboard-help').open,false);assert.equal(saved(env).documents[0].notes['cue-2'],'jkl / ? g are my note');
 }finally{await env.close();}
});

test('composition, repeat, modifiers, prevented events and non-reader workspaces do not intercept',async()=>{
 const env=setup();try{const {w,$,press}=env,m=await media(env);
 for(const options of [{repeat:true},{isComposing:true},{keyCode:229},{ctrlKey:true},{metaKey:true},{altKey:true},{shiftKey:true}])for(const key of ['j','k','l','g','/'])assert.equal(press(key,options).defaultPrevented,false);
 w.document.dispatchEvent(new w.CompositionEvent('compositionstart'));assert.equal(press('k').defaultPrevented,false);w.document.dispatchEvent(new w.CompositionEvent('compositionend'));
 const prevented=new w.KeyboardEvent('keydown',{key:'k',bubbles:true,cancelable:true});prevented.preventDefault();$('transcript').dispatchEvent(prevented);assert.equal(m.played,0);
 assert.equal(press('?',{shiftKey:true,repeat:true}).defaultPrevented,false);assert.equal($('keyboard-help').open,false);
 $('add-content').click();w.document.activeElement.blur();for(const key of ['j','k','l','g','/','?'])assert.equal(press(key).defaultPrevented,false);assert.equal(m.played,0);assert.equal(m.player.currentTime,40);
 }finally{await env.close();}
});

test('native and ARIA modals block reading shortcuts even when focus is on reader text',async()=>{
 const env=setup();try{const {w,$,press}=env,m=await media(env);
 for(const dialog of [$('edit-dialog'),$('source-dialog'),$('details-dialog'),$('remove-document-dialog'),$('finish-removal-dialog'),$('large-backup-dialog')]){dialog.showModal();$('transcript').focus();for(const key of ['j','k','l','g','/','?'])assert.equal(press(key).defaultPrevented,false);dialog.close();}
 const modal=w.document.createElement('section');modal.setAttribute('aria-modal','true');w.document.body.append(modal);$('transcript').focus();assert.equal(press('k').defaultPrevented,false);modal.remove();
 assert.equal(m.played,0);assert.equal(m.player.currentTime,40);
 }finally{await env.close();}
});

test('help preserves playing preview and restores connected focus after close',async()=>{
 const env=setup();try{const {w,$,press}=env,m=await media(env);$('mode-passages').click();const first=$('passage-body').querySelector('.passage');
 first.querySelector('.passage-listen').click();await Promise.resolve();first.focus();const time=m.player.currentTime,pauses=m.pauses,played=m.played;
 assert.equal(press('?',{shiftKey:true}).defaultPrevented,true);assert.equal($('keyboard-help').open,true);assert.equal(w.document.activeElement,$('keyboard-help-close'));
 assert.equal(m.player.paused,false);assert.equal($('passage-playback-controls').hidden,false);for(const key of ['j','k','l','g','/','?'])assert.equal(press(key).defaultPrevented,false);
 $('keyboard-help-close').click();await Promise.resolve();assert.equal(w.document.activeElement,first);assert.equal(m.player.currentTime,time);assert.equal(m.pauses,pauses);assert.equal(m.played,played);
 press('k');assert.equal(m.player.paused,true);assert.equal($('passage-playback-controls').hidden,false);press('k');assert.equal(m.player.paused,false);
 m.player.currentTime=w.CoconutPassages.build(fixture().segments)[0].end;m.player.dispatchEvent(new w.Event('timeupdate'));assert.equal(m.player.paused,true,'bounded preview must still stop');
 $('keyboard-help-open').focus();$('keyboard-help-open').click();$('keyboard-help-close').click();await Promise.resolve();assert.equal(w.document.activeElement,$('keyboard-help-open'));
 }finally{await env.close();}
});

test('help restores a safe current-document target if the original row was replaced',async()=>{
 const env=setup();try{const {w,$,press}=env;await media(env);row(env,'cue-2').focus();press('?');row(env,'cue-2').remove();$('keyboard-help-close').click();await Promise.resolve();assert.equal(w.document.activeElement,$('keyboard-help-open'));
 }finally{await env.close();}
});

test('ordinary seek releases a bounded preview and cue loop through existing controls',async()=>{
 const env=setup();try{const {$,press}=env,m=await media(env);$('mode-passages').click();$('passage-body').querySelector('.passage-listen').click();await Promise.resolve();$('passage-body').focus();
 press('l');assert.equal(m.player.currentTime,10);assert.equal($('passage-playback-controls').hidden,true);
 m.player.currentTime=25;m.player.dispatchEvent(new env.w.Event('timeupdate'));assert.equal(m.player.paused,false);
 $('mode-transcript').click();row(env,'cue-2').querySelector('.repeat-button').click();$('transcript').focus();assert.equal($('stop-repeat').hidden,false);press('j');assert.equal($('stop-repeat').hidden,true);assert.equal(m.player.currentTime,0);
 }finally{await env.close();}
});

test('no media, not-yet-loaded media, errors, gaps and audio-only projects never acquire a source',async()=>{
 const env=setup();try{const {$,press}=env;await load(env);$('passage-body').focus();for(const key of ['j','k','l','g'])assert.equal(press(key).defaultPrevented,false);assert.equal($('source-media').children.length,0);
 const m=await media(env);m.duration=NaN;for(const key of ['j','k','l','g'])assert.equal(press(key).defaultPrevented,false);m.duration=700;m.error={code:4};assert.equal(press('k').defaultPrevented,false);m.error=null;m.player.currentTime=699;assert.equal(press('g').defaultPrevented,false);
 assert.equal(m.played,0);await load(env,{project_kind:'audio_only',transcript_status:'unavailable',title:'Authored audio project',podcast_source:{kind:'direct_media',media_url:'https://example.invalid/authored.wav',media_kind:'audio'},segments:[],project_note:'Keep this thought'});$('reader-workspace').focus();assert.equal(press('/').defaultPrevented,false);assert.equal(press('g').defaultPrevented,false);assert.equal($('audio-project').hidden,false);assert.equal($('project-note').value,'Keep this thought');assert.equal(env.calls.length,0);
 }finally{await env.close();}
});

test('disabling all character keys survives reload, keeps a clickable help and leaves search Enter available',async()=>{
 const env=setup();let restored;try{const {w,$,press}=env,m=await media(env);
 $('keyboard-help-open').click();$('keyboard-shortcuts-enabled').checked=false;$('keyboard-shortcuts-enabled').onchange();$('keyboard-help-close').click();await Promise.resolve();$('transcript').focus();
 for(const key of ['j','k','l','g','/','?'])assert.equal(press(key).defaultPrevented,false);
 assert.equal(m.played,0);assert.equal(w.localStorage.getItem(preference),'off');assert.equal($('dock-play').hasAttribute('aria-keyshortcuts'),false);assert.equal($('keyboard-help-open').hasAttribute('aria-keyshortcuts'),false);
 $('search').focus();$('search').value='needle';$('search').oninput();press('Enter');assert.equal(w.document.activeElement.dataset.segmentId,'cue-0');
 restored=setup({saved:w.localStorage.getItem(shelfKey),enabled:false});restored.$('keyboard-help-open').click();assert.equal(restored.$('keyboard-help').open,true);assert.equal(restored.$('keyboard-shortcuts-enabled').checked,false);
 restored.$('keyboard-shortcuts-enabled').checked=true;restored.$('keyboard-shortcuts-enabled').onchange();assert.equal(restored.$('dock-play').getAttribute('aria-keyshortcuts'),'K');assert.equal(restored.$('keyboard-help-open').getAttribute('aria-keyshortcuts'),'Shift+/');
 }finally{await env.close();await restored?.close();}
});

test('preference write failures still apply for this page with honest feedback',async()=>{
 const env=setup();try{const {$,press,w}=env;await media(env);const backing=w.localStorage;Object.defineProperty(w,'localStorage',{configurable:true,value:{getItem:key=>backing.getItem(key),setItem:(key,value)=>{if(key===preference)throw new Error('quota');backing.setItem(key,value);}}});
 $('keyboard-shortcuts-enabled').checked=false;$('keyboard-shortcuts-enabled').onchange();assert.match($('keyboard-preference-status').textContent,/本次设置已生效.*未保存/);assert.equal(press('k').defaultPrevented,false);
 }finally{await env.close();}
});


test('native close and inert locks reject body/document shortcuts until release',async()=>{
 const env=setup({native:true});try{const {w,$,press}=env,m=await media(env);
 const inertKeys=()=>{
  const time=m.player.currentTime,played=m.played,focus=w.document.activeElement;
  for(const target of [w.document,w.document.body,$('reader-workspace')])for(const key of ['k','j','g','?'])assert.equal(press(key,{},target).defaultPrevented,false);
  assert.equal(m.player.currentTime,time);assert.equal(m.played,played);assert.equal(w.document.activeElement,focus);assert.equal($('keyboard-help').open,false);
 };
 // A real final native-close approval owns the lock. Clearing only the DOM
 // attribute must not release readerClosing or allow a stale body event.
 Object.defineProperty($('file'),'files',{configurable:true,value:[]});
 const owner=env.request();assert.equal(w.coconutPrepareClose('safe',owner),true);assert.equal(w.document.body.inert,true);inertKeys();
 w.document.body.inert=false;inertKeys();
 assert.equal(w.coconutPrepareClose('release',owner),true);
 for(const node of [w.document.body,$('reader-workspace')]){node.inert=true;inertKeys();node.inert=false;node.setAttribute('inert','');inertKeys();node.removeAttribute('inert');}
 $('transcript').focus();assert.equal(press('j').defaultPrevented,true);assert.equal(m.player.currentTime,30);assert.equal(press('k').defaultPrevented,true);assert.equal(m.player.paused,false);
 }finally{await env.close();}
});


const input=(env,node,value)=>{node.value=value;node.dispatchEvent(new env.w.Event('input',{bubbles:true}));};
const checkpoint=env=>JSON.parse(env.w.localStorage.getItem('coconut-listening-v1:'+env.w.sessionStorage.getItem('coconut-reader-active-v1')));
for(const native of [false,true])test(`${native?'native':'Web'} unsaved glossary and bookmark drafts survive keyboard navigation and help`,async()=>{
 const env=setup({native});try{const {w,$,press}=env,doc={...fixture(),project_note:'Saved project note',timestamp_bookmarks:[{id:'first',time:10,note:'Saved bookmark'}]},m=await media(env,doc);
 Object.defineProperty($('file'),'files',{configurable:true,value:[]});
 const dirty=()=>{if(native)return !w.coconutPrepareClose('inspect').safe;const event=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(event);return event.defaultPrevented;};
 assert.equal(dirty(),false);const original=w.localStorage.getItem(shelfKey);
 input(env,$('translation-glossary'),'Needle = 关键词');input(env,$('audio-bookmark-time'),'15');input(env,$('audio-bookmark-note'),'An unfinished bookmark');
 $('audio-bookmarks').querySelector('.edit-bookmark-time').click();input(env,$('audio-bookmarks').querySelector('form input'),'21');assert.equal(dirty(),true);
 $('transcript').focus();press('g');press('/');input(env,$('search'),'needle');press('Enter');press('g');
 press('?');assert.equal($('keyboard-help').open,true);$('keyboard-help-close').click();await new Promise(resolve=>setImmediate(resolve));
 press('k');press('k');press('j');press('l');press('g');
 assert.equal($('translation-glossary').value,'Needle = 关键词');assert.equal($('audio-bookmark-time').value,'15');assert.equal($('audio-bookmark-note').value,'An unfinished bookmark');
 assert.equal($('audio-bookmarks').querySelector('form input').value,'21');assert.equal(dirty(),true);assert.equal(w.localStorage.getItem(shelfKey),original);assert.equal($('source-media').querySelector('audio'),m.player);
 $('cancel-translation-glossary').click();$('cancel-audio-bookmark').click();$('audio-bookmarks').querySelector('form [type="button"]').click();assert.equal(dirty(),false);assert.equal(env.calls.length,0);
 }finally{await env.close();}
});

test('keyboard pause and seek preserve separate primary and preview listening ownership',async()=>{
 const env=setup();try{const {w,$,press}=env,m=await media(env),library=w.localStorage.getItem(shelfKey);
 m.player.currentTime=70;press('k');press('k');assert.equal(checkpoint(env).time,70);
 $('mode-passages').click();$('passage-body').querySelector('.passage-listen').click();await new Promise(resolve=>setImmediate(resolve));$('passage-body').focus();
 m.player.currentTime=8;press('k');assert.equal(m.player.paused,true);assert.equal(checkpoint(env).time,70);press('?');$('keyboard-help-close').click();await new Promise(resolve=>setImmediate(resolve));assert.equal(checkpoint(env).time,70);
 press('k');assert.equal(m.player.paused,false);m.player.currentTime=9;press('k');assert.equal(checkpoint(env).time,70);
 press('l');m.player.dispatchEvent(new w.Event('seeked'));assert.equal($('passage-playback-controls').hidden,true);assert.equal(checkpoint(env).time,19);
 press('j');m.player.dispatchEvent(new w.Event('seeked'));assert.equal(checkpoint(env).time,9);assert.equal(w.localStorage.getItem(shelfKey),library);assert.equal(env.calls.length,0);
 }finally{await env.close();}
});

for(const preview of [false,true])test(`native close flush after keyboard use ${preview?'excludes a bounded preview':'keeps the final main clock'}`,async()=>{
 const env=setup({native:true});try{const {w,$,press}=env,m=await media(env);Object.defineProperty($('file'),'files',{configurable:true,value:[]});
 m.player.currentTime=70;press('k');press('k');assert.equal(checkpoint(env).time,70);
 if(preview){$('mode-passages').click();$('passage-body').querySelector('.passage-listen').click();await new Promise(resolve=>setImmediate(resolve));$('passage-body').focus();m.player.currentTime=8;press('k');}
 else m.player.currentTime=73;
 assert.equal(w.coconutPrepareClose('safe',env.request()),true);assert.equal(checkpoint(env).time,preview?70:73);
 const time=m.player.currentTime,played=m.played;for(const target of [w.document,w.document.body])for(const key of ['j','k','g','?'])assert.equal(press(key,{},target).defaultPrevented,false);
 assert.equal(m.player.currentTime,time);assert.equal(m.played,played);assert.equal($('keyboard-help').open,false);
 }finally{await env.close();}
});
