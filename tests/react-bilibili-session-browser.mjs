/** Real React/HTTP connection UI with authored credentials; never reads a browser profile. */
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {startBridge} from '../desktop/server.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
let connected=false,deny=false,connections=0;
const status=()=>({supported:true,browser:'edge',connected,profile:connected?'Default':null,profiles:[{id:'Default',label:'Edge 默认配置'}]});
const session={async status(){return status();},async connect(profile){assert.equal(profile,'Default');connections++;if(deny)throw Error('这个 Edge 配置中没有有效的 B 站登录态。');connected=true;return status();},async disconnect(){connected=false;return status();}};
const directory=await mkdtemp(path.join(os.tmpdir(),'coconut-session-browser-'));
const server=await startBridge({port:0,libraryDirectory:path.join(directory,'library'),bilibiliSession:session,captionService:{available:true,providers:['bilibili']}});
const browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
const origin='http://127.0.0.1:'+server.address().port,errors=[];
try{
 const page=await browser.newPage({viewport:{width:390,height:900}});
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.goto(origin);await page.locator('.app-settings > summary').click();const panel=page.locator('.bilibili-session');
 await expect(panel).toBeVisible();assert.equal(connections,0);
 await panel.locator('summary').click();await expect(page.getByLabel('Edge 配置')).toBeVisible();
 await page.getByRole('button',{name:'连接 Edge 中的 B 站账号'}).click();
 await expect(panel).toContainText('已连接。现在可以重试');assert.equal(connections,1);
 await page.reload();await page.locator('.app-settings > summary').click();await expect(panel.locator('summary')).toContainText('已连接 Edge');assert.equal(connections,1);
 await panel.locator('summary').click();await page.getByRole('button',{name:'断开 Edge',exact:true}).click();
 await expect(panel).toContainText('已断开 Edge');assert.equal(connected,false);
 deny=true;await page.getByRole('button',{name:'连接 Edge 中的 B 站账号'}).click();
 await expect(panel).toContainText('没有有效的 B 站登录态');await expect(page.getByRole('button',{name:'连接 Edge 中的 B 站账号'})).toBeEnabled();
 assert.equal(connected,false);assert.equal(connections,2);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 assert.deepEqual(errors,[]);console.log('Edge connect, persisted status, disconnect, failure recovery and mobile layout passed.');
}finally{await browser.close();await server.shutdown();await rm(directory,{recursive:true,force:true});}
