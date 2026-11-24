/** Authored HTTP/queue/native decoding fixture; not public-platform evidence. */
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {startBridge} from '../desktop/server.mjs';
import {createVideoAudioService} from '../desktop/video-audio-service.mjs';
const audio=await readFile(new URL('./fixtures/authored-video-audio.m4a',import.meta.url)),video=await readFile(new URL('./fixtures/authored-source-video.mp4',import.meta.url));
const directory=await mkdtemp(path.join(os.tmpdir(),'coconut-durable-video-ui-'));
let browser,calls=0,release;const errors=[],forbidden=[],unexpected=[];
const gate=new Promise(resolve=>release=resolve);
const helper={extractAudio:async({url,purpose,audioOnly})=>{
 assert.equal(purpose,'source');assert.equal(audioOnly,true);
 calls++;const id=new URL(url).searchParams.get('v');if(id==='abcdefghijk')await gate;if(id==='deniedxxxxx')return {status:'access_restricted'};
 const combined=id==='videoxxxxxx',bytes=combined?video:audio;
 return {status:'media_ready',bytes,media:{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),type:combined?'video/mp4':'audio/mp4',kind:combined?'video':'audio'},source:{url,id,purpose,provider:'youtube',title:'Authored fixture',duration:2,subtitle_check:'no_matching_captions',audio_language:combined?null:'en',audio_language_basis:combined?'platform_video_stream':'platform_original',audio_role:combined?'unknown':'original',format:combined?'mp4':'m4a',format_id:combined?'18':'140'}};
}};
const server=await startBridge({port:0,libraryDirectory:directory,enableSourceJobs:true,
 captionService:{available:true,providers:['youtube'],importCaption:async({url,authorOnly})=>{
  assert.equal(authorOnly,true);
  return url.endsWith('deniedxxxxx')?{status:'ready',document:{title:'Authored caption with blocked audio',language:'en',source_url:url,
   provenance:{kind:'platform_subtitles',source_platform:'youtube',media_id:'deniedxxxxx'},segments:[{id:'proof',start:0,end:1,text:'Author caption stays readable.'}]}}
   :{status:'author_captions_absent'};
 }},
 videoAudioService:createVideoAudioService({helper,sourceMedia:true}),providers:{status:async()=>({ready:false}),ask:()=>assert.fail('No model calls')}});
const origin='http://127.0.0.1:'+server.address().port;
const catalog=()=>fetch(origin+'/api/v1/library/catalog?protocolVersion=1').then(r=>r.json());
const document=key=>fetch(origin+'/api/v1/library/document?protocolVersion=1&key='+encodeURIComponent(key)).then(r=>r.json()).then(r=>r.record.document);
const jobs=key=>fetch(origin+'/api/v1/source-jobs?key='+encodeURIComponent(key)).then(r=>r.json()).then(r=>r.jobs);
try{
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1360,height:960},serviceWorkers:'block'});
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin){forbidden.push(url.origin);return route.abort();}if(url.pathname==='/api/videos/media'||url.pathname.includes('/ingestions/upload'))unexpected.push(url.pathname);return route.continue();});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const read=async id=>{await page.getByLabel('播客或视频链接').fill('https://www.youtube.com/watch?v='+id);await page.getByRole('button',{name:'打开链接',exact:true}).click();};
 await page.goto(origin);await read('abcdefghijk');await expect.poll(()=>calls).toBe(1);await expect.poll(async()=>(await catalog()).entries.length).toBe(1);
 const key=(await catalog()).entries[0].key;await expect(page).toHaveURL(new RegExp('#read/'+encodeURIComponent(key)+'$'));
 const pending=await document(key);assert.deepEqual(pending.video_source,{version:1,provider:'youtube',media_id:'abcdefghijk'});assert.equal(pending.local_media_source,undefined);assert.equal(pending.media_duration,undefined);assert.equal(await page.locator('audio').count(),0);
 // Reload does not cancel durable work. Readiness is not assumed to mean decodability.
 await page.reload();release();await expect.poll(async()=>(await jobs(key)).find(job=>job.kind==='download')?.state).toBe('ready');
 await expect(page.locator('audio')).toHaveCount(1);await expect.poll(()=>page.locator('audio').evaluate(p=>p.duration)).toBeGreaterThan(1.9);assert.equal(await page.locator('audio').evaluate(p=>p.paused),true);
 await page.locator('audio').evaluate(async p=>{p.currentTime=1;await p.play();});await expect.poll(()=>page.locator('audio').evaluate(p=>p.currentTime)).toBeGreaterThan(1);await page.locator('audio').evaluate(p=>p.pause());assert.match(await page.locator('audio').getAttribute('src'),/api\/v1\/source-media\/content/);
 await page.reload();await expect.poll(()=>page.locator('audio').evaluate(p=>p.duration)).toBeGreaterThan(1.9);assert.equal(calls,1);
 await page.getByRole('button',{name:'添加内容',exact:true}).click();await read('deniedxxxxx');await expect.poll(async()=>(await catalog()).entries.length).toBe(2);const denied=(await catalog()).entries.find(e=>e.key!==key).key;await expect.poll(async()=>(await jobs(denied)).find(job=>job.kind==='download')?.state).toBe('failed');await expect(page.getByRole('button',{name:'重试获取原声',exact:true})).toBeVisible();assert.equal(await page.locator('audio,video').count(),0);await expect(page.locator('[data-source-id="proof"]')).toHaveText('Author caption stays readable.');assert.equal((await document(denied)).segments.length,1);
 await page.getByRole('button',{name:'添加内容',exact:true}).click();await read('videoxxxxxx');
 await expect(page.getByRole('button',{name:'重试获取原声',exact:true})).toBeVisible();
 await expect(page.locator('audio,video')).toHaveCount(0);
 for(const width of [1360,390]){await page.setViewportSize({width,height:960});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);assert.deepEqual(forbidden,[]);
 console.log('PASS authored durable video: pending source, background save/reload, native decode/seek, independent caption save and audio-only acquisition; no browser download/reupload/model calls.');
}finally{release();await browser?.close();await server.shutdown();await rm(directory,{recursive:true,force:true});}
