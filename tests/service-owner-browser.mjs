/** Actual Chromium login + production React; no external source or model calls. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {startService} from '../server/main.mjs';
const directory=await mkdtemp(path.join(tmpdir(),'coconut-owner-browser-'));
const token='authored-browser-owner-token-with-32-characters';
let server,browser;
try{
 const env={COCONUT_DATA_DIRECTORY:directory,COCONUT_PORT:'0'};
 const first=await startService({env});const port=first.server.address().port;await first.server.shutdown();
 const origin=`http://localhost:${port}`;
 const started=await startService({env:{...env,COCONUT_PORT:String(port),COCONUT_PUBLIC_ORIGIN:origin,COCONUT_OWNER_TOKEN:token}});server=started.server;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 for(const width of [1360,390]){
  const context=await browser.newContext({viewport:{width,height:850}});const page=await context.newPage();
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin);await expect(page).toHaveURL(origin+'/login');
  await page.getByLabel('访问密钥').fill('authored-wrong-key');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByText('访问密钥不正确。')).toBeVisible();
  await page.getByLabel('访问密钥').fill(token);await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('button',{name:/我的内容/})).toBeVisible();
  assert.equal(await page.evaluate(()=>Object.values(localStorage).some(value=>value.includes('authored-browser-owner-token'))),false);
  assert.equal((await context.cookies()).find(cookie=>cookie.name==='coconut_owner').httpOnly,true);
  await page.reload();await expect(page.getByRole('button',{name:/我的内容/})).toBeVisible();
  await page.goto(origin+'/login');await page.getByRole('button',{name:'退出登录'}).click();await page.goto(origin);await expect(page).toHaveURL(origin+'/login');
  await context.close();
 }
 console.log('Actual Chromium owner login, React startup, refresh and logout passed at desktop/phone widths.');
}finally{await browser?.close();await server?.shutdown();await rm(directory,{recursive:true,force:true});}
