/** Real browsers + SQLite + stored WAV. ASR receipts are authored, no inference. */
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {startService} from '../server/main.mjs';
const directory=await mkdtemp(path.join(tmpdir(),'coconut-source-browser-')),token='authored-source-browser-token-with-32-characters';
const doc={schema_version:1,key:'authored-server-source',title:'Authored server source',language:'en',project_kind:'audio_only',transcript_status:'not_imported',source_url:'https://example.test/episode',podcast_source:{kind:'direct_media',media_url:'https://example.test/audio.wav',media_kind:'audio'},project_note:'Keep this project note',timestamp_bookmarks:[{id:'bookmark',time:0.5,note:'Keep this bookmark'}],segments:[]};
const wav=Buffer.alloc(32044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);
let mediaBytes=wav;
let server,browser,origin,env,release,downloads=0,uploads=0,finishTranscription;const gate=new Promise(resolve=>release=resolve),requests=[];
const transcriber={profile:{backend:'authored'},status:async()=>({available:true,model_download:false}),run:async({inputPath,workDirectory,signal,onProgress})=>{assert.deepEqual(await readFile(inputPath),mediaBytes);uploads++;onProgress({phase:'align'});await new Promise((resolve,reject)=>{finishTranscription=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});await writeFile(path.join(workDirectory,'result.json'),JSON.stringify({schema_version:1,title:'Authored speech',language:'en',segments:[{id:'first',start:0,end:1,text:'Authored speech for browser acceptance'}]}));}};
const start=async()=>{const started=await startService({env,transcriber,podcastSources:{downloadMedia:async()=>{downloads++;await gate;if(downloads>1){mediaBytes=Buffer.from(wav);mediaBytes[44]=1;}return {body:mediaBytes,type:'audio/wav'};}}});server=started.server;};
async function openProject(page){await page.getByRole('button',{name:/我的内容/}).click();await page.getByRole('button',{name:/^Authored server source/}).click();}
async function login(width=1360){const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();page.on('request',request=>requests.push({path:new URL(request.url()).pathname,method:request.method()}));await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());await page.goto(origin+'/');await page.getByLabel('访问密钥').fill(token);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:/我的内容/})).toBeVisible();return {context,page};}
try{
 env={COCONUT_PORT:'0',COCONUT_DATA_DIRECTORY:directory};await start();const port=server.address().port;await server.shutdown();origin=`http://localhost:${port}`;env={...env,COCONUT_PORT:String(port),COCONUT_PUBLIC_ORIGIN:origin,COCONUT_OWNER_TOKEN:token};await start();
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 let {context,page}=await login();
 await page.evaluate(async({doc,receiptKey})=>{const epoch=await fetch('api/v1/library').then(r=>r.json()).then(data=>data.epoch);const response=await fetch('api/v1/library/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:1,epoch,receiptKey,key:doc.key,expected:null,action:'put',document:doc})});if(!response.ok)throw Error(await response.text());},{doc,receiptKey:randomUUID()});
 await page.reload();await openProject(page);await expect(page.getByRole('button',{name:'载入并保存原声',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'载入并保存原声',exact:true}).click();await expect(page.getByRole('region',{name:'服务端原声与文字稿',exact:true}).getByText('任务已提交。',{exact:true})).toBeVisible();await context.close();release();
 ({context,page}=await login(390));await openProject(page);await expect(page.locator('audio')).toHaveAttribute('src',/api\/v1\/source-media\/content/,{timeout:15000});
 const previousURL=await page.locator('audio').getAttribute('src');await page.locator('.activity-trigger').click();await page.getByRole('button',{name:'重新获取原声',exact:true}).click();await expect.poll(()=>page.locator('audio').getAttribute('src')).not.toBe(previousURL);assert.equal((await context.request.get(new URL(await page.locator('audio').getAttribute('src'),origin).href)).status(),200);
 await page.getByRole('button',{name:'关闭任务与状态',exact:true}).click();
 await page.getByLabel('确认使用服务中已有的模型识别原声').check();await page.getByRole('button',{name:'生成文字稿',exact:true}).click();await expect.poll(()=>uploads).toBe(1);await context.close();
 finishTranscription();({context,page}=await login());await expect.poll(async()=>(await context.request.get(origin+'/api/v1/source-jobs?'+new URLSearchParams({key:doc.key}))).json().then(value=>value.jobs.find(job=>job.kind==='transcribe')?.state)).toBe('ready');await context.close();await server.shutdown();await start();
 ({context,page}=await login());await openProject(page);await page.locator('.activity-trigger').click();await expect(page.getByRole('button',{name:'将文字稿接入原项目',exact:true})).toBeVisible();let releaseResult,resultReceived;const resultGate=new Promise(resolve=>releaseResult=resolve),received=new Promise(resolve=>resultReceived=resolve);
 const rejectResult=route=>route.fulfill({status:503,json:{error:'Authored result temporarily unavailable'}});
 await page.route('**/api/v1/source-jobs/*/result',rejectResult);await page.getByRole('button',{name:'将文字稿接入原项目',exact:true}).click();await expect(page.getByRole('dialog',{name:'任务与状态',exact:true}).getByRole('status')).toContainText('Authored result temporarily unavailable');await page.unroute('**/api/v1/source-jobs/*/result',rejectResult);
 await page.route('**/api/v1/source-jobs/*/result',async route=>{const response=await route.fetch();resultReceived();await resultGate;await route.fulfill({response});});
 await page.getByRole('button',{name:'将文字稿接入原项目',exact:true}).click();await received;
 await page.evaluate(()=>{const client=window.CoconutClientCapabilities;client.observe({...client.current,id:'authored-different-connection',libraryId:'authored-different-library'});});const resultFinished=page.waitForEvent('requestfinished',request=>new URL(request.url()).pathname.endsWith('/result'));releaseResult();await resultFinished;await page.evaluate(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});
 await expect(page.getByText('Authored speech for browser acceptance',{exact:true})).toHaveCount(0);
 assert.equal(await page.evaluate(async key=>(await fetch('api/v1/library/document?protocolVersion=1&key='+key).then(r=>r.json())).record.document.segments.length,doc.key),0);
 await page.reload();await page.locator('.activity-trigger').click();await page.getByRole('button',{name:'将文字稿接入原项目',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'任务与状态',exact:true}).getByRole('status')).toContainText('文字稿已保存。');await page.getByRole('button',{name:'关闭任务与状态',exact:true}).click();
 await expect(page.getByText('Authored speech for browser acceptance',{exact:true}).first()).toBeVisible();
 await expect.poll(()=>page.evaluate(async key=>(await fetch('api/v1/library/document?protocolVersion=1&key='+key).then(r=>r.json())).record.document.segments.length,doc.key)).toBe(1);
 const stored=await page.evaluate(async key=>(await fetch('api/v1/library/document?protocolVersion=1&key='+key).then(r=>r.json())).record.document,doc.key);assert.equal(stored.project_note,doc.project_note);assert.deepEqual(stored.timestamp_bookmarks,doc.timestamp_bookmarks);assert.equal(stored.segments.length,1);
 await page.reload();await expect(page.getByText('Authored speech for browser acceptance',{exact:true}).first()).toBeVisible();assert.equal(downloads,2);assert.equal(uploads,1);
 assert.deepEqual(requests.filter(r=>r.method==='POST'&&['/api/podcasts/media','/api/v1/source-media','/api/v1/ingestions/upload'].includes(r.path)),[]);
 await context.close();console.log('Cross-browser source download, stored playback, ASR recovery, restart and explicit transcript attachment passed. Transcription computation simulated; real direct-file task lifecycle.');
}finally{release();await browser?.close();await server?.shutdown();await rm(directory,{recursive:true,force:true});}
