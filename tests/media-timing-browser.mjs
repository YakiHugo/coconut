/** CI-only real Chromium journey. Authored tone WAV and captions; static HTTP,
 * no backend capabilities, external network, ASR, model, or personal media. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from './helpers/browser-storage.mjs';
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
 async function shelf(page){await page.evaluate(()=>libraryStore.flush());return page.evaluate(()=>readPersistedLibrary());}
 const page=await newPage();stage='import authored captions and associate local tone';
 await page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='ready');
 const fixture={title:'Authored timing calibration',segments:[{id:'first',start:10,end:12,text:'An authored first sentence for timing calibration.'},{id:'second',start:20,end:24,text:'The second sentence keeps its source timestamps.'}]};
 await page.locator('#file').setInputFiles({name:'authored-timing.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
 if(!await page.locator('#attach-reader-media').isVisible())await page.locator('#toggle-reader-media').click();await choose(page,'#attach-reader-media');await ready(page);
 await page.locator('#media-timing').waitFor({state:'visible'});
 await page.locator('#source-media audio').evaluate(p=>{p.pause();p.currentTime=12;});await page.locator('#media-timing-align').click();
 check('explicit_alignment_has_correct_sign_and_example',await page.locator('#media-timing-offset').inputValue()==='2'&&(await page.locator('#media-timing-example').textContent()).includes('00:10 → 媒体 00:12'));
 await page.locator('#source-media audio').evaluate(p=>{p.currentTime=30;});await page.locator('#media-timing-preview').click();
 await page.waitForFunction(()=>{const p=document.querySelector('audio');return !p.paused&&p.currentTime>=12&&p.currentTime<14;});
 check('real_player_preview_uses_media_clock',await page.locator('#source-media audio').evaluate(p=>p.currentTime>=12&&p.currentTime<14));
 await page.locator('#media-timing-return').click();await page.waitForFunction(()=>{const p=document.querySelector('audio');return p.paused&&Math.abs(p.currentTime-30)<.1;});
 check('preview_returns_to_physical_position_without_autoplay',true);
 await page.locator('#media-timing-save').click();await page.waitForFunction(()=>document.querySelector('#media-timing-status').textContent.startsWith('已保存'));
 const data=await shelf(page);check('saved_backup_data_keeps_canonical_source',data.documents[0].media_timing.offset===2&&data.documents[0].segments[0].start===10);
 await page.locator('#mode-transcript').click();await page.locator('.segment .time button').first().click();await page.waitForFunction(()=>{const p=document.querySelector('audio');return p.currentTime>=12&&p.currentTime<14;});
 await page.locator('#source-media audio').evaluate(p=>{p.pause();p.currentTime=13;p.dispatchEvent(new Event('timeupdate'));});
 check('inverse_highlight_selects_source_cue',await page.locator('.segment.playing').getAttribute('data-segment-id')==='first');
 if(!await page.locator('#media-timing-offset').isVisible())await page.locator('#toggle-reader-media').click();
 await page.locator('#media-timing-offset').fill('-11');await page.locator('#media-timing-preview').click();check('negative_preview_is_rejected_without_seeking',await page.locator('#source-media audio').evaluate(p=>p.currentTime===13)&&(await page.locator('#media-timing-status').textContent()).includes('无法试听'));
 await page.locator('#media-timing-offset').fill('31');await page.locator('#media-timing-preview').click();check('beyond_duration_preview_is_rejected',await page.locator('#source-media audio').evaluate(p=>p.currentTime===13));
 await page.reload();await page.locator('.segment').first().waitFor({state:'attached'});
 if(!await page.locator('#attach-reader-media').isVisible())await page.locator('#toggle-reader-media').click();await choose(page,'#attach-reader-media');await ready(page);
 check('reload_and_same_file_reselection_restore_saved_mapping_paused',await page.locator('#media-timing-offset').inputValue()==='2'&&await page.locator('#source-media audio').evaluate(p=>p.paused&&p.currentTime===0));
 await page.locator('#media-timing-reset').click();await page.locator('#media-timing-save').click();await page.waitForFunction(()=>document.querySelector('#media-timing-status').textContent.startsWith('已保存偏移 0'));
 check('reset_persists_zero_without_rewriting_subtitles',(await shelf(page)).documents[0].segments[0].start===10);
 check('mobile_controls_fit',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.locator('#media-timing').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'media-timing-mobile.png')});}
 check('no_models_uploads_or_external_requests',external===0&&mutations===0&&apiRequests.every(url=>url==='api/health')&&errors.length===0);
 console.log(JSON.stringify({ok:true,checks,errors,external,mutations},null,2));
}catch(error){console.error(JSON.stringify({ok:false,stage,checks,error:error.stack,errors,external,mutations},null,2));process.exitCode=1;}
finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());if(directory)await fs.rm(directory,{recursive:true,force:true});}
