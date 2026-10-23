/** Authored-only HTTP bridge, real RSS/VTT parsers, WAV decoding and SQLite. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {expect} from '@playwright/test';
import {startBridge} from '../../desktop/server.mjs';
import {audioFirstFixture,sourceFeed,audioFirstTrack,audioFirstMedia} from '../fixtures/source-discovery.mjs';
export async function audioFirstBrowser({browser,width,directory,output}){
 const fixture=audioFirstFixture(),forbidden=[],errors=[],requests=[];
 const deny=async()=>{forbidden.push('inference');throw Error('Authored audio-first does not run inference');};
 const server=await startBridge({port:0,libraryDirectory:path.join(directory,'audio-first-'+width),podcastSources:fixture.sources,providers:{status:async()=>({ready:false,reason:'Authored offline fixture'}),ask:deny,structured:deny,exclusive:deny}});
 const origin='http://127.0.0.1:'+server.address().port;
 const context=await browser.newContext({viewport:{width,height:960},acceptDownloads:true,serviceWorkers:'block'});let release,expectedPlays=0;
 try{
  await context.addInitScript(()=>{window.__authoredPlays=0;document.addEventListener('play',()=>window.__authoredPlays++,true);});
  await context.route('**/*',route=>{
   const url=new URL(route.request().url()),method=route.request().method();
   if(url.origin!==origin){forbidden.push(url.origin+url.pathname);return route.abort();}
   if(method==='POST'){
    if(!['/api/v1/ingestions','/api/v1/library/batch','/api/podcasts/media'].includes(url.pathname)){forbidden.push(url.pathname);return route.abort();}
    requests.push({path:url.pathname,body:route.request().postDataJSON()});
   }
   return route.continue();
  });
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  const episode=()=>page.locator('.episode-list article').filter({has:page.getByRole('heading',{name:'Authored audio-first episode',exact:true})});
  const audioFirst=()=>episode().getByRole('button',{name:'先听原声',exact:true});
  const sourceError=()=>page.locator('.source-error');
  const loadMedia=()=>page.getByRole('button',{name:'载入原声（最多 200 MiB）',exact:true});
  const saved=()=>expect(page.locator('.app-header').getByText('已保存',{exact:true})).toBeVisible();
  async function backup(){const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'导出完整备份',exact:true}).click()]);return JSON.parse(await readFile(await download.path(),'utf8')).documents;}
  async function discover(){await page.getByRole('button',{name:'发现与添加',exact:true}).click();await expect(page.getByLabel('播客或视频链接')).toBeVisible();}
  async function loadFeed(){await page.getByLabel('播客或视频链接').fill(sourceFeed);await page.getByRole('button',{name:'打开链接',exact:true}).click();await expect(episode()).toBeVisible();}
  async function noPlayback(){assert.equal(await page.evaluate(()=>window.__authoredPlays),expectedPlays);for(const player of await page.locator('audio,video').all())assert.equal(await player.evaluate(element=>element.paused),true);}
  async function screenshot(name){const geometry=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));assert.ok(geometry.document<=width+1,'Audio-first horizontal overflow '+JSON.stringify(geometry));await page.screenshot({path:path.join(output,`source-audio-first-${name}-${width}.png`),fullPage:true});}
  const status=await fetch(origin+'/api/v1/library').then(response=>response.json());assert.equal(status.backend,'sqlite');assert.equal(status.sequence,0);
  await page.goto(origin);await loadFeed();assert.deepEqual(fixture.counts,{feed:1,transcript:0,media:0});
  // Valid same-language publisher metadata recommends this track even though
  // its bytes are deliberately broken. Audio-first must still bypass fetching it.
  await expect(episode().getByRole('button',{name:'打开单集',exact:true})).toBeEnabled();
  const trackChoice=episode().getByRole('combobox');await expect(trackChoice).toHaveValue('');await expect(trackChoice.locator('option:checked')).toHaveText('默认：en · text/vtt（可切换）');await expect(trackChoice.locator(`option[value="${audioFirstTrack}"]`)).toHaveText('en · text/vtt · 1');await expect(audioFirst()).toBeEnabled();
  const missing=page.locator('.episode-list article').filter({has:page.getByRole('heading',{name:'Authored episode without audio',exact:true})});await expect(missing.getByRole('button',{name:'先听原声',exact:true})).toBeDisabled();await expect(missing).toContainText('未提供可用的公开原声');await screenshot('choice');
  // Selecting a known-bad track does not make audio-first fetch that track.
  await episode().getByRole('combobox').selectOption(audioFirstTrack);await audioFirst().click();await expect(page.getByRole('heading',{name:'先播放原文件',exact:true})).toBeVisible();await saved();
  assert.deepEqual(fixture.counts,{feed:1,transcript:0,media:0});const opened=requests.findLast(request=>request.path==='/api/v1/ingestions').body;assert.equal(opened.intent,'media_only');assert.equal(opened.episode.transcript_url,undefined);await expect(page.locator('audio')).toHaveCount(0);await noPlayback();
  // Empty notes are disclosed by the reader UI; interact with the same summary as a user.
  const projectNote=page.locator('.rw-project-note'),noteInput=page.getByRole('textbox',{name:'项目笔记',exact:true});
  await expect(projectNote).not.toHaveAttribute('open');await expect(noteInput).not.toBeVisible();await projectNote.locator('summary').click();await expect(projectNote).toHaveAttribute('open');await expect(noteInput).toBeVisible();
  await noteInput.fill('Keep this audio-first project note');await page.getByRole('button',{name:'保存笔记',exact:true}).click();await saved();
  let docs=await backup(),original=docs[0];assert.equal(docs.length,1);assert.equal(original.project_kind,'audio_only');assert.equal(original.podcast_source.media_url,audioFirstMedia);assert.equal(original.segments.length,0);assert.equal(original.project_note,'Keep this audio-first project note');
  await loadMedia().click();await expect(page.locator('audio')).toHaveCount(1);await expect(page.getByRole('button',{name:'播放原声',exact:true})).toBeVisible();await expect.poll(()=>page.locator('audio').evaluate(player=>player.duration)).toBe(40);assert.equal(fixture.counts.media,1);assert.equal(fixture.counts.transcript,0);await noPlayback();
  // Explicit playback uses the browser's real decoder; then pause and seek.
  await page.locator('audio').evaluate(player=>player.play());expectedPlays++;await expect.poll(()=>page.locator('audio').evaluate(player=>player.currentTime)).toBeGreaterThan(0);await page.locator('audio').evaluate(player=>player.pause());await noPlayback();
  await page.locator('audio').evaluate(player=>{player.currentTime=8;});await expect(page.getByRole('button',{name:'记录当前播放位置 · 00:08',exact:true})).toBeEnabled();await expect.poll(()=>page.locator('audio').evaluate(player=>player.seeking)).toBe(false);await page.getByRole('button',{name:'停止回听',exact:true}).click();await page.getByRole('button',{name:'记录当前播放位置 · 00:08',exact:true}).click();await saved();
  await page.getByRole('button',{name:'编辑书签',exact:true}).click();await page.getByLabel('备注',{exact:true}).fill('Keep this eight-second bookmark');await page.getByRole('button',{name:'保存记录',exact:true}).click();await saved();
  docs=await backup();original=docs[0];assert.equal(original.timestamp_bookmarks[0].time,8);assert.equal(original.timestamp_bookmarks[0].note,'Keep this eight-second bookmark');await expect.poll(()=>page.evaluate(key=>JSON.parse(localStorage.getItem('coconut-listening-v1:'+key)||'null')?.time,original.key)).toBe(8);await noPlayback();
  // Reload drops session bytes; neither fetching nor resuming is automatic.
  await page.reload();expectedPlays=0;await expect(loadMedia()).toBeVisible();await expect(page.locator('audio')).toHaveCount(0);assert.equal(fixture.counts.media,1);assert.equal(fixture.counts.transcript,0);assert.deepEqual(await backup(),[original]);await expect(projectNote).toHaveAttribute('open');await expect(noteInput).toBeVisible();await expect(noteInput).toHaveValue(original.project_note);
  await loadMedia().click();await expect.poll(()=>page.locator('audio').evaluate(player=>player.duration)).toBe(40);assert.equal(fixture.counts.media,2);await noPlayback();assert.equal(await page.locator('audio').evaluate(player=>player.currentTime),0);
  await page.getByRole('button',{name:'继续收听 00:08 · 仅定位',exact:true}).click();await expect.poll(()=>page.locator('audio').evaluate(player=>player.currentTime)).toBe(8);await noPlayback();
  // An explicit transcript request still surfaces the original parser error.
  await discover();await loadFeed();await episode().getByRole('combobox').selectOption(audioFirstTrack);await episode().getByRole('button',{name:'打开单集',exact:true}).click();await expect(sourceError()).toContainText('不是 WebVTT');assert.equal(fixture.counts.transcript,1);assert.equal(requests.findLast(request=>request.path==='/api/v1/ingestions').body.episode.transcript_url,audioFirstTrack);await expect(audioFirst()).toBeEnabled();assert.deepEqual(await backup(),[original]);
  await audioFirst().click();await expect(page.getByRole('region',{name:'此来源已在书架'})).toBeVisible();assert.equal(fixture.counts.transcript,1);assert.equal((await backup()).length,1);await page.getByRole('button',{name:'继续已有项目 · '+original.key.slice(-8),exact:true}).click();await expect(page.getByRole('textbox',{name:'项目笔记',exact:true})).toHaveValue(original.project_note);await noPlayback();
  // Later valid publisher bytes attach only after review, in the same project.
  fixture.state.fixed=true;await discover();await episode().getByRole('button',{name:'打开单集',exact:true}).click();await expect(page.getByRole('region',{name:'此来源已在书架'})).toBeVisible();assert.equal((await backup())[0].segments.length,0);await page.getByRole('button',{name:'核对新文字稿 · '+original.key.slice(-8),exact:true}).click();await expect(page.getByRole('region',{name:'核对并接入文字稿'})).toContainText('The same audio project');
  await page.getByRole('button',{name:'取消接入',exact:true}).click();assert.deepEqual(await backup(),[original]);await page.getByRole('button',{name:'核对新文字稿 · '+original.key.slice(-8),exact:true}).click();await page.getByRole('button',{name:'确认接入此原声项目',exact:true}).click();await expect(page.locator('.rw-original')).toHaveText('The same audio project now has a reviewed transcript.');await saved();
  await expect(projectNote).toHaveAttribute('open');await expect(noteInput).toBeVisible();await expect(noteInput).toHaveValue(original.project_note);
  const upgraded=(await backup())[0];assert.equal(upgraded.key,original.key);assert.equal(upgraded.project_note,original.project_note);assert.deepEqual(upgraded.timestamp_bookmarks,original.timestamp_bookmarks);assert.equal(upgraded.podcast_source.media_url,original.podcast_source.media_url);assert.equal(upgraded.podcast_source.feed_url,original.podcast_source.feed_url);assert.equal(upgraded.podcast_source.episode_id,original.podcast_source.episode_id);assert.equal(upgraded.podcast_source.transcript_url,audioFirstTrack);await noPlayback();
  await discover();await audioFirst().click();await expect(page.getByRole('region',{name:'此来源已在书架'})).toBeVisible();await expect(page.getByRole('button',{name:/核对新文字稿/})).toHaveCount(0);await page.getByRole('button',{name:'继续已有项目 · '+original.key.slice(-8),exact:true}).click();await expect(page.locator('.rw-original')).toHaveCount(1);assert.deepEqual(await backup(),[upgraded],'audio-first never downgrades an existing transcript project');
  await page.reload();expectedPlays=0;await expect(page.locator('.rw-original')).toHaveCount(1);assert.deepEqual(await backup(),[upgraded]);await expect(projectNote).toHaveAttribute('open');await expect(noteInput).toBeVisible();await expect(noteInput).toHaveValue(original.project_note);await expect(loadMedia()).toBeVisible();const beforeFailures={...fixture.counts};
  // Media failure/cancel and removed enclosure never destroy saved work.
  fixture.state.failMedia=true;await loadMedia().click();await expect(page.locator('.remote-media [role="status"]')).toContainText('原声下载未完成');await expect(page.locator('audio')).toHaveCount(0);assert.deepEqual(await backup(),[upgraded]);fixture.state.failMedia=false;
  fixture.state.holdMedia=new Promise(resolve=>release=resolve);await loadMedia().click();await expect.poll(()=>fixture.counts.media).toBe(beforeFailures.media+2);await page.locator('.remote-media').getByRole('button',{name:'取消',exact:true}).click();release();release=null;fixture.state.holdMedia=null;await expect(loadMedia()).toBeEnabled();await expect(page.locator('audio')).toHaveCount(0);await noPlayback();
  fixture.state.missingMedia=true;await loadMedia().click();await expect(page.locator('.remote-media [role="status"]')).toContainText('原声下载未完成');await expect(loadMedia()).toBeEnabled();assert.deepEqual(await backup(),[upgraded]);assert.equal(fixture.counts.transcript,beforeFailures.transcript);
  await discover();await loadFeed();await expect(audioFirst()).toBeDisabled();assert.deepEqual(await backup(),[upgraded]);fixture.state.missingMedia=false;await page.getByRole('button',{name:'刷新节目列表',exact:true}).click();await expect(audioFirst()).toBeEnabled();
  // Expiry makes the server recheck; cancel/new URL/navigation retire late replies.
  for(const boundary of ['cancel','new URL','navigation']){
   const before={...fixture.counts};fixture.state.now+=60001;fixture.state.holdFeed=new Promise(resolve=>release=resolve);await audioFirst().click();await expect.poll(()=>fixture.counts.feed).toBe(before.feed+1);await expect(audioFirst()).toBeDisabled();
   if(boundary==='cancel')await page.getByRole('button',{name:'取消读取',exact:true}).click();
   if(boundary==='new URL')await page.getByLabel('播客或视频链接').fill('https://publisher.example.org/new');
   if(boundary==='navigation')await page.getByRole('button',{name:/^我的内容/}).click();
   await expect.poll(()=>fixture.calls.findLast(call=>call.url===sourceFeed)?.signal?.aborted).toBe(true);release();release=null;fixture.state.holdFeed=null;
   assert.equal(fixture.counts.transcript,before.transcript);assert.equal(fixture.counts.media,before.media);assert.deepEqual(await backup(),[upgraded]);
   if(boundary==='cancel'){await expect(sourceError()).toContainText('读取已取消');await page.getByRole('button',{name:'重试上次读取：Authored audio-first episode',exact:true}).click();await expect(page.getByRole('region',{name:'此来源已在书架'})).toBeVisible();assert.equal(requests.findLast(request=>request.path==='/api/v1/ingestions').body.intent,'media_only');await page.getByRole('button',{name:'返回单集列表',exact:true}).click();}
   if(boundary==='new URL'){await expect(page.locator('.episode-list')).toHaveCount(0);await loadFeed();}
   if(boundary==='navigation'){await discover();await expect(sourceError()).toContainText('读取已暂停');}
  }
  assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);await noPlayback();
  return {width,counts:fixture.counts,passed:['audio-first ignores selected broken transcript with zero transcript/media fetch','real authored WAV decoded only on explicit media load and playback advances only after explicit play','SQLite project note and time bookmark survive reload','explicit seek-only listening resume without autoplay','transcript parser failure remains visible','same-project reviewed attachment preserves source and notes','repeated source open never downgrades transcript','missing media and failed/cancelled media acquisition preserve saved work','cancel/new URL/navigation retire stale audio-only requests'],forbidden,errors};
 }finally{release?.();fixture.state.holdFeed=null;fixture.state.holdMedia=null;await context.close();await server.shutdown();}
}
