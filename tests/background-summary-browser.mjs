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
let bridge,browser,stage='setup',external=0,pageErrors=0,failure=null,releaseBulk=()=>{};
const checks=[];
const check=(name,value,details)=>{stage=name;assert.ok(value,details?name+' '+JSON.stringify(details):name);checks.push(name);};
const report=()=>({suite:'background-summary-authored-http',status:process.exitCode?'failed':'passed',stage,checks,external,pageErrors,failure});
try{
 bridge=await backgroundSummaryBridge();
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1360,height:1000},serviceWorkers:'block'});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  // Production transport except the explicitly labeled archive response
  // fault injection below. No DOM mocks, synthetic click dispatch, or
  // replacement of the product's fetch/storage/task client.
  if(url.origin===bridge.origin||['blob:','data:'].includes(url.protocol))await route.continue();
  else{external++;await route.abort();}
 });
 let page=await context.newPage();page.on('pageerror',()=>pageErrors++);page.setDefaultTimeout(15000);
 await page.goto(bridge.origin);
 async function importSource(title,source=authoredSource(title)){
  stage='import_authored_source';
  await page.locator('#file').setInputFiles({name:'authored-background.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(source))});
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
 stage='archive_completed_task_and_keep_its_original_identity';
 const originalAssociation=await page.evaluate(id=>JSON.parse(localStorage.getItem('coconut-background-summary-v1')).entries.find(entry=>entry.task?.taskId===id),oldDirectoryTask);
 const originalRecord=await bridge.request('/api/v1/tasks/'+oldDirectoryTask+'/export');
 await row(oldDirectoryTask).locator('[data-action="archive"]').click();await expect(row(oldDirectoryTask)).toHaveCount(0);
 await expect(page.locator('#background-archive > summary')).toBeFocused();
 await page.locator('#background-archive > summary').click();
 const archivedRow=()=>page.locator('#background-archive-list .background-task').filter({hasText:oldDirectoryTask});
 await expect(archivedRow().locator('[data-action="restore"]')).toBeVisible();
 await expect(archivedRow().locator('[data-action="accept"]')).toBeDisabled();
 for(const width of [390,1280]){
  await page.setViewportSize({width,height:900});const button=archivedRow().locator('[data-action="export-archive"]');await button.scrollIntoViewIfNeeded();
  check('archive_rescue_actions_reachable_without_overflow_'+width,await button.evaluate(node=>{const rect=node.getBoundingClientRect();return rect.height>=44&&rect.width>=44&&rect.x>=0&&rect.right<=innerWidth;})&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.COCONUT_UI_ARTIFACT_DIR)await page.screenshot({path:path.join(process.env.COCONUT_UI_ARTIFACT_DIR,'background-task-archive-'+width+'.png')});
 }
 const archiveDownloadEvent=page.waitForEvent('download');await archivedRow().locator('[data-action="export-archive"]').click();const archiveDownload=await archiveDownloadEvent;
 assert.match(archiveDownload.suggestedFilename(),/^coconut-task-recovery-.*\.json$/);const archiveBackup=JSON.parse(await fs.readFile(await archiveDownload.path(),'utf8'));
 assert.equal(archiveBackup.format,'coconut-background-task-recovery');for(const key of ['taskId','attemptId','idempotencyKey','inputDigest','snapshot','result'])assert.deepEqual(archiveBackup.record.task[key],originalRecord.record.task[key]);
 assert.equal(archiveBackup.association.key,originalAssociation.key);assert.equal(archiveBackup.association.lifetime,originalAssociation.lifetime);assert.deepEqual(archiveBackup.association.payload,originalAssociation.payload);
 check('archive_download_retains_complete_source_result_and_original_browser_ownership',bridge.invocations.length===6&&(await bridge.tasks()).length===4);
 await bridge.restart();await page.reload();await refresh();await page.locator('#background-archive > summary').click();await expect(archivedRow().locator('[data-action="restore"]')).toBeVisible();
 const retainedAssociation=await page.evaluate(id=>JSON.parse(localStorage.getItem('coconut-background-summary-v1')).entries.find(entry=>entry.task?.taskId===id),oldDirectoryTask);
 assert.equal(retainedAssociation.lifetime,originalAssociation.lifetime);assert.deepEqual(retainedAssociation.payload,originalAssociation.payload);
 await archivedRow().locator('[data-action="restore"]').click();await expect(row(oldDirectoryTask)).toContainText('已接收');await expect(row(oldDirectoryTask).locator('[data-action="archive"]')).toBeFocused();
 await answers(switchedTitle,1);await page.reload();await refresh();await expect(row(oldDirectoryTask)).toContainText('已接收');await answers(switchedTitle,1);
 check('archive_restart_restore_preserves_identity_and_receipt_without_model_retry',bridge.invocations.length===6&&bridge.posts.filter(path=>path==='/api/v1/tasks').length===6&&(await bridge.tasks()).length===5);
 stage='review_selected_terminal_tasks_before_bulk_archive';
 const bulkTasks=(await bridge.tasks()).filter(task=>['succeeded','failed'].includes(task.status)||(task.status==='cancelled'&&task.cancellation?.executionSettled===true)).slice(0,2);
 assert.equal(bulkTasks.length,2);const bulkIds=bulkTasks.map(task=>task.taskId),bulkArchivePosts=()=>bridge.posts.filter(path=>path.endsWith('/archive')).length,postsBeforeBulk=bulkArchivePosts();
 for(const id of bulkIds)await row(id).locator('[data-action="select-archive"]').check();
 await page.locator('#background-bulk-review').click();await expect(page.locator('#background-bulk-items > li')).toHaveCount(2);await expect(page.locator('#background-bulk-confirm')).toHaveText('确认归档这 2 条');
 check('bulk_review_is_explicit_and_no_task_is_archived_before_confirmation',bulkArchivePosts()===postsBeforeBulk);
 for(const width of [390,1280]){
  await page.setViewportSize({width,height:900});const confirm=page.locator('#background-bulk-confirm');await confirm.scrollIntoViewIfNeeded();
  check('bulk_confirm_reachable_without_overflow_'+width,await confirm.evaluate(node=>{const r=node.getBoundingClientRect();return r.height>=44&&r.width>=44&&r.x>=0&&r.right<=innerWidth;})&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.COCONUT_UI_ARTIFACT_DIR)await page.screenshot({path:path.join(process.env.COCONUT_UI_ARTIFACT_DIR,'background-task-bulk-review-'+width+'.png')});
 }
 let bulkStarted=false;const bulkGate=new Promise(resolve=>releaseBulk=resolve);
 const firstArchive='**/api/v1/tasks/'+bulkIds[0]+'/archive';
 await page.route(firstArchive,async route=>{assert.equal(route.request().postDataJSON().protocolVersion,2);const response=await route.fetch();bulkStarted=true;await bulkGate;await route.fulfill({response});});
 await page.locator('#background-bulk-confirm').click();await until(()=>bulkStarted,'First real archive ACK');await page.locator('#background-bulk-cancel').click();releaseBulk();
 await expect(page.locator('#background-bulk-status')).toContainText('已确认归档 1 条，失败或未确认 0 条，未处理 1 条');
 await expect(page.locator('#background-bulk-retry')).toBeVisible();await page.unroute(firstArchive);
 check('bulk_cancel_keeps_the_inflight_success_and_sends_no_remaining_archive',bulkArchivePosts()===postsBeforeBulk+1&&!!(await bridge.task(bulkIds[0])).archivedAt&&!(await bridge.task(bulkIds[1])).archivedAt);
 const secondArchive='**/api/v1/tasks/'+bulkIds[1]+'/archive';await page.route(secondArchive,route=>route.fulfill({status:507,contentType:'application/json',body:JSON.stringify({code:'archive_full',error:'Authored capacity rejection'})}));
 await page.locator('#background-bulk-retry').click();await expect(page.locator('#background-bulk-confirm')).toHaveText('确认归档这 1 条');await page.locator('#background-bulk-confirm').click();
 await expect(page.locator('#background-bulk-status')).toContainText('已确认归档 0 条，失败或未确认 1 条，未处理 0 条');await expect(page.locator('#background-bulk-items')).toContainText('Authored capacity rejection');await page.unroute(secondArchive);
 await page.locator('#background-bulk-retry').click();await expect(page.locator('#background-bulk-items > li')).toHaveCount(1);await expect(page.locator('#background-bulk-confirm')).toHaveText('确认归档这 1 条');await page.locator('#background-bulk-confirm').click();
 await expect(page.locator('#background-bulk-status')).toContainText('已确认归档 1 条，失败或未确认 0 条，未处理 0 条');
 check('bulk_retry_requires_a_new_exact_confirmation_and_never_rearchives_successes',bulkArchivePosts()===postsBeforeBulk+2&&bridge.invocations.length===6&&bridge.posts.filter(path=>path==='/api/v1/tasks').length===6);
 stage='bulk_reload_before_restore';await page.reload();await refresh();await page.locator('#background-archive > summary').click();
 for(const task of bulkTasks){
  stage='bulk_restore_'+task.status+'_'+task.taskId;
  const archived=page.locator('#background-archive-list .background-task').filter({hasText:task.taskId});await expect(archived.locator('[data-action="restore"]')).toBeVisible();await archived.locator('[data-action="restore"]').click();
  // click() does not await moveArchive's asynchronous POST. Wait for this
  // exact task's settled UI receipt before reading the durable HTTP state.
  await expect(row(task.taskId).locator('[data-action="archive"]')).toBeEnabled();
  const restored=await bridge.task(task.taskId);assert.equal(restored.archivedAt,undefined);for(const field of ['taskId','attemptId','inputDigest','document','provider'])assert.deepEqual(restored[field],task[field]);
 }
 check('bulk_results_remain_restorable_after_reload_with_original_identity_and_no_model_retry',bridge.invocations.length===6&&bridge.posts.filter(path=>path==='/api/v1/tasks').length===6);
 stage='checkpoint_resume_multibatch_restart';
 const resumeTitle='Authored checkpoint continuation',resumeSource=authoredSource(resumeTitle),beforeResumeCalls=bridge.invocations.length;
 resumeSource.segments=Array.from({length:401},(_,i)=>({id:'resume-cue-'+i,start:i,end:i+1,text:'Authored checkpoint source '+i}));
 await importSource(resumeTitle,resumeSource);await chooseBackground();await page.locator('#ai-consent').check();await page.locator('#ask-ai').click();await until(()=>bridge.invocations.length===beforeResumeCalls+1);
 const resumeTask=(await bridge.tasks()).at(-1),resumeId=resumeTask.taskId;
 bridge.invocations[beforeResumeCalls].release();await until(()=>bridge.invocations.length===beforeResumeCalls+2);
 await bridge.restart();bridge.invocations[beforeResumeCalls+1].release();await bridge.invocations[beforeResumeCalls+1].settled;
 await page.reload();await refresh();await expect(row(resumeId).locator('[data-action="resume"]')).toBeEnabled();
 check('checkpoint_restart_only_reads_and_retains_one_accepted_batch',bridge.invocations.length===beforeResumeCalls+2&&(await bridge.task(resumeId)).checkpoint.completed===1);
 await row(resumeId).locator('[data-action="resume"]').click();await expect(page.locator('#ai-consent')).not.toBeChecked();await expect(page.locator('#summary-plan')).toContainText('已保存 1 批');await expect(page.locator('#summary-plan')).toContainText('最多 2 次');await expect(page.locator('#ai-send-description')).toContainText('额度可能未知');
 await expect(page.locator('#ai-provider')).toBeDisabled();await expect(page.locator('#ai-model')).toBeDisabled();await expect(page.locator('#ai-consent')).toHaveCount(1);
 for(const width of [390,1280]){
  await page.setViewportSize({width,height:1000});await page.locator('#ask-ai').scrollIntoViewIfNeeded();
  const geometry=await page.locator('#ask-ai').evaluate(node=>{const r=node.getBoundingClientRect();return {height:r.height,x:r.x,right:r.right,viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth};});
  if(process.env.COCONUT_UI_ARTIFACT_DIR)await page.screenshot({path:path.join(process.env.COCONUT_UI_ARTIFACT_DIR,'background-checkpoint-resume-'+width+'.png')});
  check('resume_single_confirmation_reachable_without_overflow_'+width,geometry.height>=44&&geometry.x>=0&&geometry.right<=geometry.viewport&&geometry.scrollWidth<=geometry.viewport,geometry);
 }
 const resumeRoute='**/api/v1/tasks/'+resumeId+'/resume';let acceptedResumeKey;
 await page.route(resumeRoute,async route=>{
  const body=route.request().postDataJSON();acceptedResumeKey=body.resumeKey;
  const durable=await page.evaluate(id=>JSON.parse(localStorage.getItem('coconut-background-summary-v1')).entries.find(entry=>entry.task?.taskId===id)?.resumeIntent,resumeId);
  assert.deepEqual(durable.payload,body);await route.fetch();await route.abort('failed');
 });
 stage='checkpoint_resume_lost_ack';await page.locator('#ai-consent').check();await page.locator('#ask-ai').click();await until(()=>bridge.invocations.length===beforeResumeCalls+3);await expect(page.locator('#background-task-message')).toContainText('续跑结果未确认');await page.unroute(resumeRoute);
 await page.reload();await refresh();await expect(row(resumeId)).toContainText('执行中');
 check('resume_lost_ack_reload_queries_same_key_without_resubmission',bridge.posts.filter(url=>url==='/api/v1/tasks/'+resumeId+'/resume').length===1&&bridge.invocations.length===beforeResumeCalls+3&&await page.evaluate(({id,key})=>JSON.parse(localStorage.getItem('coconut-background-summary-v1')).entries.find(entry=>entry.task?.taskId===id)?.resumeIntent?.receipt?.key===key,{id:resumeId,key:acceptedResumeKey}));
 assert.deepEqual(bridge.invocations[beforeResumeCalls+2].input.transcript.map(cue=>cue.id),['resume-cue-400']);bridge.invocations[beforeResumeCalls+2].release();await until(()=>bridge.invocations.length===beforeResumeCalls+4);assert.deepEqual(bridge.invocations[beforeResumeCalls+3].input.transcript.map(cue=>cue.id),['batch-1','batch-2']);bridge.invocations[beforeResumeCalls+3].release();await bridge.waitTask(resumeId,'succeeded');await refresh();await row(resumeId).locator('[data-action="accept"]').click();await answers(resumeTitle,1);await page.reload();await refresh();await answers(resumeTitle,1);
 check('checkpoint_resume_preserves_task_changes_attempt_and_accepts_once',bridge.invocations.length===beforeResumeCalls+4&&(await bridge.task(resumeId)).attemptId!==resumeTask.attemptId&&(await bridge.task(resumeId)).resume.remainingRequests===0);
 check('authored_private_notes_never_reach_fake_cli',bridge.invocations.every(call=>!JSON.stringify(call.input).includes('LOCAL NOTE')));
 check('no_external_requests_or_page_errors',external===0&&pageErrors===0);
}catch(error){process.exitCode=1;failure={message:String(error?.message||error),stack:error?.stack||null};}
finally{
 releaseBulk();
 try{await browser?.close();await bridge?.close();}catch(error){process.exitCode=1;if(!failure){stage='cleanup';failure={message:String(error?.message||error),stack:error?.stack||null};}}
 const result=report();console.log(JSON.stringify(result));
 if(process.env.COCONUT_UI_ARTIFACT_DIR){await fs.mkdir(process.env.COCONUT_UI_ARTIFACT_DIR,{recursive:true});await fs.writeFile(path.join(process.env.COCONUT_UI_ARTIFACT_DIR,'background-summary-checks.json'),JSON.stringify(result,null,2));}
}
