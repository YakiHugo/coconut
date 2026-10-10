/** Authored CI-only browser proof. Never run locally where Chromium is denied. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from './helpers/browser-storage.mjs';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
let browser,server,directory,stage='setup',external=0;
const checks=[],errors=[],geometry=[];
function check(name,value){stage=name;assert.ok(value,name);checks.push(name);}
try{
 directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-follow-'));
 const audio=path.join(directory,'authored-follow.wav');await fs.writeFile(audio,authoredAudioFixture(700));
 const reader=new URL('../reader/',import.meta.url);
 server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
  if(req.method!=='GET'||!/^[a-z-]+\.(html|js|css|png)$/.test(name)){res.writeHead(404).end();return;}
  try{res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html');res.end(await fs.readFile(new URL(name,reader)));}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce',hasTouch:true,serviceWorkers:'block'});
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||url.protocol==='blob:')return route.continue();external++;return route.abort();});
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);
 await page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='ready');
 const fixture={title:'Authored follow reading',language:'en',segments:Array.from({length:151},(_,i)=>({id:'cue-'+i,start:i*4,end:i*4+4,text:'This is authored reading passage '+i+'. The original voice stays alongside its words.'}))};
 await page.locator('#file').setInputFiles({name:'authored-follow.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
 await page.locator('#mode-transcript').click();
 if(!await page.locator('#attach-reader-media').isVisible())await page.locator('#toggle-reader-media').click();
 const [picker]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-reader-media').click()]);await picker.setFiles(audio);
 await page.waitForFunction(()=>{const p=document.querySelector('audio');return p?.readyState>=2&&p.duration===700;});
 await page.locator('#follow-playback').click();
 check('opt_in_never_autoplays',await page.locator('audio').evaluate(p=>p.paused));
 await page.locator('#follow-playback').tap();check('touch_can_turn_follow_off',await page.locator('#follow-playback').getAttribute('aria-pressed')==='false');
 await page.locator('#follow-playback').tap();
 await page.locator('audio').evaluate(async p=>{p.currentTime=500;await p.play();});
 await page.waitForFunction(()=>document.querySelector('.segment')?.dataset.segmentId==='cue-100');
 check('page_crossing_keeps_follow_control_focus',await page.evaluate(()=>document.activeElement.id==='follow-playback'));
 await page.locator('#media-dock').waitFor({state:'visible'});
 check('playing_cue_is_comfortably_above_dock',await page.evaluate(()=>{const cue=document.querySelector('.segment.playing').getBoundingClientRect(),dock=document.querySelector('#media-dock').getBoundingClientRect();return cue.top>=0&&cue.bottom<=dock.top;}));
 await page.mouse.wheel(0,100);
 await page.waitForFunction(()=>document.querySelector('#dock-follow').dataset.state==='suspended');
 const manualY=await page.evaluate(()=>scrollY);
 await page.locator('audio').evaluate(p=>{p.currentTime=580;p.dispatchEvent(new Event('timeupdate'));});
 await page.waitForTimeout(150);
 check('manual_scroll_remains_owned_by_reader',await page.evaluate(y=>Math.abs(scrollY-y)<2,manualY));
 await page.locator('#dock-follow').click();
 await page.waitForFunction(()=>document.querySelector('.segment.playing')?.dataset.segmentId==='cue-145');
 // Pause leaves the opt-in armed but must not reposition on subsequent seeks.
 await page.locator('audio').evaluate(p=>p.pause());
 for(const width of [320,360,390]){
  await page.setViewportSize({width,height:844});
  const last=page.locator('.segment').last();await last.scrollIntoViewIfNeeded();
  const measurements=await page.evaluate(()=>{
   const dock=document.querySelector('#media-dock').getBoundingClientRect(),buttons=[...document.querySelectorAll('#media-dock button')].filter(b=>!b.hidden).map(b=>{const r=b.getBoundingClientRect();return {id:b.id,x:r.x,y:r.y,width:r.width,height:r.height};});
   return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,dock:{top:dock.top,height:dock.height,right:dock.right},buttons};
  });geometry.push(measurements);
  check('one_row_44px_dock_'+width,!measurements.overflow&&measurements.dock.height<=80&&measurements.dock.right<=width&&measurements.buttons.every(b=>b.width>=44&&b.height>=44)&&Math.max(...measurements.buttons.map(b=>b.y))-Math.min(...measurements.buttons.map(b=>b.y))<2);
  // Real final-cue reachability, then an exact note draft above the same dock.
  await last.evaluate(row=>row.scrollIntoView({block:'center'}));
  check('last_cue_not_covered_'+width,await page.evaluate(()=>{const row=[...document.querySelectorAll('.segment')].at(-1).getBoundingClientRect();return row.bottom<=document.querySelector('#media-dock').getBoundingClientRect().top;}));
  await last.locator('.note-button').click();await page.locator('#note').fill('  exact\n  authored draft  ');
  check('note_editor_not_covered_'+width,await page.evaluate(()=>document.querySelector('#note').getBoundingClientRect().bottom<=document.querySelector('#media-dock').getBoundingClientRect().top));
  await page.locator('audio').evaluate(p=>{p.currentTime=420;p.dispatchEvent(new Event('timeupdate'));});
  check('draft_and_focus_survive_'+width,await page.locator('#note').inputValue()==='  exact\n  authored draft  '&&await page.evaluate(()=>document.activeElement.id==='note'));
  await page.locator('#close-note').click();
 }
 if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'playback-follow-mobile.png')});await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'playback-follow-geometry.json'),JSON.stringify(geometry,null,2));}
 check('no_external_calls_or_page_errors',external===0&&errors.length===0);
 console.log(JSON.stringify({ok:true,checks,geometry,errors},null,2));
}catch(error){console.error(JSON.stringify({ok:false,stage,checks,error:error.stack,geometry,errors},null,2));process.exitCode=1;}
finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());if(directory)await fs.rm(directory,{recursive:true,force:true});}
