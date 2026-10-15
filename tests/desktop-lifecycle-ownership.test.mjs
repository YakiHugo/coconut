// Real main-process lifecycle coupled to the production React store and close controller.
/** Real production functions with deterministic IPC/deadline boundaries; no Electron/network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {build} from 'esbuild';
const compiled=await build({stdin:{contents:"export {createAppStore} from './frontend/app/store'; export {createCloseController} from './frontend/native-media/close';",resolveDir:process.cwd()},bundle:true,write:false,format:'iife',globalName:'ReactLifecycle',platform:'browser'});
import {createCloseCoordinator,createLifecycleOwnership} from '../desktop/close-coordinator.mjs';
const root=new URL('../',import.meta.url),key='coconut-reader-v1',timeoutMs=1000;
const read=file=>fs.readFileSync(new URL(file,root),'utf8');
const main=read('desktop/main.mjs');
function section(start,end){
 const first=main.indexOf(start),last=main.indexOf(end,first+start.length);
 assert.ok(first>=0&&last>first,`production function boundary: ${start}`);return main.slice(first,last);
}
// Evaluate verbatim production bodies. Only Electron/OS boundaries are fakes;
// assertions below run real main-process coordination, React store, close controller
// and receipt pipeline. UI lock/update eligibility are controlled host boundaries,
// not mounted NativeClose UI acceptance (covered by react-*-mounted tests).
const factory=new Function('deps',`const {window,app,updater,prepareInstall,dialog,path,process,createCloseCoordinator,createLifecycleOwnership,captionHelper,server,localMediaService}=deps;
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
function setup(t,{nativeMedia=false}={}){
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1800000000000});
 const w=new Window({url:'https://coconut.example/'}),trace=[],executions=[],queue=[];
 Object.defineProperty(w,'Date',{value:Date});
 w.document.body.innerHTML='<main id="react-root"></main>';
 w.structuredClone=structuredClone;
 Object.defineProperty(w,'crypto',{value:{randomUUID:()=>webcrypto.randomUUID(),subtle:{digest:(...args)=>webcrypto.subtle.digest(...args)}}});
 w.coconutUpdates={state:async()=>({status:'idle',version:'test',arch:'arm64'}),subscribe:()=>{}};
 for(const file of ['summary','core','passages','passage-playback','canonical-library','library-store'])w.eval(read(`reader/${file}.js`));
 const writes={held:false,pending:[]};const createAdapter=w.CoconutLibraryStore.createLegacyAdapter;
 w.CoconutLibraryStore.createLegacyAdapter=options=>{const adapter=createAdapter(options);return {...adapter,write(value,context){
  if(!writes.held)return adapter.write(value,context);
  return new Promise(resolve=>writes.pending.push({signal:context.signal,settle:()=>resolve(adapter.write(value,context)),fail:()=>resolve({ok:false,status:'failed',error:{code:'quota'}})}));
 }}};

 w.eval(compiled.outputFiles[0].text);
 const adapter=w.CoconutLibraryStore.createLegacyAdapter({getStorage:()=>w.localStorage,validate:w.Coconut.validate}),loaded=adapter.load();
 const store=w.ReactLifecycle.createAppStore({documents:loaded.documents,active:loaded.active,validate:w.Coconut.validate,project:w.CoconutCanonicalLibrary.project,createPipeline:getDocuments=>w.CoconutLibraryStore.create({adapter,getDocuments,delay:0})});
 let closing=false;
 // Allow pending-only content through this host eligibility gate so the main/
 // controller race tests can exercise the real final writer barrier. The mounted
 // React view has a stricter updateReady gate and is verified separately.
 const controller=w.ReactLifecycle.createCloseController({snapshot:store.closeSnapshot,acquireBarrier:id=>store.acquireBarrier(String(id)),barrierActive:store.barrierActive,releaseBarrier:store.releaseBarrier,flush:store.flush,discardPending:store.discardPending,lockUI:()=>{w.document.body.inert=true;return()=>{w.document.body.inert=false;closing=false;};},finish:()=>{closing=true;},updateReady:()=>!closing&&store.closeSnapshot().flushable});
 w.coconutPrepareClose=controller.close;w.coconutPrepareUpdate=controller.update;
 const sample=async()=>{store.setActivity('sample','正在读取示例');try{await w.crypto.subtle.digest('SHA-256',new Uint8Array([1]));store.addDocument({...w.Coconut.validate({title:'Lifecycle fixture',segments:[{id:'cue',start:0,end:1,text:'Source text'}],notes:{}}),key:'fixture'});await store.flush();}finally{store.setActivity('sample',null);}};
 const save=()=>{const doc=store.getDocument();return store.commitDocument({...doc},{key:doc.key,revision:store.getRevision(doc.key)});};
 const note=text=>{const doc=store.getDocument();return store.commitDocument({...doc,notes:{cue:text}},{key:doc.key,revision:store.getRevision(doc.key)});};

 const shutdown=deferred(),mediaShutdown=deferred(),stage=deferred(),start=deferred();
 let paused=false,holdNext=null,runtime,closeDecision=false,updateDecision=1,storageFlush=null;
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
 runtime=factory({window:{isDestroyed:()=>false,webContents:{executeJavaScript:execute,session:{flushStorageData(){trace.push('flushStorageData');return storageFlush?.promise;}}}},app,updater,prepareInstall:()=>{trace.push('prepareInstall');return stage.promise;},dialog,path,process:{resourcesPath:'/Applications/Coconut.app/Contents/Resources',arch:'arm64'},createCloseCoordinator,createLifecycleOwnership:()=>createLifecycleOwnership({timeoutMs}),localMediaService:nativeMedia?{shutdown(){trace.push('media.shutdown');return mediaShutdown.promise;}}:undefined,captionHelper:{shutdown(){trace.push('helper.shutdown');return shutdown.promise;}},server:{shutdown(){trace.push('server.shutdown');}}});
 const install={async discard(){trace.push('install.discard');},start(){trace.push('install.start');return start.promise;}};
 const drain=async()=>{paused=false;while(queue.length){queue.shift().run();await turn();}};
 t.after(async()=>{stage.resolve(install);start.resolve();shutdown.resolve();mediaShutdown.resolve();await drain();await turn();controller.dispose();store.dispose();await w.happyDOM.close();});
 return {w,store,sample,note,save,trace,executions,queue,runtime,updater,stage,start,shutdown,mediaShutdown,install,closeRequests,writes,
  holdStorage(){return storageFlush=deferred();},
  result:()=>({inert:!!w.document.body.inert,closing,quitting:runtime.quitting,quitReady:runtime.quitReady,status:updater.state.status}),
  freeze(){paused=true;},hold(mode){holdNext=mode;},drain,
  setCloseDecision(value){closeDecision=value;},setUpdateDecision(value){updateDecision=value;},
  expire(){t.mock.timers.tick(timeoutMs+1);}
 };
}
async function assertEditable(s,text){
 assert.equal(s.result().inert,false);assert.equal(s.result().closing,false);
 if(!s.store.getDocument())await s.sample();
 const saved=s.note(text);await s.store.flush();assert.equal(await saved,true);assert.ok(s.w.localStorage.getItem(key).includes(text),'React store note edit must actually persist');
}

test('staging failure cannot unlock accepted Cmd-Q during helper shutdown',async t=>{
 const s=setup(t);await s.sample();
 const update=s.runtime.installUpdate();await until(()=>s.trace.includes('prepareInstall'),'update staging');
 assert.equal(await s.runtime.closeCoordinator.request(),true);
 assert.deepEqual(s.result(),{inert:true,closing:true,quitting:true,quitReady:false,status:'installing'});
 s.stage.reject(Error('authored staging failure'));await update;await turn();
 assert.equal(s.result().inert,true);assert.equal(s.result().closing,true);
 assert.equal(await s.save(),false);assert.equal(s.result().quitReady,false);
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
 const s=setup(t);await s.sample();const before=s.store.getSnapshot().revision;
 s.hold('safe');const close=s.runtime.closeCoordinator.request();await until(()=>s.queue.some(item=>item.mode==='safe'),'queued final safe close');
 s.expire();assert.equal(await close,false);assert.equal(s.result().quitting,false);
 await s.drain();assert.equal(s.executions.find(item=>item.mode==='safe').answer,false);
 assert.equal(s.store.getSnapshot().revision,before);assert.equal(s.trace.includes('flushStorageData'),false);
 await assertEditable(s,'Edit after expired close');
});

test('in-flight import activity during staging blocks final install and leaves both Cancel paths usable',async t=>{
 const s=setup(t),update=s.runtime.installUpdate();await until(()=>s.trace.includes('prepareInstall'),'update staging');
 const digest=deferred();s.w.crypto.subtle.digest=async(...args)=>{await digest.promise;return webcrypto.subtle.digest(...args);};
 const sample=s.sample();assert.ok(s.store.closeSnapshot().nonContentReasons.length);
 s.stage.resolve(s.install);await update;await turn();
 assert.equal(s.trace.includes('install.start'),false);assert.equal(s.trace.filter(event=>event==='install.discard').length,1);
 assert.equal(s.result().status,'ready');assert.equal(s.result().inert,false);assert.equal(s.result().closing,false);
 assert.equal(await s.runtime.closeCoordinator.request(),false,'native Cancel during the pending sample');
 assert.equal(s.result().quitting,false);assert.equal(s.result().inert,false);
 digest.resolve();await sample;assert.equal(JSON.parse(s.w.localStorage.getItem(key)).documents.length,1);
 await assertEditable(s,'Edit after sample and native Cancel');
});

test('failed installer start releases only the update owner and leaves editing usable',async t=>{
 const s=setup(t);await s.sample();const update=s.runtime.installUpdate();
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
 const s=setup(t);await s.sample();s.setUpdateDecision(0);await s.runtime.installUpdate();await turn();
 assert.equal(s.trace.includes('prepareInstall'),false);assert.equal(s.result().status,'ready');await assertEditable(s,'Edit after update Cancel');
 s.store.setDirty(true);
 assert.equal(await s.runtime.closeCoordinator.request(),false);assert.equal(s.store.getSnapshot().dirty,true);
 s.store.setDirty(false);
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

function queueNote(s,text){void s.note(text);}
test('pending-only native close waits for the real writer with no discard prompt or early DOM-storage flush',async t=>{
 const s=setup(t);await s.sample();s.writes.held=true;queueNote(s,'Pending close reaches legacy storage');
 const close=s.runtime.closeCoordinator.request();await until(()=>s.writes.pending.length===1,'native pending writer');
 assert.equal(s.trace.includes('dialog 关闭 Coconut？'),false);assert.equal(s.trace.includes('flushStorageData'),false);assert.equal(s.result().closing,false);assert.equal(s.result().quitting,false);
 assert.equal(s.runtime.closeCoordinator.request(),close,'repeated Cmd-Q shares the same pending receipt');
 s.writes.pending[0].settle();assert.equal(await close,true);assert.match(s.w.localStorage.getItem(key),/Pending close reaches legacy storage/);
 assert.equal(s.trace.filter(item=>item==='flushStorageData').length,1);assert.equal(s.trace.includes('dialog 关闭 Coconut？'),false);assert.equal(s.result().closing,true);
});

test('failed pending native write re-inspects and Cancel preserves memory and editing',async t=>{
 const s=setup(t);await s.sample();s.writes.held=true;queueNote(s,'Failed native content stays visible');
 const close=s.runtime.closeCoordinator.request();await until(()=>s.writes.pending.length===1,'failing native writer');s.writes.pending[0].fail();assert.equal(await close,false);await turn();
 assert.equal(s.trace.filter(item=>item==='dialog 关闭 Coconut？').length,1);assert.equal(s.trace.includes('flushStorageData'),false);assert.equal(s.result().quitting,false);
 assert.equal(s.store.getDocument().notes.cue,'Failed native content stays visible');assert.equal(s.store.getSnapshot().save.blocked,false);
 s.writes.held=false;await assertEditable(s,'Recovery edit after failed native flush');
});

test('native writer timeout releases ingress, and a late real receipt never closes the reader',async t=>{
 const s=setup(t);await s.sample();s.writes.held=true;queueNote(s,'Late disk acknowledgement');
 const close=s.runtime.closeCoordinator.request();await until(()=>s.writes.pending.length===1,'timed writer');s.expire();assert.equal(await close,false);
 await until(()=>!s.store.getSnapshot().save.blocked,'matching renderer release');assert.equal(s.result().closing,false);
 s.writes.pending[0].settle();await s.store.flush();await turn();
 assert.equal(s.result().quitting,false);assert.equal(s.result().closing,false);assert.equal(s.trace.includes('flushStorageData'),false);assert.equal(s.trace.includes('app.quit'),false);
 s.writes.held=false;await assertEditable(s,'Writable after late acknowledgement');
});

test('DOM-storage timeout retires the same controller owner and its late completion cannot quit',async t=>{
 const s=setup(t);await s.sample();const storage=s.holdStorage(),close=s.runtime.closeCoordinator.request();
 await until(()=>s.trace.includes('flushStorageData'),'held DOM-storage flush');assert.equal(s.result().closing,true);
 s.expire();assert.equal(await close,false);await until(()=>!s.result().closing,'DOM-storage timeout release');
 storage.resolve();await turn();assert.equal(s.result().quitting,false);assert.equal(s.trace.includes('app.quit'),false);await assertEditable(s,'Edit after DOM-storage timeout');
});

test('update flushes a staging-time edit behind its final barrier before installer start',async t=>{
 const s=setup(t);await s.sample();const update=s.runtime.installUpdate();await until(()=>s.trace.includes('prepareInstall'),'staging');
 s.writes.held=true;queueNote(s,'Edit made during update staging');s.stage.resolve(s.install);await until(()=>s.writes.pending.length===1,'update final writer');
 assert.equal(s.trace.includes('install.start'),false);assert.equal(s.trace.includes('flushStorageData'),false);assert.equal(s.store.getSnapshot().save.blocked,true);assert.equal(s.result().closing,false);
 assert.equal(await s.runtime.closeCoordinator.request(),false,'Cmd-Q cannot race the final update writer');
 s.writes.pending[0].settle();await until(()=>s.trace.includes('install.start'),'installer after receipt');assert.match(s.w.localStorage.getItem(key),/Edit made during update staging/);
 s.start.reject(Error('authored installer failure'));await update;await until(()=>!s.result().closing,'installer failure release');
 assert.equal(s.store.getSnapshot().save.blocked,false);s.writes.held=false;await assertEditable(s,'Edit after held update and installer failure');
});

for(const failure of ['failure','timeout'])test(`staging-time content ${failure} never starts installation`,async t=>{
 const s=setup(t);await s.sample();const update=s.runtime.installUpdate();await until(()=>s.trace.includes('prepareInstall'),'staging');
 s.writes.held=true;queueNote(s,'Update timeout retains memory');s.stage.resolve(s.install);await until(()=>s.writes.pending.length===1,'timed update writer');
 if(failure==='timeout')s.expire();else s.writes.pending[0].fail();await update;await until(()=>!s.store.getSnapshot().save.blocked,'update failure release');
 assert.equal(s.trace.includes('install.start'),false);assert.equal(s.trace.includes('flushStorageData'),false);assert.equal(s.result().closing,false);assert.equal(s.result().status,'ready');
 if(failure==='timeout'){s.writes.pending[0].settle();await s.store.flush();await turn();}assert.equal(s.trace.includes('install.start'),false);
 s.writes.held=false;await assertEditable(s,'Edit after failed update writer');
});


test('native quit waits for pending private-reference shutdown as well as helper cleanup',async t=>{
 const s=setup(t,{nativeMedia:true});assert.equal(await s.runtime.closeCoordinator.request(),true);
 assert.ok(s.trace.includes('media.shutdown'));s.shutdown.resolve();await turn();assert.equal(s.result().quitReady,false);
 s.mediaShutdown.resolve();await until(()=>s.result().quitReady,'native media shutdown completion');assert.equal(s.trace.filter(event=>event==='app.quit').length,1);
});
