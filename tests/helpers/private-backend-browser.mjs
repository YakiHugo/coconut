// Compatibility renderer regression; this suite does not establish default React acceptance.
/** Real bridge authorization, SQLite and task ledger in two Chromium contexts.
 * Only HTTPS/Serve transport is simulated; no tailnet, real login or model. */
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {startBridge} from '../../desktop/server.mjs';
import {openLibraryTools} from './library-tools-browser.mjs';
import {recoveryFixture,sourceId,mediaLibraryIdentity,migrationId} from '../fixtures/canonical-migration.mjs';
const require=createRequire(import.meta.url),Tasks=require('../../reader/task-client.js'),Coconut=require('../../reader/core.js');
export function privateBrowserRecovery(){
 const recovery=recoveryFixture();
 for(const row of recovery.stores.documents){
  row.value.payload.segments=row.value.payload.segments.map((cue,index)=>({...cue,start:index*3,end:index*3+3}));
  Coconut.validate(row.value.payload);
 }
 return recovery;
}
export async function privateBackendBrowser(){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-private-browser-')),contexts=[],errors=[];
 const origin='https://reader.authored.ts.net',owner='owner@example.test';let server,browser,calls=0,remotePosts=0;
 const geometry=[],httpStatus=[],failures=[];let stage='setup',passed=false;
 async function captureConnection(page,label){
  stage='private_'+label;
  for(const width of [390,1280]){
   await page.setViewportSize({width,height:844});await openLibraryTools(page);
   const backup=page.locator('.library-backup');if(!await backup.evaluate(n=>n.open))await backup.locator(':scope > summary').click();
   const hint=backup.locator('p').filter({hasText:label==='connected'?'已连接 Authored computer':'电脑服务已失联或未授权'});
   await hint.waitFor({state:'visible'});await page.evaluate(()=>document.fonts.ready);await hint.scrollIntoViewIfNeeded();
   const bounds=await hint.evaluate(n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,scrollWidth:n.scrollWidth,clientWidth:n.clientWidth};});
   const controls=await backup.locator('button:visible').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {label:n.textContent,left:r.left,right:r.right,width:r.width,height:r.height};}));
   geometry.push({state:label,viewport:width,hint:bounds,controls});
   if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,`private-owner-${label}-${width}.png`),fullPage:false,animations:'disabled'});}
   assert.ok(bounds.left>=-1&&bounds.right<=width+1&&bounds.top>=-1&&bounds.bottom<=bounds.height+1,'private connection status is visible inside viewport');
   assert.ok(bounds.scrollWidth<=bounds.clientWidth+1,'private connection text does not overflow');
   assert.ok(controls.length>0&&controls.every(r=>r.left>=-1&&r.right<=width+1&&r.width>0&&r.height>0),'visible library controls fit horizontally');
  }
  await page.setViewportSize({width:390,height:844});
 }
 try{
  // Canonical authority is intentional here; do not use the static-Web wrapper
  // that requires IndexedDB after every navigation.
  browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
  server=await startBridge({port:0,libraryDirectory:path.join(directory,'library'),taskDirectory:path.join(directory,'tasks'),privateProxy:{type:'tailscale-serve',origin,ownerLogin:owner,backendLabel:'Authored computer'},providers:{status:async()=>({ready:true}),ask:async data=>{calls++;return {answer:'Authored fake summary result',citations:[data.segments[0].id]};}}});
  const local='http://127.0.0.1:'+server.address().port;
  const request=async(url,body)=>{const response=await fetch(local+url,body?{method:'POST',headers:{Origin:local,'Content-Type':'application/json'},body:JSON.stringify(body)}:{});assert.equal(response.ok,true,await response.clone().text());return response.json();};
  const epoch=(await request('/api/v1/library')).epoch,bytes=Buffer.from(JSON.stringify(privateBrowserRecovery())),base={protocolVersion:1,epoch,migrationId};
  await request('/api/v1/library/migration',{...base,action:'begin',manifest:{sourceId,mediaLibraryIdentity,bytes:bytes.length,chunks:1,sha256:createHash('sha256').update(bytes).digest('hex')}});
  await request('/api/v1/library/migration',{...base,action:'chunk',index:0,data:bytes.toString('base64')});
  await request('/api/v1/library/migration',{...base,action:'finalize'});
  async function open(){
   const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block',acceptDownloads:true});contexts.push(context);
   const state={offline:false,login:owner};
   await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin!==origin||state.offline)return route.abort();
    if(req.method()==='POST')remotePosts++;
    // The real HTTP bridge evaluates these headers; no API response is mocked.
    const headers={...req.headers(),Host:new URL(origin).host,'Tailscale-User-Login':state.login,'X-Forwarded-Host':new URL(origin).host,'X-Forwarded-Proto':'https'};
    for(const key of ['host','connection','content-length','accept-encoding'])delete headers[key];
    const response=await new Promise((resolve,reject)=>{const request=http.request({hostname:'127.0.0.1',port:server.address().port,path:url.pathname+url.search,method:req.method(),headers},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});request.on('error',reject);request.end(req.postDataBuffer());});
    if(url.pathname.startsWith('/api/'))httpStatus.push({method:req.method(),path:url.pathname,status:response.status});
    await route.fulfill(response);
   });
   const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/compatibility.html');await page.waitForFunction(()=>CoconutStorageBootstrap.phase==='ready');
   assert.equal(await page.evaluate(()=>CoconutStorageBootstrap.result.backend),'indexeddb');
   await openLibraryTools(page);await page.locator('.library-backup > summary').click();
   page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'连接已有电脑书架',exact:true}).click();
   stage='connect_context_'+contexts.length;
   try{await page.waitForFunction(()=>CoconutStorageBootstrap.phase==='ready'&&CoconutStorageBootstrap.result.backend==='canonical');}
   catch(error){failures.push(await page.evaluate(()=>({phase:window.CoconutStorageBootstrap?.phase,backend:window.CoconutStorageBootstrap?.result?.backend,message:document.getElementById('storage-startup-message')?.textContent,connection:document.querySelector('.library-backup')?.textContent})).catch(()=>({phase:'unreadable'})));throw error;}
   assert.equal(await page.evaluate(()=>CoconutClientCapabilities.current.libraryId),epoch);
   return {page,state};
  }
  const a=await open(),b=await open();assert.equal(calls,0,'passive read/binding never runs a model');
  await captureConnection(a.page,'connected');
  const before=await request('/api/v1/library/document?protocolVersion=1&key=live');
  if(await b.page.locator('#mode-transcript').isVisible())await b.page.locator('#mode-transcript').click();
  await b.page.locator('.note-button').first().click();await b.page.locator('#note').fill('Authored private phone note');
  await b.page.evaluate(()=>libraryStore.flush());await b.page.waitForFunction(()=>libraryStore.status().unsaved===0);await b.page.locator('#close-note').click();
  const stored=await request('/api/v1/library/document?protocolVersion=1&key=live');assert.equal(stored.record.document.notes.cue,'Authored private phone note');
  const stale=await a.page.evaluate(async({epoch,record})=>{const r=await fetch('api/v1/library/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:1,epoch,action:'put',key:'live',receiptKey:'stale-authored-phone',expected:record.token,document:record.document})});return r.status;},{epoch,record:before.record});assert.equal(stale,409);
  await a.page.reload();await a.page.waitForFunction(()=>CoconutStorageBootstrap.phase==='ready');assert.equal(await a.page.evaluate(()=>CoconutStorageBootstrap.result.loaded.documents[0].notes.cue),'Authored private phone note');
  const value=Tasks.submission({key:'live',segments:[{id:'cue',text:'Original'}]},{revision:'authored-pc',provider:'codex',idempotencyKey:'pc-authored-summary',consent:true});
  const receipt=await request('/api/v1/tasks',value);let task;
  for(let i=0;i<100;i++){task=(await request('/api/v1/tasks/'+receipt.task.taskId)).task;if(task.status==='succeeded')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(task.status,'succeeded');assert.equal(calls,1);
  const viewed=await a.page.evaluate(async id=>(await (await fetch('api/v1/tasks/'+id)).json()).task,task.taskId);assert.equal(viewed.result.answer,'Authored fake summary result');
  await a.page.evaluate(()=>CoconutBackgroundSummary.refresh());assert.ok((await a.page.locator('#background-task-list').textContent()).includes(task.taskId));
  await openLibraryTools(a.page);await a.page.locator('#background-tasks').evaluate(n=>n.open=true);
  const row=a.page.locator('.background-task').filter({hasText:task.taskId});await row.getByRole('button',{name:'查看独立结果',exact:true}).click();
  await row.locator('.background-result').waitFor({state:'visible'});assert.equal(await row.locator('.background-result').textContent(),'Authored fake summary result');
  const [download]=await Promise.all([a.page.waitForEvent('download'),row.locator('[data-action=export-result]').click()]);assert.equal(await download.failure(),null);
  const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);const exported=JSON.parse(Buffer.concat(chunks).toString('utf8'));assert.equal(exported.task.taskId,task.taskId);assert.equal(exported.result.answer,viewed.result.answer);assert.equal(calls,1);
  await a.page.locator('#mode-summary').click();await a.page.locator('#prepare-summary').click();await a.page.locator('#summary-execution').selectOption('background');
  await a.page.waitForFunction(()=>document.getElementById('summary-background-status').textContent.includes('Authored computer'));await a.page.locator('#ai-consent').check();
  const count=remotePosts;a.state.offline=true;await a.page.evaluate(()=>dispatchEvent(new Event('offline')));assert.equal(await a.page.locator('#ai-consent').isChecked(),false);
  await captureConnection(a.page,'offline');
  a.state.offline=false;a.state.login='other@example.test';await a.page.evaluate(()=>CoconutClientCapabilities.refresh());
  assert.equal(await a.page.evaluate(()=>CoconutClientCapabilities.current),null);await a.page.evaluate(async()=>{document.getElementById('ai-consent').checked=true;await document.getElementById('ask-ai').onclick();});assert.equal(remotePosts,count);assert.equal(calls,1);
  await captureConnection(a.page,'identity-rejected');
  assert.equal(remotePosts,count);assert.equal(calls,1);
  assert.deepEqual(errors,[]);passed=true;
  return 'private_owner_real_bridge_two_contexts_binding_note_cas_pc_task_offline_identity_rejection';
 }finally{if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'private-owner-checks.json'),JSON.stringify({status:passed?'passed':'failed',stage,transport:'Authored private-owner proxy header fixture over loopback HTTP; no real TLS, tailnet or phone network validation',geometry,errors,httpStatus,failures},null,2));}for(const context of contexts)await context.close();await browser?.close();await server?.shutdown();await fs.rm(directory,{recursive:true,force:true});}
}
