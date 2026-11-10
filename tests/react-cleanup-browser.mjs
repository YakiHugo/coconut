/** Authored source, production React components and real browser selection. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';

const output=process.env.COCONUT_CLEANUP_ARTIFACTS||'/tmp/coconut-cleanup-browser';
const fixture={key:'authored-cleanup',title:'自写访谈：保留原话的口语精简',language:'zh',notes:{},segments:[
 {id:'a',start:0,end:5,text:'我们呃今天聊机器人。',speaker:'甲',words:Array.from('我们呃今天聊机器人。',(word,index)=>({word,start:index*.5,end:(index+1)*.5}))},
 {id:'b',start:6,end:7,text:'呃，',speaker:'甲',words:[{word:'呃，',start:6,end:7}]},
 {id:'c',start:8,end:10,text:'嗯，是的。',speaker:'乙'},
 {id:'d',start:11,end:15,text:'这个人说其实就是刘元。',speaker:'甲'}
]};
const code=`
import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {ReaderWorkspace} from './frontend/reader-workspace/workspace';
import {textRange} from './frontend/reader-workspace/text-range';
import {speechSelection} from './frontend/reader-workspace/speech';
import C from './reader/core.js';
import P from './reader/passages.js';
import PP from './reader/passage-playback.js';
import D from './reader/disfluency.js';
window.Coconut=C;window.CoconutPassages=P;window.CoconutPassagePlayback=PP;
let doc=${JSON.stringify(fixture)},revision=1;
doc.reading_cleanup={version:1,policyVersion:'authored-v1',sourceSignature:D.signature(doc),decisions:[{cue_id:'a',from:2,to:3,action:'hide',reason:'自写句内填充'},{cue_id:'b',from:0,to:2,action:'hide',reason:'自写完整跨度'}]};
window.savedDocs=[];window.aiRequests=[];window.doc=doc;
const root=createRoot(document.querySelector('#app'));
const render=()=>root.render(createElement(ReaderWorkspace,{document:doc,revision,media:{url:'/voice.wav',identity:'file-candidate-v1:cleanup',name:'voice.wav',kind:'audio'},onSaveDocument:async next=>{window.savedDocs.push(next);doc=next;window.doc=doc;revision++;render();return true;},onReadingPosition:()=>{},onRequestAi:request=>window.aiRequests.push(request)}));
window.updateDoc=change=>{doc=change(doc);window.doc=doc;revision++;render();};
window.setMarkedDoc=withHides=>{
 const text='我们呃今天聊机器人';
 doc={key:'marked-reading',title:'自写访谈：标点与断句',language:'zh',notes:{},segments:[{id:'a',start:0,end:5,text,speaker:'甲',words:Array.from(text,(word,index)=>({word,start:index*.5,end:(index+1)*.5}))}]};
 doc.reading_cleanup={version:1,policyVersion:'authored-boundaries-v1',sourceSignature:D.signature(doc),decisions:withHides?[{cue_id:'a',from:2,to:3,action:'hide',reason:'自写填充'}]:[],marks:[{cue_id:'a',at:5,mark:'，',reason:'自写分句',method:'rule'},{cue_id:'a',at:9,mark:'。',reason:'自写句末',method:'llm'}],breaks:[{cue_id:'a',at:5,reason:'自写段落'}]};
 window.doc=doc;revision++;render();
};
window.sourceRange=(id,from,to)=>textRange(document.querySelector('[data-source-id="'+id+'"]'),from,to);
window.expectedReview=(id,offset)=>speechSelection(doc.segments.find(cue=>cue.id===id),offset);
window.selectSource=(id,from,to)=>{const source=document.querySelector('[data-source-id="'+id+'"]'),range=window.sourceRange(id,from,to);source.closest('.rw-original').focus();getSelection().removeAllRanges();getSelection().addRange(range);source.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));};
render();
`;
const bundle=await build({stdin:{contents:code,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,define:{'process.env.NODE_ENV':'"production"'}});
const css=await readFile('frontend/reader-workspace/workspace.css','utf8');
function wav(seconds){const data=Buffer.alloc(44+seconds*16000);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(8000,24);data.writeUInt32LE(16000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(data.length-44,40);return data;}
const server=createServer((request,response)=>{
 if(request.url==='/app.js'){response.setHeader('Content-Type','text/javascript');return response.end(bundle.outputFiles[0].contents);}
 if(request.url==='/voice.wav'){response.setHeader('Content-Type','audio/wav');return response.end(wav(20));}
 response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><meta charset="utf-8"><style>:root{--text:#25322f;--muted:#687163;--surface:#faf9f5;--reading-edge:#d9ded2;--reading-raised:#f0f1e9;--reading-selected:#e4e9d8;--accent:#566342}body{margin:0;font:16px system-ui;background:var(--surface)}button{background:transparent;border:1px solid var(--reading-edge);color:inherit}'+css+'</style><div id="app"></div><script src="/app.js"></script>');
});
let browser;
const report={};
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1360,height:900},permissions:['clipboard-read','clipboard-write']}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin);const source=page.locator('[data-source-id="a"]'),cleanupModeButtons=page.getByRole('button',{name:/^(精简口语|保留口语)$/});
 await expect(source).toHaveAttribute('data-cleanup-applied','true');
 await expect(cleanupModeButtons).toHaveCount(0);
 await expect(page.locator('.rw-reading-controls,.rw-records')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'阅读记录',exact:true})).toHaveCount(0);
 assert.equal(await source.textContent(),fixture.segments[0].text);
 assert.equal(await source.innerText(),'我们今天聊机器人。');
 assert.equal(await page.locator('[data-source-id="b"]').textContent(),'呃，');assert.equal(await page.locator('[data-source-id="b"]').innerText(),'');
 assert.equal(await page.locator('[data-source-id="c"]').innerText(),'嗯，是的。','a standalone response stays visible');
 assert.equal(await page.locator('[data-source-id="d"]').innerText(),fixture.segments[3].text,'semantic 就是 stays visible');
 await page.evaluate(()=>selectSource('a',0,10));
 const native=await source.evaluate(node=>({content:node.textContent,range:getSelection().getRangeAt(0).toString(),selection:getSelection().toString()}));
 assert.equal(native.range,fixture.segments[0].text);assert.equal(native.selection,'我们今天聊机器人。');report.hidden_range_vs_selection=native;
 // Actual mouse dragging crosses the invisible filler. The captured source
 // offsets must include it, even though the native selected string omits it.
 const glyphs=await page.evaluate(()=>{
  getSelection().removeAllRanges();
  const first=sourceRange('a',0,1).getBoundingClientRect(),last=sourceRange('a',9,10).getBoundingClientRect();
  return {x:first.left+.2,y:first.top+first.height/2,end:last.right+.2};
 });
 await page.mouse.move(glyphs.x,glyphs.y);await page.mouse.down();await page.mouse.move(glyphs.end,glyphs.y,{steps:12});await page.mouse.up();
 await expect(page.getByRole('button',{name:'复制原话',exact:true})).toBeVisible();
 await page.keyboard.press(process.platform==='darwin'?'Meta+C':'Control+C');
 await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(fixture.segments[0].text);
 report.native_drag_copy=await page.evaluate(()=>navigator.clipboard.readText());
 await page.evaluate(()=>selectSource('a',0,10));
 await page.getByRole('button',{name:'保存精确摘录',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>savedDocs.length)).toBe(1);
 const saved=await page.evaluate(()=>savedDocs[0]);
 assert.equal(saved.exact_excerpts[0].text,fixture.segments[0].text);assert.deepEqual(saved.segments,fixture.segments);report.excerpt_text=saved.exact_excerpts[0].text;
 // Keyboard and click selections use the same continuous playback action.
 await page.evaluate(()=>getSelection().removeAllRanges());await source.locator('xpath=ancestor::p').focus();await page.keyboard.press('Enter');
 await expect(page.getByRole('button',{name:'从所选位置播放',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'关闭选文操作',exact:true}).click();
 assert.equal(await page.locator('.rw-selection').count(),0);assert.equal(await page.evaluate(()=>getSelection().rangeCount),0);
 await source.scrollIntoViewIfNeeded();
 const clicked=await page.evaluate(()=>{const r=sourceRange('a',4,5).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,expected:expectedReview('a',4)};});
 await page.mouse.click(clicked.x,clicked.y);
 await expect(page.getByRole('button',{name:'从所选位置播放',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'复制原话',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(clicked.expected.text);report.click_after_hidden_source_text=clicked.expected.text;
 const clickedEnd=fixture.segments[0].words[clicked.expected.to-1].end;
 await page.locator('audio').evaluate(player=>{player.playbackRate=2;});
 await page.getByRole('button',{name:'从所选位置播放',exact:true}).click();
 await expect.poll(()=>page.locator('audio').evaluate(player=>player.currentTime),{timeout:5000}).toBeGreaterThan(clickedEnd+.5);
 assert.equal(await page.locator('audio').evaluate(player=>player.paused),false,'click playback continues beyond the selected source range');
 report.continuous_click_playback={selectionEnd:clickedEnd,currentTime:await page.locator('audio').evaluate(player=>player.currentTime)};
 await page.locator('audio').evaluate(player=>{player.pause();player.playbackRate=1;});
 await page.evaluate(()=>selectSource('a',3,5));
 await page.getByRole('button',{name:'从所选位置播放',exact:true}).click();
 await expect.poll(()=>page.locator('audio').evaluate(player=>player.currentTime)).toBeGreaterThanOrEqual(1);
 assert.ok(await page.locator('audio').evaluate(player=>player.currentTime<2.5),'playback uses original 1.5-second word start and lead-in');
 await page.locator('audio').evaluate(player=>{player.pause();player.currentTime=6.5;player.dispatchEvent(new Event('timeupdate'));});
 assert.equal(await page.locator('[data-source-id="b"].rw-playing,[data-source-id="b"] .rw-playing').count(),0,'hidden-only speech has no false visible highlight');
 await page.getByRole('tab',{name:'逐句校对',exact:true}).click();await source.scrollIntoViewIfNeeded();assert.equal(await source.innerText(),fixture.segments[0].text);await expect(cleanupModeButtons).toHaveCount(0);
 await page.getByRole('tab',{name:'文字稿',exact:true}).click();await expect(source).toHaveAttribute('data-cleanup-applied','true');await source.scrollIntoViewIfNeeded();await expect.poll(()=>source.innerText()).toBe('我们今天聊机器人。');
 await mkdir(output,{recursive:true});
 for(const width of [1360,390]){
  await page.setViewportSize({width,height:900});await page.evaluate(()=>window.scrollTo(0,0));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow at '+width);
  const paragraph=source.locator('xpath=ancestor::p');
  await paragraph.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');const focus=await paragraph.evaluate(node=>{const s=getComputedStyle(node);return {outline:s.outlineStyle,shadow:s.boxShadow,background:s.backgroundColor};});
  assert.equal(focus.outline,'none');assert.equal(focus.shadow,'none');assert.notEqual(focus.background,'rgba(0, 0, 0, 0)');
  await page.screenshot({path:path.join(output,'cleanup-'+width+'.png'),fullPage:true});
 }
 // Generated glyphs and paragraph breaks change the visual reading layer while
 // source nodes, ranges, exact excerpts and media clocks keep original offsets.
 await page.evaluate(()=>setMarkedDoc(true));await expect(page.locator('[data-cleanup-mark]')).toHaveCount(2);
 await expect(page.locator('[data-cleanup-break]')).toHaveCount(1);await source.scrollIntoViewIfNeeded();
 const marked=await source.evaluate(node=>{
  const r=document.createRange();r.selectNodeContents(node);
  return {source:node.textContent,range:r.toString(),marks:[...node.querySelectorAll('[data-cleanup-mark]')].map(mark=>({text:mark.textContent,content:getComputedStyle(mark,'::after').content})),
   first:sourceRange('a',0,1).getBoundingClientRect().top,next:sourceRange('a',5,6).getBoundingClientRect().top};
 });
 assert.equal(marked.source,'我们呃今天聊机器人');assert.equal(marked.range,marked.source);assert.ok(marked.next>marked.first+10,'sentence break starts a new visible line');
 assert.deepEqual(marked.marks.map(mark=>mark.text),['','']);assert.deepEqual(marked.marks.map(mark=>mark.content),['"，"','"。"']);report.generated_reading_layer=marked;
 const acrossLines=await page.evaluate(()=>{getSelection().removeAllRanges();const first=sourceRange('a',0,1).getBoundingClientRect(),last=sourceRange('a',8,9).getBoundingClientRect();return {x:first.left+.2,y:first.top+first.height/2,endX:last.right-.2,endY:last.top+last.height/2};});
 await page.mouse.move(acrossLines.x,acrossLines.y);await page.mouse.down();await page.mouse.move(acrossLines.endX,acrossLines.endY,{steps:16});await page.mouse.up();
 await expect(page.getByRole('button',{name:'复制原话',exact:true})).toBeVisible();
 await page.keyboard.press(process.platform==='darwin'?'Meta+C':'Control+C');await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(marked.source);
 await page.evaluate(()=>selectSource('a',0,9));await page.getByRole('button',{name:'保存精确摘录',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>savedDocs.length)).toBe(2);assert.equal(await page.evaluate(()=>savedDocs.at(-1).exact_excerpts[0].text),marked.source);
 await page.evaluate(()=>getSelection().removeAllRanges());
 const shiftedGlyph=await page.evaluate(()=>{const r=sourceRange('a',6,7).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,expected:expectedReview('a',6)};});
 await page.mouse.click(shiftedGlyph.x,shiftedGlyph.y);await expect(page.getByRole('button',{name:'从所选位置播放',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'复制原话',exact:true}).click();await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(shiftedGlyph.expected.text);
 report.click_after_generated_break=shiftedGlyph.expected.text;
 await page.evaluate(()=>getSelection().removeAllRanges());
 await page.getByRole('button',{name:'关闭选文操作',exact:true}).click();
 await page.locator('[data-cleanup-mark]').first().click();assert.equal(await page.locator('.rw-selection').count(),0,'generated glyphs do not act as source words');
 await page.evaluate(()=>selectSource('a',6,7));await page.getByRole('button',{name:'从所选位置播放',exact:true}).click();
 await expect.poll(()=>page.locator('audio').evaluate(player=>player.currentTime)).toBeGreaterThanOrEqual(2.5);assert.ok(await page.locator('audio').evaluate(player=>player.currentTime<3.8));
 await page.locator('audio').evaluate(player=>player.pause());
 await page.getByRole('tab',{name:'逐句校对',exact:true}).click();assert.equal(await page.locator('[data-cleanup-mark]').count(),0);assert.equal(await page.locator('[data-cleanup-break]').count(),0);
 await page.getByRole('tab',{name:'文字稿',exact:true}).click();await expect(page.locator('[data-cleanup-mark]')).toHaveCount(2);
 for(const width of [1360,390]){await page.setViewportSize({width,height:900});await page.evaluate(()=>scrollTo(0,0));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(output,'boundaries-'+width+'.png'),fullPage:true});}
 await page.evaluate(()=>setMarkedDoc(false));await expect(source).toHaveAttribute('data-cleanup-applied','true');await expect(cleanupModeButtons).toHaveCount(0);await expect(page.locator('[data-cleanup-mark]')).toHaveCount(2);await expect(page.locator('[data-cleanup-hidden]')).toHaveCount(0);
 await page.evaluate(()=>updateDoc(doc=>({...doc,segments:doc.segments.map(cue=>cue.id==='a'?{...cue,text:'来源已经更新。',words:undefined}:cue)})));
 await expect(page.getByText('口语精简建议与当前原文不一致，已保留口语。',{exact:true})).toBeVisible();
 assert.equal(await source.innerText(),'来源已经更新。');assert.equal(await page.locator('[data-cleanup-hidden]').count(),0);
 assert.equal(await page.locator('.rw-selection').count(),0);assert.equal(await page.evaluate(()=>aiRequests.length),0);
 assert.deepEqual(errors,[]);report.errors=errors;report.result='passed';
 await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({result:'passed',artifacts:output,native_range_preserves_source:true,native_copy_preserves_source:true,excerpt_preserves_source:true}));
}finally{
 await browser?.close();await new Promise(resolve=>server.close(resolve));
}
