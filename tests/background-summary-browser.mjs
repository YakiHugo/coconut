/** CI-only real Chromium + production HTTP/task ledger/CLI adapter. Authored
 * sources and injected CLI replies only; no real account or model is contacted.
 * CPU harness contracts can run separately without launching a browser. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect,waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {openLibraryTools} from './helpers/library-tools-browser.mjs';
import {openCueActions} from './cue-actions-browser.mjs';
import {backgroundSummaryBridge,authoredSource,until} from './helpers/background-summary-bridge.mjs';
if(process.env.GITHUB_ACTIONS!=='true')throw new Error('Run this real Chromium journey in GitHub Actions only.');
let bridge,browser,stage='setup',external=0,pageErrors=0;
const checks=[];
const check=(name,value)=>{stage=name;assert.ok(value,name);checks.push(name);};
const report=()=>({suite:'background-summary-authored-http',status:process.exitCode?'failed':'passed',stage,checks,external,pageErrors});
try{
 bridge=await backgroundSummaryBridge();
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1360,height:1000},serviceWorkers:'block'});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  // Transport is real. No page.route fulfillment, DOM mocks, synthetic click
  // dispatch, or replacement of the product's fetch/storage/task client.
  if(url.origin===bridge.origin||['blob:','data:'].includes(url.protocol))await route.continue();
  else{external++;await route.abort();}
 });
 let page=await context.newPage();page.on('pageerror',()=>pageErrors++);page.setDefaultTimeout(15000);
 await page.goto(bridge.origin);
 async function importSource(title){
  stage='import_authored_source';
  await page.locator('#file').setInputFiles({name:'authored-background.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(authoredSource(title)))});
  await expect(page.locator('#title')).toHaveText(title);
  await waitForPersistedLibrary(page,async title=>(await readPersistedLibrary()).documents.some(doc=>doc.title===title),title);
 }
 async function openTasks(){
  await openLibraryTools(page);
  if(!await page.locator('#background-tasks').evaluate(node=>node.open))await page.locator('#background-tasks > summary').click();
  await expect(page.locator('#background-refresh')).toBeVisible();
 }
 async function refresh(){await openTasks();await page.locator('#background-refresh').click();}
 async function chooseBackground(){
  stage='choose_explicit_background_mode';
  await page.locator('#mode-summary').click();await page.locator('#prepare-summary').click();
  await page.locator('#summary-execution').selectOption('background');
  await expect(page.locator('#ask-ai')).toBeEnabled();
  await expect(page.locator('#summary-background-status')).toContainText('已连接此电脑');
  await expect(page.locator('#ai-consent')).not.toBeChecked();
 }
 async function submit(count,taskCount=count){
  stage='explicit_background_submission';
  await page.locator('#ai-consent').check();await page.locator('#ask-ai').click();
  await until(()=>bridge.invocations.length===count,'Fake CLI call');
  await expect(page.locator('#ask-ai')).toBeEnabled();
  const tasks=await bridge.tasks();assert.equal(tasks.length,taskCount);return tasks.at(-1).taskId;
 }
 const row=id=>page.locator('#background-task-list .background-task').filter({hasText:id});
 async function answers(title,count){
  await waitForPersistedLibrary(page,async({title,count})=>{const doc=(await readPersistedLibrary()).documents.find(doc=>doc.title===title);return !!doc&&(doc.ai_answers||[]).length===count;},{title,count});
 }
 async function openSource(title){
  await openLibraryTools(page);await page.locator('#library .library-open').filter({has:page.locator('.library-title',{hasText:title})}).click();
  await expect(page.locator('#title')).toHaveText(title);
 }

 const original='Authored background original',other='Authored other document';
 await importSource(original);await page.locator('#mode-summary').click();await page.locator('#prepare-summary').click();
 check('foreground_is_default_and_opening_sends_nothing',await page.locator('#summary-execution').inputValue()==='foreground'&&bridge.posts.length===0);
 await page.locator('#summary-execution').selectOption('background');await expect(page.locator('#ask-ai')).toBeEnabled();
 await page.locator('#ask-ai').click();check('background_requires_the_single_explicit_consent',bridge.posts.length===0&&bridge.invocations.length===0);
 await expect(page.locator('#ai-consent-copy')).toContainText('收起或离页后继续');
 const first=await submit(1);
 // A second real user submission of the same active source must be rejected
 // before transport, as well as the executor's independently tested idempotency.
 await page.locator('#ai-consent').check();await page.locator('#ask-ai').click();
 await expect(page.locator('#background-task-message')).toContainText('已有相同范围');
 check('repeat_submission_is_one_durable_task_and_cli_call',(await bridge.tasks()).length===1&&bridge.invocations.length===1&&bridge.posts.filter(path=>path==='/api/v1/tasks').length===1);
 stage='compact_task_entry_preserves_reading_space_and_status';await page.setViewportSize({width:320,height:568});
 await page.waitForFunction(()=>!document.getElementById('library-tools').hidden&&document.getElementById('background-tasks').parentElement.id==='library-tools-content');
 if(await page.locator('#toggle-library').getAttribute('aria-expanded')==='false')await page.locator('#toggle-library').click();
 await expect(page.locator('#library-background-task-status')).toBeVisible();await expect(page.locator('#library-background-task-status')).toContainText('进行中 1');
 check('compact_collapsed_tools_keep_running_task_discoverable',!await page.locator('#library-tools').evaluate(node=>node.open)&&await page.locator('#library-tools > summary').evaluate(node=>node.getBoundingClientRect().height>=44)&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.locator('#toggle-library').click();await page.locator('#summary-open-background-tasks').click();
 await expect(page.locator('#background-refresh')).toBeVisible();
 check('compact_summary_shortcut_opens_real_task_ancestors_and_focus',await page.evaluate(()=>document.getElementById('library-tools').open&&document.getElementById('background-tasks').open&&document.activeElement===document.querySelector('#background-tasks > summary'))&&await page.locator('#background-tasks > summary').evaluate(node=>node.getBoundingClientRect().height>=44));
 await page.setViewportSize({width:1360,height:1000});
 await page.waitForFunction(()=>document.getElementById('library-tools').hidden&&document.getElementById('background-tasks').parentElement.id==='library-list');
 check('wide_task_entry_restores_focus_without_resubmitting',await page.locator('#background-tasks > summary').evaluate(node=>node===document.activeElement)&&bridge.invocations.length===1&&bridge.posts.filter(path=>path==='/api/v1/tasks').length===1);
 await page.locator('#close-summary-request').click();await page.reload();await refresh();
 await expect(row(first)).toContainText('执行中');
 const firstSubmissionKey=await row(first).getAttribute('data-submission-key');assert.ok(firstSubmissionKey);
 check('panel_close_and_reload_keep_task_without_cancelling',bridge.invocations.length===1&&!bridge.invocations[0].signal.aborted&&bridge.posts.every(path=>!path.endsWith('/cancel')));

 stage='disconnect_and_switch_document';await context.setOffline(true);await refresh();
 await expect(page.locator('#background-executor-status')).toContainText('暂时不可用');
 await importSource(other);await answers(original,0);await answers(other,0);
 // Close the only actual page while the fake CLI is still held. Keep the
 // browser context (the user's browser profile), not a hidden reader tab.
 stage='close_only_reader_while_task_pending';await page.close();
 check('closed_page_leaves_task_running_without_reader',page.isClosed()&&context.pages().length===0&&(await bridge.task(first)).status==='running'&&!bridge.invocations[0].signal.aborted);
 bridge.invocations[0].release();await bridge.waitTask(first,'succeeded');
 check('server_finishes_task_with_zero_open_pages',context.pages().length===0&&bridge.invocations.length===1&&bridge.posts.every(path=>!path.endsWith('/cancel')));
 // No copied page state, synthetic journal, consent, or resubmission: a new
 // page must recover the original durable association from this same origin.
 stage='new_page_recovers_original_submission';await context.setOffline(false);
 page=await context.newPage();page.on('pageerror',()=>pageErrors++);page.setDefaultTimeout(15000);
 await page.goto(bridge.origin);await refresh();await expect(row(first)).toContainText('已完成');
 await answers(original,0);await answers(other,0);
 check('offline_late_completion_does_not_write_any_document',bridge.invocations.length===1);
 check('new_page_recovers_same_task_without_post_or_auto_accept',await row(first).getAttribute('data-submission-key')===firstSubmissionKey&&bridge.posts.filter(path=>path==='/api/v1/tasks').length===1&&bridge.invocations.length===1);
 await openSource(other);await refresh();
 await expect(row(first).locator('[data-action="accept"]')).toBeDisabled();
 check('wrong_document_cannot_receive_result',await page.locator('#title').textContent()===other);
 await openSource(original);await refresh();await expect(row(first).locator('[data-action="accept"]')).toBeEnabled();
 await row(first).locator('details > summary').click();await expect(row(first).locator('.background-result')).toContainText('Authored background result');
 await answers(original,0);stage='explicit_receive_once';await row(first).locator('[data-action="accept"]').click();
 await answers(original,1);await answers(other,0);await expect(row(first).locator('[data-action="accept"]')).toBeDisabled();
 await page.reload();await refresh();await expect(row(first)).toContainText('已接收');await answers(original,1);
 check('explicit_accept_is_persisted_once_across_reload',bridge.invocations.length===1);

 const cancelledTitle='Authored cancellation';await importSource(cancelledTitle);await chooseBackground();const cancelled=await submit(2);
 await page.locator('#close-summary-request').click();await openTasks();stage='explicit_cancellation';
 await row(cancelled).locator('[data-action="cancel"]').click();await bridge.waitTask(cancelled,'cancel_requested');
 check('cancel_reaches_real_executor_abort',bridge.invocations[1].signal.aborted);
 bridge.invocations[1].release();const cancelledTask=await bridge.waitTask(cancelled,'cancelled');await refresh();
 await expect(row(cancelled)).toContainText('已取消');await expect(row(cancelled).locator('[data-action="accept"]')).toHaveCount(0);
 await page.reload();await refresh();await answers(cancelledTitle,0);
 check('late_cancelled_result_is_discarded_and_reload_never_retries',!cancelledTask.result&&bridge.invocations.length===2);

 const restartTitle='Authored executor restart';await importSource(restartTitle);await chooseBackground();const interrupted=await submit(3);
 stage='restart_actual_bridge_same_origin';await bridge.restart();bridge.invocations[2].release();await bridge.invocations[2].settled;
 await page.reload();await refresh();await expect(row(interrupted)).toContainText('中断，不会自动重跑');await answers(restartTitle,0);
 check('real_executor_restart_recovers_interrupted_without_retry',(await bridge.task(interrupted)).status==='interrupted'&&bridge.invocations.length===3);

 const editedTitle='Authored changed source';await importSource(editedTitle);await chooseBackground();const edited=await submit(4);
 await page.locator('#close-summary-request').click();await page.locator('#mode-transcript').click();
 stage='native_source_edit_before_late_result';await openCueActions(page.locator('.segment').first());
 await page.locator('.segment .edit-button').first().click();await page.locator('#edit-segment').fill('Authored replacement source must never be overwritten.');await page.locator('#save-edit').click();
 await waitForPersistedLibrary(page,async title=>(await readPersistedLibrary()).documents.find(doc=>doc.title===title)?.segments[0].text==='Authored replacement source must never be overwritten.',editedTitle);
 bridge.invocations[3].release();await bridge.waitTask(edited,'succeeded');await refresh();
 await expect(row(edited).locator('[data-action="accept"]')).toBeDisabled();await answers(editedTitle,0);
 await page.reload();await refresh();await expect(row(edited).locator('[data-action="accept"]')).toBeDisabled();
 check('edited_source_stays_saved_and_cannot_receive_old_result',bridge.invocations.length===4);
 // A genuinely new browser profile has neither manuscript lifetimes nor the
 // submission journal. The same executor still owns the completed receipts.
 const associatedPage=page;
 stage='fresh_browser_rescues_unassociated_result';
 const rescueContext=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block',acceptDownloads:true});
 await rescueContext.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===bridge.origin||['blob:','data:'].includes(url.protocol))await route.continue();else{external++;await route.abort();}});
 page=await rescueContext.newPage();page.on('pageerror',()=>pageErrors++);page.setDefaultTimeout(15000);await page.goto(bridge.origin);
 const rescueTitle='Authored unrelated rescue document';await importSource(rescueTitle);await refresh();
 await expect(row(first).locator('[data-action="view-result"]')).toBeVisible();await expect(row(first).locator('[data-action="accept"]')).toHaveCount(0);
 await row(first).locator('[data-action="view-result"]').click();await expect(row(first).locator('.background-result')).toBeVisible();await expect(row(first).locator('.background-result')).toContainText('Authored background result');
 await expect(row(first).locator('.background-source').first()).toContainText(authoredSource(original).segments[0].text);
 check('unassociated_result_opens_and_receives_focus_without_adopting_document',await row(first).locator('details').evaluate(node=>node.open&&node.querySelector('summary')===document.activeElement));
 for(const width of [390,1280]){
  await page.setViewportSize({width,height:900});await openTasks();const button=row(first).locator('[data-action="export-result"]');await button.scrollIntoViewIfNeeded();
  check('rescue_download_remains_reachable_without_overflow_'+width,await button.evaluate(node=>{const rect=node.getBoundingClientRect();return rect.height>=44&&rect.width>=44&&rect.x>=0&&rect.right<=innerWidth;})&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.COCONUT_UI_ARTIFACT_DIR){await fs.mkdir(process.env.COCONUT_UI_ARTIFACT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_ARTIFACT_DIR,'background-result-rescue-'+width+'.png')});}
 }
 const savedDownload=page.waitForEvent('download');await row(first).locator('[data-action="export-result"]').click();const download=await savedDownload;
 assert.match(download.suggestedFilename(),/^coconut-summary-.*\.json$/);const recovered=JSON.parse(await fs.readFile(await download.path(),'utf8'));
 assert.equal(recovered.format,'coconut-background-summary-result');assert.equal(recovered.task.taskId,first);assert.equal(recovered.result.answer,(await bridge.task(first)).result.answer);assert.deepEqual(recovered.result.input_snapshot,(await bridge.task(first)).result.input_snapshot);assert.equal(recovered.segments,undefined);assert.equal(recovered.documents,undefined);
 await answers(rescueTitle,0);await expect(page.locator('#background-task-message')).toContainText('请确认文件已保存');
 check('native_result_download_retains_complete_source_without_restoring_ownership',await page.evaluate(()=>JSON.parse(localStorage.getItem('coconut-background-summary-v1')).entries.length===0)&&bridge.invocations.length===4);
 await page.reload();await refresh();await expect(row(first).locator('[data-action="view-result"]')).toBeVisible();await expect(row(first).locator('[data-action="accept"]')).toHaveCount(0);await answers(rescueTitle,0);
 check('independent_rescue_does_not_create_association_on_reload',bridge.invocations.length===4);
 check('no_duplicate_submission_or_hidden_foreground_calls',bridge.posts.filter(path=>path==='/api/v1/tasks').length===4&&bridge.posts.filter(path=>path.endsWith('/cancel')).length===1&&bridge.posts.every(path=>path==='/api/v1/tasks'||path.endsWith('/cancel')));
 // The actual same-origin reader profile retains old acknowledgements while
 // the bridge moves between independent disk ledgers, as source/dev modes do.
 stage='same_origin_different_task_directory';page=associatedPage;
 const switchedTitle='Authored executor directory switch';await importSource(switchedTitle);await chooseBackground();const oldDirectoryTask=await submit(5);
 bridge.invocations[4].release();await bridge.waitTask(oldDirectoryTask,'succeeded');await page.locator('#close-summary-request').click();await refresh();await answers(switchedTitle,0);
 const originBeforeSwitch=bridge.origin;await bridge.switchTaskDirectory('alternate');assert.equal(bridge.origin,originBeforeSwitch);
 const oldLookup=await bridge.request('/api/v1/tasks/'+oldDirectoryTask);assert.equal(oldLookup.status,404);assert.equal(oldLookup.code,'not_found');
 await page.reload();await refresh();await expect(row(oldDirectoryTask)).toContainText('此执行器找不到此任务');await expect(page.locator('#background-executor-status')).toContainText('已连接此电脑');
 await expect(row(oldDirectoryTask).locator('[data-action="resubmit"]')).toHaveCount(0);await expect(row(oldDirectoryTask).locator('[data-action="accept"]')).toHaveCount(0);
 check('missing_old_task_isolated_without_resending_or_disabling_new_executor',bridge.invocations.length===5&&bridge.posts.filter(path=>path==='/api/v1/tasks').length===5&&(await bridge.tasks()).length===0);
 await page.setViewportSize({width:390,height:844});await openTasks();await row(oldDirectoryTask).scrollIntoViewIfNeeded();
 check('missing_task_status_remains_readable_in_compact_library',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 if(process.env.COCONUT_UI_ARTIFACT_DIR)await page.screenshot({path:path.join(process.env.COCONUT_UI_ARTIFACT_DIR,'background-executor-directory-switch-390.png')});
 await page.setViewportSize({width:1360,height:1000});await chooseBackground();await page.locator('#ask-ai').click();
 check('new_executor_still_requires_explicit_fresh_consent',bridge.invocations.length===5&&bridge.posts.filter(path=>path==='/api/v1/tasks').length===5);
 const newDirectoryTask=await submit(6,1);assert.notEqual(newDirectoryTask,oldDirectoryTask);bridge.invocations[5].release();await bridge.waitTask(newDirectoryTask,'succeeded');await page.locator('#close-summary-request').click();await refresh();
 await expect(row(newDirectoryTask)).toContainText('已完成');await expect(row(newDirectoryTask).locator('[data-action="accept"]')).toBeEnabled();await expect(row(oldDirectoryTask).locator('[data-action="accept"]')).toHaveCount(0);await answers(switchedTitle,0);
 check('explicit_new_task_does_not_replace_old_task_identity',await row(newDirectoryTask).getAttribute('data-submission-key')!==await row(oldDirectoryTask).getAttribute('data-submission-key')&&bridge.invocations.length===6);
 await bridge.switchTaskDirectory('original');await page.reload();await refresh();await expect(row(newDirectoryTask)).toContainText('此执行器找不到此任务');await expect(row(oldDirectoryTask).locator('[data-action="accept"]')).toBeEnabled();
 await row(oldDirectoryTask).locator('[data-action="accept"]').click();await answers(switchedTitle,1);await page.reload();await refresh();await answers(switchedTitle,1);await expect(row(oldDirectoryTask)).toContainText('已接收');
 await waitForPersistedLibrary(page,async({title,taskId})=>{const receipts=(await readPersistedLibrary()).documents.find(doc=>doc.title===title)?.background_summary_receipts;return Array.isArray(receipts)&&receipts.length===1&&receipts[0]===taskId;},{title:switchedTitle,taskId:oldDirectoryTask});
 check('returning_to_original_directory_recovers_exact_result_once_without_model_retry',bridge.invocations.length===6&&bridge.posts.filter(path=>path==='/api/v1/tasks').length===6&&bridge.posts.filter(path=>path.endsWith('/cancel')).length===1&&(await bridge.tasks()).length===5);
 check('authored_private_notes_never_reach_fake_cli',bridge.invocations.every(call=>!JSON.stringify(call.input).includes('LOCAL NOTE')));
 check('no_external_requests_or_page_errors',external===0&&pageErrors===0);
}catch{process.exitCode=1;}
finally{
 try{await browser?.close();await bridge?.close();}catch{process.exitCode=1;stage='cleanup';}
 const result=report();console.log(JSON.stringify(result));
 if(process.env.COCONUT_UI_ARTIFACT_DIR){await fs.mkdir(process.env.COCONUT_UI_ARTIFACT_DIR,{recursive:true});await fs.writeFile(path.join(process.env.COCONUT_UI_ARTIFACT_DIR,'background-summary-checks.json'),JSON.stringify(result,null,2));}
}
