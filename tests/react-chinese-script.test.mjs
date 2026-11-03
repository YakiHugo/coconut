import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {Window} from 'happy-dom';
const require=createRequire(import.meta.url);
test('Chinese display follows language, keeps canonical selections, and converts only reading exports',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'coconut-script-')),win=new Window({url:'http://localhost/'}),previous={};
 for(const name of ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','MutationObserver','getComputedStyle','CSS']){previous[name]=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{value:typeof win[name]==='function'&&name==='getComputedStyle'?win[name].bind(win):win[name],configurable:true,writable:true});}
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;let root;const channels=[],SavedChannel=globalThis.MessageChannel;globalThis.MessageChannel=class extends SavedChannel{constructor(){super();channels.push(this);}};
 try{
  await symlink(join(process.cwd(),'node_modules'),join(temp,'node_modules'),'dir');
  const bundle=await build({stdin:{contents:"export * from './frontend/reading-preferences/chinese-script';export * from './frontend/reader-workspace/domain';export * from './frontend/reader-workspace/workspace';",resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'cjs',platform:'node',write:false,external:['react','react-dom','react-dom/client','react/jsx-runtime']});
  const file=join(temp,'ui.cjs');await writeFile(file,bundle.outputFiles[0].contents);
  const {scriptConverter,resolveChineseScript,captureSourceSelection,ReaderWorkspace}=require(file);
  assert.equal(resolveChineseScript('system',['zh-TW']),'zh-Hant');assert.equal(resolveChineseScript('system',['zh-CN']),'zh-Hans');assert.equal(resolveChineseScript('system',['en-US']),'source');
  const convert=scriptConverter('zh-Hans'),raw='我們寫代碼，頭髮很長。',simplified=convert(raw);assert.equal(simplified,'我们写代码，头发很长。');assert.equal(scriptConverter('zh-Hant')('头发很长。'),'頭髮很長。');
  const Coconut=require('../reader/core.js'),Passages=require('../reader/passages.js');win.Coconut=Coconut;win.CoconutPassages=Passages;
  const doc={...Coconut.validate({title:'Authored',language:'zh',segments:[{id:'a',start:0,end:2,text:raw}],notes:{a:'保留筆記'}}),key:'authored'};
  const host=win.document.createElement('div');win.document.body.append(host);host.innerHTML='<p data-source-id="a">'+simplified+'</p>';
  const range=win.document.createRange();range.setStart(host.firstChild.firstChild,0);range.setEnd(host.firstChild.firstChild,5);win.getSelection().addRange(range);
  const selection=captureSourceSelection(host,doc,win.getSelection(),Passages.separator,convert);assert.equal(selection.text,raw.slice(0,5));win.getSelection().removeAllRanges();host.replaceChildren();
  const {createElement,act}=await import('react'),{createRoot}=await import('react-dom/client');root=createRoot(host);let script='zh-Hans';const render=()=>root.render(createElement(ReaderWorkspace,{document:doc,revision:1,chineseScript:script,onSaveDocument:async()=>true,onRequestAi:()=>{},onReadingPosition:()=>{}}));
  await act(async()=>render());assert.equal(host.querySelector('[data-source-id="a"]').textContent,simplified);
  const before=JSON.stringify(doc),input=host.querySelector('input[type=search]');await act(async()=>{Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value').set.call(input,'代码');input.dispatchEvent(new win.Event('input',{bubbles:true}));});assert.ok(host.querySelector('[data-source-id="a"]'));
  const blobs=[];const savedCreate=URL.createObjectURL,savedRevoke=URL.revokeObjectURL;URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:authored';};URL.revokeObjectURL=()=>{};
  try{
   const format=[...host.querySelectorAll('label')].find(label=>label.textContent.startsWith('文件格式')).querySelector('select');
   const download=async kind=>{await act(async()=>{format.value=kind;format.dispatchEvent(new win.Event('change',{bubbles:true}));});await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='下载本篇').click());return blobs.at(-1).text();};
   assert.match(await download('txt'),/我们写代码/);assert.match(await download('srt'),/我们写代码/);assert.equal(JSON.parse(await download('json')).segments[0].text,raw);
  }finally{URL.createObjectURL=savedCreate;URL.revokeObjectURL=savedRevoke;}
  await act(async()=>{script='source';render();});assert.equal(JSON.stringify(doc),before);assert.equal(doc.notes.a,'保留筆記');
 }finally{if(root){const {act}=await import('react');await act(async()=>root.unmount());}await win.happyDOM.abort();for(const [name,value]of Object.entries(previous))value?Object.defineProperty(globalThis,name,value):delete globalThis[name];globalThis.MessageChannel=SavedChannel;for(const channel of channels){channel.port1.close();channel.port2.close();}await rm(temp,{recursive:true,force:true});}
});
