/** Actions-only native-dialog acceptance. Authored fixtures and PCM audio only.
 * Uses native file choosers, Chromium IME/keyboard, production search and IndexedDB.
 * The two explicit adversarial probes hold only a real activation continuation
 * or acquire the production save barrier; neither fabricates successful results.
 * node --check is syntax evidence, never a claimed browser acceptance pass. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import C from '../reader/core.js';
import {chromium,expect,waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
import {openLibrarySearch,closeLibrarySearch,openLibraryTools} from './helpers/library-tools-browser.mjs';
import {openCueActions} from './cue-actions-browser.mjs';
import {openTranscriptTools} from './helpers/reading-tools-browser.mjs';
import {evaluateNativeIME} from './helpers/native-ime-proof.mjs';
import {evaluateLibraryReturnScroll,evaluateLibraryReturnIdentity} from './helpers/library-return-scroll-proof.mjs';
import {startBridge} from '../desktop/server.mjs';

if(process.env.GITHUB_ACTIONS!=='true')throw new Error('Run wide library search in GitHub Actions only; use node --check in the workspace.');
const checks=[],geometry=[],screenshots=[],errors=[],ime=[],returns=[];
let browser,server,page,browserVersion=null,returnExpectation=null,stage='setup',external=0,mutations=0,failure=null;
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
const entry=key=>page.locator('.library-entry[data-document-key="'+key+'"]');
const group=(key,language='zh')=>entry(key).locator('.library-translation-group[data-language="'+language+'"]');
const hit=(key,language='zh')=>group(key,language).locator('.library-translation-hit');
const sameValue=(actual,expected,name)=>{assert.deepEqual(actual,expected,name);checks.push(name);};
async function capture(name){
 if(!process.env.COCONUT_UI_SCREENSHOTS)return;
 await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});
 const filename='wide-library-search-'+name+'.png';
 await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,filename),animations:'disabled'});screenshots.push(filename);
}
async function walk(target,label,key='Tab'){
 const route=[];
 for(let i=0;i<100&&!await target.evaluate(node=>node===document.activeElement);i++){
  await page.keyboard.press(key);await settle();
  const focus=await page.evaluate(()=>({id:document.activeElement?.id,classes:document.activeElement?.className,hitId:document.activeElement?.dataset.hitId,modal:document.activeElement?.closest('dialog')?.id,safe:document.getElementById('library-search-dialog').contains(document.activeElement)||document.activeElement===document.body||document.activeElement===document.documentElement}));
  route.push(focus);check(label+'_tab_stays_in_native_top_layer_'+i,focus.safe);
 }
 console.log(JSON.stringify({suite:'wide-library-search-tab-path',label,key,route}));
 check(label+'_reached_by_real_keyboard',await target.evaluate(node=>node===document.activeElement));
}
async function walkReader(target,label,key='Shift+Tab'){
 const route=[];
 for(let i=0;i<250&&!await target.evaluate(node=>node===document.activeElement);i++){
  await page.keyboard.press(key);await settle();route.push(await page.evaluate(()=>({id:document.activeElement?.id,classes:document.activeElement?.className})));
 }
 console.log(JSON.stringify({suite:'wide-library-search-reader-return-path',label,key,route}));
 check(label+'_return_entry_reached_by_real_keyboard',await target.evaluate(node=>node===document.activeElement));
}
async function keyboardGeometry(target,label){
 await settle();
 const m=await target.evaluate(node=>{
  const r=node.getBoundingClientRect(),s=getComputedStyle(node),ring=(parseFloat(s.outlineWidth)||0)+Math.max(0,parseFloat(s.outlineOffset)||0);
  const points=[[(r.left+r.right)/2,(r.top+r.bottom)/2],[r.left+1,(r.top+r.bottom)/2],[r.right-1,(r.top+r.bottom)/2],[(r.left+r.right)/2,r.top+1],[(r.left+r.right)/2,r.bottom-1]].map(([x,y])=>{const found=document.elementFromPoint(x,y);return {x,y,clear:found===node||node.contains(found),found:found?.id||found?.className};});
  const clips=[];
  for(let parent=node.parentElement;parent&&parent!==document.body;parent=parent.parentElement){
   const style=getComputedStyle(parent),box=parent.getBoundingClientRect(),x=/auto|scroll|hidden|clip/.test(style.overflowX),y=/auto|scroll|hidden|clip/.test(style.overflowY);
   if(x||y)clips.push({id:parent.id,x,y,left:box.left+parent.clientLeft,right:box.left+parent.clientLeft+parent.clientWidth,top:box.top+parent.clientTop,bottom:box.top+parent.clientTop+parent.clientHeight});
  }
  const modal=node.closest('dialog[open]');
  const overlays=['reading-feedback','notice-shell','passage-playback-controls','media-dock','library-search-feedback'].flatMap(id=>{
   const overlay=document.getElementById(id);if(!overlay||overlay.contains(node))return [];
   const box=overlay.getBoundingClientRect(),style=getComputedStyle(overlay);
   return [{id,rect:box.toJSON(),foreground:!modal||overlay.closest('dialog[open]')===modal,visible:!overlay.hidden&&style.display!=='none'&&style.visibility!=='hidden'&&box.width>0&&box.height>0}];
  });
  return {rect:r.toJSON(),ring,outlineStyle:s.outlineStyle,outlineColor:s.outlineColor,focused:node===document.activeElement,focusVisible:node.matches(':focus-visible'),points,clips,overlays,width:innerWidth,height:innerHeight};
 });
 geometry.push({label,...m});
 const r=m.rect,ring=m.ring;
 const clear=m.focused&&m.focusVisible&&m.outlineStyle!=='none'&&m.outlineColor!=='rgba(0, 0, 0, 0)'&&ring>0&&r.width>=44&&r.height>=44&&r.left-ring>=0&&r.right+ring<=m.width&&r.top-ring>=0&&r.bottom+ring<=m.height&&m.points.every(point=>point.clear)&&m.clips.every(c=>(!c.x||r.left-ring>=c.left&&r.right+ring<=c.right)&&(!c.y||r.top-ring>=c.top&&r.bottom+ring<=c.bottom))&&m.overlays.every(o=>!o.visible||!o.foreground||o.rect.right<=r.left-ring||o.rect.left>=r.right+ring||o.rect.bottom<=r.top-ring||o.rect.top>=r.bottom+ring);
 if(!clear)await capture(label+'-geometry-failure');
 check(label+'_44px_full_focus_ring_five_hit_points_and_foreground_overlays',clear);
}
async function layout(label){
 const m=await page.evaluate(()=>{
  const dialog=document.getElementById('library-search-dialog'),port=document.getElementById('library-search-results'),input=document.getElementById('library-search'),scope=document.getElementById('library-search-scope');
  const preview=document.querySelector('.library-translation-hit .library-hit-preview'),source=document.querySelector('.library-translation-hit .library-hit-source');
  const rect=node=>node.getBoundingClientRect().toJSON();
  return {dialog:rect(dialog),port:rect(port),input:rect(input),scope:rect(scope),close:rect(document.getElementById('close-library-search')),preview:preview&&rect(preview),source:source&&rect(source),width:innerWidth,height:innerHeight,native:dialog instanceof HTMLDialogElement&&dialog.matches(':modal'),overflow:document.documentElement.scrollWidth>innerWidth||dialog.scrollWidth>dialog.clientWidth||port.scrollWidth>port.clientWidth,dialogScroll:dialog.scrollHeight>dialog.clientHeight,portOverflow:getComputedStyle(port).overflowY,headerOutside:!port.contains(input)&&!port.contains(scope)&&!port.contains(document.getElementById('close-library-search')),filtersInside:port.contains(document.getElementById('library-search-filters')),scopeOutsideManage:!document.getElementById('library-options').contains(scope),singletons:['library-search','library-scope','library-search-scope','library','library-page-status','library-pagination','library-empty'].every(id=>document.querySelectorAll('#'+id).length===1)};
 });
 geometry.push({label,...m});
 check(label+'_native_modal_singleton_tree_and_one_result_scrollport',m.native&&m.singletons&&m.headerOutside&&m.filtersInside&&m.scopeOutsideManage&&!m.dialogScroll&&/auto|scroll/.test(m.portOverflow));
 check(label+'_no_horizontal_overflow',!m.overflow);
 if(m.width>=1000)check(label+'_960px_dialog_with_real_source_and_translation_at_least_640px',m.dialog.width<=960&&m.preview.width>=640&&m.source.width>=640);
 if(m.width===390)check(label+'_full_height_390px_with_real_source_and_translation_at_least_320px',m.dialog.left===0&&m.dialog.top===0&&m.dialog.width===390&&m.dialog.height===m.height&&m.preview.width>=320&&m.source.width>=320);
}
async function search(query,scope='translations',count=40){
 await openLibrarySearch(page);await page.locator('#library-scope').selectOption(scope);await page.locator('#library-search').fill(query);
 await page.waitForFunction(({query,scope,count})=>{const host=document.getElementById('library');return document.getElementById('library-search').value===query&&document.getElementById('library-scope').value===scope&&!host.hidden&&host.getAttribute('aria-busy')==='false'&&host.querySelectorAll('.library-entry').length===count;},{query,scope,count});
}
async function jump(number){await page.locator('#library-page-number').fill(String(number));await page.locator('#library-page-number').press('Enter');await page.waitForFunction(number=>document.getElementById('library-page-number').value===String(number)&&document.activeElement?.classList.contains('library-open'),number);}
async function ownership(){return page.evaluate(()=>({key:state.active,selected:sessionStorage.getItem('coconut-reader-active-v1'),mode:document.body.dataset.readingMode,documents:JSON.stringify(state.documents),draft:document.getElementById('translation-glossary').value}));}
async function returnSnapshot(label,{save=false}={}){
 // One read captures every return condition together, including the browser's
 // attainable scroll range. It never changes focus, scroll or the result tree.
 const snapshot=await page.evaluate(({expected,save})=>{
  const port=document.getElementById('library-search-results'),dialog=document.getElementById('library-search-dialog');
  const entry=expected&&document.querySelector('.library-entry[data-document-key="'+expected.key+'"]');
  const group=entry?.querySelector('.library-translation-group[data-language="'+expected.language+'"]'),target=group?.querySelector('.library-translation-hit');
  const activeButton=document.getElementById('library-show-active'),focused=document.activeElement,rect=node=>node?.getBoundingClientRect().toJSON()??null;
  const targetRect=rect(target),portRect=rect(port),style=target&&getComputedStyle(target);
  const current=port.scrollTop,max=Math.max(0,port.scrollHeight-port.clientHeight);
  const saved=save?current:expected?.savedScroll??null,hitIndex=group?.querySelector('.library-translation-status')?.textContent??null;
  return {width:innerWidth,query:document.getElementById('library-search').value,scope:document.getElementById('library-scope').value,page:document.getElementById('library-page-number').value,pageStatus:document.getElementById('library-page-status').textContent,activeKey:state.active,dialogOpen:dialog.open,native:dialog.matches(':modal'),documentKey:entry?.dataset.documentKey??null,language:target?.dataset.language??null,hitId:target?.dataset.hitId??null,hitIndex,focused:!!target&&focused===target,connected:target?.isConnected??false,modalOpen:dialog.open&&dialog.matches(':modal'),scrollTop:current,maxScrollTop:max,scrollHeight:port.scrollHeight,clientHeight:port.clientHeight,targetTop:targetRect?.top??null,targetPortOffset:targetRect?targetRect.top-portRect.top:null,scroll:{saved,current,max,scrollHeight:port.scrollHeight,clientHeight:port.clientHeight,clientTop:port.clientTop,expectedClamp:saved===null?null:Math.min(saved,max)},portRect,target:{key:entry?.dataset.documentKey??null,language:target?.dataset.language??null,hitId:target?.dataset.hitId??null,hitIndex,rect:targetRect,offsetTop:target?.offsetTop??null,contentTop:targetRect?targetRect.top-portRect.top-port.clientTop+current:null,focused:!!target&&focused===target,connected:target?.isConnected??false,focusVisible:target?.matches(':focus-visible')??false,ring:style?(parseFloat(style.outlineWidth)||0)+Math.max(0,parseFloat(style.outlineOffset)||0):null},focus:{id:focused?.id,tagName:focused?.tagName,classes:focused?.className,hitId:focused?.dataset.hitId,language:focused?.dataset.language,modal:focused?.closest('dialog')?.id},activeButton:{hidden:activeButton.hidden,rect:rect(activeButton)},feedbackRect:rect(document.getElementById('library-search-feedback')),components:expected?{query:document.getElementById('library-search').value===expected.query,scope:document.getElementById('library-scope').value===expected.scope,page:document.getElementById('library-page-number').value===expected.page,key:entry?.dataset.documentKey===expected.key,hit:target?.dataset.hitId===expected.hitId,language:target?.dataset.language===expected.language,hitIndex:hitIndex===expected.hitIndex,focus:!!target&&focused===target,connected:target?.isConnected===true,nativeModal:dialog.open&&dialog.matches(':modal')}:null,rawScrollMatches:saved===null?null:Math.abs(current-saved)<=1};
 },{expected:returnExpectation,save});
 if(save)returnExpectation={...returnExpectation,savedScroll:snapshot.scrollTop};
 returns.push({label,expected:returnExpectation,snapshot});console.log(JSON.stringify({suite:'wide-library-search-return',label,expected:returnExpectation,snapshot}));return snapshot;
}
function returnProof(label,before,after,{allowClamping=false}={}){
 const scroll=evaluateLibraryReturnScroll({before,after}),identity=evaluateLibraryReturnIdentity({before,after});
 const scrollPolicy=allowClamping?'native-clamp-with-stable-anchor':'raw-retention',rawScrollMatches=Math.abs(after.scrollTop-before.scrollTop)<=1;
 returns.push({label,expected:returnExpectation,components:after.components,identity,scrollPolicy,rawScrollMatches,scroll});console.log(JSON.stringify({suite:'wide-library-search-return-proof',label,expected:returnExpectation,components:after.components,identity,scrollPolicy,rawScrollMatches,scroll}));
 for(const [name,value]of Object.entries(after.components))check(label+'_expected_'+name,value===true);
 for(const [name,value]of Object.entries(identity))check(label+'_retained_'+name,value===true);
 check(label+'_valid_scroll_metrics',scroll.validMetrics);
 if(!allowClamping)check(label+'_raw_scroll_retained_without_clamp_exception',rawScrollMatches);
 return Object.values(after.components).every(value=>value===true)&&Object.values(identity).every(value=>value===true)&&(allowClamping?scroll.pass:rawScrollMatches);
}
async function installIMEAudit(targetPage,selector){
 await targetPage.evaluate(selector=>{
  const original=document.querySelector(selector),types=['compositionstart','compositionupdate','compositionend','beforeinput','input'];
  window.__wideIMEOriginal=original;window.__wideIMESelector=selector;window.__wideIME=[];window.__wideIMEManual=[];window.__wideIMEComposing=false;window.__wideIMEPhase='installed';
  for(const type of types)original.addEventListener(type,event=>{
   if(type==='compositionstart')__wideIMEComposing=true;
   if(type==='compositionend')__wideIMEComposing=false;
   __wideIME.push({type:event.type,data:event.data??null,trusted:event.isTrusted,same:event.target===original,inputType:event.inputType??null,isComposing:event.isComposing??null,phase:__wideIMEPhase,value:original.value,selectionStart:original.selectionStart,selectionEnd:original.selectionEnd,focused:document.activeElement===original,activeElement:document.activeElement?.id||document.activeElement?.tagName,currentNodeSame:document.querySelector(selector)===original,connected:original.isConnected});
  });
  // Observe manual dispatches without fabricating or changing any event. CDP
  // uses the browser input pipeline and must not call this JavaScript method.
  const dispatch=EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent=function(event){if(types.includes(event?.type))__wideIMEManual.push({type:event.type,target:this.id||this.nodeName||null,phase:__wideIMEPhase});return dispatch.call(this,event);};
 },selector);
}
async function imeSnapshot(targetPage,width,role,phase){
 const snapshot=await targetPage.evaluate(({role,phase})=>{
  window.__wideIMEPhase=phase;
  const original=window.__wideIMEOriginal,current=document.querySelector(window.__wideIMESelector||'#library-search'),focused=document.activeElement;
  const events=window.__wideIME||[];
  return {events,manualDispatches:window.__wideIMEManual||[],value:original?.value??null,selectionStart:original?.selectionStart??null,selectionEnd:original?.selectionEnd??null,same:!!original&&original===current&&original.isConnected,focused:!!original&&original===focused,composing:role==='application'?(typeof librarySearchComposing==='boolean'?librarySearchComposing:null):window.__wideIMEComposing,activeElement:{id:focused?.id,tagName:focused?.tagName,modal:focused?.closest('dialog')?.id},originalConnected:original?.isConnected??false,dialogOpen:document.getElementById('library-search-dialog')?.open??null,originalSingleton:role==='application'?current===window.__wideNodes?.['library-search']:current===original,components:{start:events.some(e=>e.type==='compositionstart'),update:events.some(e=>e.type==='compositionupdate'),end:events.some(e=>e.type==='compositionend'),allTrusted:events.every(e=>e.trusted),allSame:events.every(e=>e.same)}};
 },{role,phase});
 ime.push({width,role,phase,snapshot});console.log(JSON.stringify({suite:'wide-library-search-ime-phase',browserVersion,width,role,phase,snapshot}));return snapshot;
}
async function nativeIMESequence(targetPage,width,role){
 const cdp=await targetPage.context().newCDPSession(targetPage);
 try{
  const protocolVersion=await cdp.send('Browser.getVersion');ime.push({width,role,protocolVersion});
  // Discard ordinary fill/click preparation events, never native IME events.
  await targetPage.evaluate(()=>{__wideIME=[];__wideIMEManual=[];__wideIMEComposing=false;});
  await imeSnapshot(targetPage,width,role,'before-imeSetComposition');
  await targetPage.evaluate(()=>{__wideIMEPhase='imeSetComposition';});
  await cdp.send('Input.imeSetComposition',{text:'路标',selectionStart:2,selectionEnd:2});
  await imeSnapshot(targetPage,width,role,'after-imeSetComposition');
  await targetPage.evaluate(()=>{__wideIMEPhase='insertText';});
  await cdp.send('Input.insertText',{text:'路标'});
  return await imeSnapshot(targetPage,width,role,'after-insertText');
 }catch(error){await imeSnapshot(targetPage,width,role,'cdp-failure').catch(snapshotError=>ime.push({width,role,phase:'cdp-failure',snapshotError:snapshotError.message}));throw error;}
 finally{await cdp.detach();}
}
async function nativeIMEBaseline(context,width){
 const baselinePage=await context.newPage();
 try{
  await baselinePage.setContent('<!doctype html><html lang="en"><title>Authored native search input baseline</title><label>Native IME baseline <input id="native-ime-baseline" type="search"></label></html>');
  await installIMEAudit(baselinePage,'#native-ime-baseline');await baselinePage.locator('#native-ime-baseline').click();
  return await nativeIMESequence(baselinePage,width,'baseline');
 }finally{await baselinePage.close();}
}
async function media(label,mounted=true){
 const audit=await page.evaluate(()=>({...window.__wideMedia,time:window.__widePlayer.currentTime,paused:window.__widePlayer.paused,mounted:document.querySelector('#source-media audio')===window.__widePlayer}));
 check(label+'_no_seek_or_play_and_nonzero_clock_unchanged',audit.plays===0&&audit.seeks.length===0&&audit.time===6&&audit.paused&&audit.mounted===mounted);
}
function fixtures(){
 const docs=largeLibraryFixture(81);
 for(const doc of docs){doc.readingPosition=doc.segments[7].id;doc.translation_view='';for(const cue of doc.segments.slice(1,6))cue.translations={zh:{text:'widebeacon '+('自写路标与完整译文。'.repeat(4)),source_text:cue.text,source_language:'en',document_language:'en',provider:'authored'}};}
 const original=C.validate(docs[0]);original.key=docs[0].key;
 original.segments[0].text='historical-widebeacon retained exact words';
 original.exact_excerpts=[C.exactExcerptSnapshot(original,[original.segments[0]],[],0,original.segments[0].text.length,{id:'wide-history',createdAt:'2026-10-11T00:00:00.000Z'})];
 original.segments[0].text='Corrected current source excludes the historical query';docs[0]=original;
 // Actual 501-contributor matching forces production activation verification
 // to yield. Only the continuation clock is held during the explicit race probe.
 const long=docs[79];long.segments=Array.from({length:600},(_,i)=>{const text='Authored activation contributor '+i;return {id:'long-'+i,start:i,end:i+0.8,text,translations:{fr:{text:'a',source_text:text,source_language:'en',document_language:'en',provider:'authored'}}};});long.readingPosition='long-599';
 // Keep all 81 documents in the ordinary query as well.
 long.segments[599].translations.zh={text:'widebeacon long document final match',source_text:long.segments[599].text,source_language:'en',document_language:'en',provider:'authored'};
 return docs;
}
async function installActivationClock(){
 await page.evaluate(()=>{
  const native=window.setTimeout;window.__wideActivation={hold:false,tasks:[],scheduled:0};
  window.setTimeout=function(callback,delay,...args){if(__wideActivation.hold&&callback?.name==='step'&&delay===0){__wideActivation.scheduled++;__wideActivation.tasks.push(()=>native(callback,0,...args));return -__wideActivation.scheduled;}return native(callback,delay,...args);};
  window.__wideReleaseActivation=()=>{__wideActivation.hold=false;for(const task of __wideActivation.tasks.splice(0))task();};
 });
}
try{
 server=await startBridge({port:0});const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 browserVersion=browser.version();
 for(const width of [1360,390]){
  returnExpectation=null;
  stage=width+' import and native media baseline';
  const context=await browser.newContext({viewport:{width,height:width===390?844:1000},acceptDownloads:true,serviceWorkers:'block'});
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(!['GET','HEAD'].includes(request.method())){mutations++;await route.abort();}else if(url.origin===origin||['blob:','data:'].includes(url.protocol))await route.continue();else{external++;await route.abort();}});
  page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);
  const docs=fixtures();await openLibraryTools(page);await page.locator('.library-backup > summary').click();
  const [restore]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#restore-library').click()]);
  await restore.setFiles({name:'authored-wide-library.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({format:'coconut-library',version:1,documents:docs,active:docs[0].key}))});
  await waitForPersistedLibrary(page,async()=>(await readPersistedLibrary()).documents.length===81);
  if(await page.locator('#toggle-library').isVisible()&&await page.locator('#toggle-library').getAttribute('aria-expanded')==='true')await page.locator('#toggle-library').click();
  if(!await page.locator('#attach-reader-media').isVisible())await page.locator('#toggle-reader-media').click();
  const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-reader-media').click()]);
  await chooser.setFiles({name:'authored-wide-tone.wav',mimeType:'audio/wav',buffer:authoredAudioFixture(40)});
  await page.waitForFunction(()=>{const p=document.querySelector('#source-media audio');return p&&!p.error&&p.readyState>=2&&p.duration===40;});
  await page.locator('#source-media audio').evaluate(async player=>{
   player.pause();await new Promise(resolve=>{player.addEventListener('seeked',resolve,{once:true});player.currentTime=6;});window.__widePlayer=player;window.__wideMedia={seeks:[],plays:0};
   const descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime'),play=HTMLMediaElement.prototype.play;
   Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{...descriptor,set(value){__wideMedia.seeks.push(value);return descriptor.set.call(this,value);}});
   HTMLMediaElement.prototype.play=function(...args){__wideMedia.plays++;return play.apply(this,args);};
  });
  if(await page.locator('#close-reader-media').isVisible())await page.locator('#close-reader-media').click();
  await page.evaluate(()=>libraryStore.flush());
  // Keep a genuine, unsubmitted per-document glossary draft throughout cancel
  // and IME; never save it or grant any provider consent.
  // A restored document starts in passages, where the entire language panel
  // is hidden. Enter bilingual reading, then its real translation entry and
  // nested options; short phone documents may first require the tool disclosure.
  await page.locator('#mode-bilingual').click();await openTranscriptTools(page);
  await expect(page.locator('#prepare-bilingual')).toBeVisible();await page.locator('#prepare-bilingual').click();
  await expect(page.locator('#ai-task')).toHaveValue('translation');
  await expect(page.locator('#translation-options > summary')).toBeVisible();
  if(!await page.locator('#translation-options').evaluate(node=>node.open))await page.locator('#translation-options > summary').click();
  await expect(page.locator('#translation-glossary')).toBeVisible();await expect(page.locator('#translation-glossary')).toBeEnabled();
  await page.locator('#translation-glossary').fill('widebeacon = 未提交的自写术语');await page.locator('#language-panel > summary').click();
  await page.evaluate(()=>libraryStore.flush());
  const initial=await ownership(),persisted=await page.evaluate(()=>readPersistedLibrary());
  await page.evaluate(()=>{window.__wideNodes=Object.fromEntries(['library-search','library-scope','library-search-scope','library','library-page-status','library-pagination','library-empty'].map(id=>[id,document.getElementById(id)]));});
  await installIMEAudit(page,'#library-search');

  stage=width+' native keyboard and wide geometry';
  await page.locator('#open-library-search').focus();await page.keyboard.press('Enter');
  check(width+'_native_enter_opens_and_focuses_original_search',await page.locator('#library-search').evaluate(node=>node===document.activeElement&&node===__wideNodes['library-search']));
  await search('widebeacon');await layout(width+'-initial');await capture(width+'-initial');
  await walk(page.locator('#library-scope'),width+'-scope');await keyboardGeometry(page.locator('#library-scope'),width+'-scope');
  await page.keyboard.press('Escape');await openLibrarySearch(page);await settle();
  check(width+'_cancel_and_reopen_retains_noncard_scope_owner',await page.locator('#library-scope').evaluate(node=>node===document.activeElement)&&await page.locator('#library-scope').inputValue()==='translations');
  await walk(page.locator('#library-search'),width+'-reverse-input','Shift+Tab');await keyboardGeometry(page.locator('#library-search'),width+'-input');
  await walk(page.locator('#close-library-search'),width+'-reverse-close','Shift+Tab');await keyboardGeometry(page.locator('#close-library-search'),width+'-close');
  await page.keyboard.press('Enter');await settle();
  check(width+'_close_returns_to_real_opener_without_reopening',!await page.locator('#library-search-dialog').evaluate(node=>node.open)&&await page.locator('#open-library-search').evaluate(node=>node===document.activeElement));
  sameValue(await ownership(),initial,width+'_search_and_cancel_leave_reader_documents_language_and_drafts_unchanged');
  sameValue(await page.evaluate(()=>readPersistedLibrary()),persisted,width+'_search_and_cancel_leave_real_indexeddb_unchanged');await media(width+'-cancel');

  stage=width+' isolated native search input IME baseline';
  const baselineIME=await nativeIMEBaseline(context,width);
  stage=width+' original input native IME and repeat closing';
  await openLibraryTools(page);await page.locator('#library-search').click();
  await page.locator('#library-search').fill('');
  const actualIME=await nativeIMESequence(page,width,'application');
  await expect(page.locator('#library-search')).toHaveValue('路标');
  // Preserve trusted input/start/update, a real end, and original ownership.
  // compositionend trust must exactly match this same browser's plain input;
  // no arbitrary false flag, missing event or synthetic dispatch is accepted.
  const imeProof=evaluateNativeIME({baseline:baselineIME,actual:actualIME,text:'路标'});
  ime.push({width,role:'comparison',proof:imeProof});console.log(JSON.stringify({suite:'wide-library-search-ime-comparison',browserVersion,width,proof:imeProof}));
  for(const [name,value]of Object.entries(imeProof))check(width+'_native_ime_'+name,value===true);
  check(width+'_trusted_ime_events_keep_the_original_input',Object.values(imeProof).every(value=>value===true)&&actualIME.originalSingleton);
  await closeLibrarySearch(page);await settle();
  check(width+'_ime_close_does_not_automatically_reopen',!await page.locator('#library-search-dialog').evaluate(node=>node.open));
  for(let i=0;i<3;i++){await openLibrarySearch(page);await page.keyboard.press('Escape');await settle();check(width+'_repeat_native_escape_'+i,!await page.locator('#library-search-dialog').evaluate(node=>node.open)&&await page.locator('#library-search').inputValue()==='路标');}
  check(width+'_unsubmitted_glossary_survives_ime_and_repeated_cancel',await page.locator('#translation-glossary').inputValue()==='widebeacon = 未提交的自写术语');
  if(await page.locator('#toggle-library').isVisible()&&await page.locator('#toggle-library').getAttribute('aria-expanded')==='true')await page.locator('#toggle-library').click();
  await page.locator('#language-panel > summary').click();await page.locator('#cancel-translation-glossary').click();await page.locator('#language-panel > summary').click();

  stage=width+' live success notice belongs to the native top layer';
  await search('widebeacon');await jump(3);await openLibraryTools(page);
  if(!await page.locator('.library-backup').evaluate(node=>node.open))await page.locator('.library-backup > summary').click();
  const [backup]=await Promise.all([page.waitForEvent('download'),page.locator('#export-library').click()]);
  await openLibrarySearch(page);await walk(page.locator('#dismiss-notice'),width+'-live-toast-dismiss','Shift+Tab');
  check(width+'_real_download_success_notice_is_still_live_inside_modal',await page.locator('#notice').isVisible()&&await page.locator('#notice').getAttribute('data-kind')==='success'&&await page.locator('#notice-shell').evaluate(node=>node.closest('dialog')?.id==='library-search-dialog'));
  await keyboardGeometry(page.locator('#dismiss-notice'),width+'-live-toast-dismiss');
  await walk(hit('shelf-80'),width+'-live-toast-hit','Shift+Tab');await keyboardGeometry(hit('shelf-80'),width+'-live-toast-hit');
  check(width+'_success_notice_did_not_expire_before_hit_geometry',await page.locator('#notice').isVisible()&&await page.locator('#notice').getAttribute('data-kind')==='success');await capture(width+'-live-success-toast');
  await walk(page.locator('#dismiss-notice'),width+'-dismiss-after-proof');await page.keyboard.press('Enter');
  check(width+'_native_success_dismiss_keeps_search_open_and_focus_owned',await page.locator('#notice').isHidden()&&await page.locator('#library-search').evaluate(node=>node===document.activeElement)&&await page.locator('#library-search-dialog').evaluate(node=>node.open));
  check(width+'_actual_success_backup_contains_all_81_documents',JSON.parse(await fs.readFile(await backup.path(),'utf8')).documents.length===81);

  stage=width+' page three exact fifth language hit and reading return';
  // The live-toast journey deliberately left the same query on page three.
  // Unchanged queries preserve that page; the default 40-card wait is for page one.
  await expect(page.locator('#library-page-number')).toHaveValue('3');
  await search('widebeacon','translations',1);await jump(3);
  check(width+'_40_document_paging_reaches_document_81',await page.locator('.library-entry').count()===1&&await page.locator('.library-entry').getAttribute('data-document-key')==='shelf-80'&&/81/.test(await page.locator('#library-page-status').textContent()));
  for(let i=1;i<5;i++){await walk(group('shelf-80').locator('.library-translation-next'),width+'-next-'+i);await keyboardGeometry(group('shelf-80').locator('.library-translation-next'),width+'-next-'+i);await page.keyboard.press('Enter');await expect(hit('shelf-80')).toHaveAttribute('data-hit-id','shelf-80-cue-'+(i+1));}
  await keyboardGeometry(hit('shelf-80'),width+'-fifth-hit');await capture(width+'-page-three-fifth-match');
  returnExpectation={key:'shelf-80',language:'zh',hitId:'shelf-80-cue-5',hitIndex:'第 5 / 5 处',query:'widebeacon',scope:'translations',page:'3',savedScroll:null};
  const beforeReturn=await returnSnapshot(width+'-before-hit-selection',{save:true});
  await page.keyboard.press('Enter');await page.waitForFunction(()=>state.active==='shelf-80'&&active().translation_view==='zh'&&document.activeElement?.dataset.segmentId==='shelf-80-cue-5');
  check(width+'_selection_closes_native_dialog_at_real_source',!await page.locator('#library-search-dialog').evaluate(node=>node.open)&&await page.locator('.segment[data-segment-id="shelf-80-cue-5"] .translation mark').textContent()==='widebeacon');
  await walkReader(page.locator('#return-library-search'),width+'-return-entry');await returnSnapshot(width+'-before-return-entry');await page.keyboard.press('Enter');await settle();
  const afterReturn=await returnSnapshot(width+'-after-return-entry');
  check(width+'_return_restores_query_scope_page_fifth_hit_scroll_and_actual_focus',returnProof(width+'-exact-hit-return',beforeReturn,afterReturn,{allowClamping:true}));
  await keyboardGeometry(hit('shelf-80'),width+'-returned-hit');await media(width+'-cross-document',false);

  stage=width+' newer cancelled page beats previous successful hit';
  await jump(2);await walk(hit('shelf-40'),width+'-newer-page-owner');await keyboardGeometry(hit('shelf-40'),width+'-newer-page-owner');
  returnExpectation={key:'shelf-40',language:'zh',hitId:'shelf-40-cue-1',hitIndex:'第 1 / 5 处',query:'widebeacon',scope:'translations',page:'2',savedScroll:null};
  const beforeCancel=await returnSnapshot(width+'-before-page-two-cancel',{save:true});
  await page.keyboard.press('Escape');await openLibrarySearch(page);await settle();
  const afterCancel=await returnSnapshot(width+'-after-page-two-reopen');
  check(width+'_cancelled_page_two_and_new_owner_override_old_page_three_return',returnProof(width+'-cancelled-page-two-return',beforeCancel,afterCancel));

  await walk(page.locator('#library-page-number'),width+'-page-number-owner','Shift+Tab');await page.keyboard.press('Escape');await openLibrarySearch(page);await settle();
  check(width+'_cancel_and_reopen_retains_noncard_page_input_owner',await page.locator('#library-page-number').evaluate(node=>node===document.activeElement)&&await page.locator('#library-page-number').inputValue()==='2');

  stage=width+' opened resize crosses 650 and desktop boundaries';
  await page.locator('#library-search').click();await page.locator('#library-search').evaluate(node=>node.setSelectionRange(2,7));
  const beforeResize=await page.locator('#library-search-results').evaluate(node=>node.scrollTop);
  for(const nextWidth of [650,651,1360,390,1360,width]){
   await page.setViewportSize({width:nextWidth,height:nextWidth<=650?844:1000});await settle();
   check(width+'_resize_'+nextWidth+'_keeps_single_original_nodes_input_focus_and_caret',await page.evaluate(()=>Object.entries(__wideNodes).every(([id,node])=>document.getElementById(id)===node)&&document.activeElement===__wideNodes['library-search']&&__wideNodes['library-search'].selectionStart===2&&__wideNodes['library-search'].selectionEnd===7&&document.getElementById('library-search-dialog').open));
   check(width+'_resize_'+nextWidth+'_keeps_query_page_and_scrollport',await page.locator('#library-search').inputValue()==='widebeacon'&&await page.locator('#library-page-number').inputValue()==='2'&&Math.abs(await page.locator('#library-search-results').evaluate(node=>node.scrollTop)-beforeResize)<=1);
   await layout(width+'-resize-'+nextWidth);
  }
  const headerBefore=await page.locator('#library-search-query').boundingBox();
  await page.locator('#library-search-results').hover();await page.mouse.wheel(0,700);
  await page.waitForFunction(before=>document.getElementById('library-search-results').scrollTop>before,beforeResize);await settle();
  sameValue(await page.locator('#library-search-query').boundingBox(),headerBefore,width+'_results_scroll_keeps_query_and_scope_fixed');
  check(width+'_outer_dialog_never_becomes_a_second_results_scrollport',await page.locator('#library-search-dialog').evaluate(node=>node.scrollTop===0));await capture(width+'-scrolled-wide-results');

  stage=width+' historical notebook return uses one modal';
  await search('historical-widebeacon','text',1);const saved=page.locator('.library-saved-hit[data-hit-id="wide-history"]');
  await walk(saved,width+'-saved-record');await keyboardGeometry(saved,width+'-saved-record');const beforeNotebook=await ownership();await page.keyboard.press('Enter');
  await expect(page.locator('#library-notebook')).toBeVisible();check(width+'_saved_hit_has_exactly_one_native_modal',await page.evaluate(()=>document.querySelectorAll('dialog:modal').length===1&&document.querySelector('dialog:modal').id==='library-notebook'));
  check(width+'_historical_snapshot_is_retained_and_not_rewritten',await page.locator('.notebook-capture[data-capture-id="wide-history"] .notebook-quote').textContent()==='historical-widebeacon retained exact words');
  await page.keyboard.press('Escape');await settle();
  check(width+'_notebook_escape_reopens_search_at_exact_saved_owner',await page.evaluate(()=>document.querySelectorAll('dialog:modal').length===1&&document.querySelector('dialog:modal').id==='library-search-dialog')&&await saved.evaluate(node=>node===document.activeElement));
  sameValue(await ownership(),beforeNotebook,width+'_notebook_roundtrip_does_not_change_reader_ownership');
  await keyboardGeometry(saved,width+'-saved-return');await capture(width+'-historical-return');

  stage=width+' real yielded activation cannot outlive close or newer selection';
  await installActivationClock();const phrase=Array(501).fill('a').join(' ');
  for(const race of ['close-reopen','next-match','new-selection']){
   await search(phrase,'translations',1);const target=hit('shelf-79','fr');
   await walk(target,width+'-'+race);const before=await ownership();
   await page.evaluate(()=>{__wideActivation.hold=true;});await page.keyboard.press('Enter');
   await page.waitForFunction(()=>__wideActivation.tasks.length===1);
   if(race==='close-reopen'){await closeLibrarySearch(page);await openLibrarySearch(page);}
   else if(race==='next-match'){await group('shelf-79','fr').locator('.library-translation-next').click();await expect(target).toHaveAttribute('data-hit-id','long-1');}
   else{await entry('shelf-79').locator('.library-open').click();await page.waitForFunction(()=>state.active==='shelf-79');}
   await page.evaluate(()=>__wideReleaseActivation());await settle();
   if(race==='new-selection')check(width+'_old_activation_cannot_set_language_after_new_title_selection',await page.evaluate(()=>state.active==='shelf-79'&&active().translation_view===''&&!document.getElementById('library-search-dialog').open));
   else{sameValue(await ownership(),before,width+'_'+race+'_rejects_previous_activation');check(width+'_'+race+'_keeps_native_dialog_open',await page.locator('#library-search-dialog').evaluate(node=>node.open));}
  }

  stage=width+' actual failed save and modal-contained recovery';
  await closeLibrarySearch(page);await page.locator('#mode-transcript').click();
  const row=page.locator('.segment').first(),noteId=await row.getAttribute('data-segment-id');await openCueActions(row);await row.locator('.note-button').click();
  await page.evaluate(()=>failContentWrites());await page.locator('#note').fill('Authored failed wide-search save');await page.evaluate(()=>libraryStore.flush());
  await expect(page.locator('#save-status')).toHaveAttribute('data-state','failed');await page.locator('#close-note').click();
  await search('widebeacon');
  check(width+'_failure_and_recovery_controls_live_inside_search_modal',await page.locator('#save-status').evaluate(node=>node.closest('dialog')?.id==='library-search-dialog')&&await page.locator('#retry-save').isVisible()&&await page.locator('#export-unsaved-documents').isVisible());
  await walk(page.locator('#retry-save'),width+'-retry','Shift+Tab');await keyboardGeometry(page.locator('#retry-save'),width+'-retry');await capture(width+'-failed-save');
  await page.evaluate(()=>restoreContentWrites());await page.keyboard.press('Enter');
  await expect(page.locator('#save-status')).toHaveAttribute('data-state','saved');
  await waitForPersistedLibrary(page,async noteId=>(await readPersistedLibrary()).documents.find(doc=>doc.key==='shelf-79')?.notes[noteId]==='Authored failed wide-search save',noteId);
  check(width+'_retry_waits_for_real_idb_and_keeps_focused_control',await page.locator('#retry-save').evaluate(node=>node===document.activeElement&&node.closest('dialog')?.id==='library-search-dialog'));
  // A real production lifecycle barrier is an adversarial boundary, not a fake
  // save receipt. The normal button activation must explain refusal in top layer.
  await page.evaluate(()=>{window.__wideBarrier=libraryStore.acquireBarrier('authored-wide-search');});const blockedBefore=await ownership();
  await hit('shelf-0').click();await settle();sameValue(await ownership(),blockedBefore,width+'_save_barrier_blocks_cross_document_activation');
  check(width+'_save_barrier_refusal_is_visible_inside_modal',await page.locator('#notice').isVisible()&&await page.locator('#notice').evaluate(node=>node.closest('dialog')?.id==='library-search-dialog')&&/保存/.test(await page.locator('#notice').textContent())&&await page.locator('#library-search-dialog').evaluate(node=>node.open));
  await capture(width+'-save-barrier');await page.evaluate(()=>libraryStore.releaseBarrier(__wideBarrier));
  await closeLibrarySearch(page);await page.reload();
  await waitForPersistedLibrary(page,async()=>(await readPersistedLibrary()).documents.length===81&&Object.values((await readPersistedLibrary()).documents.find(doc=>doc.key==='shelf-79')?.notes||{}).includes('Authored failed wide-search save'));
  await search('widebeacon');await layout(width+'-reloaded');
  check(width+'_real_idb_reload_keeps_complete_library_and_explicit_reading_markers',await page.evaluate(()=>state.documents.length===81&&state.documents.every(doc=>doc.readingPosition===(doc.key==='shelf-79'?'long-599':doc.key+'-cue-7'))));
  await context.close();page=null;
 }
 check('no_external_requests_mutating_http_or_uncaught_errors',external===0&&mutations===0&&errors.length===0);
 console.log(JSON.stringify({suite:'wide-library-search',status:'passed',checks,screenshots}));
}catch(error){failure={stage,error:{name:error.name,message:error.message,stack:error.stack}};if(page&&!page.isClosed()){await returnSnapshot('suite-failure').catch(snapshotError=>returns.push({label:'suite-failure',snapshotError:snapshotError.message}));await imeSnapshot(page,page.viewportSize()?.width,'application','suite-failure').catch(snapshotError=>ime.push({phase:'suite-failure',snapshotError:snapshotError.message}));await capture('failure').catch(()=>{});}console.error(JSON.stringify({suite:'wide-library-search',status:'failed',...failure,browserVersion,ime,returns,checks}));throw error;}
finally{
 if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'wide-library-search-checks.json'),JSON.stringify({suite:'wide-library-search',status:failure?'failed':'passed',failure,browserVersion,ime,returns,checks,geometry,screenshots,errors,external,mutations},null,2));}
 await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());
}
