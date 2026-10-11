import {installSelectedBackupWriteProbe} from './helpers/selected-backup-write-probe.mjs';
import {openLibraryTools} from './helpers/library-tools-browser.mjs';
/** GitHub browser-CI-only proof: authored files, real downloads/pickers and
 * native storage quota. No AI, remote media, traces or private artifacts. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from './helpers/legacy-browser.mjs';
import {MiB,annotatedDocument,chineseDocument,oversizedDocument} from './helpers/backup-fixtures.mjs';

const root=new URL('../reader/',import.meta.url),KEY='coconut-reader-v1';
const checks=[];let browser,server,directory,page,stage='setup',external=0,mutations=0,errors=0;
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
const digest=value=>createHash('sha256').update(value).digest('hex');
try{
 directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-backup-proof-'));
 server=createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){mutations++;res.writeHead(405).end();return;}
  const filename=new URL(req.url,'http://localhost').pathname.replace(/^\//,'')||'index.html';
  if(!/^[a-z-]+\.(html|js|css|webmanifest|png)$/.test(filename)){res.writeHead(404,{'Content-Type':'application/json'}).end('{"error":"static only"}');return;}
  try{const body=await fs.readFile(new URL(filename,root));res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.png')?'image/png':'text/html'}).end(body);}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 async function newPage({holdableWriter=false}={}){
  const context=await browser.newContext({acceptDownloads:true,serviceWorkers:'block'});
  await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===origin||['blob:','data:'].includes(url.protocol))await route.continue();else{external++;await route.abort();}});
  if(holdableWriter)await context.route('**/library-store.js*',async route=>{
   const response=await route.fetch(),body=await response.text();
   await route.fulfill({response,body:body+'\n;('+installSelectedBackupWriteProbe.toString()+')(window);'});
  });
  const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',()=>errors++);
  await page.addInitScript(()=>{const read=File.prototype.text;window.backupProbe={reads:0,started:0,finished:0,dialogCloses:0};File.prototype.text=function(){window.backupProbe.reads++;return read.call(this);};});
  await page.goto(origin);await page.locator('#sample').waitFor();
  await page.evaluate(()=>{for(const id of ['file','library-file','project-transcript-file']){const input=document.getElementById(id),handler=input.onchange;input.onchange=async function(event){window.backupProbe.started++;try{await handler.call(this,event);}finally{window.backupProbe.finished++;}};}document.getElementById('large-backup-dialog').addEventListener('close',()=>{window.backupProbe.dialogCloses++;});});
  return page;
 }
 const write=async(name,value)=>{const file=path.join(directory,name);await fs.writeFile(file,JSON.stringify(value));return file;};
 const finished=(page,count)=>page.waitForFunction(count=>window.backupProbe.finished===count,count);
 const disk = async page => {await page.evaluate(()=>libraryStore.flush());return page.evaluate(key=>localStorage.getItem(key),KEY);};
 async function download(page,id,name){
  const shelfDownload=id==='export-library'||id==='export-selected-library';
  if(shelfDownload)await openLibraryTools(page);
  const details=page.locator(id==='export'?'#export-menu':id==='export-selected-library'?'#library-options':'details.library-backup');
  if(shelfDownload&&!await details.isVisible()){
   const toggle=page.locator('#toggle-library');
   if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')==='false')await toggle.click();
  }
  if(!await details.evaluate(element=>element.open))await details.locator(':scope > summary').click();
  const [item]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);
  if(id==='export-selected-library')assert.equal(item.suggestedFilename(),'coconut-selected-library.json');
  const file=path.join(directory,name);await item.saveAs(file);assert.equal(await item.failure(),null);return file;
 }

 stage='selected rich-document actual download';page=await newPage({holdableWriter:true});
 const localMedia={version:1,kind:'audio',name:'Authored selected recording.wav',size:1024,last_modified:7,type:'audio/wav',fingerprint:'a'.repeat(64)};
 const rich=await page.evaluate(input=>{
  const doc={...Coconut.validate(input),key:input.key},cue=doc.segments[0];
  Coconut.saveManualTranslation(doc,cue,'zh','自写人工核对译文',Coconut.manualReviewSnapshot(doc,cue,'zh'),JSON.stringify(cue.translations.zh));
  doc.exact_excerpts=[Coconut.exactExcerptSnapshot(doc,doc.segments,[],0,doc.segments[0].text.length,{id:'selected-exact-quote',createdAt:'2026-10-11T01:00:00.000Z'})];
  doc.exact_excerpt_notes={'selected-exact-quote':'Authored note on the complete captured source'};return doc;
 },{...annotatedDocument('Authored selected complete record'),key:'selected-rich',local_media_source:localMedia,media_duration:241,project_note:'Authored complete project note',timestamp_bookmarks:[{id:'rich-bookmark',time:2,note:'Keep this authored time bookmark'}]});
 const audio={key:'selected-audio',project_kind:'audio_only',title:'Authored selected audio-only record',segments:[],local_media_source:{...localMedia,name:'Authored audio-only recording.wav',fingerprint:'b'.repeat(64)},media_duration:241,project_note:'Keep the complete audio-only project note',timestamp_bookmarks:[{id:'audio-bookmark',time:37,note:'Authored audio bookmark 中文'}]};
 const excluded={...annotatedDocument('Authored unselected private record'),key:'selected-excluded'};
 const selectionFixture=await write('selected-fixture.json',{format:'coconut-library',version:1,documents:[rich,excluded,audio],active:excluded.key});
 await page.locator('#library-file').setInputFiles(selectionFixture);await finished(page,1);
 const originalSelection=JSON.parse(await disk(page));
 await openLibraryTools(page);await page.locator('#library-options > summary').click();await page.locator('#library-selection-mode').click();
 // Choose in reverse shelf order. Export order is deterministic, never click order.
 await page.locator('.library-entry[data-document-key="selected-audio"] .library-select').check();
 await page.locator('.library-entry[data-document-key="selected-rich"] .library-select').check();
 const selectedFile=await download(page,'export-selected-library','selected-complete-library.json');
 const selectedText=await fs.readFile(selectedFile,'utf8'),selectedBackup=JSON.parse(selectedText);
 assert.equal(selectedBackup.format,'coconut-library');assert.equal(selectedBackup.version,1);
 assert.deepEqual(selectedBackup.documents,originalSelection.documents.filter(doc=>doc.key!==excluded.key));
 check('actual_selected_json_is_complete_and_excludes_unselected_documents',selectedBackup.documents.length===2&&selectedBackup.active===rich.key&&!selectedText.includes(excluded.title));
 const richBackup=selectedBackup.documents[0],audioBackup=selectedBackup.documents[1];
 check('selected_json_preserves_original_correction_notes_translation_context_and_ai_evidence',richBackup.readingPosition==='cue'&&richBackup.segments[0].original_text==='Authored original words'&&richBackup.segments[0].saved_excerpt===true&&richBackup.notes.cue==='Keep this private note'&&richBackup.segments[0].translations.zh.text==='自写人工核对译文'&&Object.keys(richBackup.translation_contexts).length===1&&richBackup.ai_answers[0].input_snapshot.segments[0].text==='Authored source words');
 assert.deepEqual(richBackup.segments[0].translations.zh,rich.segments[0].translations.zh);assert.deepEqual(richBackup.translation_glossary,rich.translation_glossary);
 check('selected_json_preserves_manual_translation_review_and_original_version',richBackup.segments[0].translations.zh.original_translation.text==='自写测试译文'&&richBackup.segments[0].translations.zh.manual_review.previous_text==='自写测试译文'&&richBackup.segments[0].translations.zh.manual_review.cues[0].text==='Authored source words');
 assert.deepEqual(richBackup.exact_excerpts,rich.exact_excerpts);assert.deepEqual(richBackup.exact_excerpt_notes,rich.exact_excerpt_notes);
 check('selected_json_preserves_exact_excerpts_and_project_metadata_without_media_bytes',richBackup.local_media_source.name===localMedia.name&&richBackup.timestamp_bookmarks[0].note==='Keep this authored time bookmark'&&audioBackup.project_kind==='audio_only'&&audioBackup.segments.length===0&&audioBackup.project_note===audio.project_note&&audioBackup.timestamp_bookmarks[0].note===audio.timestamp_bookmarks[0].note&&!selectedText.includes('blob:'));
 const sourcePage=page;

 stage='selected actual download fresh restore';page=await newPage();
 check('selected_restore_starts_in_fresh_browser_storage',await disk(page)===null);
 await page.locator('#library-file').setInputFiles(selectedFile);await finished(page,1);
 assert.deepEqual(JSON.parse(await disk(page)).documents,selectedBackup.documents);
 check('selected_actual_download_restores_complete_documents_in_fresh_context',await page.locator('#title').textContent()===rich.title);
 await page.locator('#library-file').setInputFiles(selectedFile);await finished(page,2);
 assert.deepEqual(JSON.parse(await disk(page)).documents,selectedBackup.documents);
 check('selected_actual_download_repeat_fresh_restore_is_idempotent',true);await page.context().close();

 stage='selected actual download additive and conflict restore';page=await newPage();
 const unrelatedFile=await write('selected-unrelated.json',annotatedDocument('Unrelated existing shelf document'));
 await page.locator('#file').setInputFiles(unrelatedFile);await finished(page,1);const unrelated=JSON.parse(await disk(page)).documents[0];
 await page.locator('#library-file').setInputFiles(selectedFile);await finished(page,2);
 const additive=JSON.parse(await disk(page));assert.deepEqual(additive.documents,[unrelated,...selectedBackup.documents]);
 check('selected_restore_is_additive_and_keeps_unrelated_existing_content',await page.locator('#title').textContent()===rich.title);
 await page.locator('#library-file').setInputFiles(selectedFile);await finished(page,3);
 assert.deepEqual(JSON.parse(await disk(page)),additive);check('selected_additive_repeat_restore_adds_no_duplicates',true);
 await page.locator('#mode-transcript').click();await page.locator('.note-button').first().click();await page.locator('#note').fill('Newer local note must survive restoring an older selected backup');await page.locator('#close-note').click();
 const beforeConflict=JSON.parse(await disk(page));
 check('selected_conflict_fixture_is_a_real_saved_local_edit',beforeConflict.documents.find(doc=>doc.key===rich.key).notes.cue==='Newer local note must survive restoring an older selected backup');
 await page.locator('#library-file').setInputFiles(selectedFile);await finished(page,4);
 const conflict=JSON.parse(await disk(page)),restoredVersion=conflict.documents.find(doc=>!beforeConflict.documents.some(old=>old.key===doc.key));
 assert.equal(conflict.documents.length,beforeConflict.documents.length+1);
 for(const doc of beforeConflict.documents)assert.deepEqual(conflict.documents.find(current=>current.key===doc.key),doc);
 assert.ok(restoredVersion);assert.notEqual(restoredVersion.key,rich.key);assert.deepEqual({...restoredVersion,key:rich.key},richBackup);
 check('selected_restore_retains_conflicting_local_version_and_complete_backup_version',await page.evaluate(()=>sessionStorage.getItem('coconut-reader-active-v1'))===restoredVersion.key);
 await page.locator('#library-file').setInputFiles(selectedFile);await finished(page,5);
 assert.deepEqual(JSON.parse(await disk(page)),conflict);check('selected_conflicting_repeat_restore_deduplicates_the_retained_backup_version',true);await page.context().close();

 stage='selected pending removal blocks partial backup';page=sourcePage;
 // Verify that the loading-time factory wrapper reached the actual writer;
 // assigning write on the production frozen adapter cannot install this hook.
 check('held_writer_is_installed_before_frozen_adapter_creation',await page.evaluate(()=>{
  const proof=selectedBackupWriteProof;
  return proof.created===1&&proof.originalFrozen&&proof.wrapperFrozen&&Object.isFrozen(libraryAdapter)&&libraryAdapter.write===proof.write&&proof.captures>0&&proof.writes.length===0;
 }));
 await page.evaluate(()=>{selectedBackupWriteProof.hold=true;});
 stage='selected pending removal awaits held write';
 await page.locator('.library-entry[data-document-key="selected-rich"] .library-remove').click();await page.locator('#confirm-removal').click();
 await page.waitForFunction(()=>selectedBackupWriteProof.writes.length===1);await openLibraryTools(page);
 check('pending_selected_removal_disables_export_without_silently_dropping_selection',await page.locator('#export-selected-library').isDisabled()&&/已选\s*2\s*份/.test(await page.locator('#library-selection-status').textContent())&&/正在移除或恢复/.test(await page.locator('#library-selection-status').textContent()));
 // Read committed disk directly: flushing here would wait for the held writer.
 assert.deepEqual(JSON.parse(await page.evaluate(key=>localStorage.getItem(key),KEY)),originalSelection);
 stage='selected pending removal releases held write';
 await page.evaluate(()=>{selectedBackupWriteProof.hold=false;selectedBackupWriteProof.writes[0].commit();});
 await page.waitForFunction(()=>document.getElementById('save-status').dataset.state==='saved'&&!document.getElementById('export-selected-library').disabled);
 await openLibraryTools(page);
 check('held_writer_releases_through_original_adapter_once',await page.evaluate(()=>selectedBackupWriteProof.releases===1));
 check('completed_removal_prunes_selection_with_visible_count',/已选\s*1\s*份/.test(await page.locator('#library-selection-status').textContent())&&/已取消/.test(await page.locator('#library-selection-status').textContent()));
 const afterRemoval=JSON.parse(await fs.readFile(await download(page,'export-selected-library','selected-after-removal.json'),'utf8'));
 assert.deepEqual(afterRemoval.documents,[audioBackup]);check('after_removal_selected_download_contains_only_remaining_selected_document',afterRemoval.active===audio.key);
 await page.locator('#undo-removal').click();await page.evaluate(()=>libraryStore.flush());await openLibraryTools(page);
 check('undo_does_not_implicitly_select_restored_document',JSON.parse(await disk(page)).documents.length===3&&!await page.locator('.library-entry[data-document-key="selected-rich"] .library-select').isChecked()&&/已选\s*1\s*份/.test(await page.locator('#library-selection-status').textContent()));
 await page.context().close();
 const small=await write('original.json',annotatedDocument('Original saved work'));
 const chinese=await write('chinese.json',chineseDocument());assert.ok((await fs.stat(chinese)).size>15*MiB);
 page=await newPage();await page.locator('#file').setInputFiles(small);await finished(page,1);const before=await disk(page);
 stage='native_quota_and_17_mib_recovery';await page.locator('#file').setInputFiles(chinese);await finished(page,2);
 check('17_mib_json_reads_without_extra_confirmation',!await page.locator('#large-backup-dialog').isVisible()&&await page.locator('#title').textContent()==='600万汉字完整备份');
 check('native_quota_failure_preserves_original_disk_library',await disk(page)===before&&await page.locator('#save-status').getAttribute('data-state')==='failed');
 const rescued=await download(page,'export','chinese-rescue.json');const rescueText=await fs.readFile(rescued,'utf8');const rescue=JSON.parse(rescueText);
 check('actual_download_preserves_all_source_and_context',rescue.segments.length===6001&&rescue.segments.at(-1).text==='汉'.repeat(1000)&&rescue.ai_answers[0].input_snapshot.segments[0].text==='Authored source words'&&Object.keys(rescue.translation_contexts).length===1);
 await page.locator('#file').setInputFiles(rescued);await finished(page,3);check('actual_download_repeat_import_is_idempotent',await page.evaluate(()=>state.documents.length)===2);
 await page.context().close();page=await newPage();await page.locator('#file').setInputFiles(rescued);await finished(page,1);
 const secondRescue=await download(page,'export','chinese-fresh-rescue.json');const second=JSON.parse(await fs.readFile(secondRescue,'utf8'));
 // Local document keys are assigned from validated content; compare complete user data.
 delete rescue.key;delete second.key;check('fresh_browser_reimports_the_actual_download_losslessly',digest(JSON.stringify(second))===digest(JSON.stringify(rescue)));
 await page.context().close();

 stage='large_file_cancel_escape_retry';const large=await write('large-notes.json',oversizedDocument());check('authored_annotations_really_exceed_50_mib',(await fs.stat(large)).size>50*MiB);
 page=await newPage();await page.locator('#file').setInputFiles(small);await finished(page,1);const saved=await disk(page);
 for(const [index,action] of ['cancel','escape'].entries()){
  await page.locator('#file').setInputFiles(large);await page.locator('#large-backup-dialog').waitFor({state:'visible'});
  check('large_file_is_not_read_before_'+action,await page.evaluate(()=>window.backupProbe.reads)===1);
  if(action==='cancel')await page.locator('#cancel-large-backup').click();else await page.keyboard.press('Escape');
  await finished(page,index+2);check(action+'_preserves_original_library',await disk(page)===saved&&await page.locator('#file').evaluate(input=>input.files.length===0));
 }
 stage='large_file_same_path_retry';
 await page.locator('#file').setInputFiles(large);await page.locator('#large-backup-dialog').waitFor({state:'visible'});
 check('same_path_retry_after_escape_starts_a_new_unread_review',await page.evaluate(()=>window.backupProbe.started===4&&window.backupProbe.finished===3&&window.backupProbe.reads===1)&&await disk(page)===saved);
 // Chromium does not dispatch change when its selected file has the same
 // source path. A distinct full copy is a genuine newer selection; do not
 // manually dispatch change or clear the input to manufacture this race.
 stage='large_file_new_selection';const newerLarge=path.join(directory,'large-notes-new-selection.json');await fs.copyFile(large,newerLarge);
 check('new_selection_is_a_complete_oversized_copy',(await fs.stat(newerLarge)).size===(await fs.stat(large)).size&&(await fs.stat(newerLarge)).size>50*MiB);
 const closesBefore=await page.evaluate(()=>window.backupProbe.dialogCloses);
 await page.locator('#file').setInputFiles(newerLarge);await finished(page,4);
 check('new_file_change_retires_previous_review',await page.evaluate(()=>window.backupProbe.started===5&&window.backupProbe.finished===4)&&await page.locator('#file').evaluate(input=>input.files[0]?.name==='large-notes-new-selection.json'));
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 check('old_native_close_event_does_not_cancel_new_large_selection',await page.locator('#large-backup-dialog').isVisible()&&await page.evaluate(before=>window.backupProbe.reads===1&&window.backupProbe.dialogCloses>before,closesBefore));
 stage='large_file_approved_read';await page.locator('#continue-large-backup').click();await finished(page,5);
 check('approved_large_json_remains_readable_when_not_persisted',await page.locator('#title').textContent()==='含大笔记的完整备份'&&await disk(page)===saved&&await page.locator('#save-status').getAttribute('data-state')==='failed');
 const library=await download(page,'export-library','whole-library.json');check('whole_library_over_50_mib_download_is_not_blocked',(await fs.stat(library)).size>50*MiB);
 await page.context().close();
 stage='large_library_actual_download_restore';page=await newPage();await page.locator('#file').setInputFiles(small);await finished(page,1);const preserved=await disk(page);
 await page.locator('#library-file').setInputFiles(library);await page.locator('#continue-large-backup').click();await finished(page,2);
 check('large_library_merge_keeps_original_and_full_annotation',await page.evaluate(()=>state.documents.length===2&&active().notes.cue.length===17600000)&&await disk(page)===preserved);
 await page.locator('#library-file').setInputFiles(library);await page.locator('#continue-large-backup').click();await finished(page,3);
 check('large_library_repeat_restore_deduplicates_without_overwriting',await page.evaluate(()=>state.documents.length)===2&&await disk(page)===preserved);
 const final=await download(page,'export','large-final-rescue.json');const actual=JSON.parse(await fs.readFile(final,'utf8')),expected=oversizedDocument();
 assert.deepEqual(actual.ai_answers,expected.ai_answers);check('rescue_download_keeps_complete_large_notes_and_ai_evidence',digest(actual.notes.cue)===digest(expected.notes.cue));
 await page.context().close();check('no_remote_requests_mutations_or_page_errors',external===0&&mutations===0&&errors===0);
 console.log(JSON.stringify({suite:'complete-backup-roundtrip',status:'passed',checks}));
}catch(error){
 // Authored fixture metadata only: enough to distinguish missing change,
 // retired approval, read/render work and a failed persistence boundary in CI.
 const probe=await page?.evaluate(()=>({...window.backupProbe,dialogOpen:document.getElementById('large-backup-dialog')?.open,file:document.getElementById('file')?.files[0]?.name||null,libraryFile:document.getElementById('library-file')?.files[0]?.name||null,saveState:document.getElementById('save-status')?.dataset.state,selectionStatus:document.getElementById('library-selection-status')?.textContent,selectedExportDisabled:document.getElementById('export-selected-library')?.disabled,pendingStructuralKeys:[...pendingStructuralDocuments.keys()],writer:window.selectedBackupWriteProof?{created:selectedBackupWriteProof.created,originalFrozen:selectedBackupWriteProof.originalFrozen,wrapperFrozen:selectedBackupWriteProof.wrapperFrozen,installed:libraryAdapter.write===selectedBackupWriteProof.write,hold:selectedBackupWriteProof.hold,held:selectedBackupWriteProof.writes.length,captures:selectedBackupWriteProof.captures,releases:selectedBackupWriteProof.releases}:null})).catch(()=>null);
 console.error(JSON.stringify({suite:'complete-backup-roundtrip',status:'failed',stage,checks,probe,error:error.message}));process.exitCode=1;
}
finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));if(directory)await fs.rm(directory,{recursive:true,force:true});}
