import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {Window} from 'happy-dom';
const require=createRequire(import.meta.url),D=require('../reader/disfluency.js'),P=require('../reader/passages.js');
const directory=await mkdtemp(join(tmpdir(),'coconut-cleanup-unit-'));
const bundle=await build({stdin:{contents:"export {prepareCleanup} from './frontend/reader-workspace/cleanup';export {PassageView} from './frontend/reader-workspace/passages';export {captureSourceSelection} from './frontend/reader-workspace/domain';export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';",resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false});
await writeFile(join(directory,'cleanup.cjs'),bundle.outputFiles[0].contents);
const {prepareCleanup,PassageView,captureSourceSelection,createElement,renderToStaticMarkup}=require(join(directory,'cleanup.cjs'));
const fixture=()=>({key:'cleanup',title:'自写口语',language:'zh',notes:{},segments:[
 {id:'a',start:0,end:2,speaker:'甲',text:'我呃知道🙂。',words:[{word:'我',start:0,end:.3},{word:'呃',start:.3,end:.4},{word:'知道🙂。',start:.5,end:2}]},
 {id:'b',start:3,end:4,speaker:'甲',text:'呃，'},
 {id:'c',start:5,end:7,speaker:'乙',text:'这个人说其实就是刘元。'}
]});
function withPlan(doc){return {...doc,reading_cleanup:{version:1,policyVersion:'authored-v1',sourceSignature:D.signature(doc),decisions:[{cue_id:'a',from:1,to:2,action:'hide',reason:'自写规则'}, {cue_id:'b',from:0,to:2,action:'hide',reason:'自写规则'}]}};}

test('saved rules take precedence; stale and malformed masks are discarded for current local reading',()=>{
 const input=withPlan(fixture()),before=structuredClone(input);
 const ready=prepareCleanup(input);
 assert.equal(ready.state,'ready');assert.equal(ready.hiddenCount,2);assert.equal(ready.hiddenCharacters,3);
 assert.equal(ready.projection.cues[0].text,'我知道🙂。');assert.deepEqual(input,before);
 assert.equal(prepareCleanup({...input,notes:{a:'新增笔记'}}).state,'ready');
 const stale=prepareCleanup({...input,segments:input.segments.map((c,i)=>i===0?{...c,text:'您好'}:c)});
 assert.equal(stale.state,'ready');assert.equal(stale.hiddenCount,0);
 assert.equal(prepareCleanup({...input,reading_cleanup:{...input.reading_cleanup,sourceSignature:''}}).hiddenCount,0);
 assert.equal(prepareCleanup({...input,reading_cleanup:{...input.reading_cleanup,version:2}}).hiddenCount,0);
 assert.equal(prepareCleanup(fixture()).state,'ready');
});

test('default spoken reading preserves evidence, quoted speech across cues, uncertainty and short answers',()=>{
 const phrases=['嗯，呃，我我觉得可能要再试一次。','嗯？','我不是不同意。','他提到“我我觉得，','嗯，这个不好说”。','🙂然后，然后再继续讨论。','是不是，是是非非，嗯哼，都不改。','他提醒我，我还没有回答。'];
 const doc={key:'default',segments:phrases.map((text,index)=>({id:String(index),start:index,end:index+1,text}))};
 const before=structuredClone(doc),result=prepareCleanup(doc);
 assert.equal(result.state,'ready');
 assert.deepEqual(result.projection.cues.map(cue=>cue.readingText),['嗯，我觉得可能要再试一次。',...phrases.slice(1,5),'🙂然后再继续讨论。',...phrases.slice(6)]);
 assert.deepEqual(doc,before);
});

test('reading DOM omits fillers and keeps canonical offsets, clocks and anchors',()=>{
 const w=new Window(),saved=globalThis.window;globalThis.window=w;w.CoconutPassages=P;
 try{
  const input=withPlan(fixture()),cleanup=prepareCleanup(input),host=w.document.createElement('div');
  host.innerHTML=renderToStaticMarkup(createElement(PassageView,{doc:input,cues:input.segments,position:'a',active:{cueId:'b',partIndex:0},projection:cleanup.projection,onLocate:()=>{},onPlayFrom:()=>{}}));
  const first=host.querySelector('[data-source-id="a"]'),hidden=host.querySelector('[data-source-id="b"]');
  assert.equal(first.textContent,'我知道🙂。');assert.equal(first.querySelector('[hidden]'),null);
  assert.equal(hidden.textContent,'');assert.equal(hidden.querySelectorAll('[hidden]').length,0);
  assert.equal(hidden.matches('.rw-playing')||Boolean(hidden.querySelector('.rw-playing')),false,'all-hidden speech never invents visible highlighting');
  const walker=w.document.createTreeWalker(first,4),nodes=[];for(let node=walker.nextNode();node;node=walker.nextNode())nodes.push(node);
  const range=w.document.createRange();range.setStart(nodes[0],0);range.setEnd(nodes.at(-1),nodes.at(-1).textContent.length);
  w.getSelection().addRange(range);
  const selection=captureSourceSelection(host,input,w.getSelection(),P.separator);
  assert.equal(selection.text,input.segments[0].text);assert.deepEqual(selection.cueIds,['a']);assert.equal(selection.from,0);assert.equal(selection.to,input.segments[0].text.length);
  assert.equal(host.querySelector('[data-source-id="c"]').textContent,input.segments[2].text);
 }finally{if(saved===undefined)delete globalThis.window;else globalThis.window=saved;void w.happyDOM.close();}
});

test('a length-changing conversion keeps the full sentence and leaves neighboring projections intact',()=>{
 const w=new Window(),previous=globalThis.window;globalThis.window=w;w.CoconutPassages=P;
 try{
  const input=withPlan(fixture()),host=w.document.createElement('div');
  host.innerHTML=renderToStaticMarkup(createElement(PassageView,{doc:input,cues:input.segments,position:'a',
   projection:prepareCleanup(input).projection,displayText:text=>text===input.segments[0].text?text+'！':text,onLocate:()=>{},onPlayFrom:()=>{}}));
  const changed=host.querySelector('[data-source-id="a"]'),unchanged=host.querySelector('[data-source-id="b"]');
  assert.equal(changed.textContent,input.segments[0].text+'！');
  assert.equal(changed.querySelector('[hidden]'),null);
  assert.equal(unchanged.textContent,'');
 }finally{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;void w.happyDOM.close();}
});

test('marks-only plans render punctuation and paragraph breaks with their source ranges',()=>{
 const w=new Window(),saved=globalThis.window;globalThis.window=w;w.CoconutPassages=P;
 try{
  const input={key:'marks-only',title:'自写断句',notes:{},segments:[{id:'m',start:0,end:5,text:'今天讨论模型然后谈产品',speaker:'甲'}]};
  input.reading_cleanup={version:1,policyVersion:'boundaries-v1',sourceSignature:D.signature(input),decisions:[],marks:[{cue_id:'m',at:6,mark:'。',reason:'语义句界'}],breaks:[{cue_id:'m',at:6,reason:'换行'}]};
  const cleanup=prepareCleanup(input),host=w.document.createElement('div');
  assert.equal(cleanup.state,'ready');assert.equal(cleanup.hiddenCount,0);assert.equal(cleanup.markCount,1);assert.equal(cleanup.breakCount,1);
  host.innerHTML=renderToStaticMarkup(createElement(PassageView,{doc:input,cues:input.segments,position:'m',projection:cleanup.projection,onLocate:()=>{},onPlayFrom:()=>{}}));
  const paragraphs=[...host.querySelectorAll('article p')];
  assert.deepEqual(paragraphs.map(p=>p.textContent),['今天讨论模型。','然后谈产品']);
  const first=paragraphs[0].querySelector('[data-reading-from]'),last=paragraphs[1].querySelector('[data-reading-from]');
  const range=w.document.createRange();range.setStart(first.firstChild,0);range.setEnd(last.firstChild,last.textContent.length);
  w.getSelection().addRange(range);
  assert.equal(captureSourceSelection(host,input,w.getSelection(),P.separator).text,input.segments[0].text);
 }finally{if(saved===undefined)delete globalThis.window;else globalThis.window=saved;void w.happyDOM.close();}
});

test.after(async()=>rm(directory,{recursive:true,force:true}));
