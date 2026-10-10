import {openCueActions} from './cue-actions-browser.mjs';
import {splitCueFixture} from './helpers/split-cue-fixture.mjs';
/** Real Chromium proof for the static Web product; no Python service or AI calls. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {chromium} from './helpers/browser-storage.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
let directory,server,browser,stage='setup';
const checks=[];
// Only authored synthetic fixtures from this file may enter these review images.
async function capture(page,name,fullPage=true){
 if(!process.env.COCONUT_UI_SCREENSHOTS)return;
 await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});
 // A full-page document image starts at the top so sticky UI isn't stranded mid-page.
 // Viewport-only evidence preserves exactly the user's current reading position.
 const scroll=await page.evaluate(()=>({x:scrollX,y:scrollY}));
 if(fullPage)await page.evaluate(()=>scrollTo(0,0));
 await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,name+'.png'),fullPage});
 if(fullPage)await page.evaluate(({x,y})=>scrollTo(x,y),scroll);
}
function check(name,value){stage=name;assert.ok(value,name);checks.push(name);}
try {
 directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-static-web-'));
 const video=path.join(directory,'synthetic.mp4'),audio=path.join(directory,'synthetic.wav');
 execFileSync('ffmpeg',['-nostdin','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','8','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',video],{timeout:30000});
 execFileSync('ffmpeg',['-nostdin','-loglevel','error','-i',video,'-vn',audio],{timeout:30000});
 const segments=[{id:'first',start:0,end:2,text:'This is an original synthetic browser test.'},{id:'second',start:2,end:4,text:'Audio and video stay in this browser.'},{id:'last',start:4,end:6,text:'A saved summary must keep its source.'}];
 const fixture={title:'浏览器验证 · 自写示例',segments,ai_answers:[{purpose:'summary',question:'Synthetic summary fixture',answer:'这是一份自写的浏览器验证摘要，不是模型生成的真实节目摘要。',provider:'synthetic-test-fixture',citations:['second'],input_snapshot:{version:1,segments:segments.map(({id,text})=>({id,text}))}}]};
 const fixturePath=path.join(directory,'fixture.json');await fs.writeFile(fixturePath,JSON.stringify(fixture));
 let mutations=0;
 server=createServer(async(req,res)=>{
  if(req.method!=='GET'&&req.method!=='HEAD'){mutations++;res.writeHead(405).end();return;}
  const pathname=new URL(req.url,'http://localhost').pathname;
  const filename=pathname==='/'?'index.html':pathname.slice(1);
  if(!/^[a-z-]+\.(html|js|css|webmanifest|png)$/.test(filename)){res.writeHead(404,{'Content-Type':'application/json'}).end('{"error":"static only"}');return;}
  try{const data=await fs.readFile(path.join(root,'reader',filename));res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.png')?'image/png':'text/html'});res.end(data);}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({acceptDownloads:true,viewport:{width:1360,height:1000},serviceWorkers:'block'});
 let external=0,pageErrors=0;
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.origin===origin||['blob:','data:'].includes(u.protocol))await route.continue();else{external++;await route.abort();}
 });
 const page=await context.newPage();page.on('pageerror',()=>pageErrors++);page.setDefaultTimeout(15000);
 await page.goto(origin);await page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='ready');await page.locator('#sample').waitFor({state:'visible'});
 await page.waitForFunction(()=>!document.getElementById('worker-status').textContent.includes('正在检查'));
 await capture(page,'01-source-entry');
 check('brand_asset_loads',await page.locator('.brand-mark').evaluate(img=>img.complete&&img.naturalWidth>0));
 await page.setViewportSize({width:390,height:844});
 check('mobile_first_use_fits',await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await capture(page,'01-mobile-source-entry');
 await page.setViewportSize({width:1360,height:1000});
 check('static_web_prioritizes_working_import',await page.locator('#import').evaluate(n=>n.classList.contains('primary'))&&await page.locator('#process-url').textContent()==='查看连接方式');
 await page.locator('#process-url').click();
 check('static_source_failure_has_an_honest_next_step',(await page.locator('#source-route-status').textContent()).includes('本地服务')&&await page.locator('#local-setup').evaluate(n=>n.open));
 await capture(page,'01-source-unavailable');await page.locator('#video-url').fill('');await page.locator('#local-setup > summary').click();
 await page.locator('#sample').click();await page.locator('#demo-guide').waitFor({state:'visible'});
 check('demo_opens_actual_bilingual_reading',await page.locator('#mode-bilingual').getAttribute('aria-pressed')==='true'&&await page.locator('.translation').count()===3);
 check('demo_discloses_authored_content',(await page.locator('#demo-guide').textContent()).includes('无音视频')&&await page.locator('#summary-body').textContent()==='');
 await capture(page,'02-bilingual-demo');
 await page.locator('#demo-note').click();await page.locator('#note').fill('My authored first reading note');await capture(page,'02-open-note');
 await page.setViewportSize({width:390,height:844});
 check('mobile_open_note_fits',await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await capture(page,'02-mobile-open-note');
 await page.locator('#close-note').click();await page.setViewportSize({width:1360,height:1000});
 await page.locator('#demo-finish').click();await page.locator('#sample').click();
 check('repeated_demo_preserves_note',await page.locator('.saved-note').textContent()==='My authored first reading note');
 await page.setViewportSize({width:390,height:844});
 await page.locator('#demo-finish').click();await page.locator('#sample').click();
 check('one_click_mobile_tryout_reveals_actual_source',await page.locator('.words').first().evaluate(n=>{const r=n.getBoundingClientRect();return r.top<innerHeight*0.6&&r.bottom>0;}));
 check('one_click_mobile_tryout_shows_both_languages',await page.locator('.parallel-text').first().evaluate(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}));
 await capture(page,'02-mobile-first-viewport',false);
 check('mobile_bilingual_demo_fits',await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await capture(page,'02-mobile-bilingual-demo');
 await page.locator('#toggle-demo-tools').click();await page.locator('#search').fill('good idea');await page.locator('#toggle-demo-tools').click();
 check('collapsed_demo_tools_keep_filter_visible',await page.locator('.segment').count()===1&&(await page.locator('#toggle-demo-tools').textContent()).includes('筛选中'));
 await page.locator('#toggle-demo-tools').click();await page.locator('#clear-search').click();await page.locator('#toggle-demo-tools').click();
 check('demo_tools_preserve_bilingual_reading',await page.locator('.translation').count()===3&&await page.locator('#mode-bilingual').getAttribute('aria-pressed')==='true');
 await page.locator('#mode-summary').click();check('demo_search_tools_hidden_in_summary',await page.locator('#toggle-demo-tools').isHidden());
 await page.locator('#mode-bilingual').click();await page.locator('#toggle-demo-tools').click();
 check('demo_tools_return_to_visible_search',await page.locator('#search').isVisible()&&await page.locator('#search').evaluate(n=>n===document.activeElement));
 await page.setViewportSize({width:1360,height:1000});stage='import';
 await page.locator('#file').setInputFiles(fixturePath);
 await page.locator('#reader-workspace').waitFor({state:'visible'});
 check('summary_is_default',await page.locator('#summary-workspace').isVisible()&&await page.locator('#transcript-layout').isHidden());
 check('saved_summary_visible',(await page.locator('#summary-body').textContent()).includes('自写的浏览器验证'));
 check('summary_source_current',await page.locator('#summary-state').getAttribute('data-state')==='current');
 await capture(page,'02-episode-summary');
 await page.locator('#prepare-summary').click();check('summary_review_is_inline',await page.locator('#summary-request').isVisible()&&await page.locator('#language-panel').isHidden());await capture(page,'03-summary-review');await page.locator('#close-summary-request').click();
 await page.locator('#summary-citations button').click();
 check('citation_opens_original',await page.locator('#transcript-layout').isVisible()&&await page.locator('.segment[data-segment-id="second"]').evaluate(n=>n===document.activeElement));
 async function attach(filename,kind){
  if(!await page.locator('#attach-reader-media').isVisible())await page.locator('#toggle-reader-media').click();
  const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-reader-media').click()]);await chooser.setFiles(filename);
  await page.waitForFunction(kind=>{const p=document.querySelector('#source-media '+kind);return p&&!p.error&&p.readyState>=2&&p.duration>0;},kind);
  check(kind+'_uses_browser_file',(await page.locator('#source-media '+kind).getAttribute('src')).startsWith('blob:'));
  await page.locator('.segment[data-segment-id="second"] .time > button').first().click();
  await page.waitForFunction(kind=>{const p=document.querySelector('#source-media '+kind);return !p.paused&&p.currentTime>2;},kind);
  check(kind+'_seek_and_play',true);
  await page.locator('#source-media '+kind).evaluate(p=>p.pause());
 }
 await attach(video,'video');
 check('video_decoded',await page.locator('video').evaluate(v=>v.videoWidth===320&&v.videoHeight===180));
 await page.locator('video').evaluate(v=>v.play());
 await page.locator('#mode-summary').click();
 check('summary_keeps_visible_media_playing',await page.locator('video').isVisible()&&await page.locator('video').evaluate(v=>!v.paused));
 await page.locator('video').evaluate(v=>v.pause());
 await page.locator('#mode-transcript').click();await attach(audio,'audio');
 check('audio_replaces_video',await page.locator('video').count()===0);
 const row=page.locator('.segment[data-segment-id="second"]');
 await row.locator('.note-button').click();await page.locator('#note').fill('Synthetic note survives mode changes');await page.locator('#close-note').click();
 await openCueActions(row);await row.locator('.edit-button').click();await page.locator('#edit-segment').fill('A corrected synthetic source sentence.');await page.locator('#save-edit').click();
 await page.locator('#mode-summary').click();check('edited_source_marks_summary_stale',await page.locator('#summary-state').getAttribute('data-state')==='stale');
 const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#export-summary').click()]);
 const exported=path.join(directory,'summary.md');await download.saveAs(exported);const markdown=await fs.readFile(exported,'utf8');
 check('summary_export_has_historical_input',markdown.includes('Audio and video stay in this browser')&&markdown.includes('播客摘要')&&markdown.includes('旧摘要可能过期'));
 await page.evaluate(()=>libraryStore.flush());
 check('object_urls_never_persist',await page.evaluate(async()=>!JSON.stringify(await readPersistedLibrary()).includes('blob:')));
 await page.reload();await page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='ready');await page.locator('#summary-workspace').waitFor({state:'visible'});
 check('refresh_keeps_summary_state',await page.locator('#summary-state').getAttribute('data-state')==='stale');
 check('refresh_requires_file_reselection',await page.locator('#source-media audio,#source-media video').count()===0);
 await page.locator('#mode-transcript').click();await page.locator('.segment[data-segment-id="second"] .note-button').click();
 check('refresh_keeps_notes',await page.locator('#note').inputValue()==='Synthetic note survives mode changes');
 check('zero_model_upload_or_external_requests',mutations===0&&external===0);
 check('zero_uncaught_browser_errors',pageErrors===0);
 // Mobile is the same complete reader, with no horizontal overflow.
 await page.locator('#close-note').click();await page.setViewportSize({width:390,height:844});await page.locator('#mode-summary').click();
 check('mobile_summary_fits',await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await capture(page,'04-mobile-summary');
 const oversize={title:'Synthetic summary limit test',language:'en',segments:Array.from({length:20001},(_,i)=>({id:'limit-'+i,start:i,end:i+1,text:i?'Other cue':'Unique selected source'}))};
 await page.locator('#file').setInputFiles({name:'summary-limit.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(oversize))});
 await page.locator('#mode-summary').click();await page.locator('#summary-readiness').waitFor({state:'visible'});
 check('oversize_summary_blocked_before_consent',await page.locator('#prepare-summary').isDisabled()&&!(await page.locator('#ai-consent').isChecked()));
 check('mobile_summary_limit_fits',await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 await page.locator('#summary-select-excerpt').click();await page.locator('#search').fill('Unique selected');
 check('summary_recovery_is_filtered_question',await page.locator('#ai-task').inputValue()==='question'&&await page.locator('#ai-filtered').isChecked()&&await page.locator('.segment').count()===1);
 await page.locator('#ai-task').selectOption('summary');await page.locator('#ai-consent').check();
 await page.locator('#ask-ai').evaluate(button=>button.onclick());
 check('manual_oversize_send_still_blocked',await page.locator('#ask-ai').isDisabled()&&!(await page.locator('#ai-consent').isChecked())&&(await page.locator('#ai-progress').textContent()).includes('整篇摘要暂不可用'));
 check('summary_preflight_does_not_generate_or_send',mutations===0&&external===0&&await page.locator('#summary-body').textContent()==='');
 check('summary_preflight_has_no_browser_errors',pageErrors===0);
 // Navigation uses real authored source text, including the last page, never invented chapters.
 const longSource={title:'一份长文字稿 · 自写导航验证',language:'en',segments:Array.from({length:221},(_,i)=>({id:'map-'+i,start:i*10,end:i*10+9,text:'Original authored passage '+(i+1)+'. Click a source position to keep reading, then leave your own note.'}))};
 await page.locator('#file').setInputFiles({name:'authored-long-source.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(longSource))});
 await page.setViewportSize({width:1360,height:1000});await page.locator('#mode-summary').click();
 check('source_map_is_bounded',await page.locator('#overview-segments button').count()===6&&await page.locator('#reading-jump option').count()===21);
 await capture(page,'05-source-overview');
 await page.locator('#overview-segments button').last().click();
 check('source_map_opens_last_original_passage',await page.locator('.passage-original .passage-cue[data-cue-id="map-220"]').count()===1);
 await page.locator('.passage').filter({has:page.locator('.passage-original .passage-cue[data-cue-id="map-220"]')}).locator('.passage-details').click();
 await page.locator('#reading-jump').selectOption('map-220');
 check('source_passage_details_keep_exact_last_cue',await page.locator('.segment[data-segment-id="map-220"]').evaluate(n=>n===document.activeElement));
 await page.locator('#search').fill('absent phrase');await page.locator('#reading-jump').selectOption('map-0');
 check('source_navigation_recovers_from_empty_search',await page.locator('#search').inputValue()===''&&await page.locator('.segment[data-segment-id="map-0"]').evaluate(n=>n===document.activeElement));
 // Search isolates a real sentence fragment; context must recover its actual
 // neighbors and return the same reading filter without moving the bookmark.
 const split=splitCueFixture();
 await page.locator('#file').setInputFiles({name:'authored-split-cues.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(split))});
 await page.locator('#mode-bilingual').click();
 const target=page.locator('.segment[data-segment-id="split-1750"]');
 for(const [label,viewport] of [['desktop',{width:1360,height:1000}],['mobile',{width:390,height:844}]]){
  await page.setViewportSize(viewport);await page.locator('#search').fill('crossing-marker');
  check(label+'_fragment_search_is_one_bilingual_result',await page.locator('.segment').count()===1&&await target.locator('.translation').count()===1);
  await target.locator('.context-button').click();
  check(label+'_context_shows_actual_adjacent_source',await page.locator('#reading-context').isVisible()&&await page.locator('.segment').count()<=100&&await page.locator('.segment[data-segment-id="split-1749"] .words').textContent()===split.segments[1749].text&&await page.locator('.segment[data-segment-id="split-1751"] .words').textContent()===split.segments[1751].text);
  await page.evaluate(()=>libraryStore.flush());
  check(label+'_context_preserves_reading_bookmark',await page.evaluate(async()=>{const s=await readPersistedLibrary();return s.documents.find(d=>d.key===sessionStorage.getItem('coconut-reader-active-v1')).readingPosition;})==='split-19');
  // Do not scroll from the test: the product jump itself must settle on the
  // intended fragment, not merely mount it somewhere in a 100-cue DOM window.
  const contextViewport=await page.evaluate(async()=>{
   const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
   await frame();await frame();
   const before={scroll:scrollY,top:document.querySelector('.segment[data-segment-id="split-1750"]').getBoundingClientRect().top};
   await frame();await frame();
   const breadcrumb=document.getElementById('reading-context').getBoundingClientRect();
   const visibleBelowBreadcrumb=element=>{
    if(!element)return false;
    const r=element.getBoundingClientRect();
    return r.width>0&&r.height>0&&r.top>=breadcrumb.bottom&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;
   };
   const target=document.querySelector('.segment[data-segment-id="split-1750"]');
   const neighbors=['split-1749','split-1751'].map(id=>document.querySelector('.segment[data-segment-id="'+id+'"]'));
   return {
    settled:Math.abs(scrollY-before.scroll)<1&&Math.abs(target.getBoundingClientRect().top-before.top)<1,
    targetVisible:visibleBelowBreadcrumb(target.querySelector('.words'))&&visibleBelowBreadcrumb(target.querySelector('.translation')),
    neighborsVisible:neighbors.every(row=>visibleBelowBreadcrumb(row?.querySelector('.words'))&&visibleBelowBreadcrumb(row?.querySelector('.translation'))),
    returnVisible:breadcrumb.top>=0&&breadcrumb.bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth
   };
  });
  check(label+'_context_jump_settles_without_test_scrolling',contextViewport.settled);
  check(label+'_context_target_source_and_translation_visible',contextViewport.targetVisible);
  check(label+'_context_both_neighbors_visible_below_breadcrumb',contextViewport.neighborsVisible);
  check(label+'_context_return_is_in_view',contextViewport.returnVisible);
  await capture(page,'06-'+label+'-reading-context',false);
  await page.locator('#return-reading-results').click();
  check(label+'_return_restores_filter_bilingual_and_keyboard_target',await page.locator('#search').inputValue()==='crossing-marker'&&await page.locator('.segment').count()===1&&await target.locator('.translation').count()===1&&await target.locator('.context-button').evaluate(n=>n===document.activeElement)&&await page.locator('#reading-context').isHidden());
 }
 // If the source changes on the detour, returning cannot resurrect old text or
 // leave a stale context banner covering an empty filtered view.
 await target.locator('.context-button').click();await openCueActions(target);await target.locator('.edit-button').click();
 await page.locator('#edit-segment').fill('Authored revised sentence without the former search marker.');await page.locator('#save-edit').click();
 await page.locator('#return-reading-results').click();
 check('context_return_handles_removed_search_match',await page.locator('.segment').count()===0&&await page.locator('#reading-context').isHidden()&&await page.locator('#search').evaluate(n=>n===document.activeElement)&&(await page.locator('#notice').textContent()).includes('没有匹配'));
 await page.locator('#search').fill('revised sentence');await target.locator('.context-button').click();await page.locator('#dismiss-reading-context').click();
 check('explicit_context_dismiss_stays_in_full_source',await page.locator('#search').inputValue()===''&&await page.locator('#reading-context').isHidden()&&await target.evaluate(n=>n===document.activeElement));
 check('first_use_and_source_map_have_no_external_requests',mutations===0&&external===0&&pageErrors===0);
 console.log(JSON.stringify({suite:'static-web-podcast',status:'passed',checks}));
} catch {
 console.log(JSON.stringify({suite:'static-web-podcast',status:'failed',stage,checks}));process.exitCode=1;
} finally {
 await browser?.close();await new Promise(resolve=>server?.listening?server.close(resolve):resolve());
 if(directory)await fs.rm(directory,{recursive:true,force:true});
}
