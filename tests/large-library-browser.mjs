import {openLibraryTools} from './helpers/library-tools-browser.mjs';
/** CI-only native browser journey. Authored fixtures, no model/media/external requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium, waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {startBridge} from '../desktop/server.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
const checks=[],check=(name,passed)=>{assert.ok(passed,name);checks.push(name);};
let browser,server,stage='setup',external=0,mutations=0;const errors=[];
try{
 server=await startBridge({port:0});const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 async function newPage(){
  const context=await browser.newContext({viewport:{width:1360,height:1000},acceptDownloads:true,serviceWorkers:'block'});
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(!['GET','HEAD'].includes(request.method())){mutations++;await route.abort();}else if(url.origin===origin||['blob:','data:'].includes(url.protocol))await route.continue();else{external++;await route.abort();}});
  const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);return page;
 }
 const page=await newPage();
 async function shelf(p=page,options=false){if(!await p.locator('#library-search').isVisible())await p.locator('#toggle-library').click();if(options)await openLibraryTools(p);if(options&&!await p.locator('#library-sort').isVisible())await p.locator('#library-options > summary').click();}
 async function jump(number,p=page){await shelf(p);await openLibraryTools(p);await p.locator('#library-page-number').fill(String(number));await p.locator('#library-page-number').press('Enter');await p.waitForFunction(()=>document.activeElement?.classList.contains('library-open'));}
 async function stored(p=page){await p.evaluate(()=>libraryStore.flush());return p.evaluate(()=>readPersistedLibrary());}
 async function restore(p,buffer,count=1001){await p.locator('#library-file').setInputFiles({name:'authored-large-shelf.json',mimeType:'application/json',buffer});await p.waitForFunction(()=>document.getElementById('library-file').value==='');await waitForPersistedLibrary(p,async count=>(await readPersistedLibrary()).documents.length===count,count,{timeout:20000});}
 const docs=largeLibraryFixture();docs[1].title='ZZZ last by title, added second';docs[0].segments[7].end=10000;for(const doc of docs)doc.segments.at(-1).text='Shared authored pagination needle';
 const last=docs.at(-1);last.title+=' · '+('完整的长标题'.repeat(18));last.segments=Array.from({length:221},(_,i)=>({id:last.key+'-cue-'+i,start:i*2,end:i*2+1,text:i===220?'Shared authored pagination needle':'Original authored late-document cue '+i}));last.readingPosition=last.key+'-cue-0';last.notes[last.key+'-cue-219']='Last private needle';
 stage='complete storage and bounded shelf';await restore(page,Buffer.from(JSON.stringify({format:'coconut-library',version:1,documents:docs,active:docs[0].key})));
 check('indexeddb_retains_all_1001_documents',(await stored()).documents.length===1001);
 check('only_40_cards_mounted',await page.locator('.library-entry').count()===40);
 check('visible_count_distinguishes_page_and_total',/1–40.*1001/.test(await page.locator('#library-page-status').textContent()));
 await jump(26);check('keyboard_page_jump_focuses_final_card',await page.locator('.library-open').evaluate(n=>n===document.activeElement&&n.closest('.library-entry').dataset.documentKey==='shelf-1000'));
 check('full_last_title_without_truncation',await page.locator('.library-title').textContent()===last.title&&await page.locator('.library-title').evaluate(n=>getComputedStyle(n).textOverflow!=='ellipsis'));
 await page.keyboard.press('Enter');check('final_document_opens',await page.locator('#title').textContent()===last.title);
 stage='cooperative cancellation and honest pending state';await shelf(page,true);
 const pendingProof=await page.evaluate(()=>{
  const input=document.getElementById('library-search'),scope=document.getElementById('library-scope'),host=document.getElementById('library');
  scope.value='text';input.focus();input.value='pagination needle';input.oninput();
  const pending=host.hidden&&host.getAttribute('aria-busy')==='true'&&document.getElementById('library-page-status').textContent.includes('正在查找');
  input.value='Last private needle';input.oninput();input.value='';input.oninput();
  return {pending,cleared:!host.hidden&&host.getAttribute('aria-busy')==='false',focused:document.activeElement===input};
 });
 check('pending_count_is_honest_and_old_hits_hidden',pendingProof.pending);
 check('rapid_query_replacement_and_clear_are_immediate',pendingProof.cleared&&pendingProof.focused);
 await page.waitForFunction(()=>document.getElementById('library-page-status').textContent.includes('/ 1001'));
 await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
 check('cancelled_search_never_replaces_clear_results',await page.locator('.library-entry').count()===40);
 stage='complete search, sorting and precise late hit';await shelf(page,true);await page.locator('#library-scope').selectOption('text');await page.locator('#library-search').fill('pagination needle');
 await page.waitForFunction(()=>document.getElementById('library').getAttribute('aria-busy')==='false');
 check('search_covers_all_documents',/1001/.test(await page.locator('#library-page-status').textContent())&&await page.locator('.library-entry').count()===40);
 await jump(26);await page.locator('.library-hit').focus();await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.activeElement?.dataset.segmentId==='shelf-1000-cue-220');
 check('late_search_hit_focuses_real_cue',await page.locator('.segment').count()<=100&&await page.locator('#title').textContent()===last.title);
 check('hit_preserves_shelf_query',await page.locator('#library-search').inputValue()==='pagination needle'&&await page.locator('#library-page-number').inputValue()==='26');
 await shelf(page,true);await page.locator('#library-scope').selectOption('notes');await page.locator('#library-search').fill('Last private needle');await page.waitForFunction(()=>document.getElementById('library').getAttribute('aria-busy')==='false');await page.locator('.library-hit').focus();await page.keyboard.press('Enter');
 check('off_page_note_hit_focuses_exact_editor',await page.locator('#note').evaluate(n=>n===document.activeElement&&n.value==='Last private needle'));
 await page.locator('#close-note').click();await shelf(page,true);await page.locator('#library-search').fill('');await page.locator('#library-kind').selectOption('annotated');
 await page.waitForFunction(()=>document.getElementById('library').getAttribute('aria-busy')==='false');
 check('annotation_filter_reaches_final_document',await page.locator('.library-entry').count()===1&&await page.locator('.library-entry').getAttribute('data-document-key')==='shelf-1000');
 await page.locator('#library-kind').selectOption('all');await page.locator('#library-sort').selectOption('title');await jump(26);
 check('complete_title_sort_changes_final_page',await page.locator('.library-entry').getAttribute('data-document-key')==='shelf-1');
 await page.locator('#library-sort').selectOption('duration');await jump(26);check('complete_duration_sort_changes_final_page',await page.locator('.library-entry').getAttribute('data-document-key')==='shelf-0');
 stage='mobile paging removal and exact undo focus';await page.setViewportSize({width:390,height:844});await shelf(page,true);await page.locator('#library-sort').selectOption('added');await jump(26);
 check('mobile_paging_fits',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 for(const id of ['library-previous','library-next','library-page-number'])check(id+'_44px_target',await page.locator('#'+id).evaluate(n=>n.getBoundingClientRect().height>=44));
 const original=(await stored()).documents.at(-1);await page.locator('.library-remove').click();await page.locator('#cancel-removal').click();await page.waitForFunction(()=>document.activeElement?.classList.contains('library-remove'));
 check('cancel_restores_final_page_exact_action',await page.locator('.library-remove').evaluate(n=>n===document.activeElement));
 await page.locator('.library-remove').click();await page.locator('#confirm-removal').click();await page.locator('#undo-removal').waitFor({state:'visible'});
 check('remove_persists_all_other_documents',(await stored()).documents.length===1000);
 check('removed_final_page_clamps_without_empty_shelf',await page.locator('.library-entry').count()===40&&await page.locator('#library-page-number').inputValue()==='25');
 await page.locator('#undo-removal').click();await page.waitForFunction(()=>document.activeElement?.classList.contains('library-remove')&&document.activeElement.closest('.library-entry').dataset.documentKey==='shelf-1000');
 check('undo_restores_exact_last_document_and_keyboard_focus',await page.locator('#library-page-number').inputValue()==='26'&&await page.locator('.library-entry').count()===1);
 assert.deepEqual((await stored()).documents.at(-1),original);check('undo_preserves_complete_last_document',true);
 stage='real complete backup and clean-context restore';await shelf();await openLibraryTools(page);await page.locator('.library-backup > summary').click();const pending=page.waitForEvent('download');await page.locator('#export-library').click();const download=await pending,bytes=await fs.readFile(await download.path()),backup=JSON.parse(bytes);
 check('actual_download_contains_every_document',backup.documents.length===1001);assert.deepEqual(backup.documents.at(-1),original);
 const clean=await newPage();await restore(clean,bytes);await shelf(clean,true);await clean.locator('#library-search').fill(last.title);
 check('clean_restore_finds_last_complete_title',await clean.locator('.library-title').textContent()===last.title&&(await stored(clean)).documents.length===1001);

 // Separate authored context: the complete-library proof above keeps its 1001
 // documents and expectations. Selection must remain independent of 40-card DOM pages.
 stage='150-document selected backup across pages and filters';
 const selectionPage=await newPage(),selectionDocs=largeLibraryFixture(150);
 selectionDocs[149].title='AAA selected final document · '+('完整的备份标题'.repeat(12));
 selectionDocs[149].notes['shelf-149-cue-7']='Authored selected final private note';
 selectionDocs[0].segments.at(-1).end=10000;
 await restore(selectionPage,Buffer.from(JSON.stringify({format:'coconut-library',version:1,documents:selectionDocs,active:'shelf-0'})),150);
 const selectionBefore=await stored(selectionPage),selectedKeys=[0,1,2,40,41,42,80,81,82,120,121,149].map(index=>'shelf-'+index);
 const choice=key=>selectionPage.locator('.library-entry[data-document-key="'+key+'"] .library-select');
 async function selectionStatus(total,outside,label){
  const status=await selectionPage.locator('#library-selection-status').textContent();
  check(label,new RegExp('已选\\s*'+total+'\\s*份').test(status)&&new RegExp('其中\\s*'+outside+'\\s*份不在当前页').test(status));
  check(label+'_bounded_cards',await selectionPage.locator('.library-entry').count()<=40);
 }
 async function lastSelectedKeyboardGeometry(label){
  // Let native focus scrolling settle. Never scroll the checkbox in this proof,
  // dismiss feedback, or wait for the success toast to expire before measuring.
  await selectionPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const geometry=await choice('shelf-149').evaluate(node=>{
   const label=node.closest('label'),rect=node.getBoundingClientRect(),labelRect=label.getBoundingClientRect(),style=getComputedStyle(node);
   const ring=(parseFloat(style.outlineWidth)||0)+Math.max(0,parseFloat(style.outlineOffset)||0);
   const target={left:Math.min(labelRect.left,rect.left-ring),right:Math.max(labelRect.right,rect.right+ring),top:Math.min(labelRect.top,rect.top-ring),bottom:Math.max(labelRect.bottom,rect.bottom+ring)};
   const midX=(labelRect.left+labelRect.right)/2,midY=(labelRect.top+labelRect.bottom)/2;
   const hitPoints=[[midX,midY],[labelRect.left+1,midY],[labelRect.right-1,midY],[midX,labelRect.top+1],[midX,labelRect.bottom-1]].map(([x,y])=>{
    const hit=document.elementFromPoint(x,y);return {x,y,hit:hit===label||label.contains(hit)};
   });
   const toast=document.getElementById('notice-shell'),notice=document.getElementById('notice'),toastRect=toast.getBoundingClientRect(),toastStyle=getComputedStyle(toast);
   const activeToast=notice.dataset.kind==='success'&&!notice.hidden&&toast.classList.contains('is-success')&&toastStyle.display!=='none'&&toastStyle.visibility!=='hidden'&&toastRect.width>0&&toastRect.height>0;
   const scrollViewport=document.getElementById('library-list').getBoundingClientRect();
   return {focused:document.activeElement===node,focusVisible:node.matches(':focus-visible'),checked:node.checked,rect:rect.toJSON(),labelRect:labelRect.toJSON(),ring,outlineStyle:style.outlineStyle,target,hitPoints,activeToast,toast:toastRect.toJSON(),notice:notice.textContent,scrollViewport:scrollViewport.toJSON(),viewport:{width:innerWidth,height:innerHeight}};
  });
  console.log(JSON.stringify({suite:'selected-library-keyboard-geometry',label,...geometry}));
  const {target,toast,scrollViewport,viewport}=geometry;
  const clear=geometry.focused&&geometry.focusVisible&&geometry.outlineStyle!=='none'&&geometry.ring>0&&geometry.labelRect.height>=44&&geometry.activeToast&&
   target.left>=0&&target.right<=viewport.width&&target.top>=0&&target.bottom<=viewport.height&&
   target.left>=scrollViewport.left&&target.right<=scrollViewport.right&&target.top>=scrollViewport.top&&target.bottom<=scrollViewport.bottom&&
   (toast.right<=target.left||toast.left>=target.right||toast.top>=target.bottom||toast.bottom<=target.top)&&geometry.hitPoints.every(point=>point.hit);
  // Failure artifacts are explicitly diagnostic, never a successful card proof.
  if(!clear&&process.env.COCONUT_UI_SCREENSHOTS){
   await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});
   await selectionPage.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'selected-library-backup-390-'+label+'-geometry-failure.png'),fullPage:false,animations:'disabled'});
  }
  check(label+'_last_checkbox_full_label_focus_ring_and_five_hit_points_clear_live_toast',clear);
 }
 async function selectedDownload(){
  await shelf(selectionPage,true);
  const [download]=await Promise.all([selectionPage.waitForEvent('download'),selectionPage.locator('#export-selected-library').click()]);
  assert.equal(await download.failure(),null);assert.equal(download.suggestedFilename(),'coconut-selected-library.json');
  const bytes=await fs.readFile(await download.path());return {bytes,backup:JSON.parse(bytes)};
 }
 await shelf(selectionPage,true);
 check('selected_backup_is_opt_in',await selectionPage.locator('#library-selection-mode').getAttribute('aria-pressed')==='false'&&!await selectionPage.locator('#library-selection-controls').isVisible()&&await selectionPage.locator('.library-select:visible').count()===0);
 await selectionPage.locator('#library-selection-mode').click();
 check('empty_selection_cannot_download',await selectionPage.locator('#export-selected-library').isDisabled()&&await selectionPage.locator('#clear-library-selection').isDisabled());
 await choice('shelf-0').focus();await selectionPage.keyboard.press('Space');
 check('native_keyboard_checkbox_selects_without_opening',await choice('shelf-0').isChecked()&&await choice('shelf-0').evaluate(node=>node===document.activeElement)&&await selectionPage.locator('#title').textContent()===selectionDocs[0].title);
 await selectionStatus(1,0,'keyboard_selection_reports_first_document');
 await choice('shelf-1').check();await choice('shelf-2').check();await selectionStatus(3,0,'first_page_selected_count');
 await jump(2,selectionPage);for(const key of ['shelf-40','shelf-41','shelf-42'])await choice(key).check();await selectionStatus(6,3,'second_page_keeps_off_page_selection');
 await jump(3,selectionPage);for(const key of ['shelf-80','shelf-81','shelf-82'])await choice(key).check();await selectionStatus(9,6,'third_page_keeps_off_page_selection');
 await jump(4,selectionPage);for(const key of ['shelf-120','shelf-121','shelf-149'])await choice(key).check();await selectionStatus(12,9,'fourth_page_keeps_all_twelve_selections');
 check('150_document_final_page_stays_bounded',await selectionPage.locator('.library-entry').count()===30);
 await shelf(selectionPage,true);await selectionPage.locator('#library-search').fill(selectionDocs[149].title);
 check('title_query_keeps_selected_checkbox',await choice('shelf-149').isChecked());await selectionStatus(12,11,'query_reports_hidden_selections');
 await selectionPage.locator('#library-search').fill('No authored document has this title');
 check('empty_results_do_not_disable_selected_backup',await selectionPage.locator('.library-entry').count()===0&&!await selectionPage.locator('#export-selected-library').isDisabled());
 await selectionStatus(12,12,'empty_query_reports_all_selected_documents_off_page');
 const selected=await selectedDownload();
 assert.equal(selected.backup.format,'coconut-library');assert.equal(selected.backup.version,1);assert.equal(selected.backup.active,'shelf-0');assert.equal(selected.backup.documents.length,12);
 assert.deepEqual(selected.backup.documents,selectionBefore.documents.filter(doc=>selectedKeys.includes(doc.key)));
 check('actual_selected_download_contains_only_complete_selected_objects_and_selected_active',true);
 await selectionPage.locator('#library-search').fill('');await selectionPage.locator('#library-sort').selectOption('title');
 check('sort_reorders_shelf_without_losing_selection',await selectionPage.locator('.library-entry').first().getAttribute('data-document-key')==='shelf-149'&&await choice('shelf-149').isChecked()&&await choice('shelf-0').isChecked());
 await selectionStatus(12,8,'sort_reports_selected_documents_outside_page');
 await selectionPage.locator('#library-kind').selectOption('annotated');
 await selectionPage.waitForFunction(()=>document.getElementById('library').getAttribute('aria-busy')==='false');
 check('kind_filter_preserves_all_selections',await selectionPage.locator('.library-entry').count()===1&&await choice('shelf-149').isChecked());
 await selectionStatus(12,11,'kind_filter_reports_off_page_selections');
 await selectionPage.locator('#library-scope').selectOption('notes');await selectionPage.locator('#library-search').fill('selected final private note');
 await selectionPage.waitForFunction(()=>document.getElementById('library').getAttribute('aria-busy')==='false');
 check('note_query_preserves_checkbox_selection',await choice('shelf-149').isChecked());
 await selectionStatus(12,11,'note_query_reports_off_page_selections');
 await selectionPage.locator('#library-search').fill('');await selectionPage.locator('#library-kind').selectOption('all');await selectionPage.locator('#library-scope').selectOption('title');
 await choice('shelf-0').uncheck();const fallback=await selectedDownload();
 assert.deepEqual(fallback.backup.documents,selectionBefore.documents.filter(doc=>selectedKeys.includes(doc.key)&&doc.key!=='shelf-0'));
 check('unselected_active_falls_back_to_first_selected_shelf_order',fallback.backup.active==='shelf-1'&&fallback.backup.documents.length===11);

 stage='selected backup actual IndexedDB fresh and repeat restore';
 const selectionClean=await newPage();await restore(selectionClean,selected.bytes,12);
 assert.deepEqual((await stored(selectionClean)).documents,selected.backup.documents);
 check('selected_download_fresh_indexeddb_restore_preserves_complete_objects',await selectionClean.locator('#title').textContent()===selectionDocs[0].title);
 await restore(selectionClean,selected.bytes,12);assert.deepEqual((await stored(selectionClean)).documents,selected.backup.documents);
 check('selected_download_repeat_indexeddb_restore_adds_no_duplicates',true);await selectionClean.context().close();

 stage='390px selected backup controls and explicit clearing';
 await selectionPage.setViewportSize({width:390,height:844});await shelf(selectionPage,true);await selectionPage.locator('#library-sort').selectOption('added');await jump(4,selectionPage);await shelf(selectionPage,true);
 await selectionStatus(11,8,'mobile_retains_off_page_selection');
 check('selected_backup_mobile_has_no_horizontal_overflow',await selectionPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 for(const id of ['library-selection-mode','export-selected-library','clear-library-selection'])check(id+'_44px_mobile_target',await selectionPage.locator('#'+id).evaluate(node=>node.getBoundingClientRect().height>=44));
 check('selected_checkbox_has_44px_mobile_label_target',await choice('shelf-149').evaluate(node=>{const r=node.closest('label').getBoundingClientRect();return r.height>=44&&r.width>=44;}));
 check('selected_mobile_long_title_remains_complete',await selectionPage.locator('.library-entry[data-document-key="shelf-149"] .library-title').textContent()===selectionDocs[149].title);
 if(process.env.COCONUT_UI_SCREENSHOTS){
  await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});
  await selectionPage.locator('#library-options').scrollIntoViewIfNeeded();
  await selectionPage.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'selected-library-backup-390-controls.png'),fullPage:false,animations:'disabled'});
 }
 stage='390px last selected checkbox native keyboard and live feedback';
 const mobileDownload=await selectedDownload();assert.deepEqual(mobileDownload.backup,fallback.backup);
 // Start at the last card's ordinary open action. Actual Tab and Shift+Tab own
 // arrival at its checkbox; no test-side checkbox focus or scroll hides overlap.
 const lastEntry=selectionPage.locator('.library-entry[data-document-key="shelf-149"]');
 await lastEntry.locator('.library-open').focus();await selectionPage.keyboard.press('Tab');
 await lastSelectedKeyboardGeometry('forward-tab');
 await selectionPage.keyboard.press('Space');
 check('mobile_space_unchecks_last_document_without_losing_keyboard_focus',!await choice('shelf-149').isChecked()&&await choice('shelf-149').evaluate(node=>node===document.activeElement));
 await selectionStatus(10,8,'mobile_keyboard_deselect_updates_total_and_off_page_counts');
 await selectionPage.keyboard.press('Space');
 check('mobile_space_reselects_last_document_without_losing_keyboard_focus',await choice('shelf-149').isChecked()&&await choice('shelf-149').evaluate(node=>node===document.activeElement));
 await selectionStatus(11,8,'mobile_keyboard_reselect_restores_total_and_off_page_counts');
 await selectionPage.keyboard.press('Tab');
 check('mobile_tab_after_last_checkbox_reaches_its_remove_action',await lastEntry.locator('.library-remove').evaluate(node=>node===document.activeElement));
 await selectionPage.keyboard.press('Shift+Tab');await lastSelectedKeyboardGeometry('reverse-tab');
 if(process.env.COCONUT_UI_SCREENSHOTS){
  // Geometry above is established before capturing; the live toast is untouched.
  await selectionPage.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'selected-library-backup-390-card.png'),fullPage:false,animations:'disabled'});
 }
 await selectionPage.locator('#clear-library-selection').click();await selectionStatus(0,0,'clear_selection_resets_total_and_hidden_counts');
 check('clear_selection_disables_export_and_unchecks_visible_cards',await selectionPage.locator('#export-selected-library').isDisabled()&&!await choice('shelf-149').isChecked());
 await choice('shelf-149').check();await selectionPage.locator('#library-selection-mode').click();
 check('cancel_selection_hides_controls_and_checkboxes',await selectionPage.locator('#library-selection-mode').getAttribute('aria-pressed')==='false'&&!await selectionPage.locator('#library-selection-controls').isVisible()&&await selectionPage.locator('.library-select:visible').count()===0);
 await selectionPage.locator('#library-selection-mode').click();await selectionStatus(0,0,'reentering_selection_does_not_reselect_old_choices');
 check('selection_is_read_only_for_all_150_persisted_documents',JSON.stringify(await stored(selectionPage))===JSON.stringify(selectionBefore));
 await choice('shelf-149').check();await selectionPage.reload();await shelf(selectionPage,true);
 check('reload_starts_with_selection_mode_off',await selectionPage.locator('#library-selection-mode').getAttribute('aria-pressed')==='false'&&!await selectionPage.locator('#library-selection-controls').isVisible());
 await selectionPage.locator('#library-selection-mode').click();await selectionStatus(0,0,'selection_is_not_persisted_across_reload');
 await selectionPage.context().close();
 check('no_external_requests_mutations_or_browser_errors',external===0&&mutations===0&&errors.length===0);
 console.log(JSON.stringify({checks},null,2));
}catch(error){console.error('Large library browser acceptance failed at '+stage);throw error;}
finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());}
