/** CI-only real Chromium journey. Authored tone WAV and captions; static HTTP,
 * no backend capabilities, external network, ASR, model, or personal media. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
let browser,server,directory,stage='setup',external=0,mutations=0;
const checks=[],errors=[],apiRequests=[];
function check(name,value){stage=name;assert.ok(value,name);checks.push(name);}
try{
 directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-local-project-'));
 const audio=path.join(directory,'authored-local.wav');await fs.writeFile(audio,authoredAudioFixture(40));
 const reader=new URL('../reader/',import.meta.url);
 server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
  if(req.method!=='GET'&&req.method!=='HEAD'){mutations++;res.writeHead(405).end();return;}
  if(name.startsWith('api/'))apiRequests.push(name);
  if(!/^[a-z-]+\.(html|js|css|png)$/.test(name)){res.writeHead(404).end();return;}
  try{res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html');res.end(await fs.readFile(new URL(name,reader)));}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});
 async function newPage(){
  const context=await browser.newContext({acceptDownloads:true,serviceWorkers:'block',viewport:{width:390,height:844}});
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||url.protocol==='blob:')return route.continue();external++;return route.abort();});
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);return page;
 }
 async function choose(page,selector){const [picker]=await Promise.all([page.waitForEvent('filechooser'),page.locator(selector).click()]);await picker.setFiles(audio);}
 async function ready(page){await page.waitForFunction(()=>{const p=document.querySelector('#source-media audio');return p&&!p.error&&p.readyState>=2&&p.duration===40;});}
 async function shelf(page){await page.evaluate(()=>libraryStore.flush());return page.evaluate(()=>JSON.parse(localStorage.getItem('coconut-reader-v1')));}
 const page=await newPage();stage='open local audio with no transcript';
 await page.waitForFunction(()=>!document.getElementById('worker-status').textContent.includes('正在检查'));
 check('local_entry_always_available_with_44px_touch_target',await page.locator('#open-local-media').isVisible()&&await page.locator('#open-local-media').evaluate(n=>n.getBoundingClientRect().height>=44));
 await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
 check('add_screen_was_scrolled_before_opening',await page.evaluate(()=>scrollY>0));
 await choose(page,'#open-local-media');await ready(page);
 check('opening_scrolls_to_new_project_before_save_receipt',await page.locator('#title').evaluate(n=>{const r=n.getBoundingClientRect();return r.top>=-1&&r.top<innerHeight;}));
 check('no_transcript_or_consent_needed',await page.locator('#audio-project').isVisible()&&await page.locator('.segment').count()===0&&await page.locator('#source-media audio').evaluate(p=>p.paused&&p.currentTime===0));
 await page.locator('#project-note').fill('Local authored project note');await page.locator('#audio-bookmark-time').fill('12');await page.locator('#audio-bookmark-note').fill('Local authored timestamp note');await page.locator('#audio-bookmark-form button[type=submit]').click();
 const original=(await shelf(page)).documents[0],key=original.key;
 check('small_metadata_only_backup',JSON.stringify(original).length<3000&&original.local_media_source.name==='authored-local.wav'&&!JSON.stringify(original).includes('blob:'));
 stage='explicit playback and listening checkpoint';await page.locator('#source-media audio').evaluate(async p=>{await new Promise(resolve=>{p.addEventListener('seeked',resolve,{once:true});p.currentTime=15;});await p.play();p.pause();});
 await page.waitForFunction(key=>JSON.parse(localStorage.getItem('coconut-listening-v1:'+key)||'null')?.time>=15,key);
 await page.reload();await page.locator('#audio-project').waitFor({state:'visible'});
 check('reload_preserves_annotations_without_reading_media',await page.locator('#source-media audio').count()===0&&await page.locator('#project-note').inputValue()==='Local authored project note'&&(await page.locator('#reader-media-status').textContent()).includes('重新选择'));
 await choose(page,'#attach-reader-media');await ready(page);check('reselection_is_still_paused',await page.locator('#source-media audio').evaluate(p=>p.paused&&p.currentTime===0));
 await page.locator('#resume-listening').click();check('explicit_resume_restores_only_position',await page.locator('#source-media audio').evaluate(p=>p.paused&&p.currentTime>=15));
 stage='attach authored captions to the same project';
 const subtitles=Array.from({length:16},(_,i)=>`${i+1}\n00:00:${String(i*2).padStart(2,'0')},000 --> 00:00:${String(i*2+2).padStart(2,'0')},000\nAuthored local sentence ${i+1} gives the reader something real to inspect.\n`).join('\n');
 const [captionPicker]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-project-transcript').click()]);await captionPicker.setFiles({name:'authored.srt',mimeType:'application/x-subrip',buffer:Buffer.from(subtitles)});
 await page.waitForFunction(()=>document.querySelectorAll('.segment').length===16);
 let data=await shelf(page);check('subtitle_attachment_preserves_exact_project',data.documents.length===1&&data.documents[0].key===key&&data.documents[0].project_note===original.project_note&&data.documents[0].timestamp_bookmarks[0].note===original.timestamp_bookmarks[0].note&&data.documents[0].local_media_source.fingerprint===original.local_media_source.fingerprint);
 await page.locator('#add-content').click();await choose(page,'#open-local-media');await ready(page);await page.locator('.passage-original').first().waitFor({state:'visible'});
 check('reopen_never_downgrades_transcript_or_creates_duplicate',(await shelf(page)).documents.length===1&&await page.locator('#mode-passages').getAttribute('aria-pressed')==='true');
 check('mobile_reading_retains_first_source_budget',await page.locator('.passage-original').first().evaluate(n=>{const r=n.getBoundingClientRect();return r.top>=-1&&r.top<=350;})&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 stage='download full project and restore in a clean browser';
 await page.locator('#export-menu > summary').click();const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#export').click()]);const backup=path.join(directory,'local-project.json');await download.saveAs(backup);const saved=JSON.parse(await fs.readFile(backup,'utf8'));
 check('download_contains_complete_annotations_and_no_blob',saved.local_media_source.name==='authored-local.wav'&&saved.project_note===original.project_note&&!JSON.stringify(saved).includes('blob:'));
 const restored=await newPage();await restored.locator('#file').setInputFiles(backup);await restored.locator('.passage-original').first().waitFor({state:'visible'});
 check('clean_browser_restore_needs_file_reselection',await restored.locator('#source-media audio').count()===0&&(await shelf(restored)).documents[0].timestamp_bookmarks[0].time===12);
 if(!await restored.locator('#attach-reader-media').isVisible())await restored.locator('#toggle-reader-media').click();await choose(restored,'#attach-reader-media');await ready(restored);
 check('clean_restore_uses_no_service_or_model',external===0&&mutations===0&&apiRequests.every(url=>url==='api/health')&&errors.length===0);
 stage='distinct backup versions demand explicit matching';
 const alternate={...saved,project_note:'Alternate authored backup note'};await restored.locator('#file').setInputFiles({name:'alternate.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(alternate))});await restored.waitForFunction(()=>document.querySelector('#library-total').textContent==='2');
 await restored.locator('#add-content').click();const [picker]=await Promise.all([restored.waitForEvent('filechooser'),restored.locator('#open-local-media').click()]);await picker.setFiles(audio);await restored.locator('#local-media-project-dialog').waitFor({state:'visible'});
 check('versions_are_shown_without_silent_merge',await restored.locator('#local-media-project-options button').count()===2&&await restored.locator('#local-media-project-options').textContent().then(t=>t.includes('Alternate authored backup note')&&t.includes('Local authored project note')));
 await restored.locator('#cancel-local-media-project').click();check('cancelling_version_choice_keeps_both_backups',(await shelf(restored)).documents.length===2&&await restored.locator('#add-workspace').isVisible());
 console.log(JSON.stringify({suite:'local-media-projects-authored',status:'passed',checks}));
}catch(error){console.error(JSON.stringify({suite:'local-media-projects-authored',status:'failed',stage,checks,errors,error:error.message}));process.exitCode=1;}
finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));if(directory)await fs.rm(directory,{recursive:true,force:true});}
