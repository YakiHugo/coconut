/** Production UI -> HTTP coordinator -> authored RSS/real caption parser. No inference/network. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium,expect} from '@playwright/test';
import {startBridge} from '../desktop/server.mjs';
import {captionDefaultsFixture,feedUrl,trackUrl} from './fixtures/caption-defaults.mjs';
const directory=await mkdtemp(path.join(os.tmpdir(),'coconut-defaults-')),output=process.env.COCONUT_REACT_ARTIFACTS||'/tmp/coconut-caption-defaults-artifacts';
let browser,server;const errors=[],requests=[];
try{
 await mkdir(output,{recursive:true});browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 for(const width of [1360,390]){
  const fixture=captionDefaultsFixture();server=await startBridge({port:0,libraryDirectory:path.join(directory,String(width)),podcastSources:fixture.sources});const origin='http://127.0.0.1:'+server.address().port;
  const context=await browser.newContext({viewport:{width,height:960},serviceWorkers:'block'});await context.route('**/*',route=>{const r=route.request();if(new URL(r.url()).origin!==origin){errors.push(r.url());return route.abort();}if(r.url().endsWith('/api/v1/ingestions')&&r.method()==='POST')requests.push(r.postDataJSON());return route.continue();});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  const row=()=>page.locator('.episode-list article').filter({has:page.getByRole('heading',{name:'Publisher choices',exact:true})}),open=()=>row().getByRole('button',{name:'打开单集',exact:true}),select=()=>row().getByRole('combobox');
  const discover=async()=>{await page.getByRole('button',{name:'发现与添加',exact:true}).click();await expect(row()).toBeVisible();};
  await page.goto(origin);await page.getByLabel('播客或视频链接').fill(feedUrl);await page.getByRole('button',{name:'打开链接',exact:true}).click();await expect(open()).toBeEnabled();await expect(select()).toHaveValue('');await expect(select()).toContainText('默认：zh-hans · text/vtt');
  await page.screenshot({path:path.join(output,`default-${width}.png`),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  // Default has no transcript_url override and imports the server's exact language recommendation.
  await open().click();await expect(page.locator('.reader-workspace')).toBeVisible();await expect(page.locator('.reader-workspace')).toContainText('Publisher simplified.vtt');assert.equal(requests.at(-1).episode.transcript_url,undefined);
  await discover();await select().selectOption(trackUrl('traditional.vtt'));await open().click();await expect(page.locator('.source-project-choice')).toBeVisible();assert.equal(requests.at(-1).episode.transcript_url,trackUrl('traditional.vtt'));
  await page.getByRole('button',{name:'返回单集列表',exact:true}).click();await expect(select()).toHaveValue(trackUrl('traditional.vtt'));await select().selectOption('');
  // Cancellation cannot resurrect a request or turn a default into an explicit override.
  let release;fixture.state.hold=new Promise(resolve=>release=resolve);await open().click();await page.getByRole('button',{name:'取消读取',exact:true}).click();release();fixture.state.hold=null;await expect(page.locator('.source-error')).toContainText('读取已取消');await expect(select()).toHaveValue('');await expect(page.locator('.source-project-choice')).toHaveCount(0);
  fixture.state.tracks=fixture.state.tracks.slice(0,1);await page.getByRole('button',{name:'刷新节目列表',exact:true}).click();await expect(select().locator('option')).toHaveCount(2);await expect(open()).toBeDisabled();await expect(row().getByRole('button',{name:'先听原声',exact:true})).toBeEnabled();
  fixture.state.tracks=[['invalid.vtt','text/vtt','bad_language']];await page.getByRole('button',{name:'刷新节目列表',exact:true}).click();await expect(select()).toContainText('语言标注无效');await expect(open()).toBeDisabled();
  fixture.state.tracks=[['inherited.vtt','text/vtt',null]];await page.getByRole('button',{name:'刷新节目列表',exact:true}).click();await expect(select()).toContainText('按发布者语言 zh-hans');await expect(open()).toBeEnabled();
  fixture.state.language=null;await page.getByRole('button',{name:'刷新节目列表',exact:true}).click();await expect(select()).toContainText('语言未标明');await expect(open()).toBeDisabled();
  fixture.state.language='en';fixture.state.tracks=[['same.vtt','text/vtt','fr'],['same.vtt','text/vtt','en']];await page.getByRole('button',{name:'刷新节目列表',exact:true}).click();await expect(select()).toContainText('标注冲突');await expect(open()).toBeDisabled();assert.ok(await select().locator('option').evaluateAll(options=>options.slice(1).every(option=>option.disabled)));
  await page.screenshot({path:path.join(output,`unknown-${width}.png`),fullPage:true});await context.close();await new Promise(resolve=>server.close(resolve));server=null;
 }
 assert.deepEqual(errors,[]);console.log('Caption defaults browser passed: 1360/390, default/override/return/cancel/refresh/invalid/inherited/unknown; no external requests.');
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
