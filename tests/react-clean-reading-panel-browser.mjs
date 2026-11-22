import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import D from '../reader/disfluency.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createLibraryStore} from '../desktop/library-store.mjs';
import {createCleanReadingJobs} from '../desktop/clean-reading-jobs.mjs';
import {createCleanReadingPlanner} from '../desktop/clean-reading.mjs';
import {startBridge} from '../desktop/server.mjs';

const directory=await mkdtemp(path.join(tmpdir(),'coconut-clean-panel-test-'));
const library=await createLibraryStore({directory:path.join(directory,'library')});
const original={schema_version:1,key:'clean-panel-e2e',title:'自写整理入口验收',notes:{},segments:[{id:'a',start:1,end:5,text:'我我觉得值得认真讨论，然后继续。',speaker:'自写说话人'}]};
library.commit({protocolVersion:1,epoch:library.describe().epoch,key:original.key,receiptKey:'clean-panel-e2e-create',action:'put',expected:null,document:original});
const jobs=await createCleanReadingJobs({directory:path.join(directory,'jobs'),libraryStore:library,planner:createCleanReadingPlanner()});
const server=await startBridge({port:0,libraryStore:library,cleanReadingJobs:jobs});
const origin='http://127.0.0.1:'+server.address().port;
let browser;
try{
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width:1360,height:900}}),external=[],errors=[];
 page.on('request',request=>{if(new URL(request.url()).origin!==origin&&!request.url().startsWith('blob:'))external.push(request.url());});
 page.on('pageerror',error=>errors.push(error.message));
 const job=await jobs.create({protocolVersion:1,operation_id:randomUUID(),key:original.key,source_signature:D.signature(original),fallback:false,consent:false});
 await expect.poll(()=>jobs.get(job.id).state,{timeout:30000}).toBe('ready');
 await jobs.action(job.id,'apply');
 await page.goto(origin+'/#read/'+original.key);
 const source=page.locator('[data-source-id="a"]');
 await expect(source).toHaveAttribute('data-cleanup-applied','true');
 await expect(page.getByRole('button',{name:/^(精简口语|保留口语)$/})).toHaveCount(0);
 await expect(page.locator('.rw-reading-controls,.rw-records')).toHaveCount(0);
 assert.equal(await source.textContent(),await source.innerText());
 const displayed=await source.innerText();assert.notEqual(displayed,original.segments[0].text,'saved cleanup is displayed immediately');
 const plan=library.get(original.key).document.reading_cleanup,segments=library.get(original.key).document.segments;
 assert.ok(plan.decisions.length>0);assert.equal(plan.fallback.provider,'');assert.equal(plan.stats.llmCalls,0);
 assert.deepEqual(segments.map(({id,start,end,text,speaker,words})=>({id,start,end,text,speaker,words})),original.segments.map(({id,start,end,text,speaker,words})=>({id,start,end,text,speaker,words})));
 await page.reload();await expect(source).toHaveAttribute('data-cleanup-applied','true');
 await expect(page.getByRole('button',{name:/^(精简口语|保留口语)$/})).toHaveCount(0);
 await source.scrollIntoViewIfNeeded();await expect.poll(()=>source.innerText()).toBe(displayed);assert.equal(await source.textContent(),await source.innerText());
 assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'passed',state:'applied',decisions:plan.decisions.length,llmCalls:plan.stats.llmCalls,sourceUnchanged:true,reloadRestores:true,externalRequests:0}));
}finally{
 await browser?.close();await server.shutdown();await jobs.shutdown();library.close();await rm(directory,{recursive:true,force:true});
}
