import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {libraryHarness} from './helpers/large-library-harness.mjs';
const require=createRequire(import.meta.url),Q=require('../reader/quotation.js'),C=require('../reader/core.js'),P=require('../reader/passages.js');
const source=fs.readFileSync(new URL('../reader/quotation.js',import.meta.url),'utf8');
const cues=[{id:'one',start:1.234,end:8.5,text:'Repeated repeated 🌴',speaker:'A'},{id:'two',start:2,end:4,text:'words 中文。',speaker:'A'}];
const fixture=()=>({key:'quote-doc',title:'Authored quotation',language:'en',source_url:'https://youtu.be/authored',segments:cues.map(c=>({...c})),notes:{one:'Private note'},readingPosition:'one'});
function setup(doc=fixture()){
 const env=libraryHarness([doc],{probe:true,configureCore(w){w.eval(source);}});env.$('mode-passages').click();return env;
}
function select(w,first,from,last=first,to=first.textContent.length){const range=w.document.createRange();range.setStart(first,from);range.setEnd(last,to);const selection=w.getSelection();selection.removeAllRanges();selection.addRange(range);return selection;}
function paragraph(w){return w.document.querySelector('.passage-original');}
function action(w){return w.document.querySelector('.passage-quote');}
async function tick(){await new Promise(resolve=>setTimeout(resolve,0));}

test('exact slices retain separators, repeated words, unicode and overlapping cue source range',()=>{
 const model=Q.compose(cues,P.separator),from=model.text.indexOf('repeated'),to=model.text.indexOf(' 中文');
 const quote=Q.slice(model,from,to);assert.equal(quote.text,'repeated 🌴 words');assert.equal(quote.start,1.234);assert.equal(quote.end,8.5);assert.equal(quote.parts.length,2);
 assert.equal(quote.parts[0].from,9);assert.equal(quote.parts[1].to,5);assert.equal(Q.stamp(3661.234),'01:01:01.234');
 assert.throws(()=>Q.slice(model,model.text.indexOf('🌴')+1,to));assert.throws(()=>Q.slice(model,0,0));
 const cjk=Q.compose([{...cues[0],text:'你好'},{...cues[1],text:'世界'}],P.separator);assert.equal(Q.slice(cjk,1,3).text,'好世');
 const combining=Q.compose([{...cues[0],text:' e\u0301\nlast  '}],P.separator);assert.equal(Q.slice(combining,0,5).text,' e\u0301\nl');
 const long=Q.compose([{...cues[0],text:'x'.repeat(20000)}],P.separator);assert.equal(Q.slice(long,0,20000).text.length,20000);
});

test('attribution never invents word timing, source URLs, demo media or private paths',()=>{
 const quote=Q.slice(Q.compose(cues,P.separator),0,4),doc=fixture(),text=Q.attribution(doc,quote,C);
 assert.ok(text.startsWith('Repe\n\n—— Authored quotation'));assert.match(text,/00:00:01.234–00:00:08.500/);assert.doesNotMatch(text,/片段 ID|识别错误|逐字/);assert.match(text,/https:\/\/youtu.be\/authored\?t=1/);assert.doesNotMatch(text,/Private note|Repeated repeated/);
 for(const source_url of ['javascript:alert(1)','blob:private','https://user:secret@youtube.com/x','https://unknown.example/']){
  const result=Q.attribution({...doc,source_url},quote,C);assert.match(result,/未关联原站链接或媒体/);assert.doesNotMatch(result,/javascript:|blob:|secret|unknown.example/);
 }
 assert.match(Q.attribution({...doc,provenance:{kind:'authored_demo'}},quote,C),/无对应音视频/);
 assert.doesNotMatch(Q.attribution({...doc,provenance:{kind:'authored_demo'}},quote,C),/https:/);
 assert.match(Q.attribution({...doc,source_url:'',local_media_source:{name:'/private/a.mp3'}},quote,C),/本地原始媒体/);
 assert.doesNotMatch(Q.attribution({...doc,source_url:'',local_media_source:{name:'/private/a.mp3'}},quote,C),/private/);
 assert.match(Q.attribution({...doc,source_url:'https://podcast.example/episode',podcast_source:{}},quote,C),/按时间手动定位/);
});

test('DOM selection maps continuous cues exactly and opening/cancel leave content/media untouched',async()=>{
 const {w,$}=setup();try{
  const doc=w.libraryProbe.documents[0],before=JSON.stringify(doc),p=paragraph(w),spans=p.querySelectorAll('.passage-cue'),button=action(w);let paused=0;const media=w.document.createElement('audio');media.pause=()=>paused++;$('source-media').append(media);
  select(w,spans[0].firstChild,9,spans[1].firstChild,5);button.click();assert.equal($('quotation-dialog').open,true);assert.ok($('quotation-preview').value.startsWith('repeated 🌴 words\n\n'));
  $('quotation-close').click();assert.equal(w.document.activeElement,button);assert.equal(paused,0);assert.equal(JSON.stringify(doc),before);
 }finally{await w.happyDOM.close();}
});

test('mixed UI/translation selections do not reuse an old quote, keyboard path maps the same exact text',async()=>{
 const {w,$}=setup();try{
  const p=paragraph(w),spans=p.querySelectorAll('.passage-cue'),button=action(w);
  select(w,spans[0].firstChild,9,spans[1].firstChild,5);button.click();const expected=$('quotation-preview').value;$('quotation-close').click();
  select(w,spans[0].firstChild,0,button.firstChild,2);button.click();assert.equal($('quotation-result').hidden,true);assert.match($('quotation-status').textContent,/同一段原文/);assert.equal($('quotation-preview').value,'');$('quotation-close').click();
  w.getSelection().removeAllRanges();button.click();assert.equal($('quotation-source').readOnly,true);const from=$('quotation-source').value.indexOf('repeated'),to=$('quotation-source').value.indexOf(' 中文');$('quotation-source').setSelectionRange(from,to);$('quotation-preview-selection').click();assert.equal($('quotation-preview').value,expected);
 }finally{await w.happyDOM.close();}
});

test('DOM endpoints at elements and cue boundaries do not attribute unselected neighbors',async()=>{
 const {w,$}=setup();try{
  const p=paragraph(w),model=Q.compose(w.libraryProbe.documents[0].segments,P.separator),spans=p.querySelectorAll('.passage-cue');
  select(w,p,0,spans[0].firstChild,4);assert.equal(w.CoconutQuotation.domSelection(p,model,w.getSelection()).text,'Repe');
  select(w,spans[0].firstChild,spans[0].textContent.length,spans[1].firstChild,5);const quote=w.CoconutQuotation.domSelection(p,model,w.getSelection());assert.equal(quote.text,' words');assert.equal(quote.parts.length,1);assert.equal(quote.start,2);
  select(w,p.childNodes[1],0,p.childNodes[1],1);assert.throws(()=>w.CoconutQuotation.domSelection(p,model,w.getSelection()));
  const injected=w.document.createElement('button');injected.textContent='unexpected';p.append(injected);select(w,spans[0].firstChild,0,spans[1].firstChild,2);assert.throws(()=>w.CoconutQuotation.domSelection(p,model,w.getSelection()));
 }finally{await w.happyDOM.close();}
});

test('source edits before preview or copy are rejected without altering the quote or notes',async()=>{
 const {w,$}=setup();try{
  const doc=w.libraryProbe.documents[0],p=paragraph(w);select(w,p.firstChild.firstChild,0,p.firstChild.firstChild,4);action(w).click();const text=$('quotation-preview').value;doc.segments[0].text='Changed';let writes=0;Object.defineProperty(w.navigator,'clipboard',{value:{writeText(){writes++;return Promise.resolve();}}});$('quotation-copy').click();assert.equal(writes,0);assert.match($('quotation-status').textContent,/已变化/);assert.equal($('quotation-preview').value,text);
  $('quotation-close').click();action(w).click();assert.equal($('quotation-copy').disabled,true);assert.match($('quotation-status').textContent,/已变化/);
 }finally{await w.happyDOM.close();}
});

test('clipboard failure preserves full manual preview, duplicate writes suppressed and stale resolution cannot hijack focus',async()=>{
 const {w,$}=setup();try{
  const before=JSON.stringify(w.libraryProbe.documents[0]);let writes=0,finish;Object.defineProperty(w.navigator,'clipboard',{value:{writeText(){writes++;return new Promise(resolve=>finish=resolve);},readText(){throw Error('Must never read');}}});
  action(w).click();$('quotation-source').setSelectionRange(0,4);$('quotation-preview-selection').click();$('quotation-copy').click();$('quotation-copy').click();assert.equal(writes,1);$('quotation-close').click();const focused=w.document.activeElement;finish();await tick();assert.equal(w.document.activeElement,focused);assert.equal($('quotation-dialog').open,false);
  action(w).click();$('quotation-source').setSelectionRange(0,4);$('quotation-preview-selection').click();w.navigator.clipboard.writeText=async()=>{throw Error('denied');};const payload=$('quotation-preview').value;$('quotation-copy').click();await tick();assert.match($('quotation-status').textContent,/手动复制/);assert.equal($('quotation-preview').value,payload);assert.equal(JSON.stringify(w.libraryProbe.documents[0]),before);
 }finally{await w.happyDOM.close();}
});

test('keyboard CRLF offsets and full quote preserve source; isolated CR is rejected rather than normalized',async()=>{
 const doc=fixture();doc.segments=[{id:'crlf',start:0,end:1,text:'before\r\nafter\rlast'}];const {w,$}=setup(doc);try{
  action(w).click();assert.equal($('quotation-source').value,'before\nafter\nlast');$('quotation-source').setSelectionRange(7,12);$('quotation-preview-selection').click();assert.ok($('quotation-preview').value.startsWith('after\n\n'));
  $('quotation-source').setSelectionRange(0,12);$('quotation-preview-selection').click();assert.equal($('quotation-result').hidden,false);assert.match($('quotation-status').textContent,/手动复制采用预览中的换行格式/);let copied;Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>{copied=text;}}});$('quotation-copy').click();await tick();assert.ok(copied.startsWith('before\r\nafter\n\n'));assert.ok($('quotation-preview').value.startsWith('before\nafter\n\n'));
  $('quotation-source').setSelectionRange(7,17);$('quotation-preview-selection').click();assert.equal($('quotation-result').hidden,true);assert.match($('quotation-status').textContent,/孤立 CR/);
  assert.equal(Q.inputOffset('a\r\nb',2),3);
 }finally{await w.happyDOM.close();}
});

test('zero-length joiners and CJK DOM ranges are supported',async()=>{
 const doc=fixture();doc.segments[0].text='你好';doc.segments[1].text='世界';const {w,$}=setup(doc);try{
  const spans=paragraph(w).querySelectorAll('.passage-cue');select(w,spans[0].firstChild,1,spans[1].firstChild,1);action(w).click();assert.ok($('quotation-preview').value.startsWith('好世\n\n'));
 }finally{await w.happyDOM.close();}
});

test('pointerdown snapshot survives native-like selection collapse without changing document ownership',async()=>{
 const {w,$}=setup();try{
  const p=paragraph(w),button=action(w);select(w,p.firstChild.firstChild,0,p.firstChild.firstChild,4);button.dispatchEvent(new w.Event('pointerdown'));w.getSelection().removeAllRanges();button.dispatchEvent(new w.MouseEvent('click',{detail:1}));assert.ok($('quotation-preview').value.startsWith('Repe\n\n'));$('quotation-close').click();
  select(w,p.firstChild.firstChild,0,p.firstChild.firstChild,4);button.dispatchEvent(new w.Event('pointerdown'));w.libraryProbe.documents[0].title='Changed';w.getSelection().removeAllRanges();button.dispatchEvent(new w.MouseEvent('click',{detail:1}));assert.match($('quotation-status').textContent,/已变化/);assert.equal($('quotation-copy').disabled,true);
 }finally{await w.happyDOM.close();}
});

test('new mixed selection supersedes pointer snapshot; successful copy returns exact displayed payload without reads',async()=>{
 const {w,$}=setup();try{
  const p=paragraph(w),button=action(w);select(w,p.firstChild.firstChild,0,p.firstChild.firstChild,4);button.dispatchEvent(new w.Event('pointerdown'));select(w,p.firstChild.firstChild,0,button.firstChild,2);button.dispatchEvent(new w.MouseEvent('click',{detail:1}));assert.equal($('quotation-result').hidden,true);assert.match($('quotation-status').textContent,/同一段原文/);$('quotation-close').click();
  w.getSelection().removeAllRanges();button.click();$('quotation-source').setSelectionRange(0,4);$('quotation-preview-selection').click();let copied;Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>{copied=text;},readText(){throw Error('unexpected read');}}});$('quotation-copy').click();await tick();assert.equal(copied,$('quotation-preview').value);assert.match($('quotation-status').textContent,/已复制/);
 }finally{await w.happyDOM.close();}
});

test('metadata line breaks are represented explicitly instead of changing preview/copy bytes',()=>{
 const doc={...fixture(),title:'Title\r\nOther'};const quote=Q.slice(Q.compose(cues,P.separator),0,4);const payload=Q.attribution(doc,quote,C);assert.match(payload,/Title\\r\\nOther/);assert.equal(payload.includes('\r'),false);
});

test('app keeps its strict-mode directive before quotation state initialization',()=>{
 const app=fs.readFileSync(new URL('../reader/app.js',import.meta.url),'utf8');assert.match(app,/^\s*[\"']use strict[\"'];\s*let quotationController;/);
});
