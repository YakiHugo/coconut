/** Synthetic browser flow through the production source HTTP routes. No network sources or models. */
import {startBridge} from '../desktop/server.mjs';
import {chromium} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
let server,browser,directory,stage='setup';const checks=[];
const check=(name,value)=>{stage=name;assert.ok(value);checks.push(name);};
try{
 directory=await mkdtemp(path.join(os.tmpdir(),'coconut-source-ui-'));const filename=path.join(directory,'synthetic.mp3');
 execFileSync('ffmpeg',['-nostdin','-loglevel','error','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','6','-c:a','libmp3lame',filename],{timeout:30000});const body=await readFile(filename);
 const source={feed_url:'https://publisher.example/feed',episode_id:'a'.repeat(64),transcript_url:'https://publisher.example/text.vtt',media_url:'https://publisher.example/audio.mp3',media_kind:'audio'};
 const episode={id:source.episode_id,title:'自写来源验收节目',source_url:'https://publisher.example/episode',language:'en',duration:6,media:[{url:source.media_url,type:'audio/mpeg',kind:'audio',length:body.length}],transcripts:[{url:source.transcript_url,type:'text/vtt',language:'en',supported:true}]};
 const doc={title:episode.title,language:'en',source_url:episode.source_url,podcast_source:source,provenance:{kind:'publisher_transcript',caption_method:'publisher_provided',review_status:'unreviewed'},segments:[{id:'one',start:0,end:2,text:'Synthetic source words'},{id:'two',start:2,end:4,text:'More synthetic words'}]};
 const noTextEpisode={...episode,id:'b'.repeat(64),title:'无文字稿原声项目',transcripts:[]};
 const unsupportedEpisode={...episode,id:'c'.repeat(64),title:'仅有网页格式文字稿的自写节目',transcripts:[{url:'https://publisher.example/transcript.html',type:'text/html',supported:false}]};
 const calls=[],mediaPayloads=[];
 server=await startBridge({port:0,providers:{status:async()=>{throw new Error('No CLI checks expected');}},podcastSources:{discover:async data=>{calls.push('discover');return data.url.endsWith('.mp3')?{kind:'media',title:'原声直链项目',media:episode.media[0]}:{kind:'feed',title:'Synthetic source',feed_url:source.feed_url,episodes:[episode,noTextEpisode,unsupportedEpisode],warnings:[]};},importEpisode:async data=>{calls.push('import');return data.episodeId===noTextEpisode.id?{status:'needs_transcription',episode:noTextEpisode,feed_url:source.feed_url}:{status:'ready',document:doc,episode};},downloadMedia:async data=>{calls.push('media');mediaPayloads.push(data);return {body,type:'audio/mpeg',kind:'audio',filename:'synthetic.mp3'};}}});
 const origin='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const page=await browser.newPage();let external=0,errors=0;
 await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin===origin||u.protocol==='blob:')await route.continue();else{external++;await route.abort();}});page.on('pageerror',()=>errors++);page.setDefaultTimeout(15000);
 await page.goto(origin);await page.locator('#podcast-import').waitFor({state:'visible'});check('no_automatic_source_requests',calls.length===0);
 stage='discover';await page.locator('#video-url').fill(source.feed_url);await page.locator('#process-url').click();await page.locator('.podcast-episode').first().waitFor();
 check('discovery_only',calls.join(',')==='discover');
 stage='filter_discovered_episodes';
 await page.locator('#podcast-episode-search').fill('无文字稿');
 check('title_filter_finds_audio_only_episode',await page.locator('.podcast-episode:visible').count()===1&&await page.locator('.podcast-episode:visible h3').textContent()===noTextEpisode.title);
 await page.locator('#podcast-episode-availability').selectOption('supported');
 check('combined_filters_show_recoverable_empty_state',await page.locator('.podcast-episode:visible').count()===0&&await page.locator('.podcast-filter-empty').isVisible());
 await page.locator('.podcast-clear').click();
 check('clear_filters_restores_all_and_search_focus',await page.locator('.podcast-episode:visible').count()===3&&await page.locator('#podcast-episode-search').evaluate(node=>document.activeElement===node));
 await page.locator('#podcast-episode-availability').selectOption('supported');
 check('supported_filter_excludes_html_and_missing_transcripts',await page.locator('.podcast-episode:visible').count()===1&&await page.locator('.podcast-episode:visible h3').textContent()===episode.title);
 check('episode_filtering_never_fetches_or_imports',calls.join(',')==='discover');
 await page.locator('.podcast-clear').click();
 if(process.env.COCONUT_UI_SCREENSHOTS){
  await mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});
  for(const [name,width,height] of [['desktop',1280,900],['mobile',390,844]]){
   await page.setViewportSize({width,height});await page.locator('.podcast-filters').evaluate(node=>node.scrollIntoView({block:'start'}));
   check('picker_'+name+'_has_no_horizontal_overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'podcast-picker-'+name+'.png')});
  }
  await page.setViewportSize({width:1280,height:720});
 }
 await page.locator('.podcast-episode button').first().click();await page.locator('#summary-workspace').waitFor({state:'visible'});
 check('no_fabricated_summary',await page.locator('#summary-state').textContent()==='未生成');check('no_automatic_media_download',calls.join(',')==='discover,import');
 await page.locator('#mode-transcript').click();await page.locator('#download-podcast-media').click();
 await page.waitForFunction(()=>{const a=document.querySelector('#source-media audio');return a&&!a.error&&a.duration>0&&a.readyState>=2;});check('media_download_is_explicit',calls.join(',')==='discover,import,media');
 await page.locator('.segment[data-segment-id="two"] .time > button').first().click();await page.waitForFunction(()=>document.querySelector('audio').currentTime>2.1);check('downloaded_audio_decodes_and_seeks',true);
 await page.locator('audio').evaluate(a=>a.pause());await page.locator('.segment[data-segment-id="two"] .note-button').click();await page.locator('#note').fill('Browser source note');await page.locator('#close-note').click();
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('coconut-reader-v1')).documents[0]);check('source_and_notes_saved',saved.podcast_source.episode_id===source.episode_id&&saved.notes.two==='Browser source note');
 await page.reload();await page.locator('#mode-transcript').click();check('media_requires_explicit_reload',await page.locator('#source-media audio').count()===0);check('no_hidden_or_external_requests',calls.join(',')==='discover,import,media'&&external===0&&errors===0);

 stage='save_no_transcript_project';await page.locator('#add-content').click();await page.locator('#video-url').fill(source.feed_url);await page.locator('#process-url').click();await page.locator('.podcast-episode').nth(1).locator('button').first().click();await page.locator('#audio-project').waitFor({state:'visible'});
 check('audio_project_has_no_fake_summary',await page.locator('#summary-workspace').isHidden()&&await page.locator('#language-panel').isHidden()&&await page.locator('#transcript-layout').isHidden());
 const noTextSaved=await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('coconut-reader-v1'));return s.documents.find(d=>d.key===s.active);});
 check('audio_project_source_saved_without_download',noTextSaved.project_kind==='audio_only'&&noTextSaved.segments.length===0&&noTextSaved.ai_answers.length===0&&calls.filter(c=>c==='media').length===1);
 await page.locator('#project-note').fill('浏览器验收项目笔记');await page.locator('#audio-bookmark-time').fill('00:02');await page.locator('#audio-bookmark-note').fill('这里需要回听核对');await page.locator('#audio-bookmark-form button[type=submit]').click();
 await page.reload();await page.locator('#audio-project').waitFor({state:'visible'});check('audio_notes_survive_refresh',await page.locator('#project-note').inputValue()==='浏览器验收项目笔记'&&await page.locator('#audio-bookmarks textarea').inputValue()==='这里需要回听核对');
 check('refresh_does_not_redownload_audio',await page.locator('#source-media audio').count()===0&&calls.filter(c=>c==='media').length===1);
 await page.locator('#download-podcast-media').click();await page.waitForFunction(()=>{const a=document.querySelector('#source-media audio');return a&&!a.error&&a.duration>0&&a.readyState>=2;});
 await page.locator('#audio-bookmarks button').first().click();check('timestamp_bookmark_seeks_reacquired_audio',await page.locator('#source-media audio').evaluate(a=>Math.abs(a.currentTime-2)<0.1&&a.paused));
 await page.locator('#export-menu summary').click();const [projectDownload]=await Promise.all([page.waitForEvent('download'),page.locator('#export').click()]);const projectPath=path.join(directory,'audio-project.coconut.json');await projectDownload.saveAs(projectPath);
 const projectBackup=JSON.parse(await readFile(projectPath,'utf8'));check('audio_project_json_backup_is_complete',projectBackup.project_note==='浏览器验收项目笔记'&&projectBackup.timestamp_bookmarks[0].time===2&&projectBackup.segments.length===0&&!JSON.stringify(projectBackup).includes('blob:'));
 if(!await page.locator('.library-backup').evaluate(node=>node.open))await page.locator('.library-backup > summary').click();
 const [libraryDownload]=await Promise.all([page.waitForEvent('download'),page.locator('#export-library').click()]);const libraryPath=path.join(directory,'coconut-library.json');await libraryDownload.saveAs(libraryPath);
 await page.evaluate(()=>localStorage.removeItem('coconut-reader-v1'));await page.reload();await page.locator('#library-file').setInputFiles(libraryPath);await page.locator('#audio-project').waitFor({state:'visible'});
 check('full_library_backup_restores_audio_notes',await page.locator('#project-note').inputValue()==='浏览器验收项目笔记'&&await page.locator('#audio-bookmarks textarea').inputValue()==='这里需要回听核对');
 await page.evaluate(()=>localStorage.removeItem('coconut-reader-v1'));await page.reload();await page.locator('#file').setInputFiles(projectPath);await page.locator('#audio-project').waitFor({state:'visible'});
 check('single_project_backup_restores_audio_notes',await page.locator('#project-note').inputValue()==='浏览器验收项目笔记'&&await page.locator('#audio-bookmarks textarea').inputValue()==='这里需要回听核对');
 if(process.env.COCONUT_AUDIO_SCREENSHOT)await page.screenshot({path:process.env.COCONUT_AUDIO_SCREENSHOT,fullPage:true});
 stage='direct_media_project';await page.locator('#add-content').click();await page.locator('#video-url').fill(source.media_url);await page.locator('#process-url').click();await page.getByRole('button',{name:'保存原声项目',exact:true}).click();await page.locator('#audio-project').waitFor({state:'visible'});
 await page.reload();await page.locator('#download-podcast-media').click();await page.waitForFunction(()=>{const a=document.querySelector('#source-media audio');return a&&!a.error&&a.readyState>=2;});
 check('direct_media_redownload_preserves_url_contract',JSON.stringify(mediaPayloads.at(-1))===JSON.stringify({url:source.media_url}));
 check('audio_projects_never_trigger_external_requests_or_inference',external===0&&errors===0&&calls.every(c=>['discover','import','media'].includes(c)));
 console.log(JSON.stringify({suite:'podcast-source-browser',status:'passed',checks}));
}catch{console.error(JSON.stringify({suite:'podcast-source-browser',status:'failed',stage,checks}));process.exitCode=1;}
finally{await browser?.close();if(server)await new Promise(resolve=>server.shutdown(resolve));if(directory)await rm(directory,{recursive:true,force:true});}
