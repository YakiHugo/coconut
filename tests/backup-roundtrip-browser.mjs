/** GitHub browser-CI-only proof: authored files, real downloads/pickers and
 * native storage quota. No AI, remote media, traces or private artifacts. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from '@playwright/test';
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
 async function newPage(){
  const context=await browser.newContext({acceptDownloads:true,serviceWorkers:'block'});
  await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===origin||['blob:','data:'].includes(url.protocol))await route.continue();else{external++;await route.abort();}});
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
  const details=page.locator(id==='export'?'#export-menu':'details.library-backup');
  if(id==='export-library'&&!await details.isVisible()){
   const toggle=page.locator('#toggle-library');
   if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')==='false')await toggle.click();
  }
  if(!await details.evaluate(element=>element.open))await details.locator(':scope > summary').click();
  const [item]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);
  const file=path.join(directory,name);await item.saveAs(file);assert.equal(await item.failure(),null);return file;
 }
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
 const probe=await page?.evaluate(()=>({...window.backupProbe,dialogOpen:document.getElementById('large-backup-dialog')?.open,file:document.getElementById('file')?.files[0]?.name||null,libraryFile:document.getElementById('library-file')?.files[0]?.name||null})).catch(()=>null);
 console.error(JSON.stringify({suite:'complete-backup-roundtrip',status:'failed',stage,checks,probe,error:error.message}));process.exitCode=1;
}
finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));if(directory)await fs.rm(directory,{recursive:true,force:true});}
