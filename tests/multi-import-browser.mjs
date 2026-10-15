// Compatibility renderer regression; this suite is not default React acceptance.
/** CI-only actual native multiple-file selection and IndexedDB persistence.
 * Authored text only; no models, ASR, accounts, uploads or public-source content. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import {chromium} from './helpers/browser-storage.mjs';
const root=new URL('../reader/',import.meta.url),checks=[];
const source=title=>({title,language:'en',segments:[{id:'cue',start:0,end:3,text:'Authored sentence for '+title}],notes:{cue:'Private note for '+title}});
const file=(title,text=JSON.stringify(source(title)),extension='json')=>({name:title+'.'+extension,mimeType:extension==='json'?'application/json':'text/plain',buffer:Buffer.from(text)});
let server,browser,stage='setup',external=0,mutations=0,errors=0;
const check=(name,condition)=>{assert.ok(condition,name);checks.push(name);};
try{
 server=createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){mutations++;res.writeHead(405).end();return;}
  const pathname=new URL(req.url,'http://localhost').pathname,filename=pathname==='/'?'compatibility.html':pathname.slice(1);
  if(!/^[a-z-]+\.(html|js|css|webmanifest|png)$/.test(filename)){res.writeHead(404,{'Content-Type':'application/json'}).end('{"error":"static only"}');return;}
  try{const body=await fs.readFile(new URL(filename,root));res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.png')?'image/png':'text/html'}).end(body);}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
 await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===origin||['blob:','data:'].includes(url.protocol))await route.continue();else{external++;await route.abort();}});
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',()=>errors++);
 await page.addInitScript(()=>{
  window.multiProbe={holdName:null,reads:[],finished:0};const read=File.prototype.text;
  File.prototype.text=async function(){const probe=window.multiProbe;probe.reads.push(this.name);if(this.name===probe.holdName){probe.holdName=null;await new Promise(resolve=>probe.release=resolve);probe.release=null;}return read.call(this);};
 });
 const watch=()=>page.evaluate(()=>{const input=document.getElementById('file'),handler=input.onchange;input.onchange=async event=>{await handler.call(input,event);window.multiProbe.finished++;};});
 await page.goto(origin);await watch();
 const choose=files=>page.locator('#file').setInputFiles(files);
 const finished=count=>page.waitForFunction(count=>window.multiProbe.finished===count,count);
 const statuses=()=>page.locator('#transcript-import-list > li').evaluateAll(rows=>rows.map(row=>row.dataset.status));
 const stored=()=>page.evaluate(async()=>{await libraryStore.flush();return readPersistedLibrary();});
 const rows=page.locator('#transcript-import-list > li');
 stage='seed';await choose(file('Existing'));await finished(1);await page.locator('#add-content').click();
 stage='native_multiple_partial_failure';await choose([file('New JSON'),file('Malformed','{'),file('Existing'),file('SRT','1\n00:00:01,125 --> 00:00:03,250\nAuthored SRT\n','srt'),file('VTT','WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Ada>Authored VTT\n','vtt'),file('Whole library',JSON.stringify({format:'coconut-library',version:1,documents:[],...source('Never a transcript')}))]);await finished(2);
 assert.deepEqual(await statuses(),['saved','failed','duplicate','saved','saved','failed']);
 const first=await stored();check('native_multiple_formats_preserve_partial_success',first.documents.length===4&&first.documents.find(doc=>doc.title==='VTT').segments[0].speaker==='Ada');
 check('library_backup_is_explicitly_separate',/恢复书架备份/.test(await rows.nth(5).textContent()));
 check('batch_finishes_in_add_with_individual_read_actions',await page.locator('#add-workspace').isVisible()&&await rows.nth(0).locator('button').isVisible());
 await rows.nth(3).locator('button').click();check('chosen_result_opens_clean_reader',await page.locator('#title').textContent()==='SRT'&&!await page.locator('#transcript-import-results').isVisible()&&await page.locator('#reader-workspace').evaluate(node=>node===document.activeElement));
 await page.reload();await watch();assert.deepEqual((await stored()).documents,first.documents);check('actual_indexeddb_reload_preserves_all_successes_and_notes',true);
 stage='cancel_remaining';await page.locator('#add-content').click();await page.evaluate(()=>window.multiProbe.holdName='Slow.json');
 await choose([file('Before cancel'),file('Slow'),file('Never read')]);await page.waitForFunction(()=>!!window.multiProbe.release);
 check('first_file_commits_before_second_file_finishes_reading',(await stored()).documents.some(doc=>doc.title==='Before cancel'));
 await page.locator('#stop-transcript-import').click();await page.evaluate(()=>window.multiProbe.release());await finished(1);
 assert.deepEqual(await statuses(),['saved','cancelled','cancelled']);check('cancel_retains_saved_success_and_does_not_read_remaining_file',!await page.evaluate(()=>window.multiProbe.reads.includes('Never read.json')));
 stage='newer_navigation';await page.evaluate(()=>window.multiProbe.holdName='Held navigation.json');
 await choose([file('Held navigation'),file('Never after navigation')]);await page.waitForFunction(()=>!!window.multiProbe.release);
 if(await page.locator('#toggle-library').getAttribute('aria-expanded')==='false')await page.locator('#toggle-library').click();
 await page.locator('#library .library-open').filter({hasText:'Existing'}).click();await page.locator('#mode-transcript').click();await page.locator('.note-button').click();await page.locator('#note').fill('A newer note during a retired import');
 await page.evaluate(()=>window.multiProbe.release());await finished(2);
 check('newer_navigation_and_note_editor_survive_old_batch',await page.locator('#title').textContent()==='Existing'&&await page.locator('#note').inputValue()==='A newer note during a retired import'&&await page.locator('#notes-panel').isVisible());
 check('retired_batch_never_reads_later_file',!await page.evaluate(()=>window.multiProbe.reads.includes('Never after navigation.json')));
 stage='storage_failure_then_retry';await page.locator('#close-note').click();await page.locator('#add-content').click();await page.evaluate(()=>{window.multiProbe.holdName='Quota file.json';});
 await choose([file('Before quota'),file('Quota file'),file('After quota')]);await page.waitForFunction(()=>!!window.multiProbe.release);await page.evaluate(()=>{failContentWrites();window.multiProbe.release();});await finished(3);
 assert.deepEqual(await statuses(),['saved','unsaved','cancelled']);check('quota_never_counts_pending_document_as_saved',!(await page.evaluate(()=>readPersistedLibrary())).documents.some(doc=>doc.title==='Quota file'));
 check('quota_exposes_complete_recovery',await page.locator('#export-unsaved-documents').isVisible()&&!await page.evaluate(()=>window.multiProbe.reads.includes('After quota.json')));
 await page.evaluate(()=>restoreContentWrites());await page.locator('#retry-save').click();await page.waitForFunction(()=>document.querySelectorAll('#transcript-import-list > li')[1].dataset.status==='saved');
 const final=await stored();check('explicit_retry_acknowledges_exact_failed_identity',final.documents.some(doc=>doc.title==='Quota file'&&doc.notes.cue==='Private note for Quota file'));
 await page.reload();assert.deepEqual((await stored()).documents,final.documents);check('reload_confirms_partial_batch_and_retry_without_unsaved_or_unstarted_files',final.documents.length===7&&!final.documents.some(doc=>/^(Slow|Never|After quota|Held navigation)/.test(doc.title)));
 check('all_file_inputs_are_reset_after_owned_requests',await page.locator('#file').evaluate(input=>input.files.length===0));
 stage='file_drop_journey';await page.locator('#add-content').click();
 await choose(file('Wrong picker','Not a transcript','mp3'));
 await page.waitForFunction(()=>document.getElementById('transcript-drop-status').textContent.includes('Wrong picker.mp3'));
 check('rejected_picker_clears_native_file_selection',await page.locator('#file').evaluate(input=>input.files.length===0&&input.value===''));
 const dropFiles=async entries=>{
  const transfer=await page.evaluateHandle(entries=>{const data=new DataTransfer();for(const entry of entries)data.items.add(new File([entry.text],entry.name,{type:entry.name.endsWith('.json')?'application/json':'text/plain'}));return data;},entries);
  try{await page.locator('#transcript-drop-target').dispatchEvent('dragenter',{dataTransfer:transfer});await page.locator('#transcript-drop-target').dispatchEvent('dragover',{dataTransfer:transfer});await page.locator('#transcript-drop-target').dispatchEvent('drop',{dataTransfer:transfer});}finally{await transfer.dispose();}
 };
 await dropFiles([{name:'Rejected.json',text:JSON.stringify(source('Rejected'))},{name:'Wrong.mp3',text:'Not media'}]);
 await page.waitForFunction(()=>document.getElementById('transcript-drop-status').textContent.includes('Wrong.mp3'));
 check('mixed_drop_rejected_before_any_file_read',!await page.evaluate(()=>window.multiProbe.reads.includes('Rejected.json')||window.multiProbe.reads.includes('Wrong.mp3')));
 await dropFiles([{name:'Dropped.json',text:JSON.stringify(source('Dropped'))},{name:'Drop captions.vtt',text:'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Ada>Dropped local captions\n'}]);
 await page.waitForFunction(()=>document.querySelectorAll('#transcript-import-list > li').length===2&&[...document.querySelectorAll('#transcript-import-list > li')].every(row=>row.dataset.status==='saved'));
 check('actual_file_drop_preserves_order_and_receipts',JSON.stringify(await statuses())===JSON.stringify(['saved','saved']));
 check('drop_highlight_clears_and_target_fits_mobile',await page.locator('#transcript-drop-target').evaluate(node=>!node.classList.contains('is-file-drag')&&node.getBoundingClientRect().right<=innerWidth));
 const dropped=await stored();check('drop_preserves_vtt_speaker',dropped.documents.find(doc=>doc.title==='Drop captions').segments[0].speaker==='Ada');
 await page.reload();assert.deepEqual((await stored()).documents,dropped.documents);check('drop_successes_survive_indexeddb_reload',true);

 stage='partial_subtitle_native_picker';await watch();await page.locator('#add-content').click();
 const partialText='1\n00:00:00,000 --> 00:00:01,000\nOpening\n\n2\n00:00:01,000 -> 00:00:02,000\nCritical <img src=x onerror=alert(1)> sentence\n\n3\n00:00:02,000 --> 00:00:03,000\nClosing';
 const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#import').click()]);
 await chooser.setFiles(file('Partial native',partialText,'srt'));await finished(1);
 check('single_partial_import_announces_loss_without_claiming_complete_success',/部分字幕未导入.*添加内容/.test(await page.locator('#notice').textContent()));
 await page.locator('#add-content').click();const partialRow=rows.first(),details=partialRow.locator('details');await details.locator('summary').click();
 await details.locator('li').waitFor();check('native_warning_persists_with_original_lines_and_text_only_preview',await partialRow.getAttribute('data-status')==='saved'&&await partialRow.getAttribute('data-parse-state')==='partial'&&/第 5–7 行/.test(await details.textContent())&&await details.locator('img').count()===0&&/Critical <img/.test(await details.textContent()));
 check('partial_warning_fits_narrow_viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)&&await details.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
 const imported=(await stored()).documents.find(doc=>doc.title==='Partial native');check('partial_import_saves_only_valid_cues_without_diagnostic_metadata',imported.segments.length===2&&imported.segments[1].text==='Closing'&&!Object.hasOwn(imported,'diagnostics'));
 await choose([file('Normal before partial'),file('Partial batch',partialText,'srt'),file('Normal after partial')]);await finished(2);
 check('normal_partial_normal_preserves_per_file_warning',JSON.stringify(await statuses())===JSON.stringify(['saved','saved','saved'])&&await rows.nth(1).locator('details').count()===1&&await rows.nth(2).locator('details').count()===0&&/部分字幕未导入 1 块/.test(await page.locator('#transcript-import-progress').textContent()));
 stage='partial_subtitle_save_failure';await page.evaluate(()=>failContentWrites());await choose([file('Partial quota',partialText,'srt'),file('Never after partial quota')]);await finished(3);
 check('partial_warning_is_orthogonal_to_failed_save',JSON.stringify(await statuses())===JSON.stringify(['unsaved','cancelled'])&&/跳过 1/.test(await rows.first().locator('details').textContent()));
 await page.evaluate(()=>restoreContentWrites());await page.locator('#retry-save').click();await page.waitForFunction(()=>document.querySelector('#transcript-import-list > li').dataset.status==='saved');
 check('retry_preserves_partial_warning_and_saves_valid_cues',/跳过 1/.test(await rows.first().locator('details').textContent())&&(await stored()).documents.find(doc=>doc.title==='Partial quota').segments.length===2);
 stage='partial_subtitle_drop';await dropFiles([{name:'Partial dropped.srt',text:partialText}]);
 await page.waitForFunction(()=>document.getElementById('title').textContent==='Partial dropped'&&document.querySelector('#transcript-import-list > li')?.dataset.status==='saved');
 await page.locator('#add-content').click();await rows.first().locator('summary').click();await rows.first().locator('details li').waitFor();
 check('drop_retains_partial_line_diagnostics',/第 5–7 行/.test(await rows.first().locator('details').textContent()));
 stage='partial_subtitle_project_supplement';
 const localSource={version:1,kind:'audio',name:'Authored original.wav',size:64,last_modified:7,type:'audio/wav',fingerprint:'a'.repeat(64)};
 const project={project_kind:'audio_only',title:'Partial supplement project',local_media_source:localSource,segments:[],project_note:'Keep project note',timestamp_bookmarks:[{id:'bookmark-1',time:12,note:'Keep original bookmark'}]};
 await choose(file('Supplement project',JSON.stringify(project)));await finished(4);const projectBefore=(await stored()).documents.find(doc=>doc.title===project.title);
 const [supplementChooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-project-transcript').click()]);
 await supplementChooser.setFiles(file('Supplement partial',partialText,'srt'));
 await page.waitForFunction(()=>document.getElementById('project-transcript-file').value===''&&document.querySelector('#transcript-import-list > li')?.dataset.status==='saved'&&document.querySelector('#transcript-import-list .transcript-import-name')?.textContent==='Supplement partial.srt');
 const projectAfter=(await stored()).documents.find(doc=>doc.key===projectBefore.key);
 check('partial_supplement_preserves_project_identity_and_annotations',projectAfter.segments.length===2&&projectAfter.project_note===project.project_note&&JSON.stringify(projectAfter.timestamp_bookmarks)===JSON.stringify(project.timestamp_bookmarks)&&JSON.stringify(projectAfter.local_media_source)===JSON.stringify(localSource));
 await page.locator('#add-content').click();await rows.first().locator('summary').click();await rows.first().locator('details li').waitFor();
 check('supplement_warning_is_persistent_after_navigation',/第 5–7 行/.test(await rows.first().locator('details').textContent()));
 check('no_network_upload_external_request_or_page_error',mutations===0&&external===0&&errors===0);
 console.log(JSON.stringify({suite:'multi-transcript-import',status:'passed',checks}));
}catch(error){console.error(JSON.stringify({suite:'multi-transcript-import',status:'failed',stage,checks,error:error.message}));process.exitCode=1;}
finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}
