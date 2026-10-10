import {openCueActions} from './cue-actions-browser.mjs';
/** Real public sources → production bridge → Coconut UI. No injected source/provider handlers. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {startBridge} from '../desktop/server.mjs';
let server,browser,directory,stage='setup';const checks=[];
const check=(name,value)=>{stage=name;assert.ok(value,name);checks.push(name);};
const markdownText=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\\`*_{}\[\]()#+.!|~$-]/g,'\\$&');
try {
 directory=await mkdtemp(path.join(os.tmpdir(),'coconut-live-ui-'));
 server=await startBridge({port:0});const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({acceptDownloads:true,serviceWorkers:'block'});
 const page=await context.newPage();page.setDefaultTimeout(25000);
 let unexpected=0,errors=0;const calls=[];
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.protocol==='blob:'||url.protocol==='data:')return route.continue();
  const allowed=url.origin===origin&&(request.method()==='GET'&&(!url.pathname.startsWith('/api/')||url.pathname==='/api/health')||request.method()==='POST'&&/^\/api\/podcasts\/(discover|import|media)$/.test(url.pathname));
  if(!allowed){unexpected++;return route.abort();}
  if(request.method()==='POST')calls.push(url.pathname.split('/').at(-1));
  return route.continue();
 });
 page.on('pageerror',()=>errors++);
 await page.goto(origin);await page.locator('#podcast-import').waitFor({state:'visible'});
 check('fresh_launch_has_no_automatic_source_or_model_request',calls.length===0&&await page.locator('#library .library-open').count()===0);
 async function discover(url){
  stage='discover_public_source';await page.locator('#video-url').fill(url);
  const response=page.waitForResponse(r=>r.url()===origin+'/api/podcasts/discover'&&r.request().method()==='POST');
  await page.locator('#process-url').click();const received=await response;
  assert.equal(received.status(),200);const value=await received.json();
  await page.locator('#process-url').waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.getElementById('process-url').disabled);
  return value;
 }
 // A rejected source must leave a usable retry entry, with no partial bookshelf item.
 await page.locator('#video-url').fill('http://127.0.0.1/private-feed');
 await page.locator('#process-url').click();
 await page.waitForFunction(()=>!document.getElementById('process-url').disabled&&!document.getElementById('cancel-podcast').offsetParent);
 check('invalid_source_failure_preserves_empty_shelf',await page.locator('#library .library-open').count()===0&&(await page.locator('#podcast-status').textContent()).length>0);
 const feed=await discover('https://mp3s.nashownotes.com/pc20rss.xml');
 const episode=feed.episodes?.find(item=>item.transcripts?.some(track=>track.supported&&/^en(?:-|$)/.test(track.language)));
 assert.ok(episode);const track=episode.transcripts.find(item=>item.supported&&/^en(?:-|$)/.test(item.language));
 const row=page.locator('.podcast-episode').filter({has:page.getByRole('heading',{name:episode.title,exact:true})});
 await row.getByLabel('选择文字稿版本').selectOption(track.url);
 const importResponse=page.waitForResponse(r=>r.url()===origin+'/api/podcasts/import'&&r.request().method()==='POST');
 await row.getByRole('button',{name:'导入发布者文字稿',exact:true}).click();const importedResponse=await importResponse;
 assert.equal(importedResponse.status(),200);const imported=await importedResponse.json();
 await page.locator('#mode-summary').click();await page.locator('#summary-workspace').waitFor({state:'visible'});
 check('actual_publisher_transcript_reaches_reader',imported.status==='ready'&&imported.document.segments.length>10&&(await page.locator('#title').textContent())===episode.title);
 check('real_provenance_and_no_fabricated_summary',(await page.locator('#provenance').textContent()).includes('发布者')&&(await page.locator('#summary-state').textContent())==='未生成'&&imported.document.provenance.review_status==='unreviewed');
 check('no_automatic_media_download',!calls.includes('media'));
 await page.locator('#mode-transcript').click();const first=page.locator('.segment').first();const segmentId=await first.getAttribute('data-segment-id');
 const original=imported.document.segments.find(item=>item.id===segmentId);assert.ok(original);
 await first.locator('.note-button').click();await page.locator('#note').fill('Coconut live acceptance: verify this passage against the publisher audio.');await page.locator('#close-note').click();
 await openCueActions(first);await first.locator('.bookmark-button').click();
 if(!await page.locator('#export-menu').evaluate(node=>node.open))await page.locator('#export-menu summary').click();
 const [backup]=await Promise.all([page.waitForEvent('download'),page.locator('#export').click()]);
 const backupPath=path.join(directory,'transcript.json');await backup.saveAs(backupPath);const saved=JSON.parse(await readFile(backupPath,'utf8'));
 check('real_transcript_notes_and_source_exported',saved.podcast_source.episode_id===episode.id&&saved.notes[segmentId].startsWith('Coconut live acceptance:')&&saved.readingPosition===segmentId&&saved.segments.find(item=>item.id===segmentId).text===original.text);
 if(!await page.locator('#export-menu').evaluate(node=>node.open))await page.locator('#export-menu summary').click();
 const [notebook]=await Promise.all([page.waitForEvent('download'),page.locator('#export-notebook').click()]);
 const notebookPath=path.join(directory,'notes.md');await notebook.saveAs(notebookPath);const markdown=await readFile(notebookPath,'utf8');
 check('notebook_contains_real_quote_note_and_publisher_link',markdown.includes(markdownText(original.text))&&markdown.includes(markdownText(saved.notes[segmentId]))&&markdown.includes(episode.source_url));
 await page.reload();await page.locator('#mode-transcript').click();await page.locator('#resume').click();
 check('reload_restores_reading_position',await page.locator('.segment').first().getAttribute('data-segment-id')===segmentId);
 await page.locator('.segment').first().locator('.note-button').click();check('reload_restores_real_source_notes',(await page.locator('#note').inputValue())===saved.notes[segmentId]);await page.locator('#close-note').click();
 // A separate blank browser proves exported bytes restore the product state.
 const restored=await browser.newContext({serviceWorkers:'block'}),restoredPage=await restored.newPage();restoredPage.setDefaultTimeout(25000);
 await restored.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===origin&&route.request().method()==='GET'&&(!url.pathname.startsWith('/api/')||url.pathname==='/api/health'))return route.continue();unexpected++;return route.abort();});
 await restoredPage.goto(origin);await restoredPage.locator('#file').setInputFiles(backupPath);await restoredPage.locator('#reader-workspace').waitFor({state:'visible'});
 await restoredPage.locator('#mode-transcript').click();await restoredPage.locator('#resume').click();await restoredPage.locator('.segment').first().locator('.note-button').click();
 check('downloaded_backup_reopens_in_clean_browser',(await restoredPage.locator('#note').inputValue())===saved.notes[segmentId]&&(await restoredPage.locator('#provenance').textContent()).includes('发布者'));
 await restored.close();
 await page.locator('#add-content').click();
 const apple=await discover('https://podcasts.apple.com/us/podcast/the-changelog-software-development-open-source/id341623264');
 check('apple_share_link_resolves_in_actual_ui',apple.feed_url==='https://changelog.com/podcast/feed'&&await page.locator('.podcast-episode').count()>0);
 const appleEpisode=await discover('https://podcasts.apple.com/us/podcast/the-changelog-software-development-open-source/id341623264?i=1000785837067');
 check('apple_shared_episode_matches_exact_guid_in_actual_ui',appleEpisode.episode_selection?.status==='matched'&&appleEpisode.episode_selection.apple_episode_id==='1000785837067'&&appleEpisode.episode_selection.matched_by==='publisher_guid'&&appleEpisode.episodes.length===1&&await page.locator('.podcast-episode').count()===1&&(await page.locator('.podcast-episode h3').textContent())==='Postgres at PlanetScale (Interview)');
 const xy=await discover('https://www.xiaoyuzhoufm.com/episode/6ab0922a0916f6f8b4468234');
 assert.equal(xy.episodes.length,1);const sample=xy.episodes[0];assert.equal(sample.transcripts.length,0);
 const xyRow=page.locator('.podcast-episode').first();await xyRow.getByRole('button',{name:'检查本集文字稿',exact:true}).click();
 await page.waitForFunction(()=>document.getElementById('podcast-status').textContent.includes('没有可用的公开定时文字稿'));
 await page.locator('#audio-project').waitFor({state:'visible'});
 check('no_caption_truthful_state_saves_audio_project',await page.locator('#library .library-open').count()===2&&!calls.includes('media')&&await page.locator('#summary-workspace').isHidden()&&await page.locator('#language-panel').isHidden());
 const audioProject=await page.evaluate(()=>{const shelf=JSON.parse(localStorage.getItem('coconut-reader-v1'));return shelf.documents.find(doc=>doc.key===sessionStorage.getItem('coconut-reader-active-v1'));});
 check('audio_project_preserves_real_source_without_transcript',audioProject.project_kind==='audio_only'&&audioProject.podcast_source.episode_id===sample.id&&audioProject.podcast_source.feed_url===xy.feed_url&&audioProject.segments.length===0&&audioProject.ai_answers.length===0);
 await page.locator('#project-note').fill('Coconut live audio project: my unverified listening note.');
 // The review sample must remain explicitly public and <=100 MiB. The production
 // UI fetch uses its normal 200 MiB hard limit; this additional source check bounds this suite.
 const media=sample.media[0];assert.ok(media.kind==='audio'&&media.length>0&&media.length<=100*1024*1024);
 stage='real_public_audio_through_coconut_ui';
 await page.locator('#download-podcast-media').click();
 await page.waitForFunction(()=>{const audio=document.querySelector('#source-media audio');return audio&&!audio.error&&audio.readyState>=2&&Number.isFinite(audio.duration)&&audio.duration>10;},null,{timeout:150000});
 const audio=page.locator('#source-media audio');await audio.evaluate(element=>element.play());
 await page.waitForFunction(()=>document.querySelector('#source-media audio').currentTime>1);
 const duration=await audio.evaluate(element=>element.duration);const target=Math.min(30,duration/2);
 await audio.evaluate((element,target)=>{element.pause();element.currentTime=target;},target);
 await page.waitForFunction(target=>Math.abs(document.querySelector('#source-media audio').currentTime-target)<0.5&&!document.querySelector('#source-media audio').seeking,target);
 check('real_public_audio_decodes_plays_and_seeks_inside_coconut',duration>10&&duration<=21600);
 await page.locator('#use-playback-time').click();await page.locator('#audio-bookmark-note').fill('Coconut live timestamp: return here to verify.');await page.locator('#audio-bookmark-form button[type=submit]').click();
 await audio.evaluate(element=>{element.currentTime=0;});await page.locator('#audio-bookmarks button').first().click();
 await page.waitForFunction(target=>Math.abs(document.querySelector('#source-media audio').currentTime-target)<0.5&&!document.querySelector('#source-media audio').seeking,target);
 check('saved_bookmark_seeks_actual_public_audio',await audio.evaluate(element=>element.paused));
 await audio.evaluate(element=>element.play());await page.locator('#add-content').click();
 check('leaving_audio_project_pauses_hidden_audio',await audio.evaluate(element=>element.paused));await page.locator('#back-reading').click();
 if(!await page.locator('#export-menu').evaluate(node=>node.open))await page.locator('#export-menu summary').click();
 const [audioBackup]=await Promise.all([page.waitForEvent('download'),page.locator('#export').click()]);
 const audioBackupPath=path.join(directory,'audio-project.json');await audioBackup.saveAs(audioBackupPath);const audioSaved=JSON.parse(await readFile(audioBackupPath,'utf8'));
 check('audio_project_backup_contains_source_notes_and_bookmark',audioSaved.project_note.startsWith('Coconut live audio project:')&&Math.abs(audioSaved.timestamp_bookmarks[0].time-target)<0.01&&audioSaved.timestamp_bookmarks[0].note.startsWith('Coconut live timestamp:')&&audioSaved.podcast_source.media_url===media.url&&audioSaved.segments.length===0&&audioSaved.ai_answers.length===0&&!JSON.stringify(audioSaved).includes('blob:'));
 await page.reload();await page.locator('#audio-project').waitFor({state:'visible'});
 check('audio_project_refresh_restores_notes_without_media_download',await page.locator('#project-note').inputValue()===audioSaved.project_note&&await page.locator('#audio-bookmarks textarea').inputValue()===audioSaved.timestamp_bookmarks[0].note&&await page.locator('#source-media audio').count()===0&&calls.filter(item=>item==='media').length===1);
 const audioRestored=await browser.newContext({serviceWorkers:'block'}),audioRestoredPage=await audioRestored.newPage();audioRestoredPage.setDefaultTimeout(25000);
 audioRestoredPage.on('pageerror',()=>errors++);
 await audioRestored.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===origin&&route.request().method()==='GET'&&(!url.pathname.startsWith('/api/')||url.pathname==='/api/health'))return route.continue();unexpected++;return route.abort();});
 await audioRestoredPage.goto(origin);await audioRestoredPage.locator('#file').setInputFiles(audioBackupPath);await audioRestoredPage.locator('#audio-project').waitFor({state:'visible'});
 check('audio_project_backup_recovers_in_clean_browser',await audioRestoredPage.locator('#project-note').inputValue()===audioSaved.project_note&&await audioRestoredPage.locator('#audio-bookmarks textarea').inputValue()===audioSaved.timestamp_bookmarks[0].note&&await audioRestoredPage.locator('#summary-workspace').isHidden()&&await audioRestoredPage.locator('#source-media audio').count()===0);
 await audioRestoredPage.locator('#audio-bookmarks button').first().click();check('restored_audio_bookmark_honestly_requires_media', (await audioRestoredPage.locator('#audio-project-status').textContent()).includes('先单独获取原声'));
 await audioRestored.close();
 check('no_inference_upload_or_uncaught_errors',unexpected===0&&errors===0&&calls.filter(item=>item==='media').length===1);
 console.log(JSON.stringify({suite:'public-source-to-reader',status:'passed',checks,segments:imported.document.segments.length,audio_duration_seconds:Math.round(duration),source_requests:calls.length}));
} catch {
 console.error(JSON.stringify({suite:'public-source-to-reader',status:'failed',stage,checks,message:'Actual public-source/UI acceptance failed. No models, accounts, access workaround, source bodies or upstream error logs were used or published.'}));process.exitCode=1;
} finally {
 await browser?.close();if(server)await new Promise(resolve=>server.shutdown(resolve));if(directory)await rm(directory,{recursive:true,force:true});
}
