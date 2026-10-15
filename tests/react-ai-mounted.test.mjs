import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Window} from 'happy-dom';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),core=require('../reader/core.js'),summary=require('../reader/summary.js'),tasks=require('../reader/task-client.js');
const dir=await mkdtemp(join(process.cwd(),'tests/.react-ai-'));
await build({entryPoints:['frontend/ai-workspace/workspace.tsx','frontend/ai-workspace/controller.ts'],bundle:true,platform:'node',format:'esm',outdir:dir,outExtension:{'.js':'.mjs'},external:['react','react/jsx-runtime']});
const window=new Window({url:'http://localhost:8765'});
for(const name of ['window','document','navigator','HTMLElement','Node','Event','MouseEvent'])Object.defineProperty(globalThis,name,{configurable:true,value:name==='window'?window:window[name]});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=await import('react'),{createRoot}=await import('react-dom/client'),{AiWorkspace}=await import(join(dir,'workspace.mjs')),{createAiController}=await import(join(dir,'controller.mjs'));
const {act}=React;
test('actual React mount owns consent, action rendering, error reveal and detached lifecycle',async()=>{
 let documentValue={key:'one',title:'Original',language:'en',segments:[{id:'a',text:'The source',start:0,end:1}]},revision=0,calls=0;
 const controller=createAiController({core,summary,tasks:{...tasks,createClient:()=>({describe:async()=>({providers:{codex:{supported:true,model_selection:{supported:true}}}})})},document:()=>documentValue,documents:()=>[documentValue],getRevision:()=>revision,commit:async(next)=>{documentValue=next;revision++;return {ok:true};},request:async(path)=>{if(path==='language-tools')return {local_translation:false,ai:{codex:{ready:true}}};calls++;const e=Error('Provider failed');e.localProviderDetails={message:'Only show after explicit click'};throw e;},access:{refresh:async()=>{},allows:()=>true,identity:()=> 'local',generation:0},journal:{read:()=>null,write:()=>{}},navigate:()=>{},uuid:()=>crypto.randomUUID()});
 controller.setDocument(documentValue,'0');controller.commands.configure({question:'Explain'});
 function App(){const snapshot=React.useSyncExternalStore(controller.subscribe,controller.getSnapshot);return React.createElement(AiWorkspace,{snapshot,commands:controller.commands});}
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 await act(async()=>root.render(React.createElement(App)));
 assert.equal(calls,0);assert.ok(host.querySelector('input[type=checkbox]'));assert.equal(host.querySelectorAll('#ai-consent').length,0);
 const button=text=>[...host.querySelectorAll('button')].find(b=>b.textContent===text);
 await act(async()=>button('检查本地 AI 连接').click());assert.equal(calls,0);
 await act(async()=>host.querySelector('input[type=checkbox]').click());assert.equal(button('执行本次任务').disabled,false);
 await act(async()=>button('执行本次任务').click());assert.equal(calls,1);assert.equal(host.querySelector('input[type=checkbox]').checked,false);
 assert.ok(!host.textContent.includes('Only show after explicit click'));
 await act(async()=>button('查看本次本机错误详情').click());assert.ok(host.textContent.includes('Only show after explicit click'));
 await act(async()=>controller.clearTransientError());assert.ok(!host.textContent.includes('Only show after explicit click'));
 await act(async()=>root.unmount());controller.dispose();host.remove();assert.equal(calls,1);
});
test('mounted foreground summary rejection after source navigation cannot replace new source or show old diagnostics',async()=>{
 let value={key:'one',title:'Original',language:'en',segments:[{id:'a',text:'Original text',start:0,end:1}]},revision=0,reject,commits=0;
 const controller=createAiController({core,summary,tasks:{...tasks,createClient:()=>({describe:async()=>({providers:{codex:{supported:true,model_selection:{supported:true}}}})})},document:()=>value,documents:()=>[value],getRevision:()=>revision,commit:async(next,expected)=>{assert.equal(expected.revision,revision);commits++;value=next;revision++;controller.setDocument(value,String(revision));return {ok:true};},request:async path=>path==='language-tools'?{local_translation:false,ai:{codex:{ready:true}}}:new Promise((resolve,fail)=>reject=fail),access:{refresh:async()=>{},allows:()=>true,identity:()=> 'local',generation:0},journal:{read:()=>null,write:()=>{}},navigate:()=>{},uuid:()=>crypto.randomUUID()});
 controller.setDocument(value,'0');controller.commands.configure({purpose:'summary'});
 function App(){const snapshot=React.useSyncExternalStore(controller.subscribe,controller.getSnapshot);return React.createElement(AiWorkspace,{snapshot,commands:controller.commands});}
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(React.createElement(App)));
 const button=text=>[...host.querySelectorAll('button')].find(b=>b.textContent===text);
 await act(async()=>button('检查本地 AI 连接').click());await act(async()=>host.querySelector('input[type=checkbox]').click());
 await act(async()=>{button('执行本次任务').click();await new Promise(r=>setTimeout(r,0));});assert.equal(typeof reject,'function');const before=commits;
 await act(async()=>{value=structuredClone(value);value.segments[0].text='New authoritative source';revision++;controller.setDocument(value,String(revision));const error=Error('Old provider rejected');error.localProviderDetails={message:'Old private diagnostic'};reject(error);await new Promise(r=>setTimeout(r,0));});
 assert.equal(value.segments[0].text,'New authoritative source');assert.equal(commits,before);assert.ok(host.textContent.includes('New authoritative source'));assert.ok(!host.textContent.includes('Old provider rejected'));assert.ok(!button('查看本次本机错误详情'));assert.equal(host.querySelector('input[type=checkbox]').checked,false);
 await act(async()=>root.unmount());controller.dispose();host.remove();
});
test.after(async()=>{window.happyDOM.abort();await rm(dir,{recursive:true,force:true});});
