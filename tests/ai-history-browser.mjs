/** CI-only Chromium acceptance. Authored transcript/history, browser-local storage
 * and real downloads only. No provider, CLI, account, media or external requests. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium, waitForPersistedLibrary} from './helpers/browser-storage.mjs';
const root=new URL('../reader/',import.meta.url),KEY='coconut-reader-v1';
const checks=[];let browser,server,directory,stage='setup',external=0,mutations=0,modelRequests=0,errors=0;
function check(name,value){stage=name;assert.ok(value,name);checks.push(name);}
const segments=Array.from({length:3},(_,i)=>({id:'cue-'+i,start:i*4,end:i*4+4,text:`Authored historical source ${i}.`}));
const fixture={title:'完整 AI 历史 · 自写验收',language:'en',segments,notes:{'cue-0':'Authored local reading note.'},ai_answers:Array.from({length:245},(_,i)=>({
 question:`Authored question ${i+1}`,answer:`Authored answer ${i+1}${i===244?' · '+'unbroken-authored-text'.repeat(30):''}`,provider:'authored-fixture',purpose:i===1||i===24?'summary':'question',citations:['cue-'+i%3],input_snapshot:{version:1,segments:segments.map(({id,text})=>({id,text}))}
}))};
fixture.ai_answers[0].citations=['removed-cue'];fixture.ai_answers[0].input_snapshot.segments.push({id:'removed-cue',text:'Historical source that no longer exists in this transcript.'});
async function capture(page,name){
 if(!process.env.COCONUT_UI_SCREENSHOTS)return;
 await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});
 await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,name+'.png'),fullPage:false});
}
try{
 directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-ai-history-'));
 server=createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){mutations++;res.writeHead(405).end();return;}
  const pathname=new URL(req.url,'http://localhost').pathname,filename=pathname==='/'?'index.html':pathname.slice(1);
  if(!/^[a-z-]+\.(html|js|css|webmanifest|png)$/.test(filename)){res.writeHead(404,{'Content-Type':'application/json'}).end('{"error":"static only"}');return;}
  try{const body=await fs.readFile(new URL(filename,root));res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.png')?'image/png':'text/html'}).end(body);}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});
 async function newPage(width=1360){
  const context=await browser.newContext({acceptDownloads:true,serviceWorkers:'block',viewport:{width,height:844}});
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.origin===origin){if(/^\/api\/(ask|translate|translate-subscription|language-tools)$/.test(url.pathname))modelRequests++;await route.continue();}
   else if(['blob:','data:'].includes(url.protocol))await route.continue();
   else{external++;await route.abort();}
  });
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',()=>errors++);
  await page.goto(origin);await page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='ready');await page.locator('#import').waitFor({state:'visible'});return page;
 }
 const active = async page => {await page.evaluate(()=>libraryStore.flush());return page.evaluate(async key=>{const state=await readPersistedLibrary();return state?.documents.find(doc=>doc.key===sessionStorage.getItem('coconut-reader-active-v1'));},KEY);};
 async function choose(page,file){
  const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#import').click()]);await chooser.setFiles(file);
  await waitForPersistedLibrary(page,async key=>{const state=await readPersistedLibrary();return state?.documents.find(doc=>doc.key===sessionStorage.getItem('coconut-reader-active-v1'))?.ai_answers.length===245&&!document.getElementById('reader-workspace').hidden;},KEY);
  await page.waitForFunction(()=>document.getElementById('file').value==='');
 }
 async function download(page,selector,name){
  const [item]=await Promise.all([page.waitForEvent('download'),page.locator(selector).click()]);
  const filename=path.join(directory,name);await item.saveAs(filename);assert.equal(await item.failure(),null);assert.ok((await fs.stat(filename)).size>0);return filename;
 }
 const page=await newPage();stage='native_import';
 await choose(page,{name:'authored-history.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
 check('all_245_records_persist_without_truncation',(await active(page)).ai_answers.length===245);
 check('latest_explicit_summary_survives_later_questions',await page.locator('#summary-body').textContent()==='Authored answer 25');
 await page.locator('#browse-ai-history').click();
 check('summary_history_entry_is_visible_and_focused',await page.locator('#ai-history-heading').isVisible()&&await page.locator('#ai-history-heading').evaluate(node=>node===document.activeElement));
 for(const [label,width] of [['desktop',1360],['mobile',390]]){
  stage=label+'_history_navigation';await page.setViewportSize({width,height:844});
  check(label+'_latest_page_mounts_only_ten_records',await page.locator('.ai-answer').count()===10&&await page.locator('.ai-answer').first().getAttribute('data-answer-number')==='245');
  check(label+'_total_and_page_count_visible',(await page.locator('#ai-history-status').textContent()).includes('共 245 则 · 第 1 / 25 页'));
  await page.locator('#ai-history-heading').evaluate(node=>node.scrollIntoView({block:'start',behavior:'instant'}));
  check(label+'_history_fits_width',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await capture(page,'ai-history-'+label+'-latest');
  await page.locator('#ai-history-oldest').focus();await page.keyboard.press('Enter');
  check(label+'_oldest_keyboard_action_preserves_visible_focus',await page.locator('#ai-history-heading').evaluate(node=>node===document.activeElement));
  check(label+'_oldest_page_is_bounded_and_at_the_end',await page.locator('.ai-answer').count()===5&&await page.locator('.ai-answer').last().getAttribute('data-answer-number')==='1'&&await page.locator('#ai-history-older').isDisabled());
  const missing=page.locator('.ai-answer[data-answer-number="1"]');
  check(label+'_removed_citation_is_text_and_has_no_jump',(await missing.textContent()).includes('原片段已不存在：removed-cue')&&await missing.locator('button,a').count()===0);
  check(label+'_removed_source_still_marks_answer_stale',(await missing.textContent()).includes('依据可能过期'));
  await missing.scrollIntoViewIfNeeded();check(label+'_old_history_fits_width',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await capture(page,'ai-history-'+label+'-oldest');
  await page.locator('#ai-history-latest').focus();await page.keyboard.press('Enter');
  check(label+'_latest_keyboard_action_restores_first_page_and_focus',await page.locator('#ai-history-heading').evaluate(node=>node===document.activeElement)&&await page.locator('.ai-answer').first().getAttribute('data-answer-number')==='245'&&await page.locator('#ai-history-newer').isDisabled());
 }
 stage='complete_downloads';
 await page.locator('#ai-history-oldest').click();await page.locator('#search').fill('no authored source matches this filter');
 const markdownFile=await download(page,'#export-ai-reading','history.ai-reading.md'),markdown=await fs.readFile(markdownFile,'utf8');
 check('real_markdown_download_keeps_all_245_records_independent_of_page_and_filter',(markdown.match(/^## 回答 /gm)||[]).length===245&&markdown.includes('Authored answer 1\n')&&markdown.includes('Authored answer 245'));
 check('real_markdown_keeps_removed_historical_source',markdown.includes('Historical source that no longer exists')&&markdown.includes('原片段已移除'));
 const jsonFile=await download(page,'#export-ai-history-json','history.json'),json=JSON.parse(await fs.readFile(jsonFile,'utf8'));
 assert.deepEqual(json.ai_answers,(await active(page)).ai_answers);check('real_json_download_keeps_every_record_snapshot_and_missing_reference',json.ai_answers.length===245&&json.ai_answers[0].citations[0]==='removed-cue');
 stage='reload';await page.reload();await page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='ready');await page.locator('#reader-workspace').waitFor({state:'visible'});
 check('refresh_keeps_all_records_and_latest_summary',(await active(page)).ai_answers.length===245&&await page.locator('#summary-body').textContent()==='Authored answer 25');
 await page.locator('#browse-ai-history').click();check('refresh_shows_bounded_latest_page_and_saved_count',await page.locator('.ai-answer').count()===10&&(await page.locator('#ai-history-storage').textContent()).includes('245 则均已保存'));
 stage='clean_browser_restore';const restored=await newPage(390);await choose(restored,jsonFile);assert.deepEqual((await active(restored)).ai_answers,json.ai_answers);
 await restored.locator('#browse-ai-history').click();await restored.locator('#ai-history-oldest').click();
 check('download_restores_full_history_and_old_missing_reference_in_clean_mobile_browser',await restored.locator('.ai-answer').count()===5&&(await restored.locator('.ai-answer').last().textContent()).includes('原片段已不存在'));
 check('restored_mobile_history_fits',await restored.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 check('zero_provider_upload_external_or_uncaught_browser_errors',modelRequests===0&&mutations===0&&external===0&&errors===0);
 console.log(JSON.stringify({suite:'complete-ai-reading-history',status:'passed',checks}));
}catch(error){console.error(JSON.stringify({suite:'complete-ai-reading-history',status:'failed',stage,checks,error:error.message}));process.exitCode=1;}
finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));if(directory)await fs.rm(directory,{recursive:true,force:true});}
