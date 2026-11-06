/** Authored text, real React and SQLite. No external services or inference. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {startDevelopmentBridge} from '../desktop/dev.mjs';
import {chromium,expect} from '@playwright/test';
const require=createRequire(import.meta.url),P=require('../reader/passages.js'),C=require('../reader/core.js'),S=require('../reader/summary.js');
function savedSummary(doc){const source={...C.validate(doc),key:doc.key},plan=S.plan(source),job=S.create(plan,'codex');let answer;while(!answer){const request=S.request(plan,job);answer=S.accept(plan,job,{answer:'## 让声音成为可以重读的内容\n\n**连续阅读**保留完整的表达，时间戳让文字与声音连在一起。\n\n- 阅读时保留上下文\n- 回听原话，再留下自己的理解\n\n核对来源 ['+request.segments.at(-1).id+']',citations:[request.segments[0].id,request.segments.at(-1).id]});}return answer;}
const directory=await mkdtemp(path.join(tmpdir(),'coconut-reading-ui-'));
const output=process.env.COCONUT_REACT_ARTIFACTS||'/tmp/coconut-transcript-interactions';
function wav(seconds){const data=Buffer.alloc(44+seconds*16000);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(8000,24);data.writeUInt32LE(16000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(data.length-44,40);return data;}
const fixture={key:'reading-proof',title:'自写访谈：让文字稿可以连续阅读 · '+ 'LongEpisodeTitleWithoutWhitespace'.repeat(4),language:'zh',source_url:'https://www.bilibili.com/video/BV1wgpy69Ekz',
 podcast_source:{kind:'direct_media',media_url:'https://publisher.example/authored.wav',media_kind:'audio'},
 provenance:{kind:'authored_demo',punctuation_method:'local-reading-v1',speaker_method:'local-reading-v1'},
 notes:{'cue-0':'自写笔记，仍在对应段落。'},segments:Array.from({length:120},(_,i)=>({id:'cue-'+i,start:i*2,end:i*2+2,
 text:i%3===2?'先读完这一句话，再回听对应的原声。':'把被字幕切开的表达连在一起，',speaker:i<36?'说话人 1':i<80?'说话人 2':i<86?null:'说话人 1'}))};
fixture.ai_answers=[savedSummary(fixture)];
let server,browser;
try {
 ({server}=await startDevelopmentBridge({port:0,libraryDirectory:directory,taskDirectory:null,captionPython:null,captionProxy:null,privateProxy:null}));
 const origin='http://127.0.0.1:'+server.address().port;
 const request=async(route,body)=>{const response=await fetch(origin+route,body?{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}:{});assert.ok(response.ok);return response.json();};
 const library=await request('/api/v1/library');
 await request('/api/v1/library/commit',{protocolVersion:1,epoch:library.epoch,action:'put',key:fixture.key,receiptKey:'reading-seed',expected:null,document:fixture});
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1360,height:900},permissions:['clipboard-read','clipboard-write']}),page=await context.newPage(),errors=[];let sourceMediaRequests=0;
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();if(url.pathname==='/api/podcasts/media'){sourceMediaRequests++;return route.fulfill({status:200,contentType:'audio/wav',body:wav(260)});}return route.continue();});
 await page.goto(origin);await page.getByRole('button',{name:/^我的内容/}).click();await page.locator('.library-page li > button').filter({hasText:fixture.title}).click();
 await expect(page.locator('.rw-mode-tabs [aria-selected=true]')).toHaveAttribute('data-mode','passages');
 await expect(page.locator('.rw-cue')).toHaveCount(0);await expect(page.locator('.rw-passage').first()).toBeVisible();
 assert.ok(await page.locator('[data-source-id]').count()>await page.locator('.rw-passage').count()*3);
 await expect(page.locator('.rw-original').first()).toHaveAttribute('tabindex','0');
 // Real tabs: one Tab stop, arrows/Home/End select a panel without losing the cue.
 const readingTab=page.getByRole('tab',{name:'文字稿',exact:true});
 await readingTab.focus();await page.keyboard.press('ArrowRight');
 await expect(page.getByRole('tab',{name:'逐句校对',exact:true})).toBeFocused();
 await expect(page.locator('.rw-current')).toHaveAttribute('data-cue-id','cue-0');
 await page.keyboard.press('End');await expect(page.getByRole('tab',{name:'摘要',exact:true})).toBeFocused();
 await expect(page.getByRole('region',{name:'摘要阅读'})).toBeVisible();
 await page.keyboard.press('Home');await expect(readingTab).toBeFocused();
 assert.equal(await page.locator('[role=tab][tabindex="0"]').count(),1);
 await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby',await readingTab.getAttribute('id'));
 // Every text-length block carries its own identity and source timestamp.
 await expect(page.locator('.rw-speaker-avatar')).toHaveCount(0);await expect(page.locator('.rw-passage').first().locator('.rw-speaker-label')).toHaveCount(1);
 assert.equal(await page.locator('.rw-speaker-label').count(),await page.locator('.rw-passage').count());
 await expect(page.locator('.rw-passage').nth(1).locator('.rw-speaker-label')).toHaveText('说话人 1');
 await expect(page.locator('.rw-passage').nth(1).locator('.rw-cue-meta :is(button,a)')).toHaveCount(1);
 // The timestamp starts continuous playback, while explicit range listening still stops.
 await page.getByRole('button',{name:'载入原声（最多 200 MiB）',exact:true}).click();
 const audio=page.locator('audio');await expect.poll(()=>audio.evaluate(player=>player.duration)).toBe(260);const ownedMediaUrl=await audio.evaluate(player=>player.currentSrc||player.src);assert.equal(new URL(ownedMediaUrl).pathname,'/api/v1/source-media/content');assert.equal(sourceMediaRequests,1);
 assert.equal(await audio.evaluate(player=>player.paused),true,'Loading never starts playback');
 const firstPassage=P.build(fixture.segments,{layout:'reading'})[0];
 await page.getByRole('button',{name:'从 00:00 开始播放',exact:true}).click();
 await expect.poll(()=>audio.evaluate(player=>player.paused)).toBe(false);
 await audio.evaluate((player,end)=>{player.currentTime=end+.25;player.dispatchEvent(new Event('timeupdate'));},firstPassage.end);
 await expect(page.locator('.rw-passage').nth(1)).toHaveClass(/rw-passage-playing/);
 assert.equal(await audio.evaluate(player=>player.paused),false,'A timestamp must continue past its paragraph end');
 await page.getByRole('button',{name:'暂停播放',exact:true}).click();
 // Following has one anchor in both reading modes and on desktop/mobile.
 await page.getByRole('button',{name:/^我的内容/}).click();
 await page.locator('.library-page li > button').filter({hasText:fixture.title}).click();
 if(await page.getByRole('button',{name:'载入原声（最多 200 MiB）',exact:true}).count())await page.getByRole('button',{name:'载入原声（最多 200 MiB）',exact:true}).click();
 await expect.poll(()=>audio.evaluate(player=>player.duration)).toBe(260);
 const followInput=page.locator('.rw-player-follow input');
 const settleScroll=()=>page.evaluate(()=>new Promise(resolve=>{
  let last=scrollY,stable=0;const started=performance.now();
  const sample=()=>{stable=Math.abs(scrollY-last)<1?stable+1:0;last=scrollY;if(stable>=6||performance.now()-started>2000)resolve();else requestAnimationFrame(sample);};
  requestAnimationFrame(sample);
 }));
 const followGeometry=(cueId='cue-70')=>page.evaluate(id=>{
  const source=document.querySelector('[data-source-id="'+CSS.escape(id)+'"]');
  const speech=source.matches('.rw-playing')?source:source.querySelector('.rw-playing')||source;
  const range=document.createRange();range.selectNodeContents(speech);
  const rect=[...range.getClientRects()].find(rect=>rect.width&&rect.height);
  const top=24+document.querySelector('.rw-content-switch').getBoundingClientRect().height;
  const bottom=document.querySelector('.rw-player').getBoundingClientRect().top-24;
  return {top:rect.top,bottom:rect.bottom,anchor:top+(bottom-top)/4,limit:bottom,scroll:scrollY};
 },cueId);
 for(const width of [1360,390])for(const mode of ['passages','transcript']){
  await page.setViewportSize({width,height:900});
  await followInput.evaluate(input=>{if(input.checked)input.click();});
  await page.locator('.rw-mode-tabs [data-mode="'+mode+'"]').click();
  await audio.evaluate(player=>{player.pause();player.currentTime=140.25;player.dispatchEvent(new Event('timeupdate'));});
  await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await settleScroll();
  await followInput.evaluate(input=>{
   input.click();const player=document.querySelector('audio');let ticks=0;
   const timer=setInterval(()=>{player.currentTime+=.01;player.dispatchEvent(new Event('timeupdate'));if(++ticks===8)clearInterval(timer);},60);
  });await expect(followInput).toBeChecked();await settleScroll();
  const initial=await followGeometry();
  assert.ok(Math.abs(initial.top-initial.anchor)<4,JSON.stringify({width,mode,initial}));
  assert.ok(initial.bottom<initial.limit,'Speech clears the persistent player');
  await audio.evaluate(player=>{player.currentTime=140.75;player.dispatchEvent(new Event('timeupdate'));});await settleScroll();
  const stationary=await followGeometry();
  // content-visibility may change scrollY as the browser preserves its anchor;
  // the observable invariant is the text's position on screen.
  assert.ok(Math.abs(stationary.top-initial.top)<2,'Visible speech stays still across time updates '+JSON.stringify({width,mode,initial,stationary}));
  // Real wheel input outside .rw-cues must suspend follow and keep the chosen view.
  await page.mouse.move(width-25,120);await page.mouse.wheel(0,250);
  await expect(followInput).not.toBeChecked();await settleScroll();const manual=await page.evaluate(()=>scrollY);
  await audio.evaluate(player=>{player.currentTime=220.25;player.dispatchEvent(new Event('timeupdate'));});await settleScroll();
  assert.ok(Math.abs(await page.evaluate(()=>scrollY)-manual)<2,'Playback does not pull manual reading back');
  await expect(page.locator('.rw-mode-tabs [aria-selected=true]')).toHaveAttribute('data-mode',mode);
  // Explicit location uses the same anchor, even for an already-visible source.
  await audio.evaluate(player=>{player.currentTime=140.25;player.dispatchEvent(new Event('timeupdate'));});
  await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await settleScroll();
  const samples=await page.getByTitle('定位当前原话',{exact:true}).evaluate(button=>new Promise(resolve=>{
   const positions=[],started=performance.now();button.click();
   const sample=()=>{positions.push(scrollY);if(performance.now()-started>=600)resolve(positions);else requestAnimationFrame(sample);};requestAnimationFrame(sample);
  }));
  assert.ok(new Set(samples.map(Math.round)).size>5,'Location moves through intermediate positions instead of flashing');
  await settleScroll();const located=await followGeometry();
  assert.ok(Math.abs(located.top-located.anchor)<4,JSON.stringify({width,mode,located}));
  await page.evaluate(()=>window.scrollBy({top:60,behavior:'instant'}));await settleScroll();
  await page.getByTitle('定位当前原话',{exact:true}).click();await settleScroll();
  const repeated=await followGeometry();
  assert.ok(Math.abs(repeated.top-repeated.anchor)<4,'Visible speech is also aligned on explicit location');
  await audio.evaluate(player=>{player.currentTime=220.25;player.dispatchEvent(new Event('timeupdate'));});
  await settleScroll();
  // Selection Play must align even a visible source, with follow switched off.
  await followInput.evaluate(input=>{if(input.checked)input.click();});
  const selectedSource=page.locator('[data-source-id="cue-70"]');
  await selectedSource.evaluate(node=>node.scrollIntoView({block:'center'}));await settleScroll();
  if(mode==='passages')await selectedSource.click();
  else await selectedSource.evaluate(node=>{
   const range=document.createRange();range.setStart(node.firstChild,2);range.setEnd(node.firstChild,8);
   getSelection().removeAllRanges();getSelection().addRange(range);node.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
  });
  await expect(followInput).not.toBeChecked();
  const beforeSelectionPlay=await followGeometry();
  assert.ok(Math.abs(beforeSelectionPlay.top-beforeSelectionPlay.anchor)>30,'Selection begins away from the reading anchor');
  await page.getByRole('button',{name:'从所选位置播放',exact:true}).click();
  await expect.poll(()=>audio.evaluate(player=>!player.paused&&player.currentTime>=140&&player.currentTime<142)).toBe(true);
  await settleScroll();const selectedPlaying=await followGeometry();
  assert.ok(Math.abs(selectedPlaying.top-selectedPlaying.anchor)<4,JSON.stringify({width,mode,selectedPlaying}));
  // Each subsequent source keeps the same anchor even while already visible.
  for(const next of [71,72,73]){
   await audio.evaluate((player,index)=>{player.currentTime=index*2+.25;player.dispatchEvent(new Event('timeupdate'));},next);
   await settleScroll();const continued=await followGeometry('cue-'+next);
   assert.ok(Math.abs(continued.top-continued.anchor)<4,JSON.stringify({width,mode,next,continued}));
   assert.equal(await audio.evaluate(player=>player.paused),false,'Following does not interrupt continuous playback');
  }
  await page.getByRole('button',{name:'暂停播放',exact:true}).click();
  // Keeping a selection while scrolling elsewhere must not lose the play target.
  await selectedSource.evaluate(node=>{
   const range=document.createRange();range.setStart(node.firstChild,2);range.setEnd(node.firstChild,8);
   getSelection().removeAllRanges();getSelection().addRange(range);node.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
  });
  await expect(page.getByRole('button',{name:'从所选位置播放',exact:true})).toBeVisible();
  await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await settleScroll();
  await expect(selectedSource).not.toBeInViewport();
  await page.getByRole('button',{name:'从所选位置播放',exact:true}).click();await settleScroll();
  const returnedSelection=await followGeometry();
  assert.ok(Math.abs(returnedSelection.top-returnedSelection.anchor)<4,JSON.stringify({width,mode,returnedSelection}));
  await page.getByRole('button',{name:'暂停播放',exact:true}).click();
 }
 await page.setViewportSize({width:1360,height:900});
 await page.locator('.rw-mode-tabs [data-mode="passages"]').click();
 await audio.evaluate(player=>{player.currentTime=140.25;player.dispatchEvent(new Event('timeupdate'));});
 // Reduced motion keeps the same destination without an animated transition.
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await settleScroll();
 await page.getByTitle('定位当前原话',{exact:true}).click();await settleScroll();
 const reduced=await followGeometry();assert.ok(Math.abs(reduced.top-reduced.anchor)<4);
 await page.emulateMedia({reducedMotion:'no-preference'});
 // Wheel input also cancels an explicit location while its animation is running.
 await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await settleScroll();
 await page.getByTitle('定位当前原话',{exact:true}).evaluate(button=>button.click());
 await page.mouse.move(1335,120);await page.mouse.wheel(0,180);await settleScroll();
 const interrupted=await followGeometry();
 assert.ok(Math.abs(interrupted.top-interrupted.anchor)>100,'Manual scrolling interrupts the location animation');
 // Hidden playback cues must not clear an intentional reading filter.
 await page.getByRole('button',{name:'筛选与定位',exact:true}).click();
 await page.getByLabel('只看笔记',{exact:true}).check();
 await page.getByRole('button',{name:'关闭筛选与定位',exact:true}).click();
 await followInput.evaluate(input=>input.click());
 await audio.evaluate(player=>{player.currentTime=140.25;player.dispatchEvent(new Event('timeupdate'));});await settleScroll();
 await expect(page.locator('[data-source-id]')).toHaveCount(1);
 await expect(page.locator('.rw-filter-status')).toContainText('只看笔记');
 // A keyboard page scroll pauses follow just like a wheel gesture.
 await page.locator('.rw-original').first().evaluate(node=>node.focus({preventScroll:true}));
 await page.keyboard.press('PageDown');await expect(followInput).not.toBeChecked();
 await page.getByRole('button',{name:/^筛选与定位/}).click();
 await page.getByLabel('只看笔记',{exact:true}).uncheck();
 await page.getByRole('button',{name:'关闭筛选与定位',exact:true}).click();
 await page.locator('[data-source-id="cue-1"]').scrollIntoViewIfNeeded();
 await page.evaluate(()=>{
  const node=document.querySelector('[data-source-id="cue-1"]'),range=document.createRange();range.setStart(node.firstChild,2);range.setEnd(node.firstChild,8);
  getSelection().removeAllRanges();getSelection().addRange(range);node.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
 });
 const contextual=page.getByRole('complementary',{name:'选中文字操作'});await expect(contextual).toBeVisible();
 await expect(page.locator('.rw-passage-actions,.rw-inspect-passage,.rw-replay-passage')).toHaveCount(0);
 await expect(contextual.locator('p')).toHaveCount(0);
 const geometry=await page.evaluate(()=>({bar:document.querySelector('.rw-selection').getBoundingClientRect().toJSON(),selection:getSelection().getRangeAt(0).getBoundingClientRect().toJSON()}));
 assert.ok(Math.min(Math.abs(geometry.bar.top-geometry.selection.bottom),Math.abs(geometry.bar.bottom-geometry.selection.top))<80,'desktop actions sit beside the selection');
 await mkdir(output,{recursive:true});await page.screenshot({path:path.join(output,'context-selection-desktop.png')});
 await page.getByRole('button',{name:'从所选位置播放',exact:true}).click();
 await expect.poll(()=>audio.evaluate(player=>player.currentTime>=2&&player.currentTime<4&&!player.paused)).toBe(true);
 await expect(contextual).toHaveCount(0);
 await audio.evaluate((player,end)=>{player.currentTime=end+.25;player.dispatchEvent(new Event('timeupdate'));},firstPassage.end);
 assert.equal(await audio.evaluate(player=>player.paused),false,'selection Play continues past the selected cue and paragraph');
 await page.getByRole('button',{name:'暂停播放',exact:true}).click();
 await page.locator('[data-source-id="cue-0"]').scrollIntoViewIfNeeded();
 // Headless Chromium screenshots are authored UI evidence, not Podwise content.
 await mkdir(output,{recursive:true});await page.locator('.rw-passages').scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(output,'transcript-desktop.png')});
 await expect(page.locator('.rw-passage-notes')).toContainText(fixture.notes['cue-0']);
 await expect(page.locator('.rw-passage-notes')).toBeVisible();
 assert.equal(await page.locator('.rw-passages details').count(),0);
 const selected=await page.evaluate(()=>{
  const first=document.querySelector('[data-source-id="cue-0"]'),last=document.querySelector('[data-source-id="cue-1"]');
  const range=document.createRange();range.setStart(first.firstChild,2);range.setEnd(last.firstChild,10);
  const selection=getSelection();selection.removeAllRanges();selection.addRange(range);last.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return selection.toString();
 });
 await expect(page.getByRole('complementary',{name:'选中文字操作'})).toBeVisible();
 await page.getByRole('button',{name:'复制原话',exact:true}).click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),selected);
 await page.getByRole('button',{name:'保存精确摘录',exact:true}).click();
 const saved=async()=>(await request('/api/v1/library/document?protocolVersion=1&key='+fixture.key)).record.document;
 await expect.poll(async()=>(await saved()).exact_excerpts?.[0]?.text).toBe(selected);
 const expected=P.build(fixture.segments,{layout:'reading'}).map(p=>p.cues.map(c=>c.id));
 const actual=await page.locator('.rw-passage').evaluateAll(rows=>rows.map(row=>[...row.querySelectorAll('[data-source-id]')].map(cue=>cue.dataset.sourceId)));
 assert.deepEqual(actual,expected,'Continuous reading never cuts a paragraph or omits a cue');
 assert.equal(actual.flat().length,120);await expect(page.locator('[aria-label="片段分页"]')).toHaveCount(0);
 await expect(page.locator('.rw-speaker-label').first()).toHaveText('说话人 1');
 await page.locator('.rw-speaker-label').filter({hasText:'未标注'}).first().scrollIntoViewIfNeeded();
 await expect(page.locator('.rw-speaker-label').filter({hasText:'未标注'}).first()).toBeVisible();
 // Set the reading position explicitly: scrolling can leave the prior playback cue visible on Linux fonts.
 await page.locator('[data-source-id]').first().evaluate(node=>node.scrollIntoView({block:'center'}));await page.getByRole('tab',{name:'逐句校对',exact:true}).click();
 await page.locator('.rw-mode-tabs [data-mode="passages"]').click();
 await page.locator('[data-source-id]').first().scrollIntoViewIfNeeded();
 const anchor=await page.locator('[data-source-id]').first().getAttribute('data-source-id');
 await page.locator('.rw-mode-tabs [data-mode="transcript"]').click();
 await expect(page.locator('[data-source-id="'+anchor+'"]')).toBeVisible();
 await expect(page.locator('.rw-current')).toHaveAttribute('data-cue-id',anchor);
 await page.locator('.rw-mode-tabs [data-mode="passages"]').click();
 await expect(page.locator('[data-source-id="'+anchor+'"]')).toBeVisible();
 await page.locator('[data-source-id]').first().evaluate(node=>node.scrollIntoView({block:'center'}));await page.getByRole('tab',{name:'逐句校对',exact:true}).click();
 await expect(page.locator('.rw-mode-tabs [aria-selected=true]')).toHaveAttribute('data-mode','transcript');
 await expect(page.locator('.rw-cue').first()).toBeVisible();
 await page.locator('.rw-mode-tabs [data-mode="passages"]').click();
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile reading cannot overflow horizontally');
 await page.locator('.rw-passages').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'transcript-mobile.png')});
 await page.reload();await page.getByRole('button',{name:'继续阅读',exact:true}).click();await expect(page.locator('.rw-mode-tabs [aria-selected=true]')).toHaveAttribute('data-mode','passages');
 assert.equal((await saved()).segments.length,120);assert.deepEqual(errors,[]);
 // A citation switches to the full transcript, keeping the restored owned player alive. Clicking it again must relocate after manual scrolling.
 await page.setViewportSize({width:1360,height:900});
 await expect(page.getByRole('button',{name:'载入原声（最多 200 MiB）',exact:true})).toHaveCount(0);
 await expect.poll(()=>audio.evaluate(player=>player.duration)).toBe(260);assert.equal(await audio.evaluate(player=>player.currentSrc||player.src),ownedMediaUrl);assert.equal(await audio.evaluate(player=>player.paused),true);assert.equal(sourceMediaRequests,1,'reload never re-fetches publisher media');
 await page.getByRole('tab',{name:'摘要',exact:true}).click();
 const originalPlayer=await audio.elementHandle();
 await page.getByRole('button',{name:'03:58 · 核对原文',exact:true}).click();
 await expect(page.locator('.rw-reading-layout-compare')).toHaveCount(0);
 await expect(page.locator('.rw-summary')).toHaveCount(0);await expect(readingTab).toHaveAttribute('aria-selected','true');
 await expect(page.locator('[data-source-id="cue-119"]')).toBeInViewport();
 assert.equal(await audio.evaluate((node,original)=>node===original,originalPlayer),true,'view changes retain the same media owner');
 assert.equal(await audio.evaluate(node=>node.paused),true,'source navigation never starts playback');
 await page.getByRole('button',{name:'返回摘要 ↑',exact:true}).click();
 await page.getByRole('button',{name:'03:58 · 核对原文',exact:true}).click();
 await expect(page.locator('[data-source-id="cue-119"]')).toBeInViewport();
 await page.screenshot({path:path.join(output,'citation-desktop.png')});
 await page.getByRole('button',{name:'返回摘要 ↑',exact:true}).click();await page.getByRole('button',{name:'回听摘要引用 · 03:58',exact:true}).click();
 await expect.poll(()=>audio.evaluate(node=>node.paused)).toBe(false);
 await audio.evaluate(node=>{node.currentTime=241;node.dispatchEvent(new Event('timeupdate'));});
 await expect.poll(()=>audio.evaluate(node=>node.paused)).toBe(true);
 await page.getByRole('button',{name:'前进 15 秒',exact:true}).click();
 await expect.poll(()=>audio.evaluate(node=>node.currentTime)).toBe(255);
 await page.getByRole('button',{name:'后退 15 秒',exact:true}).click();
 await expect.poll(()=>audio.evaluate(node=>node.currentTime)).toBe(240);
 await page.getByRole('combobox',{name:'播放速度',exact:true}).selectOption('1.5');
 assert.equal(await audio.evaluate(node=>node.playbackRate),1.5);
 await page.getByRole('button',{name:'播放原声',exact:true}).click();
 await expect.poll(()=>audio.evaluate(node=>node.paused)).toBe(false);
 await page.getByRole('button',{name:'暂停播放',exact:true}).click();
 await expect.poll(()=>audio.evaluate(node=>node.paused)).toBe(true);
 await page.getByRole('slider',{name:'播放进度',exact:true}).focus();await page.keyboard.press('Home');
 await expect.poll(()=>audio.evaluate(node=>node.currentTime)).toBe(0);

 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.screenshot({path:path.join(output,'citation-mobile.png')});
 await page.getByRole('button',{name:'返回摘要 ↑',exact:true}).click();await page.getByRole('button',{name:'继续阅读全文',exact:true}).click();
 await expect(page.locator('.rw-reading-layout-compare')).toHaveCount(0);
 // Short, self-authored dialogue makes the speaker/continuation layout reviewable.
 const visual={...fixture,key:'reading-visual',title:'让对话，成为可以重读的文字 · 交互演示',notes:{},segments:[
  ['说话人 1',0,30,'一段好的对话，值得被慢慢读完。我们听播客的时候，常常会被某一句话打动，但过了几分钟，又很难记起它出现在哪里。文字稿的意义，就是让声音里那些值得留下的想法，有一个可以回来寻找的位置。'],
  ['说话人 1',30,43,'我希望阅读的时候，能看到完整的表达。遇到感兴趣的地方，点一下时间，就可以回到当时的声音，继续听下去。'],
  ['说话人 2',43,49,'对，文字和声音应该始终连在一起。'],
  ['说话人 1',49,79,'还有一个很小的细节：两个人说话的节奏是不一样的。同一个人继续讲，也应该根据文字长度分段。每个阅读块标清姓名和起始时间，需要回听时就能找到对应的声音。'],
  ['说话人 1',79,94,'看到想记录的原话，也可以直接选中。回听、复制，或者把它留成摘录，都从这一小段文字开始。'],
  ['说话人 2',94,103,'这样就能顺着内容往下读，需要的时候，再回到声音里。']
 ].map(([speaker,start,end,text],i)=>({id:'visual-'+i,speaker,start,end,text}))};
 visual.ai_answers=[savedSummary(visual)];
 await request('/api/v1/library/commit',{protocolVersion:1,epoch:library.epoch,action:'put',key:visual.key,receiptKey:'reading-visual',expected:null,document:visual});
 await page.reload();await page.getByRole('button',{name:/^我的内容/}).click();await page.locator('.library-page li > button').filter({hasText:visual.title}).click();
 await page.getByRole('button',{name:'载入原声（最多 200 MiB）',exact:true}).click();await expect.poll(()=>page.locator('audio').evaluate(player=>player.duration)).toBe(260);
 for(const [width,height,name] of [[1360,1000,'transcript-desktop'],[390,844,'transcript-mobile']]){
  await page.setViewportSize({width,height});await page.locator('.rw-passage').first().evaluate(node=>node.scrollIntoView({block:'start'}));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:path.join(output,name+'.png')});
 }
 await page.setViewportSize({width:1360,height:1000});await page.getByRole('tab',{name:'摘要',exact:true}).click();await expect(page.getByRole('searchbox')).toHaveCount(0);await expect(page.locator('.rw-summary-heading')).toBeInViewport();await page.screenshot({path:path.join(output,'summary-desktop.png')});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'summary-mobile.png')});
 await page.getByRole('button',{name:'01:34 · 核对原文',exact:true}).click();await expect(page.locator('[data-source-id="visual-5"]')).toBeInViewport();
 await expect(page.getByRole('searchbox')).toHaveCount(0);await page.locator('.rw-original').last().focus();await page.keyboard.press('Control+f');const find=page.getByRole('searchbox',{name:'搜索原话、译文和笔记'});await expect(find).toBeFocused();await find.fill('不存在的关键词');await expect(page.locator('.rw-search-empty')).toBeVisible();await find.press('Escape');await expect(find).toHaveCount(0);await expect(page.locator('[data-source-id="visual-5"]')).toBeVisible();
 await page.setViewportSize({width:1360,height:1000});await page.getByRole('button',{name:'搜索文字稿',exact:true}).click();await find.fill('文字');await page.screenshot({path:path.join(output,'search-desktop.png')});await find.press('Escape');
 // Long speech, fast turn-taking and bilingual blocks share the same source anchors.
 const longSentence='我们在这里完整解释一个观点，并且保留它的例子和限定条件。阅读时按文字长度分段，每一块都能回到对应的原声。';
 const mixedSegments=[...Array.from({length:18},()=>['讲述者',longSentence]),
  ...['对。','为什么？','因为条件变了。','明白。','不过有例外。','你继续。'].map((text,i)=>[i%2?'讲述者':'讨论者',text]),
  ...Array.from({length:6},()=>['讨论者',longSentence])].map(([speaker,text],i)=>({id:'mixed-'+i,speaker,
   speaker_id:speaker==='讲述者'?'speaker-0001':'speaker-0002',text,start:i*2,end:(i+1)*2,
   translations:{en:{text:'Authored translation '+i+'.',source_text:text,source_language:'zh',provider:'user'}}}));
 const mixed={...fixture,key:'reading-mixed',title:'自写样例：长讲述与快速接话',notes:{},ai_answers:[],translation_view:'en',segments:mixedSegments};
 await request('/api/v1/library/commit',{protocolVersion:1,epoch:library.epoch,action:'put',key:mixed.key,receiptKey:'reading-mixed',expected:null,document:mixed});
 await page.reload();await page.getByRole('button',{name:/^我的内容/}).click();await page.locator('.library-page li > button').filter({hasText:mixed.title}).click();
 const mixedRows=page.locator('.rw-passage');await expect(mixedRows.first()).toBeVisible();
 const narrative=page.locator('.rw-passage:not(.rw-passage-compact)'),shortRows=page.locator('.rw-passage-compact');
 assert.ok(await narrative.count()>=3);await expect(shortRows).toHaveCount(6);
 assert.deepEqual(await shortRows.locator('[data-source-id]').evaluateAll(nodes=>nodes.map(node=>node.dataset.sourceId)),mixedSegments.slice(18,24).map(cue=>cue.id),'each fast reply remains its own reading block');
 const bilingual=await mixedRows.evaluateAll(rows=>rows.map(row=>({ids:[...row.querySelectorAll('[data-source-id]')].map(node=>node.dataset.sourceId),translation:row.querySelector('.rw-translation')?.textContent,label:row.querySelector('.rw-speaker-label')?.textContent,time:row.querySelector('.rw-cue-meta :is(button,a)')?.textContent})));
 assert.deepEqual(bilingual.flatMap(row=>row.ids),mixedSegments.map(cue=>cue.id));
 for(const row of bilingual){
  const cues=row.ids.map(id=>mixedSegments.find(cue=>cue.id===id));
  assert.equal(row.label,cues[0].speaker);assert.equal(row.translation,cues.map(cue=>cue.translations.en.text).join(' '));
  assert.ok(row.time.includes(C.time(cues[0].start)));
 }
 for(const [width,height,name] of [[1360,1000,'mixed-desktop'],[390,844,'mixed-mobile']]){
  await page.setViewportSize({width,height});await shortRows.first().scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  const padding=await page.evaluate(()=>['.rw-passage-compact','.rw-passage:not(.rw-passage-compact)'].map(selector=>parseFloat(getComputedStyle(document.querySelector(selector)).paddingBottom)));
  assert.ok(padding[0]<padding[1],'short replies have tighter spacing without changing source text');
  await page.screenshot({path:path.join(output,name+'.png')});
 }
 const timeLink=shortRows.first().locator('.rw-cue-meta :is(button,a)');await timeLink.focus();
 await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');await expect(timeLink).toBeFocused();
 assert.equal(await timeLink.evaluate(node=>getComputedStyle(node).outlineStyle),'none');
 assert.notEqual(await timeLink.evaluate(node=>getComputedStyle(node).backgroundColor),'rgba(0, 0, 0, 0)','keyboard focus remains visible inside the control');
 await expect(page.locator('.rw-passages details,.rw-passages select')).toHaveCount(0);
 const touchContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),touchPage=await touchContext.newPage();
 await touchPage.goto(origin+'/#read/'+mixed.key);
 const touchControl=touchPage.locator('.rw-passage-compact .rw-cue-meta :is(button,a)').first();await touchControl.scrollIntoViewIfNeeded();
 await expect(touchControl).toBeInViewport();
 await touchPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.ok((await touchControl.boundingBox()).height>=44,'touch timestamps retain a usable target');
 await touchPage.screenshot({path:path.join(output,'mixed-touch.png')});
 await touchPage.evaluate(()=>{
  const node=document.querySelector('[data-source-id="mixed-18"]'),range=document.createRange();range.selectNodeContents(node);
  getSelection().removeAllRanges();getSelection().addRange(range);document.dispatchEvent(new Event('selectionchange'));
 });
 const touchBar=touchPage.getByRole('complementary',{name:'选中文字操作'});await expect(touchBar).toBeVisible();
 const touchBox=await touchBar.boundingBox();assert.ok(touchBox.x>=0&&touchBox.x+touchBox.width<=390&&touchBox.y+touchBox.height<=844);
 assert.ok((await touchBar.getByRole('button',{name:'保存精确摘录',exact:true}).boundingBox()).height>=44);
 await touchPage.screenshot({path:path.join(output,'context-selection-touch.png')});
 await touchBar.getByRole('button',{name:'保存双语摘录',exact:true}).tap();
 const bilingualDialog=touchPage.getByRole('dialog',{name:'保存双语摘录',exact:true});await expect(bilingualDialog).toBeVisible();
 await expect(bilingualDialog.locator('select')).toHaveCount(0);
 await expect(bilingualDialog.getByRole('combobox',{name:'已保存的译文片段',exact:true})).toBeVisible();
 await bilingualDialog.getByRole('button',{name:'关闭保存双语摘录',exact:true}).tap();await expect(touchBar).toBeVisible();
 await touchBar.getByRole('button',{name:'保存精确摘录',exact:true}).tap();
 await expect.poll(async()=>(await request('/api/v1/library/document?protocolVersion=1&key='+mixed.key)).record.document.exact_excerpts?.[0]?.text).toBe('对。');
 await touchContext.close();
 // Word-aligned sentences remain inside one source node and one reading block.
 await page.setViewportSize({width:1360,height:900});
 const followSentence='用于验证连续播放时高亮位置固定。';
 const timed={...fixture,key:'reading-timed',title:'自写样例：段内句子与原声位置',notes:{},ai_answers:[],segments:[
  {id:'timed-0',speaker:'讲述者',start:10,end:20,text:'第一句话。第二句话。第三句话。',words:[
   {word:'第一句话。',start:10,end:12},{word:'第二句话。',start:14,end:16},{word:'第三句话。',start:18,end:20}]},
  {id:'timed-1',speaker:'讲述者',start:20,end:25,text:'接下来的原声继续播放。'},
  {id:'timed-long',speaker:'讲述者',start:26,end:50,text:followSentence.repeat(12),
   words:Array.from({length:12},(_,i)=>({word:followSentence,start:26+i*2,end:28+i*2}))}
 ]};
 await request('/api/v1/library/commit',{protocolVersion:1,epoch:library.epoch,action:'put',key:timed.key,receiptKey:'reading-timed',expected:null,document:timed});
 await page.reload();await page.getByRole('button',{name:/^我的内容/}).click();await page.locator('.library-page li > button').filter({hasText:timed.title}).click();await expect(page.locator('[data-source-id="timed-0"]')).toBeVisible();
 await page.getByRole('button',{name:'载入原声（最多 200 MiB）',exact:true}).click();
 await expect.poll(()=>page.locator('audio').evaluate(player=>player.duration)).toBe(260);
 const sentences=page.locator('[data-source-id="timed-0"] .rw-speech');await expect(sentences).toHaveCount(3);
 // A normal left click opens the selected fragment's controls underneath it, without playing.
 await sentences.nth(1).click();
 await expect(contextual).toBeVisible();
 await expect(sentences.nth(1)).toHaveClass(/rw-selected-speech/);
 assert.equal(await audio.evaluate(player=>player.paused),true,'Clicking a fragment only opens actions');
 const clickedGeometry=await page.evaluate(()=>({bar:document.querySelector('.rw-selection').getBoundingClientRect().toJSON(),text:document.querySelector('.rw-selected-speech').getBoundingClientRect().toJSON()}));
 assert.ok(clickedGeometry.bar.top>=clickedGeometry.text.bottom&&clickedGeometry.bar.top-clickedGeometry.text.bottom<20,'left-click actions are directly below the clicked highlight');
 await page.getByRole('button',{name:'复制原话',exact:true}).click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'第二句话。');
 await sentences.nth(2).click();await expect(contextual).toBeVisible();
 await expect(sentences.nth(2)).toHaveClass(/rw-selected-speech/);await expect(sentences.nth(1)).not.toHaveClass(/rw-selected-speech/);
 await page.screenshot({path:path.join(output,'click-highlight-controls.png')});
 await page.getByRole('button',{name:'关闭选文操作',exact:true}).click();await expect(contextual).toHaveCount(0);
 // Paragraphs stay one Tab stop; Enter opens the active/first fragment, Tab reaches actions.
 await page.locator('.rw-original').first().focus();await page.keyboard.press('Enter');
 await expect(contextual).toBeVisible();await expect(sentences.first()).toHaveClass(/rw-selected-speech/);
 await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'从所选位置播放',exact:true})).toBeFocused();
 await page.keyboard.press('Escape');await expect(contextual).toHaveCount(0);
 // Double-click keeps the browser's smaller word selection instead of expanding to a sentence.
 await sentences.nth(1).dblclick();await expect(contextual).toBeVisible();
 const word=await page.evaluate(()=>getSelection().toString());assert.ok(word.length>0&&word.length<'第二句话。'.length);
 await page.getByRole('button',{name:'关闭选文操作',exact:true}).click();
 // Drag selection remains smaller than the clicked speech fragment, including the real click event after mouseup.
 const drag=await sentences.first().evaluate(node=>{const range=document.createRange();range.setStart(node.firstChild,1);range.setEnd(node.firstChild,4);const rect=range.getBoundingClientRect();return {x:rect.left+.5,y:rect.top+rect.height/2,end:rect.right-.5};});
 await page.mouse.move(drag.x,drag.y);await page.mouse.down();await page.mouse.move(drag.end,drag.y,{steps:8});await page.mouse.up();
 await expect(contextual).toBeVisible();assert.equal(await page.evaluate(()=>getSelection().toString()),'一句话');
 await expect(page.locator('.rw-selected-speech')).toHaveCount(0);
 await page.getByRole('button',{name:'复制原话',exact:true}).click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'一句话');
 await page.getByRole('button',{name:'关闭选文操作',exact:true}).click();
 // Narrow app panes also place the controls underneath a single-click highlight.
 await page.setViewportSize({width:515,height:900});await sentences.nth(1).click();await expect(contextual).toBeVisible();
 const narrowGeometry=await page.evaluate(()=>({bar:document.querySelector('.rw-selection').getBoundingClientRect().toJSON(),text:document.querySelector('.rw-selected-speech').getBoundingClientRect().toJSON()}));
 assert.ok(narrowGeometry.bar.top>=narrowGeometry.text.bottom&&narrowGeometry.bar.top-narrowGeometry.text.bottom<20);
 await page.screenshot({path:path.join(output,'click-highlight-controls-narrow.png')});
 await page.getByRole('button',{name:'关闭选文操作',exact:true}).click();await page.setViewportSize({width:1360,height:900});
 await sentences.nth(1).evaluate(node=>{const range=document.createRange();range.setStart(node.firstChild,1);range.setEnd(node.firstChild,4);getSelection().removeAllRanges();getSelection().addRange(range);node.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
 await page.getByRole('button',{name:'从所选位置播放',exact:true}).click();
 await expect.poll(()=>page.locator('audio').evaluate(player=>player.currentTime>=14&&player.currentTime<16&&!player.paused)).toBe(true);
 await page.locator('audio').evaluate(player=>{player.currentTime=15;player.dispatchEvent(new Event('timeupdate'));});
 await expect(sentences.nth(1)).toHaveClass(/rw-playing/);await expect(sentences.first()).not.toHaveClass(/rw-playing/);
 await sentences.nth(1).evaluate(node=>{const range=document.createRange();range.setStart(node.firstChild,1);range.setEnd(node.firstChild,4);getSelection().removeAllRanges();getSelection().addRange(range);node.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
 await page.locator('audio').evaluate(player=>{player.currentTime=18.5;player.dispatchEvent(new Event('timeupdate'));});
 await expect(sentences.nth(2)).toHaveClass(/rw-playing/);await expect(sentences.nth(1)).not.toHaveClass(/rw-playing/);
 await page.getByRole('button',{name:'复制原话',exact:true}).click();
 assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'二句话');
 await page.screenshot({path:path.join(output,'sentence-highlight-selection.png')});
 await page.getByRole('button',{name:'保存精确摘录',exact:true}).click();
 await expect.poll(async()=>(await request('/api/v1/library/document?protocolVersion=1&key='+timed.key)).record.document.exact_excerpts?.[0]?.text).toBe('二句话');
 await page.locator('audio').evaluate(player=>{player.currentTime=20.5;player.dispatchEvent(new Event('timeupdate'));});
 assert.equal(await page.locator('audio').evaluate(player=>player.paused),false);
 await expect(page.locator('[data-source-id="timed-1"]')).toHaveClass(/rw-playing/);
 assert.equal(await page.locator('[data-source-id="timed-0"]').textContent(),timed.segments[0].text);
 await page.getByRole('button',{name:'暂停播放',exact:true}).click();
 const listening=page.locator('[data-source-id="timed-long"] .rw-speech');
 const fragments=await listening.evaluateAll(nodes=>nodes.map(node=>({start:Number(node.dataset.speechStart)})));
 // Highlight changes inside one long cue share the same position as cue changes.
 for(const width of [1360,390]){
  await page.setViewportSize({width,height:900});
  await listening.nth(4).click();await page.getByRole('button',{name:'从所选位置播放',exact:true}).click();await settleScroll();
  for(const next of [5,6,7]){
   await audio.evaluate((player,start)=>{player.currentTime=start+.1;player.dispatchEvent(new Event('timeupdate'));},fragments[next].start);
   await settleScroll();const fragmentPosition=await followGeometry('timed-long');
   assert.ok(Math.abs(fragmentPosition.top-fragmentPosition.anchor)<4,JSON.stringify({width,next,fragmentPosition}));
  }
  await page.getByRole('button',{name:'暂停播放',exact:true}).click();
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,paragraphs:actual.length,cues:120,tabs_keyboard:true,continuous_playback:true,contextual_selection:true,continuous_selection_play:true,selection_play_always_locates:true,continuous_playback_keeps_anchor:true,exact_selection:true,clipboard:true,sqlite_reload:true,mobile:true,shared_reading_anchor:true,smooth_location:true,interruptible_location:true,reduced_motion:true,screenshots:output}));
}finally{await browser?.close();await server?.shutdown();await rm(directory,{recursive:true,force:true});}
