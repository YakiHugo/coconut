/** CI-only real-browser proof. 500 authored documents, no models or external data. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium,waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
import {openLibraryTools} from './helpers/library-tools-browser.mjs';
import {startBridge} from '../desktop/server.mjs';
let browser,server,stage='setup';const checks=[],geometry={},errors=[];let external=0,mutations=0;
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
try{
 server=await startBridge({port:0});const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:320,height:568},serviceWorkers:'block',acceptDownloads:true});
 await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(!['GET','HEAD'].includes(request.method())){mutations++;await route.abort();}else if(url.origin===origin||['blob:','data:'].includes(url.protocol))await route.continue();else{external++;await route.abort();}});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
 const docs=largeLibraryFixture(500);docs[0].title='读完整个想法，再回到声音：一次关于城市、日常观察与认真倾听的自写阅读练习';docs[499].title='最后一篇 · Authored final shelf document';
 await page.locator('#library-file').setInputFiles({name:'authored-500.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({format:'coconut-library',version:1,documents:docs,active:docs[0].key}))});
 await waitForPersistedLibrary(page,async()=>(await readPersistedLibrary()).documents.length===500);
 stage='associate paused authored media';
 if(!await page.locator('#attach-reader-media').isVisible())await page.locator('#toggle-reader-media').click();
 const [picker]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-reader-media').click()]);
 await picker.setFiles({name:'authored-library-tone.wav',mimeType:'audio/wav',buffer:authoredAudioFixture(20)});
 await page.waitForFunction(()=>{const p=document.querySelector('#source-media audio');return p&&!p.error&&p.readyState>=2;});
 await page.locator('#source-media audio').evaluate(p=>{p.pause();p.currentTime=6;window.__compactPlayer=p;});
 await page.evaluate(()=>{window.__compactPlays=0;const play=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(...args){window.__compactPlays++;return play.apply(this,args);};window.__compactReader=document.getElementById('reader-workspace');window.__compactMedia=document.getElementById('source-media');});
 const screenshot=async name=>{if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'compact-library-'+name+'.png'),animations:'disabled'});}};
 const open=async()=>{if(await page.locator('#toggle-library').getAttribute('aria-expanded')==='false')await page.locator('#toggle-library').click();};
 const initialGeometry=async name=>{
  const result=await page.evaluate(()=>{const list=document.getElementById('library-list').getBoundingClientRect(),card=document.querySelector('.library-open').getBoundingClientRect(),title=document.querySelector('.library-title'),r=title.getBoundingClientRect(),close=document.getElementById('toggle-library').getBoundingClientRect();return {list:{top:list.top,bottom:list.bottom},card:{top:card.top,bottom:card.bottom},title:{top:r.top,bottom:r.bottom,full:title.scrollHeight<=title.clientHeight+1},cardArea:list.bottom-card.top,closeHeight:close.height,width:document.documentElement.scrollWidth,viewport:innerWidth};});
  geometry[name]=result;check(name+'_at_least_240px_of_real_card_space',result.cardArea>=240);check(name+'_complete_first_card_initially_visible',result.card.top>=result.list.top&&result.card.bottom<=result.list.bottom&&result.card.bottom<=568);check(name+'_full_title_and_no_horizontal_overflow',result.title.full&&result.width<=result.viewport);check(name+'_close_44px',result.closeHeight>=44);
 };
 stage='initial small-mobile full card';await page.locator('#title').focus();await open();await initialGeometry('initial');await screenshot('320-initial-500-full-card');
 check('tools_start_collapsed_and_page_count_honest',!await page.locator('#library-tools').evaluate(n=>n.open)&&/1–40.*500/.test(await page.locator('#library-page-status').textContent()));
 await page.locator('#library-search').focus();await page.keyboard.press('Escape');check('escape_returns_to_reader_title',await page.locator('#title').evaluate(n=>n===document.activeElement)&&await page.locator('#toggle-library').getAttribute('aria-expanded')==='false');
 await open();await page.locator('.library-open').first().click();check('current_document_returns_to_same_reader_anchor',await page.locator('#title').evaluate(n=>n===document.activeElement));
 check('current_document_preserves_real_media_identity_time_and_pause',await page.evaluate(()=>window.__compactPlayer===document.querySelector('#source-media audio')&&window.__compactPlayer.paused&&Math.abs(window.__compactPlayer.currentTime-6)<.1));
 stage='active document opens reading from Add';await page.locator('#add-content').click();await open();await page.locator('.library-open').first().click();
 check('active_document_from_add_opens_reader',await page.locator('#reader-workspace').isVisible()&&await page.locator('#title').evaluate(n=>n===document.activeElement));
 stage='target-owned Escape';await open();await page.locator('#library-search').focus();await page.evaluate(()=>document.getElementById('library-search').addEventListener('keydown',event=>event.preventDefault(),{once:true}));await page.keyboard.press('Escape');
 check('focused_control_can_prevent_Escape',await page.locator('#toggle-library').getAttribute('aria-expanded')==='true');await page.keyboard.press('Escape');
 stage='desktop focused search enters mobile from closed toggle';await page.setViewportSize({width:1360,height:1000});await page.locator('#library-search').focus();await page.setViewportSize({width:320,height:568});
 await page.waitForFunction(()=>document.getElementById('toggle-library').getAttribute('aria-expanded')==='true');
 check('resize_keeps_default_closed_desktop_search_visible',await page.locator('#library-search').isVisible()&&await page.locator('#library-search').evaluate(n=>n===document.activeElement));await page.keyboard.press('Escape');
 stage='query and last page';await open();await page.locator('#library-search').fill('最后一篇');await initialGeometry('query');check('search_reaches_document_500',await page.locator('.library-entry').getAttribute('data-document-key')==='shelf-499');await screenshot('320-query-document-500');
 await page.locator('#library-search').fill('');await openLibraryTools(page);
 for(const selector of ['#library-tools > summary','#library-page-number','#library-next','.library-backup > summary','#library-options > summary'])check(selector+'_44px',await page.locator(selector).evaluate(n=>n.getBoundingClientRect().height>=44));
 await page.locator('#library-page-number').fill('13');await page.locator('#library-page-number').press('Enter');
 check('page_jump_closes_tools_and_focuses_first_result',!await page.locator('#library-tools').evaluate(n=>n.open)&&await page.locator('.library-open').first().evaluate(n=>n===document.activeElement)&&await page.locator('.library-entry').first().getAttribute('data-document-key')==='shelf-480');
 await page.locator('#library-list').evaluate(n=>{n.scrollTop=0;});await initialGeometry('page13');await screenshot('320-page13-of-500');
 stage='responsive tools preserve focus and edits';await openLibraryTools(page);await page.locator('#library-options > summary').click();await page.locator('#library-sort').selectOption('title');await page.locator('.library-backup > summary').click();
 await page.locator('#library-sort').focus();
 for(let i=0;i<2;i++){
  await page.setViewportSize({width:1360,height:1000});await page.waitForFunction(()=>document.getElementById('library-tools').hidden);
  check('desktop_original_positions_'+i,await page.evaluate(()=>document.getElementById('open-library-notebook').nextElementSibling.className==='library-search'&&document.getElementById('library-options').nextElementSibling.id==='library-page-status'&&document.activeElement===document.getElementById('library-sort')));
  await page.setViewportSize({width:320,height:568});await page.waitForFunction(()=>!document.getElementById('library-tools').hidden);
  check('mobile_resize_preserves_open_state_focus_and_sort_'+i,await page.evaluate(()=>document.getElementById('library-tools').open&&document.querySelector('.library-backup').open&&document.getElementById('library-options').open&&document.activeElement===document.getElementById('library-sort')&&document.getElementById('library-sort').value==='title'));
 }
 await page.locator('#library-tools > summary').focus();await page.setViewportSize({width:1360,height:1000});await page.waitForFunction(()=>document.activeElement===document.getElementById('library-search'));
 check('desktop_resize_moves_mobile_only_summary_focus_to_search',await page.locator('#library-search').isVisible());await page.setViewportSize({width:320,height:568});await page.waitForFunction(()=>!document.getElementById('library-tools').hidden);
 stage='backup still downloads all documents';const pending=page.waitForEvent('download');await page.locator('#export-library').click();const download=await pending,backup=JSON.parse(await fs.readFile(await download.path(),'utf8'));check('complete_backup_of_500',backup.documents.length===500&&backup.documents.at(-1).title===docs.at(-1).title);
 await page.locator('#library-tools > summary').click();await page.locator('#library-search').fill('最后一篇');await page.locator('.library-open').click();check('different_document_closes_pane_at_reader_target',await page.locator('#toggle-library').getAttribute('aria-expanded')==='false'&&await page.locator('#title').evaluate(n=>n===document.activeElement&&n.textContent.includes('最后一篇')));
 check('reader_media_remain_mounted_without_autoplay',await page.evaluate(()=>window.__compactReader===document.getElementById('reader-workspace')&&window.__compactMedia===document.getElementById('source-media')&&window.__compactPlays===0));
 check('no_external_mutations_or_page_errors',external===0&&mutations===0&&errors.length===0);
 if(process.env.COCONUT_UI_SCREENSHOTS)await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'compact-library-geometry.json'),JSON.stringify({checks,geometry},null,2));
 console.log(JSON.stringify({checks,geometry},null,2));
}catch(error){console.error('Compact library proof failed at '+stage);throw error;}
finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());}
