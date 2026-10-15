/** Authored same-origin service fixture in real Chromium. This proves the UI
 * and HTTP contract, NOT a real TLS proxy, owner login, or cross-network phone. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
export async function privateClientBrowser(browser){
 const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
 const client={mode:'private-owner',id:'synthetic-owner',backendLabel:'Synthetic PC',online:true,libraryId:'synthetic-library',capabilities:{libraryRead:true,libraryWrite:true,aiActions:true,backgroundTasks:true,localMedia:false,libraryMigration:false}};
 const descriptor={protocolVersion:1,client,executor:{type:'local-node',online:true},enabled:true,remoteSubmission:true,supportedTaskKinds:['summary'],execution:{disconnect:'continue',restart:'interrupt_without_retry',cancel:'request_then_settle'},providers:{codex:{supported:true},claude:{supported:true}}};
 let posts=0,libraryRequests=0,task=null;const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  assert.equal(url.origin,'https://private-reader.test');
  const json=value=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
  if(url.pathname==='/api/health')return json({client,capabilities:{local_agents:true}});
  if(url.pathname==='/api/language-tools')return json({local_translation:false,ai:{codex:{ready:true},claude:{ready:true}}});
  if(url.pathname==='/api/v1/executor')return json(descriptor);
  if(url.pathname.startsWith('/api/v1/library')){libraryRequests++;return json({enabled:true,protocolVersion:1});}
  if(url.pathname==='/api/v1/tasks'){
   if(req.method()==='POST'){posts++;const body=req.postDataJSON();task={taskId:'synthetic-task',attemptId:'synthetic-attempt',inputDigest:'synthetic-digest',kind:'summary',document:body.document,provider:body.provider,status:'running',progress:{completed:0,total:1}};return json({protocolVersion:1,task});}
   return json({protocolVersion:1,tasks:task?[task]:[]});
  }
  if(url.pathname==='/api/v1/tasks/synthetic-task')return json({protocolVersion:1,task});
  if(url.pathname.startsWith('/api/'))return route.fulfill({status:404,contentType:'application/json',body:'{"error":"synthetic unsupported endpoint"}'});
  const filename=url.pathname==='/'?'index.html':url.pathname.slice(1);
  if(!/^[a-z-]+\.(html|js|css|png)$/.test(filename))return route.abort();
  try{return await route.fulfill({status:200,contentType:filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.png')?'image/png':'text/html',body:await fs.readFile(new URL('../../reader/'+filename,import.meta.url))});}catch{return route.fulfill({status:404,body:''});}
 });
 try{
  await page.goto('https://private-reader.test/');
  assert.equal(await page.evaluate(()=>CoconutStorageBootstrap.result.backend),'indexeddb');
  assert.equal(libraryRequests,0,'a new mobile origin never automatically connects or imports');
  const fixture={title:'Authored private connection',segments:[{id:'one',start:0,end:2,text:'A synthetic private owner source.'}]};
  await page.locator('#file').setInputFiles({name:'private-fixture.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  await page.waitForFunction(()=>document.getElementById('title').textContent.includes('Authored private'));
  await page.locator('#mode-summary').click();await page.locator('#prepare-summary').click();await page.locator('#summary-execution').selectOption('background');
  await page.waitForFunction(()=>document.getElementById('summary-background-status').textContent.includes('Synthetic PC'));
  assert.equal(posts,0);await page.locator('#ai-consent').check();await page.locator('#ask-ai').click();
  await page.waitForFunction(()=>document.getElementById('summary-background-status').textContent.includes('执行中'));
  assert.equal(posts,1);
  await page.evaluate(()=>window.dispatchEvent(new Event('offline')));
  assert.equal(await page.locator('#ai-consent').isChecked(),false);
  client.libraryId='different-synthetic-library';await page.evaluate(()=>CoconutBackgroundSummary.refresh());
  assert.equal(posts,1,'reconnection and changed library cannot create a new task');
  assert.equal(await page.evaluate(()=>CoconutClientCapabilities.allows('localMedia')),false);
  assert.equal(await page.evaluate(()=>CoconutClientCapabilities.allows('libraryMigration')),false);
  assert.deepEqual(errors,[]);
  return 'private_owner_same_origin_fixture_mobile_capabilities_no_auto_submission';
 }finally{await context.close();}
}
