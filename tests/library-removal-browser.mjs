/** Real Chromium acceptance for authored local data; run in browser CI only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {startBridge} from '../desktop/server.mjs';
const fixture=title=>({title,language:'en',readingPosition:'cue',notes:{cue:'Authored private note'},segments:[{id:'cue',start:0,end:3,text:'An authored correction.',original_text:'An authored original.',translations:{zh:{text:'自写译文',provider:'authored-fixture',source_text:'An authored correction.',source_language:'en',document_language:'en'}}}]});
const checks=[],check=(name,condition)=>{assert.ok(condition,name);checks.push(name);};
let server,browser,stage='setup';
try{
 server=await startBridge({port:0});const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block',acceptDownloads:true});let external=0;const errors=[];
 await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===origin||url.protocol==='blob:')await route.continue();else{external++;await route.abort();}});
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);
 const stored=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('coconut-reader-v1')));
 const importDoc=async doc=>{await page.locator('#file').setInputFiles({name:'authored-removal.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc))});await page.waitForFunction(title=>JSON.parse(localStorage.getItem('coconut-reader-v1')||'{"documents":[]}').documents.some(d=>d.title===title),doc.title);};
 const openShelf=async()=>{if(await page.locator('#toggle-library').isVisible()&&await page.locator('#toggle-library').getAttribute('aria-expanded')==='false')await page.locator('#toggle-library').click();};
 const request=async title=>{await openShelf();await page.getByRole('button',{name:'从书架移除 '+title,exact:true}).click();};
 const remove=async title=>{await request(title);await page.locator('#confirm-removal').click();};
 const download=async id=>{const pending=page.waitForEvent('download');await page.locator('#'+id).click();const file=await pending;return JSON.parse(await fs.readFile(await file.path(),'utf8'));};
 const screenshot=async name=>{if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,name+'.png')});}};
 const first=fixture('第一篇自写稿'),second=fixture('第二篇自写稿');await importDoc(first);await importDoc(second);const before=await stored(),original=before.documents.find(d=>d.title===second.title);
 stage='keyboard_cancel_and_confirm';await request(second.title);check('cancel_is_initial_focus',await page.locator('#cancel-removal').evaluate(node=>node===document.activeElement));await page.keyboard.press('Escape');
 check('escape_keeps_complete_shelf',JSON.stringify(await stored())===JSON.stringify(before));check('escape_restores_action_focus',await page.getByRole('button',{name:'从书架移除 '+second.title,exact:true}).evaluate(node=>node===document.activeElement));
 await request(second.title);await page.locator('#confirm-removal').focus();await page.keyboard.press('Enter');
 check('current_removal_persists_smaller_shelf',(await stored()).documents.length===1&&JSON.stringify(await stored()).length<JSON.stringify(before).length);
 check('undo_receives_keyboard_focus',await page.locator('#undo-removal').evaluate(node=>node===document.activeElement));
 check('rescue_download_contains_full_document',JSON.stringify(await download('export-removed-document'))===JSON.stringify(original));
 await page.locator('.library-backup > summary').click();check('whole_library_backup_excludes_removed',(await download('export-library')).documents.every(d=>d.key!==original.key));
 check('mobile_recovery_fits',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await screenshot('library-removal-mobile-recovery');
 await page.locator('#undo-removal').click();assert.deepEqual(await stored(),before);checks.push('undo_persists_original_notes_translations_and_position');
 stage='noncurrent_and_slot_replacement';await remove(first.title);await request(second.title);check('replacement_explains_previous_recovery_loss',(await page.locator('#replace-removal-warning').textContent()).includes(first.title));await screenshot('library-removal-replace-confirmation');await page.locator('#cancel-removal').click();check('cancel_preserves_old_slot',(await download('export-removed-document')).title===first.title);
 await remove(second.title);check('last_document_removed',(await stored()).documents.length===0&&await page.locator('#reader-workspace').isHidden());
 stage='quota_undo_rescue';await page.evaluate(()=>{window.removalOriginalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='coconut-reader-v1')throw new DOMException('Injected quota','QuotaExceededError');return window.removalOriginalSetItem.call(this,key,value);};});await page.locator('#undo-removal').click();
 check('failed_undo_stays_honest',(await stored()).documents.length===0&&(await page.locator('#notice').textContent()).includes('撤销未成功'));check('failed_undo_retains_full_rescue',(await download('export-removed-document')).title===second.title);
 await page.setViewportSize({width:1440,height:960});await screenshot('library-removal-desktop-quota-recovery');await page.evaluate(()=>{Storage.prototype.setItem=window.removalOriginalSetItem;});await page.locator('#undo-removal').click();check('retry_undo_saved',(await stored()).documents.length===1);
 stage='reload_and_download_restore';await remove(second.title);const rescue=await download('export-removed-document');let warned=false;page.once('dialog',async dialog=>{assert.equal(dialog.type(),'beforeunload');warned=true;await dialog.accept();});await page.reload();check('reload_warns_about_memory_recovery',warned);check('reload_does_not_resurrect_removed_content',(await stored()).documents.length===0&&await page.locator('#removal-recovery').isHidden());
 await importDoc(rescue);const restored=(await stored()).documents[0];check('download_can_restore_complete_work',JSON.stringify(restored.segments)===JSON.stringify(original.segments)&&JSON.stringify(restored.notes)===JSON.stringify(original.notes)&&restored.readingPosition===original.readingPosition);
 stage='late_question_after_remove_and_undo';let release,started,requests=0;const requestStarted=new Promise(resolve=>{started=resolve;});
 await page.route('**/api/language-tools',route=>route.fulfill({json:{ai:{codex:{ready:true},claude:{ready:true}}}}));
 await page.route('**/api/ask',async route=>{requests++;await new Promise(resolve=>{release=resolve;started();});await route.fulfill({json:{answer:'Injected late answer',citations:['cue']}});});
 await page.locator('#mode-transcript').click();await page.locator('#language-panel').evaluate(node=>{node.open=true;});await page.locator('#ai-task').selectOption('question');await page.locator('#ai-question').fill('What is this authored sentence?');await page.locator('#check-ai').click();await page.locator('#ai-consent').check();
 await page.locator('#ask-ai').click();let startedTimer;try{await Promise.race([requestStarted,new Promise((_,reject)=>{startedTimer=setTimeout(()=>reject(new Error('Injected question did not start')),15000);})]);}finally{clearTimeout(startedTimer);}const pendingSnapshot=await stored();
 await remove(second.title);await page.locator('#undo-removal').click();assert.equal(requests,1);release();await page.waitForFunction(()=>document.querySelector('#ai-progress').textContent.includes('本次结果未保存'));
 assert.deepEqual(await stored(),pendingSnapshot);checks.push('late_answer_cannot_mutate_restored_document');
 check('no_external_requests_or_page_errors',external===0&&errors.length===0);console.log(JSON.stringify({checks,external,errors}));await context.close();
}catch(error){console.error('Library removal browser stage:',stage);throw error;}
finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}
