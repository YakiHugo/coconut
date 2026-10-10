import {openCueActions} from './cue-actions-browser.mjs';
/** Chromium acceptance with only injected provider fixtures. Never invoke a real CLI. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {startBridge} from '../desktop/server.mjs';
let server,browser,directory,release,stage='setup';
const checks=[],requests=[];
let firstStartedResolve;const firstStarted=new Promise(resolve=>{firstStartedResolve=resolve;});
const check=(name,value)=>{stage=name;assert.ok(value,name);checks.push(name);};
const providers={status:async()=>({ready:true,reason:'Injected test fixture; no real CLI'}),exclusive:async action=>action(),structured:async()=>{throw new Error('Unexpected inference adapter');},ask:async request=>{
 requests.push(request);
 if(requests.length===1)await new Promise(resolve=>{release=resolve;firstStartedResolve();});
 const aggregate=request.segments[0].id==='batch-1';
 return {answer:aggregate?'这是一份测试用汇总，不代表真实模型质量。':'这是一份测试用分批笔记。',citations:aggregate?request.segments.map(s=>s.id):[request.segments[0].id],provider:'synthetic-fixture'};
}};
try{
 directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-summary-browser-'));
 server=await startBridge({port:0,providers});const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({acceptDownloads:true,viewport:{width:390,height:844},serviceWorkers:'block'});let external=0,errors=0;
 await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===origin||url.protocol==='blob:')await route.continue();else{external++;await route.abort();}});
 const page=await context.newPage();page.on('pageerror',()=>errors++);page.setDefaultTimeout(15000);
 await page.goto(origin);const fixture={title:'长文摘要测试 · 仅模拟结果',language:'en',segments:Array.from({length:5001},(_,i)=>({id:'source-'+i,start:i,end:i+1,text:'Synthetic source cue '+i}))};
 await page.locator('#file').setInputFiles({name:'long.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
 await page.locator('#mode-summary').click();await page.locator('#prepare-summary').click();check('plan_before_any_inference',requests.length===0&&(await page.locator('#summary-plan').textContent()).includes('共 14 次'));
 check('mobile_plan_fits',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.locator('#check-ai').click();await page.locator('#ai-consent').check();await page.locator('#ask-ai').click();
 await page.waitForFunction(()=>document.querySelector('#ai-progress').textContent.includes('第 1/13'));
 check('no_summary_from_partial_work',await page.locator('#summary-body').textContent()==='');
 await firstStarted;await page.locator('#stop-summary').click();release();
 await page.waitForFunction(()=>document.querySelector('#ai-progress').textContent.includes('已停止后续请求'));
 check('one_durable_batch_after_stop',requests.length===1&&await page.evaluate(()=>JSON.parse(localStorage.getItem('coconut-reader-v1')).documents[0].summary_job.results.length===1));
 await page.reload();await page.locator('#mode-summary').click();await page.locator('#prepare-summary').click();
 check('reload_does_not_resume',requests.length===1&&!(await page.locator('#ai-consent').isChecked())&&(await page.locator('#summary-plan').textContent()).includes('本次继续 13 次'));
 await page.locator('#check-ai').click();await page.locator('#ai-consent').check();await page.locator('#ask-ai').click();
 await page.waitForFunction(()=>document.querySelector('#summary-state').dataset.state==='current');
 check('all_source_batches_then_one_aggregate',requests.length===14&&requests.slice(0,13).flatMap(r=>r.segments).length===5001&&requests[13].segments.length===13);
 const doc=await page.evaluate(()=>JSON.parse(localStorage.getItem('coconut-reader-v1')).documents[0]);
 check('final_has_full_source_and_original_citations',doc.summary_job===null&&doc.ai_answers[0].input_snapshot.segments.length===5001&&doc.ai_answers[0].citations.every(id=>fixture.segments.some(s=>s.id===id))&&doc.ai_answers[0].summary_process.batches===13);
 if(!await page.locator('#export-menu').evaluate(node=>node.open))await page.locator('#export-menu > summary').click();
 const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#export').click()]);const exported=path.join(directory,'summary-backup.json');await download.saveAs(exported);
 const other=await browser.newContext({serviceWorkers:'block'}),restored=await other.newPage();restored.on('pageerror',()=>errors++);await restored.goto(origin);await restored.locator('#file').setInputFiles(exported);
 await restored.waitForFunction(()=>document.querySelector('#summary-state').dataset.state==='current');
 check('export_reimport_recovers_complete_summary',(await restored.locator('#summary-body').textContent()).includes('测试用汇总'));
 await restored.locator('#mode-summary').click();await restored.locator('#summary-citations button').first().click();await openCueActions(restored.locator('.segment').first());await restored.locator('.segment .edit-button').first().click();await restored.locator('#edit-segment').fill('Modified source, after summary');await restored.locator('#save-edit').click();await restored.locator('#mode-summary').click();
 check('changed_original_marks_summary_stale',await restored.locator('#summary-state').getAttribute('data-state')==='stale');
 check('no_external_requests_or_browser_errors',external===0&&errors===0);
 console.log(JSON.stringify({suite:'long-summary-mocked',status:'passed',checks}));
}catch{console.log(JSON.stringify({suite:'long-summary-mocked',status:'failed',stage,checks}));process.exitCode=1;}
finally{release?.();await browser?.close();await new Promise(resolve=>server?.listening?server.shutdown(resolve):resolve());if(directory)await fs.rm(directory,{recursive:true,force:true});}
