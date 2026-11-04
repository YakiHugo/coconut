/** Authored text and simulated CLI outputs exercise real durable review/save. */
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';
import {chromium,expect} from '@playwright/test';
import {startBridge} from '../desktop/server.mjs';
import {createTranscriptReviewer} from '../desktop/transcript-review.mjs';
const directory=await mkdtemp(path.join(tmpdir(),'coconut-review-browser-'));let browser,server,release,started=false,calls=0;
const fixture={schema_version:1,key:'review-authored',title:'对话刘元 · 自写校对测试',notes:{a:'原有笔记'},provenance:{kind:'local_asr',speaker_method:'recording-acoustic-v1'},segments:[{id:'a',start:0,end:2,text:'刘源来了。',speaker:'主持人',words:[{word:'刘',start:0,end:.2},{word:'源来了。',start:.2,end:2}]},{id:'b',start:2,end:4,text:'我们有12个人。',speaker:'嘉宾'}]};
try{
 const reviewer=createTranscriptReviewer({providers:{structured:async(provider,input)=>{calls++;assert.equal(provider,'kimi');assert.ok(!input.includes('原有笔记'));started=true;await new Promise(r=>release=r);return {edits:[{cue_id:'a',original:'刘源',replacement:'刘元',category:'entity',basis:'节目标题'},{cue_id:'b',original:'12',replacement:'20',category:'typo',basis:'不能用模型猜测数字'}],issues:[]};}}});
 server=await startBridge({port:0,libraryDirectory:path.join(directory,'library'),transcriptReviewer:reviewer});const origin='http://127.0.0.1:'+server.address().port;
 const request=async(route,body)=>{const response=await fetch(origin+route,body?{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}:{});assert.ok(response.ok);return response.json();};
 const library=await request('/api/v1/library');await request('/api/v1/library/commit',{protocolVersion:1,epoch:library.epoch,key:fixture.key,action:'put',receiptKey:'review-seed',expected:null,document:fixture});
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.goto(origin+'/#read/'+fixture.key);await page.getByRole('button',{name:'来源与整理',exact:true}).click();await page.getByRole('button',{name:'文字整理',exact:true}).click();await expect(page.locator('[aria-label="AI 校对文字稿"]')).toBeVisible();
 await page.getByRole('radio',{name:'Kimi CLI'}).check();await page.getByRole('button',{name:'开始全文校对',exact:true}).click();await expect.poll(()=>started).toBe(true);await page.getByRole('button',{name:'关闭来源与整理',exact:true}).click();
 await page.getByRole('tab',{name:'逐句校对',exact:true}).click();await page.locator('.rw-cue').first().locator('summary').filter({hasText:/^笔记/}).click();await page.getByRole('textbox',{name:'00:00 的笔记'}).fill('校对期间的新笔记');release();
 const saved=async()=>(await request('/api/v1/library/document?protocolVersion=1&key='+fixture.key)).record.document;
 await expect.poll(async()=>(await saved()).segments[0].text).toBe('刘源来了。');await page.getByRole('button',{name:'保存笔记',exact:true}).first().click();
 await page.getByRole('button',{name:'来源与整理',exact:true}).click();await page.getByRole('button',{name:'文字整理',exact:true}).click();await expect.poll(async()=>(await saved()).segments[0].text).toBe('刘元来了。');const result=await saved();assert.equal(result.notes.a,'校对期间的新笔记');assert.equal(result.segments[1].text,'我们有12个人。');assert.equal(result.transcript_review.issues.length,1);assert.equal(result.segments[0].original_text,'刘源来了。');assert.deepEqual(result.segments[0].words.map(w=>[w.start,w.end]),fixture.segments[0].words.map(w=>[w.start,w.end]));
 await page.reload();await page.getByRole('button',{name:'来源与整理',exact:true}).click();await page.getByRole('button',{name:'文字整理',exact:true}).click();await expect(page.getByRole('dialog',{name:'来源与整理'})).toContainText('待核对 · 1 处');assert.equal(calls,1);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await mkdir('/tmp/coconut-review-browser',{recursive:true});await page.screenshot({path:'/tmp/coconut-review-browser/mobile.png'});assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,provider:'kimi',draft_fence:true,concurrent_notes_preserved:true,word_clocks_preserved:true,protected_number:true,reload_without_model_call:true,mobile:true}));
}finally{release?.();await browser?.close();await server?.shutdown();await rm(directory,{recursive:true,force:true});}
