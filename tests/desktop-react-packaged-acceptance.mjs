/** Actual unsigned macOS ZIP/default React entry. Authored PCM/text only.
 * Native MenuItem and preload/media are real. Only native dialog answers are
 * injected (keep editing); this does not establish signing/Gatekeeper trust.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {_electron as electron,expect} from '@playwright/test';
const root=fileURLToPath(new URL('../',import.meta.url)),origin='http://127.0.0.1:47831';
const checks=[],receipts=[],errors=[],blocked=[];
let app,page,temp,libraryIdentity,canonicalNativeOwnerVerified=false,stage='configuration',chooserCount=0,menuDiagnostics=null;
const output=process.env.COCONUT_NATIVE_DIAGNOSTICS;
process.umask(0o077);delete process.env.DEBUG;delete process.env.PWDEBUG;
function sanitizedFailure(error){
 const clean=value=>String(value||'').replaceAll(temp||'\0','<fixture-temp>').replaceAll(root,'<checkout>')
  .replace(/https?:\/\/[^\s)\]}]+/g,'<url>').replace(/file:\/\/[^\s)\]}]+/g,'<file-url>')
  .replace(/(?:\/Users\/|\/home\/|\/private\/|\/var\/)[^\s)\]}]+/g,'<path>')
  .replace(/(?:token|authorization|cookie|password|secret)\s*[:=]\s*\S+/gi,'<redacted>');
 return {message:clean(error.message).slice(0,4000),stack:clean(error.stack).slice(0,8000)};
}
const pass=name=>{checks.push(name);console.log('PASS '+name);};
function wav(){const b=Buffer.alloc(44+16000*10*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;}
const saved=()=>expect(page.locator('.app-header .save-indicator')).toHaveText('已保存');
async function screenshot(name){if(output){await fs.mkdir(output,{recursive:true});await page.screenshot({path:path.join(output,name),fullPage:true});}}
async function launch(executable,profile,version){
 stage='launch_actual_zip_default_react';
 await fs.mkdir(profile,{recursive:true});
 // Seed the existing production six-hour throttle in this isolated profile.
 // Browser routing cannot intercept the main process updater's node:https.
 // Do this before EVERY launch; no test-only production bypass is introduced.
 const updateDirectory=path.join(profile,'updates'),updateSettings={developer:false,lastCheck:Date.now()};await fs.mkdir(updateDirectory,{recursive:true});await fs.writeFile(path.join(updateDirectory,'settings.json'),JSON.stringify(updateSettings));assert.deepEqual(JSON.parse(await fs.readFile(path.join(updateDirectory,'settings.json'),'utf8')),updateSettings);
 const home=path.join(temp,'home');await fs.mkdir(home,{recursive:true});
 app=await electron.launch({executablePath:executable,args:['--user-data-dir='+profile],cwd:temp,acceptDownloads:true,chromiumSandbox:true,bypassCSP:false,timeout:45000,env:{HOME:home,TMPDIR:temp,PATH:'/usr/bin:/bin',LANG:process.env.LANG||'en_US.UTF-8'}});
 const facts=await app.evaluate(({app,BrowserWindow})=>({packaged:app.isPackaged,version:app.getVersion(),profile:app.getPath('userData'),asar:app.getAppPath().endsWith('/app.asar'),preferences:BrowserWindow.getAllWindows()[0]?.webContents.getLastWebPreferences()}));
 assert.equal(facts.packaged,true);assert.equal(facts.asar,true);assert.equal(facts.version,version);assert.equal(await fs.realpath(facts.profile),await fs.realpath(profile));
 await app.context().route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(['blob:','data:'].includes(url.protocol)||(url.origin===origin&&['GET','HEAD'].includes(request.method())&&url.pathname!=='/api/language-tools')||(url.origin===origin&&request.method()==='POST'&&url.pathname==='/api/v1/library/batch'))return route.continue();blocked.push({method:request.method(),path:url.origin===origin?url.pathname:'external'});return route.abort();});
 page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(sanitizedFailure(e)));page.on('filechooser',()=>chooserCount++);
 await page.waitForURL(url=>url.origin===origin&&url.pathname==='/');await expect(page.locator('.react-app')).toBeVisible();
 assert.equal(await page.locator('script[src="app.js"],.shell,#transcript').count(),0);
 await page.waitForFunction(()=>window.CoconutReactDesktopReady===true&&typeof window.coconutFileCommand==='function'&&typeof window.coconutPrepareClose==='function');
 const security=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());assert.equal(security.sandbox,true);assert.equal(security.contextIsolation,true);assert.equal(security.nodeIntegration,false);assert.equal(security.webSecurity,true);assert.equal(await page.evaluate(()=>typeof require==='undefined'&&typeof process==='undefined'),true);
 menuDiagnostics=null;
 try{
  await expect.poll(()=>app.evaluate(({Menu})=>['open-local-media','import-transcript','backup-library'].every(id=>Menu.getApplicationMenu()?.getMenuItemById(id)?.enabled))).toBe(true);
 }catch(error){
  // Diagnostic booleans and allowlisted route only: never persist a native path or URL.
  menuDiagnostics=await app.evaluate(({Menu,BrowserWindow},expectedOrigin)=>{
   const window=BrowserWindow.getAllWindows()[0],contents=window?.webContents;
   let trustedOrigin=false,pathname='other';try{const url=new URL(contents?.getURL());trustedOrigin=url.origin===expectedOrigin;if(trustedOrigin&&['/','/index.html'].includes(url.pathname))pathname=url.pathname;}catch{}
   return {menus:Object.fromEntries(['open-local-media','import-transcript','backup-library'].map(id=>[id,Menu.getApplicationMenu()?.getMenuItemById(id)?.enabled??null])),trustedOrigin,pathname,loadingMainFrame:contents?.isLoadingMainFrame()??null,focusedWindow:BrowserWindow.getFocusedWindow()===window,windowDestroyed:window?.isDestroyed()??null};
  },origin).catch(error=>({diagnosticFailure:sanitizedFailure(error)}));
  menuDiagnostics.renderer=await page.evaluate(()=>({ready:window.CoconutReactDesktopReady===true,fileCommand:typeof window.coconutFileCommand==='function',closeHook:typeof window.coconutPrepareClose==='function',documentReady:document.readyState,focused:document.hasFocus()})).catch(error=>({diagnosticFailure:sanitizedFailure(error)}));
  throw error;
 }
 // Observe, never replace, the real synchronous renderer command and chooser.
 await page.evaluate(()=>{const original=window.coconutFileCommand;window.authoredMenu={sequence:0,last:null,inputs:[]};document.addEventListener('click',event=>{if(event.target instanceof HTMLInputElement&&event.target.type==='file')window.authoredMenu.inputs.push({activation:navigator.userActivation.isActive,accept:event.target.accept});},true);window.coconutFileCommand=function(command,request){const activation=navigator.userActivation.isActive;const result=original.apply(this,arguments);window.authoredMenu.last={sequence:++window.authoredMenu.sequence,command,result,type:typeof result,activation,afterActivation:navigator.userActivation.isActive,current:request.issuedAt>=performance.timeOrigin,unexpired:request.expiresAt>Date.now()};return result;};});
 const library=await fetch(origin+'/api/v1/library').then(response=>response.json());assert.equal(library.enabled,true);assert.equal(library.backend,'sqlite');assert.ok(library.binding?.mediaLibraryIdentity);
 const identity={epoch:library.epoch,mediaLibraryIdentity:library.binding.mediaLibraryIdentity};if(libraryIdentity)assert.deepEqual(identity,libraryIdentity);else{assert.equal(library.sequence,0);libraryIdentity=identity;}
 assert.equal((await fs.readFile(path.join(profile,'library','library.sqlite'))).subarray(0,16).toString(),'SQLite format 3\0');
 await expect(page.locator('#app-updates')).toBeAttached();assert.equal(await page.getByRole('button',{name:/^下载 .*|安装并重启$/}).count(),0);
 pass('Packaged ASAR default / mounts React with production sandbox and native ready menu');
}
async function menu(id){
 const before=await page.evaluate(()=>window.authoredMenu.sequence);
 await app.evaluate(({Menu,BrowserWindow},id)=>{const item=Menu.getApplicationMenu().getMenuItemById(id),window=BrowserWindow.getAllWindows()[0];if(!item?.enabled)throw Error('Menu disabled');item.click(item,window,{});},id);
 await page.waitForFunction(({before,id})=>window.authoredMenu.last?.sequence>before&&window.authoredMenu.last.command===id,{before,id});
 const receipt=await page.evaluate(()=>window.authoredMenu.last);receipts.push(receipt);assert.equal(receipt.type,'boolean');assert.equal(receipt.current,true);assert.equal(receipt.unexpired,true);return receipt.result;
}
async function backup(){const wait=page.waitForEvent('download');assert.equal(await menu('backup-library'),true);const download=await wait;assert.equal(await download.failure(),null);const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
async function close(){stage='clean_native_quit';const closed=app.waitForEvent('close');await app.evaluate(({app})=>{app.quit();});await closed;app=null;await expect.poll(async()=>{try{await fetch(origin+'/api/health',{signal:AbortSignal.timeout(300)});return false;}catch{return true;}},{timeout:10000}).toBe(true);pass('Actual native quit stops the packaged bridge');}
try{
 assert.equal(process.platform,'darwin');const configuration=JSON.parse(await fs.readFile(path.join(root,'desktop/package.json'),'utf8'));
 const archive=path.join(root,'desktop/dist',`Coconut-${configuration.version}-${process.arch}-unsigned.zip`);assert.ok((await fs.stat(archive)).size>0);
 temp=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-react-packaged-'));const release=path.join(temp,'release');await fs.mkdir(release);execFileSync('/usr/bin/ditto',['-x','-k',archive,release],{timeout:60000,stdio:'pipe'});
 const executable=path.join(release,'Coconut.app/Contents/MacOS/Coconut'),profile=path.join(temp,'profile'),audio=path.join(temp,'authored-react.wav');await fs.writeFile(audio,wav());
 await launch(executable,profile,configuration.version);await expect(page.getByRole('heading',{name:'今天，想听什么？'})).toBeVisible();await screenshot('react-packaged-home.png');
 stage='real_native_raw_chooser';const chooserPromise=page.waitForEvent('filechooser');assert.equal(await menu('open-local-media'),true);const chooser=await chooserPromise;const picking=await page.evaluate(()=>window.coconutPrepareClose('inspect'));assert.equal(picking.safe,false);assert.equal(picking.flushable,false);assert.equal(await page.evaluate(()=>window.coconutPrepareUpdate()),false);assert.equal(await menu('open-local-media'),false);await chooser.setFiles(audio);
 await expect(page.getByRole('heading',{name:'authored-react.wav',exact:true})).toBeVisible();await saved();await page.waitForFunction(()=>{const media=document.querySelector('audio');return media&&!media.error&&media.readyState>=2&&Math.abs(media.duration-10)<.1;});assert.equal(await page.locator('audio').evaluate(p=>p.paused),true);assert.equal(await page.locator('.rw-cue').count(),0);
 const input=await page.evaluate(()=>window.authoredMenu.inputs.at(-1));assert.equal(input.activation,true);assert.equal(input.accept,'audio/*,video/*');assert.equal(receipts.find(receipt=>receipt.command==='open-local-media'&&receipt.result===true).activation,true);assert.equal(chooserCount,1);pass('Real native menu preserves user gesture into authored raw-media chooser without inference/autoplay');
 const note=page.getByRole('textbox',{name:'项目笔记',exact:true}),projectNote=page.locator('.rw-project-note');
 await expect(projectNote).not.toHaveAttribute('open');await expect(note).not.toBeVisible();await projectNote.locator('summary').click();await expect(projectNote).toHaveAttribute('open');await expect(note).toBeVisible();
 await note.fill('Authored durable packaged React note');await page.getByRole('button',{name:'保存笔记',exact:true}).click();await saved();
 // The controlled checkbox commits only after the actual asynchronous native receipt.
 const remember=page.getByRole('checkbox',{name:'在这台电脑记住原文件',exact:true});await expect(remember).not.toBeChecked();await remember.click();await expect(remember).toBeChecked();await expect(page.getByText(/已在这台电脑记住原文件/)).toBeVisible();
 const portable=await backup();assert.equal(portable.documents.length,1);const doc=portable.documents[0];assert.equal(doc.project_kind,'audio_only');assert.equal(doc.project_note,'Authored durable packaged React note');assert.equal(doc.segments.length,0);assert.equal(doc.ai_answers?.length||0,0);assert.ok(!JSON.stringify(portable).includes(temp));assert.ok(!JSON.stringify(portable).includes('/api/local-media/'));
 // Inspect the durable native receipt without including private file fields in diagnostics.
 const nativeManifest=JSON.parse(await fs.readFile(path.join(profile,'local-media.json'),'utf8'));
 const canonicalRecord=await fetch(origin+'/api/v1/library/document?'+new URLSearchParams({protocolVersion:'1',key:doc.key})).then(response=>response.json());
 const nativeOwner=nativeManifest.records?.find(record=>record.owner?.key===doc.key)?.owner;
 canonicalNativeOwnerVerified=nativeManifest.version===1&&nativeManifest.records.length===1&&!!nativeOwner&&nativeOwner.library===libraryIdentity.mediaLibraryIdentity&&nativeOwner.epoch===canonicalRecord.record?.identity?.lifetime&&Number.isSafeInteger(nativeOwner.epoch)&&nativeOwner.epoch>0;
 assert.equal(canonicalNativeOwnerVerified,true,'Remembered native owner must match the canonical library binding and durable document lifetime');
 await screenshot('react-packaged-reading.png');pass('React notes persist with native file ownership and actual portable JSON download');
 stage='dirty_native_close_and_menu_guard';await note.fill('Unsaved authored draft must survive cancel');assert.equal(await page.evaluate(()=>window.coconutPrepareClose('inspect').safe),false);assert.equal(await page.evaluate(()=>window.coconutPrepareUpdate()),false);
 const beforeChooser=chooserCount;assert.equal(await menu('open-local-media'),false);assert.equal(await menu('import-transcript'),false);assert.equal(chooserCount,beforeChooser);await expect(note).toHaveValue('Unsaved authored draft must survive cancel');
 await app.evaluate(({dialog})=>{globalThis.authoredClose={dialogs:[]};dialog.showMessageBox=async(_window,options)=>{globalThis.authoredClose.dialogs.push({title:options.title,buttons:options.buttons,defaultId:options.defaultId,cancelId:options.cancelId});return {response:0};};});
 for(const kind of ['window','quit']){const before=await app.evaluate(()=>globalThis.authoredClose.dialogs.length);await app.evaluate(({app,BrowserWindow},kind)=>{if(kind==='window')BrowserWindow.getAllWindows()[0].close();else app.quit();},kind);await expect.poll(()=>app.evaluate(()=>globalThis.authoredClose.dialogs.length)).toBe(before+1);const prompt=await app.evaluate(()=>globalThis.authoredClose.dialogs.at(-1));assert.equal(prompt.title,'关闭 Coconut？');assert.equal(prompt.buttons[0],'继续编辑');assert.equal(prompt.defaultId,0);assert.equal(prompt.cancelId,0);await expect(note).toHaveValue('Unsaved authored draft must survive cancel');assert.equal(page.isClosed(),false);assert.equal((await fetch(origin+'/api/health')).ok,true);}
 pass('Actual window/app close handlers preserve draft with authored keep-editing native dialog responses');
 await page.getByRole('button',{name:'保存笔记',exact:true}).click();await saved();const expected=(await backup()).documents;const stored=await fetch(origin+'/api/v1/library/document?'+new URLSearchParams({protocolVersion:'1',key:expected[0].key})).then(response=>response.json());assert.deepEqual(stored.record.document,expected[0]);assert.equal(stored.record.identity.lifetime,1);assert.equal(expected[0].project_note,'Unsaved authored draft must survive cancel');await close();
 await launch(executable,profile,configuration.version);await page.getByRole('button',{name:'继续阅读',exact:true}).click();await expect(page.locator('.rw-project-note')).toHaveAttribute('open');await expect(page.getByRole('textbox',{name:'项目笔记',exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:'项目笔记',exact:true})).toHaveValue(expected[0].project_note);await expect(page.getByText(/已载入本机原文件，未自动播放/)).toBeVisible();await page.waitForFunction(()=>{const p=document.querySelector('audio');return p&&!p.error&&p.readyState>=2;});assert.equal(await page.locator('audio').evaluate(p=>p.paused),true);assert.deepEqual((await backup()).documents,expected);pass('Actual packaged restart restores identical document and remembered original without autoplay');
 await page.getByRole('button',{name:'不再记住',exact:true}).click();await expect(page.getByText(/已不再记住原文件/)).toBeVisible();assert.equal(await page.locator('audio').count(),1);
 stage='native_srt_chooser_review_and_find';const transcript=path.join(temp,'authored-react.srt');await fs.writeFile(transcript,'1\n00:00:00,000 --> 00:00:02,000\nAuthored packaged menu transcript.\n');const subtitleChooser=page.waitForEvent('filechooser');assert.equal(await menu('import-transcript'),true);const pickedSubtitle=await subtitleChooser;await pickedSubtitle.setFiles(transcript);const review=page.getByRole('checkbox',{name:'我已核对文字、编码和诊断，确认加入',exact:true});await expect(review).not.toBeChecked();const add=page.getByRole('button',{name:'加入已核对的字幕',exact:true});await expect(add).toBeDisabled();await review.check();await add.click();await expect(page.locator('.rw-original')).toHaveText('Authored packaged menu transcript.');await saved();assert.equal(await page.evaluate(()=>window.authoredMenu.inputs.at(-1).activation),true);
 await page.locator('.rw-original').focus();assert.equal(await menu('find-transcript'),true);await expect(page.getByRole('searchbox',{name:'搜索原话、译文和笔记',exact:true})).toBeFocused();const afterTranscript=(await backup()).documents;assert.equal(afterTranscript.length,2);assert.deepEqual(afterTranscript.find(item=>item.key===expected[0].key),expected[0]);pass('Actual native transcript chooser requires review and Edit Find focuses React search without changing raw project');
 await close();assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 if(output)await fs.writeFile(path.join(output,'react-packaged-report.json'),JSON.stringify({status:'passed',canonicalNativeOwnerVerified,checks,receipts,boundaries:['actual packaged macOS ZIP','authored local media only','native keep-editing dialog answers injected','no signing/Gatekeeper/update download proof'],errors,blocked},null,2));
}catch(error){if(output){await fs.mkdir(output,{recursive:true});await screenshot('react-packaged-failure.png').catch(()=>{});const failure=sanitizedFailure(error);await fs.writeFile(path.join(output,'react-packaged-report.json'),JSON.stringify({status:'failed',canonicalNativeOwnerVerified,stage,...failure,menuDiagnostics,checks,receipts,errors,blocked},null,2));}throw error;}
finally{if(app){await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});}).catch(()=>{});await app.close().catch(()=>{});}if(temp)await fs.rm(temp,{recursive:true,force:true});}
