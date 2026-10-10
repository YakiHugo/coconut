/** CI-only Chromium proof: ordinary SRT/VTT chooser, reading, notes and downloads.
 * Only original authored fixtures, static assets and browser-local data are used. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {openCueActions} from './cue-actions-browser.mjs';
import {subtitleFixtures,expectedCues,note,correction,cueSnapshot} from './helpers/subtitle-import-fixtures.mjs';
const root=new URL('../reader/',import.meta.url),KEY='coconut-reader-v1';
const checks=[];let browser,server,stage='setup',external=0,mutations=0,errors=0;
function check(name,value){assert.ok(value,name);checks.push(name);}
try{
 server=createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){mutations++;res.writeHead(405).end();return;}
  const pathname=new URL(req.url,'http://localhost').pathname,filename=pathname==='/'?'index.html':pathname.slice(1);
  if(!/^[a-z-]+\.(html|js|css|webmanifest|png)$/.test(filename)){res.writeHead(404,{'Content-Type':'application/json'}).end('{"error":"static only"}');return;}
  try{const body=await fs.readFile(new URL(filename,root));res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.png')?'image/png':'text/html'}).end(body);}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 async function newPage(width){
  const context=await browser.newContext({acceptDownloads:true,serviceWorkers:'block',viewport:{width,height:900}});
  await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin===origin||['blob:','data:'].includes(u.protocol))await route.continue();else{external++;await route.abort();}});
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',()=>errors++);
  await page.goto(origin);await page.locator('#import').waitFor({state:'visible'});return page;
 }
 const stored=page=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),KEY);
 const active=async page=>{const state=await stored(page);return state.documents.find(doc=>doc.key===state.active);};
 async function choose(page,file,title){
  if(await page.locator('#add-content').isVisible())await page.locator('#add-content').click();
  const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#import').click()]);
  await chooser.setFiles(file);
  if(title)await page.waitForFunction(title=>document.getElementById('title').textContent===title&&!document.getElementById('reader-workspace').hidden,title);
  else await page.waitForFunction(()=>document.getElementById('notice').textContent.startsWith('导入失败'));
  await page.waitForFunction(()=>document.getElementById('file').value==='');
 }
 async function download(page,selector){
  if(!await page.locator('#export-menu').evaluate(node=>node.open))await page.locator('#export-menu > summary').click();
  const [item]=await Promise.all([page.waitForEvent('download'),page.locator(selector).click()]);
  const stream=await item.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);
  assert.equal(await item.failure(),null);return {name:item.suggestedFilename(),buffer:Buffer.concat(chunks)};
 }
 for(const fixture of subtitleFixtures){
  const label=fixture.format,width=label==='srt'?1360:390,page=await newPage(width);
  stage=label+'_native_import';
  check(label+'_advertised_file_types',await page.locator('#file').getAttribute('accept')==='.json,.srt,.vtt');
  await choose(page,{name:fixture.name,mimeType:fixture.mimeType,buffer:Buffer.from(fixture.text)},fixture.title);
  assert.deepEqual(cueSnapshot(await active(page)),expectedCues);check(label+'_bom_crlf_ids_timestamps_unicode_and_multiline',true);
  await page.locator('#mode-transcript').click();
  assert.deepEqual(await page.locator('.words').allTextContents(),expectedCues.map(cue=>cue.text));
  check(label+'_renders_only_spoken_cues',await page.locator('.segment').count()===3);
  check(label+'_reading_fits_viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(label==='vtt') {
   check('vtt_native_import_preserves_voice', (await active(page)).segments[0].speaker==='Narrator');
   await page.locator('#speaker-filter').selectOption(JSON.stringify('Narrator'));
   check('vtt_voice_filter_selects_only_named_cue',await page.locator('.segment').count()===1&&(await page.locator('.words').textContent())===expectedCues[0].text);
   await page.locator('#speaker-filter').selectOption('all');
  }
  stage=label+'_note_and_correction';
  await page.locator('.segment').first().locator('.note-button').click();await page.locator('#note').fill(note);await page.locator('#close-note').click();
  const second=page.locator('.segment').nth(1);await openCueActions(second);await second.locator('.edit-button').click();
  await page.locator('#edit-segment').fill(correction);await page.locator('#save-edit').click();
  check(label+'_note_and_edit_visible',await page.locator('.saved-note').textContent()===note&&await page.locator('.words').nth(1).textContent()===correction);
  const current=await active(page);assert.equal(current.segments[1].original_text,expectedCues[1].text);
  stage=label+'_invalid_file_preserves_work';const before=await stored(page);
  await choose(page,{name:'broken.'+label,mimeType:fixture.mimeType,buffer:Buffer.from(fixture.invalid)});
  assert.deepEqual(await stored(page),before);
  check(label+'_bad_file_explains_failure',await page.locator('#notice').isVisible()&&(await page.locator('#notice').textContent()).includes('导入失败'));
  await page.locator('#back-reading').click();await page.locator('#mode-transcript').click();
  check(label+'_bad_file_keeps_active_text_and_note',await page.locator('#title').textContent()===fixture.title&&await page.locator('.saved-note').textContent()===note&&await page.locator('.words').nth(1).textContent()===correction);
  stage=label+'_json_download_reimport';
  const backup=await download(page,'#export'),json=JSON.parse(backup.buffer.toString('utf8'));
  assert.deepEqual(cueSnapshot(json),cueSnapshot(current));assert.equal(json.notes['segment-1'],note);
  const restored=await newPage(width);await choose(restored,{...backup,mimeType:'application/json'},fixture.title);await restored.locator('#mode-transcript').click();
  const restoredDocument=await active(restored);assert.deepEqual(cueSnapshot(restoredDocument),cueSnapshot(current));assert.equal(restoredDocument.segments[1].original_text,expectedCues[1].text);
  check(label+'_actual_json_download_restores_notes_in_clean_browser',await restored.locator('.saved-note').textContent()===note);
  stage=label+'_subtitle_download_reimport';
  // Export the entire document despite a visible one-cue search result.
  await page.locator('#search').fill('Corrected authored question');check(label+'_filtered_reading_has_one_cue',await page.locator('.segment').count()===1);
  if(!await page.locator('#export-menu').evaluate(node=>node.open))await page.locator('#export-menu > summary').click();
  await page.locator('#subtitle-format').selectOption(label);await page.locator('#subtitle-bilingual').uncheck();
  const subtitle=await download(page,'#export-subtitles'),text=subtitle.buffer.toString('utf8');
  check(label+'_subtitle_download_excludes_private_note',!text.includes(note)&&subtitle.name.endsWith('.'+label));
  const roundtrip=await newPage(width);await choose(roundtrip,{...subtitle,mimeType:fixture.mimeType},fixture.title);await roundtrip.locator('#mode-transcript').click();
  assert.deepEqual(cueSnapshot(await active(roundtrip)),cueSnapshot(current));
  check(label+'_actual_subtitle_download_restores_all_cues_and_milliseconds',await roundtrip.locator('.segment').count()===3&&await roundtrip.locator('.saved-note').count()===0);
  if(label==='vtt') check('vtt_actual_download_and_json_restore_keep_voice',(await active(roundtrip)).segments[0].speaker==='Narrator'&&restoredDocument.segments[0].speaker==='Narrator');
  // Refresh checks browser persistence rather than only exported data.
  await restored.reload();await restored.locator('#reader-workspace').waitFor({state:'visible'});await restored.locator('#mode-transcript').click();
  check(label+'_refresh_keeps_reimported_notes_and_correction',await restored.locator('.saved-note').textContent()===note&&await restored.locator('.words').nth(1).textContent()===correction);
  await page.context().close();await restored.context().close();await roundtrip.context().close();
 }
 check('no_uploads_model_calls_external_requests_or_page_errors',mutations===0&&external===0&&errors===0);
 console.log(JSON.stringify({suite:'subtitle-file-import',status:'passed',checks}));
}catch(error){console.error(JSON.stringify({suite:'subtitle-file-import',status:'failed',stage,checks,error:error.message}));process.exitCode=1;}
finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}
