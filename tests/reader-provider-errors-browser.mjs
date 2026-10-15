/** Authored errors only: no CLI or model calls, credentials or user sources. */
import {chromium} from './helpers/browser-storage.mjs';
import {startBridge} from '../desktop/server.mjs';
import {providerFailure} from '../desktop/provider-errors.mjs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-provider-browser-'));
const output=process.env.COCONUT_UI_SCREENSHOTS||temporary;
await fs.mkdir(output,{recursive:true});
const fixture={title:'Authored diagnostic fixture',language:'en',segments:[{id:'fixture-cue',start:0,end:5,text:'This is synthetic source material created only for UI tests.'}]};
const failure=providerFailure('codex',{code:1,stdout:JSON.stringify({type:'turn.failed',error:{message:'Synthetic provider failure: fixture-only detail',code:'fixture_error',status_code:503}})});
const server=await startBridge({port:0,privateProxy:{type:'tailscale-serve',origin:'https://reader.fixture.ts.net',ownerLogin:'owner@example.test'},providers:{status:async()=>({ready:true}),ask:async()=>{throw failure;}}});
const origin='http://127.0.0.1:'+server.address().port;
let browser;
const report=[];
try{
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 for(const width of [390,1280]){
  const page=await browser.newPage({viewport:{width,height:900}});
  await page.goto(origin);
  await page.locator('#file').setInputFiles({name:'fixture.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  await page.waitForFunction(()=>document.getElementById('title').textContent.includes('Authored diagnostic fixture'));
  await page.locator('#mode-transcript').click();
  await page.locator('#language-panel > summary').click();
  await page.locator('#check-ai').click();
  await page.locator('#ai-question').fill('What does the fixture say?');
  await page.locator('#ai-consent').check();
  await page.locator('#ask-ai').click();
  await page.locator('#local-provider-error').waitFor({state:'visible'});
  assert.equal(await page.locator('#local-provider-error').getAttribute('open'),null);
  assert.equal(await page.locator('#local-provider-error-text').textContent(),'');
  assert.match(await page.locator('#local-provider-error').textContent(),/可能含任务片段/);
  assert.ok(!(await page.locator('#ai-progress').textContent()).includes('fixture-only detail'));
  await page.locator('#local-provider-error').scrollIntoViewIfNeeded();
  await page.screenshot({path:output+'/provider-errors-'+width+'-collapsed.png'});
  await page.locator('#local-provider-error > summary').click();
  await page.waitForFunction(()=>document.getElementById('local-provider-error-text').textContent.includes('fixture-only detail'));
  await page.screenshot({path:output+'/provider-errors-'+width+'-expanded.png'});
  assert.ok(!(await page.evaluate(async()=>JSON.stringify(await window.readPersistedLibrary()))).includes('fixture-only detail'));
  await page.locator('#language-panel > summary').click();
  await page.waitForFunction(()=>document.getElementById('local-provider-error').hidden);
  await page.screenshot({path:output+'/provider-errors-'+width+'-closed.png'});
  report.push({width,collapsed:true,explicitOpen:true,warning:await page.locator('#local-provider-error').textContent().then(s=>s.includes('可能含任务片段')),closeClears:true,noPersistence:true});
  // A second failure is cleared on source navigation and cannot revive on reload.
  await page.locator('#language-panel > summary').click();
  await page.locator('#ai-consent').check();await page.locator('#ask-ai').click();
  await page.locator('#local-provider-error').waitFor({state:'visible'});
  await page.locator('#file').setInputFiles({name:'another.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...fixture,title:'Another authored source'}))});
  await page.waitForFunction(()=>document.getElementById('title').textContent.includes('Another authored source'));
  assert.equal(await page.locator('#local-provider-error').isVisible(),false);
  await page.reload();assert.equal(await page.locator('#local-provider-error').isVisible(),false);
  // Relay only this ask through the bridge's actual private-owner authorization:
  // the remote response must contain no transient field, even though the UI is local.
  await page.route('**/api/ask',async route=>{
   const body=route.request().postData();
   const response=await new Promise((resolve,reject)=>{
    const request=http.request(origin+'/api/ask',{method:'POST',headers:{Host:'reader.fixture.ts.net',Origin:'https://reader.fixture.ts.net','Tailscale-User-Login':'owner@example.test','X-Forwarded-Host':'reader.fixture.ts.net','X-Forwarded-Proto':'https','Content-Type':'application/json'}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:text}));});
    request.on('error',reject);request.end(body);
   });
   assert.equal(response.status,400);const value=JSON.parse(response.body);assert.equal(value.code,'provider_failed');assert.equal(value.providerDiagnostics.upstreamStatus,503);
   assert.ok(!response.body.includes('fixture-only detail'));assert.ok(!response.body.includes('localProviderDetails'));
   await route.fulfill({status:response.status,contentType:'application/json',body:response.body});
  });
  await page.locator('#mode-transcript').click();
  if(!await page.locator('#language-panel').evaluate(element=>element.open))await page.locator('#language-panel > summary').click();
  await page.locator('#check-ai').click();await page.locator('#ai-question').fill('What does the fixture say?');
  await page.locator('#ai-consent').check();await page.locator('#ask-ai').click();
  await page.waitForFunction(()=>document.getElementById('ai-progress').textContent.includes('AI 阅读未完成'));
  assert.equal(await page.locator('#local-provider-error').isVisible(),false);
  await page.locator('#ai-progress').scrollIntoViewIfNeeded();await page.screenshot({path:output+'/provider-errors-'+width+'-remote-safe.png'});
  report.at(-1).sourceChangeClears=true;report.at(-1).reloadClears=true;report.at(-1).remoteSafe=true;
  await page.close();
 }
 await fs.writeFile(output+'/provider-errors-checks.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({suite:'provider-error-ui',report}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await fs.rm(temporary,{recursive:true,force:true});}
