/**
 * Operate the exact native-architecture macOS ZIP, not the source Electron app.
 * Authored text and PCM audio only. No CLI detection, accounts, models, downloads
 * from publishers, or application security overrides. Profiles/exports stay
 * temporary; this is runtime acceptance, not Gatekeeper/signing acceptance.
 */
import assert from 'node:assert/strict';
import {openCueActions} from './cue-actions-browser.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {_electron as electron} from '@playwright/test';

const root=fileURLToPath(new URL('../',import.meta.url));
const origin='http://127.0.0.1:47831';
const checks=[];
let temporary,application,stage='configuration',pageErrors=0,forbiddenRequests=0;
process.umask(0o077);
delete process.env.DEBUG;
delete process.env.PWDEBUG;
function check(name,value){stage=name;assert.ok(value,name);checks.push(name);}

// A complete 10-second mono PCM WAV needs no encoder, network or model.
function authoredAudio(){
 const samples=16000*10,bytes=Buffer.alloc(44+samples*2);
 bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
 bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
 bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);
 bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);
 for(let index=0;index<samples;index++)bytes.writeInt16LE(Math.round(2000*Math.sin(2*Math.PI*440*index/16000)),44+index*2);
 return bytes;
}

async function launch(executable,profile,version,label){
 stage=label+'_launch';
 await fs.mkdir(profile,{recursive:true});
 const home=path.join(temporary,'home');await fs.mkdir(home,{recursive:true});
 application=await electron.launch({executablePath:executable,args:['--user-data-dir='+profile],
  cwd:temporary,acceptDownloads:true,chromiumSandbox:true,bypassCSP:false,timeout:45000,
  env:{HOME:home,TMPDIR:temporary,PATH:'/usr/bin:/bin',LANG:process.env.LANG||'en_US.UTF-8'}});
 const facts=await application.evaluate(({app})=>({packaged:app.isPackaged,version:app.getVersion(),
  userData:app.getPath('userData'),appPath:app.getAppPath()}));
 check(label+'_runs_packaged_asar',facts.packaged&&facts.appPath.endsWith('/app.asar')&&facts.version===version);
 check(label+'_isolated_profile',await fs.realpath(facts.userData)===await fs.realpath(profile));
 const context=application.context();
 // Any unintended model/status/upload/external request is a failing test,
 // blocked before it could touch an account or send the authored content.
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(['blob:','data:'].includes(url.protocol)||(url.origin===origin&&['GET','HEAD'].includes(request.method())&&url.pathname!=='/api/language-tools'))await route.continue();
  else{forbiddenRequests++;await route.abort();}
 });
 const page=await application.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',()=>pageErrors++);
 await page.waitForURL(origin+'/');await page.locator('#import').waitFor({state:'attached'});
 await page.waitForFunction(()=>document.getElementById('worker-status').textContent.includes('轻量本地服务已连接'));
 const preferences=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
 check(label+'_production_renderer_security',preferences.sandbox===true&&preferences.contextIsolation===true&&preferences.nodeIntegration===false&&preferences.webSecurity===true);
 check(label+'_renderer_has_no_node',await page.evaluate(()=>typeof require==='undefined'&&typeof process==='undefined'));
 check(label+'_original_brand_asset_loads',await page.locator('.brand-mark').evaluate(img=>img.complete&&img.naturalWidth>0));
 return page;
}

async function close(){
 if(!application)return;
 stage='quit_packaged_app';await application.close();application=null;
 // A closed app must not leave a background bridge serving the old bookshelf.
 let stillRunning=true;const deadline=Date.now()+5000;
 while(stillRunning&&Date.now()<deadline){
  try{await fetch(origin+'/api/health',{signal:AbortSignal.timeout(300)});await new Promise(resolve=>setTimeout(resolve,100));}
  catch{stillRunning=false;}
 }
 check('app_quit_stops_bridge',!stillRunning);
}

async function stored(page){return page.evaluate(()=>{
 const shelf=JSON.parse(localStorage.getItem('coconut-reader-v1')||'null');
 return shelf?.documents.find(doc=>doc.key===shelf.active)||null;
});}
async function importFile(page,filename){
 stage='file_chooser_import';await page.locator('#add-content').click();
 const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#import').click()]);await chooser.setFiles(filename);
 await page.locator('#reader-workspace').waitFor({state:'visible'});
 await page.waitForFunction(()=>document.getElementById('file').value==='');
}
const row=(page,id)=>page.locator('.segment[data-segment-id="'+id+'"]');
async function download(page,button,filename){
 stage='export_'+filename;
 if(!await page.locator('#export-menu').evaluate(node=>node.open))await page.locator('#export-menu > summary').click();
 const [artifact]=await Promise.all([page.waitForEvent('download'),page.locator(button).click()]);
 const destination=path.join(temporary,filename);await artifact.saveAs(destination);
 check('saved_'+filename,await artifact.failure()===null&&(await fs.stat(destination)).size>0);
 return destination;
}
async function verifyRestored(page,expected,label){
 await page.locator('#reader-workspace').waitFor({state:'visible'});
 check(label+'_complete_document',isDeepStrictEqual(await stored(page),expected));
 check(label+'_honest_empty_summary',await page.locator('#summary-state').textContent()==='未生成');
 await page.locator('#mode-transcript').click();
 check(label+'_media_needs_reselection',await page.locator('#source-media audio,#source-media video').count()===0);
 await page.locator('#resume').click();check(label+'_resume_bookmark',await row(page,'last').locator('.bookmark-button').getAttribute('aria-pressed')==='true');
 await row(page,'middle').locator('.note-button').click();check(label+'_note_ui',await page.locator('#note').inputValue()===expected.notes.middle);
 await page.locator('#close-note').click();
 check(label+'_corrected_words',await row(page,'middle').locator('.words').textContent()===expected.segments[1].text);
 stage=label+'_restore_original';await openCueActions(row(page,'middle'));
 await row(page,'middle').locator('.edit-button').click();await page.locator('#restore-edit').click();
 check(label+'_original_retained',await page.locator('#edit-segment').inputValue()===expected.segments[1].original_text);
 await page.locator('#edit-dialog button[value="cancel"]').click();
 check(label+'_cancel_does_not_change_document',isDeepStrictEqual(await stored(page),expected));
}
async function verifyAudioRestored(page,expected,label){
 await page.locator('#audio-project').waitFor({state:'visible'});
 check(label+'_complete_audio_project',isDeepStrictEqual(await stored(page),expected));
 check(label+'_audio_note_ui',await page.locator('#project-note').inputValue()===expected.project_note);
 check(label+'_timestamp_bookmark_ui',await page.locator('#audio-bookmarks textarea').inputValue()===expected.timestamp_bookmarks[0].note);
 check(label+'_no_fabricated_transcript_or_summary',expected.segments.length===0&&expected.ai_answers.length===0&&await page.locator('#summary-workspace').isHidden()&&await page.locator('#language-panel').isHidden()&&await page.locator('#export-subtitles').isDisabled());
 check(label+'_audio_media_needs_reselection',await page.locator('#source-media audio,#source-media video').count()===0);
 await page.locator('#audio-bookmarks button').first().click();
 check(label+'_bookmark_requires_explicit_media',(await page.locator('#audio-project-status').textContent()).includes('先单独获取原声'));
 check(label+'_bookmark_does_not_change_saved_project',isDeepStrictEqual(await stored(page),expected));
}

try{
 check('native_macos_required',process.platform==='darwin');
 const configuration=JSON.parse(await fs.readFile(path.join(root,'desktop/package.json'),'utf8'));
 const archive=path.join(root,'desktop/dist',`Coconut-${configuration.version}-${process.arch}-unsigned.zip`);
 check('native_release_zip_exists',(await fs.stat(archive)).size>0);
 temporary=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-packaged-acceptance-'));
 const extracted=path.join(temporary,'release');await fs.mkdir(extracted);
 execFileSync('/usr/bin/ditto',['-x','-k',archive,extracted],{timeout:60000,stdio:'pipe'});
 const executable=path.join(extracted,'Coconut.app/Contents/MacOS/Coconut');await fs.access(executable);
 const fixture={schema_version:1,title:'Packaged Coconut authored acceptance',language:'en',source_url:'',
  provenance:{kind:'imported_subtitles',caption_method:'unknown',review_status:'unreviewed'},
  segments:[{id:'first',start:0.25,end:2.5,text:'These are original acceptance words.'},
   {id:'middle',start:3,end:5.5,text:'Keep the original before correcting this sentence.'},
   {id:'last',start:6,end:8.5,text:'Resume this authored passage after reopening.'}]};
 const fixturePath=path.join(temporary,'authored.json'),audioPath=path.join(temporary,'authored.wav');
 await fs.writeFile(fixturePath,JSON.stringify(fixture));await fs.writeFile(audioPath,authoredAudio());
 const profile=path.join(temporary,'profile');let page=await launch(executable,profile,configuration.version,'first_launch');
 check('new_profile_empty',await stored(page)===null);
 check('packaged_public_caption_capability',await page.evaluate(async()=>{const health=await(await fetch('api/health')).json();return health.capabilities.caption_import===true&&health.capabilities.media_import===false;}));
 check('asr_ui_not_offered',await page.locator('#advanced-import-options').isHidden()&&await page.locator('#import-media').isDisabled());
 await importFile(page,fixturePath);
 check('all_authored_segments_imported',(await stored(page)).segments.length===3);
 check('local_subtitles_do_not_claim_manual_verification',(await stored(page)).provenance.caption_method==='unknown'&&(await stored(page)).provenance.review_status==='unreviewed'&&(await page.locator('#provenance').textContent()).includes('导入的字幕'));
 check('summary_stays_uncreated',await page.locator('#summary-state').textContent()==='未生成');
 await page.locator('#prepare-summary').click();
 check('ai_remains_unverified_without_cli_probe',(await page.locator('#ai-status').textContent()).includes('点击')&&await page.locator('#ask-ai').isDisabled()&&!await page.locator('#ai-consent').isChecked());
 check('no_silent_inference',!(await stored(page)).ai_answers?.length);
 await page.locator('#mode-transcript').click();
 if(!await page.locator('#attach-reader-media').isVisible())await page.locator('#toggle-reader-media').click();
 const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-reader-media').click()]);await chooser.setFiles(audioPath);
 await page.waitForFunction(()=>{const media=document.querySelector('#source-media audio');return media&&!media.error&&media.readyState>=2&&media.duration>9;});
 check('packaged_audio_decodes',await page.locator('#source-media audio').evaluate(media=>Math.abs(media.duration-10)<0.1));
 await row(page,'middle').locator('.time > button').first().click();
 await page.waitForFunction(()=>{const media=document.querySelector('#source-media audio');return !media.paused&&media.currentTime>3.1&&media.currentTime<5.5&&document.querySelector('.segment[data-segment-id="middle"]').classList.contains('playing');});
 check('timestamp_seeks_and_plays',true);
 check('playback_highlights_original',await row(page,'middle').evaluate(node=>node.classList.contains('playing')));
 await page.locator('#source-media audio').evaluate(media=>media.pause());
 await page.locator('#playback-rate').selectOption('1.5');
 await row(page,'middle').locator('.note-button').click();await page.locator('#note').fill('A note that must survive closing the packaged app');await page.locator('#close-note').click();
 stage='correct_source_from_cue_actions';await openCueActions(row(page,'middle'));
 await row(page,'middle').locator('.edit-button').click();await page.locator('#edit-segment').fill('The corrected authored acceptance sentence');await page.locator('#save-edit').click();
 stage='save_excerpt_from_cue_actions';await openCueActions(row(page,'first'));
 await row(page,'first').locator('.excerpt-button').click();
 stage='bookmark_from_cue_actions';await openCueActions(row(page,'last'));
 await row(page,'last').locator('.bookmark-button').click();
 const expected=await stored(page);
 check('original_and_note_saved',expected.segments[1].original_text===fixture.segments[1].text&&expected.notes.middle&&expected.readingPosition==='last'&&expected.segments[0].saved_excerpt===true);
 check('transient_media_not_persisted',!JSON.stringify(expected).includes('blob:'));
 // A real file-import failure and user retry must leave prior work intact.
 stage='malformed_file_recovery';const malformed=path.join(temporary,'malformed.json');await fs.writeFile(malformed,'{"segments":');
 await page.locator('#add-content').click();
 const [failedChooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#import').click()]);await failedChooser.setFiles(malformed);
 await page.waitForFunction(()=>document.getElementById('notice').textContent.startsWith('导入失败：'));
 check('failed_import_preserves_book',isDeepStrictEqual(await stored(page),expected));
 await importFile(page,fixturePath);
 check('retry_original_import_keeps_existing_edits',isDeepStrictEqual(await stored(page),expected)&&await page.evaluate(()=>JSON.parse(localStorage.getItem('coconut-reader-v1')).documents.length)===1);
 await page.locator('#mode-transcript').click();
 const backup=await download(page,'#export','backup.json');
 check('json_disk_bytes_match_saved_document',isDeepStrictEqual(JSON.parse(await fs.readFile(backup,'utf8')),expected));
 for(const format of ['srt','vtt']){
  await page.locator('#subtitle-format').selectOption(format);
  const filename=await download(page,'#export-subtitles','captions.'+format),text=await fs.readFile(filename,'utf8');
  check(format+'_disk_contains_all_cues',(text.match(/ --> /g)||[]).length===3&&expected.segments.every(cue=>text.includes(cue.text))&&!text.includes(expected.notes.middle));
  check(format+'_retains_millisecond_times',text.includes(format==='srt'?'00:00:00,250 --> 00:00:02,500':'00:00:00.250 --> 00:00:02.500'));
 }
 const notebook=await download(page,'#export-notebook','notebook.md'),markdown=await fs.readFile(notebook,'utf8');
 check('markdown_disk_contains_original_edit_and_note',markdown.includes(expected.notes.middle)&&markdown.includes(expected.segments[1].text)&&markdown.includes(fixture.segments[1].text.replaceAll('.','\\.')));
 // An authored public-source reference is metadata only. The request guard above
 // forbids fetching it; playback uses the same local PCM fixture and no network.
 const audioFixture={schema_version:1,project_kind:'audio_only',transcript_status:'not_imported',
  title:'Packaged authored audio project',source_url:'https://publisher.example/native-acceptance',
  podcast_source:{kind:'direct_media',media_url:'https://publisher.example/native-authored.wav',media_kind:'audio'},
  media_duration:10,segments:[]};
 const audioFixturePath=path.join(temporary,'audio-project-fixture.json');await fs.writeFile(audioFixturePath,JSON.stringify(audioFixture));
 await importFile(page,audioFixturePath);await page.locator('#audio-project').waitFor({state:'visible'});
 check('packaged_audio_project_import_preserves_transcript_shelf',await page.evaluate(()=>JSON.parse(localStorage.getItem('coconut-reader-v1')).documents.length)===2);
 check('packaged_audio_source_is_metadata_only',(await stored(page)).podcast_source.media_url===audioFixture.podcast_source.media_url&&await page.locator('#source-media audio').count()===0&&forbiddenRequests===0);
 await page.locator('#project-note').fill('Native project note survives app restart');
 if(!await page.locator('#attach-reader-media').isVisible())await page.locator('#toggle-reader-media').click();
 const [audioChooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-reader-media').click()]);await audioChooser.setFiles(audioPath);
 await page.waitForFunction(()=>{const media=document.querySelector('#source-media audio');return media&&!media.error&&media.readyState>=2&&media.duration>9;});
 await page.locator('#source-media audio').evaluate(media=>{media.pause();media.currentTime=4.25;});
 await page.locator('#use-playback-time').click();await page.locator('#audio-bookmark-note').fill('Check this authored audio moment');await page.locator('#audio-bookmark-form button[type=submit]').click();
 const audioExpected=await stored(page);
 check('packaged_audio_note_and_timestamp_saved',audioExpected.project_note==='Native project note survives app restart'&&audioExpected.timestamp_bookmarks.length===1&&audioExpected.timestamp_bookmarks[0].time===4.25&&audioExpected.timestamp_bookmarks[0].note==='Check this authored audio moment');
 check('packaged_audio_has_no_inferred_content_or_blob',audioExpected.segments.length===0&&audioExpected.ai_answers.length===0&&!JSON.stringify(audioExpected).includes('blob:'));
 await page.locator('#source-media audio').evaluate(media=>{media.currentTime=0;});await page.locator('#audio-bookmarks button').first().click();
 await page.waitForFunction(()=>{const media=document.querySelector('#source-media audio');return !media.seeking&&Math.abs(media.currentTime-4.25)<0.01&&media.paused;});
 check('packaged_audio_bookmark_seeks_without_autoplay',true);
 const audioBackup=await download(page,'#export','audio-project-backup.json');
 check('audio_json_disk_bytes_match_saved_project',isDeepStrictEqual(JSON.parse(await fs.readFile(audioBackup,'utf8')),audioExpected));
 const audioNotebook=await download(page,'#export-notebook','audio-project-notes.md'),audioMarkdown=await fs.readFile(audioNotebook,'utf8');
 check('audio_markdown_has_user_notes_without_fake_transcript',audioMarkdown.includes(audioExpected.project_note)&&audioMarkdown.includes(audioExpected.timestamp_bookmarks[0].note)&&audioMarkdown.includes('00:04')&&audioMarkdown.includes('没有摘要')&&audioMarkdown.includes('用户笔记和时间书签'));
 // Exercise the exact packaged close handlers with native dialog answers, not
 // renderer-only beforeunload events. Cancel must leave its bridge operational.
 stage='native_close_preserves_dirty_work';
 await application.evaluate(({dialog})=>{
  globalThis.closeProof={response:0,dialogs:[]};
  dialog.showMessageBox=async(_window,options)=>{globalThis.closeProof.dialogs.push({title:options.title,buttons:options.buttons,defaultId:options.defaultId,cancelId:options.cancelId});return {response:globalThis.closeProof.response};};
 });
 async function cancelNativeClose(kind){
  const count=await application.evaluate(()=>globalThis.closeProof.dialogs.length);
  await application.evaluate(({app,BrowserWindow},kind)=>{if(kind==='window')BrowserWindow.getAllWindows()[0].close();else app.quit();},kind);
  for(let i=0;i<100;i++){
   if(await application.evaluate(()=>globalThis.closeProof.dialogs.length)>count)break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  const prompts=await application.evaluate(()=>globalThis.closeProof.dialogs);
  check(kind+'_close_prompts_keep_editing_by_default',prompts.length===count+1&&prompts.at(-1).title==='关闭 Coconut？'&&prompts.at(-1).buttons[0]==='继续编辑'&&prompts.at(-1).defaultId===0&&prompts.at(-1).cancelId===0);
  check(kind+'_cancel_keeps_bridge_and_window',!page.isClosed()&&(await fetch(origin+'/api/health')).ok&&await page.evaluate(()=>!document.body.inert));
 }
 await page.locator('#reading-settings > summary').click();await page.locator('#document-details').click();
 await page.locator('#document-title').fill('Authored uncommitted native title');
 await cancelNativeClose('window');
 check('cancel_window_retains_title_draft',await page.locator('#document-title').inputValue()==='Authored uncommitted native title');
 await page.locator('#details-dialog button[value="cancel"]').click();
 await page.evaluate(()=>{const original=Storage.prototype.setItem;window.restoreCloseProofStorage=()=>{Storage.prototype.setItem=original;};Storage.prototype.setItem=function(key,value){if(this===localStorage&&key==='coconut-reader-v1')throw new DOMException('Authored native quota failure','QuotaExceededError');return original.call(this,key,value);};});
 await page.locator('#project-note').fill('Authored unsaved note to discard explicitly');
 await cancelNativeClose('quit');
 check('cancel_quit_retains_unsaved_note',await page.locator('#project-note').inputValue()==='Authored unsaved note to discard explicitly'&&await page.locator('#save-status').isVisible());
 // Restoring storage alone must not silently save the failed edit. Explicit
 // discard should recover the last successful bytes on the next app launch.
 await page.evaluate(()=>window.restoreCloseProofStorage());
 await application.evaluate(()=>{globalThis.closeProof.response=1;});
 const exited=application.waitForEvent('close');
 await application.evaluate(({app})=>{setTimeout(()=>app.quit(),0);});await exited;application=null;
 let bridgeStopped=false;
 for(let i=0;i<50;i++){try{await fetch(origin+'/api/health',{signal:AbortSignal.timeout(300)});await new Promise(resolve=>setTimeout(resolve,100));}catch{bridgeStopped=true;break;}}
 check('explicit_discard_quits_and_stops_bridge',bridgeStopped);
 page=await launch(executable,profile,configuration.version,'relaunch');await verifyAudioRestored(page,audioExpected,'relaunch');
 await page.locator('#library button').filter({hasText:fixture.title}).click();await verifyRestored(page,expected,'relaunch');
 check('relaunch_keeps_playback_preference',await page.locator('#playback-rate').inputValue()==='1.5');
 await close();
 page=await launch(executable,path.join(temporary,'fresh-profile'),configuration.version,'fresh_restore');
 check('restore_profile_begins_empty',await stored(page)===null);await importFile(page,backup);
 // Import deliberately assigns a content fingerprint; all user data must match.
 const restored=await stored(page);const restoredExpected={...expected,key:restored.key};
 await verifyRestored(page,restoredExpected,'fresh_restore');
 await importFile(page,audioBackup);const restoredAudio=await stored(page);
 await verifyAudioRestored(page,{...audioExpected,key:restoredAudio.key},'fresh_restore');
 check('clean_profile_retains_both_project_formats',await page.evaluate(()=>JSON.parse(localStorage.getItem('coconut-reader-v1')).documents.length)===2);
 check('no_unexpected_external_status_or_mutating_requests',forbiddenRequests===0);
 check('no_uncaught_renderer_errors',pageErrors===0);
 await close();
 console.log(JSON.stringify({suite:'packaged-macos-product',status:'passed',architecture:process.arch,checks,
  gatekeeper_install_verified:false,real_inference_verified:false}));
}catch(error){
 console.error(JSON.stringify({suite:'packaged-macos-product',status:'failed',stage,category:error.name,checks}));process.exitCode=1;
}finally{
 // A failed assertion may leave the authored dirty fixture open. Cleanup may
 // discard only that isolated test profile so it cannot wait on a native dialog.
 try{if(application){await application.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});}).catch(()=>{});await application.close();}}finally{if(temporary)await fs.rm(temporary,{recursive:true,force:true});}
}
