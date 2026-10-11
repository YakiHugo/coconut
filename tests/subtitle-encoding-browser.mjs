/** Actions-only native byte files, encoding recovery, committed IndexedDB and
 * actual downloads. Authored fixtures only; no external services or models. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from './helpers/browser-storage.mjs';
import {encodingFixtures,bytesFor} from './helpers/subtitle-encoding-fixtures.mjs';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
const root=new URL('../reader/',import.meta.url),checks=[],errors=[],geometry=[];
const fixture=name=>encodingFixtures.find(f=>f.name.startsWith(name));
const input=f=>({name:f.name,mimeType:f.name.endsWith('.vtt')?'text/vtt':'application/x-subrip',buffer:bytesFor(f)});
const invalidJSON=()=>({name:'broken.json',mimeType:'application/json',buffer:Buffer.concat([Buffer.from('{"title":"Broken JSON","segments":[{"start":0,"end":1,"text":"'),Buffer.from([0xd6,0xd0]),Buffer.from('"}]}')])});
const text=f=>f.text.trim().split('\r\n').slice(-2).join('\n');
let browser,server,stage='setup',external=0,mutations=0,failure=null;
const check=(name,result)=>{assert.ok(result,name);checks.push(name);};
try{
 server=createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){mutations++;res.writeHead(405).end();return;}
  const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
  if(!/^[a-z-]+\.(html|js|css|png)$/.test(name)){res.writeHead(404).end();return;}
  try{res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html');res.end(await fs.readFile(new URL(name,root)));}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});
 async function newPage(width=1280){
  const context=await browser.newContext({viewport:{width,height:844},acceptDownloads:true,serviceWorkers:'block'});
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['blob:','data:'].includes(url.protocol))return route.continue();external++;return route.abort();});
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);return page;
 }
 async function choose(page,files,selector='#import'){
  if(selector==='#import'&&await page.locator('#add-content').isVisible())await page.locator('#add-content').click();
  const [picker]=await Promise.all([page.waitForEvent('filechooser'),page.locator(selector).click()]);await picker.setFiles(files);
 }
 async function stored(page){await page.evaluate(()=>libraryStore.flush());return page.evaluate(()=>readPersistedLibrary());}
 async function active(page){const state=await stored(page),key=await page.evaluate(()=>sessionStorage.getItem('coconut-reader-active-v1'));return state.documents.find(doc=>doc.key===key);}
 async function finished(page,id='file'){await expect(page.locator('#'+id)).toHaveValue('');}
 async function selectEncoding(page,f){
  await expect(page.locator('#subtitle-encoding-dialog')).toBeVisible();await expect(page.locator('#subtitle-encoding-file')).toHaveText(f.name);
  await page.locator('#subtitle-encoding').selectOption(f.encoding);await expect(page.locator('#confirm-subtitle-encoding')).toBeEnabled();
  check(f.name+'_exact_native_preview_'+checks.length,await page.locator('#subtitle-encoding-preview').textContent()===f.text);
 }
 async function accept(page,f){await selectEncoding(page,f);await page.locator('#confirm-subtitle-encoding').click();}
 async function exportJSON(page,selector='#export'){
  if(!await page.locator('#export-menu').evaluate(n=>n.open))await page.locator('#export-menu > summary').click();
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator(selector).click()]);
  return {name:download.suggestedFilename(),mimeType:'application/json',buffer:await fs.readFile(await download.path())};
 }
 async function keyboardGeometry(page,label){
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const value=await page.evaluate(()=>{
   const node=document.activeElement,host=document.getElementById('subtitle-encoding-dialog'),r=node.getBoundingClientRect(),d=host.getBoundingClientRect(),style=getComputedStyle(node),ring=(parseFloat(style.outlineWidth)||0)+Math.max(0,parseFloat(style.outlineOffset)||0),x=(r.left+r.right)/2,y=(r.top+r.bottom)/2;
   return {id:node.id,inside:node.closest('dialog')===host,visibleFocus:node.matches(':focus-visible'),outline:style.outlineStyle,ring,rect:r.toJSON(),dialog:d.toJSON(),viewport:{width:innerWidth,height:innerHeight},pageWidth:document.documentElement.scrollWidth,dialogWidth:host.scrollWidth,dialogClientWidth:host.clientWidth,hits:[[x,y],[r.left+1,y],[r.right-1,y],[x,r.top+1],[x,r.bottom-1]].map(([x,y])=>{const hit=document.elementFromPoint(x,y);return {x,y,clear:hit===node||node.contains(hit),hit:hit?.id||hit?.tagName};})};
  });
  geometry.push({label,...value});const {rect:r,dialog:d,ring,viewport:v}=value;
  const okay=value.inside&&value.visibleFocus&&value.outline!=='none'&&ring>0&&r.width>=44&&r.height>=44&&r.left-ring>=Math.max(0,d.left)&&r.right+ring<=Math.min(v.width,d.right)&&r.top-ring>=Math.max(0,d.top)&&r.bottom+ring<=Math.min(v.height,d.bottom)&&value.hits.every(hit=>hit.clear)&&value.pageWidth<=v.width&&value.dialogWidth<=value.dialogClientWidth+1;
  if(!okay&&process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'subtitle-encoding-geometry-failure.png')});}
  check(label+'_44px_ring_and_five_clear_hit_points',okay);
 }
 for(const width of [390,1280]){
  const page=await newPage(width);stage='BOM auto import '+width;
  for(const f of encodingFixtures.filter(f=>!f.encoding)){
   await choose(page,input(f));await finished(page);assert.equal((await active(page)).segments[0].text,text(f));
   check(f.name+'_native_auto_BOM_'+width,!await page.locator('#subtitle-encoding-dialog').isVisible());
  }
  stage='legacy recovery '+width;const f=fixture('gb18030');await choose(page,input(f));await expect(page.locator('#subtitle-encoding-dialog')).toBeVisible();
  const count=(await stored(page)).documents.length;
  await expect(page.locator('#confirm-subtitle-encoding')).toBeDisabled();await page.locator('#subtitle-encoding').selectOption('utf-8');
  await expect(page.locator('#subtitle-encoding-status')).toContainText('无法完整解码');await expect(page.locator('#confirm-subtitle-encoding')).toBeDisabled();
  await selectEncoding(page,f);check('preview_never_mutates_library_'+width,(await stored(page)).documents.length===count);
  check('recovery_dialog_fits_width_and_touch_targets_'+width,await page.locator('#subtitle-encoding-dialog').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight+1&&Array.from(n.querySelectorAll('button')).filter(b=>!b.hidden).every(b=>b.getBoundingClientRect().height>=44)&&document.documentElement.scrollWidth<=innerWidth;}));
  await page.locator('#subtitle-encoding').focus();
  for(const key of ['Tab','Shift+Tab'])for(let i=0;i<8;i++){await page.keyboard.press(key);await keyboardGeometry(page,'single_'+width+'_'+key+'_'+i);}
  await page.locator('#subtitle-encoding-preview').focus();check('encoding_preview_visible_focus_ring_'+width,await page.locator('#subtitle-encoding-preview').evaluate(n=>{const style=getComputedStyle(n);return style.outlineStyle==='solid'&&parseFloat(style.outlineWidth)>=2;}));
  if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'subtitle-encoding-'+width+'.png')});}
  await page.keyboard.press('Escape');await finished(page);await expect(page.locator('#import')).toBeFocused();check('native_escape_no_import_'+width,(await stored(page)).documents.length===count);
  await choose(page,input(f));await accept(page,f);await finished(page);await page.locator('#mode-transcript').click();assert.equal((await active(page)).segments[0].text,text(f));
  await page.locator('.note-button').first().click();await page.locator('#note').fill('Authored encoding recovery note');await page.locator('#close-note').click();await stored(page);
  const download=await exportJSON(page),backup=JSON.parse(download.buffer.toString('utf8'));assert.equal(backup.segments[0].text,text(f));assert.equal(backup.notes['segment-1'],'Authored encoding recovery note');
  const restored=await newPage(width);await choose(restored,download);await finished(restored);await restored.reload();const saved=await active(restored);
  check('actual_JSON_download_clean_restore_and_IndexedDB_reload_'+width,saved.segments[0].text===text(f)&&saved.notes['segment-1']==='Authored encoding recovery note');
  await page.context().close();await restored.context().close();
  const stopped=await newPage(width);stage='batch stop keyboard geometry '+width;await choose(stopped,[input(fixture('gb18030')),input(fixture('big5'))]);await selectEncoding(stopped,f);await stopped.locator('#subtitle-encoding').focus();
  for(const key of ['Tab','Shift+Tab'])for(let i=0;i<10;i++){await stopped.keyboard.press(key);await keyboardGeometry(stopped,'batch_'+width+'_'+key+'_'+i);}
  await stopped.locator('#stop-subtitle-encoding').click();await finished(stopped);await expect(stopped.locator('#import')).toBeFocused();check('actual_stop_all_remaining_'+width,JSON.stringify(await stopped.locator('.transcript-import-item').evaluateAll(nodes=>nodes.map(n=>n.dataset.status)))===JSON.stringify(['cancelled','cancelled'])&&(await stored(stopped)).documents.length===0);await stopped.context().close();
 }
 stage='mixed native batch';const batch=await newPage(390);await choose(batch,encodingFixtures.map(input));
 for(const f of encodingFixtures.filter(f=>f.encoding))await accept(batch,f);await finished(batch);
 const documents=(await stored(batch)).documents;assert.equal(documents.length,encodingFixtures.length);for(const [i,f] of encodingFixtures.entries())assert.equal(documents[i].segments[0].text,text(f));
 check('all_encodings_native_batch_saved',await batch.locator('.transcript-import-item[data-status=saved]').count()===8);await batch.reload();check('batch_native_IndexedDB_reload',(await stored(batch)).documents.length===8);
 stage='batch skip and native Escape';const cancelled=await newPage(390);await choose(cancelled,[input(fixture('utf8')),input(fixture('gb18030')),input(fixture('big5'))]);await expect(cancelled.locator('#subtitle-encoding-file')).toHaveText('gb18030.srt');await cancelled.locator('#cancel-subtitle-encoding').click();await expect(cancelled.locator('#subtitle-encoding-file')).toHaveText('big5.vtt');await cancelled.keyboard.press('Escape');await finished(cancelled);
 check('batch_skip_then_escape_keep_prior_saved',JSON.stringify(await cancelled.locator('.transcript-import-item').evaluateAll(nodes=>nodes.map(n=>n.dataset.status)))===JSON.stringify(['saved','skipped','cancelled'])&&(await stored(cancelled)).documents.length===1);
 stage='same media project';const project=await newPage(390);await choose(project,{name:'authored.wav',mimeType:'audio/wav',buffer:authoredAudioFixture(4)},'#open-local-media');await finished(project,'local-media-file');
 await project.locator('#project-note').fill('Keep original project note');await project.locator('#audio-bookmark-time').fill('1');await project.locator('#audio-bookmark-note').fill('Keep timestamp note');await project.locator('#audio-bookmark-form button[type=submit]').click();
 const original=await active(project);await choose(project,invalidJSON(),'#attach-project-transcript');await finished(project,'project-transcript-file');assert.deepEqual(await active(project),original);await expect(project.locator('#notice')).toContainText('JSON 备份包含无法按 UTF-8');
 await choose(project,input(fixture('big5')),'#attach-project-transcript');await selectEncoding(project,fixture('big5'));assert.equal((await active(project)).segments.length,0);await project.locator('#cancel-subtitle-encoding').click();await finished(project,'project-transcript-file');
 await choose(project,input(fixture('big5')),'#attach-project-transcript');await accept(project,fixture('big5'));await finished(project,'project-transcript-file');let attached=await active(project);
 check('project_keeps_identity_media_and_annotations',attached.key===original.key&&attached.project_note===original.project_note&&attached.timestamp_bookmarks[0].note===original.timestamp_bookmarks[0].note&&attached.local_media_source.fingerprint===original.local_media_source.fingerprint&&attached.segments[0].text===text(fixture('big5')));
 await project.reload();attached=await active(project);check('project_reload_keeps_unicode_and_reselection_hint',attached.key===original.key&&attached.segments[0].text===text(fixture('big5'))&&(await project.locator('#reader-media-status').textContent()).includes('authored.wav'));
 stage='encoding save failure rescue';const failed=await newPage();await failed.evaluate(()=>failContentWrites());await choose(failed,[input(fixture('gb18030')),input(fixture('big5'))]);await accept(failed,fixture('gb18030'));await finished(failed);
 await expect(failed.locator('.transcript-import-item').first()).toHaveAttribute('data-status','unsaved');await expect(failed.locator('.transcript-import-item').nth(1)).toHaveAttribute('data-status','cancelled');check('failed_encoding_save_stops_batch',(await stored(failed)).documents.length===0);
 const [rescue]=await Promise.all([failed.waitForEvent('download'),failed.locator('#export-unsaved-documents').click()]);const rescued=JSON.parse(await fs.readFile(await rescue.path(),'utf8'));assert.equal(rescued.documents[0].segments[0].text,text(fixture('gb18030')));
 await failed.evaluate(()=>restoreContentWrites());await failed.locator('#retry-save').click();await expect(failed.locator('#save-status')).toHaveAttribute('data-state','saved');await failed.reload();check('failed_save_rescue_retry_and_reload',(await stored(failed)).documents[0].segments[0].text===text(fixture('gb18030')));
 stage='late byte ownership';const late=await newPage();await late.evaluate(()=>{
  const original=File.prototype.arrayBuffer;window.encodingProbe={reads:0,done:false};File.prototype.arrayBuffer=async function(){if(this.name==='gb18030.srt'){encodingProbe.reads++;await new Promise(resolve=>encodingProbe.release=resolve);const bytes=await original.call(this);encodingProbe.done=true;return bytes;}return original.call(this);};
 });
 await choose(late,input(fixture('gb18030')));await late.waitForFunction(()=>!!window.encodingProbe.release);await choose(late,input(fixture('utf8')));await finished(late);await late.evaluate(()=>encodingProbe.release());await late.waitForFunction(()=>encodingProbe.done);await late.evaluate(()=>new Promise(resolve=>setTimeout(resolve,30)));
 check('late_bytes_never_open_dialog_or_replace_newer_reader',(await stored(late)).documents.length===1&&(await active(late)).title==='utf8'&&!await late.locator('#subtitle-encoding-dialog').isVisible());
 stage='malformed UTF16 and BOM mismatch';await choose(late,{name:'broken.srt',mimeType:'application/x-subrip',buffer:Buffer.from([255,254,0,216])});await expect(late.locator('#subtitle-encoding-dialog')).toBeVisible();await late.locator('#subtitle-encoding').selectOption('utf-16be');await expect(late.locator('#subtitle-encoding-status')).toContainText('BOM');await late.locator('#subtitle-encoding').selectOption('utf-16le');await expect(late.locator('#subtitle-encoding-status')).toContainText('无法完整解码');await expect(late.locator('#confirm-subtitle-encoding')).toBeDisabled();await late.locator('#cancel-subtitle-encoding').click();await finished(late);check('malformed_bytes_cannot_silently_replace_source',(await stored(late)).documents.length===1);
 stage='native JSON BOM and literal replacement character';const jsonUnicode=await newPage(),jsonText=JSON.stringify({title:'Native JSON Unicode',segments:[{start:0,end:1,text:'Literal � survives'}]}),jsonBytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(jsonText)]);
 await choose(jsonUnicode,{name:'valid.json',mimeType:'application/json',buffer:jsonBytes});await finished(jsonUnicode);check('native_single_BOM_JSON_and_literal_replacement_are_preserved',(await active(jsonUnicode)).segments[0].text==='Literal � survives');
 await choose(jsonUnicode,{name:'double-bom.json',mimeType:'application/json',buffer:Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),jsonBytes])});await finished(jsonUnicode);await expect(jsonUnicode.locator('#notice')).toContainText('导入失败');check('double_BOM_JSON_keeps_original_parser_rejection',(await stored(jsonUnicode)).documents.length===1);
 stage='strict JSON bytes';const prior=await active(late);await choose(late,invalidJSON());await finished(late);assert.deepEqual(await active(late),prior);await expect(late.locator('#notice')).toContainText('JSON 备份包含无法按 UTF-8');
 const jsonBatch=await newPage();await choose(jsonBatch,[invalidJSON(),input(fixture('utf16be'))]);await finished(jsonBatch);check('strict_JSON_failure_continues_batch_without_encoding_picker',await jsonBatch.locator('.transcript-import-item[data-status=failed]').count()===1&&(await stored(jsonBatch)).documents.length===1&&!await jsonBatch.locator('#subtitle-encoding-dialog').isVisible());
 check('no_external_upload_model_or_page_errors' ,external===0&&mutations===0&&errors.length===0);
 console.log(JSON.stringify({suite:'subtitle-encoding',status:'passed',checks}));
}catch(error){failure={stage,error:error.message};console.error(JSON.stringify({suite:'subtitle-encoding',status:'failed',stage,checks,error:error.message,errors}));process.exitCode=1;}
finally{
 if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'subtitle-encoding-checks.json'),JSON.stringify({status:failure?'failed':'passed',stage,failure,checks,errors,geometry},null,2));}
 await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
}
