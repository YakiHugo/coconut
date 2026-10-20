/** Real React/HTTP/M4A decoding; authored bytes only, not platform evidence. */
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {startBridge} from '../desktop/server.mjs';
import {createVideoAudioService} from '../desktop/video-audio-service.mjs';
const url='https://www.youtube.com/watch?v=abcdefghijk',errors=[],forbidden=[],asrRequests=[];
const bytes=await readFile(new URL('./fixtures/authored-video-audio.m4a',import.meta.url)),sha256=createHash('sha256').update(bytes).digest('hex');
let status='no_matching_captions',mediaCalls=0,completed=0,browser,hold,release,mode='denied';
const helper={extractAudio:async()=>{
 mediaCalls++;if(hold)await hold;completed++;
 if(mode==='denied')return {status:'access_restricted'};
 return {status:'media_ready',bytes,media:{bytes:bytes.length,sha256,type:'audio/mp4',kind:'audio'},source:{url,id:'abcdefghijk',provider:'youtube',title:'Authored A/B tone',duration:2,subtitle_check:'no_matching_captions',audio_language:'en',audio_language_basis:'platform_original',format:'m4a'}};
}};
const directory=await mkdtemp(path.join(os.tmpdir(),'coconut-video-audio-ui-'));
const server=await startBridge({port:0,libraryDirectory:directory,
 captionService:{available:true,providers:['youtube'],importCaption:async()=>({status,message:'Authored '+status})},
 videoAudioService:createVideoAudioService({helper}),providers:{status:async()=>({ready:false}),ask:()=>assert.fail('No model calls')}});
const origin='http://127.0.0.1:'+server.address().port;
const state=()=>fetch(origin+'/api/v1/library').then(r=>r.json());
try{
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1360,height:960},serviceWorkers:'block'});
 await context.addInitScript(()=>{window.__authoredPlays=0;document.addEventListener('play',()=>window.__authoredPlays++,true);});
 await context.route('**/*',route=>{const target=new URL(route.request().url());if(target.origin!==origin){forbidden.push(target.origin);return route.abort();}if(target.pathname.includes('/ingestions/upload')||target.pathname.includes('/ingestions/capabilities'))asrRequests.push(target.pathname);return route.continue();});
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 const button=page.getByRole('button',{name:'下载公开音轨并新建项目（最多 200 MiB）',exact:true});
 const read=async()=>{await page.getByLabel('播客或视频链接').fill(url);await page.getByRole('button',{name:'打开链接',exact:true}).click();};
 await page.goto(origin);await read();await expect(button).toBeVisible();assert.equal(mediaCalls,0);
 for(const width of [1360,390]){
  await page.setViewportSize({width,height:960});await expect(button).toBeVisible();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const image=await page.screenshot({fullPage:true}),base64=image.toString('base64');
  for(let offset=0;offset<base64.length;offset+=8000)console.log('COCONUT_VIDEO_UI_IMAGE '+JSON.stringify({width,offset,total:base64.length,data:base64.slice(offset,offset+8000)}));
 }
 await button.click();await expect(page.locator('.source-error')).toContainText('来源明确限制访问');assert.equal(mediaCalls,1);await expect(button).toHaveCount(0);
 for(const next of ['access_restricted','network_unavailable','caption_parse_failed','language_required','metadata_incomplete']){
  status=next;await page.getByRole('button',{name:'打开链接',exact:true}).click();
  await expect(page.locator('.source-error')).toContainText(next);await expect(button).toHaveCount(0);assert.equal(mediaCalls,1);
 }
 assert.equal((await state()).sequence,0);
 status='no_matching_captions';mode='ready';
 // Late success after explicit cancellation must not create any project.
 await read();hold=new Promise(resolve=>release=resolve);await button.click();await expect.poll(()=>mediaCalls).toBe(2);
 await page.getByRole('button',{name:'取消读取',exact:true}).click();release();hold=null;await expect.poll(()=>completed).toBe(2);
 await expect(page.locator('.source-error')).toContainText('读取已取消');assert.equal((await state()).sequence,0);
 // Changing the source while the same request is pending also retires ownership.
 await read();hold=new Promise(resolve=>release=resolve);await button.click();await expect.poll(()=>mediaCalls).toBe(3);
 await page.getByLabel('播客或视频链接').fill('https://www.youtube.com/watch?v=zzzzzzzzzzz');release();hold=null;await expect.poll(()=>completed).toBe(3);await expect(button).toHaveCount(0);assert.equal((await state()).sequence,0);
 // Successful authored audio uses the actual endpoint, File fingerprint, store,
 // canonical library and browser decoder. It must not start playback or ASR.
 await read();await button.click();await expect(page.getByRole('heading',{name:'先播放原文件',exact:true})).toBeVisible();
 await expect(page.locator('.app-header').getByText('已保存',{exact:true})).toBeVisible();
 await expect(page.locator('audio')).toBeVisible();await expect.poll(()=>page.locator('audio').evaluate(player=>player.duration)).toBeGreaterThan(1.9);
 assert.equal(await page.locator('audio').evaluate(player=>player.paused),true);assert.equal(await page.evaluate(()=>window.__authoredPlays),0);
 await expect(page.getByRole('button',{name:'生成文字稿',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'生成文字稿',exact:true})).toBeDisabled();
 const catalog=await fetch(origin+'/api/v1/library/catalog?protocolVersion=1').then(r=>r.json());assert.equal(catalog.entries.length,1);
 const key=catalog.entries[0].key,document=(await fetch(origin+'/api/v1/library/document?protocolVersion=1&key='+encodeURIComponent(key)).then(r=>r.json())).record.document;
 assert.equal(document.source_url,url);assert.equal(document.title,'Authored A/B tone');assert.equal(document.project_kind,'audio_only');assert.equal(document.local_media_source.type,'audio/mp4');assert.equal(document.local_media_source.name,'coconut-Authored A_B tone.m4a');assert.equal(document.media_provenance.sha256,sha256);assert.equal(document.media_provenance.audio_language_basis,'platform_original');
 assert.deepEqual(asrRequests,[]);assert.deepEqual(errors,[]);assert.deepEqual(forbidden,[]);
 console.log('PASS authored video fallback UI: absence-only action, denial/cancel/source-change create no project, successful M4A decoder/File/canonical binding, no automatic playback or ASR, wide/narrow layout.');
}finally{release?.();await browser?.close();await server.shutdown();await rm(directory,{recursive:true,force:true});}
