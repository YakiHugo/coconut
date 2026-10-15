// Compatibility renderer regression; this suite is not default React acceptance.
/** Authored CI-only browser proof. Never run locally where Chromium is denied. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from './helpers/browser-storage.mjs';
import {installFollowScrollObserver,followWheelSettled} from './helpers/follow-scroll-observer.mjs';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
let browser,server,directory,page,manualScroll,stage='setup',external=0;
const checks=[],errors=[],geometry=[],rewinds=[],lastCue=[];
function check(name,value){stage=name;assert.ok(value,name);checks.push(name);}
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function capture(label){
 if(!process.env.COCONUT_UI_SCREENSHOTS)return;
 await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});
 await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'playback-follow-'+label+'.png'),animations:'disabled'});
}
async function rewind(label,{suspended=false,touch=false,unavailable=false}={}){
 stage=label;
 await page.evaluate(()=>{window.__followRewindSettlement={last:null,count:0};});
 await page.waitForFunction(()=>{const state=window.__followRewindSettlement;state.count=state.last===scrollY?state.count+1:0;state.last=scrollY;return state.count>=6;},null,{polling:'raf'});
 const point=await page.locator('#dock-rewind').evaluate(button=>{
  const rect=button.getBoundingClientRect();
  button.addEventListener('click',event=>{const p=document.querySelector('audio');window.__followRewindBefore={trusted:event.isTrusted,time:p.currentTime,paused:p.paused,rate:p.playbackRate,scrollY,player:p};},{once:true,capture:true});
  return {x:rect.x+rect.width/2,y:rect.y+rect.height/2,clear:document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===button,headerOffscreen:document.querySelector('#episode-media').getBoundingClientRect().bottom<=0};
 });
 check(label+'_uses_visible_dock_with_header_offscreen',point.clear&&point.headerOffscreen);
 if(touch)await page.touchscreen.tap(point.x,point.y);else await page.mouse.click(point.x,point.y);
 await page.waitForFunction(()=>!document.querySelector('audio').seeking);await settle();
 const proof=await page.evaluate(()=>{const before=window.__followRewindBefore,p=document.querySelector('audio');return {trusted:before.trusted,before:before.time,after:p.currentTime,pausedBefore:before.paused,paused:p.paused,same:p===before.player,rate:p.playbackRate,rateBefore:before.rate,scrollDelta:scrollY-before.scrollY,follow:document.querySelector('#dock-follow').dataset.state};});rewinds.push({label,...proof});
 check(label+'_native_ten_second_seek_preserves_player_rate_and_state',proof.trusted&&proof.same&&proof.paused===proof.pausedBefore&&proof.rate===proof.rateBefore&&Math.abs(proof.after-Math.max(0,proof.before-10))<.65);
 check(label+'_preserves_follow_intent',proof.follow===(unavailable?'off':suspended?'suspended':'following'));
 if(suspended)check(label+'_does_not_take_manual_viewport',Math.abs(proof.scrollDelta)<2);
}
async function dockGeometry(label,{focus=false,audioOnly=false}={}){
 const measurements=await page.evaluate(()=>{
  const dock=document.querySelector('#media-dock'),box=dock.getBoundingClientRect(),buttons=[...dock.querySelectorAll('button')].filter(button=>!button.hidden&&getComputedStyle(button).display!=='none').map(button=>{
   const r=button.getBoundingClientRect(),style=getComputedStyle(button),walker=document.createTreeWalker(button,NodeFilter.SHOW_TEXT),labels=[];let node;
   while(node=walker.nextNode()){
    if(!node.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(node);
    for(const rect of range.getClientRects())if(rect.width&&rect.height)labels.push({text:node.textContent.trim(),...rect.toJSON()});
   }
   const pad={left:parseFloat(style.paddingLeft)+parseFloat(style.borderLeftWidth),right:parseFloat(style.paddingRight)+parseFloat(style.borderRightWidth)};
   const points=[[r.left+r.width/2,r.top+r.height/2],[r.left+1,r.top+r.height/2],[r.right-1,r.top+r.height/2],[r.left+r.width/2,r.top+1],[r.left+r.width/2,r.bottom-1]].map(([x,y])=>{const hit=document.elementFromPoint(x,y);return {x,y,clear:hit===button||button.contains(hit)};});
   return {id:button.id,x:r.x,y:r.y,width:r.width,height:r.height,rect:r.toJSON(),labels,pad,points,disabled:button.disabled,visibleLabel:labels.map(label=>label.text).join(''),title:button.title,aria:button.getAttribute('aria-label'),fontSize:parseFloat(style.fontSize),outline:{width:parseFloat(style.outlineWidth),offset:parseFloat(style.outlineOffset),style:style.outlineStyle,color:style.outlineColor},focusVisible:button.matches(':focus-visible'),focused:document.activeElement===button};
  });
  return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,dock:{...box.toJSON()},buttons,follow:document.querySelector('#dock-follow').dataset.state};
 });geometry.push({label,...measurements});
 const narrow=measurements.width<=850,buttons=measurements.buttons;
 check(label+'_one_row_all_five_44px_targets_no_overflow',!measurements.overflow&&buttons.map(b=>b.id).join(',')===(audioOnly?'dock-rewind,dock-play,dock-follow,dock-return':'dock-rewind,dock-play,dock-follow,dock-locate,dock-return')&&measurements.dock.left>=0&&measurements.dock.right<=measurements.width&&buttons.every(b=>b.width>=44&&b.height>=44&&b.points.every(p=>p.clear))&&Math.max(...buttons.map(b=>b.y))-Math.min(...buttons.map(b=>b.y))<2);
 if(narrow)check(label+'_exact_64px_dock_envelope',Math.abs(measurements.dock.height-64)<.01);
 check(label+'_native_text_ranges_fit_without_clipping',buttons.every(b=>b.labels.length&&b.labels.every(r=>r.left>=b.rect.left+b.pad.left-.5&&r.right<=b.rect.right-b.pad.right+.5&&r.top>=b.rect.top&&r.bottom<=b.rect.bottom)&&b.fontSize>=(narrow?11:12)));
 const rewindButton=buttons.find(b=>b.id==='dock-rewind'),follow=buttons.find(b=>b.id==='dock-follow'),locate=buttons.find(b=>b.id==='dock-locate'),player=buttons.find(b=>b.id==='dock-return');
 check(label+'_complete_follow_and_accessible_rewind_labels',rewindButton.visibleLabel==='−10秒'&&rewindButton.aria==='后退10秒'&&rewindButton.title==='后退10秒'&&['跟随原声','恢复跟随','跟随待播放','停止跟随','跟随不可用'].includes(follow.visibleLabel));
 if(narrow)check(label+'_short_labels_keep_full_accessible_names',(audioOnly||['定位','无字幕'].includes(locate.visibleLabel)&&['定位当前播放的原文','当前时间没有字幕'].includes(locate.aria))&&player.visibleLabel==='原声'&&player.aria==='回到原声播放器');
 if(focus){
  const focused=buttons.find(b=>b.focused);check(label+'_visible_two_pixel_inset_focus_ring',focused?.focusVisible&&focused.outline.width===2&&focused.outline.offset===-4&&focused.outline.style==='solid'&&focused.outline.color!=='rgba(0, 0, 0, 0)'&&focused.rect.left>=measurements.dock.left&&focused.rect.right<=measurements.dock.right&&focused.rect.top>=measurements.dock.top&&focused.rect.bottom<=measurements.dock.bottom);
  check(label+'_inset_ring_does_not_cover_label',focused.labels.every(r=>r.left>=focused.rect.left+4&&r.right<=focused.rect.right-4&&r.top>=focused.rect.top+4&&r.bottom<=focused.rect.bottom-4));
 }
 return measurements;
}
try{
 directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-follow-'));
 const audio=path.join(directory,'authored-follow.wav');await fs.writeFile(audio,authoredAudioFixture(700));
 const reader=new URL('../reader/',import.meta.url);
 server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.slice(1)||'compatibility.html';
  if(req.method!=='GET'||!/^[a-z-]+\.(html|js|css|png)$/.test(name)){res.writeHead(404).end();return;}
  try{res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html');res.end(await fs.readFile(new URL(name,reader)));}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce',hasTouch:true,serviceWorkers:'block'});
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||url.protocol==='blob:')return route.continue();external++;return route.abort();});
 page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);
 await page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='ready');
 const fixture={title:'Authored follow reading',language:'en',segments:Array.from({length:151},(_,i)=>({id:'cue-'+i,start:i*4,end:i*4+4,text:'This is authored reading passage '+i+'. The original voice stays alongside its words.'}))};
 await page.locator('#file').setInputFiles({name:'authored-follow.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
 await page.locator('#mode-transcript').click();
 if(!await page.locator('#attach-reader-media').isVisible())await page.locator('#toggle-reader-media').click();
 const [picker]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-reader-media').click()]);await picker.setFiles(audio);
 await page.waitForFunction(()=>{const p=document.querySelector('audio');return p?.readyState>=2&&p.duration===700;});
 await page.locator('#follow-playback').click();
 check('opt_in_never_autoplays',await page.locator('audio').evaluate(p=>p.paused));
 await page.locator('#follow-playback').tap();check('touch_can_turn_follow_off',await page.locator('#follow-playback').getAttribute('aria-pressed')==='false');
 await page.locator('#follow-playback').tap();
 await page.locator('audio').evaluate(async p=>{p.currentTime=500;await p.play();});
 await page.waitForFunction(()=>document.querySelector('.segment')?.dataset.segmentId==='cue-100');
 check('page_crossing_keeps_follow_control_focus',await page.evaluate(()=>document.activeElement.id==='follow-playback'));
 await page.locator('#media-dock').waitFor({state:'visible'});
 await rewind('following_pointer_rewind');
 await rewind('following_touch_rewind',{touch:true});
 check('playing_cue_is_comfortably_above_dock',await page.evaluate(()=>{const cue=document.querySelector('.segment.playing').getBoundingClientRect(),dock=document.querySelector('#media-dock').getBoundingClientRect();return cue.top>=0&&cue.bottom<=dock.top;}));
 await page.evaluate(installFollowScrollObserver);
 stage='manual_wheel_settlement';
 await page.mouse.wheel(0,100);
 await page.waitForFunction(()=>document.querySelector('#dock-follow').dataset.state==='suspended');
 // Suspended is synchronous wheel intent, not completion of native scrolling.
 // Require real movement and its scrollend, then two unchanged frame samples.
 // The existing finite page timeout fails if wheel movement never completes.
 await page.evaluate(()=>window.__followScrollObserver.record('suspended_observed'));
 await page.waitForFunction(followWheelSettled,null,{polling:'raf'});
 const manualY=await page.evaluate(()=>{window.__followScrollObserver.record('manual_baseline');return scrollY;});
 await page.evaluate(()=>window.__followScrollObserver.record('before_seek'));
 await page.locator('audio').evaluate(p=>{p.currentTime=580;p.dispatchEvent(new Event('timeupdate'));});
 await page.waitForTimeout(150);
 manualScroll=await page.evaluate(y=>{const observer=window.__followScrollObserver;observer.record('after_seek');return {...observer.state,baselineY:y,finalY:scrollY,delta:scrollY-y,follow:document.querySelector('#dock-follow').dataset.state};},manualY);
 check('manual_scroll_remains_owned_by_reader',Math.abs(manualScroll.delta)<2&&manualScroll.follow==='suspended');
 check('manual_wheel_and_seek_have_no_programmatic_scroll',manualScroll.calls.every(call=>!call.afterWheel));
 await rewind('suspended_pointer_rewind',{suspended:true});
 await page.locator('audio').evaluate(p=>{p.currentTime=580;});
 await page.waitForFunction(()=>!document.querySelector('audio').seeking);
 await page.evaluate(()=>window.__followScrollObserver.stop());
 await page.locator('#dock-follow').click();
 await page.waitForFunction(()=>document.querySelector('.segment.playing')?.dataset.segmentId==='cue-145');
 // Pause leaves the opt-in armed but must not reposition on subsequent seeks.
 await page.locator('audio').evaluate(p=>p.pause());
 for(const viewport of [{width:320,height:844},{width:360,height:844},{width:390,height:844},{width:390,height:480},{width:1360,height:1000}]){
  const {width,height}=viewport,label=width+'x'+height;await page.setViewportSize(viewport);
  const last=page.locator('.segment').last();await last.scrollIntoViewIfNeeded();await page.locator('#media-dock').waitFor({state:'visible'});await settle();
  // Drive actual product states, never substitute text for a geometry pass.
  await page.locator('audio').evaluate(p=>{p.currentTime=600;});await page.waitForFunction(()=>!document.querySelector('audio').seeking);
  if(await page.locator('#dock-follow').getAttribute('data-state')!=='following')await page.locator('#dock-follow').click();
  check(label+'_armed_label_is_complete',await page.locator('#dock-follow').textContent()==='跟随待播放');await dockGeometry(label+'-armed');
  await rewind(label+'_armed_paused_rewind');
  await page.locator('#dock-follow').click();check(label+'_off_label_is_complete',await page.locator('#dock-follow').textContent()==='跟随原声');await dockGeometry(label+'-off');
  await page.locator('#dock-follow').click();await page.locator('#dock-play').click();
  await page.waitForFunction(()=>!document.querySelector('audio').paused&&document.querySelector('#dock-follow').textContent==='停止跟随');await settle();await dockGeometry(label+'-playing');
  await rewind(label+'_playing_rewind');await page.locator('#dock-play').click();
  await page.waitForFunction(()=>document.querySelector('audio').paused&&document.querySelector('#dock-follow').textContent==='跟随待播放');
  // Start at the first control and actually Tab through every dock target.
  await page.locator('#dock-rewind').focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
  for(const id of ['dock-rewind','dock-play','dock-follow','dock-locate','dock-return']){
   check(label+'_'+id+'_native_tab_order',await page.evaluate(id=>document.activeElement.id===id,id));await dockGeometry(label+'-'+id+'-focus',{focus:true});
   await capture(label+'-'+id+'-focus');if(id!=='dock-return')await page.keyboard.press('Tab');
  }
  await last.scrollIntoViewIfNeeded();await settle();
  // A real cue focus is deliberate manual reading intent, without leaving a
  // native wheel animation in flight during subsequent geometry snapshots.
  await last.focus();await page.keyboard.press('ArrowUp');
  await page.waitForFunction(()=>document.querySelector('#dock-follow').dataset.state==='suspended');
  await page.waitForFunction(()=>{const value=scrollY,s=window.__dockGeometrySettlement||(window.__dockGeometrySettlement={last:null,count:0});s.count=s.last===value?s.count+1:0;s.last=value;return s.count>=4;},null,{polling:'raf'});
  check(label+'_suspended_label_is_complete',await page.locator('#dock-follow').textContent()==='恢复跟随');await dockGeometry(label+'-suspended');await capture(label+'-suspended');
  await page.locator('audio').evaluate(p=>{p.currentTime=650;});await page.waitForFunction(()=>document.querySelector('#dock-locate').disabled);await dockGeometry(label+'-no-current-cue');
  // Real final-cue reachability, then an exact note draft above the same dock.
  await last.evaluate(row=>row.scrollIntoView({block:'center'}));await settle();
  const finalCue=await page.evaluate(()=>{const node=[...document.querySelectorAll('.segment')].at(-1),row=node.getBoundingClientRect(),dock=document.querySelector('#media-dock').getBoundingClientRect(),style=getComputedStyle(node),owner=document.scrollingElement;return {width:innerWidth,height:innerHeight,y:scrollY,row:row.toJSON(),dock:dock.toJSON(),words:node.querySelector('.words').getBoundingClientRect().toJSON(),note:node.querySelector('.saved-note')?.getBoundingClientRect().toJSON()||null,scrollOwner:owner?.tagName,scrollHeight:owner?.scrollHeight,clientHeight:owner?.clientHeight,scrollPaddingBottom:getComputedStyle(document.documentElement).scrollPaddingBottom,scrollMarginTop:style.scrollMarginTop,scrollMarginBottom:style.scrollMarginBottom,mainPaddingBottom:getComputedStyle(document.querySelector('main')).paddingBottom,toolbar:document.querySelector('#reading-mode-toolbar').getBoundingClientRect().toJSON()};});
  lastCue.push({label,...finalCue});
  check('last_cue_not_covered_'+width,finalCue.row.bottom<=finalCue.dock.top);
  check('last_cue_has_native_reading_gap_'+label,finalCue.dock.top-finalCue.row.bottom>=2);
  check('last_cue_source_clear_of_both_toolbars_'+label,finalCue.words.top>=Math.max(0,finalCue.toolbar.bottom)&&finalCue.words.bottom<=finalCue.dock.top);
  if(finalCue.note)check('last_cue_saved_note_clear_of_both_toolbars_'+label,finalCue.note.top>=Math.max(0,finalCue.toolbar.bottom)&&finalCue.note.bottom<=finalCue.dock.top);
  await last.locator('.note-button').click();await page.locator('#note').fill('  exact\n  authored draft  ');
  check('note_editor_not_covered_'+width,await page.evaluate(()=>document.querySelector('#note').getBoundingClientRect().bottom<=document.querySelector('#media-dock').getBoundingClientRect().top));
  await page.locator('audio').evaluate(p=>{p.currentTime=420;p.dispatchEvent(new Event('timeupdate'));});
  check('draft_and_focus_survive_'+width,await page.locator('#note').inputValue()==='  exact\n  authored draft  '&&await page.evaluate(()=>document.activeElement.id==='note'));
  await page.locator('#close-note').click();await capture(label+'-last-cue');
 }
 await page.setViewportSize({width:390,height:844});await page.locator('.segment').last().scrollIntoViewIfNeeded();await capture('mobile');
 // The unavailable label is exercised on a genuine audio-only project, whose
 // lower annotation rows also make the original player naturally offscreen.
 const audioOnly=path.join(directory,'authored-no-transcript.wav');await fs.writeFile(audioOnly,authoredAudioFixture(40));
 await page.locator('#add-content').click();const [audioPicker]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#open-local-media').click()]);await audioPicker.setFiles(audioOnly);
 await page.waitForFunction(()=>document.querySelector('#source-media audio')?.duration===40);
 for(let index=0;index<12;index++){
  await page.locator('#audio-bookmark-time').fill(String(index+1));await page.locator('#audio-bookmark-note').fill('Authored audio-only reading note '+index);await page.locator('#audio-bookmark-form button[type="submit"]').click();
  await page.waitForFunction(count=>document.querySelectorAll('.audio-bookmark').length===count,index+1);
 }
 for(const viewport of [{width:320,height:844},{width:360,height:844},{width:390,height:844},{width:390,height:480},{width:1360,height:1000}]){
  const label=viewport.width+'x'+viewport.height+'-audio-only';await page.setViewportSize(viewport);await page.locator('.audio-bookmark').last().scrollIntoViewIfNeeded();await page.locator('#media-dock').waitFor({state:'visible'});await settle();
  check(label+'_full_unavailable_state_without_fake_transcript',await page.locator('#dock-follow').textContent()==='跟随不可用'&&await page.locator('#dock-follow').isDisabled()&&await page.locator('#dock-locate').isHidden()&&await page.locator('.segment').count()===0);
  await dockGeometry(label,{audioOnly:true});await page.locator('audio').evaluate(p=>{p.currentTime=30;});await page.waitForFunction(()=>!document.querySelector('audio').seeking);
  await rewind(label+'_rewind',{unavailable:true});await capture(label);
 }
 if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'playback-follow-geometry.json'),JSON.stringify(geometry,null,2));}
 check('no_external_calls_or_page_errors',external===0&&errors.length===0);
 if(process.env.COCONUT_UI_SCREENSHOTS){await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'playback-follow-scroll.json'),JSON.stringify(manualScroll,null,2));await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'playback-follow-rewind.json'),JSON.stringify(rewinds,null,2));await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'playback-follow-last-cue.json'),JSON.stringify(lastCue,null,2));}
 console.log(JSON.stringify({ok:true,checks,geometry,rewinds,lastCue,manualScroll,errors},null,2));
}catch(error){
 try{
  if(page&&!page.isClosed()){
   const observed=await page.evaluate(()=>{const observer=window.__followScrollObserver;observer?.record('failure');return observer?.state||null;});
   manualScroll={...manualScroll,...observed};
   if(process.env.COCONUT_UI_SCREENSHOTS){
    await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});
    await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'playback-follow-scroll.json'),JSON.stringify(manualScroll,null,2));
    await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'playback-follow-geometry.json'),JSON.stringify(geometry,null,2));
    await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'playback-follow-rewind.json'),JSON.stringify(rewinds,null,2));await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'playback-follow-last-cue.json'),JSON.stringify(lastCue,null,2));
    await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'playback-follow-failure.png')});
   }
  }
 }catch(captureError){errors.push('failure diagnostics: '+captureError.message);}
 console.error(JSON.stringify({ok:false,stage,checks,error:error.stack,geometry,rewinds,lastCue,manualScroll,errors},null,2));process.exitCode=1;
}
finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());if(directory)await fs.rm(directory,{recursive:true,force:true});}
