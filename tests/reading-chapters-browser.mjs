/** CI-only native chapter journey. Authored text/translations and a tone-only WAV.
 * No external services, models, browser traces, recordings or user material. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium,waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {openTranscriptTools} from './helpers/reading-tools-browser.mjs';
import {openCueActions} from './cue-actions-browser.mjs';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
import {startBridge} from '../desktop/server.mjs';

const checks=[],errors=[];
let browser,server,directory,page,diagnosticPage,stage='setup',external=0,mutations=0;
const key='authored-chapter-document',cueId=index=>'chapter-cue-'+index;
const fixture={key,schema_version:1,title:'Authored manual chapter navigation · 完整原稿',language:'en',translation_view:'zh',readingPosition:cueId(19),notes:{[cueId(150)]:'Authored note remains independent of chapter naming'},segments:Array.from({length:260},(_,index)=>{
 const text='Authored chapter cue '+index+' '+(index<200?'filter marker':'other source')+'.';
 return {id:cueId(index),start:index*.5,end:index*.5+.45,text,speaker:index<200?'Mina':'Leo',...(index<200?{saved_excerpt:true}:{}),translations:{zh:{text:'自写译文 '+index,source_text:text,source_language:'en',document_language:'en',provider:'authored_fixture'}}};
})};
// The target is near the end of a paragraph containing a tall preceding cue.
// Focusing just the passage container would leave this exact cue below the fold.
fixture.segments[219].text='章前原文不能因定位而被修改'.repeat(48);
fixture.segments[219].translations.zh.source_text=fixture.segments[219].text;
const titles={early:'第一章 · Opening',middle:'第二章 · Turning point',late:'第三章 · '+('完整的手动章节标题'.repeat(10))};
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
async function capture(p,label){
 if(!process.env.COCONUT_UI_SCREENSHOTS)return;
 await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});
 await p.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'reading-chapters-'+label+'.png'),fullPage:false,animations:'disabled'});
}
async function stored(p=page){await p.evaluate(()=>libraryStore.flush());return p.evaluate(async key=>(await readPersistedLibrary()).documents.find(doc=>doc.key===key),key);}
async function savedChapters(count,p=page){await waitForPersistedLibrary(p,async({key,count})=>{const doc=(await readPersistedLibrary()).documents.find(doc=>doc.key===key);return doc&&(doc.reading_chapters||[]).length===count;},{key,count});}
async function openDirectory(p=page){
 diagnosticPage=p;if(await p.locator('#chapter-dialog').evaluate(node=>node.open))return;
 const button=p.locator('#open-chapters');
 async function hiddenEntry(reason){
  const ancestors=await button.evaluate(node=>{const rows=[];for(let current=node;current;current=current.parentElement){const style=getComputedStyle(current);rows.push({tag:current.tagName,id:current.id,hidden:current.hidden,display:style.display,visibility:style.visibility,open:current.tagName==='DETAILS'?current.open:undefined,rect:current.getBoundingClientRect().toJSON()});}return rows;});
  console.error(JSON.stringify({suite:'reading-chapters-entry-visibility',reason,ancestors}));await capture(p,'entry-visibility-failure');assert.fail(reason);
 }
 if(!await button.isVisible()){
  // Compact reading nests the already-open settings inside closed reading-info.
  // Reveal all native disclosures from the outside in; never unhide a root.
  const owners=await button.evaluate(node=>{const ids=[];for(let owner=node.parentElement;owner;owner=owner.parentElement)if(owner.tagName==='DETAILS')ids.unshift(owner.id);return ids;});
  for(const id of owners){
   if(!id)await hiddenEntry('Chapter entry has an unnamed disclosure ancestor');
   const owner=p.locator('#'+id);if(await owner.evaluate(node=>node.open))continue;
   const summary=owner.locator(':scope > summary');
   if(!await summary.isVisible())await hiddenEntry('Chapter disclosure '+id+' is hidden by a non-disclosure root');
   await summary.click();
  }
  if(!await button.isVisible())await hiddenEntry('Chapter entry remains hidden after all native disclosures are open');
 }
 await button.click();await p.locator('#chapter-dialog').waitFor({state:'visible'});
}
async function closeDirectory(p=page){if(await p.locator('#chapter-dialog').evaluate(node=>node.open))await p.locator('#chapter-close').click();}
async function findCue(index,p=page){
 await closeDirectory(p);await p.locator('#mode-transcript').click();await openTranscriptTools(p);
 if(await p.locator('#clear-search').isVisible())await p.locator('#clear-search').click();
 await p.locator('#search').fill('Authored chapter cue '+index+' ');
 const row=p.locator('.segment[data-segment-id="'+cueId(index)+'"]');await row.waitFor({state:'visible'});return row;
}
async function createChapter(index,title,count){
 const row=await findCue(index);await openCueActions(row);await row.locator('.chapter-create').click();
 await page.locator('#chapter-editor').waitFor({state:'visible'});assert.equal(await page.locator('#chapter-cue-number').inputValue(),String(index+1));
 await page.locator('#chapter-title').fill(title);await page.locator('#chapter-save').click();
 await page.locator('#chapter-editor').waitFor({state:'hidden'});await savedChapters(count);
 const chapter=(await stored()).reading_chapters.find(chapter=>chapter.cue_id===cueId(index));assert.equal(chapter.title,title);assert.equal(chapter.time,fixture.segments[index].start);return chapter;
}
const chapterRow=(id,p=page)=>p.locator('.chapter-entry[data-chapter-id="'+id+'"]');
const focused=(p,selector)=>p.locator(selector).evaluate(node=>node===document.activeElement);
async function readingState(p=page){return p.evaluate(()=>({query:document.getElementById('search').value,speaker:document.getElementById('speaker-filter').value,excerpts:document.getElementById('filter-excerpts').getAttribute('aria-pressed'),notes:document.getElementById('filter-notes').getAttribute('aria-pressed'),mode:document.body.dataset.readingMode,bilingual:document.getElementById('mode-bilingual').getAttribute('aria-pressed'),transcript:document.getElementById('mode-transcript').getAttribute('aria-pressed'),rows:[...document.querySelectorAll('#transcript .segment')].map(row=>row.dataset.segmentId)}));}
async function idleMediaAndBookmark(label,p=page){
 const state=await p.evaluate(()=>({plays:window.chapterMediaProof.plays,players:[...document.querySelectorAll('audio,video')].map(player=>({paused:player.paused,time:player.currentTime})),active:sessionStorage.getItem('coconut-reader-active-v1')}));
 const doc=await stored(p);
 check(label+'_never_plays_or_seeks_media',state.plays===0&&state.players.every(player=>player.paused&&player.time===0));
 check(label+'_preserves_explicit_reading_position',doc.readingPosition===fixture.readingPosition&&state.active===key);
}
async function targetCue(index,p=page){
 await p.waitForFunction(id=>{const node=document.querySelector('.chapter-target');return node&&(node.dataset.cueId||node.dataset.segmentId)===id&&node===document.activeElement;},cueId(index));
 check('chapter_lands_on_exact_cue_'+index+'_'+checks.length,await p.locator('.chapter-target').evaluate((node,id)=>(node.dataset.cueId||node.dataset.segmentId)===id,cueId(index)));
}
async function keyboardGeometry(p,selector,dialogId,label){
 await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const geometry=await p.locator(selector).evaluate((node,dialogId)=>{
  const rect=node.getBoundingClientRect(),style=getComputedStyle(node),ring=(parseFloat(style.outlineWidth)||0)+Math.max(0,parseFloat(style.outlineOffset)||0),dialog=document.getElementById(dialogId).getBoundingClientRect();
  const x=(rect.left+rect.right)/2,y=(rect.top+rect.bottom)/2;
  const hits=[[x,y],[rect.left+1,y],[rect.right-1,y],[x,rect.top+1],[x,rect.bottom-1]].map(([x,y])=>{const hit=document.elementFromPoint(x,y);return {x,y,clear:hit===node||node.contains(hit),hit:hit?{tag:hit.tagName,id:hit.id,className:hit.className}:null};});
  return {focused:document.activeElement===node,visibleFocus:node.matches(':focus-visible'),outlineStyle:style.outlineStyle,ring,rect:rect.toJSON(),dialog:dialog.toJSON(),hits,viewport:{width:innerWidth,height:innerHeight},pageWidth:document.documentElement.scrollWidth,dialogWidth:document.getElementById(dialogId).scrollWidth,dialogClientWidth:document.getElementById(dialogId).clientWidth};
 },dialogId);
 console.log(JSON.stringify({suite:'reading-chapters-keyboard-geometry',label,...geometry}));
 const {rect:r,ring,dialog,viewport}=geometry;
 const clear=geometry.focused&&geometry.visibleFocus&&geometry.outlineStyle!=='none'&&ring>0&&r.width>=44&&r.height>=44&&r.left-ring>=Math.max(0,dialog.left)&&r.right+ring<=Math.min(viewport.width,dialog.right)&&r.top-ring>=Math.max(0,dialog.top)&&r.bottom+ring<=Math.min(viewport.height,dialog.bottom)&&geometry.hits.every(point=>point.clear)&&geometry.pageWidth<=viewport.width&&geometry.dialogWidth<=geometry.dialogClientWidth+1;
 if(!clear)await capture(p,label+'-geometry-failure');check(label+'_complete_keyboard_target_and_five_hit_points_visible',clear);
}
async function precisePassageGeometry(p,index,label){
 await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const geometry=await p.locator('.passage-original .passage-cue.chapter-target[data-cue-id="'+cueId(index)+'"]').evaluate((node,precedingId)=>{
  const style=getComputedStyle(node),ring=(parseFloat(style.outlineWidth)||0)+Math.max(0,parseFloat(style.outlineOffset)||0),rects=[...node.getClientRects()].filter(r=>r.width>0&&r.height>0),first=rects[0],previous=node.closest('.passage').querySelector('[data-cue-id="'+precedingId+'"]');
  const points=first?[[first.left+first.width/2,first.top+first.height/2],[first.left+1,first.top+first.height/2],[first.right-1,first.top+first.height/2],[first.left+first.width/2,first.top+1],[first.left+first.width/2,first.bottom-1]]:[];
  return {focused:document.activeElement===node,visibleFocus:node.matches(':focus-visible'),tag:node.tagName,ring,scrollMarginTop:style.scrollMarginTop,returnBar:document.getElementById('chapter-return').getBoundingClientRect().toJSON(),rects:rects.map(r=>r.toJSON()),precedingHeight:previous?.getBoundingClientRect().height||0,samePassage:!!previous,hits:points.map(([x,y])=>{const hit=document.elementFromPoint(x,y);return {x,y,clear:hit===node||node.contains(hit),hit:hit?{tag:hit.tagName,id:hit.id,className:hit.className}:null};}),viewport:{width:innerWidth,height:innerHeight},text:node.textContent};
 },cueId(219));
 console.log(JSON.stringify({suite:'reading-chapters-exact-span-geometry',label,...geometry}));
 const clear=geometry.focused&&geometry.visibleFocus&&geometry.tag==='SPAN'&&geometry.ring>0&&geometry.samePassage&&geometry.precedingHeight>geometry.viewport.height&&geometry.rects.length>0&&geometry.rects.every(r=>r.top-geometry.ring>=0&&r.bottom+geometry.ring<=geometry.viewport.height&&r.left-geometry.ring>=0&&r.right+geometry.ring<=geometry.viewport.width)&&geometry.hits.length===5&&geometry.hits.every(point=>point.clear)&&geometry.text===fixture.segments[index].text;
 if(!clear)await capture(p,label+'-geometry-failure');check(label+'_focuses_the_exact_visible_span_after_a_viewport_tall_cue',clear);
}
try{
 directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-authored-chapters-'));const audioPath=path.join(directory,'authored-chapter-tone.wav');await fs.writeFile(audioPath,authoredAudioFixture());
 server=await startBridge({port:0});const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 async function newPage(viewport={width:1360,height:1000}){
  const context=await browser.newContext({viewport,acceptDownloads:true,serviceWorkers:'block'});
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(!['GET','HEAD'].includes(request.method())){mutations++;await route.abort();}else if(url.origin===origin||['blob:','data:'].includes(url.protocol))await route.continue();else{external++;await route.abort();}});
  await context.addInitScript(()=>{window.chapterMediaProof={plays:0};document.addEventListener('play',event=>{if(event.target instanceof HTMLMediaElement)window.chapterMediaProof.plays++;},true);});
  const p=await context.newPage();p.setDefaultTimeout(20000);p.on('pageerror',error=>errors.push({message:error.message,stack:error.stack,url:p.url()}));diagnosticPage=p;await p.goto(origin);return p;
 }
 page=await newPage();await page.locator('#library-file').setInputFiles({name:'authored-chapter-source.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({format:'coconut-library',version:1,documents:[fixture],active:key}))});
 await page.waitForFunction(()=>document.getElementById('library-file').value==='');await savedChapters(0);
 if(!await page.locator('#attach-reader-media').isVisible())await page.locator('#toggle-reader-media').click();
 const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-reader-media').click()]);await chooser.setFiles(audioPath);
 await page.waitForFunction(()=>{const player=document.querySelector('#source-media audio');return player&&!player.error&&player.readyState>=2&&player.duration>=179;});
 const before=await stored();await idleMediaAndBookmark('attached_authored_audio');
 stage='close authored media setup using its native control';
 await page.evaluate(()=>{window.chapterMediaProof.player=document.querySelector('#source-media audio');});
 await page.locator('#close-reader-media').click();
 await page.locator('#episode-media').waitFor({state:'hidden'});
 check('native_media_close_preserves_player_and_returns_focus',await page.evaluate(()=>document.querySelector('#source-media audio')===window.chapterMediaProof.player&&document.activeElement===document.getElementById('toggle-reader-media')&&document.getElementById('toggle-reader-media').getAttribute('aria-expanded')==='false'));
 assert.deepEqual(await stored(),before);await idleMediaAndBookmark('closed_authored_audio_panel');


 stage='create out-of-order chapters from exact cue actions';
 const late=await createChapter(220,titles.late,1),middle=await createChapter(150,titles.middle,2),early=await createChapter(10,titles.early,3);
 await openDirectory();assert.deepEqual(await page.locator('.chapter-entry').evaluateAll(rows=>rows.map(row=>row.dataset.chapterId)),[early.id,middle.id,late.id]);
 check('directory_uses_complete_transcript_order_instead_of_creation_order',true);
 const beforeDuplicate=(await stored()).reading_chapters;await closeDirectory();const duplicateRow=await findCue(150);await openCueActions(duplicateRow);await duplicateRow.locator('.chapter-create').click();await page.locator('#chapter-title').fill('Duplicate chapter must not replace the first');await page.locator('#chapter-save').click();
 check('duplicate_chapter_is_rejected_with_visible_editor_explanation',await page.locator('#chapter-editor').evaluate(node=>node.open)&&(await page.locator('#chapter-editor-status').textContent()).trim().length>0);
 assert.deepEqual((await stored()).reading_chapters,beforeDuplicate);assert.equal((await stored()).reading_chapters.length,3);assert.equal((await stored()).reading_chapters.find(chapter=>chapter.id===middle.id).title,titles.middle);await page.locator('#chapter-cancel').click();

 stage='current-cue create and explicit chapter removal';await findCue(30);await openDirectory();await page.locator('#chapter-add').click();
 assert.equal(await page.locator('#chapter-cue-number').inputValue(),'31');await page.locator('#chapter-title').fill('Temporary current-cue chapter');await page.locator('#chapter-save').click();await page.locator('#chapter-editor').waitFor({state:'hidden'});await savedChapters(4);
 const temporary=(await stored()).reading_chapters.find(chapter=>chapter.cue_id===cueId(30));await openDirectory();await chapterRow(temporary.id).locator('.chapter-remove').click();await savedChapters(3);
 check('removing_a_chapter_keeps_its_source_cue',Boolean((await stored()).segments.find(cue=>cue.id===cueId(30))));

 stage='rename drafts and explicit full-transcript relocation';await chapterRow(middle.id).locator('.chapter-rename').click();
 check('rename_keeps_position_read_only',await page.locator('#chapter-cue-number').evaluate(node=>node.readOnly));
 await page.locator('#chapter-title').fill('Unsubmitted chapter draft');await page.locator('#chapter-editor-close').click();check('close_editor_returns_focus_to_its_original_rename_button',await chapterRow(middle.id).locator('.chapter-rename').evaluate(node=>node===document.activeElement));await openDirectory();await chapterRow(middle.id).locator('.chapter-rename').click();
 check('editor_close_retains_unsaved_title_draft',await page.locator('#chapter-title').inputValue()==='Unsubmitted chapter draft');assert.equal((await stored()).reading_chapters.find(chapter=>chapter.id===middle.id).title,titles.middle);
 await page.locator('#chapter-cancel').click();await openDirectory();await chapterRow(middle.id).locator('.chapter-rename').click();assert.equal(await page.locator('#chapter-title').inputValue(),titles.middle);
 const renamed='第二章 · Renamed by the reader';await page.locator('#chapter-title').fill(renamed);await page.locator('#chapter-save').click();await page.locator('#chapter-editor').waitFor({state:'hidden'});
 await waitForPersistedLibrary(page,async({key,id,title})=>(await readPersistedLibrary()).documents.find(doc=>doc.key===key)?.reading_chapters.find(chapter=>chapter.id===id)?.title===title,{key,id:middle.id,title:renamed});
 await openDirectory();await chapterRow(early.id).locator('.chapter-relocate').click();check('relocation_requires_explicit_editable_source_position',!await page.locator('#chapter-cue-number').evaluate(node=>node.readOnly));check('relocation_keeps_title_read_only',await page.locator('#chapter-title').evaluate(node=>node.readOnly));
 await page.locator('#chapter-cue-number').fill('81');check('relocation_preview_names_the_full_transcript_cue',(await page.locator('#chapter-cue-preview').textContent()).includes(fixture.segments[80].text));await page.locator('#chapter-save').click();await page.locator('#chapter-editor').waitFor({state:'hidden'});
 await waitForPersistedLibrary(page,async({key,id,cue})=>(await readPersistedLibrary()).documents.find(doc=>doc.key===key)?.reading_chapters.find(chapter=>chapter.id===id)?.cue_id===cue,{key,id:early.id,cue:cueId(80)});
 assert.equal((await stored()).reading_chapters.find(chapter=>chapter.id===early.id).time,fixture.segments[80].start);await openDirectory();
 await idleMediaAndBookmark('chapter_creation_rename_and_relocation');

 stage='chapter previous next navigation';await chapterRow(middle.id).locator('.chapter-open').click();await targetCue(150);await openDirectory();
 check('reopened_directory_uses_exact_landed_chapter_instead_of_context_page_start',(await page.locator('#chapter-current').textContent()).includes('最近定位章节：'+renamed));await page.locator('#chapter-next').click();await targetCue(220);await openDirectory();await page.locator('#chapter-previous').click();await targetCue(150);await openDirectory();await page.locator('#chapter-previous').click();await targetCue(80);await openDirectory();await page.locator('#chapter-next').click();await targetCue(150);await openDirectory();await chapterRow(early.id).locator('.chapter-remove').click();await savedChapters(2);await closeDirectory();
 if(await page.locator('#stay-at-chapter').isVisible())await page.locator('#stay-at-chapter').click();

 stage='filtered result page clears for chapter and returns exactly';await page.locator('#mode-bilingual').click();await openTranscriptTools(page);if(await page.locator('#clear-search').isVisible())await page.locator('#clear-search').click();
 await page.locator('#search').fill('filter marker');await page.locator('#filter-excerpts').click();await page.locator('#speaker-filter').selectOption(JSON.stringify('Mina'));await page.locator('#next-page').click();
 const filtered=await readingState();assert.equal(filtered.rows[0],cueId(100));assert.equal(filtered.rows.length,100);
 await openDirectory();await chapterRow(late.id).locator('.chapter-open').click();await targetCue(220);
 const full=await readingState();check('chapter_jump_temporarily_clears_query_and_filters',full.query===''&&full.speaker==='all'&&full.excerpts==='false'&&full.notes==='false'&&await page.locator('#chapter-return').isVisible());
 await idleMediaAndBookmark('filtered_chapter_jump');await page.locator('#return-from-chapter').click();assert.deepEqual(await readingState(),filtered);
 check('one_click_return_restores_mode_query_speaker_excerpt_and_result_page',!await page.locator('#chapter-return').isVisible());await idleMediaAndBookmark('chapter_return');

 stage='390px chapter directory native keyboard and exact passage span';await page.locator('#clear-search').click();await page.locator('#mode-passages').click();await page.setViewportSize({width:390,height:844});await openDirectory();
 check('mobile_directory_keeps_complete_long_chapter_title',await chapterRow(late.id).locator('strong').textContent()===titles.late&&(await chapterRow(late.id).locator('.chapter-open').getAttribute('aria-label')).includes(titles.late));
 await chapterRow(late.id).locator('.chapter-rename').focus();await page.keyboard.press('Shift+Tab');await keyboardGeometry(page,'.chapter-entry[data-chapter-id="'+late.id+'"] .chapter-open','chapter-dialog','390-directory-open');
 await page.keyboard.press('Tab');await keyboardGeometry(page,'.chapter-entry[data-chapter-id="'+late.id+'"] .chapter-rename','chapter-dialog','390-directory-rename');await page.keyboard.press('Shift+Tab');await capture(page,'390-directory-keyboard');
 await page.keyboard.press('Enter');await targetCue(220);await precisePassageGeometry(page,220,'390-exact-chapter-span');await capture(page,'390-exact-chapter-span');await idleMediaAndBookmark('exact_passage_chapter_navigation');

 stage='390px native modal boundary wrap and Escape draft preservation';await openDirectory();
 check('last_chapter_disables_next_but_keeps_previous_available',await page.locator('#chapter-next').isDisabled()&&!await page.locator('#chapter-previous').isDisabled());
 // Directory opens on Add. Native reverse traversal must skip disabled Next.
 await page.keyboard.press('Shift+Tab');check('directory_reverse_tab_skips_disabled_next',await focused(page,'#chapter-previous'));
 await page.keyboard.press('Shift+Tab');check('directory_first_shift_tab_wraps_to_last',await focused(page,'#chapter-close'));await keyboardGeometry(page,'#chapter-close','chapter-dialog','390-directory-last');
 await page.keyboard.press('Tab');check('directory_last_tab_wraps_to_first',await focused(page,'#chapter-previous'));
 await page.keyboard.press('Tab');check('directory_forward_tab_skips_disabled_next',await focused(page,'#chapter-add'));
 await chapterRow(late.id).locator('.chapter-rename').click();check('editor_opens_with_title_focused',await focused(page,'#chapter-title'));
 await page.keyboard.press('Shift+Tab');check('editor_first_shift_tab_wraps_to_last',await focused(page,'#chapter-editor-close'));await keyboardGeometry(page,'#chapter-editor-close','chapter-editor','390-editor-last');await capture(page,'390-editor-keyboard');
 await page.keyboard.press('Tab');check('editor_last_tab_wraps_to_first',await focused(page,'#chapter-title'));
 await page.keyboard.press('Tab');check('editor_readonly_source_remains_keyboard_inspectable',await focused(page,'#chapter-cue-number'));await page.keyboard.press('Shift+Tab');
 await page.locator('#chapter-title').fill('Mobile unsaved Escape draft');await page.keyboard.press('Escape');await page.locator('#chapter-editor').waitFor({state:'hidden'});
 check('native_escape_returns_to_original_rename_button',await chapterRow(late.id).locator('.chapter-rename').evaluate(node=>node===document.activeElement));assert.equal((await stored()).reading_chapters.find(chapter=>chapter.id===late.id).title,titles.late);
 await page.keyboard.press('Enter');await page.locator('#chapter-editor').waitFor({state:'visible'});assert.equal(await page.locator('#chapter-title').inputValue(),'Mobile unsaved Escape draft');await page.locator('#chapter-cancel').click();
 await chapterRow(late.id).locator('.chapter-rename').click();assert.equal(await page.locator('#chapter-title').inputValue(),titles.late);await page.locator('#chapter-cancel').click();
 check('native_escape_preserves_draft_and_explicit_cancel_discards_it',true);


 stage='actual chapter JSON backup and fresh-context recovery';await openDirectory();const pending=page.waitForEvent('download');await page.locator('#chapter-backup').click();const download=await pending;assert.equal(download.suggestedFilename(),'coconut-chapters.json');assert.equal(await download.failure(),null);const bytes=await fs.readFile(await download.path()),backup=JSON.parse(bytes),saved=await stored();
 assert.deepEqual(backup,{format:'coconut-library',version:1,documents:[saved],active:key});assert.deepEqual(saved.segments,before.segments);assert.deepEqual(saved.notes,before.notes);assert.equal(saved.readingPosition,before.readingPosition);
 check('actual_json_backup_contains_exact_chapters_and_untouched_source_work',saved.reading_chapters.length===2);
 const fresh=await newPage({width:390,height:844});await fresh.locator('#library-file').setInputFiles({name:'actual-chapter-backup.json',mimeType:'application/json',buffer:bytes});await fresh.waitForFunction(()=>document.getElementById('library-file').value==='');await savedChapters(2,fresh);
 assert.deepEqual(await stored(fresh),saved);await openDirectory(fresh);assert.deepEqual(await fresh.locator('.chapter-entry').evaluateAll(rows=>rows.map(row=>row.dataset.chapterId)),[middle.id,late.id]);await closeDirectory(fresh);
 await fresh.locator('#library-file').setInputFiles({name:'actual-chapter-backup.json',mimeType:'application/json',buffer:bytes});await fresh.waitForFunction(()=>document.getElementById('library-file').value==='');assert.deepEqual(await stored(fresh),saved);
 check('fresh_actual_backup_restore_preserves_chapters_and_repeat_is_idempotent',await fresh.locator('audio,video').count()===0&&await fresh.evaluate(async()=> (await readPersistedLibrary()).documents.length===1));await idleMediaAndBookmark('fresh_chapter_restore',fresh);await fresh.context().close();
 diagnosticPage=page;await closeDirectory();await page.reload();assert.deepEqual((await stored()).reading_chapters,saved.reading_chapters);await openDirectory();
 check('reloaded_chapter_directory_keeps_saved_names_and_positions',await page.locator('.chapter-entry').count()===2);await idleMediaAndBookmark('reloaded_chapters');
 check('no_external_requests_mutations_or_browser_errors',external===0&&mutations===0&&errors.length===0);console.log(JSON.stringify({suite:'reading-chapters',status:'passed',checks}));
}catch(error){
 const probe=await diagnosticPage?.evaluate(()=>({chapterDialog:document.getElementById('chapter-dialog')?.open,editor:document.getElementById('chapter-editor')?.open,chapterStatus:document.getElementById('chapter-save-status')?.textContent,editorStatus:document.getElementById('chapter-editor-status')?.textContent,chapterRows:document.querySelectorAll('.chapter-entry').length,activeTag:document.activeElement?.tagName,activeId:document.activeElement?.id,activeClass:document.activeElement?.className,query:document.getElementById('search')?.value,media:{plays:window.chapterMediaProof?.plays,paused:document.querySelector('#source-media audio')?.paused,time:document.querySelector('#source-media audio')?.currentTime},mediaPanel:{hidden:document.getElementById('episode-media')?.hidden,expanded:document.getElementById('toggle-reader-media')?.getAttribute('aria-expanded'),rect:document.getElementById('episode-media')?.getBoundingClientRect().toJSON(),closeHidden:document.getElementById('close-reader-media')?.hidden},readingInfoOpen:document.getElementById('reading-info')?.open,modeControl:(()=>{const node=document.getElementById('mode-transcript'),rect=node?.getBoundingClientRect(),hit=rect&&document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);return {rect:rect?.toJSON(),hitTag:hit?.tagName,hitId:hit?.id,hitClass:hit?.className};})()})).catch(()=>null);
 console.error(JSON.stringify({suite:'reading-chapters',status:'failed',stage,checks,probe,errors,error:{message:error.message,stack:error.stack}}));if(diagnosticPage&&!diagnosticPage.isClosed())await capture(diagnosticPage,'failure').catch(()=>{});process.exitCode=1;
}finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());if(directory)await fs.rm(directory,{recursive:true,force:true});}
