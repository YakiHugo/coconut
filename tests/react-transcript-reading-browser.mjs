/** Authored text, real React and SQLite. No external services or inference. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {startDevelopmentBridge} from '../desktop/dev.mjs';
import {chromium,expect} from '@playwright/test';
const require=createRequire(import.meta.url),P=require('../reader/passages.js');
const directory=await mkdtemp(path.join(tmpdir(),'coconut-reading-ui-'));
const fixture={key:'reading-proof',title:'自写访谈：让文字稿可以连续阅读 · '+ 'LongEpisodeTitleWithoutWhitespace'.repeat(4),language:'zh',source_url:'https://www.bilibili.com/video/BV1wgpy69Ekz',
 provenance:{kind:'authored_demo',punctuation_method:'local-reading-v1',speaker_method:'local-reading-v1'},
 notes:{'cue-0':'自写笔记，仍在对应段落。'},segments:Array.from({length:120},(_,i)=>({id:'cue-'+i,start:i*2,end:i*2+2,
 text:i%3===2?'先读完这一句话，再回听对应的原声。':'把被字幕切开的表达连在一起，',speaker:i<36?'说话人 1':i<80?'说话人 2':i<86?null:'说话人 1'}))};
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
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.goto(origin);await page.getByRole('button',{name:/^我的内容/}).click();await page.locator('.library-page li > button').filter({hasText:fixture.title}).click();
 await expect(page.locator('.rw-reading-controls select').first()).toHaveValue('passages');
 await expect(page.locator('.rw-cue')).toHaveCount(0);await expect(page.locator('.rw-passage').first()).toBeVisible();
 assert.ok(await page.locator('[data-source-id]').count()>await page.locator('.rw-passage').count()*3);
 await expect(page.locator('.rw-original').first()).toHaveAttribute('tabindex','0');
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
 const expected=P.build(fixture.segments,{layout:'reading'}).map(p=>p.cues.map(c=>c.id)),actual=[];
 while(true){
  actual.push(...await page.locator('.rw-passage').evaluateAll(rows=>rows.map(row=>[...row.querySelectorAll('[data-source-id]')].map(cue=>cue.dataset.sourceId))));
  if(await page.getByRole('button',{name:'下一页',exact:true}).isDisabled())break;
  await page.getByRole('button',{name:'下一页',exact:true}).click();
 }
 assert.deepEqual(actual,expected,'Pagination must never cut an already formed paragraph or omit a cue');
 assert.equal(actual.flat().length,120);await expect(page.locator('.rw-speaker-label').first()).toHaveText('说话人 1');
 await page.getByRole('button',{name:'上一页',exact:true}).click();await expect(page.locator('.rw-speaker-label').filter({hasText:'未标注'}).first()).toBeVisible();
 const anchor=await page.locator('[data-source-id]').first().getAttribute('data-source-id');
 await page.locator('.rw-reading-controls select').first().selectOption('transcript');
 await expect(page.locator('[data-source-id="'+anchor+'"]')).toBeVisible();
 await expect(page.locator('.rw-current')).toHaveAttribute('data-cue-id',anchor);
 await page.locator('.rw-reading-controls select').first().selectOption('passages');
 await expect(page.locator('[data-source-id="'+anchor+'"]')).toBeVisible();
 await page.locator('.rw-inspect-passage').first().click();
 await expect(page.locator('.rw-reading-controls select').first()).toHaveValue('transcript');
 await expect(page.locator('.rw-cue').first()).toBeVisible();
 await page.locator('.rw-reading-controls select').first().selectOption('passages');
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile reading cannot overflow horizontally');
 await page.reload();await page.getByRole('button',{name:'继续阅读',exact:true}).click();await expect(page.locator('.rw-reading-controls select').first()).toHaveValue('passages');
 assert.equal((await saved()).segments.length,120);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,paragraphs:actual.length,cues:120,exact_selection:true,clipboard:true,sqlite_reload:true,mobile:true}));
}finally{await browser?.close();await server?.shutdown();await rm(directory,{recursive:true,force:true});}
