/** Real React/HTTP/M4A/MP4 decoding; authored bytes only, not platform evidence. */
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {startBridge} from '../desktop/server.mjs';
import {createVideoAudioService} from '../desktop/video-audio-service.mjs';
const url='https://www.youtube.com/watch?v=abcdefghijk',errors=[],forbidden=[],asrRequests=[];
const audioBytes=await readFile(new URL('./fixtures/authored-video-audio.m4a',import.meta.url)),videoBytes=await readFile(new URL('./fixtures/authored-source-video.mp4',import.meta.url)),sha256=createHash('sha256').update(audioBytes).digest('hex');
// Keep the complete metadata boxes and corrupt only encoded samples. This
// catches metadata-only admission that can create an unusable project.
const brokenVideo=Buffer.from(videoBytes);let mediaBoxes=0,metadataBoxes=0;
for(let offset=0;offset<brokenVideo.length;){
 const size=brokenVideo.readUInt32BE(offset),type=brokenVideo.toString('ascii',offset+4,offset+8);
 assert.ok(size>=8&&offset+size<=brokenVideo.length);
 if(type==='mdat'){brokenVideo.fill(0,offset+8,offset+size);mediaBoxes++;}
 if(type==='moov')metadataBoxes++;
 offset+=size;
}
assert.equal(mediaBoxes,1);assert.equal(metadataBoxes,1);
let status='no_matching_captions',mediaCalls=0,completed=0,browser,hold,release,mode='denied';
const helper={extractAudio:async()=>{
 mediaCalls++;if(hold)await hold;completed++;
 if(mode==='denied')return {status:'access_restricted'};
 const video=mode==='video'||mode==='invalid'||mode==='broken_samples',bytes=mode==='invalid'?Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom invalid authored container')]):mode==='broken_samples'?brokenVideo:video?videoBytes:audioBytes;
 return {status:'media_ready',bytes,media:{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),type:video?'video/mp4':'audio/mp4',kind:video?'video':'audio'},source:{url,id:'abcdefghijk',provider:'youtube',title:video?'Authored source video':'Authored A/B tone',duration:2,subtitle_check:'no_matching_captions',audio_language:video?null:'en',audio_language_basis:video?'platform_video_stream':'platform_original',audio_role:video?'unknown':'original',format:video?'mp4':'m4a',format_id:video?'18':'140'}};
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
 const button=page.getByRole('button',{name:'下载公开媒体并新建项目（最多 200 MiB）',exact:true});
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
 await expect(page.locator('audio')).toHaveCount(1);await expect(page.getByRole('button',{name:'播放原声',exact:true})).toBeVisible();await expect.poll(()=>page.locator('audio').evaluate(player=>player.duration)).toBeGreaterThan(1.9);
 assert.equal(await page.locator('audio').evaluate(player=>player.paused),true);assert.equal(await page.evaluate(()=>window.__authoredPlays),0);
 await expect(page.getByRole('button',{name:'生成文字稿',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'生成文字稿',exact:true})).toBeDisabled();
 const catalog=await fetch(origin+'/api/v1/library/catalog?protocolVersion=1').then(r=>r.json());assert.equal(catalog.entries.length,1);
 const key=catalog.entries[0].key,document=(await fetch(origin+'/api/v1/library/document?protocolVersion=1&key='+encodeURIComponent(key)).then(r=>r.json())).record.document;
 assert.equal(document.source_url,url);assert.equal(document.title,'Authored A/B tone');assert.equal(document.project_kind,'audio_only');assert.equal(document.local_media_source.type,'audio/mp4');assert.equal(document.local_media_source.name,'coconut-Authored A_B tone.m4a');assert.equal(document.media_provenance.sha256,sha256);assert.equal(document.media_provenance.audio_language_basis,'platform_original');

 // A valid protocol receipt with undecodable media must not create a project.
 await page.getByRole('button',{name:'添加内容',exact:true}).click();mode='invalid';await read();await button.click();
 await expect(page.locator('.source-error')).toContainText('无法解码');assert.equal((await fetch(origin+'/api/v1/library/catalog?protocolVersion=1').then(r=>r.json())).entries.length,1);
 // The browser can read intact duration/dimensions before discovering broken
 // sample payloads. That metadata alone must never authorize a project.
 const metadataOnly=await page.evaluate(async base64=>{
  const video=document.createElement('video'),bytes=Uint8Array.from(atob(base64),value=>value.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));
  video.preload='metadata';video.muted=true;
  try{return await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Broken-sample metadata probe timed out')),5000);
   video.addEventListener('loadedmetadata',()=>{clearTimeout(timer);resolve({duration:video.duration,width:video.videoWidth});},{once:true});
   video.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Broken sample did not preserve readable metadata'));},{once:true});
   video.src=url;video.load();
  });}finally{video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
 },brokenVideo.toString('base64'));
 assert.equal(metadataOnly.width,160);assert.ok(metadataOnly.duration>1.9);
 mode='broken_samples';await read();await button.click();
 await expect(page.locator('.source-error')).toContainText(/无法解码|解码超时/,{timeout:15000});
 assert.equal((await fetch(origin+'/api/v1/library/catalog?protocolVersion=1').then(r=>r.json())).entries.length,1);
 // Combined MP4 stays a video player/File, not a mislabeled audio-only file.
 mode='video';await read();await button.click();await page.locator('.rw-player-video>summary').click();await expect(page.locator('video')).toBeVisible();
 await expect(page.locator('.app-header').getByText('已保存',{exact:true})).toBeVisible();
 await expect.poll(()=>page.locator('video').evaluate(player=>player.videoWidth)).toBe(160);
 await expect.poll(()=>page.locator('video').evaluate(player=>player.duration)).toBeGreaterThan(1.9);
 assert.equal(await page.locator('video').evaluate(player=>player.paused),true);assert.equal(await page.evaluate(()=>window.__authoredPlays),0);
 const videoCatalog=await fetch(origin+'/api/v1/library/catalog?protocolVersion=1').then(r=>r.json());assert.equal(videoCatalog.entries.length,2);
 const videoKey=videoCatalog.entries.find(entry=>entry.key!==key).key;
 const videoDocument=(await fetch(origin+'/api/v1/library/document?protocolVersion=1&key='+encodeURIComponent(videoKey)).then(r=>r.json())).record.document;
 assert.equal(videoDocument.source_url,url);assert.equal(videoDocument.local_media_source.kind,'video');assert.equal(videoDocument.local_media_source.type,'video/mp4');assert.equal(videoDocument.local_media_source.name,'coconut-Authored source video.mp4');assert.equal(videoDocument.media_provenance.container,'mp4');assert.equal(videoDocument.media_provenance.audio_role,'unknown');assert.equal(videoDocument.media_provenance.audio_language,null);
 await expect(page.getByRole('button',{name:'生成文字稿',exact:true})).toBeDisabled();
 for(const width of [1360,390]){
  await page.setViewportSize({width,height:960});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const base64=(await page.screenshot({fullPage:true})).toString('base64');
  for(let offset=0;offset<base64.length;offset+=8000)console.log('COCONUT_VIDEO_SUCCESS_IMAGE '+JSON.stringify({width,offset,total:base64.length,data:base64.slice(offset,offset+8000)}));
 }
 assert.deepEqual(asrRequests,[]);assert.deepEqual(errors,[]);assert.deepEqual(forbidden,[]);
 console.log('PASS authored video fallback UI: absence-only action, denial/cancel/source-change create no project, successful M4A and combined MP4 decoder/File/canonical binding; invalid container and metadata-valid broken samples create no project, no automatic playback or ASR, wide/narrow layout.');
}finally{release?.();await browser?.close();await server.shutdown();await rm(directory,{recursive:true,force:true});}
