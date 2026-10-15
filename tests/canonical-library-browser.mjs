// Compatibility renderer regression; this suite does not establish default React acceptance.
/** Authored-only Chromium + real Node SQLite authority-transfer acceptance.
 * No user profiles, external services, models, real media or private artifacts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {chromium} from '@playwright/test';
import {startDevelopmentBridge} from '../desktop/dev.mjs';
async function startBridge(options){return (await startDevelopmentBridge({...options,taskDirectory:null})).server;}
import {openLibraryTools} from './helpers/library-tools-browser.mjs';

const fixture={schema_version:1,key:'authored-canonical',title:'自写迁移验证',language:'en',notes:{cue:'Original authored note'},unknown:{preserve:'exact source'},segments:[{id:'cue',start:0,end:3,text:'An authored migration fixture.',opaque:{preserve:true}}]};
const original=' '+JSON.stringify({documents:[fixture],active:fixture.key})+'\n';
const checks=[],servers=new Set(),contexts=new Set();let browser,directory,stage='setup',external=0,models=0;
const errors=[],selectionRequests=[];let allowSelection=false;
const providers={status:async()=>({ready:allowSelection,reason:'Authored acceptance; real models disabled'}),ask:async data=>{if(!allowSelection){models++;throw Error('Models disabled');}selectionRequests.push(data);return {answer:'Authored selected-text explanation.',citations:[data.segments[0].id],provider:'fixture'};},structured:async()=>{models++;throw Error('Models disabled');},exclusive:async action=>action()};
const check=(name,condition)=>{assert.ok(condition,name);checks.push(name);};
const ready=page=>page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='ready');
const backend=page=>page.evaluate(()=>CoconutStorageBootstrap.result.backend);
async function startDevelopmentProcess({port,libraryDirectory}){
 const child=fork(new URL('./fixtures/canonical-development-process.mjs',import.meta.url),[String(port),libraryDirectory],{execArgv:[],stdio:['ignore','pipe','pipe','ipc']});
 let diagnostic='',exited=false;child.stderr.on('data',data=>{diagnostic=(diagnostic+data).slice(-8192);});child.stdout.resume();child.once('exit',()=>{exited=true;});
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill();reject(Error('Authored development process startup timed out: '+diagnostic));},15000);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',code=>{clearTimeout(timer);reject(Error('Authored development process exited before ready ('+code+'): '+diagnostic));});
  child.on('message',message=>{
   if(message.type==='selection-request')selectionRequests.push(message.data);
   if(message.type==='unexpected-model')models++;
   if(message.type==='ready'){
    clearTimeout(timer);resolve({process:child,address:()=>({port:message.port}),close(callback){
     if(exited){callback();return;}
     const deadline=setTimeout(()=>child.kill(),5000);child.once('exit',()=>{clearTimeout(deadline);callback();});
     if(child.connected)child.send('close');else child.kill();
    }});
   }
  });
 });
}
async function closeServer(server){servers.delete(server);await new Promise(resolve=>server.close(resolve));}
async function setup(name){
 const libraryDirectory=path.join(directory,name),server=await (name==='happy'?startDevelopmentProcess({port:0,libraryDirectory}):startBridge({port:0,libraryDirectory,providers}));servers.add(server);
 const origin='http://127.0.0.1:'+server.address().port,context=await browser.newContext({acceptDownloads:true,serviceWorkers:'block',viewport:{width:1280,height:900}});contexts.add(context);
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['blob:','data:'].includes(url.protocol))return route.continue();external++;return route.abort();});
 await context.addInitScript(({original})=>{if(localStorage.getItem('coconut-reader-v1')===null)localStorage.setItem('coconut-reader-v1',original);},{original});
 const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/compatibility.html');await ready(page);assert.equal(await backend(page),'indexeddb');
 assert.equal((await records(origin)).length,0);assert.equal(await marker(page),undefined);checks.push('no_automatic_adoption_'+name);
 const source=await page.evaluate(()=>CoconutStorageBootstrap.storage.readRecovery());
 return {page,context,server,origin,source,name};
}
async function startMigration(page){
 await openLibraryTools(page);const disclosure=page.locator('.library-backup');if(!await disclosure.evaluate(n=>n.open))await disclosure.locator(':scope > summary').click();
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'迁移到此 PC 的统一书架',exact:true}).click();
}
const marker=page=>page.evaluate(async()=> (await CoconutStorageBootstrap.storage.canonicalStatus()).value);
const records=async origin=>(await (await fetch(origin+'/api/v1/library/catalog?protocolVersion=1')).json()).entries;
const record=async origin=>(await (await fetch(origin+'/api/v1/library/document?protocolVersion=1&key='+fixture.key)).json()).record;
async function frozenSource(page){return page.evaluate(async()=>{const copy=await CoconutStorageBootstrap.storage.readRecovery(),migration=copy.stores.meta.find(row=>row.key==='canonical-migration').value;return {snapshot:JSON.parse(migration.text),current:copy,legacy:localStorage.getItem('coconut-reader-v1'),migration};});}
async function capture(page,name){if(!process.env.COCONUT_UI_SCREENSHOTS)return;await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,name+'.png'),fullPage:true});}
async function recoveryDownload(page,button){
 const [file]=await Promise.all([page.waitForEvent('download'),button.click()]);assert.equal(await file.failure(),null);const chunks=[];for await(const chunk of await file.createReadStream())chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
try{
 directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-authored-canonical-'));
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 stage='explicit adoption and durable edit';const happy=await setup('happy');
 await startMigration(happy.page);await happy.page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='ready'&&CoconutStorageBootstrap.result.backend==='canonical');
 check('explicit_user_action_adopts_real_sqlite', (await record(happy.origin)).document.key===fixture.key);
 const frozen=await frozenSource(happy.page);assert.equal(frozen.legacy,original);assert.deepEqual(frozen.snapshot.stores.documents,happy.source.stores.documents);assert.deepEqual(frozen.current.stores.documents,happy.source.stores.documents);assert.equal(frozen.current.stores.meta.find(row=>row.key==='state').value.status,'canonical-frozen');
 check('immutable_browser_source_and_original_localstorage_retained',true);
 await happy.page.reload();await ready(happy.page);assert.equal(await backend(happy.page),'canonical');
 if(await happy.page.locator('#mode-transcript').isVisible())await happy.page.locator('#mode-transcript').click();await happy.page.locator('.note-button').first().click();await happy.page.locator('#note').fill('Edited through actual Chromium canonical reader');
 await happy.page.evaluate(()=>libraryStore.flush());await happy.page.waitForFunction(()=>libraryStore.status().unsaved===0);await happy.page.locator('#close-note').click();
 assert.equal((await record(happy.origin)).document.notes.cue,'Edited through actual Chromium canonical reader');assert.deepEqual((await record(happy.origin)).document.segments[0].opaque,fixture.segments[0].opaque);
 await happy.page.reload();await ready(happy.page);check('canonical_edit_survives_actual_refresh_and_sqlite_readback',await happy.page.evaluate(()=>CoconutStorageBootstrap.result.loaded.documents[0].notes.cue)==='Edited through actual Chromium canonical reader');
 assert.deepEqual((await frozenSource(happy.page)).current.stores.documents,happy.source.stores.documents);
 await openLibraryTools(happy.page);await happy.page.locator('.library-backup > summary').click();const recovery=await recoveryDownload(happy.page,happy.page.getByRole('button',{name:'导出迁移原始恢复文件',exact:true}));assert.equal(recovery.currentLegacyRaw,original);assert.deepEqual(recovery.stores.documents,happy.source.stores.documents);check('real_download_retains_frozen_original_recovery',true);await capture(happy.page,'canonical-library-adopted');


 stage='real import, exact excerpt, consented fake AI and same-library service restart';
 const importedTitle='Authored durable selection journey';
 await happy.page.locator('#file').setInputFiles({name:'joint-authored.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({schema_version:1,title:importedTitle,language:'en',segments:[{id:'joint-cue',start:0,end:4,text:'An authored selection survives a computer service restart.'}]}))});
 await happy.page.waitForFunction(title=>document.getElementById('title').textContent===title&&document.getElementById('file').files.length===0,importedTitle);
 await happy.page.evaluate(()=>libraryStore.flush());await happy.page.waitForFunction(()=>libraryStore.status().unsaved===0);
 const importedKey=await happy.page.evaluate(()=>state.active);
 await happy.page.locator('#mode-passages').click();await happy.page.locator('.passage-quote').first().click();
 await happy.page.locator('#quotation-source').evaluate(text=>{text.focus();text.setSelectionRange(0,11);});await happy.page.locator('#quotation-preview-selection').click();await happy.page.locator('#quotation-save').click();
 await happy.page.waitForFunction(()=>document.getElementById('quotation-save').textContent==='已保存摘录');await happy.page.locator('#quotation-close').click();
 await happy.page.locator('.passage-quote').first().click();await happy.page.locator('#quotation-source').evaluate(text=>{text.focus();text.setSelectionRange(0,11);});await happy.page.locator('#quotation-preview-selection').click();
 await happy.page.locator('#quotation-context-actions').getByRole('button',{name:'解释所选',exact:true}).click();
 assert.equal(await happy.page.locator('#passage-selection-text').textContent(),'An authored');assert.equal(selectionRequests.length,0);assert.equal(await happy.page.locator('#ai-consent').isChecked(),false);
 allowSelection=true;await happy.page.locator('#check-ai').click();await happy.page.locator('#ai-consent').check();await happy.page.locator('#ask-ai').click();
 await happy.page.waitForFunction(key=>state.documents.find(doc=>doc.key===key)?.ai_answers?.length===1,importedKey);
 await happy.page.evaluate(()=>libraryStore.flush());await happy.page.waitForFunction(()=>libraryStore.status().unsaved===0);allowSelection=false;
 assert.equal(selectionRequests.length,1);assert.match(selectionRequests[0].question,/所选原文：\nAn authored\n【所选原文结束】$/);assert.equal(selectionRequests[0].segments.length,1);
 await happy.page.locator('#close-passage-question').click();await happy.page.locator('#mode-transcript').click();await happy.page.locator('.note-button').first().click();await happy.page.locator('#note').fill('Authored joint note retained after process restart');await happy.page.evaluate(()=>libraryStore.flush());await happy.page.waitForFunction(()=>libraryStore.status().unsaved===0);await happy.page.locator('#close-note').click();
 const jointBefore=(await (await fetch(happy.origin+'/api/v1/library/document?protocolVersion=1&key='+encodeURIComponent(importedKey))).json()).record;
 assert.equal(jointBefore.document.exact_excerpts.length,1);assert.equal(jointBefore.document.exact_excerpts[0].text,'An authored');assert.equal(jointBefore.document.exact_excerpts[0].snapshot.from,0);assert.equal(jointBefore.document.exact_excerpts[0].snapshot.to,11);assert.equal(jointBefore.document.ai_answers.length,1);assert.equal(jointBefore.document.notes['joint-cue'],'Authored joint note retained after process restart');
 const servicePort=happy.server.address().port,firstProcess=happy.server.process;await closeServer(happy.server);assert.equal(firstProcess.exitCode,0);happy.server=await startDevelopmentProcess({port:servicePort,libraryDirectory:path.join(directory,happy.name)});servers.add(happy.server);assert.notEqual(happy.server.process.pid,firstProcess.pid);
 await happy.page.reload();await ready(happy.page);assert.equal(await backend(happy.page),'canonical');
 const reloadedJoint=await happy.page.evaluate(key=>CoconutStorageBootstrap.result.loaded.documents.find(doc=>doc.key===key),importedKey);assert.deepEqual(reloadedJoint.ai_answers,jointBefore.document.ai_answers);assert.deepEqual(reloadedJoint.exact_excerpts,jointBefore.document.exact_excerpts);assert.deepEqual(reloadedJoint.notes,jointBefore.document.notes);
 const jointAfter=(await (await fetch(happy.origin+'/api/v1/library/document?protocolVersion=1&key='+encodeURIComponent(importedKey))).json()).record;assert.deepEqual(jointAfter,jointBefore);
 check('import_exact_selection_fake_ai_note_and_excerpt_survive_actual_development_process_restart',true);
 stage='new browser explicit connection and two-client writes';
 async function newBrowser(localDocument){
  const context=await browser.newContext({acceptDownloads:true,serviceWorkers:'block',viewport:{width:1280,height:900}});contexts.add(context);
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===happy.origin||['blob:','data:'].includes(url.protocol))return route.continue();external++;return route.abort();});
  if(localDocument)await context.addInitScript(document=>{if(localStorage.getItem('coconut-reader-v1')===null)localStorage.setItem('coconut-reader-v1',JSON.stringify({documents:[document]}));},localDocument);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(happy.origin+'/compatibility.html');await ready(page);
  assert.equal(await backend(page),'indexeddb');assert.equal(await marker(page),undefined);return {page,context};
 }
 async function clickConnect(page){
  await openLibraryTools(page);const disclosure=page.locator('.library-backup');if(!await disclosure.evaluate(n=>n.open))await disclosure.locator(':scope > summary').click();
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'连接已有电脑书架',exact:true}).click();
 }
 const second=await newBrowser();assert.equal(await second.page.evaluate(()=>CoconutStorageBootstrap.result.loaded.documents.length),0);
 await clickConnect(second.page);await second.page.waitForFunction(()=>CoconutStorageBootstrap.phase==='ready'&&CoconutStorageBootstrap.result.backend==='canonical');
 const reopenedJoint=await second.page.evaluate(key=>CoconutStorageBootstrap.result.loaded.documents.find(doc=>doc.key===key),importedKey);assert.deepEqual(reopenedJoint.ai_answers,jointBefore.document.ai_answers);assert.deepEqual(reopenedJoint.exact_excerpts,jointBefore.document.exact_excerpts);assert.deepEqual(reopenedJoint.notes,jointBefore.document.notes);check('fresh_browser_binding_reads_imported_ai_excerpt_and_note_after_service_restart',true);
 assert.equal((await marker(second.page)).state,'connected');assert.equal(await second.page.evaluate(()=>CoconutStorageBootstrap.result.loaded.documents[0].notes.cue),'Edited through actual Chromium canonical reader');
 await second.page.waitForFunction(title=>document.getElementById('title').textContent===title,fixture.title);
 if(await second.page.locator('#mode-transcript').isVisible())await second.page.locator('#mode-transcript').click();await second.page.locator('.note-button').first().click();await second.page.locator('#note').fill('Independent browser B edit');
 await second.page.evaluate(()=>libraryStore.flush());await second.page.waitForFunction(()=>libraryStore.status().unsaved===0);await second.page.locator('#close-note').click();
 await happy.page.reload();await ready(happy.page);assert.equal(await happy.page.evaluate(()=>CoconutStorageBootstrap.result.loaded.documents[0].notes.cue),'Independent browser B edit');
 await second.page.reload();await ready(second.page);check('independent_browser_connects_and_both_clients_read_same_sqlite_writes',await backend(second.page)==='canonical');
 const localDocument={...fixture,key:'browser-only',title:'Only in browser C'},third=await newBrowser(localDocument),thirdSource=await third.page.evaluate(()=>CoconutStorageBootstrap.storage.readRecovery());
 const oldThird=await third.context.newPage();await oldThird.goto(happy.origin+'/compatibility.html');await ready(oldThird);
 await third.page.evaluate(()=>{const original=CoconutStorageBootstrap.storage;CoconutStorageBootstrap.result.canonical=CoconutCanonicalLibrary.create({primitive:{...original,bindCanonical:async m=>{await original.bindCanonical(m);throw Error('Connection receipt interrupted');}},validate:Coconut.validate});});
 await clickConnect(third.page);await third.page.waitForFunction(()=>CoconutStorageBootstrap.phase==='migration');assert.equal((await marker(third.page)).state,'connected');
 assert.equal(await third.page.getByRole('button',{name:'继续迁移',exact:true}).isVisible(),false);
 await third.page.reload();await ready(third.page);assert.equal(await backend(third.page),'canonical');
 await openLibraryTools(third.page);await third.page.locator('.library-backup > summary').click();const retained=await recoveryDownload(third.page,third.page.getByRole('button',{name:'导出连接前浏览器恢复文件',exact:true}));assert.deepEqual(retained.stores.documents,thirdSource.stores.documents);
 assert.equal((await records(happy.origin)).some(row=>row.key==='browser-only'),false);
 if(await oldThird.locator('#mode-transcript').isVisible())await oldThird.locator('#mode-transcript').click();await oldThird.locator('.note-button').first().click();await oldThird.locator('#note').fill('Old browser C tab');assert.equal((await oldThird.evaluate(()=>libraryStore.flush())).ok,false);
 check('nonempty_browser_source_exported_and_old_tabs_fenced_after_lost_binding_ack',true);
 await second.page.route('**/api/v1/library**',route=>route.abort('failed'));await second.page.reload();await second.page.waitForFunction(()=>CoconutStorageBootstrap.phase==='failed');assert.equal(await second.page.locator('.shell').evaluate(n=>n.inert),true);assert.equal((await marker(second.page)).state,'connected');
 await second.page.unroute('**/api/v1/library**');await second.page.reload();await ready(second.page);check('bound_browser_offline_blocks_writable_fallback_and_recovers_after_refresh',true);

 stage='interrupted staging cancellation and old-tab fence';const cancelled=await setup('cancelled'),old=await cancelled.context.newPage();old.on('pageerror',error=>errors.push(error.message));await old.goto(cancelled.origin+'/compatibility.html');await ready(old);
 await cancelled.page.route('**/api/v1/library/migration',async route=>{if(route.request().method()==='POST'&&route.request().postDataJSON().action==='chunk')return route.abort('failed');return route.continue();});
 await startMigration(cancelled.page);await cancelled.page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='migration');assert.equal((await marker(cancelled.page)).state,'frozen');assert.equal((await records(cancelled.origin)).length,0);
 if(await old.locator('#mode-transcript').isVisible())await old.locator('#mode-transcript').click();await old.locator('.note-button').first().click();await old.locator('#note').fill('Old tab must not overwrite frozen source');const stale=await old.evaluate(()=>libraryStore.flush());assert.equal(stale.ok,false);assert.ok(stale.results.some(result=>result.error?.code==='version'),'old tab must fail the frozen IDB write fence');assert.deepEqual((await frozenSource(cancelled.page)).current.stores.documents,cancelled.source.stores.documents);check('native_idb_transaction_fences_existing_tab',true);
 await cancelled.page.unroute('**/api/v1/library/migration');await cancelled.page.getByRole('button',{name:'确认取消迁移',exact:true}).click();await ready(cancelled.page);assert.equal(await backend(cancelled.page),'indexeddb');assert.equal(await marker(cancelled.page),undefined);assert.equal((await records(cancelled.origin)).length,0);check('confirmed_server_cancel_restores_only_original_browser_authority',true);await cancelled.context.close();contexts.delete(cancelled.context);

 stage='lost finalized response and restart recovery';const lost=await setup('lost-finalize');let dropped=false;
 await lost.page.route('**/api/v1/library/migration',async route=>{if(!dropped&&route.request().method()==='POST'&&route.request().postDataJSON().action==='finalize'){dropped=true;const response=await route.fetch();assert.equal(response.status(),200);await response.dispose();return route.abort('failed');}return route.continue();});
 await startMigration(lost.page);await lost.page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='migration');assert.equal(dropped,true);assert.equal((await marker(lost.page)).state,'frozen');assert.equal((await records(lost.origin)).length,1);
 await lost.page.unroute('**/api/v1/library/migration');await lost.page.reload();await lost.page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='failed');assert.equal(await lost.page.locator('.shell').evaluate(n=>n.inert),true);
 await lost.page.getByRole('button',{name:'继续迁移',exact:true}).click();await lost.page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='ready'&&CoconutStorageBootstrap.result.backend==='canonical');assert.equal((await record(lost.origin)).token.revision,1);check('lost_finalize_response_resumes_committed_receipt_without_duplicate_import',true);await capture(lost.page,'canonical-library-resumed');

 stage='unavailable canonical API cannot admit writable browser fallback';
 await happy.page.route('**/api/v1/library**',route=>route.abort('failed'));await happy.page.reload();await happy.page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='failed');
 assert.equal(await happy.page.locator('.shell').evaluate(n=>n.inert),true);assert.equal((await marker(happy.page)).state,'canonical');assert.deepEqual((await frozenSource(happy.page)).current.stores.documents,happy.source.stores.documents);check('unavailable_canonical_api_never_falls_back_to_browser_writes',true);await happy.page.unroute('**/api/v1/library**');
 stage='same-origin replacement server epoch mismatch';const port=happy.server.address().port;await closeServer(happy.server);const replacement=await startBridge({port,libraryDirectory:path.join(directory,'replacement'),providers});servers.add(replacement);
 await happy.page.reload();await happy.page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='failed');assert.equal(await happy.page.locator('.shell').evaluate(n=>n.inert),true);assert.equal((await marker(happy.page)).state,'canonical');assert.equal((await records(happy.origin)).length,0);
 await second.page.reload();await second.page.waitForFunction(()=>CoconutStorageBootstrap.phase==='failed');assert.equal((await marker(second.page)).state,'connected');assert.equal(await second.page.locator('.shell').evaluate(n=>n.inert),true);check('bound_browser_epoch_replacement_fails_closed',true);
 const blockedRecovery=await recoveryDownload(happy.page,happy.page.locator('#storage-startup-recovery'));assert.deepEqual(blockedRecovery.stores.documents,happy.source.stores.documents);assert.equal(blockedRecovery.currentLegacyRaw,original);check('real_server_epoch_mismatch_blocks_writable_fallback_and_exports_recovery',true);await capture(happy.page,'canonical-library-epoch-blocked');
 check('no_external_network_or_real_model_calls',external===0&&models===0&&selectionRequests.length===1);check('no_uncaught_browser_errors',errors.length===0);
 const report={schema_version:1,suite:'canonical-library-browser',status:'passed',browser:'Chromium',storage:'native IndexedDB and real Node SQLite',checks,counts:{externalRequests:external,modelCalls:models,authoredSelectionCalls:selectionRequests.length,pageErrors:errors.length}};
 if(process.env.COCONUT_UI_SCREENSHOTS)await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'canonical-library-checks.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch(error){
 const report={schema_version:1,suite:'canonical-library-browser',status:'failed',stage,checks,error:error.name,message:String(error.message).split('\n')[0],counts:{externalRequests:external,modelCalls:models,authoredSelectionCalls:selectionRequests.length,pageErrors:errors.length}};
 if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'canonical-library-checks.json'),JSON.stringify(report,null,2)+'\n');}
 console.error(JSON.stringify(report));process.exitCode=1;
}
finally{for(const context of contexts)await context.close().catch(()=>{});await browser?.close();for(const server of servers)await closeServer(server).catch(()=>{});if(directory)await fs.rm(directory,{recursive:true,force:true});}
