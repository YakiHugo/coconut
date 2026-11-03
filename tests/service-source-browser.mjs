/** Real browsers + SQLite + stored WAV. ASR receipts are authored, no inference. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {startService} from '../server/main.mjs';
const directory=await mkdtemp(path.join(tmpdir(),'coconut-source-browser-')),token='authored-source-browser-token-with-32-characters';
const doc={schema_version:1,key:'authored-server-source',title:'Authored server source',language:'en',project_kind:'audio_only',transcript_status:'not_imported',source_url:'https://example.test/episode',podcast_source:{kind:'direct_media',media_url:'https://example.test/audio.wav',media_kind:'audio'},project_note:'Keep this project note',timestamp_bookmarks:[{id:'bookmark',time:0.5,note:'Keep this bookmark'}],segments:[]};
const wav=Buffer.alloc(32044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);
let server,browser,origin,env,release,downloads=0,uploads=0,upstream,operation;const gate=new Promise(resolve=>release=resolve),requests=[];
const executor={status:async()=>({available:true,model_download:false}),recover:async value=>{if(!upstream)throw Object.assign(Error('missing'),{taskCode:'ingestion_operation_not_found'});assert.equal(value.operation_id,operation.operation_id);return upstream;},upload:async(body,options)=>{assert.deepEqual(Buffer.concat(await Array.fromAsync(body)),wav);uploads++;operation=options;upstream={id:'b'.repeat(32),state:'running'};return upstream;},result:async()=>({...upstream,transcript:{document:{schema_version:1,title:'Authored speech',language:'en',segments:[{id:'first',start:0,end:1,text:'Authored speech for browser acceptance'}],source_media:{job_id:upstream.id,kind:'audio'}}}})};
const start=async()=>{const started=await startService({env,ingestionExecutor:executor,podcastSources:{downloadMedia:async()=>{downloads++;await gate;return {body:wav,type:'audio/wav'};}}});server=started.server;};
async function login(width=1360){const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();page.on('request',request=>requests.push({path:new URL(request.url()).pathname,method:request.method()}));await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());await page.goto(origin+'/');await page.getByLabel('访问密钥').fill(token);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:/我的内容/})).toBeVisible();return {context,page};}
try{
 env={COCONUT_PORT:'0',COCONUT_DATA_DIRECTORY:directory};await start();const port=server.address().port;await server.shutdown();origin=`http://localhost:${port}`;env={...env,COCONUT_PORT:String(port),COCONUT_PUBLIC_ORIGIN:origin,COCONUT_OWNER_TOKEN:token};await start();
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 let {context,page}=await login();
 await page.evaluate(async({doc,receiptKey})=>{const epoch=await fetch('api/v1/library').then(r=>r.json()).then(data=>data.epoch);const response=await fetch('api/v1/library/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:1,epoch,receiptKey,key:doc.key,expected:null,action:'put',document:doc})});if(!response.ok)throw Error(await response.text());},{doc,receiptKey:randomUUID()});
 await page.goto(origin+'/#read/'+doc.key);await page.reload();await expect(page.getByRole('button',{name:'载入并保存原声',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'载入并保存原声',exact:true}).click();await expect(page.getByText('已交给所连接的服务执行。关闭页面后可重新打开此项目查看。')).toBeVisible();await context.close();release();
 ({context,page}=await login(390));await page.goto(origin+'/#read/'+doc.key);await expect(page.locator('audio')).toHaveAttribute('src',/api\/v1\/source-media\/content/,{timeout:15000});
 await page.getByLabel('确认使用服务中已有的模型识别原声').check();await page.getByRole('button',{name:'生成文字稿',exact:true}).click();await expect.poll(()=>uploads).toBe(1);await context.close();
 upstream={...upstream,state:'ready'};await server.shutdown();await start();
 ({context,page}=await login());await page.goto(origin+'/#read/'+doc.key);await page.locator('.activity-center > summary').click();await expect(page.getByRole('button',{name:'将文字稿接入原项目',exact:true})).toBeVisible();let releaseResult,resultReceived;const resultGate=new Promise(resolve=>releaseResult=resolve),received=new Promise(resolve=>resultReceived=resolve);
 await page.route('**/api/v1/source-jobs/*/result',async route=>{const response=await route.fetch();resultReceived();await resultGate;await route.fulfill({response});});
 await page.getByRole('button',{name:'将文字稿接入原项目',exact:true}).click();await received;
 await page.evaluate(()=>{const client=window.CoconutClientCapabilities;client.observe({...client.current,id:'authored-different-connection',libraryId:'authored-different-library'});});releaseResult();
 await expect(page.getByText('Authored speech for browser acceptance',{exact:true})).toHaveCount(0);
 assert.equal(await page.evaluate(async key=>(await fetch('api/v1/library/document?protocolVersion=1&key='+key).then(r=>r.json())).record.document.segments.length,doc.key),0);
 await page.reload();await page.locator('.activity-center > summary').click();await page.getByRole('button',{name:'将文字稿接入原项目',exact:true}).click();
 await expect(page.getByText('Authored speech for browser acceptance',{exact:true}).first()).toBeVisible();
 await expect.poll(()=>page.evaluate(async key=>(await fetch('api/v1/library/document?protocolVersion=1&key='+key).then(r=>r.json())).record.document.segments.length,doc.key)).toBe(1);
 const stored=await page.evaluate(async key=>(await fetch('api/v1/library/document?protocolVersion=1&key='+key).then(r=>r.json())).record.document,doc.key);assert.equal(stored.project_note,doc.project_note);assert.deepEqual(stored.timestamp_bookmarks,doc.timestamp_bookmarks);assert.equal(stored.segments.length,1);
 await page.reload();await expect(page.getByText('Authored speech for browser acceptance',{exact:true}).first()).toBeVisible();assert.equal(downloads,1);assert.equal(uploads,1);
 assert.deepEqual(requests.filter(r=>r.method==='POST'&&['/api/podcasts/media','/api/v1/source-media','/api/v1/ingestions/upload'].includes(r.path)),[]);
 await context.close();console.log('Cross-browser source download, stored playback, ASR recovery, restart and explicit transcript attachment passed. ASR receipts simulated.');
}finally{release();await browser?.close();await server?.shutdown();await rm(directory,{recursive:true,force:true});}
