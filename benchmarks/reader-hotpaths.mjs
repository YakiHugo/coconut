/** Measure mounted reader work during ordinary playback clock updates. */
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {build} from 'esbuild';
import {Window} from 'happy-dom';

const bundle=await build({
 stdin:{loader:'tsx',resolveDir:process.cwd(),contents:`
 import {createElement} from 'react';
 import {createRoot} from 'react-dom/client';
 import {flushSync} from 'react-dom';
 import {ReaderWorkspace} from './frontend/reader-workspace/workspace';
 import Coconut from './reader/core.js';
 import CoconutPassages from './reader/passages.js';
 import CoconutPassagePlayback from './reader/passage-playback.js';
 Object.assign(window,{Coconut,CoconutPassages,CoconutPassagePlayback});
 window.mountReader=doc=>{
   const root=createRoot(document.body.appendChild(document.createElement('div')));
   const media={url:'blob:benchmark',kind:'audio',identity:'file-candidate-v1:benchmark',name:'Synthetic'};
   flushSync(()=>root.render(createElement(ReaderWorkspace,{document:doc,media,revision:1,
     onSaveDocument:async()=>true,onReadingPosition:()=>{},onRequestAi:()=>{}})));
   return ()=>root.unmount();
 };
 `},bundle:true,format:'iife',platform:'browser',write:false,define:{'process.env.NODE_ENV':'"production"'},
});
const rows=[];
for(const count of [1771,5000]){
 const window=new Window({url:'http://localhost/'});
 let cueReads=0,layoutReads=0;
 const segments=new Proxy(Array.from({length:count},(_,i)=>({id:'cue-'+i,start:i*4,end:i*4+4,text:'Synthetic sentence '+i+'.'})),{
  get(target,key,receiver){if(typeof key==='string'&&/^\d+$/.test(key))cueReads++;return Reflect.get(target,key,receiver);},
 });
 const layout=window.HTMLElement.prototype.getBoundingClientRect;
 window.HTMLElement.prototype.getBoundingClientRect=function(){layoutReads++;return layout.call(this);};
 window.eval(bundle.outputFiles[0].text);
 const unmount=window.mountReader({key:'benchmark',title:'Synthetic transcript',segments,notes:{}});
 try{
  const audio=window.document.querySelector('audio');
  Object.defineProperty(audio,'duration',{value:count*4});
  audio.dispatchEvent(new window.Event('loadedmetadata'));
  audio.currentTime=1;audio.dispatchEvent(new window.Event('timeupdate'));
  window.document.querySelector('.rw-player-follow').click();
  await new Promise(resolve=>setTimeout(resolve,0));
  cueReads=0;layoutReads=0;
  const clockUpdates=60,start=performance.now();
  for(let i=0;i<clockUpdates;i++){
   audio.currentTime=1+i/30;
   audio.dispatchEvent(new window.Event('timeupdate'));
   await new Promise(resolve=>setImmediate(resolve));
  }
  assert.match(window.document.querySelector('.rw-player-progress').getAttribute('aria-valuetext'),/^00:02 /);
  assert.equal(cueReads,0,'a clock update in the same speech part must not rescan the transcript');
  assert.equal(layoutReads,0,'a clock update in the same speech part must not measure reading layout');
  rows.push({cues:count,clockUpdates,cueReads,layoutReads,ms:+(performance.now()-start).toFixed(1)});
 }finally{unmount();await window.happyDOM.close();}
}
console.log(JSON.stringify(rows,null,2));
