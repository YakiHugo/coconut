/** Real decoded local audio and authored short-cue captions. No real recording,
 * account, model, third-party transcript, trace or media artifact is used. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const checks=[];let server,browser,directory,stage='setup',external=0,mutations=0,errors=0;
function check(name,value){stage=name;assert.ok(value,name);checks.push(name);}
const sourceParts=['A language model can work with','a limited context window. Keep the original','near the interpretation, and verify the detail.'];
const translations=['语言模型能处理的，','是有限的上下文窗口。把原文','放在解释旁边，再核对重要细节。'];
const fixture={title:'短句字幕、跨段语义与中英术语：从 context window 到自己的阅读笔记，这是一份带长标题的原创操作验证材料',language:'en',translation_view:'zh',provenance:{kind:'imported_subtitles',review_status:'Authored short-cue fixture with generated tone-only audio'},segments:Array.from({length:151},(_,i)=>({id:'clip-'+i,start:i*.8,end:(i+1)*.8,text:sourceParts[i%3],translations:{zh:{text:translations[i%3],source_text:sourceParts[i%3],source_language:'en',document_language:'en',provider:'Authored QA translation'}}}))};
try{
 directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-dock-'));const audio=path.join(directory,'authored-tone.wav');await fs.writeFile(audio,authoredAudioFixture());
 server=createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){mutations++;res.writeHead(405).end();return;}
  const pathname=new URL(req.url,'http://localhost').pathname,name=pathname==='/'?'index.html':pathname.slice(1);
  if(!/^[a-z-]+\.(html|js|css|png)$/.test(name)){res.writeHead(404,{'Content-Type':'application/json'}).end('{"error":"static fixture server"}');return;}
  try{const bytes=await fs.readFile(path.join(root,'reader',name));res.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html'}).end(bytes);}catch{res.writeHead(404).end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1360,height:1000},serviceWorkers:'block'});
 await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin===origin||u.protocol==='blob:')await route.continue();else{external++;await route.abort();}});
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',()=>errors++);
 const capture=async name=>{if(!process.env.COCONUT_UI_SCREENSHOTS)return;await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'dock-'+name+'.png'),fullPage:false,animations:'disabled'});};
 await page.goto(origin);check('no_dock_without_media',await page.locator('#media-dock').isHidden());
 await page.locator('#file').setInputFiles({name:'authored-short-cues.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});await page.locator('#mode-bilingual').click();
 if(!await page.locator('#attach-reader-media').isVisible())await page.locator('#toggle-reader-media').click();
 const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-reader-media').click()]);await chooser.setFiles(audio);
 await page.waitForFunction(()=>{const p=document.querySelector('#source-media audio');return p&&!p.error&&p.readyState>=2&&p.duration>=179;});
 await page.locator('audio').evaluate(p=>{window.__dockPlayer=p;});
 check('decoded_audio_does_not_autoplay',await page.locator('audio').evaluate(p=>p.paused&&p.currentTime===0));
 await page.locator('#reading-jump').selectOption('clip-126');const cue=page.locator('.segment[data-segment-id="clip-126"]');
 await cue.locator('.time > button').first().click();await page.waitForFunction(()=>{const p=document.querySelector('audio');return p&&!p.paused&&p.currentTime>100.8;});
 await page.locator('#media-dock').waitFor({state:'visible'});await page.locator('#dock-play').click();
 check('deep_reading_dock_pauses_the_actual_audio',await page.locator('audio').evaluate(p=>p.paused)&&await page.locator('#dock-play').textContent()==='播放');
 check('dock_has_one_unchanged_player',await page.evaluate(()=>document.querySelectorAll('audio,video').length===1&&document.querySelector('audio')===window.__dockPlayer));
 await capture('01-short-cues-desktop');
 // Return to another page without changing the original audio position, then locate it again.
 await page.locator('#reading-jump').selectOption('clip-0');await page.locator('.segment').last().scrollIntoViewIfNeeded();await page.locator('#media-dock').waitFor({state:'visible'});
 await page.locator('#dock-locate').click();
 check('dock_locates_current_sound_across_pages',await page.evaluate(()=>document.activeElement.classList.contains('segment')&&Number(document.activeElement.dataset.segmentId.split('-')[1])>=126&&document.querySelector('audio')===window.__dockPlayer));
 await page.setViewportSize({width:390,height:844});await page.locator('#media-dock').waitFor({state:'visible'});
 await page.locator('#dock-locate').click();await page.waitForFunction(()=>{const row=document.activeElement,words=row.querySelector?.('.words'),dock=document.querySelector('#media-dock');if(!words)return false;const r=words.getBoundingClientRect();return r.top>=0&&r.bottom<dock.getBoundingClientRect().top;});
 check('mobile_current_source_is_not_covered_by_dock',true);await capture('02-short-cues-mobile');
 check('three_bilingual_short_cues_fit_a_readable_mobile_span',await page.evaluate(()=>{const rows=[...document.querySelectorAll('.segment.short-cue')].slice(26,29);return rows.length===3&&rows.reduce((sum,row)=>sum+row.getBoundingClientRect().height,0)<=550&&rows.every(row=>row.querySelector('.words').textContent&&row.querySelector('.translation').textContent);}));
 check('short_cue_primary_targets_remain_touch_sized',await page.locator('.segment.playing').evaluate(row=>['.note-button','.cue-more > summary','.time > button'].every(selector=>{const r=row.querySelector(selector).getBoundingClientRect();return r.height>=44&&r.width>=44;})));
 const cueViewport=()=>page.locator('.segment.playing').evaluate(row=>({scrollY:window.scrollY,top:row.getBoundingClientRect().top,dockTop:document.querySelector('#media-dock').getBoundingClientRect().top,parts:['.words','.translation','.cue-more > summary','.excerpt-button'].map(selector=>{const r=row.querySelector(selector).getBoundingClientRect();return {selector,top:r.top,bottom:r.bottom};})}));
 const beforeOpen=await cueViewport();
 const cueMore=page.locator('.segment.playing .cue-more');await cueMore.locator('summary').focus();await page.keyboard.press('Enter');
 const afterOpen=await cueViewport();
 check('short_cue_more_opens_by_keyboard',await cueMore.evaluate(node=>node.open));await page.keyboard.press('Tab');
 check('short_cue_correction_is_keyboard_reachable',await page.evaluate(()=>document.activeElement.classList.contains('edit-button')));
 const beforeExcerpt=await cueViewport();
 await cueMore.locator('.excerpt-button').evaluate(button=>{for(const type of ['pointerdown','click'])button.addEventListener(type,()=>{window['__excerpt'+type]={top:button.closest('.segment').getBoundingClientRect().top,scrollY:window.scrollY,active:document.activeElement.className};},{once:true,capture:true});});
 await cueMore.locator('.excerpt-button').click();
 // Native pointerdown is after Playwright's normal pre-click scrolling and
 // before the action handler; compare against that real user-action baseline.
 // Wait through layout/scroll anchoring, without scrolling to hide a jump.
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const afterExcerpt=await cueViewport();
 const pointerDown=await page.evaluate(()=>window.__excerptpointerdown),click=await page.evaluate(()=>window.__excerptclick);
 console.log(JSON.stringify({suite:'short-cue-viewport',beforeOpen,afterOpen,beforeExcerpt,pointerDown,click,afterExcerpt}));
 await capture('02-short-cue-actions-mobile');
 check('short_cue_excerpt_keeps_bilingual_context_and_actions_visible',pointerDown&&Math.abs(afterExcerpt.top-pointerDown.top)<=2&&afterExcerpt.parts.every(part=>part.top>=0&&part.bottom<afterExcerpt.dockTop));
 check('short_cue_secondary_action_restores_visible_focus',await page.evaluate(()=>document.activeElement.classList.contains('excerpt-button')&&document.activeElement.closest('details').open));
 await page.locator('.segment.playing .cue-more > summary').click();
 const current=page.locator('.segment.playing');await current.locator('.note-button').click();await page.locator('#note').fill('留在当前原声旁边的想法。');
 check('mobile_dock_and_note_do_not_overlap',await page.evaluate(()=>{const n=document.querySelector('#notes-panel').getBoundingClientRect(),d=document.querySelector('#media-dock').getBoundingClientRect(),t=document.querySelector('#note').getBoundingClientRect();return n.bottom<d.top&&t.bottom<d.top&&document.documentElement.scrollWidth<=innerWidth;}));
 await capture('02-mobile-note');
 await page.setViewportSize({width:390,height:480});await page.locator('#note').scrollIntoViewIfNeeded();
 check('compact_viewport_keeps_note_input_and_close_accessible',await page.evaluate(()=>{const t=document.querySelector('#note').getBoundingClientRect(),c=document.querySelector('#close-note').getBoundingClientRect(),d=document.querySelector('#media-dock').getBoundingClientRect();return t.top>=0&&t.bottom<d.top&&c.top>=0&&c.bottom<d.top;}));
 await capture('03-compact-note');
 const before=await page.locator('audio').evaluate(p=>p.currentTime);await page.locator('#dock-play').click();await page.waitForFunction(time=>document.querySelector('audio').currentTime>time+.1,before);await page.locator('#dock-play').click();
 check('note_dock_controls_playback_without_losing_note',await page.locator('audio').evaluate(p=>p.paused)&&await page.locator('#note').inputValue()==='留在当前原声旁边的想法。');
 const noteCue=await page.locator('.segment.selected').getAttribute('data-segment-id');
 await page.locator('#notes-panel').hover();await page.mouse.wheel(0,350);
 await page.waitForFunction(()=>{const panel=document.querySelector('#notes-panel'),p=panel.getBoundingClientRect(),r=document.querySelector('#return-excerpt').getBoundingClientRect(),d=document.querySelector('#media-dock').getBoundingClientRect();return panel.scrollTop>0&&r.top>=p.top&&r.bottom<=p.bottom&&r.bottom<d.top;});
 check('compact_note_footer_can_be_scrolled_into_view',true);await capture('04-compact-note-footer');
 await page.locator('#return-excerpt').click();
 await page.waitForFunction(id=>{const row=document.activeElement;if(row.dataset?.segmentId!==id)return false;const words=row.querySelector('.words').getBoundingClientRect(),dock=document.querySelector('#media-dock').getBoundingClientRect();return words.top>=0&&words.bottom<dock.top;},noteCue);
 check('compact_note_return_is_operable_and_preserves_saved_note',await page.locator('#notes-panel').isHidden()&&await page.evaluate(id=>{const shelf=JSON.parse(localStorage.getItem('coconut-reader-v1'));return shelf.documents.find(doc=>doc.key===sessionStorage.getItem('coconut-reader-active-v1')).notes[id]==='留在当前原声旁边的想法。';},noteCue));
 await page.setViewportSize({width:390,height:844});await page.locator('#dock-return').click();
 await page.waitForFunction(()=>{const p=document.querySelector('audio'),r=p.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;});
 check('return_restores_native_player_without_autoplay',await page.locator('#media-dock').isHidden()&&await page.locator('audio').evaluate(p=>p.paused&&p===document.activeElement));
 await page.locator('#detach-reader-media').click();
 check('removing_media_removes_all_dock_controls',await page.locator('#media-dock').isHidden()&&await page.locator('audio,video').count()===0);
 check('no_media_urls_saved_and_no_network_or_model_side_effects',await page.evaluate(()=>!localStorage.getItem('coconut-reader-v1').includes('blob:'))&&external===0&&mutations===0&&errors===0);
 console.log(JSON.stringify({suite:'playback-dock-authored-media',status:'passed',checks}));
}catch(error){console.log(JSON.stringify({suite:'playback-dock-authored-media',status:'failed',stage,error:error.message,checks}));process.exitCode=1;}
finally{await browser?.close();await new Promise(resolve=>server?.listening?server.close(resolve):resolve());if(directory)await fs.rm(directory,{recursive:true,force:true});}
