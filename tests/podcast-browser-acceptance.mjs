/** Synthetic browser flow through the production source HTTP routes. No network sources or models. */
import {startBridge} from '../desktop/server.mjs';
import {chromium} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
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
 const calls=[];
 server=await startBridge({port:0,providers:{status:async()=>{throw new Error('No CLI checks expected');}},podcastSources:{discover:async()=>{calls.push('discover');return {kind:'feed',title:'Synthetic source',feed_url:source.feed_url,episodes:[episode],warnings:[]};},importEpisode:async()=>{calls.push('import');return {status:'ready',document:doc,episode};},downloadMedia:async()=>{calls.push('media');return {body,type:'audio/mpeg',kind:'audio',filename:'synthetic.mp3'};}}});
 const origin='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const page=await browser.newPage();let external=0,errors=0;
 await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin===origin||u.protocol==='blob:')await route.continue();else{external++;await route.abort();}});page.on('pageerror',()=>errors++);page.setDefaultTimeout(15000);
 await page.goto(origin);await page.locator('#podcast-import').waitFor({state:'visible'});check('no_automatic_source_requests',calls.length===0);
 stage='discover';await page.locator('#podcast-url').fill(source.feed_url);await page.locator('#discover-podcast').click();await page.locator('.podcast-episode').waitFor();
 check('discovery_only',calls.join(',')==='discover');await page.locator('.podcast-episode button').first().click();await page.locator('#summary-workspace').waitFor({state:'visible'});
 check('no_fabricated_summary',await page.locator('#summary-state').textContent()==='未生成');check('no_automatic_media_download',calls.join(',')==='discover,import');
 await page.locator('#mode-transcript').click();await page.locator('#download-podcast-media').click();
 await page.waitForFunction(()=>{const a=document.querySelector('#source-media audio');return a&&!a.error&&a.duration>0&&a.readyState>=2;});check('media_download_is_explicit',calls.join(',')==='discover,import,media');
 await page.locator('.segment[data-segment-id="two"] .time > button').first().click();await page.waitForFunction(()=>document.querySelector('audio').currentTime>2.1);check('downloaded_audio_decodes_and_seeks',true);
 await page.locator('audio').evaluate(a=>a.pause());await page.locator('.segment[data-segment-id="two"] .note-button').click();await page.locator('#note').fill('Browser source note');await page.locator('#close-note').click();
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('coconut-reader-v1')).documents[0]);check('source_and_notes_saved',saved.podcast_source.episode_id===source.episode_id&&saved.notes.two==='Browser source note');
 await page.reload();await page.locator('#mode-transcript').click();check('media_requires_explicit_reload',await page.locator('#source-media audio').count()===0);check('no_hidden_or_external_requests',calls.join(',')==='discover,import,media'&&external===0&&errors===0);
 console.log(JSON.stringify({suite:'podcast-source-browser',status:'passed',checks}));
}catch{console.error(JSON.stringify({suite:'podcast-source-browser',status:'failed',stage,checks}));process.exitCode=1;}
finally{await browser?.close();if(server)await new Promise(resolve=>server.shutdown(resolve));if(directory)await rm(directory,{recursive:true,force:true});}
