/** CI-only Chromium proof, authored fixtures only. Do not run in a browser-denied environment. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {openCueActions} from './cue-actions-browser.mjs';
const root=new URL('../reader/',import.meta.url),KEY='coconut-reader-v1';
let browser,server,stage='setup',external=0,mutations=0,pageErrors=0;
const checks=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
// Every reload has a bounded, explicit expectation. Unexpected prompts fail;
// dismissing a prompt here is never permission to continue through it.
async function reload(page,expectPrompt){
 const dialogs=[],handler=async dialog=>{dialogs.push(dialog.type());await dialog.dismiss();};
 const marker=await page.evaluate(()=>window.unloadProbeMarker=crypto.randomUUID());
 page.on('dialog',handler);
 let failure;
 try{await page.reload({waitUntil:'load',timeout:15000});}catch(error){failure=error;}
 finally{page.off('dialog',handler);}
 if(expectPrompt){
  assert.deepEqual(dialogs,['beforeunload'],'exactly the expected native leave prompt must appear');
  if(failure)assert.match(failure.message,/ERR_ABORTED|[Nn]avigation.*(?:cancel|abort)/,'only dismissed navigation may fail');
  assert.equal(await page.evaluate(()=>window.unloadProbeMarker),marker,'dismiss must retain the original document');
 }else{
  assert.deepEqual(dialogs,[],'clean reload must not show any dialog');
  if(failure)throw failure;
  assert.equal(await page.evaluate(()=>window.unloadProbeMarker),undefined,'clean reload must replace the document');
 }
}
try{
 server=createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){mutations++;res.writeHead(405).end();return;}
  const pathname=new URL(req.url,'http://localhost').pathname,filename=pathname==='/'?'index.html':pathname.slice(1);
  if(!/^[a-z-]+\.(html|js|css|webmanifest|png)$/.test(filename)){res.writeHead(404,{'Content-Type':'application/json'}).end('{"error":"static only"}');return;}
  try{const body=await fs.readFile(new URL(filename,root));res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.png')?'image/png':'text/html'}).end(body);}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1360,height:1000},serviceWorkers:'block'});
 await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===origin||['blob:','data:'].includes(url.protocol))await route.continue();else{external++;await route.abort();}});
 const newPage=async()=>{const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',()=>pageErrors++);await page.goto(origin);await page.locator('#sample').waitFor({state:'attached'});return page;};
 const page=await newPage();
 await page.locator('#file').setInputFiles({name:'authored.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({title:'Authored reload proof',segments:[{id:'cue',start:0,end:3,text:'An original sentence for recovery tests.'}]}))});
 await page.locator('#mode-transcript').click();await page.locator('.note-button').click();
 check('ordinary_click_supplies_sticky_activation',await page.evaluate(()=>navigator.userActivation.hasBeenActive));
 stage='dirty_note_reload';
 await page.evaluate(key=>{const original=Storage.prototype.setItem;window.restoreStorageWrites=()=>{Storage.prototype.setItem=original;};Storage.prototype.setItem=function(name,value){if(this===localStorage&&name===key)throw new DOMException('Authored quota failure','QuotaExceededError');return original.call(this,name,value);};},KEY);
 await page.locator('#note').fill('Keep this unsaved authored note');await page.locator('#save-status').waitFor({state:'visible'});
 await reload(page,true);check('dismissed_dirty_reload_keeps_note',await page.locator('#note').inputValue()==='Keep this unsaved authored note');
 stage='recovered_clean_reload';await page.evaluate(()=>window.restoreStorageWrites());await page.locator('#note').fill('Saved after retry');await page.locator('#save-status').waitFor({state:'hidden'});
 await reload(page,false);await page.locator('#mode-transcript').click();await page.locator('.note-button').click();check('successful_save_removes_prompt_and_survives_reload',await page.locator('#note').inputValue()==='Saved after retry');
 stage='unchanged_edit_dialog';await page.locator('#close-note').click();await openCueActions(page.locator('.segment').first());await page.locator('.edit-button').click();await reload(page,false);check('open_unchanged_dialog_has_no_prompt',true);
 stage='changed_edit_dialog';await page.locator('#mode-transcript').click();await openCueActions(page.locator('.segment').first());await page.locator('.edit-button').click();await page.locator('#edit-segment').fill('Unsaved authored correction');await reload(page,true);
 check('dismissed_reload_keeps_edit_draft',await page.locator('#edit-segment').inputValue()==='Unsaved authored correction');
 await page.locator('#edit-dialog button[value="cancel"]').click();await page.locator('#edit-dialog').waitFor({state:'hidden'});await reload(page,false);check('canceling_edit_restores_clean_reload',true);
 stage='two_tab_conflict';const other=await newPage();
 await page.locator('#mode-transcript').click();await page.locator('.note-button').click();await page.locator('#note').fill('Newer saved note in first tab');
 const disk=await page.evaluate(key=>localStorage.getItem(key),KEY);
 await other.bringToFront();await other.locator('#mode-transcript').click();await other.locator('.note-button').click();await other.locator('#note').fill('Unsaved conflicting note in second tab');
 await other.locator('#save-status').waitFor({state:'visible'});await reload(other,true);
 check('conflict_reload_dismiss_preserves_both_versions',await other.locator('#note').inputValue()==='Unsaved conflicting note in second tab'&&await other.evaluate(key=>localStorage.getItem(key),KEY)===disk);
 check('no_external_requests_mutations_or_page_errors',external===0&&mutations===0&&pageErrors===0);
 console.log(JSON.stringify({suite:'reader-unsaved-unload',status:'passed',checks}));
}catch(error){console.error(JSON.stringify({suite:'reader-unsaved-unload',status:'failed',stage,checks,error:error.message}));process.exitCode=1;}
finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}
