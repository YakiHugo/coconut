/** Production UI + real HTTP ingestion/caption services and parser. Authored offline bytes only. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium,expect} from '@playwright/test';
import {startBridge} from '../desktop/server.mjs';
import {captionContinuityFixture,captionFixtureURL as url} from './fixtures/caption-continuity.mjs';
const fixture=captionContinuityFixture(),forbidden=[],errors=[];
const blocked=async()=>{forbidden.push('model');throw Error('No model calls in authored caption acceptance');};
const directory=await mkdtemp(path.join(os.tmpdir(),'coconut-caption-sqlite-'));
const server=await startBridge({port:0,libraryDirectory:directory,captionService:fixture.captions,providers:{status:async()=>({ready:false}),ask:blocked,structured:blocked,exclusive:blocked}}),origin='http://127.0.0.1:'+server.address().port;
const output=process.env.COCONUT_REACT_ARTIFACTS||'/tmp/coconut-react-authored';let browser,release;
try{
 const status=await fetch(origin+'/api/v1/library').then(response=>response.json());assert.equal(status.backend,'sqlite');assert.equal(status.sequence,0);
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});await mkdir(output,{recursive:true});
 const context=await browser.newContext({viewport:{width:1360,height:960},acceptDownloads:true,serviceWorkers:'block'});
 await context.route('**/*',route=>{const target=new URL(route.request().url());if(target.origin!==origin||route.request().method()==='POST'&&!['/api/v1/ingestions','/api/v1/library/batch'].includes(target.pathname)){forbidden.push(target.origin+target.pathname);return route.abort();}return route.continue();});
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 const review=page.getByRole('region',{name:'字幕解析检查'}),language=page.getByRole('region',{name:'选择视频原语言'});
 const open=async()=>{await page.getByLabel('播客或视频链接').fill(url);await page.getByRole('button',{name:'打开链接',exact:true}).click();};
 const discover=async()=>{await page.getByRole('button',{name:'发现与添加',exact:true}).click();await expect(page.getByLabel('播客或视频链接')).toBeVisible();};
 const backup=async()=>{const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'导出完整备份',exact:true}).click()]);return JSON.parse(await readFile(await download.path(),'utf8')).documents;};
 await page.goto(origin);await open();await expect(language).toBeVisible();assert.equal((await backup()).length,0);await expect(page.getByRole('button',{name:'按所选原语言重试'})).toBeDisabled();assert.deepEqual(fixture.requests.map(r=>r.language),[null]);
 assert.deepEqual(await language.locator('option').evaluateAll(items=>items.map(item=>item.value)),['','en','fr']);await language.getByRole('combobox').selectOption('en');await page.getByRole('button',{name:'按所选原语言重试'}).click();await expect(page.locator('.rw-original')).toHaveCount(2);await expect(page.locator('.app-header').getByText('已保存',{exact:true})).toBeVisible();assert.deepEqual(fixture.requests.map(r=>r.language),[null,'en']);
 const original=(await backup())[0];assert.equal(original.source_url,url);await discover();await expect(page.getByLabel('播客或视频链接')).toHaveValue(url);
 fixture.state.mode='partial';await open();await expect(review).toBeVisible();await expect(review).toContainText('Missing authored detail 1. <script>plain excerpt</script>');await expect(review.locator('script')).toHaveCount(0);await expect(page.getByRole('region',{name:'此来源已在书架'})).toHaveCount(0);assert.deepEqual(await backup(),[original]);
 await page.screenshot({path:path.join(output,'caption-partial-review.png'),fullPage:true});await page.getByRole('button',{name:'取消本次导入'}).click();await expect(review).toHaveCount(0);assert.deepEqual(await backup(),[original]);
 await open();await expect(review).toBeVisible();await page.getByRole('button',{name:'保留剩余文字稿，继续'}).click();await expect(page.getByRole('region',{name:'此来源已在书架'})).toBeVisible();assert.deepEqual(await backup(),[original]);await page.getByRole('button',{name:'另建独立副本'}).click();await expect(page.locator('.rw-original')).toHaveCount(2);await expect(page.locator('.app-header').getByText('已保存',{exact:true})).toBeVisible();const docs=await backup();assert.equal(docs.length,2);assert.deepEqual(docs.find(doc=>doc.key===original.key),original);assert.ok(docs.every(doc=>!Object.hasOwn(doc,'diagnostics')));
 await page.reload();await expect(page.locator('.rw-original')).toHaveCount(2);assert.deepEqual(await backup(),docs);await discover();fixture.state.mode='fatal';await open();await expect(page.locator('.source-error')).not.toBeEmpty();await expect(review).toHaveCount(0);assert.deepEqual(await backup(),docs);
 fixture.state.mode='partial';fixture.state.hold=new Promise(resolve=>release=resolve);await open();await page.getByRole('button',{name:'取消读取',exact:true}).click();release();release=null;fixture.state.hold=null;await expect(page.locator('.source-error')).toContainText('读取已取消');await expect(review).toHaveCount(0);assert.deepEqual(await backup(),docs);
 assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);await writeFile(path.join(output,'caption-continuity.json'),JSON.stringify({checks:['actual HTTP services and SRT parser','explicit available-language retry','loss preview and escaped excerpts','cancel unchanged library','review before existing/copy choice','durable reload','fatal parse and cancelled request'],forbidden,errors},null,2));console.log('PASS caption source continuity; authored parser fixtures, no platform/model requests.');
}finally{release?.();await browser?.close();await server.shutdown();await rm(directory,{recursive:true,force:true});}
