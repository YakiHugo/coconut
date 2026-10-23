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
 const context=await browser.newContext({viewport:{width:1360,height:900},permissions:['clipboard-read','clipboard-write']}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin!==origin?route.abort():new URL(route.request().url()).pathname==='/api/podcasts/media'?route.fulfill({status:200,contentType:'audio/wav',body:wav(260)}):route.continue());
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
 // Speaker changes have a quiet identity; continuations retain their timestamp.
 await expect(page.locator('.rw-speaker-avatar')).toHaveCount(0);await expect(page.locator('.rw-passage').first().locator('.rw-speaker-label')).toHaveCount(1);
 await expect(page.locator('.rw-passage').nth(1).locator('.rw-speaker-label')).toHaveCount(0);
 assert.equal(await page.locator('.rw-turn-continuation .rw-passage-heading').first().evaluate(node=>getComputedStyle(node,'::before').content),'none');
 // The timestamp starts continuous playback, while explicit range listening still stops.
 await page.getByRole('button',{name:'载入原声（最多 200 MiB）',exact:true}).click();
 const audio=page.locator('audio');await expect.poll(()=>audio.evaluate(player=>player.duration)).toBe(260);
 assert.equal(await audio.evaluate(player=>player.paused),true,'Loading never starts playback');
 const firstPassage=P.build(fixture.segments,{layout:'reading'})[0];
 await page.getByRole('button',{name:'从 00:00 开始播放',exact:true}).click();
 await expect.poll(()=>audio.evaluate(player=>player.paused)).toBe(false);
 await audio.evaluate((player,end)=>{player.currentTime=end+.25;player.dispatchEvent(new Event('timeupdate'));},firstPassage.end);
 await expect(page.locator('.rw-passage').nth(1)).toHaveClass(/rw-passage-playing/);
 assert.equal(await audio.evaluate(player=>player.paused),false,'A timestamp must continue past its paragraph end');
 if(!await page.locator('.rw-player-options').getAttribute('open').then(value=>value!==null))await page.locator('.rw-player-options>summary').click();
 await page.getByRole('button',{name:'停止回听',exact:true}).click();
 await page.getByRole('button',{name:'回听整段 · 00:00',exact:true}).click();
 await expect.poll(()=>audio.evaluate(player=>player.paused)).toBe(false);
 await audio.evaluate((player,end)=>{player.currentTime=end+.25;player.dispatchEvent(new Event('timeupdate'));},firstPassage.end);
 await expect.poll(()=>audio.evaluate(player=>player.paused)).toBe(true);
 if(!await page.locator('.rw-player-options').getAttribute('open').then(value=>value!==null))await page.locator('.rw-player-options>summary').click();
 await page.getByRole('button',{name:'停止回听',exact:true}).click();
 await page.locator('.rw-player-options>summary').click();
 // Headless Chromium screenshots are authored UI evidence, not Podwise content.
 await mkdir(output,{recursive:true});await page.locator('.rw-passages').scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(output,'transcript-desktop.png')});
 await page.getByText('段落笔记 · 1',{exact:true}).click();await expect(page.locator('.rw-passage-notes')).toContainText(fixture.notes['cue-0']);
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
 await page.locator('[data-source-id]').first().scrollIntoViewIfNeeded();
 const anchor=await page.locator('[data-source-id]').first().getAttribute('data-source-id');
 await page.locator('.rw-mode-tabs [data-mode="transcript"]').click();
 await expect(page.locator('[data-source-id="'+anchor+'"]')).toBeVisible();
 await expect(page.locator('.rw-current')).toHaveAttribute('data-cue-id',anchor);
 await page.locator('.rw-mode-tabs [data-mode="passages"]').click();
 await expect(page.locator('[data-source-id="'+anchor+'"]')).toBeVisible();
 await page.locator('.rw-inspect-passage').first().click();
 await expect(page.locator('.rw-mode-tabs [aria-selected=true]')).toHaveAttribute('data-mode','transcript');
 await expect(page.locator('.rw-cue').first()).toBeVisible();
 await page.locator('.rw-mode-tabs [data-mode="passages"]').click();
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile reading cannot overflow horizontally');
 await page.locator('.rw-passages').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'transcript-mobile.png')});
 await page.reload();await page.getByRole('button',{name:'继续阅读',exact:true}).click();await expect(page.locator('.rw-mode-tabs [aria-selected=true]')).toHaveAttribute('data-mode','passages');
 assert.equal((await saved()).segments.length,120);assert.deepEqual(errors,[]);
 // A citation switches to the full transcript, keeping one real player alive. Clicking it again must relocate after manual scrolling.
 await page.setViewportSize({width:1360,height:900});
 await page.getByRole('button',{name:'载入原声（最多 200 MiB）',exact:true}).click();
 await expect.poll(()=>audio.evaluate(player=>player.duration)).toBe(260);
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
  ['说话人 1',49,79,'还有一个很小的细节：两个人说话的节奏是不一样的。换人时用头像和颜色提醒一下，就知道是谁接过了话。同一个人继续讲的时候，安静地留下时间标记就够了。'],
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
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,paragraphs:actual.length,cues:120,tabs_keyboard:true,continuous_playback:true,bounded_replay:true,exact_selection:true,clipboard:true,sqlite_reload:true,mobile:true,screenshots:output}));
}finally{await browser?.close();await server?.shutdown();await rm(directory,{recursive:true,force:true});}
