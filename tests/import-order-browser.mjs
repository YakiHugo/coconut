/** Browser-CI-only proof with authored files and deferred local operations.
 * No models, accounts, real source material or browser artifacts are used. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import {chromium} from '@playwright/test';

const root=new URL('../reader/',import.meta.url),KEY='coconut-reader-v1';
const source=title=>({title,language:'en',segments:[{id:'cue',start:0,end:4,text:'An authored sentence for '+title}],notes:{cue:'Private authored note for '+title}});
const checks=[];let browser,server,stage='setup',mutations=0,external=0,errors=0;
function check(name,value){assert.ok(value,name);checks.push(name);}
try{
 server=createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){mutations++;res.writeHead(405).end();return;}
  const pathname=new URL(req.url,'http://localhost').pathname,filename=pathname==='/'?'index.html':pathname.slice(1);
  if(!/^[a-z-]+\.(html|js|css|webmanifest|png)$/.test(filename)){res.writeHead(404,{'Content-Type':'application/json'}).end('{"error":"static only"}');return;}
  try{const body=await fs.readFile(new URL(filename,root));res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.png')?'image/png':'text/html'}).end(body);}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
 await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===origin||['blob:','data:'].includes(url.protocol))await route.continue();else{external++;await route.abort();}});
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',()=>errors++);
 await page.addInitScript(()=>{
  const probe=window.importProbe={finished:0,holdFingerprint:false,heldReadName:null};
  const digest=crypto.subtle.digest.bind(crypto.subtle);
  crypto.subtle.digest=async(...args)=>{
   if(probe.holdFingerprint){probe.holdFingerprint=false;await new Promise(resolve=>{probe.releaseFingerprint=resolve;});probe.releaseFingerprint=null;}
   return digest(...args);
  };
  const read=File.prototype.text;
  File.prototype.text=async function(){
   if(this.name===probe.heldReadName){probe.heldReadName=null;await new Promise(resolve=>{probe.releaseRead=resolve;});probe.releaseRead=null;}
   return read.call(this);
  };
 });
 await page.goto(origin);await page.locator('#sample').waitFor({state:'visible'});
 await page.evaluate(()=>{for(const id of ['file','library-file']){const input=document.getElementById(id),handler=input.onchange;input.onchange=async event=>{await handler.call(input,event);window.importProbe.finished++;};}});
 const choose=(title,text=JSON.stringify(source(title)))=>page.locator('#file').setInputFiles({name:title+'.json',mimeType:'application/json',buffer:Buffer.from(text)});
 const finished=number=>page.waitForFunction(number=>window.importProbe.finished===number,number);
 const stored=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),KEY);
 const hold=()=>page.evaluate(()=>{window.importProbe.holdFingerprint=true;});
 const entered=()=>page.waitForFunction(()=>!!window.importProbe.releaseFingerprint);
 const release=()=>page.evaluate(()=>window.importProbe.releaseFingerprint());

 stage='slow_first_fingerprint';await hold();await choose('Old selection');await entered();await choose('Latest selection');await finished(1);
 await page.locator('#mode-transcript').click();await page.locator('.note-button').click();await page.locator('#note').fill('A newer private note');
 const latest=await stored(),message=await page.locator('#notice').textContent();await release();await finished(2);
 assert.deepEqual(await stored(),latest);check('only_latest_file_is_saved_and_open',latest.documents.length===1&&await page.locator('#title').textContent()==='Latest selection');
 check('late_import_preserves_open_note_and_notice',await page.locator('#note').inputValue()==='A newer private note'&&await page.locator('#notes-panel').isVisible()&&await page.locator('#notice').textContent()===message);

 stage='newer_file_input_ownership';await hold();await choose('Obsolete pending file');await entered();
 await page.evaluate(()=>{window.importProbe.heldReadName='Latest pending file.json';});await choose('Latest pending file');await page.waitForFunction(()=>!!window.importProbe.releaseRead);
 await release();await finished(3);
 check('old_completion_does_not_clear_new_native_file_selection',await page.locator('#file').evaluate(input=>input.files[0]?.name==='Latest pending file.json'));
 await page.evaluate(()=>window.importProbe.releaseRead());await finished(4);check('latest_pending_file_finishes_normally',await page.locator('#title').textContent()==='Latest pending file');

 stage='navigation_away_and_back';await hold();await choose('Abandoned by navigation');await entered();
 await page.locator('#add-content').click();await page.locator('#back-reading').click();const beforeNavigationRelease=await stored();
 await release();await finished(5);assert.deepEqual(await stored(),beforeNavigationRelease);
 check('workspace_return_does_not_revive_old_import',await page.locator('#title').textContent()==='Latest pending file'&&await page.locator('#reader-workspace').isVisible());

 stage='library_navigation';await hold();await choose('Abandoned by library');await entered();
 if(await page.locator('#toggle-library').isVisible()&&await page.locator('#toggle-library').getAttribute('aria-expanded')==='false')await page.locator('#toggle-library').click();
 await page.locator('#library button').filter({hasText:'Latest selection'}).click();const beforeLibraryRelease=await stored();
 await release();await finished(6);assert.deepEqual(await stored(),beforeLibraryRelease);check('library_choice_keeps_its_document',await page.locator('#title').textContent()==='Latest selection');

 stage='stale_parse_error';await page.evaluate(()=>{window.importProbe.heldReadName='Obsolete invalid file.json';});await choose('Obsolete invalid file','{');await page.waitForFunction(()=>!!window.importProbe.releaseRead);
 await choose('Successful retry');await finished(7);const successfulNotice=await page.locator('#notice').textContent();await page.evaluate(()=>window.importProbe.releaseRead());await finished(8);
 check('obsolete_parse_error_cannot_replace_success',await page.locator('#notice').textContent()===successfulNotice&&await page.locator('#title').textContent()==='Successful retry');
 const beforeRetry=await stored();await choose('Successful retry');await finished(9);assert.deepEqual(await stored(),beforeRetry);
 check('same_file_retry_remains_idempotent',true);check('native_input_is_reset_after_current_request',await page.locator('#file').evaluate(input=>input.files.length===0));

 stage='old_restore_new_file';const backup={format:'coconut-library',version:1,...await stored(),active:await page.evaluate(()=>sessionStorage.getItem('coconut-reader-active-v1'))};
 const restore=()=>page.locator('#library-file').setInputFiles({name:'authored-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
 await page.evaluate(()=>{window.importProbe.heldReadName='authored-backup.json';});await restore();await page.waitForFunction(()=>!!window.importProbe.releaseRead);
 await choose('New file after restore');await finished(10);await page.locator('#mode-transcript').click();await page.locator('.note-button').click();await page.locator('#note').fill('Keep the new file note open');
 const afterNewFile=await stored(),newFileNotice=await page.locator('#notice').textContent();await page.evaluate(()=>window.importProbe.releaseRead());await finished(11);
 assert.deepEqual(await stored(),afterNewFile);
 check('stale_restore_cannot_reopen_backup_active',await page.locator('#title').textContent()==='New file after restore');
 check('stale_restore_preserves_new_file_note_and_notice',await page.locator('#notes-panel').isVisible()&&await page.locator('#note').inputValue()==='Keep the new file note open'&&await page.locator('#notice').textContent()===newFileNotice);
 stage='explicit_restore_retry';await restore();await finished(12);const restored=await stored();
 check('uninterrupted_restore_selects_backup_active',await page.locator('#title').textContent()==='Successful retry'&&await page.evaluate(()=>sessionStorage.getItem('coconut-reader-active-v1'))===backup.active);
 check('uninterrupted_restore_keeps_newer_documents_and_notes',restored.documents.length===afterNewFile.documents.length&&restored.documents.find(doc=>doc.title==='New file after restore').notes.cue==='Keep the new file note open');
 await restore();await finished(13);assert.deepEqual(await stored(),restored);check('explicit_restore_retry_remains_idempotent',true);
 stage='downloaded_document_roundtrip';
 await page.locator('#mode-transcript').click();await page.locator('.note-button').click();
 await page.locator('#note').fill('A new note after the original import');await page.locator('#close-note').click();
 await page.locator('#export-menu > summary').click();
 const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#export').click()]);
 const stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);
 const exportedBytes=Buffer.concat(chunks),exported=JSON.parse(exportedBytes.toString('utf8'));
 check('download_contains_current_document_and_notes',exported.title==='Successful retry'&&exported.notes.cue==='A new note after the original import');
 const beforeRoundtrip=await stored();
 await page.locator('#file').setInputFiles({name:download.suggestedFilename(),mimeType:'application/json',buffer:exportedBytes});await finished(14);
 assert.deepEqual(await stored(),beforeRoundtrip);check('actual_download_reimport_reuses_existing_document_without_replacing_work',true);
 check('no_external_requests_mutations_or_page_errors',external===0&&mutations===0&&errors===0);
 console.log(JSON.stringify({suite:'local-file-import-order',status:'passed',checks}));
}catch(error){console.error(JSON.stringify({suite:'local-file-import-order',status:'failed',stage,checks,error:error.message}));process.exitCode=1;}
finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}
