// Compatibility renderer regression; this suite is not default React acceptance.
/** Actions-only native keyboard paste, timed-text preview and real IndexedDB receipts.
 * Fixtures are authored here. No workspace browser, external API, account, model,
 * clipboard-read permission, clipboard shim, synthetic paste or DOM mock is used.
 * The delayed adapter always delegates to the production IndexedDB transaction. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from './helpers/browser-storage.mjs';
import {openCueActions} from './cue-actions-browser.mjs';

const root=new URL('../reader/',import.meta.url),checks=[],errors=[],geometry=[];
const title='Authored pasted timed transcript';
const longCue='Complete authored text beyond the preview. '.repeat(40)+'Authored full-content tail.';
const unsafe='<img src="/pasted-xss-probe" onerror="window.__pasteAudit.xss++">';
const srt='\uFEFF1\r\n00:00:01,250 --> 00:00:03,750\r\n你好 &amp; hello.\r\nAn authored second line.\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,500\r\n'+unsafe+'\r\n\r\n3\r\n00:00:07,000 --> 00:00:09,000\r\nThe third authored cue.\r\n\r\n4\r\n00:00:10,000 --> 00:00:12,500\r\n'+longCue+'\r\n\r\n5\r\n00:00:13,000 --> 00:00:15,000\r\nThe final authored cue.\r\n';
const threeCueSrt=srt.slice(0,srt.indexOf('\r\n\r\n4\r\n'));
const expected=[
 {id:'segment-1',start:1.25,end:3.75,text:'你好 & hello.\nAn authored second line.',speaker:null},
 {id:'segment-2',start:4,end:6.5,text:unsafe,speaker:null},
 {id:'segment-3',start:7,end:9,text:'The third authored cue.',speaker:null},
 {id:'segment-4',start:10,end:12.5,text:longCue,speaker:null},
 {id:'segment-5',start:13,end:15,text:'The final authored cue.',speaker:null},
];
const vtt='\uFEFFWEBVTT\r\n\r\nNOTE Authored metadata, not spoken words.\r\n\r\nvoice-one\r\n00:01.250 --> 00:03.750 align:start\r\n<v Narrator>你好 &amp; hello.\r\nAn authored second line.</v>\r\n\r\nvoice-two\r\n00:04.000 --> 00:06.500\r\n&lt;img src="/pasted-xss-probe" onerror="window.__pasteAudit.xss++"&gt;\r\n';
const brokenBlock='4\n00:00:10,000 - 00:00:12,000\nAuthored skipped malformed block.';
const simple=(words='An authored typed sentence.')=>'1\n00:00:00,000 --> 00:00:02,500\n'+words;
const snapshot=doc=>doc.segments.map(({id,start,end,text,speaker})=>({id,start,end,text,speaker:speaker??null}));
let browser,server,stage='setup',external=0,mutations=0,xssRequests=0,failure=null;
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
try{
 server=createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){mutations++;res.writeHead(405).end();return;}
  const name=new URL(req.url,'http://localhost').pathname.slice(1)||'compatibility.html';
  if(name==='pasted-xss-probe')xssRequests++;
  if(!/^[a-z-]+\.(html|js|css|png|webmanifest)$/.test(name)){res.writeHead(404).end();return;}
  try{res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html');res.end(await fs.readFile(new URL(name,root)));}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});
 async function newPage(width=1280){
  const context=await browser.newContext({viewport:{width,height:844},acceptDownloads:true,serviceWorkers:'block'});
  // This author-controlled fixture is the only clipboard content ever written.
  // Native paste is a user gesture; the application receives no async read grant.
  await context.grantPermissions(['clipboard-write'],{origin});
  await context.addInitScript(()=>{
   window.__pasteAudit={pastes:[],typed:0,xss:0};
   addEventListener('paste',event=>{if(event.target.id==='paste-subtitle-text')__pasteAudit.pastes.push({trusted:event.isTrusted});},true);
   addEventListener('beforeinput',event=>{if(event.target.id==='paste-subtitle-text'&&event.isTrusted&&event.inputType==='insertText')__pasteAudit.typed++;},true);
  });
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['blob:','data:'].includes(url.protocol))return route.continue();external++;return route.abort();});
  await context.route('**/storage-provider.js*',async route=>{
   const response=await route.fetch(),body=await response.text();
   await route.fulfill({response,body:body+`\n(()=>{const initialize=CoconutStorageProvider.initialize;window.pasteSaveProbe={holdNext:false,held:null,finished:0};CoconutStorageProvider.initialize=async function(...args){const result=await initialize.apply(this,args);if(result.ok&&result.backend==='indexeddb'){const write=result.adapter.write.bind(result.adapter);result.adapter.write=async(...args)=>{if(pasteSaveProbe.holdNext){pasteSaveProbe.holdNext=false;await new Promise(resolve=>{pasteSaveProbe.held={release:resolve};});}const receipt=await write(...args);pasteSaveProbe.finished++;return receipt;};}return result;};})();`});
  });
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);return page;
 }
 const disk=page=>page.evaluate(()=>readPersistedLibrary());
 const stored=async page=>{await page.evaluate(()=>libraryStore.flush());return disk(page);};
 const active=async page=>{const state=await stored(page),key=await page.evaluate(()=>sessionStorage.getItem('coconut-reader-active-v1'));return state.documents.find(doc=>doc.key===key);};
 async function open(page){
  await page.bringToFront();
  if(!await page.locator('#paste-subtitles').isVisible())await page.locator('#add-content').click();
  await page.locator('#paste-subtitles').click();await expect(page.locator('#paste-subtitle-dialog')).toBeVisible();
 }
 async function paste(page,value){
  await page.locator('#paste-subtitle-text').focus();await page.keyboard.press('ControlOrMeta+A');
  await page.evaluate(value=>navigator.clipboard.writeText(value),value);await page.keyboard.press('ControlOrMeta+V');
  await expect(page.locator('#paste-subtitle-text')).toHaveValue(value.replace(/\r\n?/g,'\n'));
  check('native_trusted_keyboard_paste_'+checks.length,await page.evaluate(()=>__pasteAudit.pastes.length>0&&__pasteAudit.pastes.every(event=>event.trusted)));
 }
 async function draft(page,words,{name=title,format='auto'}={}){
  await open(page);await page.locator('#paste-subtitle-title').fill(name);await page.locator('#paste-subtitle-format').selectOption(format);await paste(page,words);
 }
 async function preview(page){await page.locator('#preview-paste-subtitle').click();await expect(page.locator('#confirm-paste-subtitle')).toBeEnabled();}
 async function save(page){await page.locator('#confirm-paste-subtitle').click();await expect(page.locator('#paste-subtitle-dialog')).not.toBeVisible();await expect(page.locator('#reader-workspace')).toBeVisible();await stored(page);}
 async function choose(page,file){
  if(await page.locator('#add-content').isVisible())await page.locator('#add-content').click();
  const [picker]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#import').click()]);await picker.setFiles(file);await expect(page.locator('#file')).toHaveValue('');
 }
 async function download(page,selector='#export'){
  if(selector==='#export'&&!await page.locator('#export-menu').evaluate(node=>node.open))await page.locator('#export-menu > summary').click();
  const [item]=await Promise.all([page.waitForEvent('download'),page.locator(selector).click()]);assert.equal(await item.failure(),null);
  return {name:item.suggestedFilename(),mimeType:'application/json',buffer:await fs.readFile(await item.path())};
 }
 async function capture(page,label){if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'pasted-subtitles-'+label+'.png'),animations:'disabled'});}}
 async function keyboardGeometry(page,label){
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const value=await page.evaluate(()=>{
   const node=document.activeElement,host=document.getElementById('paste-subtitle-dialog'),r=node.getBoundingClientRect(),d=host.getBoundingClientRect(),style=getComputedStyle(node),ring=(parseFloat(style.outlineWidth)||0)+Math.max(0,parseFloat(style.outlineOffset)||0),x=(r.left+r.right)/2,y=(r.top+r.bottom)/2;
   return {id:node.id||node.tagName+':'+node.textContent.slice(0,80),inside:node.closest('dialog')===host,visibleFocus:node.matches(':focus-visible'),outline:style.outlineStyle,ring,rect:r.toJSON(),dialog:d.toJSON(),viewport:{width:innerWidth,height:innerHeight},pageWidth:document.documentElement.scrollWidth,dialogWidth:host.scrollWidth,dialogClientWidth:host.clientWidth,hits:[[x,y],[r.left+1,y],[r.right-1,y],[x,r.top+1],[x,r.bottom-1]].map(([x,y])=>{const hit=document.elementFromPoint(x,y);return {x,y,clear:hit===node||node.contains(hit),hit:hit?.id||hit?.tagName};})};
  });
  geometry.push({label,...value});const {rect:r,dialog:d,ring,viewport:v}=value;
  check(label+'_44px_complete_ring_five_clear_hits',value.inside&&value.visibleFocus&&value.outline!=='none'&&ring>0&&r.width>=44&&r.height>=44&&r.left-ring>=Math.max(0,d.left)&&r.right+ring<=Math.min(v.width,d.right)&&r.top-ring>=Math.max(0,d.top)&&r.bottom+ring<=Math.min(v.height,d.bottom)&&value.hits.every(hit=>hit.clear)&&value.pageWidth<=v.width&&value.dialogWidth<=value.dialogClientWidth+1);
  return value.id;
 }
 async function openerGeometry(page,label){
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const value=await page.locator('#paste-subtitles').evaluate(node=>{
   const r=node.getBoundingClientRect(),style=getComputedStyle(node),ring=(parseFloat(style.outlineWidth)||0)+Math.max(0,parseFloat(style.outlineOffset)||0),x=(r.left+r.right)/2,y=(r.top+r.bottom)/2,clips=[];
   for(let parent=node.parentElement;parent;parent=parent.parentElement){const box=parent.getBoundingClientRect(),css=getComputedStyle(parent),clipX=/hidden|clip|scroll|auto/.test(css.overflowX),clipY=/hidden|clip|scroll|auto/.test(css.overflowY);if(clipX||clipY)clips.push({tag:parent.id||parent.tagName,clear:(!clipX||(r.left-ring>=box.left+parent.clientLeft&&r.right+ring<=box.left+parent.clientLeft+parent.clientWidth))&&(!clipY||(r.top-ring>=box.top+parent.clientTop&&r.bottom+ring<=box.top+parent.clientTop+parent.clientHeight))});}
   return {id:node.id,focused:document.activeElement===node,visibleFocus:node.matches(':focus-visible'),outline:style.outlineStyle,ring,rect:r.toJSON(),viewport:{width:innerWidth,height:innerHeight},clips,pageWidth:document.documentElement.scrollWidth,hits:[[x,y],[r.left+1,y],[r.right-1,y],[x,r.top+1],[x,r.bottom-1]].map(([x,y])=>{const hit=document.elementFromPoint(x,y);return {x,y,clear:hit===node||node.contains(hit),hit:hit?.id||hit?.tagName};})};
  });
  geometry.push({label,...value});const {rect:r,ring,viewport:v}=value;
  check(label+'_44px_complete_ring_five_clear_hits',value.focused&&value.visibleFocus&&value.outline!=='none'&&ring>0&&r.width>=44&&r.height>=44&&r.left-ring>=0&&r.right+ring<=v.width&&r.top-ring>=0&&r.bottom+ring<=v.height&&value.clips.every(clip=>clip.clear)&&value.hits.every(hit=>hit.clear)&&value.pageWidth<=v.width);
 }
 async function tabCircuit(page,label){
  const candidates=await page.locator('#paste-subtitle-dialog').evaluate(host=>[...host.querySelectorAll('button,input,textarea,select,summary,[tabindex]')].filter(node=>!node.disabled&&node.tabIndex>=0&&node.getBoundingClientRect().width>0&&node.getBoundingClientRect().height>0).map(node=>node.id||node.tagName+':'+node.textContent.slice(0,80)));
  await page.locator('#paste-subtitle-text').focus();
  for(const key of ['Tab','Shift+Tab']){
   const seen=new Set();for(let i=0;i<candidates.length+1;i++){await page.keyboard.press(key);seen.add(await keyboardGeometry(page,label+'_'+key+'_'+i));}
   check(label+'_'+key+'_all_visible_controls_reachable_and_trapped',candidates.every(id=>seen.has(id)));
  }
 }
 const hold=page=>page.evaluate(()=>{pasteSaveProbe.holdNext=true;});
 const held=page=>page.waitForFunction(()=>!!pasteSaveProbe.held);
 async function release(page){const before=await page.evaluate(()=>{const before=pasteSaveProbe.finished;pasteSaveProbe.held.release();pasteSaveProbe.held=null;return before;});await page.waitForFunction(before=>pasteSaveProbe.finished>before,before);}

 for(const width of [390,1280]){
  const page=await newPage(width);stage='native paste preview '+width;await open(page);
  await expect(page.locator('#paste-subtitle-format')).toHaveValue('auto');await expect(page.locator('#confirm-paste-subtitle')).toBeDisabled();
  const empty=await disk(page);await page.locator('#preview-paste-subtitle').click();await expect(page.locator('#confirm-paste-subtitle')).toBeDisabled();
  await page.locator('#paste-subtitle-title').fill(title);await paste(page,threeCueSrt);await expect(page.locator('#confirm-paste-subtitle')).toBeDisabled();
  check('typing_does_not_auto_preview_or_save_'+width,(await page.locator('#paste-subtitle-preview').textContent()).trim()===''&&JSON.stringify(await disk(page))===JSON.stringify(empty));
  await preview(page);await expect(page.locator('#paste-subtitle-status')).toContainText('3 段');await expect(page.locator('#paste-subtitle-status')).toContainText('00:01.250–00:09.000');await expect(page.locator('#paste-subtitle-preview')).toContainText('你好 & hello.');await expect(page.locator('#paste-subtitle-preview')).toContainText(unsafe);
  check('preview_is_bounded_to_first_three_cues_'+width,await page.locator('#paste-subtitle-preview > li').count()===3&&!(await page.locator('#paste-subtitle-preview').textContent()).includes('Authored full-content tail.'));
  check('preview_escapes_authored_HTML_'+width,await page.locator('#paste-subtitle-preview img, #paste-subtitle-preview script').count()===0&&await page.evaluate(()=>__pasteAudit.xss===0));
  check('preview_is_read_only_'+width,JSON.stringify(await disk(page))===JSON.stringify(empty));
  await capture(page,'preview-'+width);await tabCircuit(page,'preview_'+width);
  await page.locator('#paste-subtitle-example summary').click();await expect(page.locator('#paste-subtitle-example')).toHaveJSProperty('open',true);await tabCircuit(page,'example_expanded_'+width);await capture(page,'example-'+width);
  await paste(page,srt);await preview(page);await expect(page.locator('#paste-subtitle-status')).toContainText('5 段');
  check('longer_input_keeps_preview_bounded_and_full_time_range_'+width,await page.locator('#paste-subtitle-preview > li').count()===3&&(await page.locator('#paste-subtitle-status').textContent()).includes('00:01.250–00:15.000'));
  await page.keyboard.press('Escape');await expect(page.locator('#paste-subtitle-dialog')).not.toBeVisible();await expect(page.locator('#paste-subtitles')).toBeFocused();await openerGeometry(page,'Escape_opener_'+width);await capture(page,'Escape-opener-'+width);
  await open(page);await expect(page.locator('#paste-subtitle-text')).toHaveValue(srt.replace(/\r\n/g,'\n'));await expect(page.locator('#paste-subtitle-title')).toHaveValue(title);
  check('native_Escape_restores_opener_and_preserves_draft_'+width,JSON.stringify(await disk(page))===JSON.stringify(empty));
  // Close invalidates async ownership. Re-preview explicitly after returning.
  await preview(page);await page.locator('#paste-subtitle-title').press('End');await page.locator('#paste-subtitle-title').pressSequentially(' changed');await expect(page.locator('#confirm-paste-subtitle')).toBeDisabled();
  await page.locator('#paste-subtitle-title').fill(title);await preview(page);await page.locator('#paste-subtitle-format').selectOption('srt');await expect(page.locator('#confirm-paste-subtitle')).toBeDisabled();await preview(page);
  await page.locator('#paste-subtitle-text').press('ControlOrMeta+End');await page.locator('#paste-subtitle-text').pressSequentially(' ');await expect(page.locator('#confirm-paste-subtitle')).toBeDisabled();await paste(page,srt);await preview(page);
  check('title_format_and_text_each_require_fresh_preview_'+width,JSON.stringify(await disk(page))===JSON.stringify(empty));
  await hold(page);await page.locator('#confirm-paste-subtitle').click();await held(page);
  await expect(page.locator('#paste-subtitle-dialog')).toBeVisible();await expect(page.locator('#reader-workspace')).not.toBeVisible();
  check('start_reading_waits_for_real_commit_receipt_'+width,(await disk(page)).documents.length===0);
  await release(page);await expect(page.locator('#paste-subtitle-dialog')).not.toBeVisible();await expect(page.locator('#title')).toHaveText(title);
  const original=await active(page);assert.deepEqual(snapshot(original),expected);check('SRT_BOM_CRLF_multiline_unicode_milliseconds_saved_'+width,true);
  await page.locator('#mode-transcript').click();assert.deepEqual(await page.locator('.words').allTextContents(),expected.map(cue=>cue.text));
  await page.locator('.note-button').first().click();await page.locator('#note').fill('Authored pasted transcript annotation');await page.locator('#close-note').click();
  const third=page.locator('.segment').nth(2);await openCueActions(third);await third.locator('.edit-button').click();await page.locator('#edit-segment').fill('A corrected authored third cue.');await page.locator('#save-edit').click();
  const changed=await active(page);assert.equal(changed.segments[2].original_text,expected[2].text);
  await capture(page,'reading-'+width);
  const backup=await download(page),payload=JSON.parse(backup.buffer.toString('utf8'));assert.deepEqual(snapshot(payload),snapshot(changed));assert.equal(payload.notes['segment-1'],'Authored pasted transcript annotation');
  const restored=await newPage(width);await choose(restored,backup);await restored.reload();const recovered=await active(restored);
  check('actual_JSON_download_clean_context_restore_and_IDB_reload_'+width,JSON.stringify(snapshot(recovered))===JSON.stringify(snapshot(changed))&&recovered.notes['segment-1']===payload.notes['segment-1']&&recovered.segments[2].original_text===expected[2].text);
  await draft(page,srt,{format:'srt'});await preview(page);await save(page);const repeated=await active(page);
  check('repeated_paste_reuses_key_and_preserves_notes_and_correction_'+width,(await stored(page)).documents.length===1&&repeated.key===original.key&&repeated.notes['segment-1']===payload.notes['segment-1']&&repeated.segments[2].text===changed.segments[2].text);
  await open(page);await expect(page.locator('#paste-subtitle-text')).toHaveValue('');await expect(page.locator('#paste-subtitle-title')).toHaveValue('');
  await paste(page,simple('A draft to clear explicitly.'));await page.locator('#close-paste-subtitle').click();await expect(page.locator('#paste-subtitles')).toBeFocused();await open(page);await expect(page.locator('#paste-subtitle-text')).toHaveValue(simple('A draft to clear explicitly.'));
  await page.locator('#clear-paste-subtitle').click();await expect(page.locator('#paste-subtitle-text')).toHaveValue('');await expect(page.locator('#confirm-paste-subtitle')).toBeDisabled();
  check('successful_owned_save_clears_draft_and_close_retains_until_explicit_clear_'+width,(await stored(page)).documents.length===1);
  await page.context().close();await restored.context().close();
 }

 stage='character typing and correction';const typed=await newPage(390);await open(typed);
 await typed.locator('#paste-subtitle-text').pressSequentially('Untimed authored prose is not a timed transcript.');await typed.locator('#preview-paste-subtitle').click();await expect(typed.locator('#confirm-paste-subtitle')).toBeDisabled();
 check('untimed_prose_has_no_fabricated_timestamps_or_document',(await disk(typed)).documents.length===0);
 await typed.locator('#paste-subtitle-text').press('ControlOrMeta+A');await typed.locator('#paste-subtitle-text').pressSequentially('1\nnot-a-time --> 00:00:02,500\nAn authored typed sentence.');await typed.locator('#preview-paste-subtitle').click();await expect(typed.locator('#confirm-paste-subtitle')).toBeDisabled();
 await typed.locator('#paste-subtitle-text').press('ControlOrMeta+A');await typed.locator('#paste-subtitle-text').pressSequentially(simple());await preview(typed);
 check('per_character_trusted_typing_can_correct_failed_preview',await typed.evaluate(()=>__pasteAudit.typed>50)&&(await disk(typed)).documents.length===0);
 await save(typed);check('optional_blank_title_produces_readable_timed_document',(await active(typed)).title.length>0&&(await active(typed)).segments[0].end===2.5);

 for(const width of [390,1280]){
  stage='VTT and malformed block diagnostics '+width;const page=await newPage(width);
  await draft(page,vtt+'\r\n'+brokenBlock,{name:'Authored VTT diagnostics'});await preview(page);
  await expect(page.locator('#paste-subtitle-status')).toContainText('跳过 1 个字幕块');
  await page.locator('#paste-subtitle-diagnostics summary').first().click();
  await expect(page.locator('#paste-subtitle-diagnostics')).toContainText('Authored skipped malformed block.');
  await expect(page.locator('#paste-subtitle-diagnostics')).toContainText('第 14–16 行');
  check('skipped_block_diagnostics_show_exact_source_line_range_'+width,(await disk(page)).documents.length===0);
  await capture(page,'diagnostics-'+width);await tabCircuit(page,'diagnostics_'+width);await save(page);const doc=await active(page);
  assert.deepEqual(snapshot(doc),[{...expected[0],speaker:'Narrator'},expected[1]]);check('auto_WEBVTT_header_voice_metadata_entities_and_diagnostic_skip_'+width,true);
  await page.reload();check('VTT_reload_keeps_actual_IDB_content_'+width,JSON.stringify(snapshot(await active(page)))===JSON.stringify(snapshot(doc)));
  // Explicit VTT selection also supports a cue body supplied without a header.
  await draft(page,vtt.replace('\uFEFFWEBVTT\r\n\r\n',''),{name:'Authored explicit VTT',format:'vtt'});await preview(page);await save(page);
  check('explicit_VTT_selection_without_header_retains_voice_'+width,(await active(page)).segments[0].speaker==='Narrator');await page.context().close();
 }

 for(const width of [390,1280]){
  stage='failed save rescue retry '+width;const page=await newPage(width);await page.evaluate(()=>failContentWrites());await draft(page,srt,{name:'Authored failed paste'});await preview(page);await page.locator('#confirm-paste-subtitle').click();
  for(const selector of ['#retry-paste-subtitle','#read-paste-subtitle','#export-paste-subtitle'])await expect(page.locator(selector)).toBeVisible();
  await expect(page.locator('#paste-subtitle-dialog')).toBeVisible();await expect(page.locator('#reader-workspace')).not.toBeVisible();await expect(page.locator('#paste-subtitle-text')).toHaveValue(srt.replace(/\r\n/g,'\n'));
  check('failed_real_IDB_save_retains_dialog_draft_and_explicit_choices_'+width,(await disk(page)).documents.length===0);await capture(page,'failed-save-'+width);await tabCircuit(page,'failed_'+width);
  const rescue=await download(page,'#export-paste-subtitle'),saved=JSON.parse(rescue.buffer.toString('utf8'));assert.deepEqual(snapshot(saved),expected);
  check('complete_rescue_download_does_not_claim_saved_'+width,(await disk(page)).documents.length===0&&await page.locator('#retry-paste-subtitle').isVisible());
  const restored=await newPage(width);await choose(restored,rescue);await restored.reload();assert.deepEqual(snapshot(await active(restored)),expected);check('failed_save_rescue_is_actual_JSON_clean_restore_'+width,true);
  await page.evaluate(()=>restoreContentWrites());await page.locator('#retry-paste-subtitle').click();await expect(page.locator('#paste-subtitle-dialog')).not.toBeVisible();await page.reload();assert.deepEqual(snapshot(await active(page)),expected);check('explicit_retry_waits_for_saved_then_survives_reload_'+width,true);
  await page.context().close();await restored.context().close();
 }
 stage='bounded skipped-block diagnostics';const many=await newPage(390);const malformed=Array.from({length:52},(_,index)=>String(index+2)+'\n00:00:03,000 - 00:00:04,000\nAuthored skipped block '+(index+1)).join('\n\n');
 await draft(many,simple()+'\n\n'+malformed,{name:'Authored many diagnostics'});await preview(many);await expect(many.locator('#paste-subtitle-status')).toContainText('跳过 52 个字幕块');await many.locator('#paste-subtitle-diagnostics summary').click();await expect(many.locator('#paste-subtitle-diagnostics li')).toHaveCount(50);
 await tabCircuit(many,'diagnostic_more_390');await many.locator('#paste-subtitle-diagnostics button').click();await expect(many.locator('#paste-subtitle-diagnostics li')).toHaveCount(52);check('diagnostics_expand_in_bounded_groups_without_saving',(await disk(many)).documents.length===0);await many.context().close();
 stage='explicit in-page unsaved reading';const temporary=await newPage();await temporary.evaluate(()=>failContentWrites());await draft(temporary,simple('Authored temporary reading.'),{name:'Authored unsaved reading'});await preview(temporary);await temporary.locator('#confirm-paste-subtitle').click();await expect(temporary.locator('#read-paste-subtitle')).toBeVisible();await temporary.locator('#read-paste-subtitle').click();
 await expect(temporary.locator('#reader-workspace')).toBeVisible();await expect(temporary.locator('#title')).toHaveText('Authored unsaved reading');check('explicit_read_in_page_does_not_fake_durable_save',(await disk(temporary)).documents.length===0);
 await open(temporary);await expect(temporary.locator('#paste-subtitle-text')).toHaveValue(simple('Authored temporary reading.'));check('unsaved_reading_keeps_recoverable_draft',true);await temporary.context().close();

 for(const dismissal of ['close','Escape','edit']){
  stage='late save after '+dismissal;const page=await newPage(390);await draft(page,simple('Authored late original.'),{name:'Authored late original'});await preview(page);await hold(page);await page.locator('#confirm-paste-subtitle').click();await held(page);
  if(dismissal!=='edit'){
   if(dismissal==='close')await page.locator('#close-paste-subtitle').click();else await page.keyboard.press('Escape');
   await expect(page.locator('#paste-subtitle-dialog')).not.toBeVisible();await expect(page.locator('#paste-subtitles')).toBeFocused();await open(page);
  }
  await page.locator('#paste-subtitle-title').fill('Authored newer draft');await paste(page,simple('Keep the newer pending draft.'));
  await release(page);await stored(page);await expect(page.locator('#paste-subtitle-dialog')).toBeVisible();await expect(page.locator('#paste-subtitle-title')).toHaveValue('Authored newer draft');await expect(page.locator('#paste-subtitle-text')).toHaveValue(simple('Keep the newer pending draft.'));await expect(page.locator('#reader-workspace')).not.toBeVisible();
  check('late_receipt_after_'+dismissal+'_cannot_open_reader_close_dialog_or_clear_new_draft',(await disk(page)).documents.length===1);
  await preview(page);await save(page);check('fresh_confirm_after_'+dismissal+'_selects_only_newer_document',(await active(page)).title==='Authored newer draft');await page.context().close();
 }
 stage='late save followed by newer native file import';const newer=await newPage();
 await draft(newer,simple('Authored paste replaced by native file.'),{name:'Authored obsolete paste'});await preview(newer);await hold(newer);await newer.locator('#confirm-paste-subtitle').click();await held(newer);await newer.keyboard.press('Escape');
 const replacement={name:'authored-newer.srt',mimeType:'application/x-subrip',buffer:Buffer.from(simple('Native file owns the newer navigation.'))};
 // Do not await input reset while the shared writer is deliberately held.
 const [picker]=await Promise.all([newer.waitForEvent('filechooser'),newer.locator('#import').click()]);await picker.setFiles(replacement);
 await expect(newer.locator('#title')).toHaveText('authored-newer');await release(newer);await expect(newer.locator('#file')).toHaveValue('');await stored(newer);await expect(newer.locator('#title')).toHaveText('authored-newer');
 check('late_paste_save_cannot_reclaim_new_native_file_import',(await active(newer)).title==='authored-newer'&&(await disk(newer)).documents.length===2);
 const newerKey=(await active(newer)).key;await choose(newer,replacement);check('duplicate_new_native_import_reuses_key_after_late_receipt',(await active(newer)).key===newerKey&&(await disk(newer)).documents.length===2);
 // Returning to the add workspace and back must not revive the cancelled owner.
 await open(newer);await expect(newer.locator('#paste-subtitle-text')).toHaveValue(simple('Authored paste replaced by native file.'));await newer.locator('#clear-paste-subtitle').click();await newer.locator('#close-paste-subtitle').click();await newer.locator('#back-reading').click();await expect(newer.locator('#title')).toHaveText('authored-newer');check('new_import_preserves_cancelled_draft_until_explicit_clear',true);

 stage='late save after navigation to existing reader';const navigation=await newPage();await draft(navigation,simple('Authored prior reading.'),{name:'Authored prior reading'});await preview(navigation);await save(navigation);const priorKey=(await active(navigation)).key;
 await draft(navigation,simple('Authored late navigation save.'),{name:'Authored late navigation save'});await preview(navigation);await hold(navigation);await navigation.locator('#confirm-paste-subtitle').click();await held(navigation);await navigation.keyboard.press('Escape');await navigation.locator('#back-reading').click();await expect(navigation.locator('#title')).toHaveText('Authored prior reading');await release(navigation);await stored(navigation);
 check('late_save_never_overrides_explicit_back_to_reading',(await active(navigation)).key===priorKey&&await navigation.locator('#reader-workspace').isVisible());
 check('no_XSS_uploads_external_API_model_requests_or_page_errors',external===0&&mutations===0&&xssRequests===0&&errors.length===0);
 console.log(JSON.stringify({suite:'pasted-subtitles',status:'passed',checks}));
}catch(error){
 failure={stage,error:error.message};
 if(process.env.COCONUT_UI_SCREENSHOTS&&browser){
  try{await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});let index=0;
   for(const context of browser.contexts())for(const page of context.pages())if(!page.isClosed()){
    try{await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'pasted-subtitles-failure-'+(++index)+'-'+(page.viewportSize()?.width||'unknown')+'.png'),animations:'disabled',timeout:5000});}catch{/* Preserve the original assertion if a page closes or screenshot fails. */}
   }
  }catch{/* Screenshot diagnostics must never mask the original failure. */}
 }
 console.error(JSON.stringify({suite:'pasted-subtitles',status:'failed',stage,checks,error:error.message,errors}));process.exitCode=1;
}
finally{
 if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'pasted-subtitles-checks.json'),JSON.stringify({status:failure?'failed':'passed',stage,failure,checks,errors,geometry},null,2));}
 await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
}
