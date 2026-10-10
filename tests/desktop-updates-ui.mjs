/** Real isolated Electron UI, authored fixtures only; no account/model/network work. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from '@playwright/test';
const root=fileURLToPath(new URL('../',import.meta.url)),temporary=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-update-ui-'));
const {version}=JSON.parse(await fs.readFile(path.join(root,'desktop/package.json'),'utf8'));
let application;
try{
 const profile=path.join(temporary,'profile'),home=path.join(temporary,'home');await fs.mkdir(home);
 const launch=async()=>{
  application=await electron.launch({executablePath:path.join(root,'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(root,'desktop'),'--user-data-dir='+profile],chromiumSandbox:true,
   env:{HOME:home,TMPDIR:temporary,PATH:'/usr/bin:/bin'},timeout:45000});
  const page=await application.firstWindow();await page.waitForFunction(()=>typeof window.coconutPrepareUpdate==='function');return page;
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
 await page.evaluate(()=>{const original=Storage.prototype.setItem;window.restoreNativeStorage=()=>{Storage.prototype.setItem=original;};Storage.prototype.setItem=function(key,value){if(this===localStorage&&key==='coconut-reader-v1')throw new DOMException('Authored quota failure','QuotaExceededError');return original.call(this,key,value);};});
 await page.locator('#note').fill('Temporary unsaved native note');
 await page.evaluate(()=>libraryStore.flush());
 assert.equal(await webUnloadAbsent(),true);assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),false);
 await page.evaluate(()=>window.restoreNativeStorage());await page.locator('#note').fill('更新重启后保留这则笔记');await page.locator('#close-note').click();
 assert.equal(await webUnloadAbsent(),true);
 assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),true);
 const expected=await page.evaluate(()=>localStorage.getItem('coconut-reader-v1'));
 await application.close();application=null;page=await launch();
 assert.equal(await page.evaluate(()=>localStorage.getItem('coconut-reader-v1')),expected);
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
 assert.ok((await page.evaluate(()=>localStorage.getItem('coconut-reader-v1'))).includes('Ownership release remains writable'));
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
 const finalSaved=await page.evaluate(()=>localStorage.getItem('coconut-reader-v1'));
 await page.reload();await page.waitForFunction(()=>typeof window.coconutPrepareUpdate==='function');
 assert.equal(await page.evaluate(()=>localStorage.getItem('coconut-reader-v1')),finalSaved);
 // Hold the production legacy writer in the real renderer. Only acknowledgement
 // timing is authored: serialization, AbortSignal handling and disk writes are real.
 await page.addInitScript(()=>{
  let api;const control={held:false,pending:[]};window.nativeWriterTest=control;
  Object.defineProperty(window,'CoconutLibraryStore',{configurable:true,get:()=>api,set(value){
   api=value;const create=api.createLegacyAdapter;
   api.createLegacyAdapter=options=>{const adapter=create(options);return {...adapter,write(value,context){
    if(!control.held)return adapter.write(value,context);
    return new Promise(resolve=>control.pending.push({signal:context.signal,settle:()=>resolve(adapter.write(value,context)),fail:()=>resolve({ok:false,status:'failed',error:{code:'quota'}})}));
   }}};
  }});
 });
 await page.reload();await page.waitForFunction(()=>typeof window.coconutPrepareUpdate==='function');
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
 assert.equal(await page.evaluate(async()=>{nativeWriterTest.pending[0].settle();return await nativePendingClose;}),true);
 assert.equal(await page.evaluate(()=>readerClosing&&document.body.inert&&localStorage.getItem('coconut-reader-v1').includes('Native delayed acknowledgement fixture')),true);
 assert.equal(await page.evaluate(()=>coconutPrepareClose('release',nativePendingOwner)),true);
 await page.locator('.segment .note-button').first().click();await page.locator('#note').fill('Native quota retains this note');await page.locator('#close-note').click();
 await page.evaluate(()=>{window.nativeFailedOwner={id:2,kind:'update',expiresAt:Date.now()+60000};window.nativeFailedUpdate=coconutPrepareUpdate(true,nativeFailedOwner);});
 await page.waitForFunction(()=>nativeWriterTest.pending.length===2);
 assert.equal(await page.evaluate(async()=>{nativeWriterTest.pending[1].fail();return await nativeFailedUpdate;}),false);
 assert.equal(await page.evaluate(()=>!readerClosing&&!document.body.inert&&!libraryStore.status().blocked&&coconutPrepareClose('inspect').contentFailed),true);
 await page.evaluate(async()=>{coconutPrepareClose('release',nativeFailedOwner);nativeWriterTest.held=false;await libraryStore.retry();});
 await page.locator('.segment .note-button').first().click();await page.evaluate(()=>{nativeWriterTest.held=true;});await page.locator('#note').fill('Native discard awaiting abort acknowledgement');await page.locator('#close-note').click();
 await page.evaluate(()=>{window.nativeDiscardFlush=libraryStore.flush();});await page.waitForFunction(()=>nativeWriterTest.pending.length===3);
 await page.evaluate(()=>{window.nativeDiscardOwner={id:3,kind:'close',expiresAt:Date.now()+60000};window.nativeDiscardClose=coconutPrepareClose('discard',nativeDiscardOwner);});
 await page.waitForFunction(()=>nativeWriterTest.pending[2].signal.aborted);
 assert.equal(await page.evaluate(()=>!readerClosing&&document.body.inert&&libraryStore.status().blocked),true,'discard must wait for the actual abort acknowledgement');
 assert.equal(await page.evaluate(async()=>{nativeWriterTest.pending[2].settle();await nativeDiscardFlush;return await nativeDiscardClose;}),true);
 await page.evaluate(async()=>{coconutPrepareClose('release',nativeDiscardOwner);nativeWriterTest.held=false;await libraryStore.retry();});
 const delayedSaved=await page.evaluate(()=>localStorage.getItem('coconut-reader-v1'));await page.reload();await page.waitForFunction(()=>typeof coconutPrepareUpdate==='function');
 assert.equal(await page.evaluate(()=>localStorage.getItem('coconut-reader-v1')),delayedSaved,'delayed receipt content survives a real renderer reload');
 await application.close();application=null;
 console.log('Update UI acceptance passed: sandboxed native IPC, developer opt-in, restart guards, expired/scoped ownership, sample hashing, delayed legacy receipts, quota recovery, acknowledged discard and writable notes across release/relaunch. No inference or model downloads.');
}finally{if(application)await application.close();await fs.rm(temporary,{recursive:true,force:true});}
