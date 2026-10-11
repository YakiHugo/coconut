/** CI-only authored bilingual selections, native audio and real backup recovery. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium,waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {openLibraryTools} from './helpers/library-tools-browser.mjs';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
import {startBridge} from '../desktop/server.mjs';
if(!process.env.CI)throw Error('Bilingual excerpt browser acceptance is CI-only');
let server,browser,page,diagnosticPage,stage='setup',external=0,mutations=0;
const checks=[],errors=[],key='authored-bilingual';
const fixture={key,title:'Authored bilingual course',schema_version:1,language:'en',translation_view:'zh',readingPosition:'a',notes:{},segments:['First original words','Second original words','Third original words'].map((text,i)=>({id:['a','b','c'][i],text,start:i*2,end:i*2+2,speaker:'A',translations:{zh:{text:['第一段译文','第二段译文','第三段译文'][i],source_text:text,source_language:'en',provider:'authored_fixture'}}}))};
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
async function capture(p,label){
 if(!process.env.COCONUT_UI_SCREENSHOTS)return;
 await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});
 await p.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'bilingual-excerpts-'+label+'.png'),fullPage:false,animations:'disabled'});
}
async function disk(p=page){await p.evaluate(()=>libraryStore.flush());return p.evaluate(()=>readPersistedLibrary());}
async function importBackup(p,bytes){
 diagnosticPage=p;
 await p.locator('#library-file').setInputFiles({name:'authored-bilingual.json',mimeType:'application/json',buffer:bytes});
 await p.waitForFunction(()=>document.getElementById('library-file').value==='');
 await waitForPersistedLibrary(p,async()=> (await readPersistedLibrary()).documents.length>0);
}
async function notebook(p=page){
 diagnosticPage=p;if(await p.locator('#library-notebook').evaluate(node=>node.open))return;
 await openLibraryTools(p);await p.locator('#open-library-notebook').click();await p.locator('#library-notebook').waitFor({state:'visible'});
}
async function collectionTools(p=page){if(!await p.locator('#collection-tools').evaluate(node=>node.open))await p.locator('#collection-tools > summary').click();}
async function download(p,selector){const pending=p.waitForEvent('download');await p.locator(selector).click();const file=await pending;assert.equal(await file.failure(),null);return fs.readFile(await file.path());}
async function geometry(selector,label){
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const value=await page.locator(selector).evaluate(node=>{
  const target=node.closest('label')||node,r=target.getBoundingClientRect(),input=node.getBoundingClientRect(),style=getComputedStyle(node),ring=(parseFloat(style.outlineWidth)||0)+Math.max(0,parseFloat(style.outlineOffset)||0),dialog=document.getElementById('quotation-dialog').getBoundingClientRect();
  const bounds={left:Math.min(r.left,input.left-ring),right:Math.max(r.right,input.right+ring),top:Math.min(r.top,input.top-ring),bottom:Math.max(r.bottom,input.bottom+ring)};
  return {focused:node===document.activeElement,focusVisible:node.matches(':focus-visible'),ring,rect:r.toJSON(),bounds,dialog:dialog.toJSON(),viewport:{width:innerWidth,height:innerHeight},hits:[[r.x+r.width/2,r.y+r.height/2],[r.left+1,r.y+r.height/2],[r.right-1,r.y+r.height/2],[r.x+r.width/2,r.top+1],[r.x+r.width/2,r.bottom-1]].map(([x,y])=>{const hit=document.elementFromPoint(x,y);return {x,y,clear:hit===target||target.contains(hit),hit:hit?{id:hit.id,tag:hit.tagName,className:hit.className}:null};})};
 });
 console.log(JSON.stringify({suite:'bilingual-keyboard-geometry',label,...value}));
 const b=value.bounds,d=value.dialog,v=value.viewport,ok=value.focused&&value.focusVisible&&value.ring>0&&value.rect.height>=44&&b.left>=Math.max(0,d.left)&&b.right<=Math.min(v.width,d.right)&&b.top>=Math.max(0,d.top)&&b.bottom<=Math.min(v.height,d.bottom)&&value.hits.every(hit=>hit.clear);
 if(!ok)await capture(page,label+'-failure');check(label+'_full_target_ring_and_five_hit_points',ok);
}
try{
 server=await startBridge({port:0});const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 async function fresh(){
  const context=await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true,serviceWorkers:'block'});
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(!['GET','HEAD'].includes(request.method())){mutations++;return route.abort();}if(url.origin===origin||['blob:','data:'].includes(url.protocol))return route.continue();external++;return route.abort();});
  await context.addInitScript(()=>{window.pairedMediaProof={plays:0,seeks:0};document.addEventListener('play',()=>window.pairedMediaProof.plays++,true);document.addEventListener('seeking',()=>window.pairedMediaProof.seeks++,true);});
  const p=await context.newPage();p.setDefaultTimeout(20000);p.on('pageerror',error=>errors.push({message:error.message,stack:error.stack,url:p.url()}));diagnosticPage=p;await p.goto(origin);return p;
 }
 page=await fresh();await importBackup(page,Buffer.from(JSON.stringify({format:'coconut-library',version:1,documents:[fixture],active:key})));
 if(!await page.locator('#attach-reader-media').isVisible())await page.locator('#toggle-reader-media').click();
 const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-reader-media').click()]);
 await chooser.setFiles({name:'authored-bilingual-tone.wav',mimeType:'audio/wav',buffer:authoredAudioFixture()});
 await page.waitForFunction(()=>{const player=document.querySelector('#source-media audio');return player&&!player.error&&player.readyState>=2;});
 await page.evaluate(()=>{window.pairedMediaProof.player=document.querySelector('#source-media audio');});await page.locator('#close-reader-media').click();
 const baseline=(await disk()).documents[0];
 stage='native independent original and translation selections';
 await page.locator('#mode-passages').click();const quote=page.locator('.passage-quote').first();await quote.click();
 await page.locator('#quotation-source').focus();await page.keyboard.press('Control+Home');for(let i=0;i<5;i++)await page.keyboard.press('Shift+ArrowRight');
 await page.locator('#quotation-preview-selection').click();await page.locator('#quotation-pair-start').click();
 await page.keyboard.press('Control+Home');await page.keyboard.press('ArrowRight');await page.keyboard.press('Control+Shift+End');await page.keyboard.press('Shift+ArrowLeft');await page.keyboard.press('Tab');
 check('translation_selection_tabs_to_preview',await page.locator('#quotation-pair-preview').evaluate(node=>node===document.activeElement));await page.keyboard.press('Enter');
 assert.equal(await page.locator('#quotation-pair-text').inputValue(),'一段译文第二段译文第三段译');check('pairing_requires_explicit_confirmations',await page.locator('#quotation-save').isDisabled());
 await page.keyboard.press('Tab');await geometry('#quotation-pair-confirm','390-correspondence-confirm');await page.keyboard.press('Space');await page.keyboard.press('Tab');await geometry('#quotation-pair-compatibility','390-version-warning');await capture(page,'390-confirmation-keyboard');await page.keyboard.press('Space');
 stage='native modal boundary and retained Escape draft';
 await page.keyboard.press('Escape');await page.locator('#quotation-dialog').waitFor({state:'hidden'});await quote.click();assert.equal(await page.locator('#quotation-pair-text').inputValue(),'一段译文第二段译文第三段译');
 await page.locator('#quotation-preview').focus();await page.keyboard.press('Shift+Tab');check('first_reverse_tab_wraps_to_last_control',await page.locator('#quotation-reselect').evaluate(node=>node===document.activeElement));await page.keyboard.press('Tab');check('last_forward_tab_wraps_to_first_control',await page.locator('#quotation-preview').evaluate(node=>node===document.activeElement));
 stage='save immutable bilingual evidence';
 await page.locator('#quotation-save').click();await waitForPersistedLibrary(page,async()=> (await readPersistedLibrary()).documents[0]?.exact_excerpts?.length===1);
 const saved=(await disk()).documents[0],record=saved.exact_excerpts[0];assert.equal(record.version,2);assert.equal(record.text,'First');assert.equal(record.translation.text,'一段译文第二段译文第三段译');assert.equal(record.translation.cues.length,3);assert.deepEqual(saved.segments,baseline.segments);assert.deepEqual(saved.notes,baseline.notes);assert.equal(saved.readingPosition,baseline.readingPosition);check('independent_ranges_and_unchanged_source_preserved',true);await page.locator('#quotation-close').click();
 stage='notebook, personal note and curated collection preserve both languages';
 await notebook();const row=page.locator('.notebook-capture[data-capture-id="'+record.id+'"]');await row.locator('.notebook-details > summary').click();assert.ok((await row.locator('.notebook-paired-translation').textContent()).includes(record.translation.text));
 await row.locator('.notebook-edit-exact-note').click();await page.locator('#exact-note-text').fill('My authored bilingual thought');await page.locator('#exact-note-save').click();await page.waitForFunction(()=>document.getElementById('exact-note-status').textContent==='已保存到本机');await page.locator('#exact-note-close').click();
 await collectionTools();await page.locator('#collection-title').fill('Bilingual course selections');await page.locator('#collection-save-title').click();await row.locator('.collection-add').click();
 const collection=(await disk()).documents.find(doc=>doc.project_kind==='reading_collection');assert.equal(collection.items.length,1);assert.deepEqual(collection.items[0].snapshot.exact_excerpt,record);await page.locator('#collection-preview-button').click();assert.ok((await page.locator('#collection-preview').textContent()).includes(record.translation.text));const markdown=await download(page,'#collection-export');assert.ok(markdown.toString().includes(record.translation.text));check('collection_actual_markdown_contains_selected_translation',true);
 stage='actual full JSON download and fresh-context exact recovery';
 await page.locator('#notebook-close').click();await openLibraryTools(page);if(!await page.locator('.library-backup').evaluate(node=>node.open))await page.locator('.library-backup > summary').click();
 const bytes=await download(page,'#export-library'),backup=JSON.parse(bytes),expected=await disk();assert.deepEqual(backup.documents,expected.documents);
 const restored=await fresh();await importBackup(restored,bytes);assert.deepEqual((await disk(restored)).documents,expected.documents);await importBackup(restored,bytes);assert.deepEqual((await disk(restored)).documents,expected.documents);await notebook(restored);const restoredRow=restored.locator('.notebook-capture[data-capture-id="'+record.id+'"]');await restoredRow.locator('.notebook-details > summary').click();assert.ok((await restoredRow.locator('.notebook-paired-translation').textContent()).includes(record.translation.text));check('fresh_repeat_restore_keeps_full_paired_record_and_note',true);await capture(restored,'390-restored-bilingual-card');
 stage='historical snapshot after source translations change or disappear';diagnosticPage=page;
 await page.evaluate(()=>{const doc=state.documents.find(doc=>doc.key==='authored-bilingual');doc.segments[0].text='Changed original';delete doc.segments[0].translations;queueDocument(doc);render();});
 assert.deepEqual((await disk()).documents.find(doc=>doc.key===key).exact_excerpts[0],record);await notebook();const historical=page.locator('.notebook-capture[data-capture-id="'+record.id+'"]');await historical.locator('.notebook-details > summary').click();assert.ok((await historical.locator('.notebook-paired-translation').textContent()).includes(record.translation.text));check('historical_card_does_not_follow_changed_source_or_translation',true);await capture(page,'390-historical-bilingual-card');
 check('no_media_activity_before_source_removal',await page.evaluate(()=>window.pairedMediaProof.player===document.querySelector('#source-media audio')&&window.pairedMediaProof.player.paused&&window.pairedMediaProof.player.currentTime===0&&window.pairedMediaProof.plays===0&&window.pairedMediaProof.seeks===0));
 stage='source removal and collection-only bilingual recovery';
 await page.locator('#notebook-close').click();await openLibraryTools(page);if(!await page.locator('#library-options').evaluate(node=>node.open))await page.locator('#library-options > summary').click();await page.locator('.library-entry[data-document-key="'+key+'"] .library-remove').click();await page.locator('#confirm-removal').click();await waitForPersistedLibrary(page,async()=>!(await readPersistedLibrary()).documents.some(doc=>doc.key==='authored-bilingual'));
 await notebook();await collectionTools();await page.locator('#collection-select').selectOption(collection.key);await page.locator('#collection-preview-button').click();assert.ok((await page.locator('#collection-preview').textContent()).includes(record.translation.text));
 const onlyBytes=await download(page,'#collection-backup'),only=await fresh();await importBackup(only,onlyBytes);assert.deepEqual((await disk(only)).documents,[collection]);await notebook(only);await collectionTools(only);await only.locator('#collection-select').selectOption(collection.key);await only.locator('#collection-preview-button').click();assert.ok((await only.locator('#collection-preview').textContent()).includes(record.translation.text));check('collection_only_backup_retains_bilingual_snapshot_without_any_source',true);await capture(only,'390-collection-only');diagnosticPage=page;
 check('no_media_activity_or_external_requests_or_page_errors',await page.evaluate(()=>window.pairedMediaProof.plays===0&&window.pairedMediaProof.seeks===0)&&external===0&&mutations===0&&errors.length===0);console.log(JSON.stringify({suite:'bilingual-excerpts',status:'passed',checks}));
}catch(error){
 const probe=await diagnosticPage?.evaluate(()=>({activeId:document.activeElement?.id,dialog:document.getElementById('quotation-dialog')?.open,status:document.getElementById('quotation-status')?.textContent,pairStatus:document.getElementById('quotation-pair-status')?.textContent,saveStatus:document.getElementById('quotation-save-status')?.textContent,original:document.getElementById('quotation-source')?.selectionStart,translation:[document.getElementById('quotation-pair-source')?.selectionStart,document.getElementById('quotation-pair-source')?.selectionEnd]})).catch(()=>null);
 console.error(JSON.stringify({suite:'bilingual-excerpts',status:'failed',stage,checks,errors,probe,error:{message:error.message,stack:error.stack}}));if(diagnosticPage)await capture(diagnosticPage,'failure').catch(()=>{});process.exitCode=1;
}finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());}
