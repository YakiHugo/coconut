/** Real production functions with deterministic IPC/deadline boundaries; no Electron/network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {createCloseCoordinator,createLifecycleOwnership} from '../desktop/close-coordinator.mjs';
const root=new URL('../',import.meta.url),key='coconut-reader-v1',timeoutMs=1000;
const read=file=>fs.readFileSync(new URL(file,root),'utf8');
const main=read('desktop/main.mjs');
function section(start,end){
 const first=main.indexOf(start),last=main.indexOf(end,first+start.length);
 assert.ok(first>=0&&last>first,`production function boundary: ${start}`);return main.slice(first,last);
}
// Evaluate verbatim production bodies. Only Electron/OS boundaries are fakes;
// assertions below run real main-process coordination and real renderer code.
const factory=new Function('deps',`const {window,app,updater,prepareInstall,dialog,path,process,createCloseCoordinator,createLifecycleOwnership,captionHelper,server}=deps;
let quitting=false,quitReady=false,closeCoordinator,updateTimer,updateInterval;const startupAbort=new AbortController();
${section('function finishQuit(){','\nfunction ordinaryWebLink')}
${section('    const lifecycle=createLifecycleOwnership();','    // Native close')}
${section('    async function installUpdate(){','    ipcMain.handle(')}
return {installUpdate,closeCoordinator,get quitting(){return quitting},get quitReady(){return quitReady}};`);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});promise.catch(()=>{});return {promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate,label){
 // Microtask/IO turns, never wall-clock sleeps: every blocked operation has an
 // explicit deferred boundary and timeouts advance only via MockTimers.
 for(let i=0;i<100;i++){if(predicate())return;await turn();}
 assert.fail('Missing expected boundary: '+label);
}
function setup(t){
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1800000000000});
 const w=new Window({url:'https://coconut.example/'}),trace=[],executions=[],queue=[];
 Object.defineProperty(w,'Date',{value:Date});
 w.document.body.innerHTML=read('reader/index.html').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:{subtle:{digest:(...args)=>webcrypto.subtle.digest(...args)}}});
 w.coconutUpdates={state:async()=>({status:'idle',version:'test',arch:'arm64'}),subscribe:()=>{}};
 for(const file of ['summary','core','passages','passage-playback'])w.eval(read(`reader/${file}.js`));
 w.eval(['app','language','podcasts'].map(file=>read(`reader/${file}.js`)).join('\n')+'\nlet sourceSubmitting=false,sourceCaptionRequest=null;\n'+read('reader/updates.js')+'\nwindow.ownershipTest={closing:()=>readerClosing,revision:()=>localImportRevision,save};');
 const shutdown=deferred(),stage=deferred(),start=deferred();
 let paused=false,holdNext=null,runtime,closeDecision=false,updateDecision=1;
 const classify=source=>source.includes('coconutPrepareClose')?source.match(/coconutPrepareClose\("([^"]+)"/)?.[1]:source.includes('coconutPrepareUpdate')?'update:'+source.match(/coconutPrepareUpdate\((true|false)/)?.[1]:'unknown';
 const execute=source=>{
  const mode=classify(source);trace.push('queue '+mode);
  if(holdNext&&mode===holdNext){paused=true;holdNext=null;}
  const run=()=>{const answer=w.eval(source);executions.push({mode,source,answer});trace.push('run '+mode);return answer;};
  if(paused)return new Promise((resolve,reject)=>queue.push({mode,run:()=>{try{resolve(run());}catch(error){reject(error);}}}));
  return Promise.resolve().then(run);
 };
 const updater={state:{status:'ready'},release:{version:'next'},directory:'/authored-fixture',snapshot(){return {...this.state};},change(value){Object.assign(this.state,value);trace.push('state '+value.status);return this.snapshot();},cancel(){trace.push('updater.cancel');return this.snapshot();}};
 const closeRequests=[];
 const app={isPackaged:true,getVersion:()=> 'fixture',quit(){trace.push('app.quit');if(!runtime.quitReady)closeRequests.push(runtime.closeCoordinator.request());}};
 const dialog={showMessageBox:async(_window,options)=>{trace.push('dialog '+options.title);return {response:options.title==='安装 Coconut 更新'?updateDecision:options.title==='关闭 Coconut？'?(closeDecision?1:0):0};}};
 runtime=factory({window:{isDestroyed:()=>false,webContents:{executeJavaScript:execute,session:{flushStorageData(){trace.push('flushStorageData');}}}},app,updater,prepareInstall:()=>{trace.push('prepareInstall');return stage.promise;},dialog,path,process:{resourcesPath:'/Applications/Coconut.app/Contents/Resources',arch:'arm64'},createCloseCoordinator,createLifecycleOwnership:()=>createLifecycleOwnership({timeoutMs}),captionHelper:{shutdown(){trace.push('helper.shutdown');return shutdown.promise;}},server:{shutdown(){trace.push('server.shutdown');}}});
 const install={async discard(){trace.push('install.discard');},start(){trace.push('install.start');return start.promise;}};
 const drain=async()=>{paused=false;while(queue.length){queue.shift().run();await turn();}};
 t.after(async()=>{stage.resolve(install);start.resolve();shutdown.resolve();await drain();await turn();await w.happyDOM.close();});
 return {w,$:id=>w.document.getElementById(id),trace,executions,queue,runtime,updater,stage,start,shutdown,install,closeRequests,
  result:()=>({inert:!!w.document.body.inert,closing:w.ownershipTest.closing(),quitting:runtime.quitting,quitReady:runtime.quitReady,status:updater.state.status}),
  freeze(){paused=true;},hold(mode){holdNext=mode;},drain,
  setCloseDecision(value){closeDecision=value;},setUpdateDecision(value){updateDecision=value;},
  expire(){t.mock.timers.tick(timeoutMs+1);}
 };
}
async function assertEditable(s,text){
 assert.equal(s.result().inert,false);assert.equal(s.result().closing,false);
 if(!s.w.document.querySelector('.note-button'))await s.$('sample').onclick();
 s.w.document.querySelector('.note-button').click();const note=s.$('note');note.value=text;note.dispatchEvent(new s.w.Event('input',{bubbles:true}));
 assert.ok(s.w.localStorage.getItem(key).includes(text),'visible note edit must actually persist');
}

test('staging failure cannot unlock accepted Cmd-Q during helper shutdown',async t=>{
 const s=setup(t);await s.$('sample').onclick();
 const update=s.runtime.installUpdate();await until(()=>s.trace.includes('prepareInstall'),'update staging');
 assert.equal(await s.runtime.closeCoordinator.request(),true);
 assert.deepEqual(s.result(),{inert:true,closing:true,quitting:true,quitReady:false,status:'installing'});
 s.stage.reject(Error('authored staging failure'));await update;await turn();
 assert.equal(s.result().inert,true);assert.equal(s.result().closing,true);
 assert.equal(s.w.ownershipTest.save(),false);assert.equal(s.result().quitReady,false);
 assert.equal(s.trace.includes('install.start'),false);assert.equal(s.trace.includes('app.quit'),false);
 s.shutdown.resolve();await until(()=>s.result().quitReady,'helper shutdown completion');
 assert.equal(s.trace.filter(event=>event==='app.quit').length,1);
});

test('late successful staging is discarded after accepted quit and never launches an installer',async t=>{
 const s=setup(t),update=s.runtime.installUpdate();await until(()=>s.trace.includes('prepareInstall'),'update staging');
 assert.equal(await s.runtime.closeCoordinator.request(),true);
 s.stage.resolve(s.install);await update;await turn();
 assert.equal(s.trace.filter(event=>event==='install.discard').length,1);
 assert.equal(s.trace.includes('install.start'),false);assert.equal(s.result().inert,true);assert.equal(s.result().closing,true);
});

test('FIFO close timeout and late staging cannot acquire or release each other’s ownership',async t=>{
 const s=setup(t),update=s.runtime.installUpdate();await until(()=>s.trace.includes('prepareInstall'),'update staging');
 s.freeze();const close=s.runtime.closeCoordinator.request();await until(()=>s.queue.length===1,'queued inspect');
 s.stage.resolve(s.install);await until(()=>s.trace.includes('install.discard'),'superseded staging is discarded');
 s.expire();assert.equal(await close,false);await update;
 assert.equal(s.result().quitting,false);await s.drain();
 assert.equal(s.trace.includes('install.start'),false);assert.equal(s.result().closing,false);assert.equal(s.result().inert,false);
 await assertEditable(s,'Edit after FIFO timeout');
});

test('delayed timed-out close release cannot unlock a newer update owner',async t=>{
 const s=setup(t);s.freeze();const close=s.runtime.closeCoordinator.request();await until(()=>s.queue.length===1,'queued close inspect');
 s.expire();assert.equal(await close,false);
 await until(()=>s.queue.some(item=>item.mode==='release'),'queued timeout release');
 // Keep the old release delayed while a newly authorized update runs. All
 // other queued renderer operations retain FIFO order.
 const oldRelease=s.queue.splice(s.queue.findIndex(item=>item.mode==='release'),1)[0];await s.drain();
 const update=s.runtime.installUpdate();await until(()=>s.trace.includes('prepareInstall'),'fresh update staging');s.stage.resolve(s.install);
 await until(()=>s.trace.includes('install.start'),'fresh update owner');
 assert.equal(s.result().inert,true);assert.equal(s.result().closing,true);
 oldRelease.run();await turn();assert.equal(s.result().inert,true);assert.equal(s.result().closing,true);
 assert.equal(s.executions.at(-1).mode,'release');assert.equal(s.executions.at(-1).answer,false);
 s.start.reject(Error('authored installer failure'));await update;await turn();await assertEditable(s,'Edit after own update release');
});

test('queued expired safe commit has no cancellation, flush, or lock side effects',async t=>{
 const s=setup(t);await s.$('sample').onclick();const before=s.w.ownershipTest.revision();
 s.hold('safe');const close=s.runtime.closeCoordinator.request();await until(()=>s.queue.some(item=>item.mode==='safe'),'queued final safe close');
 s.expire();assert.equal(await close,false);assert.equal(s.result().quitting,false);
 await s.drain();assert.equal(s.executions.find(item=>item.mode==='safe').answer,false);
 assert.equal(s.w.ownershipTest.revision(),before);assert.equal(s.trace.includes('flushStorageData'),false);
 await assertEditable(s,'Edit after expired close');
});

test('sample hashing during staging blocks final install and leaves both Cancel paths usable',async t=>{
 const s=setup(t),update=s.runtime.installUpdate();await until(()=>s.trace.includes('prepareInstall'),'update staging');
 const digest=deferred();s.w.crypto.subtle.digest=async(...args)=>{await digest.promise;return webcrypto.subtle.digest(...args);};
 const sample=s.$('sample').onclick();assert.equal(s.$('sample').disabled,true);
 s.stage.resolve(s.install);await update;await turn();
 assert.equal(s.trace.includes('install.start'),false);assert.equal(s.trace.filter(event=>event==='install.discard').length,1);
 assert.equal(s.result().status,'ready');assert.equal(s.result().inert,false);assert.equal(s.result().closing,false);
 assert.equal(await s.runtime.closeCoordinator.request(),false,'native Cancel during the pending sample');
 assert.equal(s.result().quitting,false);assert.equal(s.result().inert,false);
 digest.resolve();await sample;assert.equal(JSON.parse(s.w.localStorage.getItem(key)).documents.length,1);
 await assertEditable(s,'Edit after sample and native Cancel');
});

test('failed installer start releases only the update owner and leaves editing usable',async t=>{
 const s=setup(t);await s.$('sample').onclick();const update=s.runtime.installUpdate();
 await until(()=>s.trace.includes('prepareInstall'),'update staging');s.stage.resolve(s.install);
 await until(()=>s.trace.includes('install.start'),'installer start');
 assert.equal(s.result().inert,true);assert.equal(s.result().closing,true);
 assert.equal(await s.runtime.closeCoordinator.request(),false,'native close cannot take a final update owner');
 assert.equal(s.trace.includes('dialog 关闭 Coconut？'),false);
 s.start.reject(Error('authored installer start failure'));await update;await turn();
 assert.equal(s.result().quitting,false);assert.equal(s.result().status,'ready');
 assert.equal(s.trace.filter(event=>event==='install.discard').length,1);
 await assertEditable(s,'Edit after failed installer');
});

test('initial update Cancel and native close Cancel keep notes writable',async t=>{
 const s=setup(t);await s.$('sample').onclick();s.setUpdateDecision(0);await s.runtime.installUpdate();await turn();
 assert.equal(s.trace.includes('prepareInstall'),false);assert.equal(s.result().status,'ready');await assertEditable(s,'Edit after update Cancel');
 s.$('document-details').click();s.$('document-title').value='Unsaved draft';
 assert.equal(await s.runtime.closeCoordinator.request(),false);assert.equal(s.$('document-title').value,'Unsaved draft');
 assert.equal(s.$('details-dialog').open,true);s.$('details-dialog').close();
 assert.equal(s.trace.includes('server.shutdown'),false);await assertEditable(s,'Edit after native Cancel');
});

test('successful final update flushes and quits once without a second native close decision',async t=>{
 const s=setup(t),update=s.runtime.installUpdate();await until(()=>s.trace.includes('prepareInstall'),'update staging');s.stage.resolve(s.install);
 await until(()=>s.trace.includes('install.start'),'installer start');s.start.resolve();await update;
 assert.equal(s.result().quitting,true);assert.equal(s.result().quitReady,false);
 assert.equal(s.trace.includes('dialog 关闭 Coconut？'),false);assert.equal(s.closeRequests.length,0);
 assert.ok(s.trace.indexOf('flushStorageData')<s.trace.indexOf('install.start'));
 s.shutdown.resolve();await until(()=>s.result().quitReady,'final quit');
 assert.equal(s.trace.filter(event=>event==='app.quit').length,1);assert.equal(s.closeRequests.length,0);
 assert.equal(s.result().inert,true);assert.equal(s.result().closing,true);
});
