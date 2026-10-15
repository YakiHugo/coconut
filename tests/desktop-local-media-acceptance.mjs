// Explicit compatibility native regression. Default React has a separate packaged acceptance suite.
/** Exact packaged macOS ZIP, isolated profiles and authored tone only.
 * Exercises real File chooser/preload path, decoding, quit/relaunch and backups.
 * This is native product acceptance, not Gatekeeper or an owner-library test. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {_electron as electron,expect} from '@playwright/test';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
import {installDockViewportObserver} from './helpers/dock-viewport-observer.mjs';
import {installNativeMediaViewportProof,nativeMediaAnchorIsStable,nativeMediaPhaseDelta,planNativeMediaWindow,evaluateNativeMediaWindow} from './helpers/native-media-viewport.mjs';
import {installStorageAssertions,readerReady} from './helpers/browser-storage.mjs';
import {installNativeMenuObservation,observePageFileChoosers,invokeObservedNativeMenuCommand} from './helpers/native-menu-observer.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),origin='http://127.0.0.1:47831';
let temporary,application,page,chooserObservation,executable,version,stage='configuration',forbidden=0,pageErrors=0;
const checks=[],dockReceipts=[],windowReceipts=[],nativeCommands=[];process.umask(0o077);delete process.env.DEBUG;delete process.env.PWDEBUG;
function check(name,value){stage=name;assert.ok(value,name);checks.push(name);}
async function launch(profile){
 stage='launch';await fs.mkdir(profile,{recursive:true});
 // Isolated fixture uses the existing six-hour updater throttle. Renderer routes
 // cannot block main-process node:https; refresh before every packaged launch.
 const updateDirectory=path.join(profile,'updates'),updateSettings={developer:false,lastCheck:Date.now()};await fs.mkdir(updateDirectory,{recursive:true});await fs.writeFile(path.join(updateDirectory,'settings.json'),JSON.stringify(updateSettings));assert.deepEqual(JSON.parse(await fs.readFile(path.join(updateDirectory,'settings.json'),'utf8')),updateSettings);
 const home=path.join(temporary,'home');await fs.mkdir(home,{recursive:true});
 application=await electron.launch({executablePath:executable,args:['--user-data-dir='+profile],cwd:temporary,acceptDownloads:true,chromiumSandbox:true,bypassCSP:false,timeout:45000,
  env:{HOME:home,TMPDIR:temporary,PATH:'/usr/bin:/bin',LANG:process.env.LANG||'en_US.UTF-8'}});
 const facts=await application.evaluate(({app})=>({packaged:app.isPackaged,version:app.getVersion(),userData:app.getPath('userData'),appPath:app.getAppPath()}));
 check('runs_exact_packaged_asar',facts.packaged&&facts.appPath.endsWith('/app.asar')&&facts.version===version);check('isolated_profile',await fs.realpath(facts.userData)===await fs.realpath(profile));
 await application.context().route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(['blob:','data:'].includes(url.protocol)||url.origin===origin&&['GET','HEAD'].includes(request.method())&&url.pathname!=='/api/language-tools')await route.continue();else{forbidden++;await route.abort();}});
 page=await application.firstWindow();chooserObservation=observePageFileChoosers(page);page.setDefaultTimeout(15000);page.on('pageerror',()=>pageErrors++);
 await page.waitForURL(url=>url.origin===origin&&url.pathname==='/');await page.locator('.react-app').waitFor();await page.goto(origin+'/compatibility.html');await installStorageAssertions(page);await readerReady(page);
 await page.waitForFunction(()=>window.coconutLocalMedia&&window.CoconutStorageBootstrap.phase==='ready'&&nativeMediaReady&&typeof window.coconutFileCommand==='function');
 await page.evaluate(installNativeMenuObservation);
 const preferences=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
 check('native_security_unchanged',preferences.sandbox===true&&preferences.contextIsolation===true&&preferences.nodeIntegration===false&&preferences.webSecurity===true);
}
async function quit(){
 stage='quit';if(!application)return;await page.evaluate(()=>libraryStore.flush());
 const closed=application.waitForEvent('close');await application.evaluate(({app})=>{setTimeout(()=>app.quit(),0);});await closed;chooserObservation?.dispose();application=null;
 await expect.poll(async()=>{try{await fetch(origin+'/api/health',{signal:AbortSignal.timeout(300)});return false;}catch{return true;}},{timeout:5000}).toBe(true);
}
async function mediaPanel(){if(!await page.locator('#episode-media').isVisible())await page.locator('#toggle-reader-media').click();}
async function selectNative(file,{existing=false}={}){
 stage='native_file_chooser';
 let chooser;
 if(existing){await mediaPanel();[chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-reader-media').click()]);}
 else{
  await expect.poll(()=>application.evaluate(({Menu})=>Menu.getApplicationMenu()?.getMenuItemById('open-local-media')?.enabled)).toBe(true);
  const diagnostic={};nativeCommands.push(diagnostic);
  [chooser]=await Promise.all([page.waitForEvent('filechooser'),invokeObservedNativeMenuCommand(application,page,'open-local-media',diagnostic).then(receipt=>{
   assert.equal(diagnostic.dispatch.windowCount,1,'Native media command must target the sole packaged window');
   assert.equal(receipt.threw,undefined,'Native media command must not throw');
   assert.equal(receipt.result,true,'Native media command must be accepted by the target renderer');
   assert.equal(receipt.userActivation,true,'Native media command must retain real user activation');
   assert.equal(diagnostic.inputClicks,diagnostic.before.inputClicks+1,'Native media command must click its real file input once');
   assert.deepEqual(diagnostic.lastInput,{id:'local-media-file',userActivation:true});
  })]);
 }
 check('actual_picker_target',await chooser.element().getAttribute('id')===(existing?'reader-media-file':'local-media-file'));
 await chooser.setFiles(file);await decoded();await page.evaluate(()=>libraryStore.flush());
}
async function decoded(){await page.waitForFunction(()=>{const player=document.querySelector('#source-media audio');return player&&!player.error&&player.readyState>=2&&Math.abs(player.duration-60)<0.1;});}
async function saved(){await page.evaluate(()=>libraryStore.flush());return page.evaluate(async()=>{const library=await window.readPersistedLibrary();return library.documents[0];});}
async function optIn(){
 stage='opt_in';await mediaPanel();const choice=page.locator('#remember-local-media-choice');await expect(choice).toBeVisible();await expect(choice).toBeEnabled();await expect(choice).not.toBeChecked();
 // The real change handler returns the box to unchecked while native consent
 // is pending. A genuine click must settle through its durable receipt first.
 await choice.click();await expect(page.locator('#remember-local-media-status')).toContainText('已在这台电脑记住');await expect(choice).toBeChecked();
}
async function releaseHeldNativeDockWrites(){
 if(!page||page.isClosed())return;
 await page.evaluate(()=>{const writes=window.__nativeDockWrites;if(!writes)return;writes.hold=false;for(const release of writes.pending.splice(0))release();});
}
async function settleNativeDockLayout(){
 await page.evaluate(()=>{window.__nativeDockStable={last:null,count:0};});
 await page.waitForFunction(()=>{const state=window.__nativeDockStable,value=JSON.stringify([innerWidth,innerHeight,scrollY,...['.segment.selected','#notes-panel','#reading-mode-toolbar','#media-dock'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return [r.top,r.bottom,r.height];})]);state.count=state.last===value?state.count+1:0;state.last=value;return state.count>=6;},null,{polling:'raf'});
}
function noteControlsVisible(view){return view.note.visible&&view.close.visible&&view.rewind.visible&&view.note.rect.bottom<view.rewind.rect.top&&view.notePanel.bottom<view.rewind.rect.top;}
async function expectNoPlayer(){
 // A no-player assertion before native initialization/resolve settles could
 // pass and then attach incorrectly after the test had already moved on.
 await page.waitForFunction(()=>{const doc=active(),entry=doc&&rememberedMediaStates.get(doc);return nativeMediaReady&&(!doc?.local_media_source||entry?.checked&&!entry.pending);});
 await expect(page.locator('#source-media audio')).toHaveCount(0);
}
async function captureNativeWindowGeometry(phase){
 const native=await application.evaluate(({BrowserWindow,screen})=>{
  const win=BrowserWindow.getAllWindows()[0],display=screen.getDisplayMatching(win.getBounds()),describe=d=>({id:d.id,bounds:d.bounds,workArea:d.workArea,scaleFactor:d.scaleFactor,rotation:d.rotation});
  return {window:{bounds:win.getBounds(),contentBounds:win.getContentBounds(),minimumSize:win.getMinimumSize(),maximumSize:win.getMaximumSize(),resizable:win.isResizable(),visible:win.isVisible(),fullScreen:win.isFullScreen(),zoomFactor:win.webContents.getZoomFactor()},display:describe(display),displays:screen.getAllDisplays().map(describe)};
 });
 const renderer=await page.evaluate(()=>({inner:{width:innerWidth,height:innerHeight},outer:{width:outerWidth,height:outerHeight},screenPosition:{x:screenX,y:screenY},screen:{width:screen.width,height:screen.height,availWidth:screen.availWidth,availHeight:screen.availHeight,availLeft:screen.availLeft,availTop:screen.availTop},devicePixelRatio,visualViewport:visualViewport?{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale,offsetLeft:visualViewport.offsetLeft,offsetTop:visualViewport.offsetTop,pageLeft:visualViewport.pageLeft,pageTop:visualViewport.pageTop}:null}));
 const facts={phase,...native,renderer};windowReceipts.push(facts);return facts;
}
async function failureEvidence(error){
 const clean=value=>String(value||'').replaceAll(temporary||'\0','<fixture-temp>').replaceAll(root,'<checkout>').replace(/(?:\/Users\/|\/home\/|\/private\/|\/var\/)[^\s)\]}]+/g,'<path>');
 let activeDockEvidence=null,nativeState=null;
 if(application&&page&&!page.isClosed())try{await captureNativeWindowGeometry('failure:'+stage);}catch(geometryError){windowReceipts.push({phase:'failure:'+stage,geometryError:clean(geometryError.message)});}
 if(page&&!page.isClosed())try{activeDockEvidence=await page.evaluate(()=>{const observer=window.__dockViewportObserver;if(!observer)return null;observer.record('native-media-failure');return {snapshot:observer.snapshot(),events:observer.events,calls:observer.calls};});}catch{}
 if(page&&!page.isClosed())try{nativeState=await page.evaluate(()=>{const state=window.__coconutNativeMenuObservation;return state?{receipt:state.last,inputClicks:state.inputClicks,lastInput:state.lastInput}:null;});}catch{}
 const report={suite:'packaged-local-media',status:'failed',stage,message:clean(error.message),stack:clean(error.stack),checks,forbidden,pageErrors,dockReceipts,windowReceipts,activeDockEvidence,nativeCommands,nativeState,chooserEvents:chooserObservation?.count()??0};
 console.error(JSON.stringify(report));const directory=process.env.COCONUT_NATIVE_DIAGNOSTICS;if(!directory)return;
 await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'native-media-failure.json'),JSON.stringify(report,null,2));
 if(page&&!page.isClosed())await page.screenshot({path:path.join(directory,'native-media-failure.png'),timeout:5000}).catch(()=>{});
}
async function pasteProjectCaptionsAcceptance(audioPath){
 stage='native_project_paste_setup';const profile=path.join(temporary,'project-paste-profile');
 await launch(profile);await selectNative(audioPath);await optIn();
 await page.locator('#project-note').fill('Authored native pasted-caption project note');
 await page.locator('#audio-bookmark-time').fill('12.5');await page.locator('#audio-bookmark-note').fill('Authored native saved time bookmark');await page.locator('#audio-bookmark-form button[type=submit]').click();
 const original=await saved();await page.locator('#audio-bookmark-time').fill('29.125');await page.locator('#audio-bookmark-note').fill('Authored pending time bookmark');
 await page.locator('#source-media audio').evaluate(async player=>{const seeked=new Promise(resolve=>player.addEventListener('seeked',resolve,{once:true}));player.currentTime=25;await seeked;player.pause();window.__nativePasteBefore={player,attachment:browserMedia.get(active().key),time:player.currentTime};});
 await page.locator('#paste-project-subtitles').click();await expect(page.locator('#paste-subtitle-destination')).toContainText(original.title);
 await page.locator('#paste-subtitle-text').fill('00:01 Only a start');await page.locator('#preview-paste-subtitle').click();await expect(page.locator('#confirm-paste-subtitle')).toBeDisabled();
 await page.locator('#close-paste-subtitle').click();check('native_invalid_paste_close_preserves_project_and_draft',await page.evaluate(()=>active().segments.length===0&&document.getElementById('paste-subtitle-text').value==='00:01 Only a start'&&document.getElementById('audio-bookmark-note').value==='Authored pending time bookmark'));
 await page.locator('#paste-project-subtitles').click();await expect(page.locator('#confirm-paste-subtitle')).toBeDisabled();
 const captions='1\n00:00:01,125 --> 00:00:03,875\nNative authored first caption 你好\nSecond line\n\n2\n00:00:04,000 --> 00:00:05,250\nNative authored second caption';
 await page.locator('#paste-subtitle-text').fill(captions);await page.locator('#preview-paste-subtitle').click();await expect(page.locator('#paste-subtitle-preview li')).toHaveCount(2);await expect(page.locator('#confirm-paste-subtitle')).toHaveText('附加到此项目');
 check('native_caption_preview_leaves_original_project_unchanged',await page.evaluate(()=>active().segments.length===0&&state.documents.length===1));
 await page.locator('#confirm-paste-subtitle').click();await expect(page.locator('#paste-subtitle-dialog')).not.toBeVisible();
 const attached=await saved();check('native_paste_keeps_one_exact_project_and_annotations',attached.key===original.key&&attached.title===original.title&&attached.project_note===original.project_note&&JSON.stringify(attached.timestamp_bookmarks)===JSON.stringify(original.timestamp_bookmarks)&&attached.local_media_source.fingerprint===original.local_media_source.fingerprint&&attached.segments.length===2&&attached.segments[0].start===1.125&&attached.segments[0].end===3.875);
 check('native_paste_keeps_player_manual_clock_consent_and_bookmark_draft',await page.evaluate(()=>{const before=window.__nativePasteBefore,player=document.querySelector('#source-media audio');return state.documents.length===1&&player===before.player&&browserMedia.get(active().key)===before.attachment&&player.currentTime===before.time&&player.paused&&document.getElementById('remember-local-media-choice').checked&&document.getElementById('audio-bookmark-time').value==='29.125'&&document.getElementById('audio-bookmark-note').value==='Authored pending time bookmark';}));
 // Only this explicit timestamp click is allowed to seek/play after attachment.
 await page.locator('.segment .time button').first().click();await expect.poll(()=>page.locator('#source-media audio').evaluate(p=>p.currentTime>=1.125&&p.currentTime<3.875)).toBe(true);await page.locator('#source-media audio').evaluate(p=>p.pause());
 await page.locator('#cancel-audio-bookmark').click();await quit();await launch(profile);await decoded();
 check('native_pasted_project_restarts_with_same_reference_without_autoplay',await page.evaluate(key=>state.documents.length===1&&active().key===key&&active().segments.length===2&&!!browserMedia.get(active().key)?.nativeToken&&document.querySelector('#source-media audio').paused&&document.querySelector('#source-media audio').currentTime===0,original.key));
 await quit();
}
async function rememberedDockAcceptance(audioPath){
 stage='native_remembered_dock_setup';
 const profile=path.join(temporary,'dock-profile'),transcript=path.join(temporary,'dock-transcript.json');
 await fs.writeFile(transcript,JSON.stringify({title:'Authored remembered-media dock',segments:Array.from({length:90},(_,i)=>({id:'dock-'+i,start:i*.6,end:(i+1)*.6,text:'Authored original-file dock cue '+i+'. This sentence belongs only to this test.'}))}));
 await launch(profile);await selectNative(audioPath);await optIn();
 const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-project-transcript').click()]);
 check('dock_actual_transcript_picker',await chooser.element().getAttribute('id')==='project-transcript-file');await chooser.setFiles(transcript);
 await page.waitForFunction(()=>active()?.segments.length===90);await page.evaluate(()=>libraryStore.flush());await quit();await launch(profile);await decoded();
 check('dock_restored_native_player_starts_paused',await page.evaluate(()=>!!browserMedia.get(active().key)?.nativeToken&&document.querySelector('#source-media audio').paused&&document.querySelector('#source-media audio').currentTime===0));
 // Use a supported macOS window size. The separate unchanged browser suite
 // owns 390x480 coverage; do not defeat Electron's product minimum dimensions.
 stage='native_remembered_minimum_window_resize';await captureNativeWindowGeometry('before-minimum-window');
 await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(780,620));
 await captureNativeWindowGeometry('after-minimum-window-request');
 await page.waitForFunction(()=>innerWidth===780&&innerHeight===620);
 if(await page.locator('#episode-media').isVisible())await page.locator('#close-reader-media').click();await page.locator('#mode-transcript').click();await mediaPanel();
 const row=page.locator('.segment[data-segment-id="dock-65"]');await row.scrollIntoViewIfNeeded();await row.locator('.note-button').click();
 await page.locator('#note').fill('Authored remembered dock note');await page.evaluate(()=>libraryStore.flush());
 await page.locator('#source-media audio').evaluate(player=>{player.currentTime=player.duration;});
 await page.waitForFunction(()=>{const p=document.querySelector('#source-media audio');return !p.seeking&&p.ended&&p.paused&&document.getElementById('resume-listening').hidden;});
 stage='native_remembered_dock_wait_for_reachable_control';
 await expect(page.locator('#dock-rewind')).toBeVisible();await settleNativeDockLayout();await page.evaluate(installNativeMediaViewportProof);
 const minimum=await page.evaluate(()=>window.__nativeDockReadingView(window.__nativeDockSourceAnchor()));dockReceipts.push({stage:'remembered-minimum-note-controls',...minimum});
 check('native_remembered_minimum_window_note_close_and_dock_are_unobscured',minimum.viewport.width===780&&minimum.viewport.height===620&&noteControlsVisible(minimum));
 // A compact landscape layout keeps the original overlay/dock contract while
 // giving the toolbar room for one row. Fit one explicit plan to actual native
 // workArea + frame measurements; never force an offscreen/tall window or retry
 // sizes until source visibility happens to pass. Real preflight still decides.
 stage='native_remembered_reading_window_plan';
 const readingWindowPlan=planNativeMediaWindow(await captureNativeWindowGeometry('before-reading-window'));windowReceipts.push({phase:'reading-window-plan',...readingWindowPlan});
 check('native_remembered_reading_window_plan_fits_native_work_area',readingWindowPlan.admitted);
 stage='native_remembered_reading_window_resize';
 await application.evaluate(({BrowserWindow},bounds)=>BrowserWindow.getAllWindows()[0].setBounds(bounds,false),readingWindowPlan.bounds);
 await captureNativeWindowGeometry('after-reading-window-request');await settleNativeDockLayout();
 const windowProof=evaluateNativeMediaWindow(await captureNativeWindowGeometry('after-reading-window-settled'),readingWindowPlan);windowReceipts.push({phase:'reading-window-contract',...windowProof});
 check('native_remembered_reading_window_matches_measured_plan',Object.values(windowProof).every(value=>value===true));
 // Hold the existing adapter, then release an actual IndexedDB transaction.
 await page.evaluate(()=>{const adapter=CoconutStorageBootstrap.result.adapter,write=adapter.write.bind(adapter);window.__nativeDockWrites={pending:[],hold:true,completed:0};adapter.write=(...args)=>window.__nativeDockWrites.hold?new Promise((resolve,reject)=>window.__nativeDockWrites.pending.push(()=>write(...args).then(value=>{window.__nativeDockWrites.completed++;resolve(value);},reject))):write(...args);});
 await page.locator('#note').fill('Authored remembered dock note pending receipt');await page.locator('#note').evaluate(node=>node.setSelectionRange(3,12,'backward'));
 stage='native_remembered_dock_hold_note_receipt';
 await page.waitForFunction(()=>window.__nativeDockWrites.pending.length>0);
 await settleNativeDockLayout();
 const preparation=await page.evaluate(()=>window.__nativeDockReadingPreparation());dockReceipts.push({stage:'remembered-reading-preparation',...preparation});
 check('native_remembered_source_has_measured_unobscured_preparation_point',preparation.ready);
 await page.mouse.move(preparation.point.x,preparation.point.y);await page.mouse.wheel(0,preparation.wheelDelta);await settleNativeDockLayout();
 const preflight=await page.evaluate(()=>{window.__nativeDockPreparedAnchor=window.__nativeDockSourceAnchor();return window.__nativeDockReadingView(window.__nativeDockPreparedAnchor);});dockReceipts.push({stage:'remembered-reading-preflight',...preflight});
 check('native_remembered_source_and_note_are_really_visible_before_pointer',preflight.viewport.width===readingWindowPlan.content.width&&preflight.viewport.height===readingWindowPlan.content.height&&noteControlsVisible(preflight)&&nativeMediaAnchorIsStable(preflight.sourceAnchor));
 await page.evaluate(installDockViewportObserver,{readingAnchors:true});
 const point=await page.locator('#dock-rewind').evaluate(button=>{
  const r=button.getBoundingClientRect();button.addEventListener('pointerdown',event=>{
   const player=document.querySelector('#source-media audio'),note=document.getElementById('note'),status=document.getElementById('remember-local-media-status');
   window.__nativeDockBefore={trusted:event.isTrusted,anchor:window.__nativeDockPreparedAnchor,sourceAtPointer:window.__nativeDockCheckAnchor(window.__nativeDockPreparedAnchor),player,attachment:browserMedia.get(active().key),note,value:note.value,start:note.selectionStart,end:note.selectionEnd,direction:note.selectionDirection,status:status.firstChild,statusText:status.textContent,time:player.currentTime,paused:player.paused,rate:player.playbackRate,volume:player.volume,y:scrollY,top:document.querySelector('.segment.selected').getBoundingClientRect().top,header:document.getElementById('episode-media').getBoundingClientRect().height,headerBottom:document.getElementById('episode-media').getBoundingClientRect().bottom,headerHidden:document.getElementById('episode-media').hidden,resume:document.querySelector('.listening-progress').getBoundingClientRect().height};
  },{capture:true,once:true});button.addEventListener('click',event=>{window.__nativeDockTrustedClick=event.isTrusted;},{capture:true,once:true});return {x:r.x+r.width/2,y:r.y+r.height/2,reachable:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===button};
 });check('native_remembered_dock_pointer_is_reachable',point.reachable);await page.mouse.click(point.x,point.y);
 await page.waitForFunction(()=>{const p=document.querySelector('#source-media audio');return !p.seeking&&p.currentTime===50&&!document.getElementById('resume-listening').hidden;});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const receipt=await page.evaluate(()=>{
  const b=window.__nativeDockBefore,p=document.querySelector('#source-media audio'),n=document.getElementById('note'),status=document.getElementById('remember-local-media-status');
  const layout={scrollY,header:document.getElementById('episode-media').getBoundingClientRect().height,rowTop:document.querySelector('.segment.selected').getBoundingClientRect().top};window.__dockViewportObserver.record('remembered-after-rewind');
  return {layout,sourceAtPointer:b.sourceAtPointer,readingView:window.__nativeDockReadingView(b.anchor),trusted:b.trusted&&window.__nativeDockTrustedClick,sourceAnchor:window.__nativeDockCheckAnchor(b.anchor),headerIsReal:!b.headerHidden&&b.header>0&&b.resume>=44&&b.headerBottom<=0,playerSame:p===b.player,attachmentSame:browserMedia.get(active().key)===b.attachment,time:p.currentTime,paused:p.paused&&b.paused,rateSame:p.playbackRate===b.rate,volumeSame:p.volume===b.volume,scrollDelta:scrollY-b.y,rowDelta:document.querySelector('.segment.selected').getBoundingClientRect().top-b.top,headerDelta:document.getElementById('episode-media').getBoundingClientRect().height-b.header,resumeDelta:document.querySelector('.listening-progress').getBoundingClientRect().height-b.resume,resumeVisible:!document.getElementById('resume-listening').hidden,noteSame:n===b.note&&n.value===b.value&&n.selectionStart===b.start&&n.selectionEnd===b.end&&n.selectionDirection===b.direction,statusSame:status.firstChild===b.status&&status.textContent===b.statusText,focus:document.activeElement.id,inset:getComputedStyle(document.documentElement).scrollPaddingBottom,viewport:{width:innerWidth,height:innerHeight}};
 });dockReceipts.push({stage:'remembered-ended-rewind',...receipt});
 check('native_remembered_ended_rewind_keeps_visible_source_and_resume_row',receipt.readingView.viewport.width===readingWindowPlan.content.width&&receipt.readingView.viewport.height===readingWindowPlan.content.height&&receipt.trusted&&receipt.headerIsReal&&receipt.playerSame&&receipt.attachmentSame&&receipt.time===50&&receipt.paused&&receipt.rateSame&&receipt.volumeSame&&nativeMediaAnchorIsStable(receipt.sourceAtPointer)&&nativeMediaAnchorIsStable(receipt.sourceAnchor)&&noteControlsVisible(receipt.readingView)&&receipt.rowDelta===0&&receipt.resumeDelta===0&&receipt.resumeVisible&&receipt.noteSame&&receipt.statusSame&&receipt.focus==='dock-rewind');
 await releaseHeldNativeDockWrites();await page.evaluate(()=>libraryStore.flush());await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const savedReceipt=await page.evaluate(()=>{
  const b=window.__nativeDockBefore,n=document.getElementById('note'),status=document.getElementById('remember-local-media-status'),observer=window.__dockViewportObserver;observer.record('remembered-note-receipt');const evidence={events:observer.events,calls:observer.calls};observer.stop();
  return {layout:{scrollY,header:document.getElementById('episode-media').getBoundingClientRect().height,rowTop:document.querySelector('.segment.selected').getBoundingClientRect().top},readingView:window.__nativeDockReadingView(b.anchor),sourceAnchor:window.__nativeDockCheckAnchor(b.anchor),completed:window.__nativeDockWrites.completed,playerSame:document.querySelector('#source-media audio')===b.player,attachmentSame:browserMedia.get(active().key)===b.attachment,noteSame:n===b.note&&n.value===b.value&&n.selectionStart===b.start&&n.selectionEnd===b.end&&n.selectionDirection===b.direction,statusSame:status.firstChild===b.status&&status.textContent===b.statusText,scrollDelta:scrollY-b.y,rowDelta:document.querySelector('.segment.selected').getBoundingClientRect().top-b.top,headerDelta:document.getElementById('episode-media').getBoundingClientRect().height-b.header,focus:document.activeElement.id,evidence};
 });savedReceipt.saveOnlyDelta=nativeMediaPhaseDelta(savedReceipt.layout,receipt.layout);dockReceipts.push({stage:'remembered-note-receipt',postRewindBaseline:receipt.layout,...savedReceipt});
 check('native_remembered_note_receipt_keeps_exact_header_focus_and_viewport',savedReceipt.readingView.viewport.width===readingWindowPlan.content.width&&savedReceipt.readingView.viewport.height===readingWindowPlan.content.height&&savedReceipt.completed>0&&savedReceipt.playerSame&&savedReceipt.attachmentSame&&savedReceipt.noteSame&&savedReceipt.statusSame&&nativeMediaAnchorIsStable(savedReceipt.sourceAnchor)&&noteControlsVisible(savedReceipt.readingView)&&savedReceipt.rowDelta===0&&savedReceipt.saveOnlyDelta.headerDelta===0&&savedReceipt.saveOnlyDelta.scrollDelta===0&&savedReceipt.saveOnlyDelta.rowDelta===0&&savedReceipt.focus==='dock-rewind'&&savedReceipt.evidence.calls.every(call=>!['scrollTo','scrollBy','scrollIntoView'].includes(call.type)));
 check('native_remembered_note_has_real_saved_receipt',await page.evaluate(async()=>{const saved=(await readPersistedLibrary()).documents.find(doc=>doc.key===active().key);return saved.notes['dock-65']==='Authored remembered dock note pending receipt';}));
 await quit();
}

try{
 check('macos_required',process.platform==='darwin');version=JSON.parse(await fs.readFile(path.join(root,'desktop/package.json'),'utf8')).version;
 const archive=path.join(root,'desktop/dist',`Coconut-${version}-${process.arch}-unsigned.zip`);await fs.access(archive);
 temporary=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-native-media-'));const release=path.join(temporary,'release');await fs.mkdir(release);execFileSync('/usr/bin/ditto',['-x','-k',archive,release],{timeout:60000,stdio:'pipe'});
 executable=path.join(release,'Coconut.app/Contents/MacOS/Coconut');await fs.access(executable);
 const profile=path.join(temporary,'profile'),audioPath=path.join(temporary,'Original.wav'),bytes=authoredAudioFixture(60);await fs.writeFile(audioPath,bytes);
 await launch(profile);await selectNative(audioPath);await mediaPanel();check('unchecked_default',!await page.locator('#remember-local-media-choice').isChecked());
 await page.locator('#project-note').fill('Authored note survives reference failures');const initial=await saved();await quit();
 await launch(profile);await expectNoPlayer();check('default_off_restart_needs_selection',(await saved()).project_note===initial.project_note);await selectNative(audioPath,{existing:true});await optIn();
 await page.locator('#source-media audio').evaluate(async player=>{const seeked=new Promise(resolve=>player.addEventListener('seeked',resolve,{once:true}));player.currentTime=25;await seeked;player.pause();});
 await expect.poll(()=>page.evaluate(()=>{const key=state.active;return JSON.parse(localStorage.getItem('coconut-listening-v1:'+key)||'null')?.time;})).toBe(25);
 const before=await saved(),portable=JSON.stringify(before);check('portable_document_has_no_native_reference',!portable.includes(audioPath)&&!/nativeToken|file-candidate|blob:|local-media\.json/.test(portable));
 stage='export_project_backup';
 if(!await page.locator('#export-menu').evaluate(node=>node.open))await page.locator('#export-menu > summary').click();
 await expect(page.locator('#export')).toBeVisible();
 const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#export').click()]);const backup=path.join(temporary,'project.json');await download.saveAs(backup);check('portable_backup_exact',JSON.stringify(JSON.parse(await fs.readFile(backup,'utf8')))===portable);
 await quit();await launch(profile);await decoded();check('restored_paused_at_start',await page.locator('#source-media audio').evaluate(player=>player.paused&&player.currentTime===0));
 await mediaPanel();await expect(page.locator('#resume-listening')).toBeVisible();await page.locator('#resume-listening').click();await expect.poll(()=>page.locator('#source-media audio').evaluate(player=>!player.seeking&&Math.abs(player.currentTime-25)<0.01&&player.paused)).toBe(true);check('explicit_resume_only_seeks',true);
 await page.locator('#detach-reader-media').click();await expectNoPlayer();
 const [cancelledChooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-reader-media').click()]);await cancelledChooser.setFiles([]);
 await page.waitForFunction(()=>pendingMediaDocument===null&&rememberedMediaStates.get(active())?.suppressed===true);await expectNoPlayer();check('cancelled_reselection_keeps_explicit_session_detach',true);
 // Missing then moved-file recovery: same filename and metadata, explicit
 // selection and a new unchecked opt-in. No directory scanning or guessed path.
 await quit();const movedDirectory=path.join(temporary,'moved');await fs.mkdir(movedDirectory);const moved=path.join(movedDirectory,'Original.wav');await fs.rename(audioPath,moved);
 await launch(profile);await expect(page.locator('#remember-local-media-status')).toContainText('找不到');await expectNoPlayer();check('missing_preserves_notes',(await saved()).project_note===initial.project_note);
 await selectNative(moved,{existing:true});check('moved_selection_needs_fresh_opt_in',!await page.locator('#remember-local-media-choice').isChecked());await optIn();await quit();await launch(profile);await decoded();check('explicit_moved_file_recovery',true);
 // Replace the same path, size and mtime with another inode. Even identical
 // samples must not silently inherit the old reference.
 await quit();const original=path.join(movedDirectory,'original-retained.wav'),stat=await fs.stat(moved);await fs.rename(moved,original);await fs.writeFile(moved,bytes);await fs.utimes(moved,stat.atime,stat.mtime);
 await launch(profile);await expect(page.locator('#remember-local-media-status')).toContainText('已改变');await expectNoPlayer();check('same_path_replacement_rejected',(await saved()).project_note===initial.project_note);
 await fs.unlink(moved);await fs.rename(original,moved);await selectNative(moved,{existing:true});await optIn();await quit();await launch(profile);await decoded();await mediaPanel();
 await page.locator('.skip-link').focus();await page.keyboard.press('Enter');await page.waitForURL(origin+'/compatibility.html#main-content');
 const skipProof=await page.locator('#source-media audio').evaluate(async player=>{const response=await fetch(player.getAttribute('src'),{method:'HEAD',headers:{Range:'bytes=0-43'}});return response.status===206&&response.headers.get('content-length')==='44'&&player.paused;});
 check('skip_link_keeps_native_stream_token_and_paused_player',skipProof);
 await page.locator('#forget-local-media').evaluate(()=>{const player=document.querySelector('#source-media audio');window.__nativeForgetBefore={player,attachment:browserMedia.get(active().key),src:player.getAttribute('src'),paused:player.paused};});
 stage='forget_reference_keeps_current_native_stream';
 await page.locator('#forget-local-media').click();await expect(page.locator('#remember-local-media-status')).toContainText('不再记住');check('forget_keeps_selected_media',await page.locator('#source-media audio').count()===1);check('forget_never_deletes_original',(await fs.stat(moved)).size===bytes.length);
 const forgetProof=await page.locator('#source-media audio').evaluate(async player=>{const before=window.__nativeForgetBefore,response=await fetch(player.getAttribute('src'),{method:'HEAD',headers:{Range:'bytes=0-43'}});return {samePlayer:player===before.player,sameAttachment:browserMedia.get(active().key)===before.attachment,sameSource:player.getAttribute('src')===before.src,paused:before.paused&&player.paused,status:response.status,length:response.headers.get('content-length')};});
 check('forget_keeps_exact_paused_player_attachment_source_and_head_range',forgetProof.samePlayer&&forgetProof.sameAttachment&&forgetProof.sameSource&&forgetProof.paused&&forgetProof.status===206&&forgetProof.length==='44');
 await quit();await launch(profile);await expectNoPlayer();check('forget_persists_across_restart',true);await quit();
 // A backup in a fresh profile never grants the native file reference.
 await launch(path.join(temporary,'fresh-profile'));const [importChooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#import').click()]);await importChooser.setFiles(backup);await page.locator('#audio-project').waitFor({state:'visible'});await page.evaluate(()=>libraryStore.flush());await expectNoPlayer();check('fresh_profile_backup_has_no_native_consent',(await saved()).project_note===initial.project_note);
 await quit();await pasteProjectCaptionsAcceptance(moved);await rememberedDockAcceptance(moved);
 check('no_model_upload_or_external_request',forbidden===0);check('no_renderer_errors',pageErrors===0);await quit();
 console.log(JSON.stringify({suite:'packaged-local-media',status:'passed',architecture:process.arch,checks,dockReceipts,windowReceipts,nativeCommands,gatekeeper_verified:false}));
}catch(error){process.exitCode=1;await failureEvidence(error);}finally{
 // Release only this authored adapter gate after retaining the original failure.
 await releaseHeldNativeDockWrites().catch(()=>{});
 if(application){await application.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});}).catch(()=>{});await application.close().catch(()=>{});}
 chooserObservation?.dispose();
 if(temporary)await fs.rm(temporary,{recursive:true,force:true});
}
