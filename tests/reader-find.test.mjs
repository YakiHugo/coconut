import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url),html=fs.readFileSync(new URL('reader/index.html',root),'utf8');
// All behavior scripts in their actual shipped order, including jobs and updates.
// The asynchronous resource loader itself is covered by storage-bootstrap tests.
const scripts=[...html.matchAll(/<script src="([^?]+)\?[^\"]+"/g)].map(match=>match[1]).filter(name=>name!=='storage-bootstrap.js');
function setup(native=false){
 const w=new Window({url:'https://coconut.example/'});w.document.body.innerHTML=html.split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});w.HTMLElement.prototype.scrollIntoView=function(){};
 const calls=[];w.fetch=async(...args)=>{calls.push(args);throw Error('No remote operation authorized');};
 if(native)w.coconutUpdates={state:async()=>({status:'idle',version:'test',arch:'arm64'}),subscribe:()=>{}};
 w.eval(scripts.map(name=>fs.readFileSync(new URL('reader/'+name,root),'utf8')).join('\n'));
 w.CoconutStorageBootstrap={phase:'ready'};
 const $=id=>w.document.getElementById(id);
 const press=(key='f',options={ctrlKey:true},target=w.document.activeElement)=>{const event=new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options});target.dispatchEvent(event);return event.defaultPrevented;};
 const command=(request={issuedAt:Date.now(),expiresAt:Date.now()+2000})=>w.coconutFileCommand('find-transcript',request);
 return {w,$,press,command,calls,close:async()=>{w.dispatchEvent(new w.Event('pagehide'));await w.happyDOM.close();}};
}
const fixture=()=>({title:'Authored Find transcript',readingPosition:'cue-70',project_note:'Saved project note',segments:Array.from({length:151},(_,i)=>({id:'cue-'+i,start:i*4,end:i*4+4,text:'Authored needle '+i}))});
async function load(env,doc=fixture()){
 const value=JSON.stringify(doc);Object.defineProperty(env.$('file'),'files',{configurable:true,value:[{name:'find.json',size:value.length,text:async()=>value}]});await env.$('file').onchange();
}
for(const native of [false,true])test(`${native?'native':'Web'} Find opens whole-transcript search with character keys off and preserves search navigation`,async()=>{
 const env=setup(native);try{const {w,$,press,command,calls}=env;await load(env);
 $('keyboard-shortcuts-enabled').checked=false;$('keyboard-shortcuts-enabled').onchange();$('passage-body').focus();
 const before=w.localStorage.getItem('coconut-reader-v1'),requests=calls.length;
 assert.equal(press(),true);assert.equal(w.document.activeElement,$('search'));assert.equal($('transcript-layout').hidden,false);
 $('search').value='needle';$('search').oninput();assert.equal(press('Enter',{}),true);assert.equal(w.document.activeElement.dataset.segmentId,'cue-0');
 assert.equal(press('f',{metaKey:true}),true);assert.equal($('search').value,'needle');assert.equal($('search').selectionStart,0);assert.equal($('search').selectionEnd,6);
 assert.equal(press('Enter',{shiftKey:true}),true);assert.equal(w.document.activeElement.dataset.segmentId,'cue-150');
 if(native){assert.equal(command(),true);assert.equal(w.document.activeElement,$('search'));}
 else assert.equal(w.coconutFileCommand,undefined);
 $('mode-passages').click();assert.equal($('passage-workspace').hidden,false);assert.ok(w.document.activeElement.querySelector('[data-cue-id="cue-150"]'));
 assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);assert.equal(calls.length,requests);
 $('mode-summary').click();$('mode-summary').focus();assert.equal(press(),true);assert.equal(w.document.activeElement,$('search'));
 await $('sample').onclick();$('passage-body').focus();assert.equal(press(),true);assert.equal($('transcript-reading-tools').hidden,false);
 }finally{await env.close();}
});
for(const native of [false,true])test(`${native?'native':'Web'} Find leaves editors, unsupported workspaces, modals and audio-only projects alone`,async()=>{
 const env=setup(native);try{const {w,$,press,command}=env;await load(env);
 const ignored=()=>{const focus=w.document.activeElement,mode=w.document.body.dataset.readingMode;assert.equal(press(),false);assert.equal(press('f',{metaKey:true}),false);if(native)assert.equal(command(),false);assert.equal(w.document.activeElement,focus);assert.equal(w.document.body.dataset.readingMode,mode);};
 $('mode-transcript').click();$('transcript').querySelector('.note-button').click();$('note').focus();$('note').value='Unfinished editor text';ignored();assert.equal($('note').value,'Unfinished editor text');
 for(const id of ['translation-glossary','audio-bookmark-note','library-search','source-url']){$(id).focus();ignored();}
 const host=w.document.createElement('div');host.tabIndex=0;const shadow=host.attachShadow({mode:'open'}),shadowInput=w.document.createElement('textarea');shadow.append(shadowInput);$('reader-workspace').append(host);shadowInput.focus();ignored();host.remove();
 const edit=w.document.createElement('div');edit.contentEditable='true';edit.tabIndex=0;$('reader-workspace').append(edit);edit.focus();ignored();edit.remove();
 $('details-dialog').showModal();$('document-title').focus();ignored();$('details-dialog').close();
 const modal=w.document.createElement('div');modal.setAttribute('aria-modal','true');w.document.body.append(modal);$('transcript').focus();ignored();modal.remove();
 for(const node of [w.document.body,$('reader-workspace')]){node.inert=true;$('transcript').focus();ignored();node.inert=false;}
 w.document.dispatchEvent(new w.CompositionEvent('compositionstart'));$('transcript').focus();ignored();w.document.dispatchEvent(new w.CompositionEvent('compositionend'));
 $('add-content').click();w.document.activeElement.blur();ignored();
 await load(env,{project_kind:'audio_only',transcript_status:'unavailable',title:'Authored audio',podcast_source:{kind:'direct_media',media_url:'https://example.invalid/audio.wav',media_kind:'audio'},segments:[],project_note:'Saved audio note'});$('reader-workspace').focus();ignored();assert.equal($('audio-project').hidden,false);
 }finally{await env.close();}
});
test('Find ignores repeated, composed, prevented and unrelated modified keyboard events',async()=>{
 const env=setup();try{const {w,$,press}=env;await load(env);$('passage-body').focus();
 for(const options of [{ctrlKey:true,repeat:true},{metaKey:true,isComposing:true},{ctrlKey:true,keyCode:229},{ctrlKey:true,shiftKey:true},{ctrlKey:true,altKey:true},{ctrlKey:true,metaKey:true},{}])assert.equal(press('f',options),false);
 const event=new w.KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true});event.preventDefault();$('passage-body').dispatchEvent(event);assert.equal(w.document.activeElement,$('passage-body'));
 w.document.body.contentEditable='true';assert.equal(press(),false);w.document.body.contentEditable='false';assert.equal(press(),true);
 }finally{await env.close();}
});
test('native Find rejects stale, startup, closed and final-close locked dispatch without acquiring media',async()=>{
 const env=setup(true);try{const {w,$,command}=env;await load(env);$('passage-body').focus();
 for(const phase of ['loading','failed','closed']){w.CoconutStorageBootstrap.phase=phase;assert.equal(command(),false);}w.CoconutStorageBootstrap.phase='ready';
 assert.equal(command({issuedAt:0,expiresAt:Date.now()+2000}),false);assert.equal(command({issuedAt:Date.now(),expiresAt:0}),false);
 Object.defineProperty($('file'),'files',{configurable:true,value:[]});const owner={id:1,kind:'close',expiresAt:Date.now()+60000};
 assert.equal(await w.coconutPrepareClose('safe',owner),true);assert.equal(command(),false);w.document.body.inert=false;assert.equal(command(),false);
 assert.equal(w.coconutPrepareClose('release',owner),true);$('passage-body').focus();assert.equal(command(),true);assert.equal(w.document.querySelectorAll('audio,video').length,0);
 w.dispatchEvent(new w.Event('pagehide'));assert.equal(command(),false);
 }finally{await env.close();}
});


test('production bootstrap admits separate classic scripts before native Find uses the same search action',async()=>{
 const w=new Window({url:'http://127.0.0.1:8080/'}),$=id=>w.document.getElementById(id),context=vm.createContext(w),admitted=[],requests=[];
 const run=source=>vm.runInContext(source,context);
 try{
  w.document.body.innerHTML=html.split('<body>')[1].split('</body>')[0];Object.defineProperty(w,'crypto',{value:webcrypto});w.HTMLElement.prototype.scrollIntoView=function(){};
  w.coconutUpdates={state:async()=>({status:'idle',version:'test',arch:'arm64'}),subscribe:()=>{}};
  w.fetch=async url=>{if(url==='api/health')return {ok:true,json:async()=>({})};requests.push(url);throw Error('Unexpected request');};
  w.document.head.innerHTML=[...html.matchAll(/<script\b[^>]*data-reader-script[^>]*>[\s\S]*?<\/script>/g)].map(match=>match[0]).join('');
  w.document.head.append=script=>{const name=new URL(script.src).pathname.slice(1);admitted.push(name);try{run(fs.readFileSync(new URL('reader/'+name,root),'utf8'));queueMicrotask(()=>script.onload());}catch(error){script.onerror(error);}};
  for(const name of ['appearance','summary','core','passages','quotation','passage-playback','library-store','indexeddb-document-adapter','storage-provider','storage-bootstrap'])run(fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8'));
  for(let i=0;i<100&&w.CoconutStorageBootstrap.phase==='loading';i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(w.CoconutStorageBootstrap.phase,'ready');assert.deepEqual(admitted,['app.js','language.js','translation-review.js','podcasts.js','jobs.js','updates.js']);
  await load({w,$});$('passage-body').focus();
  assert.equal(w.coconutFileCommand('find-transcript',{issuedAt:Date.now(),expiresAt:Date.now()+2000}),true);assert.equal(w.document.activeElement,$('search'));
  $('search').value='needle';$('search').oninput();$('search').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));assert.equal(w.document.activeElement.dataset.segmentId,'cue-0');
  assert.equal(requests.length,0);
 }finally{w.dispatchEvent(new w.Event('pagehide'));await w.happyDOM.close();}
});
