/** Production browser + real ingestion and caption sanitizer, using authored offline failures. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {startBridge} from '../desktop/server.mjs';
import {createCaptionService} from '../desktop/caption-service.mjs';
const url='https://www.youtube.com/watch?v=abcdefghijk',requests=[],forbidden=[],errors=[];
let hold,release;
const captions=createCaptionService({enabledProviders:['youtube'],helper:{extractCaptions:async request=>{
 requests.push(request);if(hold)await hold;
 return {status:'network_unavailable',diagnostic:{stage:'metadata',reason:'transport_unavailable',requests_attempted:2,responses_received:0,raw:'PRIVATE_RAW_ERROR'}};
}}});
const directory=await mkdtemp(path.join(os.tmpdir(),'coconut-caption-failure-'));
const denied=async()=>{forbidden.push('model');throw Error('No model calls allowed');};
const server=await startBridge({port:0,libraryDirectory:directory,captionService:captions,providers:{status:async()=>({ready:false}),ask:denied,structured:denied,exclusive:denied}});
const origin='http://127.0.0.1:'+server.address().port,output=process.env.COCONUT_REACT_ARTIFACTS||'/tmp/coconut-react-authored';let browser;
try{
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1360,height:960},serviceWorkers:'block'});
 await context.route('**/*',route=>{const target=new URL(route.request().url());if(target.origin!==origin||route.request().method()==='POST'&&target.pathname!=='/api/v1/ingestions'){forbidden.push(target.origin+target.pathname);return route.abort();}return route.continue();});
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin);await page.getByLabel('播客或视频链接').fill(url);await page.getByRole('button',{name:'打开链接',exact:true}).click();
 const panel=page.getByRole('region',{name:'本次字幕读取结果'});
 await expect(panel).toContainText('读取视频信息');await expect(panel).toContainText('尝试请求 2 次，收到响应 0 次');await expect(panel).not.toContainText('PRIVATE_RAW_ERROR');await expect(panel.getByRole('link',{name:'打开原站'})).toHaveAttribute('href',url);await expect(panel.getByRole('link')).toHaveAttribute('rel','noopener noreferrer');assert.equal(requests.length,1);
 await mkdir(output,{recursive:true});await page.screenshot({path:path.join(output,'caption-failure-wide.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await expect(panel.getByRole('link')).toBeVisible();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(output,'caption-failure-narrow.png'),fullPage:true});
 hold=new Promise(resolve=>release=resolve);await page.getByRole('button',{name:'重试上次读取',exact:true}).click();await expect(panel).toHaveCount(0);await page.getByRole('button',{name:'取消读取',exact:true}).click();release();hold=null;await expect(page.locator('.source-error')).toContainText('读取已取消');await expect(panel).toHaveCount(0);
 await page.getByLabel('播客或视频链接').fill('https://publisher.example/feed');await expect(panel).toHaveCount(0);assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);assert.equal((await fetch(origin+'/api/v1/library').then(r=>r.json())).sequence,0);
 console.log('PASS caption failure browser: localized bounded evidence, safe explicit original action, narrow layout, retry/cancel, unchanged library, no external/model requests.');
}finally{release?.();await browser?.close();await server.shutdown();await rm(directory,{recursive:true,force:true});}
