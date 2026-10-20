/** Real React + HTTP, authored caption absence/denial; not a live source proof. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {startBridge} from '../desktop/server.mjs';
const url='https://www.youtube.com/watch?v=abcdefghijk',errors=[],forbidden=[];
let status='no_matching_captions',mediaCalls=0,browser;
const directory=await mkdtemp(path.join(os.tmpdir(),'coconut-video-audio-ui-'));
const server=await startBridge({port:0,libraryDirectory:directory,
 captionService:{available:true,providers:['youtube'],importCaption:async()=>({status,message:'Authored '+status})},
 videoAudioService:{available:true,download:async()=>{mediaCalls++;throw Object.assign(Error('Authored access recheck denied'),{code:'access_restricted',status:409});}},
 providers:{status:async()=>({ready:false}),ask:()=>assert.fail('No model calls')}});
const origin='http://127.0.0.1:'+server.address().port;
try{
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1360,height:960},serviceWorkers:'block'});
 await context.route('**/*',route=>{const target=new URL(route.request().url());if(target.origin!==origin){forbidden.push(target.origin);return route.abort();}return route.continue();});
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin);await page.getByLabel('播客或视频链接').fill(url);await page.getByRole('button',{name:'打开链接',exact:true}).click();
 const button=page.getByRole('button',{name:'下载公开原声并新建项目（最多 200 MiB）',exact:true});
 await expect(button).toBeVisible();assert.equal(mediaCalls,0);
 for(const width of [1360,390]){
  await page.setViewportSize({width,height:960});await expect(button).toBeVisible();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const bytes=await page.screenshot({fullPage:true}),base64=bytes.toString('base64');
  for(let offset=0;offset<base64.length;offset+=8000)console.log('COCONUT_VIDEO_UI_IMAGE '+JSON.stringify({width,offset,total:base64.length,data:base64.slice(offset,offset+8000)}));
 }
 await button.click();await expect(page.locator('.source-error')).toContainText('Authored access recheck denied');assert.equal(mediaCalls,1);await expect(button).toHaveCount(0);
 for(const next of ['access_restricted','network_unavailable','caption_parse_failed','language_required','metadata_incomplete']){
  status=next;await page.getByRole('button',{name:'打开链接',exact:true}).click();
  await expect(page.locator('.source-error')).toContainText(next);await expect(button).toHaveCount(0);assert.equal(mediaCalls,1);
 }
 assert.equal((await fetch(origin+'/api/v1/library').then(r=>r.json())).sequence,0);
 assert.deepEqual(errors,[]);assert.deepEqual(forbidden,[]);
 console.log('PASS authored video fallback UI: absence-only explicit action, recheck denial, no automatic media/model calls, no library mutation, wide/narrow layout.');
}finally{await browser?.close();await server.shutdown();await rm(directory,{recursive:true,force:true});}
