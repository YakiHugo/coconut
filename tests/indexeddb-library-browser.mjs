/** GitHub Actions only: native IndexedDB, authored fixtures, no external content or models. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {storageAssertions, waitForPersistedLibrary} from './helpers/browser-storage.mjs';
if(process.env.GITHUB_ACTIONS!=='true')throw new Error('Run this real-browser storage proof in GitHub Actions only.');
const root=new URL('../reader/',import.meta.url),KEY='coconut-reader-v1',NAME='coconut-reader-library-v1';
const fixture=key=>({schema_version:1,key,title:'Storage '+key,language:'en',notes:{},segments:[{id:'one',start:0,end:5,text:'Complete authored storage fixture '+key}],ai_answers:Array.from({length:26},(_,i)=>({question:'Question '+i,answer:'Full answer '+i,citations:['one'],provider:'authored'}))});
const original=' '+JSON.stringify({documents:[fixture('a'),fixture('b')],active:'a'})+'\n';
let server,browser,stage='setup',external=0,mutations=0;const errors=[],checks=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
const ready=page=>page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='ready');
const disk=page=>page.evaluate(()=>readPersistedLibrary());
const flush=async page=>{await page.evaluate(()=>libraryStore.flush());};
const note=async(page,text)=>{if(await page.locator('#mode-transcript').isVisible())await page.locator('#mode-transcript').click();await page.locator('.note-button').first().click();await page.locator('#note').fill(text);};
const download=async(page,selector)=>{const [file]=await Promise.all([page.waitForEvent('download'),page.locator(selector).click()]);assert.equal(await file.failure(),null);const chunks=[];for await(const bytes of await file.createReadStream())chunks.push(bytes);return Buffer.concat(chunks).toString('utf8');};
try{
 server=createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){mutations++;res.writeHead(405).end();return;}
  const filename=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
  if(!/^[a-z-]+\.(html|js|css|png)$/.test(filename)){res.writeHead(404).end();return;}
  try{const bytes=await fs.readFile(new URL(filename,root));res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.png')?'image/png':'text/html'}).end(req.method==='HEAD'?undefined:bytes);}catch{res.writeHead(404).end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});
 async function context({seed=true,broken=false}={}){
  const context=await browser.newContext({acceptDownloads:true,serviceWorkers:'block'});
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||url.protocol==='blob:')return route.continue();external++;return route.abort();});
  await context.addInitScript(storageAssertions);
  await context.addInitScript(({KEY,original,seed,broken})=>{
   if(seed&&localStorage.getItem(KEY)===null)localStorage.setItem(KEY,original);
   if(broken){const open=indexedDB.open.bind(indexedDB);let fail=true;indexedDB.open=(...args)=>{if(fail)throw new DOMException('Authored upgrade refusal','VersionError');return open(...args);};window.allowStorageOpen=()=>{fail=false;};}
   const proof=window.storageProof={writes:[],held:false,pending:[]};
   for(const method of ['put','add','delete']){const original=IDBObjectStore.prototype[method];IDBObjectStore.prototype[method]=function(...args){if(this.transaction.db.name==='coconut-reader-library-v1'&&this.name==='documents')proof.writes.push({method,key:args[1]??args[0]?.key??args[0]});return original.apply(this,args);};}
   let provider;Object.defineProperty(window,'CoconutStorageProvider',{configurable:true,get:()=>provider,set(api){provider=api;const initialize=api.initialize;api.initialize=async options=>{const result=await initialize(options);if(!result.ok)return result;const adapter=result.adapter;return {...result,adapter:{...adapter,write(value,options){if(!proof.held)return adapter.write(value,options);return new Promise(resolve=>proof.pending.push({signal:options.signal,commit:()=>resolve(adapter.write(value,options)),fail:()=>resolve({ok:false,status:'failed',error:{code:'quota'}})}));}}};};}});
  },{KEY,original,seed,broken});
  return context;
 }
 const c=await context(),page=await c.newPage();page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(30000);await page.goto(origin);await ready(page);
 stage='complete migration and exact raw recovery';check('production_backend_is_indexeddb',await page.evaluate(()=>CoconutStorageBootstrap.result.backend==='indexeddb'));
 check('migration_reads_all_original_documents',(await disk(page)).documents.length===2);check('original_localstorage_bytes_never_rewritten',await page.evaluate(key=>localStorage.getItem(key),KEY)===original);
 const snapshot=await page.evaluate(name=>new Promise((resolve,reject)=>{const open=indexedDB.open(name);open.onsuccess=()=>{const db=open.result,tx=db.transaction('legacySnapshots'),request=tx.objectStore('legacySnapshots').get('legacy-v1');tx.oncomplete=()=>{db.close();resolve(request.result.raw);};tx.onabort=()=>reject(tx.error);};}),NAME);assert.equal(snapshot,original);
 await page.locator('.library-backup > summary').click();assert.equal(await download(page,'#export-original-storage'),original);checks.push('original_raw_download_bytes_match');
 stage='dirty-only generation receipt';await page.evaluate(()=>{storageProof.writes.length=0;storageProof.held=true;});await note(page,'First captured note');await page.waitForFunction(()=>storageProof.pending.length===1);
 await page.locator('#note').fill('Newer note while commit waits');check('pending_label_is_not_a_disk_receipt',await page.locator('#save-status').getAttribute('data-state')==='pending'&&!(await disk(page)).documents[0].notes.one);
 await page.evaluate(()=>{storageProof.pending[0].commit();storageProof.held=false;});await flush(page);await page.waitForFunction(()=>document.getElementById('save-status').dataset.state==='saved');
 check('only_dirty_document_is_written',await page.evaluate(()=>storageProof.writes.length>=1&&storageProof.writes.every(item=>item.key==='a')));check('newer_generation_is_durable',(await disk(page)).documents[0].notes.one==='Newer note while commit waits');
 await page.reload();await ready(page);check('actual_reload_reads_indexeddb',(await disk(page)).documents[0].notes.one==='Newer note while commit waits');
 stage='large restore bypasses actual localStorage quota';check('native_localstorage_limit_is_smaller_than_fixture',await page.evaluate(()=>{try{localStorage.setItem('authored-too-large','q'.repeat(12*1024*1024));localStorage.removeItem('authored-too-large');return false;}catch(error){return error.name==='QuotaExceededError';}}));
 const large={...fixture('large'),notes:{one:'完整保留。'.repeat(1200000)}};const backup=JSON.stringify({format:'coconut-library',version:1,documents:[large],active:'large'});
 await page.locator('#library-file').setInputFiles({name:'large-authored-library.json',mimeType:'application/json',buffer:Buffer.from(backup)});
 await waitForPersistedLibrary(page,async()=> (await readPersistedLibrary()).documents.some(doc=>doc.key==='large'),undefined,{timeout:30000});await flush(page);
 check('full_large_document_commits_without_truncation',(await disk(page)).documents.find(doc=>doc.key==='large').notes.one.length===large.notes.one.length);
 await page.reload();await ready(page);check('large_restore_survives_reload',(await disk(page)).documents.find(doc=>doc.key==='large').notes.one.length===large.notes.one.length);
 check('legacy_original_remains_unchanged_after_large_restore',await page.evaluate(key=>localStorage.getItem(key),KEY)===original);
 stage='two real windows preserve distinct keys and fence stale same-key writes';
 const other=await c.newPage();other.on('pageerror',error=>errors.push(error.message));await other.goto(origin);await ready(other);
 const select=async(page,key)=>{await page.locator('.library-entry[data-document-key="'+key+'"] .library-open').click();};
 await select(page,'a');await note(page,'First window A');await flush(page);await select(other,'b');await note(other,'Other window B');await flush(other);
 let saved=await disk(page);check('different_documents_merge_without_clobbering',saved.documents.find(d=>d.key==='a').notes.one==='First window A'&&saved.documents.find(d=>d.key==='b').notes.one==='Other window B');
 await select(other,'a');await note(other,'Stale second window A');await flush(other);check('same_document_compare_and_swap_conflicts',await other.locator('#save-status').getAttribute('data-state')==='failed');
 const rescued=JSON.parse(await download(other,'#export-unsaved-documents'));check('conflict_rescue_keeps_full_transcript_and_history',rescued.documents[0].notes.one==='Stale second window A'&&rescued.documents[0].ai_answers.length===26&&rescued.documents[0].segments[0].text===fixture('a').segments[0].text);
 check('stale_write_never_overwrites_newer_content',(await disk(other)).documents.find(d=>d.key==='a').notes.one==='First window A');
 other.once('dialog',dialog=>dialog.accept());await other.close({runBeforeUnload:true});
 stage='quota failure and explicit retry';await page.evaluate(()=>failContentWrites());await note(page,'Recovery after IDB quota');await flush(page);check('native_idb_failure_retains_unsaved_edit',await page.locator('#save-status').getAttribute('data-state')==='failed');
 const quotaRescue=JSON.parse(await download(page,'#export-unsaved-documents'));assert.equal(quotaRescue.documents[0].notes.one,'Recovery after IDB quota');
 await page.evaluate(()=>restoreContentWrites());await page.locator('#retry-save').click();await page.waitForFunction(()=>document.getElementById('save-status').dataset.state==='saved');await page.reload();await ready(page);check('retry_acknowledges_real_transaction',(await disk(page)).documents.find(d=>d.key==='a').notes.one==='Recovery after IDB quota');
 stage='versionchange closes stale connection and exposes rescue';
 await page.evaluate(name=>{const request=indexedDB.open(name,2);request.onupgradeneeded=()=>{};request.onsuccess=()=>request.result.close();window.upgradeRequest=request;},NAME);
 await page.waitForFunction(()=>document.getElementById('save-status').dataset.state==='failed');await note(page,'Keep after version change');await flush(page);check('versionchange_does_not_claim_saved',await page.locator('#save-status').getAttribute('data-state')==='failed');check('versionchange_keeps_export_visible',await page.locator('#export-unsaved-documents').isVisible());
 await c.close();
 stage='failed bootstrap retry and native no-edit quit';const broken=await context({broken:true}),failed=await broken.newPage();await failed.goto(origin);await failed.waitForFunction(()=>CoconutStorageBootstrap.phase==='failed');
 check('startup_failure_has_retry_and_no_half_ready_editor',await failed.locator('#storage-startup-retry').isVisible()&&await failed.evaluate(()=>document.querySelector('.shell').inert));
 check('failed_startup_can_safely_close',await failed.evaluate(()=>coconutPrepareClose('safe',{id:1,kind:'close',expiresAt:Date.now()+10000})));
 await failed.evaluate(()=>{coconutPrepareClose('release',{id:1,kind:'close'});allowStorageOpen();});await failed.locator('#storage-startup-retry').click();await ready(failed);check('explicit_retry_loads_entire_original_library',(await disk(failed)).documents.length===2);await broken.close();
 check('no_model_external_writes_or_page_errors',external===0&&mutations===0&&errors.length===0);console.log(JSON.stringify({ok:true,checks,errors},null,2));
}catch(error){throw new Error(stage+': '+error.message,{cause:error});}
finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}
