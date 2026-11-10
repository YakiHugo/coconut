import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const require=createRequire(import.meta.url),D=require('../reader/disfluency.js');
const cue=(id,text,start=0,speaker='甲')=>({id,text,start,end:start+2,speaker});
const doc=(...segments)=>({key:'source-one',segments});
const hide=(cue_id,from,to,reason='句内犹豫填充')=>({cue_id,from,to,action:'hide',reason,confidence:.99});

test('a reading projection removes only explicit source slices and preserves source objects, clocks and private data',()=>{
 const input=doc({...cue('a','我，呃，觉得很好。'),words:[{word:'我，',start:0,end:.4},{word:'呃，',start:.4,end:.4},{word:'觉得很好。',start:.8,end:2}]}),before=structuredClone(input);
 input.notes={a:'不进入投影'};input.segments[0].translation='private';
 const projection=D.createProjection(input,{decisions:[hide('a',2,4)],policyVersion:'rules-1',sourceSignature:D.signature(input)});
 assert.equal(projection.cues[0].text,'我，觉得很好。');
 assert.equal(projection.cues[0].sourceText,before.segments[0].text);
 assert.deepEqual(input.segments[0].words,before.segments[0].words);
 assert.equal(input.segments[0].text,before.segments[0].text);
 assert.equal(projection.cues[0].start,0);assert.equal(projection.cues[0].end,2);
 assert.equal(JSON.stringify(projection).includes('private'),false);assert.equal(JSON.stringify(projection).includes('不进入投影'),false);
 assert.deepEqual(projection.cues[0].spans.map(s=>[s.from,s.to,s.displayFrom,s.displayTo,s.action]),[[0,2,0,2,'keep'],[2,4,2,2,'hide'],[4,9,2,7,'keep']]);
 assert.throws(()=>{projection.cues[0].text='改字';},TypeError);
 assert.throws(()=>{projection.cues[0].spans[0].to=99;},TypeError);
 assert.throws(()=>{projection.cues.push({});},TypeError);
});

test('uncertain and explicitly protected language stays verbatim; decisions are independent of confidence thresholds',()=>{
 const input=doc(cue('a','这个人说其实就是刘元。'));
 const projection=D.createProjection(input,{decisions:[{...hide('a',6,8,'判断句，应保留'),action:'keep',confidence:.51}]});
 assert.equal(projection.cues[0].text,input.segments[0].text);
 assert.equal(projection.cues[0].spans[1].reason,'判断句，应保留');
 assert.equal(D.getCue(projection,'missing'),null);
 assert.equal(D.getCue(projection,'a'),projection.cues[0]);
});

test('deterministic rules need no invented probability while explicit invalid confidence still rejects',()=>{
 const decision={cue_id:'a',from:1,to:2,action:'hide',reason:'规则：句内填充'};
 const projection=D.createProjection(doc(cue('a','我呃知道')),{decisions:[decision]});
 assert.equal(projection.cues[0].text,'我知道');
 assert.equal(Object.hasOwn(projection.cues[0].spans[1],'confidence'),false);
 assert.throws(()=>D.createProjection(doc(cue('a','我呃知道')),{decisions:[{...decision,confidence:undefined}]}));
});

test('generated punctuation and sentence breaks remain an explicit reading layer beside source and selectable text',()=>{
 const input=doc(cue('a','你好，世界')),before=structuredClone(input);
 const projection=D.createProjection(input,{decisions:[hide('a',2,3,'旧逗号仅在阅读层隐藏')],
  marks:[{cue_id:'a',at:3,mark:'。',reason:'完整句界',method:'llm'},{cue_id:'a',at:5,mark:'！',reason:'句末',method:'rule'}],
  breaks:[{cue_id:'a',at:3,reason:'句间换行'}]});
 const a=D.getCue(projection,'a');
 assert.equal(a.sourceText,'你好，世界');assert.equal(a.text,'你好世界');assert.equal(a.readingText,'你好。\n\n世界！');
 assert.deepEqual(a.marks.map(mark=>[mark.at,mark.displayAt,mark.mark,mark.method]),[[3,2,'。','llm'],[5,4,'！','rule']]);
 assert.deepEqual(a.breaks.map(item=>[item.at,item.displayAt]),[[3,2]]);assert.deepEqual(input,before);
 const selected=D.select(projection,[{cue_id:'a',from:0,to:a.text.length}]);
 assert.deepEqual(selected.pieces.map(piece=>piece.text),['你好','世界']);assert.equal(selected.displayText,'你好世界');
 assert.throws(()=>D.select(projection,[{cue_id:'a',from:0,to:a.readingText.length}]));
 assert.throws(()=>{a.marks[0].mark='？';},TypeError);
});

test('marks-only plans and cue-end breaks keep their original clocks and source identity',()=>{
 const input=doc(cue('a','今天讨论模型然后谈产品'));
 const projection=D.createProjection(input,{marks:[{cue_id:'a',at:6,mark:'，',reason:'分句'},{cue_id:'a',at:11,mark:'。',reason:'句末'}],breaks:[{cue_id:'a',at:6,reason:'阅读段落'},{cue_id:'a',at:11,reason:'cue末尾'}]});
 assert.equal(projection.cues[0].text,input.segments[0].text);assert.equal(projection.cues[0].readingText,'今天讨论模型，\n\n然后谈产品。\n\n');
 assert.equal(projection.sourceSignature,D.signature(input));assert.equal(projection.cues[0].start,0);assert.equal(projection.cues[0].end,2);
});

test('invalid generated wording, duplicate projected boundaries and marks inside hidden or surrogate ranges reject atomically',()=>{
 const input=doc(cue('a','我呃呃🙂知道')),decision=hide('a',1,3),mark=at=>({cue_id:'a',at,mark:'，',reason:'句界'});
 for(const options of [
  {marks:[{...mark(3),mark:'字'}]},{marks:[{...mark(3),mark:'，。'}]},{marks:[{...mark(3),mark:'.'}]},
  {marks:[{...mark(3),method:'automatic'}]},{marks:[{...mark(3),reason:''}]},{marks:[{...mark(3),replacement:'新话'}]},
  {marks:[mark(0)]},{marks:[mark(99)]},{marks:[mark(4)]},{marks:[mark(3),mark(3)]},
  {decisions:[decision],marks:[mark(2)]},{decisions:[decision],marks:[mark(1),mark(3)]},
  {decisions:[hide('a',0,3)],marks:[mark(3)]},
  {breaks:[{cue_id:'a',at:0,reason:'开头'}]},{breaks:[{cue_id:'a',at:4,reason:'拆开代理对'}]},
  {breaks:[{cue_id:'a',at:3,reason:'重复'},{cue_id:'a',at:3,reason:'重复'}]},
  {decisions:[decision],breaks:[{cue_id:'a',at:2,reason:'隐藏内部'}]}
 ])assert.throws(()=>D.createProjection(input,options));
 const accepted=D.createProjection(input,{decisions:[decision],marks:[mark(3)]});
 assert.equal(accepted.cues[0].readingText,'我，🙂知道');
 assert.equal(input.segments[0].text,'我呃呃🙂知道');
});

test('all-hidden and originally empty cues retain ordered source anchors without manufacturing text',()=>{
 const input=doc(cue('a','呃，'),cue('b','',2),cue('c','好。',4));
 const projection=D.createProjection(input,{decisions:[hide('a',0,2)]});
 assert.deepEqual(projection.cues.map(c=>[c.cue_id,c.text,c.start,c.end]),[['a','',0,2],['b','',2,4],['c','好。',4,6]]);
 assert.equal(projection.cues[0].spans[0].action,'hide');assert.deepEqual(projection.cues[1].spans,[]);
 assert.throws(()=>D.select(projection,[{cue_id:'a',from:0,to:1}]));
});

test('selection returns canonical pieces across hidden gaps and never presents a joined reading sentence as a source quote',()=>{
 const projection=D.createProjection(doc(cue('a','我呃认为嗯很好')),{decisions:[hide('a',1,2),hide('a',4,5)]});
 const selection=D.select(projection,[{cue_id:'a',from:0,to:5}]);
 assert.equal(selection.displayText,'我认为很好');assert.equal(selection.continuous,false);
 assert.deepEqual(selection.pieces.map(p=>[p.cue_id,p.from,p.to,p.text]),[['a',0,1,'我'],['a',2,4,'认为'],['a',5,7,'很好']]);
 assert.ok(selection.pieces.every(p=>p.start===0&&p.end===2&&p.timing_basis==='cue'));
 const partial=D.select(projection,[{cue_id:'a',from:1,to:3}]);
 assert.equal(partial.continuous,true);assert.deepEqual(partial.pieces.map(p=>[p.from,p.to,p.text]),[[2,4,'认为']]);
});

test('selection preserves cue and speaker boundaries and separates discontinuous displayed ranges',()=>{
 const projection=D.createProjection(doc(cue('a','第一句话'),cue('b','第二句话',2,'乙')));
 const selected=D.select(projection,[{cue_id:'a',from:0,to:1},{cue_id:'a',from:3,to:4},{cue_id:'b',from:0,to:2}]);
 assert.equal(selected.continuous,false);
 assert.deepEqual(selected.pieces.map(p=>[p.cue_id,p.from,p.to,p.text]),[['a',0,1,'第'],['a',3,4,'话'],['b',0,2,'第二']]);
 assert.throws(()=>D.select(projection,[{cue_id:'b',from:0,to:1},{cue_id:'a',from:0,to:1}]));
 assert.throws(()=>D.select(projection,[{cue_id:'a',from:0,to:2},{cue_id:'a',from:1,to:3}]));
 assert.throws(()=>D.createProjection(doc(cue('a','甲'),cue('b','乙',2,'乙')),{decisions:[{...hide('a',0,2),to_cue_id:'b'}]}));
});

test('UTF-16 offsets preserve astral characters and reject cuts inside surrogate pairs',()=>{
 const input=doc(cue('a','嗯🙂可以𠮷。'));
 const projection=D.createProjection(input,{decisions:[hide('a',0,1)]});
 assert.equal(projection.cues[0].text,'🙂可以𠮷。');
 assert.deepEqual(D.select(projection,[{cue_id:'a',from:0,to:2}]).pieces.map(p=>[p.from,p.to,p.text]),[[1,3,'🙂']]);
 assert.throws(()=>D.createProjection(input,{decisions:[hide('a',1,2)]}));
 assert.throws(()=>D.select(projection,[{cue_id:'a',from:0,to:1}]));
});

test('invalid, overlapping, duplicated or rewriting proposals reject the whole projection',()=>{
 const input=doc(cue('a','我呃很好。')),before=structuredClone(input);
 for(const decisions of [
  [hide('missing',0,1)],[hide('a',-1,1)],[hide('a',0,99)],[hide('a',1,1)],
  [hide('a',.5,2)],[hide('a',1,3),hide('a',2,4)],[hide('a',1,2),hide('a',1,2)],
  [{...hide('a',1,2),action:'replace',replacement:'嗯'}],[{...hide('a',1,2),replacement:''}],
  [{...hide('a',1,2),confidence:NaN}],[{...hide('a',1,2),confidence:1.1}],[{...hide('a',1,2),reason:''}]
 ])assert.throws(()=>D.createProjection(input,{decisions}));
 assert.deepEqual(input,before);
 assert.throws(()=>D.createProjection(input,{policyVersion:''}));
 assert.throws(()=>D.createProjection(doc(cue('same','甲'),cue('same','乙',2))));
});

test('source and policy freshness includes words, speaker identity, time, order and document identity while ignoring notes',()=>{
 const input=doc({...cue('a','你好'),words:[{word:'你',start:0,end:1},{word:'好',start:1,end:2}]},cue('b','再见',2));
 const projection=D.createProjection(input,{policyVersion:'rules-1'});
 assert.equal(D.assertCurrent({...input,notes:{a:'新笔记'},title:'新标题'},projection,{policyVersion:'rules-1'}),projection);
 for(const change of [
  d=>{d.key='another';},d=>{d.segments[0].text='您好';},d=>{d.segments[0].start=.1;},
  d=>{d.segments[0].speaker='乙';},d=>{d.segments[0].speaker_id='speaker-0001';},
  d=>{d.segments[0].words[0].end=.5;},d=>{d.segments[0].words[0].word='您';},
  d=>{d.segments[0].words[0].text_start=0;},d=>{d.segments[0].id='new';}
 ]){const altered=structuredClone(input);change(altered);assert.throws(()=>D.assertCurrent(altered,projection));assert.throws(()=>D.createProjection(altered,{decisions:[hide('a',0,1)],sourceSignature:projection.sourceSignature}));}
 assert.throws(()=>D.assertCurrent(input,projection,{policyVersion:'rules-2'}));
 input.segments.reverse();assert.throws(()=>D.assertCurrent(input,projection));
 assert.throws(()=>D.select(JSON.parse(JSON.stringify(projection)),[{cue_id:'a',from:0,to:1}]));
});

test('source signatures match Node SHA-256 for mixed scripts, emoji and multi-block input',()=>{
 const input=doc({...cue('a','中文🙂English '.repeat(50)),words:[{word:'原始词',start:0,end:1,text_start:0,text_end:3}]}),c=input.segments[0];
 const snapshot={key:input.key,cues:[{id:c.id,start:c.start,end:c.end,text:c.text,speaker:c.speaker,speaker_id:null,alignment_status:null,timing_basis:null,words:[{word:'原始词',start:0,end:1,text_start:0,text_end:3}]}]};
 assert.equal(D.signature(input),'sha256:'+createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'));
});

test('the browser module exposes the same immutable, source-linked projection API',async()=>{
 const context=vm.createContext({TextEncoder});
 vm.runInContext(await readFile(new URL('../reader/disfluency.js',import.meta.url),'utf8'),context);
 const browser=context.CoconutDisfluency,input=doc(cue('a','我呃知道'));
 const projection=browser.createProjection(input,{decisions:[hide('a',1,2)]});
 assert.equal(projection.cues[0].text,'我知道');assert.equal(browser.signature(input),D.signature(input));
 assert.equal(browser.select(projection,[{cue_id:'a',from:0,to:3}]).pieces.length,2);
 assert.equal(Object.isFrozen(projection.cues[0].spans),true);
});
