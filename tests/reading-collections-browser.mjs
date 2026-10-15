// Compatibility renderer regression; this suite does not establish default React acceptance.
/** CI-only: authored sources, real individual picks, durable snapshots and downloads.
 * No external requests, models, media, browser traces or user data. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium,waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {openLibraryTools} from './helpers/library-tools-browser.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
import {startBridge} from '../desktop/server.mjs';

const checks=[],errors=[];
let diagnosticPage,contextCount=0;
const pageContexts=new WeakMap();
let browser,server,page,collectionKey,stage='setup',external=0,mutations=0;
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
// Compare authored content using explicit Markdown escaping, while download
// equality below still compares the complete untouched preview and file bytes.
const markdownText=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\\`*_{}\[\]()#+.!|~$-]/g,'\\$&');
const capture=async(p,name)=>{
 if(!process.env.COCONUT_UI_SCREENSHOTS)return;
 await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});
 await p.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'reading-collections-'+name+'.png'),fullPage:false,animations:'disabled'});
};
const disk=async(p=page)=>{await p.evaluate(()=>libraryStore.flush());return p.evaluate(()=>readPersistedLibrary());};
const savedCollection=async(p=page)=>(await disk(p)).documents.find(doc=>doc.key===collectionKey);
async function savedCount(count,p=page){
 await waitForPersistedLibrary(p,async({key,count})=>{const doc=(await readPersistedLibrary()).documents.find(doc=>doc.key===key);return doc?.project_kind==='reading_collection'&&doc.items.length===count;},{key:collectionKey,count});
 if(await p.locator('#collection-select').inputValue()===collectionKey)await p.waitForFunction(()=>document.getElementById('collection-status').dataset.state==='saved');
}
async function openNotebook(p=page){
 diagnosticPage=p;
 if(await p.locator('#library-notebook').evaluate(node=>node.open))return;
 await openLibraryTools(p);await p.locator('#open-library-notebook').click();
 await p.locator('#library-notebook').waitFor({state:'visible'});
}
async function openCollection(p=page){
 await openNotebook(p);
 if(!await p.locator('#collection-tools').evaluate(node=>node.open))await p.locator('#collection-tools > summary').click();
 await p.locator('#collection-select').selectOption(collectionKey);
}
async function sourcePage(title,number,p=page){
 await p.locator('#notebook-search').fill(title);
 await p.waitForFunction(()=>document.getElementById('notebook-captures').getAttribute('aria-busy')==='false');
 // All caller queries differ, except explicit first-page returns below.
 while(!await p.locator('#notebook-previous').isDisabled())await p.locator('#notebook-previous').click();
 for(let index=1;index<number;index++)await p.locator('#notebook-next').click();
 check('source_notebook_rows_stay_bounded_'+checks.length,await p.locator('.notebook-capture').count()<=30);
}
const sourceRow=(key,id,p=page)=>p.locator('.notebook-capture[data-document-key="'+key+'"][data-capture-id="'+id+'"]');
const itemRow=(id,p=page)=>p.locator('.collection-item[data-item-id="'+id+'"]');
async function preview(p=page){await p.locator('#collection-preview-button').click();return p.locator('#collection-preview').textContent();}
async function download(p,selector,keyboard=false){
 const pending=p.waitForEvent('download');
 if(keyboard)await p.keyboard.press('Space');else await p.locator(selector).click();
 const item=await pending;assert.equal(await item.failure(),null);
 return {name:item.suggestedFilename(),bytes:await fs.readFile(await item.path())};
}
async function keyboardGeometry(p,selector,label){
 await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const geometry=await p.locator(selector).evaluate(node=>{
  const rect=node.getBoundingClientRect(),style=getComputedStyle(node),ring=(parseFloat(style.outlineWidth)||0)+Math.max(0,parseFloat(style.outlineOffset)||0);
  const dialog=document.getElementById('library-notebook').getBoundingClientRect(),middleX=(rect.left+rect.right)/2,middleY=(rect.top+rect.bottom)/2;
  const hitPoints=[[middleX,middleY],[rect.left+1,middleY],[rect.right-1,middleY],[middleX,rect.top+1],[middleX,rect.bottom-1]].map(([x,y])=>{const hit=document.elementFromPoint(x,y);return {x,y,hit:hit===node||node.contains(hit)};});
  return {focused:document.activeElement===node,focusVisible:node.matches(':focus-visible'),outlineStyle:style.outlineStyle,ring,rect:rect.toJSON(),dialog:dialog.toJSON(),hitPoints,viewport:{width:innerWidth,height:innerHeight},pageWidth:document.documentElement.scrollWidth,dialogWidth:document.getElementById('library-notebook').scrollWidth,dialogClientWidth:document.getElementById('library-notebook').clientWidth,status:document.getElementById('collection-status').textContent};
 });
 console.log(JSON.stringify({suite:'reading-collections-keyboard-geometry',label,...geometry}));
 const {rect:r,ring,dialog,viewport}=geometry;
 const clear=geometry.focused&&geometry.focusVisible&&geometry.outlineStyle!=='none'&&ring>0&&r.width>=44&&r.height>=44&&
  r.left-ring>=Math.max(0,dialog.left)&&r.right+ring<=Math.min(viewport.width,dialog.right)&&r.top-ring>=Math.max(0,dialog.top)&&r.bottom+ring<=Math.min(viewport.height,dialog.bottom)&&
  geometry.pageWidth<=viewport.width&&geometry.dialogWidth<=geometry.dialogClientWidth+1&&geometry.hitPoints.every(point=>point.hit);
 if(!clear)await capture(p,label+'-geometry-failure');
 check(label+'_complete_focus_ring_and_five_hit_points_inside_mobile_dialog',clear);
}
try{
 server=await startBridge({port:0});const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 async function newPage(viewport={width:1280,height:900}){
  const context=await browser.newContext({viewport,acceptDownloads:true,serviceWorkers:'block'});
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(!['GET','HEAD'].includes(request.method())){mutations++;await route.abort();}else if(url.origin===origin||['blob:','data:'].includes(url.protocol))await route.continue();else{external++;await route.abort();}});
  const p=await context.newPage();pageContexts.set(p,'context-'+(++contextCount));p.setDefaultTimeout(20000);p.on('pageerror',error=>errors.push({message:error.message,stack:error.stack,url:p.url(),context:pageContexts.get(p)}));diagnosticPage=p;await p.goto(origin+'/compatibility.html');return p;
 }
 page=await newPage();
 const docs=largeLibraryFixture(2,{cues:65});
 for(const [documentIndex,doc] of docs.entries()){
  doc.title='Collection authored source '+(documentIndex?'B':'A');
  for(const [index,cue] of doc.segments.entries()){cue.saved_excerpt=true;cue.text='COLLECTION '+(documentIndex?'B':'A')+' SOURCE '+String(index).padStart(3,'0')+' original passage.';}
 }
 docs[0].notes[docs[0].segments[0].id]='Original retained A note, chosen before the source was edited.';
 docs[1].notes[docs[1].segments[64].id]='Original retained B final note.';
 await page.locator('#library-file').setInputFiles({name:'authored-collection-sources.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({format:'coconut-library',version:1,documents:docs,active:docs[0].key}))});
 await page.waitForFunction(()=>document.getElementById('library-file').value==='');
 await waitForPersistedLibrary(page,async()=>(await readPersistedLibrary()).documents.length===2);
 const originalSources=(await disk()).documents,readerTitle=await page.locator('#title').textContent();

 stage='create and rename a durable empty collection';await openNotebook();
 check('collections_are_opt_in',!await page.locator('#collection-tools').evaluate(node=>node.open)&&await page.locator('.collection-add:visible').count()===0);
 await page.locator('#collection-tools > summary').click();await page.locator('#collection-title').fill('Authored first collection');await page.locator('#collection-save-title').click();
 collectionKey=await page.locator('#collection-select').inputValue();check('creation_selects_a_saved_collection_identity',Boolean(collectionKey));await savedCount(0);
 check('empty_collection_cannot_preview_or_export',await page.locator('#collection-preview-button').isDisabled()&&await page.locator('#collection-export').isDisabled());
 const collectionTitle='Authored reading collection · 原创复习精选';await page.locator('#collection-title').fill(collectionTitle);await page.locator('#collection-save-title').click();
 await waitForPersistedLibrary(page,async({key,title})=>(await readPersistedLibrary()).documents.find(doc=>doc.key===key)?.title===title,{key:collectionKey,title:collectionTitle});
 check('collection_creation_does_not_switch_the_reader',await page.locator('#title').textContent()===readerTitle);

 stage='22 individual picks across source pages and documents';await sourcePage(docs[0].title,1);
 for(let index=0;index<20;index++){
  await sourceRow(docs[0].key,docs[0].segments[index].id).locator('.collection-add').click();await savedCount(index+1);
 }
 check('individual_picks_do_not_select_whole_document_export',await page.locator('#notebook-export').isDisabled()&&await page.locator('.notebook-capture input:checked').count()===0);
 const alreadyAdded=sourceRow(docs[0].key,docs[0].segments[0].id).locator('.collection-add');
 check('already_selected_capture_remains_accessibly_marked',await alreadyAdded.getAttribute('aria-disabled')==='true'&&await alreadyAdded.textContent()==='已加入成果集');
 await alreadyAdded.focus();await page.keyboard.press('Space');
 check('native_repeat_activation_cannot_add_a_duplicate_pick',(await savedCollection()).items.length===20&&await alreadyAdded.evaluate(node=>node===document.activeElement));
 await sourcePage(docs[0].title,3);check('late_source_page_reaches_last_five_records',await page.locator('.notebook-capture').count()===5);
 await sourceRow(docs[0].key,docs[0].segments[64].id).locator('.collection-add').click();await savedCount(21);
 await sourcePage(docs[1].title,3);await sourceRow(docs[1].key,docs[1].segments[64].id).locator('.collection-add').click();await savedCount(22);
 const picked=await savedCollection(),origins=[...Array.from({length:20},(_,i)=>[docs[0].key,docs[0].segments[i].id]),[docs[0].key,docs[0].segments[64].id],[docs[1].key,docs[1].segments[64].id]];
 assert.deepEqual(picked.items.map(item=>[item.origin.documentKey,item.origin.id]),origins);
 check('only_explicit_individual_records_are_saved',picked.items.length===22&&await page.locator('.collection-item').count()===20&&await page.locator('#collection-status').getAttribute('data-state')==='saved');
 assert.deepEqual((await disk()).documents.filter(doc=>doc.project_kind!=='reading_collection'),originalSources);
 check('picking_keeps_both_source_documents_unchanged',true);

 stage='collection paging ordering and removal';await page.locator('#collection-next').click();
 assert.deepEqual(await page.locator('.collection-item').evaluateAll(rows=>rows.map(row=>row.dataset.itemId)),picked.items.slice(20).map(item=>item.id));
 const lateA=picked.items[20],lateB=picked.items[21];await itemRow(lateB.id).locator('.collection-up').click();
 await waitForPersistedLibrary(page,async({key,id})=>(await readPersistedLibrary()).documents.find(doc=>doc.key===key)?.items[20]?.id===id,{key:collectionKey,id:lateB.id});
 assert.deepEqual(await page.locator('.collection-item').evaluateAll(rows=>rows.map(row=>row.dataset.itemId)),[lateB.id,lateA.id]);
 check('reorder_keeps_focus_on_the_exact_moved_item',await itemRow(lateB.id).locator('.collection-up').evaluate(node=>node===document.activeElement));
 await page.locator('#collection-previous').click();await itemRow(picked.items[18].id).locator('.collection-remove').click();await savedCount(21);
 const curated=await savedCollection(),expectedItems=[...picked.items.slice(0,18),picked.items[19],lateB,lateA];assert.deepEqual(curated.items,expectedItems);
 check('removing_a_pick_preserves_the_deliberate_remaining_order',true);
 await page.locator('#collection-next').click();assert.deepEqual(await page.locator('.collection-item').evaluateAll(rows=>rows.map(row=>row.dataset.itemId)),[lateA.id]);
 check('collection_last_page_is_bounded_and_next_is_disabled',await page.locator('.collection-item').count()===1&&await page.locator('#collection-next').isDisabled());
 await page.locator('#notebook-search').fill('No source record matches this authored query');
 check('empty_source_query_keeps_all_collection_picks_available',await page.locator('.notebook-capture').count()===0&&!await page.locator('#collection-export').isDisabled());

 stage='full preview and actual individually scoped Markdown';const initialPreview=await preview();
 check('preview_uses_the_saved_collection_name',initialPreview.includes(markdownText(collectionTitle)));
 let previous=-1;for(const item of expectedItems){const position=initialPreview.indexOf(markdownText(item.snapshot.text));assert.ok(position>previous,'preview preserves each chosen full passage in personal order');previous=position;}
 for(const cue of [docs[0].segments[18],docs[0].segments[20],docs[0].segments[63],docs[1].segments[0]])assert.ok(!initialPreview.includes(markdownText(cue.text)),'unselected or removed captures stay out of preview');
 check('preview_has_only_chosen_records_in_personal_order',initialPreview.includes(markdownText(docs[0].notes[docs[0].segments[0].id]))&&initialPreview.includes(markdownText(docs[1].notes[docs[1].segments[64].id])));
 const markdown=await download(page,'#collection-export');assert.equal(markdown.name,'coconut-collection.md');assert.equal(markdown.bytes.toString('utf8'),initialPreview);
 check('actual_markdown_download_matches_the_complete_preview',true);

 stage='reload durable collection without rewriting sources';await page.locator('#notebook-close').click();await page.reload();
 assert.deepEqual(await savedCollection(),curated);assert.deepEqual((await disk()).documents.filter(doc=>doc.project_kind!=='reading_collection'),originalSources);
 check('reload_preserves_exact_collection_snapshots_order_and_source_documents',true);
 await openCollection();assert.equal(await page.locator('#collection-title').inputValue(),collectionTitle);assert.equal(await preview(),initialPreview);
 check('ordinary_shelf_does_not_expose_collection_as_a_transcript',await page.locator('.library-entry[data-document-key="'+collectionKey+'"]').count()===0);

 stage='390px native keyboard export and complete target geometry';await page.setViewportSize({width:390,height:844});
 await page.locator('#collection-preview-button').focus();await page.keyboard.press('Tab');await keyboardGeometry(page,'#collection-export','390-forward-tab');
 await page.keyboard.press('Shift+Tab');await keyboardGeometry(page,'#collection-preview-button','390-reverse-tab');
 await page.keyboard.press('Tab');const keyboardDownload=await download(page,'#collection-export',true);assert.equal(keyboardDownload.bytes.toString('utf8'),initialPreview);
 await keyboardGeometry(page,'#collection-export','390-export-after-space');await capture(page,'390-keyboard-export');
 check('native_space_downloads_only_the_current_collection',keyboardDownload.name==='coconut-collection.md');

 stage='actual JSON backup fresh-context collection recovery';await page.locator('#notebook-close').click();await openLibraryTools(page);
 if(!await page.locator('.library-backup').evaluate(node=>node.open))await page.locator('.library-backup > summary').click();
 const jsonDownload=await download(page,'#export-library'),libraryBackup=JSON.parse(jsonDownload.bytes);
 assert.deepEqual(libraryBackup.documents.find(doc=>doc.key===collectionKey),curated);
 const fresh=await newPage({width:390,height:844});
 await fresh.locator('#library-file').setInputFiles({name:'actual-collection-library.json',mimeType:'application/json',buffer:jsonDownload.bytes});
 await fresh.waitForFunction(()=>document.getElementById('library-file').value==='');await savedCount(21,fresh);
 assert.deepEqual(await savedCollection(fresh),curated);await openCollection(fresh);assert.equal(await preview(fresh),initialPreview);
 check('actual_json_download_restores_complete_collection_in_fresh_context',true);
 await fresh.locator('#notebook-close').click();
 await fresh.locator('#library-file').setInputFiles({name:'actual-collection-library.json',mimeType:'application/json',buffer:jsonDownload.bytes});
 await fresh.waitForFunction(()=>document.getElementById('library-file').value==='');
 assert.equal((await disk(fresh)).documents.length,3);assert.deepEqual(await savedCollection(fresh),curated);
 check('repeat_actual_json_restore_does_not_duplicate_collections_or_sources',true);await fresh.context().close();

 stage='source edits retain chosen historical snapshots';await openCollection();await sourcePage(docs[0].title,1);
 await sourceRow(docs[0].key,docs[0].segments[0].id).locator('.notebook-open').click();await page.locator('#note').waitFor({state:'visible'});
 const newerNote='Newer source note deliberately excluded from the saved collection';await page.locator('#note').fill(newerNote);await page.locator('#close-note').click();
 await waitForPersistedLibrary(page,async({key,id,note})=>(await readPersistedLibrary()).documents.find(doc=>doc.key===key)?.notes[id]===note,{key:docs[0].key,id:docs[0].segments[0].id,note:newerNote});
 await page.locator('#return-library-notebook').click();
 if(!await page.locator('#collection-tools').evaluate(node=>node.open))await page.locator('#collection-tools > summary').click();
 await page.locator('#collection-select').selectOption(collectionKey);
 const afterEdit=await preview();assert.deepEqual((await savedCollection()).items,expectedItems);
 check('source_edit_cannot_silently_replace_curated_text_or_personal_note',afterEdit.includes(markdownText(docs[0].notes[docs[0].segments[0].id]))&&!afterEdit.includes(markdownText(newerNote)));
 check('snapshots_are_honestly_labeled_as_historical',await page.locator('.collection-history').evaluateAll(nodes=>nodes.every(node=>node.textContent.includes('历史记录，未重新核对来源'))));

 stage='source deletion retains historical collection and export';await page.locator('#notebook-close').click();await openLibraryTools(page);
 if(!await page.locator('#library-options').evaluate(node=>node.open))await page.locator('#library-options > summary').click();
 await page.locator('.library-entry[data-document-key="'+docs[0].key+'"] .library-remove').click();await page.locator('#confirm-removal').click();
 await waitForPersistedLibrary(page,async key=>!(await readPersistedLibrary()).documents.some(doc=>doc.key===key),docs[0].key);
 await page.locator('#undo-removal').waitFor({state:'visible'});await openCollection();
 assert.deepEqual((await savedCollection()).items,expectedItems);
 const historical=await preview();check('deleted_source_preserves_full_original_text_note_and_other_document_pick',historical.includes(markdownText(docs[0].segments[0].text))&&historical.includes(markdownText(docs[0].notes[docs[0].segments[0].id]))&&historical.includes(markdownText(docs[1].segments[64].text))&&!historical.includes(markdownText(newerNote)));
 check('deleted_source_has_visible_missing_source_explanation',await page.locator('.collection-history').evaluateAll(nodes=>nodes.some(node=>node.textContent.includes('本书架无此来源'))));
 const historicalDownload=await download(page,'#collection-export');assert.equal(historicalDownload.bytes.toString('utf8'),historical);
 await page.locator('#collection-preview-button').focus();await page.keyboard.press('Tab');await keyboardGeometry(page,'#collection-export','390-historical-export');await capture(page,'390-historical-export');
 // A normal reload retains the recovery warning. Accept its real browser dialog
 // only for this authored deletion; no storage or document content is cleared.
 await page.locator('#notebook-close').click();let warned=false;page.once('dialog',async dialog=>{assert.equal(dialog.type(),'beforeunload');warned=true;await dialog.accept();});await page.reload();
 check('reload_warns_that_source_undo_is_session_only',warned);assert.deepEqual((await savedCollection()).items,expectedItems);await openCollection();assert.equal(await preview(),historical);
 check('historical_collection_survives_reload_after_source_deletion',true);

 stage='collection-only JSON recovery and no remaining source documents';
 const collectionJson=await download(page,'#collection-backup'),singleBackup=JSON.parse(collectionJson.bytes);
 check('individual_collection_backup_excludes_all_source_documents',collectionJson.name==='coconut-collection.json'&&singleBackup.documents.length===1&&singleBackup.active===null);
 assert.deepEqual(singleBackup.documents[0],curated);
 const collectionOnly=await newPage({width:390,height:844});
 await collectionOnly.locator('#library-file').setInputFiles({name:'actual-single-collection.json',mimeType:'application/json',buffer:collectionJson.bytes});
 await collectionOnly.waitForFunction(()=>document.getElementById('library-file').value==='');await savedCount(21,collectionOnly);
 assert.equal((await disk(collectionOnly)).documents.length,1);await openCollection(collectionOnly);
 check('collection_only_restore_is_accessible_without_an_active_transcript',await collectionOnly.locator('.library-entry').count()===0&&(await preview(collectionOnly)).includes(markdownText(docs[1].notes[docs[1].segments[64].id])));
 assert.deepEqual((await savedCollection(collectionOnly)).items,expectedItems);

 stage='removed collection actual rescue download and fresh restore';
 await collectionOnly.locator('#collection-delete').click();
 check('collection_delete_uses_existing_confirmation',!await collectionOnly.locator('#library-notebook').evaluate(node=>node.open)&&await collectionOnly.locator('#remove-document-dialog').isVisible());
 await collectionOnly.locator('#confirm-removal').click();
 await waitForPersistedLibrary(collectionOnly,async()=>(await readPersistedLibrary()).documents.length===0);
 await collectionOnly.locator('#undo-removal').waitFor({state:'visible'});
 if(!await collectionOnly.locator('#removal-recovery-details').evaluate(node=>node.open))await collectionOnly.locator('#removal-recovery-details > summary').click();
 const removedCollection=await download(collectionOnly,'#export-removed-document'),removedEnvelope=JSON.parse(removedCollection.bytes);
 assert.equal(removedCollection.name,'coconut-removed-document.json');
 assert.deepEqual(removedEnvelope,{format:'coconut-library',version:1,documents:[curated],active:null});
 check('removed_collection_download_is_a_complete_restorable_library_envelope',true);
 const rescuedCollection=await newPage({width:390,height:844});
 await rescuedCollection.locator('#library-file').setInputFiles({name:'actual-removed-collection.json',mimeType:'application/json',buffer:removedCollection.bytes});
 await rescuedCollection.waitForFunction(()=>document.getElementById('library-file').value==='');await savedCount(21,rescuedCollection);
 assert.deepEqual((await disk(rescuedCollection)).documents,[curated]);assert.deepEqual((await savedCollection(rescuedCollection)).items,expectedItems);
 await openCollection(rescuedCollection);
 check('removed_collection_actual_download_restores_all_snapshots_without_sources',(await preview(rescuedCollection)).includes(markdownText(docs[1].notes[docs[1].segments[64].id]))&&await rescuedCollection.locator('.library-entry').count()===0);
 await rescuedCollection.context().close();await collectionOnly.context().close();

 stage='deleting all sources keeps the historical collection accessible';
 await page.locator('#notebook-close').click();await openLibraryTools(page);
 if(!await page.locator('#library-options').evaluate(node=>node.open))await page.locator('#library-options > summary').click();
 await page.locator('.library-entry[data-document-key="'+docs[1].key+'"] .library-remove').click();await page.locator('#confirm-removal').click();
 await waitForPersistedLibrary(page,async key=>{const saved=(await readPersistedLibrary()).documents;return saved.length===1&&saved[0].key===key;},collectionKey);
 await page.locator('#undo-removal').waitFor({state:'visible'});await openCollection();
 assert.deepEqual((await savedCollection()).items,expectedItems);
 check('deleting_all_sources_keeps_collection_accessible_and_every_snapshot_missing',await page.locator('.library-entry').count()===0&&await page.locator('.collection-history').evaluateAll(nodes=>nodes.length>0&&nodes.every(node=>node.textContent.includes('本书架无此来源'))));
 const noSourcesPreview=await preview();assert.ok(noSourcesPreview.includes(markdownText(docs[0].segments[0].text))&&noSourcesPreview.includes(markdownText(docs[1].segments[64].text)));
 await page.locator('#notebook-close').click();page.once('dialog',async dialog=>{assert.equal(dialog.type(),'beforeunload');await dialog.accept();});await page.reload();await openCollection();
 assert.equal(await preview(),noSourcesPreview);assert.deepEqual((await savedCollection()).items,expectedItems);
 check('collection_reopens_after_reload_with_all_source_documents_deleted',true);
 check('no_external_requests_mutations_or_page_errors',external===0&&mutations===0&&errors.length===0);
 console.log(JSON.stringify({suite:'reading-collections',status:'passed',checks}));
}catch(error){
 const failurePage=diagnosticPage&&!diagnosticPage.isClosed()?diagnosticPage:page;
 const probe=await failurePage?.evaluate(()=>({collectionState:document.getElementById('collection-status')?.dataset.state,collectionStatus:document.getElementById('collection-status')?.textContent,collectionCount:document.getElementById('collection-count')?.textContent,collectionRows:document.querySelectorAll('.collection-item').length,notebookRows:document.querySelectorAll('.notebook-capture').length,notebookOpen:document.getElementById('library-notebook')?.open,shelfExpanded:document.getElementById('toggle-library')?.getAttribute('aria-expanded'),notebookButtonRect:document.getElementById('open-library-notebook')?.getBoundingClientRect().toJSON(),activeId:document.activeElement?.id||'',activeClass:document.activeElement?.className||''})).catch(()=>null);
 console.error(JSON.stringify({suite:'reading-collections',status:'failed',stage,context:pageContexts.get(failurePage),checks,probe,errors,error:error.message}));
 if(failurePage&&!failurePage.isClosed())await capture(failurePage,'failure').catch(()=>{});
 process.exitCode=1;
}finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());}
