import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {Window} from 'happy-dom';
const require=createRequire(import.meta.url),temp=await mkdtemp(join(tmpdir(),'source-playback-'));
const bundled=await build({entryPoints:['frontend/reader-workspace/source-playback.ts'],bundle:true,format:'cjs',platform:'node',write:false});await writeFile(join(temp,'links.cjs'),bundled.outputFiles[0].contents);
const {getSourcePlaybackLink:link}=require(join(temp,'links.cjs'));
test('YouTube video routes use integer seconds and replace conflicting times',()=>{
 for(const source of ['https://youtu.be/abcdefghijk?t=999#t=2','https://youtube.com/watch?v=abcdefghijk&t=9&t=8&start=44','https://m.youtube.com/shorts/abcdefghijk','https://www.youtube.com/live/abcdefghijk','https://youtube.com/embed/abcdefghijk']){
  assert.deepEqual(link(source,123.987),{url:'https://www.youtube.com/watch?v=abcdefghijk&t=123s',timed:true,platform:'YouTube'});
 }
 assert.match(link('https://youtube.com/watch?v=abc%2Ddef_ghi',0).url,/v=abc-def_ghi&t=0s/);
});
test('Bilibili uses seconds, preserves multipart identity and encoded parameters',()=>{
 const value=link('http://www.bilibili.com/video/BV1xx411c7mD/?p=3&t=99&t=88&start_progress=9000&keyword=%E4%B8%AD%E6%96%87%26%3F#t=55',65.9),url=new URL(value.url);
 assert.equal(value.timed,true);assert.equal(url.protocol,'https:');assert.equal(url.searchParams.get('p'),'3');assert.deepEqual(url.searchParams.getAll('t'),['65']);assert.equal(url.searchParams.has('start_progress'),false);assert.equal(url.searchParams.get('keyword'),'中文&?');assert.equal(url.hash,'');
 assert.equal(link('https://m.bilibili.com/video/av12345',0).timed,true);
});
test('unknown pages and short redirects never claim timestamp support',()=>{
 for(const source of ['https://b23.tv/abc','https://www.bilibili.com/video/BVbad','https://youtube.com/playlist?list=abc','https://youtube.com/watch?v=bad','https://youtube.com.evil.test/watch?v=abcdefghijk','https://youtube.com:8443/watch?v=abcdefghijk','https://example.test/episode?t=4#chapter']){
  assert.deepEqual(link(source,12),{url:new URL(source).href,timed:false,platform:null});
 }
 for(const seconds of [-1,NaN,Infinity,Number.MAX_VALUE]) assert.equal(link('https://youtu.be/abcdefghijk',seconds).timed,false);
 for(const source of ['javascript:alert(1)','data:text/html,test','file:///tmp/a','https://user:secret@youtube.com/watch?v=abcdefghijk','//youtube.com/watch?v=abcdefghijk',null,{}]) assert.equal(link(source,12),null);
});
test('mounted reader offers explicit source links in cues and passages without a fake player',async()=>{
 const win=new Window({url:'http://localhost/'}),previous={};for(const name of ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','CSS']){previous[name]=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{value:win[name]||win,configurable:true,writable:true});}globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 win.Coconut=require('../reader/core.js');win.CoconutPassages=require('../reader/passages.js');win.CoconutPassagePlayback=require('../reader/passage-playback.js');win.HTMLElement.prototype.scrollIntoView=()=>{};
 const bundle=await build({stdin:{contents:"export {ReaderWorkspace} from './frontend/reader-workspace/workspace'; export {createRoot} from 'react-dom/client'; export {createElement,act} from 'react';",resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false});await writeFile(join(temp,'ui.cjs'),bundle.outputFiles[0].contents);
 const savedChannel=globalThis.MessageChannel,channels=[];globalThis.MessageChannel=class extends savedChannel{constructor(){super();channels.push(this);}};
 const {ReaderWorkspace,createRoot,createElement,act}=require(join(temp,'ui.cjs')),host=win.document.createElement('div');win.document.body.append(host);const root=createRoot(host);
 let source='https://youtu.be/abcdefghijk',media=null;
 const render=()=>root.render(createElement(ReaderWorkspace,{initialView:{documentKey:'video',cueId:'cue',mode:'transcript'},document:{key:'video',title:'Video',source_url:source,segments:[{id:'cue',start:123.7,end:129,text:'Source words.'}],notes:{},media_timing:{version:1,identity:'audio',offset:30}},revision:1,media,onSaveDocument:async()=>true,onReadingPosition:()=>{},onRequestAi:()=>{}}));
 try{
  await act(async()=>render());assert.equal(host.querySelector('video,audio,iframe'),null);
  const sourceLink=host.querySelector('.rw-source > p a');assert.ok(sourceLink,'source is visible outside collapsed details');
  let cueLink=host.querySelector('.rw-cue-meta a');assert.match(cueLink.textContent,/YouTube.*02:03/);assert.equal(new URL(cueLink.href).searchParams.get('t'),'123s');assert.equal(cueLink.target,'_blank');assert.equal(cueLink.rel,'noopener noreferrer');
  await act(async()=>host.querySelector('.rw-cue-meta button').click());assert.equal(win.location.href,'http://localhost/','reading navigation never opens the source automatically');
  await act(async()=>host.querySelector('[role=tab][data-mode=passages]').click());assert.equal(host.querySelector('.rw-passage a').href,cueLink.href);
  await act(async()=>{source='https://example.test/episode';render();});assert.equal(host.querySelector('.rw-passage a').textContent,'打开原站 ↗');assert.match(host.querySelector('.rw-passage a').title,/不支持按段定位/);
  await act(async()=>{source='javascript:alert(1)';render();});assert.equal(host.querySelector('.rw-passage a'),null);
  await act(async()=>{media={url:'blob:audio',kind:'audio',name:'original',identity:'audio'};render();});assert.ok([...host.querySelectorAll('button')].some(button=>button.getAttribute('aria-label')?.startsWith('回听整段')));assert.equal(host.querySelector('.rw-passage a'),null);
 }finally{await act(async()=>root.unmount());for(const name of Object.keys(previous)){if(previous[name])Object.defineProperty(globalThis,name,previous[name]);else delete globalThis[name];}for(const c of channels){c.port1.close();c.port2.close();}globalThis.MessageChannel=savedChannel;delete globalThis.IS_REACT_ACT_ENVIRONMENT;await win.happyDOM.close();}
});
test.after(async()=>rm(temp,{recursive:true,force:true}));
