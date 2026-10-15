import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {Window} from 'happy-dom';
const require=createRequire(import.meta.url),C=require('../reader/core.js'),S=require('../reader/summary.js');
test('mounted summary restores reading scope, checks provenance and respects keyboard focus boundaries',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'reader-summary-')),win=new Window({url:'http://localhost/'}),previous={};
 for(const name of ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','CSS']){previous[name]=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{value:win[name]||win,configurable:true,writable:true});}
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;win.Coconut=C;win.CoconutPassages=require('../reader/passages.js');win.CoconutPassagePlayback=require('../reader/passage-playback.js');win.HTMLElement.prototype.scrollIntoView=()=>{};
 const bundled=await build({stdin:{contents:"export {ReaderWorkspace} from './frontend/reader-workspace/workspace';export {createRoot} from 'react-dom/client';export {createElement,act} from 'react';",resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false});await writeFile(join(temp,'ui.cjs'),bundled.outputFiles[0].contents);
 const savedChannel=globalThis.MessageChannel,channels=[];globalThis.MessageChannel=class extends savedChannel{constructor(){super();channels.push(this);}};
 const {ReaderWorkspace,createRoot,createElement,act}=require(join(temp,'ui.cjs')),host=win.document.createElement('div');win.document.body.append(host);const root=createRoot(host);
 let doc={...C.validate({title:'Summary source',segments:Array.from({length:65},(_,i)=>({id:'cue-'+i,start:i*2,end:i*2+2,text:'Original '+i}))}),key:'summary'},revision=1,enabled=true,opened=0,views=[],visible=[];
 const plan=S.plan(doc),job=S.create(plan,'codex');let answer;while(!answer){const request=S.request(plan,job);answer=S.accept(plan,job,{answer:'Saved mock summary',citations:[request.segments.at(-1).id]});}doc={...doc,ai_answers:[answer]};assert.equal(C.summaryFreshness(answer,doc),'current');
 let plays=0;win.HTMLMediaElement.prototype.play=async()=>{plays++;};win.HTMLMediaElement.prototype.pause=()=>{};
 const render=()=>root.render(createElement(ReaderWorkspace,{document:doc,revision,media:{identity:'file-candidate-v1:summary',url:'blob:summary',kind:'audio',name:'summary.wav'},initialView:{documentKey:doc.key,cueId:'cue-64',mode:'summary'},shortcutsEnabled:enabled,onOpenSummary:()=>opened++,onViewChange:v=>views.push(v),onVisibleSelection:v=>visible.push(v),onReadingPosition:()=>{},onSaveDocument:async()=>true,onRequestAi:()=>{throw Error('No model request permitted');}}));
 const button=text=>[...host.querySelectorAll('button')].find(n=>n.textContent===text);
 const mode=()=>[...host.querySelectorAll('select')].find(n=>n.parentElement.textContent.includes('阅读方式'));
 const setMode=async value=>act(async()=>{mode().value=value;mode().dispatchEvent(new win.Event('change',{bubbles:true}));});
 const key=async(target,value,extra={})=>{const event=new win.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true,...extra});await act(async()=>target.dispatchEvent(event));return event.defaultPrevented;};
 try{
 await act(async()=>render());assert.equal(mode().value,'summary');assert.match(host.querySelector('.rw-summary').textContent,/Saved mock summary/);assert.equal(views.at(-1).mode,'summary');assert.deepEqual(visible.at(-1).cueIds,[]);assert.equal(opened,0);assert.equal(plays,0);
 await act(async()=>button('查看 AI 计划与记录').click());assert.equal(opened,1);
 await act(async()=>host.querySelector('[aria-label="摘要引用"] button').click());assert.equal(mode().value,'transcript');assert.ok(host.querySelector('[data-cue-id="cue-64"]'));
 await setMode('passages');const search=host.querySelector('input[type=search]');await act(async()=>{Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value').set.call(search,'Original 6');search.dispatchEvent(new win.Event('input',{bubbles:true}));});const before=visible.at(-1).cueIds;
 await setMode('summary');await act(async()=>button('返回原阅读状态').click());assert.equal(mode().value,'passages');assert.equal(search.value,'Original 6');assert.deepEqual(visible.at(-1).cueIds,before);
 await setMode('summary');await act(async()=>{doc={...doc,segments:doc.segments.map((c,i)=>i===64?{...c,text:'Changed current source'}:c)};revision++;render();});assert.match(host.querySelector('.rw-summary').textContent,/可能过期/);assert.equal(host.querySelector('[aria-label="摘要引用"] button'),null);assert.match(host.querySelector('.rw-summary details').textContent,/Original 64/);await act(async()=>button('返回原阅读状态').click());assert.equal(mode().value,'transcript');assert.equal(search.value,'');
 const player=host.querySelector('audio');Object.defineProperty(player,'duration',{value:200,configurable:true});await act(async()=>player.dispatchEvent(new win.Event('loadedmetadata')));player.currentTime=20;
 const text=host.querySelector('.rw-original');text.focus();assert.equal(await key(text,'l'),true);assert.equal(player.currentTime,25);assert.equal(await key(text,'j'),true);assert.equal(player.currentTime,20);assert.equal(await key(text,'k'),true);assert.equal(plays,1);
 const nativePlay=player.play;let rejectFirst,rejectLatest;
 player.play=()=>new Promise((_,reject)=>{rejectFirst=reject;});await key(text,'k');
 player.play=()=>new Promise((_,reject)=>{rejectLatest=reject;});await key(text,'k');
 await act(async()=>rejectFirst(new Error('old failed request')));assert.ok(!host.textContent.includes('播放未能开始'),'superseded promise cannot report a stale failure');
 await act(async()=>rejectLatest(Object.assign(new Error('interrupted'),{name:'AbortError'})));assert.ok(!host.textContent.includes('播放未能开始'),'pause/load AbortError is not a playback failure');
 player.play=()=>Promise.reject(Object.assign(new Error('denied'),{name:'NotAllowedError'}));await key(text,'k');assert.match(host.textContent,/播放未能开始/,'genuine current playback failure is visible');
 player.play=()=>Promise.resolve();await key(text,'k');assert.ok(!host.textContent.includes('播放未能开始'),'successful user retry clears only its playback warning');
 player.play=()=>new Promise((_,reject)=>{rejectLatest=reject;});await key(text,'k');await act(async()=>player.dispatchEvent(new win.Event('pause')));await act(async()=>rejectLatest(new Error('late pause failure')));assert.ok(!host.textContent.includes('播放未能开始'),'pause invalidates pending promise ownership');
 player.play=()=>Promise.reject(new Error('current failure'));await key(text,'k');assert.match(host.textContent,/播放未能开始/);await act(async()=>player.dispatchEvent(new win.Event('playing')));assert.ok(!host.textContent.includes('播放未能开始'),'native playback success clears the keyboard-only warning');player.play=nativePlay;
 assert.equal(await key(text,'l',{isComposing:true}),false);assert.equal(player.currentTime,20);
 assert.equal(await key(text,'?'),true);const close=host.querySelector('[role=dialog] button');assert.equal(win.document.activeElement,close);assert.equal(host.querySelector('dialog').open,true,'help uses native top-layer modal lifecycle');assert.equal(await key(close,'Tab'),true);assert.equal(win.document.activeElement,close);assert.equal(await key(close,'Tab',{shiftKey:true}),true);assert.equal(win.document.activeElement,close);assert.equal(await key(close,'l'),false);await key(close,'Escape');assert.equal(host.querySelector('[role=dialog]'),null);assert.equal(win.document.activeElement,text);const helpTrigger=button('阅读快捷键');helpTrigger.focus();await act(async()=>helpTrigger.click());const nativeDialog=host.querySelector('dialog');assert.equal(nativeDialog.open,true);await act(async()=>nativeDialog.dispatchEvent(new win.Event('cancel',{cancelable:true})));assert.equal(host.querySelector('dialog'),null);assert.equal(nativeDialog.open,false,'retired modal closes its top-layer ownership');assert.equal(win.document.activeElement,helpTrigger);text.focus();
 assert.equal(await key(text,'/'),true);assert.equal(win.document.activeElement,search);assert.equal(await key(search,'l'),false);
 await act(async()=>{enabled=false;render();});text.focus();assert.equal(await key(text,'l'),false);assert.equal(await key(text,'f',{ctrlKey:true}),true);assert.equal(win.document.activeElement,search);
 const textarea=host.querySelector('textarea');textarea.focus();assert.equal(await key(textarea,'f',{ctrlKey:true}),false);assert.equal(win.document.activeElement,textarea);
 win.document.body.tabIndex=0;win.document.body.focus();assert.equal(await key(win.document.body,'f',{ctrlKey:true}),false);
 await setMode('summary');await act(async()=>{doc={...doc,ai_answers:[]};revision++;render();});assert.match(host.querySelector('.rw-summary').textContent,/还没有保存/);assert.equal(plays,1);assert.equal(opened,1);await act(async()=>button('阅读快捷键').click());const retiringDialog=host.querySelector('dialog');assert.equal(retiringDialog.open,true);await act(async()=>root.unmount());assert.equal(retiringDialog.open,false,'unmount releases modal top-layer state');
 }finally{await act(async()=>root.unmount());for(const name of Object.keys(previous)){if(previous[name])Object.defineProperty(globalThis,name,previous[name]);else delete globalThis[name];}for(const channel of channels){channel.port1.close();channel.port2.close();}globalThis.MessageChannel=savedChannel;delete globalThis.IS_REACT_ACT_ENVIRONMENT;await win.happyDOM.close();await rm(temp,{recursive:true,force:true});}
});

test('reader player remains in document flow instead of covering later reading content',async()=>{const css=await readFile('frontend/reader-workspace/workspace.css','utf8');const rule=css.match(/\.rw-player\{([^}]+)\}/)[1];assert.match(rule,/position:static/);assert.doesNotMatch(rule,/position:(sticky|fixed)|z-index:/);assert.doesNotMatch(css,/scroll-margin-top:240px/);});
