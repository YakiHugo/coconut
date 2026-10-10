/** Real isolated Electron UI, authored fixtures only; no account/model/network work. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from '@playwright/test';
import {installStorageAssertions,readerReady} from './helpers/browser-storage.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),temporary=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-update-ui-'));
const {version}=JSON.parse(await fs.readFile(path.join(root,'desktop/package.json'),'utf8'));
let application;
async function nativeReady(page){
 await readerReady(page);
 await page.waitForFunction(()=>typeof window.coconutPrepareUpdate==='function'&&typeof window.coconutPrepareClose==='function');
 assert.equal(await page.evaluate(()=>window.CoconutStorageBootstrap.result.backend),'indexeddb','native update journeys use the default production IndexedDB backend');
}
try{
 const profile=path.join(temporary,'profile'),home=path.join(temporary,'home');await fs.mkdir(home);
 const launch=async()=>{
  application=await electron.launch({executablePath:path.join(root,'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(root,'desktop'),'--user-data-dir='+profile],chromiumSandbox:true,
   env:{HOME:home,TMPDIR:temporary,PATH:'/usr/bin:/bin'},timeout:45000});
  const page=await application.firstWindow();await page.waitForLoadState('domcontentloaded');await installStorageAssertions(page);await nativeReady(page);return page;
 };
 let page=await launch();await page.locator('#app-updates > summary').click();
 assert.ok((await page.locator('#update-version').textContent()).includes(version));
 assert.equal(await page.evaluate(()=>typeof require==='undefined'&&typeof process==='undefined'),true);
 assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),true);
 await page.locator('#update-developer').check();
 await page.waitForFunction(()=>document.getElementById('update-status').textContent.includes('已启用'));
 assert.equal(JSON.parse(await fs.readFile(path.join(profile,'updates/settings.json'),'utf8')).developer,true);
 // Confirm every important unsaved/busy condition blocks restart.
 for(const expression of [
  `document.getElementById('audio-bookmark-time').value='12:34'`,
  `document.getElementById('audio-bookmark-note').value='未提交的书签笔记'`,
  `document.getElementById('ai-question').value='尚未提交的问题'`,
  `document.getElementById('edit-dialog').showModal()`,
  `podcastRequest=new AbortController()`,
  `podcastMediaRequest=new AbortController()`,
  `projectCaptionRequest={controller:new AbortController()}`,
  `sourceCaptionRequest=new AbortController()`,
  `sourceSubmitting=true`,
  `document.getElementById('sample').disabled=true`,
  `asking=true`
 ]){
  await page.evaluate(expression);assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),false,expression);
  await page.evaluate(()=>{document.getElementById('audio-bookmark-form').reset();document.getElementById('ai-question').value='';document.getElementById('translation-glossary').value='';document.getElementById('edit-dialog').close();podcastRequest=null;podcastMediaRequest=null;projectCaptionRequest=null;sourceCaptionRequest=null;sourceSubmitting=false;document.getElementById('sample').disabled=false;asking=false;});
 }
 const fixture=path.join(temporary,'authored.json');await fs.writeFile(fixture,JSON.stringify({schema_version:1,title:'Update persistence fixture',language:'en',segments:[{id:'first',start:0,end:4,text:'Authored updater acceptance words.'}]}));
 await page.locator('#add-content').click();const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#import').click()]);await chooser.setFiles(fixture);
 await page.locator('#mode-transcript').click();await page.locator('.segment[data-segment-id="first"] .note-button').click();await page.locator('#note').fill('更新重启后保留这则笔记');await page.locator('#close-note').click();
 // A glossary belongs to an imported document. Exercise the actual visible
 // controls instead of assigning a hidden field on the empty startup page.
 await page.locator('#language-panel > summary').click();await page.locator('#ai-task').selectOption('translation');await page.locator('#translation-options > summary').click();
 await page.locator('#translation-glossary').fill('Coconut = 椰子');
 assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),false,'an owned glossary draft blocks update');
 assert.equal(await page.evaluate(()=>coconutPrepareClose('inspect').safe),false,'the same glossary draft blocks native close');
 await page.locator('#cancel-translation-glossary').click();assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),true,'canceling the draft releases the update guard');
 await page.locator('#translation-glossary').fill('Coconut = 椰子');assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),false);
 await page.locator('#save-translation-glossary').click();assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),true,'saving the glossary releases the update guard');
 assert.equal(await page.evaluate(()=>coconutPrepareClose('inspect').safe),true);
 await page.locator('#language-panel > summary').click();
 // Web unload prompts must not intercept native quit after service teardown.
 const webUnloadAbsent=()=>page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return !!window.coconutUpdates&&!unloadGuardReady&&!unloadGuardAttached&&!event.defaultPrevented;});
 await page.locator('#reading-settings > summary').click();
 await page.locator('#document-details').click();await page.locator('#document-title').fill('Temporary unsaved native title');
 assert.equal(await webUnloadAbsent(),true);assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),false);
 await page.locator('#details-dialog button[value="cancel"]').click();
 await page.locator('.segment[data-segment-id="first"] .note-button').click();
 await page.evaluate(()=>window.failContentWrites());
 await page.locator('#note').fill('Temporary unsaved native note');
 await page.evaluate(()=>libraryStore.flush());
 assert.equal(await webUnloadAbsent(),true);assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),false);
 await page.evaluate(()=>window.restoreContentWrites());await page.locator('#note').fill('更新重启后保留这则笔记');await page.locator('#close-note').click();
 assert.equal(await webUnloadAbsent(),true);
 assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),true);
 const expected=await page.evaluate(()=>window.readPersistedLibrary());
 await application.close();application=null;page=await launch();
 assert.deepEqual(await page.evaluate(()=>window.readPersistedLibrary()),expected);
 assert.equal(await page.locator('#update-developer').isChecked(),true);
 assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),true);
 // CI-only real-renderer ownership acceptance. Authored tokens are deliberately
 // scoped to this page; reload afterward resets the page before native app quit.
 assert.equal(await page.evaluate(()=>coconutPrepareClose('safe')),false);
 assert.equal(await page.evaluate(()=>coconutPrepareUpdate(true)),false);
 const expiredEffects=await page.evaluate(()=>{
  const before=localImportRevision;sourceCaptionRequest=new AbortController();const controller=sourceCaptionRequest;
  document.getElementById('ai-consent').checked=true;
  const accepted=coconutPrepareClose('discard',{id:1,kind:'close',expiresAt:Date.now()-1});
  const result={accepted,aborted:controller.signal.aborted,consent:document.getElementById('ai-consent').checked,revisionUnchanged:localImportRevision===before,inert:!!document.body.inert,closing:readerClosing};
  sourceCaptionRequest=null;document.getElementById('ai-consent').checked=false;return result;
 });
 assert.deepEqual(expiredEffects,{accepted:false,aborted:false,consent:true,revisionUnchanged:true,inert:false,closing:false});
 const ownership=await page.evaluate(async()=>{
  const close={id:2,kind:'close',expiresAt:Date.now()+60000},update={id:3,kind:'update',expiresAt:Date.now()+60000};
  const closed=await coconutPrepareClose('safe',close),locked=readerClosing&&document.body.inert;
  const foreignRelease=coconutPrepareClose('release',{...close,kind:'update'}),stillLocked=readerClosing&&document.body.inert;
  const released=coconutPrepareClose('release',close),editable=!readerClosing&&!document.body.inert;
  const updateLocked=await coconutPrepareUpdate(true,update),before=localImportRevision;
  const oldCommit=await coconutPrepareClose('discard',close),oldRelease=coconutPrepareClose('release',close);
  const updateStillOwned=readerClosing&&document.body.inert&&localImportRevision===before;
  const updateReleased=coconutPrepareClose('release',update),editableAgain=!readerClosing&&!document.body.inert;
  return {closed,locked,foreignRelease,stillLocked,released,editable,updateLocked,oldCommit,oldRelease,updateStillOwned,updateReleased,editableAgain};
 });
 assert.deepEqual(ownership,{closed:true,locked:true,foreignRelease:false,stillLocked:true,released:true,editable:true,updateLocked:true,oldCommit:false,oldRelease:false,updateStillOwned:true,updateReleased:true,editableAgain:true});
 await page.locator('#mode-transcript').click();await page.locator('.segment[data-segment-id="first"] .note-button').click();
 await page.locator('#note').fill('Ownership release remains writable');await page.locator('#close-note').click();
 await page.evaluate(()=>libraryStore.flush());
 assert.ok(JSON.stringify(await page.evaluate(()=>window.readPersistedLibrary())).includes('Ownership release remains writable'));
 // Hold real sample hashing: update readiness must remain blocked at the final
 // boundary without cancelling that import or making the visible UI inert.
 await page.evaluate(()=>{
  const original=crypto.subtle.digest.bind(crypto.subtle);let resolve;
  const pending=new Promise(done=>{resolve=done;});
  crypto.subtle.digest=async(...args)=>{await pending;return original(...args);};
  window.finishNativeSample=()=>{crypto.subtle.digest=original;resolve();};
  window.nativeSample=document.getElementById('sample').onclick();
 });
 await page.waitForFunction(()=>document.getElementById('sample').disabled);
 assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),false,'sample hashing blocks preflight');
 assert.equal(await page.evaluate(()=>coconutPrepareUpdate(true,{id:4,kind:'update',expiresAt:Date.now()+60000})),false,'sample hashing blocks final commit');
 assert.equal(await page.evaluate(()=>!!document.body.inert||readerClosing),false);
 await page.evaluate(async()=>{window.finishNativeSample();await window.nativeSample;});
 assert.equal(await page.evaluate(()=>document.getElementById('sample').disabled),false);
 assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),true);
 const finalSaved=await page.evaluate(()=>window.readPersistedLibrary());
 await page.reload();await nativeReady(page);
 assert.deepEqual(await page.evaluate(()=>window.readPersistedLibrary()),finalSaved);
 // Hold the selected production writer in the real renderer. Only admission
 // timing is authored: transactions, AbortSignal handling and disk writes are real.
 await page.addInitScript(()=>{
  let api;const control={held:false,pending:[]};window.nativeWriterTest=control;
  Object.defineProperty(window,'CoconutStorageProvider',{configurable:true,get:()=>api,set(value){
   api=value;const initialize=api.initialize;
   api.initialize=async options=>{const result=await initialize(options);if(!result.ok)return result;const adapter=result.adapter;
    return {...result,adapter:{...adapter,write(value,context){
     if(!control.held)return adapter.write(value,context);
     return new Promise(resolve=>control.pending.push({signal:context.signal,
      settle:()=>resolve(adapter.write(value,context)),
      fail:async()=>{window.failContentWrites();try{resolve(await adapter.write(value,context));}finally{window.restoreContentWrites();}}
     }));
    }}};
   };
  }});
 });
 await page.reload();await nativeReady(page);
 const beforeDelayedWrite=await page.evaluate(()=>window.readPersistedLibrary());
 await page.locator('#mode-transcript').click();await page.locator('.segment .note-button').first().click();
 await page.evaluate(()=>{nativeWriterTest.held=true;});await page.locator('#note').fill('Native delayed acknowledgement fixture');await page.locator('#close-note').click();
 const pendingOwner=await page.evaluate(()=>{
  const snapshot=coconutPrepareClose('inspect'),owner={id:1,kind:'close',expiresAt:Date.now()+60000};window.nativePendingOwner=owner;
  window.nativePendingClose=coconutPrepareClose('safe',owner);
  return {safe:snapshot.safe,flushable:snapshot.flushable,samePromise:window.nativePendingClose===coconutPrepareClose('safe',owner),closing:readerClosing};
 });
 assert.deepEqual(pendingOwner,{safe:false,flushable:true,samePromise:true,closing:false});
 await page.waitForFunction(()=>nativeWriterTest.pending.length===1);
 assert.equal(await page.evaluate(()=>libraryStore.status().blocked&&!readerClosing&&document.body.inert),true);
 assert.deepEqual(await page.evaluate(()=>window.readPersistedLibrary()),beforeDelayedWrite,'a held native write has no persisted acknowledgement');
 assert.equal(await page.evaluate(async()=>{nativeWriterTest.pending[0].settle();return await nativePendingClose;}),true);
 assert.equal(await page.evaluate(async()=>readerClosing&&document.body.inert&&JSON.stringify(await window.readPersistedLibrary()).includes('Native delayed acknowledgement fixture')),true);
 const beforeQuota=await page.evaluate(()=>window.readPersistedLibrary());
 assert.equal(await page.evaluate(()=>coconutPrepareClose('release',nativePendingOwner)),true);
 await page.locator('.segment .note-button').first().click();await page.locator('#note').fill('Native quota retains this note');await page.locator('#close-note').click();
 await page.evaluate(()=>{window.nativeFailedOwner={id:2,kind:'update',expiresAt:Date.now()+60000};window.nativeFailedUpdate=coconutPrepareUpdate(true,nativeFailedOwner);});
 await page.waitForFunction(()=>nativeWriterTest.pending.length===2);
 assert.equal(await page.evaluate(async()=>{nativeWriterTest.pending[1].fail();return await nativeFailedUpdate;}),false);
 assert.equal(await page.evaluate(()=>!readerClosing&&!document.body.inert&&!libraryStore.status().blocked&&coconutPrepareClose('inspect').contentFailed),true);
 assert.deepEqual(await page.evaluate(()=>window.readPersistedLibrary()),beforeQuota,'a quota-aborted IndexedDB transaction preserves the last committed content');
 await page.evaluate(async()=>{coconutPrepareClose('release',nativeFailedOwner);nativeWriterTest.held=false;await libraryStore.retry();});
 const beforeDiscard=await page.evaluate(()=>window.readPersistedLibrary());
 assert.ok(JSON.stringify(beforeDiscard).includes('Native quota retains this note'),'retry commits the retained note to IndexedDB');
 await page.locator('.segment .note-button').first().click();await page.evaluate(()=>{nativeWriterTest.held=true;});await page.locator('#note').fill('Native discard awaiting abort acknowledgement');await page.locator('#close-note').click();
 await page.evaluate(()=>{window.nativeDiscardFlush=libraryStore.flush();});await page.waitForFunction(()=>nativeWriterTest.pending.length===3);
 await page.evaluate(()=>{window.nativeDiscardOwner={id:3,kind:'close',expiresAt:Date.now()+60000};window.nativeDiscardClose=coconutPrepareClose('discard',nativeDiscardOwner);});
 await page.waitForFunction(()=>nativeWriterTest.pending[2].signal.aborted);
 assert.equal(await page.evaluate(()=>!readerClosing&&document.body.inert&&libraryStore.status().blocked),true,'discard must wait for the actual abort acknowledgement');
 assert.equal(await page.evaluate(async()=>{nativeWriterTest.pending[2].settle();await nativeDiscardFlush;return await nativeDiscardClose;}),true);
 assert.deepEqual(await page.evaluate(()=>window.readPersistedLibrary()),beforeDiscard,'acknowledged discard does not commit the aborted edit');
 await page.evaluate(async()=>{coconutPrepareClose('release',nativeDiscardOwner);nativeWriterTest.held=false;await libraryStore.retry();});
 const delayedSaved=await page.evaluate(()=>window.readPersistedLibrary());await page.reload();await nativeReady(page);
 assert.deepEqual(await page.evaluate(()=>window.readPersistedLibrary()),delayedSaved,'delayed receipt content survives a real renderer reload');
 // The isolated authored profile now exercises native close during first-time
 // migration. Preserve its complete library as the immutable legacy source.
 assert.equal((await page.evaluate(()=>libraryStore.flush())).ok,true);
 const migrationExpected=await page.evaluate(()=>window.readPersistedLibrary()),migrationRaw=JSON.stringify(migrationExpected);
 assert.ok(migrationExpected.documents.length>0,'startup migration covers the authored nonempty library');
 await page.evaluate(async raw=>{
  window.CoconutStorageBootstrap.result.adapter.close();
  await new Promise((resolve,reject)=>{
   const request=indexedDB.deleteDatabase('coconut-reader-library-v1');
   request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);
   request.onblocked=()=>reject(new Error('The authored migration reset was blocked'));
  });
  localStorage.clear();sessionStorage.clear();localStorage.setItem('coconut-reader-v1',raw);
 },migrationRaw);
 await page.addInitScript(()=>{
  const add=IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add=function(value,key){
   const request=add.apply(this,arguments);
   if(this.transaction.db.name==='coconut-reader-library-v1'&&this.name==='meta'&&key==='state'&&!window.nativeMigrationHeld){
    const store=this,transaction=this.transaction,held={active:true,terminal:null,mode:transaction.mode};window.nativeMigrationHeld=held;
    transaction.addEventListener('abort',()=>{held.active=false;held.terminal='aborted';});
    transaction.addEventListener('complete',()=>{held.active=false;held.terminal='completed';});
    // Queue real reads from each success event so migration cannot finish until
    // production startup shutdown aborts its real, still-active transaction.
    const keepAlive=()=>{const next=store.get('state');next.onsuccess=()=>{if(held.active)keepAlive();};};
    keepAlive();
   }
   return request;
  };
 });
 await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.nativeMigrationHeld?.active&&window.CoconutStorageBootstrap?.phase==='loading');
 assert.deepEqual(await page.evaluate(()=>({active:nativeMigrationHeld.active,mode:nativeMigrationHeld.mode,
  phase:CoconutStorageBootstrap.phase,inert:document.querySelector('.shell').inert,
  readerLoaded:typeof libraryStore!=='undefined',flushable:coconutPrepareClose('inspect').flushable,
  safe:coconutPrepareClose('inspect').safe,update:coconutPrepareUpdate()})),
  {active:true,mode:'readwrite',phase:'loading',inert:true,readerLoaded:false,flushable:true,safe:false,update:false});
 assert.equal(await page.evaluate(()=>localStorage.getItem('coconut-reader-v1')),migrationRaw,'in-flight migration preserves its complete source');
 // Any unexpected native prompt chooses keep-editing and makes this close fail
 // its timeout, rather than silently authorizing a discard or forcing exit.
 await application.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:0});});
 const startupClosed=application.waitForEvent('close',{timeout:15000});
 await application.evaluate(({BrowserWindow})=>{setTimeout(()=>BrowserWindow.getAllWindows()[0].close(),0);});
 await startupClosed;application=null;
 page=await launch();
 assert.equal(await page.evaluate(()=>window.CoconutStorageBootstrap.result.migrated),true,'startup close aborted the held migration before relaunch completed it');
 assert.deepEqual(await page.evaluate(()=>window.readPersistedLibrary()),migrationExpected,'native close during migration preserves every authored document across relaunch');
 assert.equal(await page.evaluate(()=>localStorage.getItem('coconut-reader-v1')),migrationRaw,'native migration recovery leaves legacy source bytes unchanged');
 assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),true,'recovered native reader is ready for a safe update');
 await application.close();application=null;
 console.log('Update UI acceptance passed: sandboxed native IPC, developer opt-in, restart guards, expired/scoped ownership, sample hashing, delayed IndexedDB receipts, quota recovery, acknowledged discard, startup migration close/recovery and writable notes across release/relaunch. No inference or model downloads.');
}finally{if(application)await application.close();await fs.rm(temporary,{recursive:true,force:true});}
