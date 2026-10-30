/** Authored interview and silent WAV; real React/SQLite, no model inference. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startBridge} from '../desktop/server.mjs';
import {chromium,expect} from '@playwright/test';
const directory=await mkdtemp(path.join(tmpdir(),'coconut-editions-')),output=process.env.COCONUT_REACT_ARTIFACTS||'/tmp/coconut-editions-proof';
const fixture={schema_version:1,key:'edition-proof',title:'自写访谈：把声音留下来',language:'zh',source_url:'https://publisher.example/episode',podcast_source:{kind:'direct_media',media_url:'https://publisher.example/episode.wav',media_kind:'audio'},notes:{a:'原有笔记'},opaque:{keep:true},segments:[
 {id:'a',start:0,end:2,text:'你为什么开始？',speaker:'采访者'},
 {id:'b',start:2,end:5,text:'我我觉得，呃，值得试试。',speaker:'嘉宾'},
 {id:'c',start:5,end:8,text:'但也可能失败。',speaker:'嘉宾'},
 {id:'d',start:9,end:10,text:'嗯。',speaker:null,speaker_status:'ambiguous_match'}
]};
for(const cue of fixture.segments)cue.translations={};
function wav(){const b=Buffer.alloc(44+10*16000);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;}
let server,browser;
try{
 server=await startBridge({port:0,libraryDirectory:directory});const origin='http://127.0.0.1:'+server.address().port;
 const request=async(route,body)=>{const r=await fetch(origin+route,body?{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}:{});assert.ok(r.ok);return r.json();};
 const library=await request('/api/v1/library');await request('/api/v1/library/commit',{protocolVersion:1,epoch:library.epoch,action:'put',key:fixture.key,receiptKey:'edition-seed',expected:null,document:fixture});
 const record=async()=>(await request('/api/v1/library/document?protocolVersion=1&key='+fixture.key)).record;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width:1360,height:950}}),errors=[],modelCalls=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('request',req=>{if(/\/api\/(?:ask|v1\/tasks)/.test(req.url()))modelCalls.push(req.url());});
 await page.route('**/*',route=>new URL(route.request().url()).origin!==origin?route.abort():new URL(route.request().url()).pathname==='/api/podcasts/media'?route.fulfill({status:200,contentType:'audio/wav',body:wav()}):route.continue());
 await page.goto(origin+'/#read/'+fixture.key);await expect(page.locator('.rw-passage').first()).toBeVisible();
 await expect(page.locator('.rw-readability-notice')).toContainText('已有 3/4');
 await page.getByText('来源与文字稿依据',{exact:true}).click();await expect(page.locator('.rw-source')).toContainText('声音匹配含糊 1 个');
 await page.getByRole('button',{name:'载入原声（最多 200 MiB）',exact:true}).click();await expect.poll(()=>page.locator('audio').evaluate(audio=>audio.duration)).toBe(10);
 const player=await page.locator('audio').elementHandle();
 await page.getByRole('button',{name:'创建编辑访谈稿',exact:true}).click();await expect(page.getByRole('region',{name:'编辑访谈稿',exact:true})).toBeVisible();
 assert.equal(await page.locator('audio').evaluate((node,original)=>node===original,player),true);
 await expect(page.locator('[data-source-id]')).toHaveCount(0);await expect(page.locator('.rw-edition-block')).toHaveCount(3);
 const answer=page.locator('.rw-edition-block').nth(1);await answer.getByRole('button',{name:'编辑本段',exact:true}).click();
 await expect(page.getByRole('combobox',{name:'阅读版本',exact:true})).toBeDisabled();
 await page.getByRole('textbox',{name:'主题小标题',exact:true}).fill('为什么值得尝试');await page.getByRole('textbox',{name:'整理正文',exact:true}).fill('我觉得值得试试。\n\n但也可能失败。');
 await page.getByRole('button',{name:'保存本段编辑',exact:true}).click();await expect(page.locator('.rw-edition-edit')).toHaveCount(0);await expect(answer.locator('.rw-edition-text')).toHaveText('我觉得值得试试。\n\n但也可能失败。');
 await expect.poll(async()=>(await record()).document.reading_editions.editions[0].revision).toBe(2);
 // A rejected durable write retains the editor until an acknowledged retry.
 let failing=true;const failWrite=route=>failing?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'unavailable',error:'Authored save failure'})}):route.continue();
 await page.route('**/api/v1/library/batch',failWrite);
 await answer.getByRole('button',{name:'编辑本段',exact:true}).click();await page.getByRole('textbox',{name:'主题小标题',exact:true}).fill('为什么值得尝试（已核对）');
 await page.getByRole('button',{name:'保存本段编辑',exact:true}).click();await expect(page.locator('.rw-edition-reader')).toContainText('尚未确认保存');await expect(page.getByRole('textbox',{name:'整理正文',exact:true})).toHaveValue('我觉得值得试试。\n\n但也可能失败。');
 failing=false;await page.getByRole('button',{name:'重试保存',exact:true}).click();await expect(page.locator('.rw-edition-edit')).toHaveCount(0);await page.unroute('**/api/v1/library/batch',failWrite);
 const saved=(await record()).document;assert.deepEqual(saved.segments,fixture.segments);assert.deepEqual(saved.notes,fixture.notes);assert.deepEqual(saved.opaque,fixture.opaque);
 await answer.locator('.rw-edition-text').evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);node.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
 await page.getByRole('button',{name:'保存编辑稿摘录',exact:true}).click();await expect.poll(async()=>(await record()).document.reading_editions.excerpts.length).toBe(1);
 assert.equal((await record()).document.reading_editions.excerpts[0].text,'我觉得值得试试。\n\n但也可能失败。');assert.equal((await record()).document.exact_excerpts,undefined);
 await answer.getByRole('button',{name:'读到这里',exact:true}).click();await expect.poll(async()=>(await record()).document.reading_editions.position?.block_id).toBe('block-2');
 const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'导出编辑稿 Markdown',exact:true}).click();const download=await downloaded;assert.match(await readFile(await download.path(),'utf8'),/为什么值得尝试/);
 await answer.locator('summary').click();await expect(answer.locator('.rw-edition-evidence')).toContainText('我我觉得，呃，值得试试。');
 await answer.getByRole('button',{name:'回听来源 00:02–00:08',exact:true}).click();await expect.poll(()=>page.locator('audio').evaluate(audio=>audio.paused)).toBe(false);await page.getByRole('button',{name:'暂停播放',exact:true}).click();
 await answer.getByRole('button',{name:'打开对应原话',exact:true}).click();await expect(page.locator('[data-source-id="b"]')).toHaveText('我我觉得，呃，值得试试。');
 await page.reload();await expect(page.getByRole('region',{name:'编辑访谈稿',exact:true})).toBeVisible();await expect(page.locator('.rw-edition-block').nth(1)).toContainText('我觉得值得试试。');
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await mkdir(output,{recursive:true});await page.screenshot({path:path.join(output,'edition-interview-390.png')});
 await page.setViewportSize({width:1360,height:950});await page.screenshot({path:path.join(output,'edition-interview-1360.png')});
 // Current source changes preserve the old edition and its frozen evidence.
 const previous=await record(),changed=structuredClone(previous.document);changed.segments[1].text='后来修正过的原话';
 await request('/api/v1/library/commit',{protocolVersion:1,epoch:library.epoch,action:'put',key:fixture.key,receiptKey:'edition-source-edit',expected:previous.token,document:changed});
 await page.reload();await expect(page.locator('.rw-edition-freshness')).toContainText('历史稿');await page.locator('.rw-edition-block').nth(1).locator('summary').click();
 await expect(page.locator('.rw-edition-block').nth(1).locator('.rw-edition-evidence')).toContainText('我我觉得，呃，值得试试。');await expect(page.getByRole('button',{name:'打开对应原话',exact:true})).toHaveCount(0);
 assert.deepEqual(errors,[]);assert.deepEqual(modelCalls,[]);
 console.log(JSON.stringify({passed:true,source_unchanged:true,separate_excerpt:true,shared_player:true,sqlite_reload:true,stale_evidence:true,mobile:true,model_calls:0}));
}finally{await browser?.close();await server?.shutdown();await rm(directory,{recursive:true,force:true});}
