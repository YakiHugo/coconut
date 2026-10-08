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
  `document.getElementById('translation-glossary').value='Coconut = 椰子'`,
  `document.getElementById('edit-dialog').showModal()`,
  `podcastRequest=new AbortController()`,
  `podcastMediaRequest=new AbortController()`,
  `projectCaptionRequest={controller:new AbortController()}`,
  `sourceCaptionRequest=new AbortController()`,
  `asking=true`,
  `document.getElementById('save-status').hidden=false`
 ]){
  await page.evaluate(expression);assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),false,expression);
  await page.evaluate(()=>{document.getElementById('audio-bookmark-form').reset();document.getElementById('ai-question').value='';document.getElementById('translation-glossary').value='';document.getElementById('edit-dialog').close();podcastRequest=null;podcastMediaRequest=null;projectCaptionRequest=null;sourceCaptionRequest=null;asking=false;document.getElementById('save-status').hidden=true;});
 }
 const fixture=path.join(temporary,'authored.json');await fs.writeFile(fixture,JSON.stringify({schema_version:1,title:'Update persistence fixture',language:'en',segments:[{id:'first',start:0,end:4,text:'Authored updater acceptance words.'}]}));
 await page.locator('#add-content').click();const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#import').click()]);await chooser.setFiles(fixture);
 await page.locator('#mode-transcript').click();await page.locator('.segment[data-segment-id="first"] .note-button').click();await page.locator('#note').fill('更新重启后保留这则笔记');await page.locator('#close-note').click();
 // Web unload prompts must not intercept native quit after service teardown.
 const webUnloadAbsent=()=>page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return !!window.coconutUpdates&&!unloadGuardReady&&!unloadGuardAttached&&!event.defaultPrevented;});
 await page.locator('#document-details').click();await page.locator('#document-title').fill('Temporary unsaved native title');
 assert.equal(await webUnloadAbsent(),true);assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),false);
 await page.locator('#details-dialog button[value="cancel"]').click();
 await page.locator('.segment[data-segment-id="first"] .note-button').click();
 await page.evaluate(()=>{const original=Storage.prototype.setItem;window.restoreNativeStorage=()=>{Storage.prototype.setItem=original;};Storage.prototype.setItem=function(key,value){if(this===localStorage&&key==='coconut-reader-v1')throw new DOMException('Authored quota failure','QuotaExceededError');return original.call(this,key,value);};});
 await page.locator('#note').fill('Temporary unsaved native note');
 assert.equal(await webUnloadAbsent(),true);assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),false);
 await page.evaluate(()=>window.restoreNativeStorage());await page.locator('#note').fill('更新重启后保留这则笔记');await page.locator('#close-note').click();
 assert.equal(await webUnloadAbsent(),true);
 assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),true);
 const expected=await page.evaluate(()=>localStorage.getItem('coconut-reader-v1'));
 await application.close();application=null;page=await launch();
 assert.equal(await page.evaluate(()=>localStorage.getItem('coconut-reader-v1')),expected);
 assert.equal(await page.locator('#update-developer').isChecked(),true);
 assert.equal(await page.evaluate(()=>coconutPrepareUpdate()),true);
 await application.close();application=null;
 console.log('Update UI acceptance passed: sandboxed native IPC, developer opt-in, 11 restart guards, saved notes and settings across relaunch. No inference or model downloads.');
}finally{if(application)await application.close();await fs.rm(temporary,{recursive:true,force:true});}
