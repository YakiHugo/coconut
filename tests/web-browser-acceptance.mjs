/** Real Chromium proof for the static Web product; no Python service or AI calls. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {chromium} from '@playwright/test';
const root=fileURLToPath(new URL('../',import.meta.url));
let directory,server,browser,stage='setup';
const checks=[];
function check(name,value){stage=name;assert.ok(value,name);checks.push(name);}
try {
 directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-static-web-'));
 const video=path.join(directory,'synthetic.mp4'),audio=path.join(directory,'synthetic.wav');
 execFileSync('ffmpeg',['-nostdin','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','8','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',video],{timeout:30000});
 execFileSync('ffmpeg',['-nostdin','-loglevel','error','-i',video,'-vn',audio],{timeout:30000});
 const segments=[{id:'first',start:0,end:2,text:'This is an original synthetic browser test.'},{id:'second',start:2,end:4,text:'Audio and video stay in this browser.'},{id:'last',start:4,end:6,text:'A saved summary must keep its source.'}];
 const fixture={title:'浏览器验证 · 自写示例',segments,ai_answers:[{purpose:'summary',question:'Synthetic summary fixture',answer:'这是一份自写的浏览器验证摘要，不是模型生成的真实节目摘要。',provider:'synthetic-test-fixture',citations:['second'],input_snapshot:{version:1,segments:segments.map(({id,text})=>({id,text}))}}]};
 const fixturePath=path.join(directory,'fixture.json');await fs.writeFile(fixturePath,JSON.stringify(fixture));
 let mutations=0;
 server=createServer(async(req,res)=>{
  if(req.method!=='GET'&&req.method!=='HEAD'){mutations++;res.writeHead(405).end();return;}
  const pathname=new URL(req.url,'http://localhost').pathname;
  const filename=pathname==='/'?'index.html':pathname.slice(1);
  if(!/^[a-z-]+\.(html|js|css|webmanifest)$/.test(filename)){res.writeHead(404,{'Content-Type':'application/json'}).end('{"error":"static only"}');return;}
  try{const data=await fs.readFile(path.join(root,'reader',filename));res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'text/html'});res.end(data);}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({acceptDownloads:true,viewport:{width:1360,height:1000},serviceWorkers:'block'});
 let external=0,pageErrors=0;
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.origin===origin||['blob:','data:'].includes(u.protocol))await route.continue();else{external++;await route.abort();}
 });
 const page=await context.newPage();page.on('pageerror',()=>pageErrors++);page.setDefaultTimeout(15000);
 await page.goto(origin);stage='import';
 await page.locator('#file').setInputFiles(fixturePath);
 await page.locator('#reader-workspace').waitFor({state:'visible'});
 check('summary_is_default',await page.locator('#summary-workspace').isVisible()&&await page.locator('#transcript-layout').isHidden());
 check('saved_summary_visible',(await page.locator('#summary-body').textContent()).includes('自写的浏览器验证'));
 check('summary_source_current',await page.locator('#summary-state').getAttribute('data-state')==='current');
 await page.locator('#summary-citations button').click();
 check('citation_opens_original',await page.locator('#transcript-layout').isVisible()&&await page.locator('.segment[data-segment-id="second"]').evaluate(n=>n===document.activeElement));
 async function attach(filename,kind){
  const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-reader-media').click()]);await chooser.setFiles(filename);
  await page.waitForFunction(kind=>{const p=document.querySelector('#source-media '+kind);return p&&!p.error&&p.readyState>=2&&p.duration>0;},kind);
  check(kind+'_uses_browser_file',(await page.locator('#source-media '+kind).getAttribute('src')).startsWith('blob:'));
  await page.locator('.segment[data-segment-id="second"] .time > button').first().click();
  await page.waitForFunction(kind=>{const p=document.querySelector('#source-media '+kind);return !p.paused&&p.currentTime>2;},kind);
  check(kind+'_seek_and_play',true);
  await page.locator('#source-media '+kind).evaluate(p=>p.pause());
 }
 await attach(video,'video');
 check('video_decoded',await page.locator('video').evaluate(v=>v.videoWidth===320&&v.videoHeight===180));
 await page.locator('#mode-summary').click();
 check('summary_mode_pauses_media',await page.locator('video').evaluate(v=>v.paused));
 await page.locator('#mode-transcript').click();await attach(audio,'audio');
 check('audio_replaces_video',await page.locator('video').count()===0);
 const row=page.locator('.segment[data-segment-id="second"]');
 await row.locator('.note-button').click();await page.locator('#note').fill('Synthetic note survives mode changes');await page.locator('#close-note').click();
 await row.locator('.edit-button').click();await page.locator('#edit-segment').fill('A corrected synthetic source sentence.');await page.locator('#save-edit').click();
 await page.locator('#mode-summary').click();check('edited_source_marks_summary_stale',await page.locator('#summary-state').getAttribute('data-state')==='stale');
 const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#export-summary').click()]);
 const exported=path.join(directory,'summary.md');await download.saveAs(exported);const markdown=await fs.readFile(exported,'utf8');
 check('summary_export_has_historical_input',markdown.includes('Audio and video stay in this browser')&&markdown.includes('播客摘要')&&markdown.includes('旧摘要可能过期'));
 check('object_urls_never_persist',await page.evaluate(()=>!localStorage.getItem('coconut-reader-v1').includes('blob:')));
 await page.reload();await page.locator('#summary-workspace').waitFor({state:'visible'});
 check('refresh_keeps_summary_state',await page.locator('#summary-state').getAttribute('data-state')==='stale');
 check('refresh_requires_file_reselection',await page.locator('#source-media audio,#source-media video').count()===0);
 await page.locator('#mode-transcript').click();await page.locator('.segment[data-segment-id="second"] .note-button').click();
 check('refresh_keeps_notes',await page.locator('#note').inputValue()==='Synthetic note survives mode changes');
 check('zero_model_upload_or_external_requests',mutations===0&&external===0);
 check('zero_uncaught_browser_errors',pageErrors===0);
 // Mobile is the same complete reader, with no horizontal overflow.
 await page.locator('#close-note').click();await page.setViewportSize({width:390,height:844});await page.locator('#mode-summary').click();
 check('mobile_summary_fits',await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 console.log(JSON.stringify({suite:'static-web-podcast',status:'passed',checks}));
} catch {
 console.log(JSON.stringify({suite:'static-web-podcast',status:'failed',stage,checks}));process.exitCode=1;
} finally {
 await browser?.close();await new Promise(resolve=>server?.listening?server.close(resolve):resolve());
 if(directory)await fs.rm(directory,{recursive:true,force:true});
}
