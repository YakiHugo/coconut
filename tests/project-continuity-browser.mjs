/** Real Chromium project continuity through production HTTP/UI code.
 * All model responses and publisher endpoints are explicitly injected fixtures.
 * This verifies storage, scopes, playback and recovery, never model quality. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {startBridge} from '../desktop/server.mjs';
let server,browser,directory,stage='setup';const checks=[],modelInputs=[],sourceCalls=[];
const check=(name,value)=>{stage=name;assert.ok(value,name);checks.push(name);};
try{
 directory=await mkdtemp(path.join(os.tmpdir(),'coconut-project-continuity-'));
 const mediaFile=path.join(directory,'synthetic.mp3');execFileSync('ffmpeg',['-nostdin','-loglevel','error','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','6','-c:a','libmp3lame',mediaFile],{timeout:30000});const body=await readFile(mediaFile);
 const source={feed_url:'https://publisher.example/feed',episode_id:'a'.repeat(64),media_url:'https://publisher.example/audio.mp3',media_kind:'audio'};
 const episode={id:source.episode_id,title:'Synthetic continuity fixture',source_url:'https://publisher.example/episode',language:'en',duration:6,media:[{url:source.media_url,type:'audio/mpeg',kind:'audio',length:body.length}],transcripts:[]};
 const transcript={title:episode.title,language:'en',source_url:episode.source_url,podcast_source:source,provenance:{kind:'publisher_transcript',review_status:'unreviewed'},segments:[{id:'one',start:0,end:2,text:'Original source one.'},{id:'two',start:2,end:4,text:'Original source two.'}]};
 let captionsReady=false;
 server=await startBridge({port:0,podcastSources:{discover:async()=>{sourceCalls.push('discover');return {kind:'feed',title:'Synthetic feed',feed_url:source.feed_url,episodes:[episode]};},importEpisode:async()=>{sourceCalls.push('transcript');return captionsReady?{status:'ready',document:transcript}:{status:'needs_transcription',episode,feed_url:source.feed_url};},downloadMedia:async()=>{sourceCalls.push('media');return {body,type:'audio/mpeg',kind:'audio',filename:'synthetic.mp3'};}},providers:{status:async()=>({ready:true,reason:'Injected test provider; no real model'}),exclusive:async fn=>fn(),structured:async(_provider,payload)=>{const data=JSON.parse(payload);modelInputs.push(data);return {translations:data.target_ids.map(id=>({id,text:id==='one'?'这是测试译文一。':'这是测试译文二。'}))};},ask:async request=>{modelInputs.push(request);return {answer:'这是注入的测试摘要，不代表真实模型质量。',citations:['two'],provider:'synthetic-fixture'};}}});
 const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 let external=0,errors=0;
 async function newPage(){const context=await browser.newContext({acceptDownloads:true,serviceWorkers:'block'});await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin===origin||u.protocol==='blob:')await route.continue();else{external++;await route.abort();}});const page=await context.newPage();page.on('pageerror',()=>errors++);page.setDefaultTimeout(15000);await page.goto(origin);return page;}
 const page=await newPage();stage='save_audio_project';await page.locator('#podcast-import').waitFor({state:'visible'});await page.locator('#video-url').fill(source.feed_url);await page.locator('#process-url').click();await page.getByRole('button',{name:'保存原声项目',exact:true}).click();await page.locator('#audio-project').waitFor({state:'visible'});
 await page.locator('#project-note').fill('PRIVATE PROJECT NOTE');await page.locator('#audio-bookmark-time').fill('2');await page.locator('#audio-bookmark-note').fill('PRIVATE BOOKMARK');await page.locator('#audio-bookmark-form button[type=submit]').click();
 await page.locator('#fetch-project-transcript').click();await page.waitForFunction(()=>document.querySelector('#audio-project-status').textContent.includes('仍未提供'));
 check('unavailable_transcript_preserves_project_without_inference',modelInputs.length===0&&await page.locator('.segment').count()===0);
 await page.locator('#download-podcast-media').click();await page.waitForFunction(()=>{const p=document.querySelector('audio');return p&&!p.error&&p.duration>4&&p.readyState>=2;});
 const originalKey=await page.evaluate(()=>sessionStorage.getItem('coconut-reader-active-v1'));await page.locator('audio').evaluate(p=>{p.dataset.retained='yes';p.currentTime=1;});
 captionsReady=true;await page.locator('#fetch-project-transcript').click();await page.locator('#transcript-layout').waitFor({state:'visible'});
 check('attachment_keeps_one_stable_project',await page.evaluate(key=>{const s=JSON.parse(localStorage.getItem('coconut-reader-v1'));return s.documents.length===1&&sessionStorage.getItem('coconut-reader-active-v1')===key;},originalKey));
 check('attachment_keeps_loaded_media_and_notes',await page.locator('audio').getAttribute('data-retained')==='yes'&&await page.locator('#project-note').inputValue()==='PRIVATE PROJECT NOTE'&&await page.locator('#audio-bookmarks textarea').inputValue()==='PRIVATE BOOKMARK');
 check('attachment_does_not_redownload_or_infer',sourceCalls.filter(c=>c==='media').length===1&&modelInputs.length===0);
 stage='explicit_translation';await page.locator('#language-panel > summary').click();await page.locator('#ai-task').selectOption('translation');await page.locator('#check-ai').click();await page.locator('#translation-target').selectOption('zh');await page.locator('#ai-consent').check();await page.locator('#subscription-translate').click();await page.waitForFunction(()=>document.querySelectorAll('.translation').length===2);
 check('translation_stays_aligned_with_original_ids',await page.locator('.segment[data-segment-id="two"] .translation').textContent()==='这是测试译文二。');
 stage='explicit_summary';await page.locator('#ai-task').selectOption('summary');await page.locator('#ai-consent').check();await page.locator('#ask-ai').click();await page.waitForFunction(()=>document.querySelector('#summary-state').dataset.state==='current');
 check('model_payloads_exclude_user_annotations',modelInputs.length===2&&modelInputs.every(data=>!JSON.stringify(data).includes('PRIVATE')));
 await page.locator('#mode-summary').click();await page.locator('#summary-citations button').click();await page.locator('.segment[data-segment-id="two"] .time > button').first().click();await page.waitForFunction(()=>document.querySelector('audio').currentTime>2.1);await page.locator('audio').evaluate(p=>p.pause());
 check('summary_citation_returns_to_decodable_source',await page.locator('.segment[data-segment-id="two"]').count()===1);
 async function download(button,filename){const [item]=await Promise.all([page.waitForEvent('download'),page.locator(button).click()]);const file=path.join(directory,filename);await item.saveAs(file);return file;}
 await page.locator('#export-menu > summary').click();const backup=await download('#export','project.json');
 if(!await page.locator('#export-menu').evaluate(n=>n.open))await page.locator('#export-menu > summary').click();const notes=await download('#export-notebook','notes.md');const markdown=await readFile(notes,'utf8');check('notebook_exports_all_original_project_annotations',markdown.includes('PRIVATE PROJECT NOTE')&&markdown.includes('PRIVATE BOOKMARK')&&markdown.includes('不是原文'));
 await page.locator('.library-backup > summary').click();const library=await download('#export-library','library.json');
 const restored=await newPage();await restored.locator('#file').setInputFiles(backup);await restored.waitForFunction(()=>document.querySelector('#summary-state').dataset.state==='current');await restored.locator('#summary-citations button').click();
 check('single_json_restores_summary_translation_and_root_annotations',await restored.locator('#project-note').inputValue()==='PRIVATE PROJECT NOTE'&&await restored.locator('.translation').count()===2&&await restored.locator('#audio-bookmarks textarea').inputValue()==='PRIVATE BOOKMARK');
 check('restore_never_reuses_blob_or_downloads_without_click',await restored.locator('audio').count()===0&&sourceCalls.filter(c=>c==='media').length===1&&modelInputs.length===2);
 if(!await restored.locator('#attach-reader-media').isVisible())await restored.locator('#toggle-reader-media').click();
 const [chooser]=await Promise.all([restored.waitForEvent('filechooser'),restored.locator('#attach-reader-media').click()]);await chooser.setFiles(mediaFile);await restored.waitForFunction(()=>{const a=document.querySelector('audio');return a&&!a.error&&a.duration>4;});await restored.locator('#audio-bookmarks button').first().click();check('restored_bookmark_seeks_reselected_file',await restored.locator('audio').evaluate(a=>Math.abs(a.currentTime-2)<0.1&&a.paused));
 const shelf=await newPage();await shelf.locator('#library-file').setInputFiles(library);await shelf.locator('#mode-bilingual').click();check('whole_library_restore_keeps_one_complete_project',await shelf.locator('#library-total').textContent()==='1'&&await shelf.locator('#project-note').inputValue()==='PRIVATE PROJECT NOTE'&&await shelf.locator('.translation').count()===2);
 check('no_external_requests_or_browser_errors',external===0&&errors===0);console.log(JSON.stringify({suite:'project-continuity-injected-models',status:'passed',checks}));
}catch(error){console.error(JSON.stringify({suite:'project-continuity-injected-models',status:'failed',stage,checks,error:error.message}));process.exitCode=1;}
finally{await browser?.close();if(server)await new Promise(resolve=>server.shutdown(resolve));if(directory)await rm(directory,{recursive:true,force:true});}
