/** Production React + actual HTTP bridge/coordinator/RSS/VTT parser; authored bytes only. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium,expect} from '@playwright/test';
import {startBridge} from '../desktop/server.mjs';
import {audioFirstBrowser} from './helpers/audio-first-browser.mjs';
import {sourceDiscoveryFixture,sourceFeed,frenchTrack,upgradeTrack} from './fixtures/source-discovery.mjs';
const output=process.env.COCONUT_REACT_ARTIFACTS||'/tmp/coconut-react-authored';
const fixture=sourceDiscoveryFixture(),forbidden=[],errors=[],checks=[];
fixture.state.extraEpisodes=205;
const forbiddenProvider=async()=>{forbidden.push('provider');throw Error('No inference in authored discovery acceptance');};
const directory=await mkdtemp(path.join(os.tmpdir(),'coconut-source-sqlite-'));
let browser,release,server;
try{
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});await mkdir(output,{recursive:true});
 for(const width of [1360,390]){
  server=await startBridge({port:0,libraryDirectory:path.join(directory,String(width)),podcastSources:fixture.sources,providers:{status:async()=>({ready:false,reason:'Authored offline fixture'}),ask:forbiddenProvider,structured:forbiddenProvider,exclusive:forbiddenProvider}});
  const origin='http://127.0.0.1:'+server.address().port;
  fixture.state.upgrade=false;fixture.state.onlyFrench=true;fixture.state.failTrack=false;fixture.state.failFeed=false;fixture.state.holdFeed=null;
  const initial={protocolVersion:1,source:{kind:'url',url:sourceFeed}},second=(await fixture.service.ingest(initial)).ingestion.selection.episodes[1];
  const project=(await fixture.service.ingest({...initial,episode:{feed_url:sourceFeed,episode_id:second.id}})).ingestion.project.document;
  project.key='original-project';project.project_note='Keep my original project note';project.timestamp_bookmarks=[{id:'b',time:1,note:'Keep my bookmark',future:{keep:true}}];project.opaque={keep:['original extension']};project.podcast_source.future={keep:true};
  const context=await browser.newContext({viewport:{width,height:960},acceptDownloads:true,serviceWorkers:'block'});
  // Seed the real server authority, independently for each viewport.
  const status=await fetch(origin+'/api/v1/library').then(response=>response.json());assert.equal(status.backend,'sqlite');assert.equal(status.sequence,0);
  const seeded=await fetch(origin+'/api/v1/library/batch',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:2,epoch:status.epoch,commands:[{action:'put',key:project.key,receiptKey:'authored-source-seed',expected:null,expectedIdentity:null,document:project}]})});assert.equal(seeded.status,200);assert.equal((await seeded.json()).receipts.length,1);
  await context.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(url.origin!==origin){forbidden.push(url.origin+url.pathname);return route.abort();}
   if(route.request().method()==='POST'&&!['/api/v1/ingestions','/api/v1/library/batch'].includes(url.pathname)){forbidden.push(url.pathname);return route.abort();}
   return route.continue();
  });
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  const episode=title=>page.locator('.episode-list article').filter({has:page.getByRole('heading',{name:title,exact:true})});
  const multilingual=()=>episode('Authored multilingual episode'),evolving=()=>episode('Authored evolving episode');
  async function saved(){await expect(page.locator('.app-header').getByText('已保存',{exact:true})).toBeVisible();}
  async function backup(){const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'导出完整备份',exact:true}).click()]);return JSON.parse(await readFile(await download.path(),'utf8')).documents;}
  async function discover(){await page.getByRole('button',{name:'发现与添加',exact:true}).click();await expect(page.getByLabel('播客或视频链接')).toBeVisible();}
  async function openFirst(){await multilingual().getByRole('button',{name:'打开单集',exact:true}).click();}
  const refresh=()=>page.getByRole('button',{name:'刷新节目列表',exact:true}),checked=()=>page.locator('.feed-refresh p');
  async function feedAborted(){await expect.poll(()=>fixture.calls.findLast(call=>call.url===sourceFeed)?.signal?.aborted).toBe(true);}
  async function screenshot(name){const size=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));assert.ok(size.document<=width+1,'Discovery horizontal overflow '+JSON.stringify(size));await page.screenshot({path:path.join(output,`source-${name}-${width}.png`),fullPage:true});}
  const beforeDiscovery={...fixture.counts};await page.goto(origin);await expect(page.getByRole('heading',{name:'今天，想听什么？'})).toBeVisible();
  await page.getByLabel('播客或视频链接').fill(sourceFeed);await page.getByRole('button',{name:'打开链接',exact:true}).click();await expect(multilingual()).toBeVisible();
  const episodeSearch=page.getByRole('searchbox',{name:'查找当前列表的单集'}),episodeRows=page.locator('.episode-list article');
  await expect(episodeRows).toHaveCount(20);await expect(page.locator('.episode-warning')).toContainText('来源列表不完整');await expect(multilingual()).toContainText('时长 1:02:03');
  await page.getByText('来源提示',{exact:true}).click();await expect(page.locator('.episode-warnings')).toContainText('发布者提供的文字稿');
  await page.getByRole('button',{name:'显示更多单集',exact:true}).click();await expect(episodeRows).toHaveCount(40);
  await episodeSearch.fill('Archive episode 190');await expect(episodeRows).toHaveCount(1);await expect(episodeRows).toContainText('Archive episode 190');
  await episodeSearch.fill('No matching episode');await expect(episodeRows).toHaveCount(0);await expect(page.getByText('当前列表没有匹配的单集。可清空搜索，或在上方换用具体单集链接。',{exact:true})).toBeVisible();await screenshot('episode-search-empty');
  await page.getByRole('button',{name:'清空单集搜索',exact:true}).click();await expect(episodeRows).toHaveCount(20);await screenshot('episode-browsing');
  await episodeSearch.focus();await episodeSearch.pressSequentially('multilingual');await expect(episodeRows).toHaveCount(1);
  assert.deepEqual(fixture.counts,{feed:beforeDiscovery.feed+1,transcript:beforeDiscovery.transcript});await expect(checked()).toContainText('上次来源检查：');const initialCheck=await checked().textContent();
  await expect(multilingual().getByRole('button',{name:'打开单集',exact:true})).toBeDisabled();await multilingual().getByRole('combobox').selectOption(frenchTrack);
  fixture.state.failTrack=true;await openFirst();await expect(page.locator('.source-error')).toContainText('Authored transcript temporarily unavailable');await expect(multilingual()).toBeVisible();await expect(multilingual().getByRole('combobox')).toHaveValue(frenchTrack);await screenshot('track-retry');
  fixture.state.failTrack=false;await page.getByRole('button',{name:'重试上次读取：Authored multilingual episode',exact:true}).click();await expect(page.locator('.rw-original')).toHaveText('Bonjour, cette source reste intacte.');await saved();
  assert.deepEqual(fixture.counts,{feed:beforeDiscovery.feed+1,transcript:beforeDiscovery.transcript+2},'track failure and retry both reuse the completed RSS, but fetch publisher transcript bytes');
  await page.locator('.rw-project-note > summary').click();await page.getByRole('textbox',{name:'项目笔记',exact:true}).fill('French project note');await page.getByRole('button',{name:'保存笔记',exact:true}).click();await saved();
  let docs=await backup(),first=docs.find(doc=>doc.title==='Authored multilingual episode');assert.equal(first.language,'fr');assert.equal(first.podcast_source.transcript_url,frenchTrack);
  await page.goBack();await expect(page.getByLabel('播客或视频链接')).toHaveValue(sourceFeed);await expect(multilingual()).toBeVisible();await expect(multilingual().getByRole('combobox')).toHaveValue(frenchTrack);
  await expect(episodeSearch).toHaveValue('multilingual');await episodeSearch.focus();await episodeSearch.press('ControlOrMeta+A');await episodeSearch.press('Backspace');await expect(episodeRows).toHaveCount(20);
  await expect(checked()).toHaveText(initialCheck);assert.equal(fixture.counts.feed,beforeDiscovery.feed+1);
  await openFirst();await expect(page.getByRole('region',{name:'此来源已在书架'})).toBeVisible();await expect(page.getByRole('button',{name:/核对新文字稿/})).toHaveCount(0);await page.getByRole('button',{name:'继续已有项目 · '+first.key.slice(-8),exact:true}).click();await expect(page.getByRole('textbox',{name:'项目笔记',exact:true})).toHaveValue('French project note');assert.equal((await backup()).length,2);
  await discover();await openFirst();await expect(page.getByRole('region',{name:'此来源已在书架'})).toBeVisible();await page.getByRole('button',{name:'另建独立副本',exact:true}).click();await expect(page.locator('.reader-workspace')).toBeVisible();await saved();assert.equal((await backup()).length,3);
  await discover();await openFirst();await expect(page.locator('.source-project-choice article')).toHaveCount(2);await screenshot('choose-project');await page.getByRole('button',{name:'继续已有项目 · '+first.key.slice(-8),exact:true}).click();await expect(page.getByRole('textbox',{name:'项目笔记',exact:true})).toHaveValue('French project note');
  await discover();fixture.state.upgrade=true;await expect(evolving().getByRole('combobox')).toHaveCount(0);assert.equal(fixture.counts.feed,beforeDiscovery.feed+1,'reopening and making copies do not silently re-fetch RSS');
  const beforeRefresh={...fixture.counts},beforeRefreshDocs=await backup();fixture.state.now+=1000;fixture.state.holdFeed=new Promise(resolve=>release=resolve);await refresh().click();await expect.poll(()=>fixture.counts.feed).toBe(beforeRefresh.feed+1);
  await expect(refresh()).toBeDisabled();await expect(multilingual().getByRole('button',{name:'打开单集',exact:true})).toBeDisabled();await expect(checked()).toHaveText(initialCheck);await expect(page.getByLabel('播客或视频链接')).toHaveValue(sourceFeed);
  release();release=null;fixture.state.holdFeed=null;await expect(evolving().getByRole('combobox')).toBeVisible();await expect(refresh()).toBeEnabled();await expect(checked()).not.toHaveText(initialCheck);const refreshedCheck=await checked().textContent();assert.equal(fixture.counts.transcript,beforeRefresh.transcript);await expect(multilingual().getByRole('combobox')).toHaveValue(frenchTrack);await screenshot('feed-refreshed');
  fixture.state.failFeed=true;fixture.state.now+=1000;await refresh().click();await expect(page.locator('.source-error')).toContainText('Authored feed temporarily unavailable');await expect(refresh()).toBeEnabled();assert.equal(fixture.counts.feed,beforeRefresh.feed+2);
  await expect(checked()).toHaveText(refreshedCheck);await expect(page.getByLabel('播客或视频链接')).toHaveValue(sourceFeed);await expect(multilingual().getByRole('combobox')).toHaveValue(frenchTrack);await expect(evolving().getByRole('combobox')).toBeVisible();await screenshot('feed-refresh-failed');
  await openFirst();await expect.poll(()=>fixture.counts.feed).toBe(beforeRefresh.feed+3);await expect(page.locator('.source-error')).toContainText('Authored feed temporarily unavailable');await expect(refresh()).toBeEnabled();assert.equal(fixture.counts.transcript,beforeRefresh.transcript,'failed refresh invalidates RSS rather than allowing stale transcript import');await expect(page.locator('.source-project-choice')).toHaveCount(0);await expect(checked()).toHaveText(refreshedCheck);assert.deepEqual(await backup(),beforeRefreshDocs,'failed source refresh and import preserve all existing projects');
  fixture.state.failFeed=false;fixture.state.now+=1000;await refresh().click();await expect(page.locator('.source-error')).toHaveText('');await expect(refresh()).toBeEnabled();assert.equal(fixture.counts.feed,beforeRefresh.feed+4);await expect(checked()).not.toHaveText(refreshedCheck);await expect(multilingual().getByRole('combobox')).toHaveValue(frenchTrack);
  await openFirst();await expect(page.getByRole('region',{name:'此来源已在书架'})).toBeVisible();assert.deepEqual(fixture.counts,{feed:beforeRefresh.feed+4,transcript:beforeRefresh.transcript+1});await page.getByRole('button',{name:'返回单集列表',exact:true}).click();
  await evolving().getByRole('combobox').selectOption(upgradeTrack);await evolving().getByRole('button',{name:'打开单集',exact:true}).click();await expect(page.getByRole('region',{name:'此来源已在书架'})).toBeVisible();assert.equal(fixture.counts.feed,beforeRefresh.feed+4);
  await page.getByRole('button',{name:'核对新文字稿 · -project',exact:true}).click();await expect(page.getByRole('region',{name:'核对并接入文字稿'})).toBeVisible();await screenshot('review-transcript');assert.equal((await backup()).find(doc=>doc.key===project.key).segments.length,0);
  await page.getByRole('button',{name:'取消接入',exact:true}).click();await expect(page.getByRole('region',{name:'核对并接入文字稿'})).toHaveCount(0);await page.getByRole('button',{name:'核对新文字稿 · -project',exact:true}).click();await page.getByRole('button',{name:'确认接入此原声项目',exact:true}).click();await expect(page.locator('.rw-original')).toHaveText('The original project keeps its notes.');await saved();
  docs=await backup();const upgraded=docs.find(doc=>doc.key===project.key);assert.equal(docs.length,3);assert.equal(upgraded.project_note,project.project_note);assert.deepEqual(upgraded.timestamp_bookmarks,project.timestamp_bookmarks);assert.deepEqual(upgraded.opaque,project.opaque);assert.deepEqual(upgraded.podcast_source.future,project.podcast_source.future);assert.equal(upgraded.podcast_source.transcript_url,upgradeTrack);
  await page.reload();await expect(page.locator('.rw-original')).toHaveText('The original project keeps its notes.');assert.deepEqual((await backup()).find(doc=>doc.key===project.key),upgraded,'save/reopen retains full upgraded document');
  await discover();await page.getByLabel('播客或视频链接').fill(sourceFeed);await page.getByRole('button',{name:'打开链接',exact:true}).click();await expect(multilingual()).toBeVisible();await multilingual().getByRole('combobox').selectOption(frenchTrack);
  const beforeCancelledRefresh={...fixture.counts},cancelledCheck=await checked().textContent();fixture.state.now+=1000;fixture.state.holdFeed=new Promise(resolve=>release=resolve);await refresh().click();await expect.poll(()=>fixture.counts.feed).toBe(beforeCancelledRefresh.feed+1);await page.getByRole('button',{name:'取消读取',exact:true}).click();await feedAborted();release();release=null;fixture.state.holdFeed=null;
  await expect(page.locator('.source-error')).toContainText('读取已取消');await expect(checked()).toHaveText(cancelledCheck);await expect(multilingual().getByRole('combobox')).toHaveValue(frenchTrack);await openFirst();await expect(page.locator('.source-project-choice')).toBeVisible();assert.deepEqual(fixture.counts,{feed:beforeCancelledRefresh.feed+2,transcript:beforeCancelledRefresh.transcript+1},'cancelled refresh invalidates the prior RSS snapshot');await page.getByRole('button',{name:'返回单集列表',exact:true}).click();const beforeNavigationCheck=await checked().textContent();assert.notEqual(beforeNavigationCheck,cancelledCheck);
  fixture.state.now+=1000;fixture.state.holdFeed=new Promise(resolve=>release=resolve);await refresh().click();await expect.poll(()=>fixture.counts.feed).toBe(beforeCancelledRefresh.feed+3);await page.getByRole('button',{name:/^我的内容/}).click();await expect(page.locator('.library-page')).toBeVisible();await feedAborted();release();release=null;fixture.state.holdFeed=null;await discover();await expect(page.locator('.source-error')).toContainText('读取已暂停');await expect(checked()).toHaveText(beforeNavigationCheck);await expect(multilingual().getByRole('combobox')).toHaveValue(frenchTrack);
  fixture.state.hold=new Promise(resolve=>release=resolve);await openFirst();await expect(page.getByRole('button',{name:'取消读取',exact:true})).toBeVisible();await page.getByRole('button',{name:'取消读取',exact:true}).click();release();release=null;fixture.state.hold=null;await expect(multilingual()).toBeVisible();await expect(page.locator('.source-error')).toContainText('读取已取消');
  fixture.state.hold=new Promise(resolve=>release=resolve);await openFirst();await expect(page.getByRole('button',{name:'取消读取',exact:true})).toBeVisible();await page.getByLabel('播客或视频链接').fill('https://publisher.example.org/new');release();release=null;fixture.state.hold=null;await expect(page.locator('.episode-list')).toHaveCount(0);await expect(page.locator('.source-project-choice')).toHaveCount(0);assert.equal((await backup()).length,3);
  checks.push({width,passed:['real HTTP bridge + RSS/VTT parser','completed RSS reuse with fresh transcript bytes','delayed explicit refresh and updated source-check time','failed refresh retains context and forbids stale-cache fallback','recovery refresh restores import','refresh cancellation and navigation retire requests','explicit track and retry','browser back discovery session','exact existing/copy/multiple choice','reviewed in-place transcript upgrade','opaque notes/bookmarks durable reload','cancel and newer URL']});await context.close();await server.shutdown();server=null;
 }
 // Fresh-library catalog entry, using authored bytes behind the real source parser.
 for(const width of [1360,390]){
  const catalogFeed='https://mp3s.nashownotes.com/pc20rss.xml',catalogFixture=sourceDiscoveryFixture(catalogFeed);
  server=await startBridge({port:0,libraryDirectory:path.join(directory,'catalog-'+width),podcastSources:catalogFixture.sources,providers:{status:async()=>({ready:false}),ask:forbiddenProvider,structured:forbiddenProvider,exclusive:forbiddenProvider}});
  const origin='http://127.0.0.1:'+server.address().port,context=await browser.newContext({viewport:{width,height:960},serviceWorkers:'block'});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){forbidden.push('catalog external request');return route.abort();}return route.continue();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);
  const card=page.locator('.podcast-catalog li').filter({has:page.getByRole('heading',{name:'Podcasting 2.0',exact:true})});
  await expect(card).toContainText('未校对');assert.equal(catalogFixture.calls.length,0);
  await card.getByRole('button',{name:'查看单集',exact:true}).click();
  const episode=page.locator('.episode-list article').filter({has:page.getByRole('heading',{name:'Authored multilingual episode',exact:true})});
  await expect(page.getByLabel('播客或视频链接')).toHaveValue(catalogFeed);await episode.getByRole('combobox').selectOption(frenchTrack);await episode.getByRole('button',{name:'打开单集',exact:true}).click();
  await expect(page.locator('.rw-original')).toHaveText('Bonjour, cette source reste intacte.');await expect(page.locator('.app-header').getByText('已保存',{exact:true})).toBeVisible();
  await page.reload();await expect(page.locator('.rw-original')).toHaveText('Bonjour, cette source reste intacte.');assert.equal(catalogFixture.counts.transcript,1);assert.equal(catalogFixture.calls.some(call=>call.url.endsWith('.mp3')),false);
  const size=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));assert.ok(size.document<=width+1);
  checks.push({width,passed:['catalog click without typing URL','real RSS/VTT parser to reader','SQLite saved transcript survives reload','no media or model request']});await context.close();await server.shutdown();server=null;
 }
 for(const width of [1360,600,390])checks.push(await audioFirstBrowser({browser,width,directory,output}));
 assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);await writeFile(path.join(output,'source-discovery.json'),JSON.stringify({checks,forbidden,errors},null,2));console.log('PASS production source-discovery continuity with actual authored backend parser; no external/model requests.');
}finally{release?.();fixture.state.hold=null;fixture.state.holdFeed=null;await browser?.close();await server?.shutdown();await rm(directory,{recursive:true,force:true});}
