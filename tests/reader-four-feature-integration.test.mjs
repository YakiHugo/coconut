/** Local four-candidate integration probes. Authored input, Happy DOM, no browser/model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import C from '../reader/core.js';
import {installSavePipeline} from './helpers/save-pipeline.mjs';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
import {createCaptionService} from '../desktop/caption-service.mjs';
import {captionFixtureURL,captionFixtureResult} from './helpers/caption-diagnostics-fixtures.mjs';
const root=new URL('../',import.meta.url),CONTENT='coconut-reader-v1',VIEW='coconut-reading-view-v1';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
async function until(fn){for(let i=0;i<500&&!fn();i++)await tick();assert.ok(fn(),'integration checkpoint');}
const response=value=>({ok:true,json:async()=>value});
const audio=()=>({...C.validate({project_kind:'audio_only',title:'Authored audio project',language:'en',project_note:'Keep project note',local_media_source:{version:1,kind:'audio',name:'Authored.wav',size:64,last_modified:7,type:'audio/wav',fingerprint:'a'.repeat(64)},segments:[]}),key:'audio-project'});
const partialPaste='1\n00:00:01,000 --> 00:00:02,000\nAuthored paste cue\n\n2\n00:00:03,000 -> 00:00:04,000\nOnly paste warning';
async function captionHarness({handler=()=>{throw Error('Unexpected authored request');},disk=null,session=null}={}){
 const w=new Window({url:'http://127.0.0.1:8080/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});
 const docs=[audio(),...largeLibraryFixture(1,{cues:220})];
 w.localStorage.setItem(CONTENT,JSON.stringify({documents:docs,active:docs[0].key}));
 for(const [key,value] of Object.entries(disk||{}))w.localStorage.setItem(key,value);
 for(const [key,value] of Object.entries(session||{}))w.sessionStorage.setItem(key,value);
 w.fetch=async(url,options)=>url==='api/health'?response({local_worker:false,capabilities:{local_agents:true,caption_import:true}}):url==='api/jobs'?response({jobs:[]}):handler(url,options);
 const pipeline=installSavePipeline(w);
 w.eval(['summary','core','passages','quotation','passage-playback','app','language','podcasts','jobs'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+'\nwindow.integrationProbe={active,documents:()=>state.documents};');
 w.HTMLElement.prototype.scrollIntoView=function(){};
 const $=id=>w.document.getElementById(id);
 await until(()=>$('worker-status').textContent.includes('已连接'));
 return {w,$,pipeline,active:()=>w.integrationProbe.active(),docs:()=>w.integrationProbe.documents(),open:key=>$('library').querySelector(`[data-document-key="${key}"] .library-open`).click(),close:async()=>{pipeline.hold(false);pipeline.writes.forEach(write=>write.commit());await tick();await w.happyDOM.close();}};
}
function preview(e,text=partialPaste){e.$('paste-project-subtitles').click();assert.equal(e.$('paste-subtitle-dialog').open,true);e.$('paste-subtitle-text').value=text;e.$('paste-subtitle-text').dispatchEvent(new e.w.Event('input'));e.$('preview-paste-subtitle').click();assert.equal(e.$('confirm-paste-subtitle').disabled,false,e.$('paste-subtitle-status').textContent);}
function submitX(e){e.$('add-content').click();e.$('video-url').value=captionFixtureURL;return e.$('url-form').onsubmit({preventDefault(){}});}
const partialX=()=>createCaptionService({enabledProviders:['x'],helper:{extractCaptions:async()=>captionFixtureResult()}}).importCaption({url:captionFixtureURL});
const first=e=>e.$('transcript').querySelector('.segment')?.dataset.segmentId;
const copyStorage=storage=>Object.fromEntries(Array.from({length:storage.length},(_,i)=>{const key=storage.key(i);return [key,storage.getItem(key)];}));

test('delayed partial X response cannot replace project paste, its warning batch or attached identity',async()=>{
 let release;const result=await partialX(),e=await captionHarness({handler:()=>new Promise(resolve=>release=resolve)});try{
  const pending=submitX(e);await until(()=>release);e.$('back-reading').click();preview(e);await e.$('confirm-paste-subtitle').onclick();
  const active=e.active(),notice=e.$('notice').textContent,row=e.$('transcript-import-list').firstElementChild;assert.equal(active.key,'audio-project');assert.equal(active.segments.length,1);assert.match(row.textContent,/跳过 1/);
  release(response(result));await pending;
  assert.equal(e.active(),active);assert.equal(e.docs().length,2);assert.equal(e.$('transcript-import-list').firstElementChild,row);assert.match(row.textContent,/跳过 1/);assert.doesNotMatch(row.textContent,/X 原语言字幕/);assert.equal(e.$('notice').textContent,notice);assert.equal(active.diagnostics,undefined);
 }finally{await e.close();}
});

for(const failPaste of [false,true])test('older partial X save cannot replace a newer paste batch, paste failure='+failPaste,async()=>{
 const result=await partialX(),e=await captionHarness({handler:()=>response(result)});try{
  e.pipeline.hold();const old=submitX(e);await until(()=>e.pipeline.writes.length===1);const xdoc=e.active();assert.notEqual(xdoc.key,'audio-project');
  e.open('audio-project');preview(e);const pasted=e.$('confirm-paste-subtitle').onclick();await until(()=>e.active().segments.length===1);
  const attached=e.active(),row=e.$('transcript-import-list').firstElementChild;assert.match(row.textContent,/跳过 1/);e.pipeline.writes[0].commit();await old;await until(()=>e.pipeline.writes.length===2);
  assert.equal(e.$('transcript-import-list').firstElementChild,row);assert.equal(e.active(),attached);assert.doesNotMatch(e.$('notice').textContent,/原语言字幕已保存/);
  if(failPaste)e.pipeline.writes[1].fail();else e.pipeline.writes[1].commit();await pasted;
  assert.equal(e.$('transcript-import-list').firstElementChild,row);assert.equal(row.dataset.status,failPaste?'unsaved':'saved');assert.equal(e.active().project_note,'Keep project note');
  if(failPaste){assert.equal(e.$('retry-paste-subtitle').hidden,false);const retry=e.$('retry-paste-subtitle').onclick();await until(()=>e.pipeline.writes.length===3);e.pipeline.writes[2].commit();await retry;assert.equal(row.dataset.status,'saved');}
  assert.equal(e.docs().length,3);assert.equal(e.active(),attached);assert.equal(e.docs().find(doc=>doc.key==='audio-project'),attached);assert.equal(e.$('paste-subtitle-dialog').open,false);
 }finally{await e.close();}
});

test('attached project keeps one key and resumes its new transcript page across navigation and reload',async()=>{
 const e=await captionHarness();let reload;try{
  const text='WEBVTT\n\n'+Array.from({length:220},(_,i)=>`${i}\n00:${String(Math.floor(i*2/60)).padStart(2,'0')}:${String(i*2%60).padStart(2,'0')}.000 --> 00:${String(Math.floor((i*2+1)/60)).padStart(2,'0')}:${String((i*2+1)%60).padStart(2,'0')}.000\nAuthored attached cue ${i}`).join('\n\n');
  preview(e,text);await e.$('confirm-paste-subtitle').onclick();e.$('next-page').click();const cue=first(e);assert.equal(cue,e.active().segments[100].id);e.open('shelf-0');e.open('audio-project');assert.equal(first(e),cue);assert.equal(e.w.document.body.dataset.readingMode,'transcript');
  e.w.dispatchEvent(new e.w.Event('pagehide'));const entry=JSON.parse(e.w.sessionStorage.getItem(VIEW)).views.find(v=>v[0]==='audio-project');assert.equal(entry[1],cue);
  reload=await captionHarness({disk:copyStorage(e.w.localStorage),session:copyStorage(e.w.sessionStorage)});assert.equal(reload.active().key,'audio-project');assert.equal(first(reload),cue);assert.equal(reload.active().project_note,'Keep project note');assert.equal(reload.docs().length,2);
 }finally{await e.close();await reload?.close();}
});

function quoteHarness(){
 const docs=largeLibraryFixture(2,{cues:220});docs[0].exact_excerpts=[C.exactExcerptSnapshot(docs[0],[docs[0].segments[100]],[],0,docs[0].segments[100].text.length,{id:'saved-late',createdAt:'2026-10-12T08:00:00.000Z'})];
 const e=libraryHarness(docs,{probe:true,configureCore:w=>w.eval(fs.readFileSync(new URL('reader/quotation.js',root),'utf8'))});
 e.open=key=>e.$('library').querySelector(`[data-document-key="${key}"] .library-open`).click();e.$('mode-transcript').click();e.$('next-page').click();return e;
}
for(const reject of [false,true])test('late saved copy cannot disturb restored cue, mode, focus or content, reject='+reject,async()=>{
 const e=quoteHarness();try{
  let release;Object.defineProperty(e.w.navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise((yes,no)=>release=()=>reject?no(Error('Denied')):yes())}});
  e.w.document.querySelector('#transcript .reading-excerpt-open:not([hidden])').click();const host=e.w.document.querySelector('#reading-excerpts-list .saved-excerpt-copy'),button=host.querySelector('button');button.focus();button.click();
  e.$('reading-excerpts-close').click();e.open('shelf-1');e.open('shelf-0');e.$('search').focus();const focused=e.w.document.activeElement,cue=first(e),mode=e.w.document.body.dataset.readingMode,view=e.w.sessionStorage.getItem(VIEW),content=e.w.localStorage.getItem(CONTENT),generation=e.pipeline.store.status().generation;
  assert.equal(cue,'shelf-0-cue-100');assert.equal(mode,'transcript');release();await tick();
  assert.equal(first(e),cue);assert.equal(e.w.document.body.dataset.readingMode,mode);assert.equal(e.w.document.activeElement,focused);assert.equal(e.w.sessionStorage.getItem(VIEW),view);assert.equal(e.w.localStorage.getItem(CONTENT),content);assert.equal(e.pipeline.store.status().generation,generation);assert.equal(e.$('reading-excerpts-dialog').open,false);assert.equal(host.querySelector('textarea'),null);
 }finally{await e.w.happyDOM.close();}
});

test('focused copy fallback is excluded from captured reading state on hide and pagehide',async()=>{
 const e=quoteHarness();let reload;try{
  Object.defineProperty(e.w.navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('Denied');}}});e.w.document.querySelector('#transcript .reading-excerpt-open:not([hidden])').click();const button=e.w.document.querySelector('#reading-excerpts-list .saved-excerpt-copy button');button.focus();button.click();await tick();
  const field=e.w.document.querySelector('.saved-excerpt-copy-preview');assert.equal(e.w.document.activeElement,field);const content=e.w.localStorage.getItem(CONTENT),generation=e.pipeline.store.status().generation;
  assert.equal(JSON.parse(e.w.sessionStorage.getItem(VIEW)).views.find(v=>v[0]==='shelf-0')[1],'shelf-0-cue-100');
  for(const row of e.w.document.querySelectorAll('#transcript .segment'))row.getBoundingClientRect=()=>({top:row.dataset.segmentId==='shelf-0-cue-135'?120:2000,bottom:row.dataset.segmentId==='shelf-0-cue-135'?180:2050,height:60,width:100});
  Object.defineProperty(e.w.document,'hidden',{configurable:true,value:true});e.w.document.dispatchEvent(new e.w.Event('visibilitychange'));e.w.dispatchEvent(new e.w.Event('pagehide'));
  const view=JSON.parse(e.w.sessionStorage.getItem(VIEW)).views.find(v=>v[0]==='shelf-0');assert.deepEqual(view,['shelf-0','shelf-0-cue-135','transcript']);assert.equal(e.w.localStorage.getItem(CONTENT),content);assert.equal(e.pipeline.store.status().generation,generation);assert.equal(e.w.document.activeElement,field);
  const disk=copyStorage(e.w.localStorage),session=copyStorage(e.w.sessionStorage);reload=libraryHarness(e.w.libraryProbe.documents,{probe:true,configureCore(w){for(const [key,value] of Object.entries(disk))w.localStorage.setItem(key,value);for(const [key,value] of Object.entries(session))w.sessionStorage.setItem(key,value);w.eval(fs.readFileSync(new URL('reader/quotation.js',root),'utf8'));}});
  assert.equal(first(reload),'shelf-0-cue-100');assert.equal(reload.w.document.body.dataset.readingMode,'transcript');assert.deepEqual(JSON.parse(reload.w.sessionStorage.getItem(VIEW)).views.find(v=>v[0]==='shelf-0'),view);assert.equal(reload.$('reading-excerpts-dialog').open,false);assert.equal(reload.w.document.querySelector('.saved-excerpt-copy-preview'),null);
 }finally{await e.w.happyDOM.close();await reload?.w.happyDOM.close();}
});
