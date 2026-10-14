/** Authored-only Chromium + real Node SQLite authority-transfer acceptance.
 * No user profiles, external services, models, real media or private artifacts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {startBridge} from '../desktop/server.mjs';
import {openLibraryTools} from './helpers/library-tools-browser.mjs';

const fixture={schema_version:1,key:'authored-canonical',title:'自写迁移验证',language:'en',notes:{cue:'Original authored note'},unknown:{preserve:'exact source'},segments:[{id:'cue',start:0,end:3,text:'An authored migration fixture.',opaque:{preserve:true}}]};
const original=' '+JSON.stringify({documents:[fixture],active:fixture.key})+'\n';
const checks=[],servers=new Set(),contexts=new Set();let browser,directory,stage='setup',external=0,models=0;
const errors=[];
const providers={status:async()=>({ready:false,reason:'Authored acceptance; models disabled'}),ask:async()=>{models++;throw Error('Models disabled');},structured:async()=>{models++;throw Error('Models disabled');},exclusive:async action=>action()};
const check=(name,condition)=>{assert.ok(condition,name);checks.push(name);};
const ready=page=>page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='ready');
const backend=page=>page.evaluate(()=>CoconutStorageBootstrap.result.backend);
async function closeServer(server){servers.delete(server);await new Promise(resolve=>server.close(resolve));}
async function setup(name){
 const libraryDirectory=path.join(directory,name),server=await startBridge({port:0,libraryDirectory,providers});servers.add(server);
 const origin='http://127.0.0.1:'+server.address().port,context=await browser.newContext({acceptDownloads:true,serviceWorkers:'block',viewport:{width:1280,height:900}});contexts.add(context);
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['blob:','data:'].includes(url.protocol))return route.continue();external++;return route.abort();});
 await context.addInitScript(({original})=>{if(localStorage.getItem('coconut-reader-v1')===null)localStorage.setItem('coconut-reader-v1',original);},{original});
 const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);await ready(page);assert.equal(await backend(page),'indexeddb');
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

 stage='interrupted staging cancellation and old-tab fence';const cancelled=await setup('cancelled'),old=await cancelled.context.newPage();old.on('pageerror',error=>errors.push(error.message));await old.goto(cancelled.origin);await ready(old);
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
 const blockedRecovery=await recoveryDownload(happy.page,happy.page.locator('#storage-startup-recovery'));assert.deepEqual(blockedRecovery.stores.documents,happy.source.stores.documents);assert.equal(blockedRecovery.currentLegacyRaw,original);check('real_server_epoch_mismatch_blocks_writable_fallback_and_exports_recovery',true);await capture(happy.page,'canonical-library-epoch-blocked');
 check('no_external_network_or_model_calls',external===0&&models===0);check('no_uncaught_browser_errors',errors.length===0);
 const report={schema_version:1,suite:'canonical-library-browser',status:'passed',browser:'Chromium',storage:'native IndexedDB and real Node SQLite',checks,counts:{externalRequests:external,modelCalls:models,pageErrors:errors.length}};
 if(process.env.COCONUT_UI_SCREENSHOTS)await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'canonical-library-checks.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch(error){
 const report={schema_version:1,suite:'canonical-library-browser',status:'failed',stage,checks,error:error.name,message:String(error.message).split('\n')[0],counts:{externalRequests:external,modelCalls:models,pageErrors:errors.length}};
 if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'canonical-library-checks.json'),JSON.stringify(report,null,2)+'\n');}
 console.error(JSON.stringify(report));process.exitCode=1;
}
finally{for(const context of contexts)await context.close().catch(()=>{});await browser?.close();for(const server of servers)await closeServer(server).catch(()=>{});if(directory)await fs.rm(directory,{recursive:true,force:true});}
