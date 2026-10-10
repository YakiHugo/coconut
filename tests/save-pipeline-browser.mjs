import {openLibraryTools} from './helpers/library-tools-browser.mjs';
/** CI-only Chromium, authored data and an injected writer delay. No model calls. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from './helpers/legacy-browser.mjs';
const root=new URL('../reader/',import.meta.url),KEY='coconut-reader-v1';
const fixture=key=>({schema_version:1,key,title:'Authored save '+key,language:'en',notes:{},segments:[{id:'one',start:0,end:5,text:'A complete authored reading fixture '+key}],ai_answers:Array.from({length:26},(_,i)=>({question:'Authored question '+i,answer:'Complete answer '+i,citations:['one'],provider:'fixture'}))});
let server,browser,stage='setup',requests=0;
try{
 server=createServer(async(req,res)=>{
  if(req.method!=='GET'){requests++;res.writeHead(405).end();return;}
  const filename=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
  if(!/^[a-z-]+\.(html|js|css|png|webmanifest)$/.test(filename)){res.writeHead(404).end();return;}
  try{const bytes=await fs.readFile(new URL(filename,root));res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.png')?'image/png':'text/html'}).end(bytes);}catch{res.writeHead(404).end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});const context=await browser.newContext({acceptDownloads:true});
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 // Capture the actual adapter before app.js creates its single writer. The
 // delayed success calls the real legacy adapter and therefore writes real disk.
 await context.route('**/library-store.js*',async route=>{
  const response=await route.fetch();const body=await response.text();
  await route.fulfill({response,body:body+`\n(()=>{const api=CoconutLibraryStore,legacy=api.createLegacyAdapter,create=api.create;window.saveProof={hold:false,writes:[],captures:0};api.create=o=>{const store=create(o);window.saveProof.store=store;return store;};api.createLegacyAdapter=o=>{const adapter=legacy(o);return {...adapter,write(value,options){saveProof.captures++;if(!saveProof.hold)return adapter.write(value,options);return new Promise(resolve=>saveProof.writes.push({value,commit:()=>resolve(adapter.write(value,options)),fail:()=>resolve({ok:false,status:'failed',error:{code:'quota'}})}));}};};})();`});
 });
 const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin);await page.evaluate(({KEY,documents})=>localStorage.setItem(KEY,JSON.stringify({documents,active:'a'})),{KEY,documents:[fixture('a'),fixture('b')]});await page.reload();
 stage='debounced pending edits';await page.locator('#summary-open-transcript').click();await page.locator('.note-button').first().click();
 const disk=await page.evaluate(key=>localStorage.getItem(key),KEY);
 await page.evaluate(()=>{saveProof.hold=true;saveProof.captures=0;});await page.locator('#note').fill('First pending');await page.locator('#note').fill('Second pending');await page.locator('#note').fill('Newest pending');
 assert.equal(await page.locator('#save-status').getAttribute('data-state'),'pending');assert.equal(await page.locator('#note').inputValue(),'Newest pending');
 await page.waitForFunction(()=>saveProof.writes.length===1);assert.equal(await page.evaluate(()=>saveProof.captures),1);assert.equal(await page.evaluate(key=>localStorage.getItem(key),KEY),disk);
 const guarded=await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;});assert.equal(guarded,true);
 await page.evaluate(()=>saveProof.writes[0].commit());await page.waitForFunction(()=>document.getElementById('save-status').dataset.state==='saved');
 await page.reload();assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).documents[0].notes.one,KEY),'Newest pending');
 stage='actual quota failure, complete rescue and retry';await page.locator('#summary-open-transcript').click();await page.locator('.note-button').first().click();
 await page.evaluate(()=>{const original=Storage.prototype.setItem;window.restoreSaveStorage=()=>Storage.prototype.setItem=original;Storage.prototype.setItem=function(key,value){if(this===localStorage&&key==='coconut-reader-v1')throw new DOMException('Authored quota','QuotaExceededError');return original.call(this,key,value);};});
 await page.locator('#note').fill('Recover this complete document');await page.waitForFunction(()=>document.getElementById('save-status').dataset.state==='failed');
 assert.match(await page.locator('#save-status').textContent(),/空间不足/);assert.equal(await page.locator('#retry-save').isVisible(),true);
 const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#export-unsaved-documents').click()]);assert.equal(await download.failure(),null);
 const chunks=[];for await(const bytes of await download.createReadStream())chunks.push(bytes);const backup=JSON.parse(Buffer.concat(chunks));
 assert.equal(backup.format,'coconut-library');assert.equal(backup.documents.length,1);assert.equal(backup.documents[0].notes.one,'Recover this complete document');assert.equal(backup.documents[0].ai_answers.length,26);assert.equal(await page.locator('#save-status').getAttribute('data-state'),'failed');
 // Exercise the actual browser prompt, dismissing it retains the failed edit.
 let prompt=false;page.once('dialog',async dialog=>{prompt=dialog.type()==='beforeunload';await dialog.dismiss();});try{await page.reload({timeout:5000});}catch{}
 assert.equal(prompt,true);assert.equal(await page.locator('#note').inputValue(),'Recover this complete document');
 await page.evaluate(()=>window.restoreSaveStorage());await page.locator('#retry-save').click();await page.waitForFunction(()=>document.getElementById('save-status').dataset.state==='saved');await page.reload();
 assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).documents[0].notes.one,KEY),'Recover this complete document');
 stage='pending removal and inaccessible provisional undo';if(!await page.locator('#library').isVisible())await page.locator('#toggle-library').click();await openLibraryTools(page);await page.locator('#library-options > summary').click();
 await page.locator('.library-entry[data-document-key="a"] .library-remove').click();await page.locator('#confirm-removal').click();await page.waitForFunction(()=>!document.getElementById('removal-recovery').hidden);
 await page.evaluate(()=>{saveProof.hold=true;});await page.locator('#undo-removal').click();
 assert.equal(await page.locator('.library-entry[data-document-key="a"] .library-open').isDisabled(),true);
 if(!await page.locator('#library').isVisible())await page.locator('#toggle-library').click();
 await page.locator('.library-entry[data-document-key="b"] .library-open').click();await page.locator('#summary-open-transcript').click();await page.locator('.note-button').first().click();await page.locator('#note').fill('B remains editable while undo waits');
 await page.evaluate(()=>saveProof.writes[0].fail());await page.waitForFunction(()=>!document.querySelector('.library-entry[data-document-key="a"]'));
 assert.equal(await page.locator('#note').inputValue(),'B remains editable while undo waits');assert.equal(await page.locator('#removal-recovery').isVisible(),true);
 await page.evaluate(()=>{saveProof.hold=false;for(const write of saveProof.writes.slice(1))write.commit();return saveProof.store.retry();});

 // CI-only authored geometry: compare the actual compact reader before, during
 // and after a held write, at mobile and desktop sizes in both appearances.
 await page.close();const geometry=[];
 const measure=page=>page.evaluate(()=>{
  const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height};};
  return {header:rect('main > header'),source:rect('.passage-original'),width:document.documentElement.scrollWidth,viewport:innerWidth,state:document.getElementById('save-status').dataset.state};
 });
 const capture=async(page,name)=>{if(!process.env.COCONUT_UI_SCREENSHOTS)return;await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'autosave-'+name+'.png'),fullPage:false,animations:'disabled'});};
 for(const width of [320,360,1280])for(const theme of ['light','dark']){
  stage=`stable autosave ${width} ${theme}`;const proof=await context.newPage();proof.on('pageerror',error=>errors.push(`${width} ${theme}: ${error.message}`));await proof.setViewportSize({width,height:900});
  await proof.goto(origin);await proof.evaluate(({KEY,document,theme})=>{localStorage.setItem(KEY,JSON.stringify({documents:[document],active:'layout'}));localStorage.setItem('coconut-reading-theme-v1',theme);},{KEY,document:fixture('layout'),theme});await proof.reload();
  await proof.locator('#mode-passages').click();const before=await measure(proof);assert.ok(before.source.y<=350);assert.equal(before.width,width);
  await proof.locator('#mode-transcript').click();await proof.locator('.note-button').first().click();
  await proof.evaluate(()=>{saveProof.hold=true;});await proof.locator('#note').fill('Complete authored pending rescue '+width+' '+theme);
  const typing=await proof.evaluate(()=>({focus:document.activeElement.id,actions:[...document.querySelectorAll('#save-status-home button')].filter(n=>!n.hidden).length}));assert.equal(typing.focus,'note');assert.equal(typing.actions,0);
  await capture(proof,`${width}-${theme}-typing`);
  await proof.locator('#close-note').click();await proof.locator('#mode-passages').click();await proof.waitForFunction(()=>saveProof.writes.length===1);
  const pending=await measure(proof);assert.equal(pending.state,'pending');assert.deepEqual(pending.header,before.header);assert.deepEqual(pending.source,before.source);assert.ok(pending.source.y<=350);assert.equal(pending.width,width);
  await capture(proof,`${width}-${theme}-pending`);
  await proof.locator('#export-menu > summary').click();const rescue=proof.locator('#export-pending-documents');await rescue.focus();assert.ok((await rescue.boundingBox()).height>=44);
  const [pendingDownload]=await Promise.all([proof.waitForEvent('download'),rescue.click()]);const bytes=[];for await(const part of await pendingDownload.createReadStream())bytes.push(part);
  const restored=JSON.parse(Buffer.concat(bytes));assert.equal(restored.documents[0].notes.one,'Complete authored pending rescue '+width+' '+theme);assert.equal(restored.documents[0].ai_answers.length,26);assert.equal(restored.documents[0].segments[0].text,fixture('layout').segments[0].text);
  assert.equal(await proof.locator('#save-status').getAttribute('data-state'),'pending');const exported=await measure(proof);
  await proof.evaluate(()=>saveProof.writes[0].commit());await proof.waitForFunction(()=>document.getElementById('save-status').dataset.state==='saved');
  assert.equal(await proof.evaluate(()=>document.activeElement.id),'export-pending-documents');assert.equal(await rescue.isVisible(),true);
  await proof.keyboard.press('Escape');await proof.waitForFunction(()=>document.getElementById('pending-export').hidden);
  const after=await measure(proof);assert.deepEqual(after.header,before.header);assert.deepEqual(after.source,exported.source,'the receipt itself must not shift the reading surface after the explicit download notice');assert.equal(after.width,width);await capture(proof,`${width}-${theme}-saved`);
  geometry.push({width,theme,before,pending,exported,after});await proof.close();
 }
 if(process.env.COCONUT_UI_SCREENSHOTS)await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'autosave-geometry.json'),JSON.stringify(geometry,null,2));
 assert.equal(requests,0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,checks:['pending-debounce','actual-disk-reload','quota-retention','complete-rescue-download','real-beforeunload','retry-disk-proof','provisional-undo-gate','concurrent-B-edit','stable-mobile-desktop-autosave','light-dark-layout','pending-full-fidelity-download','focused-rescue-receipt']},null,2));
}catch(error){throw new Error(stage+': '+error.message,{cause:error});}
finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}
