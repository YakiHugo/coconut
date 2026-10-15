/** Production React/controller with a deferred preload receipt; no native I/O. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Window} from 'happy-dom';
const {outputFiles}=await build({stdin:{contents:`import React,{useEffect} from 'react';import {createRoot} from 'react-dom/client';import {createNativeMediaController} from './frontend/native-media/controller';import {NativeMediaPanel} from './frontend/native-media/panel';const owner={library:'fixture-library',key:'project',epoch:1,source:{name:'authored.wav'}};const file=new File(['authored'],'authored.wav',{type:'audio/wav'});const media={url:'blob:fixture',kind:'audio',name:file.name,identity:'authored-identity'};const controller=createNativeMediaController({bridge:window.bridge,owner:()=>owner,active:()=>true,media:()=>media,file:()=>file,attach:()=>{throw Error('unexpected native resolve');}});window.controller=controller;window.root=createRoot(document.getElementById('root'));function App(){useEffect(()=>{window.panelReady=true;},[]);return <NativeMediaPanel controller={controller} documentKey="project" canRemember={true} hasMedia={true} onRelink={()=>{}}/>;}controller.initialize([owner]).then(()=>window.root.render(<App/>));`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"production"'}});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const wait=async predicate=>{for(let i=0;i<100&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(predicate(),'React receipt state did not settle');};
for(const outcome of ['remembered','unavailable','rejected'])test('native opt-in stays unchecked until durable receipt: '+outcome,async()=>{
 const w=new Window({url:'http://localhost/'}),receipt=deferred(),calls=[];
 try{
  w.structuredClone=structuredClone;w.document.body.innerHTML='<div id="root"></div>';
  w.bridge={reconcile:async()=>({status:'reconciled',rememberedKeys:[]}),remember:async(owner,file,identity)=>{calls.push({owner,file,identity});return receipt.promise;},resolve:async()=>{throw Error('unexpected resolve');},forget:async()=>({status:'forgotten'}),release:async()=>{}};
  w.eval(outputFiles[0].text);await wait(()=>w.panelReady&&w.document.querySelector('input[type=checkbox]'));
  const checkbox=w.document.querySelector('input[type=checkbox]'),status=()=>w.document.querySelector('[role=status]').textContent;
  assert.equal(checkbox.checked,false);assert.equal(checkbox.disabled,false);
  // This is a real DOM click, not a direct controller call or a forced value.
  checkbox.click();await wait(()=>calls.length===1&&checkbox.disabled);
  assert.equal(checkbox.checked,false,'pending IPC is not durable opt-in');assert.match(status(),/正在处理原文件引用/);
  checkbox.click();assert.equal(calls.length,1,'pending opt-in cannot repeat');assert.equal(calls[0].owner.key,'project');assert.equal(calls[0].file.name,'authored.wav');assert.equal(calls[0].identity,'authored-identity');
  if(outcome==='rejected')receipt.reject(Error('native write failed'));else receipt.resolve({status:outcome});
  await wait(()=>!checkbox.disabled);
  if(outcome==='remembered'){assert.equal(checkbox.checked,true);assert.match(status(),/已在这台电脑记住原文件/);assert.ok([...w.document.querySelectorAll('button')].some(button=>button.textContent==='不再记住'));}
  else{assert.equal(checkbox.checked,false);assert.match(status(),/暂不可用/);assert.equal([...w.document.querySelectorAll('button')].some(button=>button.textContent==='不再记住'),false);}
 }finally{receipt.resolve({status:'unavailable'});w.root?.unmount();w.controller?.dispose();await w.happyDOM.close();}
});
