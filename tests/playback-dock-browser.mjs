/** Real decoded local audio and authored short-cue captions. No real recording,
 * account, model, third-party transcript, trace or media artifact is used. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from './helpers/browser-storage.mjs';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
import {evaluateNativeIME,evaluateNativeIMEPointer} from './helpers/native-ime-proof.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const checks=[],rewinds=[],ime=[],geometry=[];let server,browser,directory,page,stage='setup',external=0,mutations=0,errors=0;
function check(name,value){stage=name;assert.ok(value,name);checks.push(name);}
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function seek(time){
 await page.locator('#source-media audio').evaluate((player,time)=>{player.currentTime=time;},time);
 await page.waitForFunction(time=>{const p=document.querySelector('#source-media audio');return !p.seeking&&Math.abs(p.currentTime-time)<.15;},time);await settle();
}
async function rewind(label,{preserveView=true,note=false}={}){
 stage=label;await settle();
 await page.evaluate(()=>{window.__dockRewindSettlement={last:null,count:0};});
 await page.waitForFunction(()=>{const state=window.__dockRewindSettlement,value=JSON.stringify([scrollY,document.querySelector('.segment.selected')?.getBoundingClientRect().top]);state.count=state.last===value?state.count+1:0;state.last=value;return state.count>=6;},null,{polling:'raf'});
 const point=await page.locator('#dock-rewind').evaluate(button=>{
  const rect=button.getBoundingClientRect(),hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
  button.addEventListener('click',event=>{
   const p=document.querySelector('#source-media audio'),editor=document.getElementById('note');
   window.__dockRewindBefore={trusted:event.isTrusted,player:p,time:p.currentTime,paused:p.paused,rate:p.playbackRate,volume:p.volume,src:p.getAttribute('src'),plays:window.__dockPlayCalls,scrollY,rows:[...document.querySelectorAll('#transcript .segment')],source:[...document.querySelectorAll('#transcript .words')].map(node=>({node,text:node.textContent,children:[...node.childNodes]})),document:JSON.stringify(state.documents),mode:document.body.dataset.readingMode,note:editor,value:editor.value,start:editor.selectionStart,end:editor.selectionEnd,direction:editor.selectionDirection,selected:document.querySelector('.segment.selected'),selectedTop:document.querySelector('.segment.selected')?.getBoundingClientRect().top};
  },{once:true,capture:true});
  return {x:rect.x+rect.width/2,y:rect.y+rect.height/2,clear:hit===button||button.contains(hit),disabled:button.disabled,headerOffscreen:document.querySelector('#episode-media').getBoundingClientRect().bottom<=0};
 });
 check(label+'_pointer_can_reach_rewind_without_header_navigation',point.clear&&!point.disabled&&point.headerOffscreen);
 // Raw native coordinates intentionally avoid locator.click's helpful scrolling.
 await page.mouse.click(point.x,point.y);await page.waitForFunction(()=>!document.querySelector('#source-media audio').seeking);await settle();
 const proof=await page.evaluate(()=>{
  const b=window.__dockRewindBefore,p=document.querySelector('#source-media audio'),n=document.getElementById('note');
  return {trusted:b.trusted,before:b.time,after:p.currentTime,pausedBefore:b.paused,paused:p.paused,same:p===b.player&&document.querySelectorAll('audio,video').length===1,rate:p.playbackRate,rateBefore:b.rate,volume:p.volume,volumeBefore:b.volume,sourceSame:p.getAttribute('src')===b.src,extraPlayCalls:window.__dockPlayCalls-b.plays,scrollDelta:scrollY-b.scrollY,rowsSame:b.rows.every(row=>row.isConnected),sourceSameDOM:b.source.every(({node,text,children})=>node.isConnected&&node.textContent===text&&node.childNodes.length===children.length&&children.every((child,index)=>node.childNodes[index]===child)),documentUnchanged:JSON.stringify(state.documents)===b.document,modeSame:document.body.dataset.readingMode===b.mode,noteSame:n===b.note&&n.isConnected,noteExact:n.value===b.value,selectionSame:n.selectionStart===b.start&&n.selectionEnd===b.end&&n.selectionDirection===b.direction,noteFocusRestored:document.activeElement===n,focused:document.activeElement.id,selectedSame:document.querySelector('.segment.selected')===b.selected,selectedDelta:b.selected?b.selected.getBoundingClientRect().top-b.selectedTop:null,follow:document.querySelector('#dock-follow').dataset.state,preview:document.getElementById('passage-playback-controls').dataset.state,loopActive:!!repeating};
 });rewinds.push({label,...proof});
 check(label+'_physical_ten_seconds_keep_player_rate_volume_pause_and_source',proof.trusted&&proof.same&&proof.sourceSame&&proof.paused===proof.pausedBefore&&proof.rate===proof.rateBefore&&proof.volume===proof.volumeBefore&&Math.abs(proof.after-Math.max(0,proof.before-10))<(proof.paused ? .08 : .65));
 check(label+'_never_calls_play_or_rewrites_source_or_document',proof.extraPlayCalls===0&&proof.rowsSame&&proof.sourceSameDOM&&proof.documentUnchanged&&proof.modeSame);
 if(preserveView)check(label+'_keeps_manual_reading_viewport',Math.abs(proof.scrollDelta)<2);
 if(note)check(label+'_keeps_exact_note_node_text_selection_and_intentional_button_focus',proof.noteSame&&proof.noteExact&&proof.selectionSame&&proof.selectedSame&&Math.abs(proof.selectedDelta)<2&&!proof.noteFocusRestored&&proof.focused==='dock-rewind');
 return proof;
}
async function nativeNoteIME(targetPage,selector,{pointerSelector=null,pointerAction=null}={}){
 await targetPage.locator(selector).fill('');await targetPage.locator(selector).click();
 await targetPage.evaluate(({selector,pointerSelector})=>{
  const original=document.querySelector(selector),button=pointerSelector?document.querySelector(pointerSelector):null,types=['compositionstart','compositionupdate','compositionend','beforeinput','input',...(button?['blur','focusout']:[])],listeners=[];
  window.__dockIME={original,selector,button,events:[],pointerEvents:[],manualDispatches:[],composing:false,restore:null};const audit=window.__dockIME;
  for(const type of types){const listener=event=>{if(type==='compositionstart')audit.composing=true;if(type==='compositionend')audit.composing=false;audit.events.push({type:event.type,data:event.data??null,trusted:event.isTrusted,same:event.target===original,inputType:event.inputType??null,isComposing:event.isComposing??null,value:original.value,selectionStart:original.selectionStart,selectionEnd:original.selectionEnd,selectionDirection:original.selectionDirection,focused:document.activeElement===original,currentNodeSame:document.querySelector(selector)===original,connected:original.isConnected});};original.addEventListener(type,listener);listeners.push([type,listener]);}
  const pointerListeners=[];
  if(button)for(const type of ['pointerdown','pointerup','click']){const listener=event=>audit.pointerEvents.push({type:event.type,trusted:event.isTrusted,same:event.target===button||button.contains(event.target),originalSame:document.querySelector(selector)===original,connected:original.isConnected,focused:document.activeElement===original,buttonFocused:document.activeElement===button,composing:audit.composing,value:original.value,selectionStart:original.selectionStart,selectionEnd:original.selectionEnd,selectionDirection:original.selectionDirection});button.addEventListener(type,listener,true);pointerListeners.push([type,listener]);}
  const dispatch=EventTarget.prototype.dispatchEvent;EventTarget.prototype.dispatchEvent=function(event){if([...types,'pointerdown','pointerup','click'].includes(event?.type))audit.manualDispatches.push(event.type);return dispatch.call(this,event);};
  audit.restore=()=>{for(const [type,listener]of listeners)original.removeEventListener(type,listener);for(const [type,listener]of pointerListeners)button.removeEventListener(type,listener,true);EventTarget.prototype.dispatchEvent=dispatch;};
 },{selector,pointerSelector});
 const cdp=await targetPage.context().newCDPSession(targetPage);
 try{
  await cdp.send('Input.imeSetComposition',{text:'路标',selectionStart:2,selectionEnd:2});
  if(pointerSelector){
   // No insertText/commit command before this native pointer boundary. The plain
   // textarea determines whether this browser commits or retains composition.
   await targetPage.evaluate(()=>{const a=window.__dockIME,n=a.original;a.beforePointer={composing:a.composing,focused:document.activeElement===n,same:n===document.querySelector(a.selector)&&n.isConnected,value:n.value,selectionStart:n.selectionStart,selectionEnd:n.selectionEnd,selectionDirection:n.selectionDirection,events:a.events.map(event=>({...event}))};});
   if(pointerAction)await pointerAction();
   else{const r=await targetPage.locator(pointerSelector).boundingBox();await targetPage.mouse.click(r.x+r.width/2,r.y+r.height/2);}
   await targetPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  }else await cdp.send('Input.insertText',{text:'路标'});
  return await targetPage.evaluate(()=>{const a=window.__dockIME,n=a.original;return {beforePointer:a.beforePointer,events:a.events,pointerEvents:a.pointerEvents,manualDispatches:a.manualDispatches,value:n.value,selectionStart:n.selectionStart,selectionEnd:n.selectionEnd,selectionDirection:n.selectionDirection,same:n===document.querySelector(a.selector)&&n.isConnected,focused:document.activeElement===n,buttonFocused:document.activeElement===a.button,composing:a.composing};});
 }finally{await targetPage.evaluate(()=>window.__dockIME.restore());await cdp.detach();}
}
async function holdNoteWrites(){
 await page.evaluate(()=>libraryStore.flush());
 await page.evaluate(()=>{
  const adapter=CoconutStorageBootstrap.result.adapter,write=adapter.write.bind(adapter);window.__dockWrites={pending:[],hold:true,completed:0};
  adapter.write=(...args)=>window.__dockWrites.hold?new Promise((resolve,reject)=>window.__dockWrites.pending.push(()=>write(...args).then(value=>{window.__dockWrites.completed++;resolve(value);},reject))):write(...args);
  window.__releaseDockWrites=async()=>{window.__dockWrites.hold=false;await Promise.all(window.__dockWrites.pending.splice(0).map(release=>release()));};
 });
}
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
 await context.addInitScript(()=>{window.__dockPlayCalls=0;const play=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(...args){window.__dockPlayCalls++;return play.apply(this,args);};});
 page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',()=>errors++);
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
 const originalTime=await page.locator('audio').evaluate(p=>p.currentTime);
 await rewind('deep_desktop_paused_rewind');
 await page.locator('audio').evaluate(p=>{p.playbackRate=1.5;p.volume=.4;});
 await page.locator('#dock-play').click();await page.waitForFunction(()=>!document.querySelector('audio').paused);
 await rewind('deep_desktop_playing_rewind');await page.locator('#dock-play').click();
 await seek(40);await rewind('first_repeated_rewind');await rewind('second_repeated_rewind');
 check('two_taps_move_forty_to_twenty',Math.abs(await page.locator('audio').evaluate(p=>p.currentTime)-20)<.08);
 await seek(3);await rewind('three_seconds_clamps_to_zero');await rewind('zero_repeated_tap_stays_paused');
 check('clamped_rewind_never_autoplays',await page.locator('audio').evaluate(p=>p.paused&&p.currentTime===0));
 await seek(179.9);await page.locator('#dock-play').click();await page.waitForFunction(()=>document.querySelector('audio').ended&&document.querySelector('audio').paused);
 await rewind('native_ended_media_rewinds_without_replay');
 await page.locator('audio').evaluate(p=>{p.playbackRate=1;p.volume=1;});await seek(originalTime);
 await capture('01-short-cues-desktop');
 // Return to another page without changing the original audio position, then locate it again.
 await page.locator('#reading-jump').selectOption('clip-0');await page.locator('.segment').last().scrollIntoViewIfNeeded();await page.locator('#media-dock').waitFor({state:'visible'});
 await page.locator('#dock-locate').click();
 check('dock_locates_current_sound_across_pages',await page.evaluate(()=>document.activeElement.classList.contains('segment')&&Number(document.activeElement.dataset.segmentId.split('-')[1])>=126&&document.querySelector('audio')===window.__dockPlayer));
 await page.setViewportSize({width:390,height:844});await page.locator('#media-dock').waitFor({state:'visible'});
 // A visible source can be passing through the viewport during goToSegment's
 // smooth scroll. Observe completion before opening its disclosure; a no-op
 // locate is complete only at the centered destination requested by the app.
 await page.evaluate(()=>{
  const controller=new AbortController(),state={ended:false,last:null,stationary:0};
  window.__dockLocateSettlement={state,controller};
  document.addEventListener('scroll',()=>{state.ended=false;state.stationary=0;},{signal:controller.signal});
  document.addEventListener('scrollend',()=>{state.ended=true;},{signal:controller.signal});
  document.querySelector('#dock-locate').addEventListener('click',()=>{state.ended=false;state.last=null;state.stationary=0;},{once:true,capture:true,signal:controller.signal});
 });
 try{
 await page.locator('#dock-locate').click();
 await page.waitForFunction(()=>{
  const row=document.activeElement,words=row.querySelector?.('.words');if(!words)return false;
  const {state}=window.__dockLocateSettlement,rect=row.getBoundingClientRect(),style=getComputedStyle(row);
  const geometry=JSON.stringify([scrollY,rect.top,rect.height]);
  state.stationary=geometry===state.last?state.stationary+1:0;state.last=geometry;
  const center=rect.top+rect.height/2+(parseFloat(style.scrollMarginBottom)||0)/2-(parseFloat(style.scrollMarginTop)||0)/2;
  const requestedScroll=scrollY+center-innerHeight/2;
  const clampedScroll=Math.max(0,Math.min(document.documentElement.scrollHeight-innerHeight,requestedScroll));
  const atDestination=Math.abs(scrollY-clampedScroll)<=1;
  const r=words.getBoundingClientRect();
  return state.stationary>=2&&(state.ended||atDestination)&&r.top>=0&&r.bottom<document.querySelector('#media-dock').getBoundingClientRect().top;
 },null,{polling:'raf'});
 console.log(JSON.stringify({suite:'dock-locate-settlement',...await page.evaluate(()=>window.__dockLocateSettlement.state)}));
 }finally{await page.evaluate(()=>{window.__dockLocateSettlement?.controller.abort();delete window.__dockLocateSettlement;});}
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
 check('short_cue_bilingual_context_and_action_visible_before_click',beforeExcerpt.parts.every(part=>part.top>=0&&part.bottom<beforeExcerpt.dockTop));
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
 const current=page.locator('.segment.playing');await current.locator('.note-button').click();
 const baselinePage=await context.newPage();let baseline;
 try{await baselinePage.setContent('<!doctype html><label>Authored native note baseline<textarea id="baseline"></textarea></label>');baseline=await nativeNoteIME(baselinePage,'#baseline');}finally{await baselinePage.close();}
 const actual=await nativeNoteIME(page,'#note'),nativeProof=evaluateNativeIME({baseline,actual,text:'路标'});ime.push({baseline,actual,proof:nativeProof});
 for(const [name,value]of Object.entries(nativeProof))check('note_native_ime_'+name,value===true);
 await rewind('mobile_committed_native_ime_rewind',{note:true});check('native_ime_text_is_not_duplicated_by_pointer_focus_change',await page.locator('#note').inputValue()==='路标');
 const pointerBaselinePage=await context.newPage();let pointerBaseline;
 try{await pointerBaselinePage.setViewportSize(page.viewportSize());await pointerBaselinePage.setContent('<!doctype html><label>Authored active-composition baseline<textarea id="baseline"></textarea></label><button id="baseline-action" type="button">后退10秒</button>');pointerBaseline=await nativeNoteIME(pointerBaselinePage,'#baseline',{pointerSelector:'#baseline-action'});}finally{await pointerBaselinePage.close();}
 const pointerActual=await nativeNoteIME(page,'#note',{pointerSelector:'#dock-rewind',pointerAction:()=>rewind('mobile_active_native_ime_rewind',{note:true})});
 const pointerProof=evaluateNativeIMEPointer({baseline:pointerBaseline,actual:pointerActual,text:'路标'});ime.push({kind:'active-composition-pointer-boundary',baseline:pointerBaseline,actual:pointerActual,proof:pointerProof});
 for(const [name,value]of Object.entries(pointerProof))check('note_active_native_ime_pointer_'+name,value===true);

 await page.locator('#note').fill('留在当前原声旁边的想法。');
 check('mobile_dock_and_note_do_not_overlap',await page.evaluate(()=>{const n=document.querySelector('#notes-panel').getBoundingClientRect(),d=document.querySelector('#media-dock').getBoundingClientRect(),t=document.querySelector('#note').getBoundingClientRect();return n.bottom<d.top&&t.bottom<d.top&&document.documentElement.scrollWidth<=innerWidth;}));
 await capture('02-mobile-note');
 await page.setViewportSize({width:390,height:480});await page.locator('#note').scrollIntoViewIfNeeded();
 check('compact_viewport_keeps_note_input_and_close_accessible',await page.evaluate(()=>{const t=document.querySelector('#note').getBoundingClientRect(),c=document.querySelector('#close-note').getBoundingClientRect(),d=document.querySelector('#media-dock').getBoundingClientRect();return t.top>=0&&t.bottom<d.top&&c.top>=0&&c.bottom<d.top;}));
 await capture('03-compact-note');
 await holdNoteWrites();await page.locator('#note').fill('留在当前原声旁边的想法。待保存');
 await page.locator('#note').evaluate(n=>{n.setSelectionRange(2,7,'backward');window.__dockNote=n;});
 await page.waitForFunction(()=>window.__dockWrites.pending.length>0);
 const noteKey=await page.evaluate(()=>sessionStorage.getItem('coconut-reader-active-v1'));
 check('held_note_receipt_is_not_fabricated_as_saved',await page.evaluate(async key=>!(await readPersistedLibrary()).documents.find(d=>d.key===key).notes[document.querySelector('.segment.selected').dataset.segmentId]?.includes('待保存'),noteKey));
 await rewind('compact_note_pending_save_rewind',{note:true});
 const beforeReceipt=await page.evaluate(()=>({scrollY,top:document.querySelector('.segment.selected').getBoundingClientRect().top,value:document.getElementById('note').value,start:document.getElementById('note').selectionStart,end:document.getElementById('note').selectionEnd,direction:document.getElementById('note').selectionDirection,focus:document.activeElement.id}));
 await page.evaluate(()=>window.__releaseDockWrites());await page.evaluate(()=>libraryStore.flush());await settle();
 check('late_real_note_receipt_keeps_node_text_selection_focus_and_viewport',await page.evaluate(b=>{const n=document.getElementById('note');return window.__dockWrites.completed>0&&n===window.__dockNote&&n.value===b.value&&n.selectionStart===b.start&&n.selectionEnd===b.end&&n.selectionDirection===b.direction&&window.__dockRewindBefore.rows.every(row=>row.isConnected)&&window.__dockRewindBefore.source.every(({node,text,children})=>node.isConnected&&node.textContent===text&&node.childNodes.length===children.length&&children.every((child,index)=>node.childNodes[index]===child))&&document.activeElement.id==='dock-rewind'&&Math.abs(scrollY-b.scrollY)<2&&Math.abs(document.querySelector('.segment.selected').getBoundingClientRect().top-b.top)<2;},beforeReceipt));
 await page.locator('#note').fill('留在当前原声旁边的想法。');await page.evaluate(()=>libraryStore.flush());
 geometry.push({label:'390x480-note-after-rewind-and-save',...await page.evaluate(()=>({viewport:{width:innerWidth,height:innerHeight},dock:document.getElementById('media-dock').getBoundingClientRect().toJSON(),note:document.getElementById('note').getBoundingClientRect().toJSON(),close:document.getElementById('close-note').getBoundingClientRect().toJSON(),selected:document.querySelector('.segment.selected').getBoundingClientRect().toJSON()}))});
 await capture('03-compact-note-rewind');
 const before=await page.locator('audio').evaluate(p=>p.currentTime);await page.locator('#dock-play').click();await page.waitForFunction(time=>document.querySelector('audio').currentTime>time+.1,before);await page.locator('#dock-play').click();
 check('note_dock_controls_playback_without_losing_note',await page.locator('audio').evaluate(p=>p.paused)&&await page.locator('#note').inputValue()==='留在当前原声旁边的想法。');
 const noteCue=await page.locator('.segment.selected').getAttribute('data-segment-id');
 await page.locator('#notes-panel').hover();await page.mouse.wheel(0,350);
 await page.waitForFunction(()=>{const panel=document.querySelector('#notes-panel'),p=panel.getBoundingClientRect(),r=document.querySelector('#return-excerpt').getBoundingClientRect(),d=document.querySelector('#media-dock').getBoundingClientRect();return panel.scrollTop>0&&r.top>=p.top&&r.bottom<=p.bottom&&r.bottom<d.top;});
 check('compact_note_footer_can_be_scrolled_into_view',true);await capture('04-compact-note-footer');
 await page.locator('#return-excerpt').click();
 await page.waitForFunction(id=>{const row=document.activeElement;if(row.dataset?.segmentId!==id)return false;const words=row.querySelector('.words').getBoundingClientRect(),dock=document.querySelector('#media-dock').getBoundingClientRect();return words.top>=0&&words.bottom<dock.top;},noteCue);
 await page.evaluate(()=>libraryStore.flush());
 check('compact_note_return_is_operable_and_preserves_saved_note',await page.locator('#notes-panel').isHidden()&&await page.evaluate(async id =>{const shelf=(await readPersistedLibrary());return shelf.documents.find(doc=>doc.key===sessionStorage.getItem('coconut-reader-active-v1')).notes[id]==='留在当前原声旁边的想法。';},noteCue));
 await page.setViewportSize({width:390,height:844});await page.locator('#dock-return').click();
 await page.waitForFunction(()=>{const p=document.querySelector('audio'),r=p.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;});
 check('return_restores_native_player_without_autoplay',await page.locator('#media-dock').isHidden()&&await page.locator('audio').evaluate(p=>p.paused&&p===document.activeElement));
 // Calibration changes subtitle mapping, never the physical ten-second step.
 await page.locator('#media-timing-offset').fill('2');await page.locator('#media-timing-save').click();
 await page.waitForFunction(()=>document.querySelector('#media-timing-status').textContent.startsWith('已保存偏移 2'));
 await page.locator('#reading-jump').selectOption('clip-126');await page.locator('.segment[data-segment-id="clip-126"]').scrollIntoViewIfNeeded();await page.locator('#media-dock').waitFor({state:'visible'});
 await seek(70);await rewind('calibrated_media_still_rewinds_physical_ten_seconds');
 // Native cue-loop cancellation must survive the seek's queued media events.
 const loopCue=page.locator('.segment[data-segment-id="clip-126"]');await loopCue.locator('.cue-more > summary').click();await loopCue.locator('.repeat-button').click();
 await page.waitForFunction(()=>repeating?.id==='clip-126'&&!document.querySelector('audio').paused);
 await rewind('rewind_releases_cue_loop');check('old_cue_loop_cannot_reacquire_after_native_seeked',await page.evaluate(()=>!repeating)&&await page.locator('#stop-repeat').isHidden());
 await page.locator('#dock-play').click();await page.waitForFunction(()=>document.querySelector('audio').paused);
 await page.locator('#mode-passages').click();
 for(const status of ['playing','paused','finished']){
  const passage=page.locator('.passage').last();await passage.locator('.passage-listen').click();
  await page.waitForFunction(()=>document.querySelector('#passage-playback-controls').dataset.state==='playing');
  await page.locator('#media-dock').waitFor({state:'visible'});
  if(status==='paused'){await page.locator('#dock-play').click();await page.waitForFunction(()=>document.querySelector('#passage-playback-controls').dataset.state==='paused');}
  if(status==='finished')await page.waitForFunction(()=>document.querySelector('#passage-playback-controls').dataset.state==='finished',null,{timeout:30000});
  const preview=await page.evaluate(()=>passagePlayback.getState());check(status+'_bounded_preview_has_return_ownership',!!preview.range&&!!preview.returnPosition);
  await rewind(status+'_bounded_preview_rewind');
  check(status+'_rewind_retires_range_and_return_ownership',await page.locator('#passage-playback-controls').isHidden()&&await page.evaluate(()=>{const p=passagePlayback.getState();return p.status==='idle'&&!p.range&&!p.returnPosition;}));
  if(!await page.locator('audio').evaluate(p=>p.paused))await page.locator('#dock-play').click();
  await capture('05-'+status+'-preview-rewind');
 }
 // Native modal hit-testing blocks the dock even though its pixels stay behind
 // the top layer. Use the pointer coordinate, not a direct JS event/handler.
 await page.locator('#passage-body').focus();await page.keyboard.press('?');await page.locator('#keyboard-help').waitFor({state:'visible'});
 const modalBefore=await page.locator('audio').evaluate(p=>p.currentTime),blockedPoint=await page.locator('#dock-rewind').boundingBox();
 check('keyboard_help_is_a_native_modal',await page.locator('#keyboard-help').evaluate(node=>node.matches(':modal')));
 await page.mouse.click(blockedPoint.x+blockedPoint.width/2,blockedPoint.y+blockedPoint.height/2);await settle();
 check('native_modal_pointer_cannot_rewind_background_audio',Math.abs(await page.locator('audio').evaluate(p=>p.currentTime)-modalBefore)<.08);
 await page.keyboard.press('Escape');await page.locator('#keyboard-help').waitFor({state:'hidden'});
 const blockedTime=await page.locator('audio').evaluate(p=>p.currentTime);
 await page.evaluate(()=>{window.__dockBarrier=libraryStore.acquireBarrier('authored-dock-native-close-boundary');});
 const barrierPoint=await page.locator('#dock-rewind').boundingBox();await page.mouse.click(barrierPoint.x+barrierPoint.width/2,barrierPoint.y+barrierPoint.height/2);await settle();
 check('production_lifecycle_barrier_rejects_actual_pointer_rewind',Math.abs(await page.locator('audio').evaluate(p=>p.currentTime)-blockedTime)<.08);
 await page.evaluate(()=>libraryStore.releaseBarrier(window.__dockBarrier));
 // Retain an actual play promise continuation across replacement. Resolution
 // is delayed, but native play/decoding/events are never mocked or synthesized.
 await page.locator('audio').evaluate(p=>{window.__retiredDockPlayer=p;const play=p.play.bind(p);p.play=()=>play().then(()=>new Promise(resolve=>{window.__releaseDockPlay=resolve;}));});
 await page.locator('#dock-play').click();await page.waitForFunction(()=>typeof window.__releaseDockPlay==='function');await page.locator('#dock-return').click();
 const [replacementChooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-reader-media').click()]);await replacementChooser.setFiles(audio);
 await page.waitForFunction(()=>{const p=document.querySelector('audio');return p!==window.__retiredDockPlayer&&p?.readyState>=2&&p.duration===180;});
 await page.evaluate(()=>window.__releaseDockPlay());await settle();
 check('retired_native_play_completion_cannot_control_replacement',await page.evaluate(()=>__retiredDockPlayer.paused&&document.querySelector('audio').paused&&document.querySelector('audio').currentTime===0&&document.querySelectorAll('audio,video').length===1));
 // Separately label adversarial old-event dispatch; it is not native evidence.
 await page.evaluate(()=>{for(const type of ['timeupdate','seeked','ended'])window.__retiredDockPlayer.dispatchEvent(new Event(type));});await settle();
 check('synthetic_retired_media_events_cannot_control_current_player',await page.locator('audio').evaluate(p=>p.paused&&p.currentTime===0));
 await page.locator('#mode-bilingual').click();await page.locator('#reading-jump').selectOption('clip-126');await page.locator('.segment[data-segment-id="clip-126"]').scrollIntoViewIfNeeded();await page.locator('#media-dock').waitFor({state:'visible'});
 await seek(35);await rewind('replacement_uses_current_player_at_action_time');
 await page.locator('#add-content').click();check('changed_workspace_disables_and_hides_rewind',await page.locator('#media-dock').isHidden()&&await page.locator('#dock-rewind').isDisabled());
 await page.locator('#back-reading').click();await page.locator('#reading-jump').selectOption('clip-126');await page.locator('.segment[data-segment-id="clip-126"]').scrollIntoViewIfNeeded();await page.locator('#media-dock').waitFor({state:'visible'});
 await rewind('return_to_reading_rewind_keeps_replacement');await page.locator('#dock-return').click();
 await page.locator('#detach-reader-media').click();
 check('removing_media_removes_all_dock_controls',await page.locator('#media-dock').isHidden()&&await page.locator('#dock-rewind').isDisabled()&&await page.locator('audio,video').count()===0);
 await page.locator('#file').setInputFiles({name:'authored-retired-source.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({title:'A replacement without media',segments:[{id:'new-source',start:0,end:2,text:'Authored replacement source.'}]}))});
 await page.waitForFunction(()=>document.getElementById('title').textContent==='A replacement without media');
 check('changing_documents_without_media_keeps_rewind_unavailable',await page.locator('#media-dock').isHidden()&&await page.locator('#dock-rewind').isDisabled()&&await page.locator('audio,video').count()===0);
 await page.evaluate(()=>libraryStore.flush());
 check('no_media_urls_saved_and_no_network_or_model_side_effects',await page.evaluate(async () =>!JSON.stringify(await readPersistedLibrary()).includes('blob:'))&&external===0&&mutations===0&&errors===0);
 if(process.env.COCONUT_UI_SCREENSHOTS)await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'dock-rewind-evidence.json'),JSON.stringify({rewinds,ime,geometry},null,2));
 console.log(JSON.stringify({suite:'playback-dock-authored-media',status:'passed',checks,rewinds,ime,geometry}));
}catch(error){
 if(process.env.COCONUT_UI_SCREENSHOTS){try{await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'dock-rewind-evidence.json'),JSON.stringify({stage,checks,rewinds,ime,geometry,error:error.stack},null,2));if(page&&!page.isClosed())await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'dock-rewind-failure.png'),animations:'disabled'});}catch(captureError){console.error('dock failure evidence: '+captureError.message);}}
 console.log(JSON.stringify({suite:'playback-dock-authored-media',status:'failed',stage,error:error.stack,checks,rewinds,ime,geometry}));process.exitCode=1;
}
finally{await browser?.close();await new Promise(resolve=>server?.listening?server.close(resolve):resolve());if(directory)await fs.rm(directory,{recursive:true,force:true});}
