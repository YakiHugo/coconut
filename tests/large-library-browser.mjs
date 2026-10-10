import {openLibraryTools} from './helpers/library-tools-browser.mjs';
/** CI-only native browser journey. Authored fixtures, no model/media/external requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
 async function jump(number){await shelf();await openLibraryTools(page);await page.locator('#library-page-number').fill(String(number));await page.locator('#library-page-number').press('Enter');await page.waitForFunction(()=>document.activeElement?.classList.contains('library-open'));}
 async function stored(p=page){await p.evaluate(()=>libraryStore.flush());return p.evaluate(()=>readPersistedLibrary());}
 async function restore(p,buffer){await p.locator('#library-file').setInputFiles({name:'authored-large-shelf.json',mimeType:'application/json',buffer});await waitForPersistedLibrary(p,async()=>(await readPersistedLibrary()).documents.length===1001,undefined,{timeout:20000});}
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
 check('no_external_requests_mutations_or_browser_errors',external===0&&mutations===0&&errors.length===0);
 console.log(JSON.stringify({checks},null,2));
}catch(error){console.error('Large library browser acceptance failed at '+stage);throw error;}
finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());}
