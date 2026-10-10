const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const P=require('../reader/passages.js');
const cue=(id,start=0,end=start+1,text='A short source fragment',speaker=null)=>({id,start,end,text,speaker});
const ids=passages=>passages.map(passage=>passage.cues.map(cue=>cue.id));

test('UMD exposes the same pure API to the browser without requiring a module loader',()=>{
 const context={window:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../reader/passages.js'),'utf8'),context);
 assert.deepEqual(Object.keys(context.window.CoconutPassages),Object.keys(P));
 assert.equal(context.window.CoconutPassages.build([cue('a')])[0].key,'passage:a');
 assert.ok(Object.isFrozen(P.LIMITS));
});

test('adjacent subtitle fragments become readable passages while every original reference survives',()=>{
 const source=Array.from({length:24},(_,i)=>cue('source-'+i,i,i+1,'A short source sentence.'));
 source[1].translations={zh:{text:'原有译文',source_text:source[1].text}};
 const before=JSON.stringify(source);source.forEach(Object.freeze);Object.freeze(source);
 const passages=P.build(source),flattened=passages.flatMap(p=>p.cues);
 assert.deepEqual(passages.map(p=>p.cues.length),[8,8,8]);
 assert.deepEqual(flattened,source);flattened.forEach((item,index)=>assert.equal(item,source[index]));
 assert.equal(flattened[1].translations,source[1].translations);assert.equal(JSON.stringify(source),before);
 assert.deepEqual(passages.map(p=>[p.start,p.end,p.speaker]),[[0,8,null],[8,16,null],[16,24,null]]);
 assert.deepEqual(P.build(source),passages);
});

test('speaker and >2 second silence boundaries are factual and exact',()=>{
 const source=[cue('a',0,1,'First','Speaker A'),cue('b',3,4,'Second','Speaker A'),
  cue('c',6.0001,7,'Third','Speaker A'),cue('d',7,8,'Fourth','Speaker B'),cue('e',8,9,'Unknown')];
 assert.deepEqual(ids(P.build(source)),[['a','b'],['c'],['d'],['e']]);
 assert.equal(P.build([cue('one',0,1,'x','Label'),cue('two',1,2,'y','label')]).length,2);
});

test('CJK full stops and closing quotes are preferred without producing one paragraph per sentence',()=>{
 const source=Array.from({length:20},(_,i)=>cue('中-'+i,i,i+1,i===7?'他说：「终于读完了。」':'这是短句。'));
 const passages=P.build(source);
 assert.deepEqual(passages.map(p=>p.cues.length),[8,8,4]);
 assert.equal(passages[0].cues.at(-1).text,'他说：「终于读完了。」');
});

test('English punctuation and closing marks end a substantial passage, commas do not',()=>{
 for(const ending of ['done.','done?','done!','done.”','done!\")  ','完成！』','完成……']){
  const source=Array.from({length:10},(_,i)=>cue('s'+i,i,i+1,i===7?ending:'small fragment,'));
  assert.deepEqual(P.build(source).map(p=>p.cues.length),[8,2],ending);
 }
 assert.deepEqual(P.build(Array.from({length:20},(_,i)=>cue('s'+i,i,i+1,'fragment, '))).map(p=>p.cues.length),[16,4]);
});

test('hard source character, cue count, and duration caps are each enforced independently',()=>{
 const cases=[
  Array.from({length:23},(_,i)=>cue('s'+i,i,i+1,'中'.repeat(110))),
  Array.from({length:41},(_,i)=>cue('s'+i,i/10,(i+1)/10,'a')),
  Array.from({length:12},(_,i)=>cue('s'+i,i*9,(i+1)*9,'a')),
 ];
 for(const source of cases){
  const passages=P.build(source);assert.deepEqual(passages.flatMap(p=>p.cues),source);
  for(const passage of passages){
   assert.ok(passage.cues.length<=P.LIMITS.cues);
   assert.ok(passage.cues.reduce((sum,s)=>sum+s.text.length,0)<=P.LIMITS.characters);
   assert.ok(passage.end-passage.start<=P.LIMITS.seconds);
  }
 }
 assert.deepEqual(P.build(cases[0]).map(p=>p.cues.length),[7,7,7,2]);
 assert.deepEqual(P.build(cases[1]).map(p=>p.cues.length),[16,16,9]);
 assert.deepEqual(P.build(cases[2]).map(p=>p.cues.length),[5,5,2]);
});

test('a hard limit prefers the last substantial sentence over a trailing unfinished fragment',()=>{
 const source=Array.from({length:9},(_,i)=>cue('s'+i,i,i+1,'x'.repeat(i<5?30:300)+(i===4?'.':'')));
 assert.deepEqual(P.build(source).map(p=>p.cues.length),[5,2,2]);
});

test('individual oversized cues remain whole and alone rather than slicing or truncating text',()=>{
 const longText=cue('long-text',1,2,'🧑🏽‍💻中\n'.repeat(500));
 const longTime=cue('long-time',2,82,'One prolonged source cue');
 const source=[cue('before'),longText,longTime,cue('after',82,83)];
 const passages=P.build(source);
 assert.deepEqual(ids(passages),[['before'],['long-text'],['long-time'],['after']]);
 assert.equal(passages[1].cues[0],longText);assert.equal(passages[2].cues[0],longTime);
 assert.equal(passages[1].cues[0].text,longText.text);
});

test('overlap, nested ends, fractional timing and zero duration retain truthful passage ranges',()=>{
 const source=[cue('long',1.125,9),cue('nested',2.25,3),cue('point',3,3),cue('next',3,4.5)];
 const passages=P.build(source);
 assert.deepEqual(ids(passages),[['long','nested','point','next']]);
 assert.equal(passages[0].start,1.125);assert.equal(passages[0].end,9);
 assert.deepEqual(source.map(s=>[s.start,s.end]),[[1.125,9],[2.25,3],[3,3],[3,4.5]]);
});

test('out-of-order starts break runs and never sort or repair original cues',()=>{
 const source=[cue('later',20,21),cue('earlier',1,2),cue('following',2,3)];
 const passages=P.build(source);
 assert.deepEqual(ids(passages),[['later'],['earlier','following']]);
 assert.equal(P.atTime(passages,1.5),passages[1]);assert.equal(P.atTime(passages,12),passages[0]);
});

test('spaces, newlines, empty source text, surrogate pairs and existing metadata remain untouched',()=>{
 const texts=[' Leading  ','\tand trailing\n','中文','日本語。','emoji 🥥🧑🏽‍💻','\r\n\u2028\u2029',''];
 const source=texts.map((text,i)=>cue('s'+i,i,i+1,text));
 source[0].original_text='Original before a correction';source[0].saved_excerpt=true;
 const before=JSON.stringify(source),passages=P.build(source);
 assert.deepEqual(passages.flatMap(p=>p.cues.map(s=>s.text)),texts);
 assert.equal(JSON.stringify(source),before);assert.equal(passages[0].cues[0],source[0]);
});

test('display separators keep English words apart without inserting spaces inside CJK text or punctuation',()=>{
 const cases=[
  ['work with','a limited budget',' '],['a sentence.','Another sentence.',' '],
  ['使用','中文',''],['読む','こと',''],['カタ','カナ',''],['𠀀','文字',''],
  ['第一句。','第二句',''],['中文','，逗号',''],['说完。','「下一句」',''],
  ['Use','API',' '],['API','使用方法',' '],['(word',')',''],['(','word',''],
  ['it',"'s",''],['word',', punctuation',''],['word','!',''],['他说：「','你好。',''],
  ['word ','next',''],['word',' next',''],['word\n','next',''],['word','\t next',''],
  ['word\u00a0','next',''],['word\u3000','next',''],['','next',''],['word','',''],
 ];
 for(const [left,right,wanted] of cases)assert.equal(P.separator(left,right),wanted,JSON.stringify([left,right]));
 const source=[cue('one',0,1,'work with'),cue('two',1,2,'a limited budget')],before=JSON.stringify(source);
 const text=source[0].text+P.separator(source[0].text,source[1].text)+source[1].text;
 assert.equal(text,'work with a limited budget');assert.equal(JSON.stringify(source),before);
});

test('array holes, null slots and explicit original positions cannot bridge omitted source',()=>{
 const sparse=[cue('a'),,cue('c',1,2),null,cue('e',2,3),undefined,cue('g',3,4)];
 assert.deepEqual(ids(P.build(sparse)),[['a'],['c'],['e'],['g']]);
 const positioned=[{...cue('a'),position:0},{...cue('c',1,2),position:2},{...cue('d',2,3),position:3}];
 assert.deepEqual(ids(P.build(positioned)),[['a'],['c','d']]);
 assert.equal(Object.hasOwn(sparse[0],'position'),false);
});

test('dense filtered lists use original references to preserve sparse boundaries without guessing from IDs',()=>{
 const source=[cue('arbitrary'),cue('another',1,2),cue('no-sequence',2,3),cue('last',3,4)];
 assert.deepEqual(ids(P.build([source[0],source[2],source[3]],{source})),[['arbitrary'],['no-sequence','last']]);
 assert.deepEqual(ids(P.build([source[2],source[0]],{source})),[['no-sequence'],['arbitrary']]);
 assert.throws(()=>P.build([{...source[0]}],{source}),/absent/);
 assert.throws(()=>P.build(source,{source:[source[0],source[0]]}),/repeated cue reference/);
 assert.deepEqual(ids(P.build(source)),[['arbitrary','another','no-sequence','last']]);
});

test('keys remain stable, source IDs are literal, and locate never treats IDs as markup or array offsets',()=>{
 const source=[cue('__proto__',0,1,'First','A'),cue('<tag>#?\"',1,2,'Second','B')],passages=P.build(source);
 assert.equal(passages[0].key,'passage:__proto__');assert.equal(P.locate(passages,'__proto__'),passages[0]);
 assert.equal(P.locate(passages,'<tag>#?\"'),passages[1]);assert.equal(P.locate(passages,0),null);
 assert.equal(P.locate(passages,'missing'),null);assert.equal(P.locate([],'missing'),null);
 assert.deepEqual(P.build(source).map(p=>p.key),passages.map(p=>p.key));
});

test('atTime uses cue intervals and next source in gaps instead of evenly spaced paragraph indexes',()=>{
 const passages=P.build([cue('early',3,4,'Early','A'),cue('middle',12.5,20,'Middle','B'),cue('late',99,100,'Late','C')]);
 for(const [time,index] of [[0,0],[3,0],[3.999,0],[4,1],[10,1],[12.5,1],[20,2],[50,2],[99,2],[100,2],[500,2]]){
  assert.equal(P.atTime(passages,time),passages[index],String(time));
 }
 for(const time of [NaN,Infinity,-1,'12',null,undefined])assert.equal(P.atTime(passages,time),null);
 assert.equal(P.atTime([],0),null);
});

test('atTime handles overlaps, shared edges, zero duration, and gaps inside a passage by actual cue intervals',()=>{
 const passages=P.build([cue('covering',0,20,'Wide','A'),cue('nested',5,6,'Nested','B'),
  cue('point',6,6,'Point','C'),cue('following',6,8,'Following','D'),cue('last-point',30,30,'Point','E')]);
 assert.equal(P.atTime(passages,5.5),passages[1]);
 assert.equal(P.atTime(passages,6),passages[3]);
 assert.equal(P.atTime(passages,8),passages[0]);
 assert.equal(P.atTime(passages,20),passages[4]);
 assert.equal(P.atTime(passages,30),passages[4]);
 assert.equal(P.atTime(passages,31),passages[4]);
 const pointOnly=P.build([cue('point',6,6)]);assert.equal(P.atTime(pointOnly,6),pointOnly[0]);
});

test('empty inputs are valid; invalid timestamps, source shapes, IDs and positions fail without mutation',()=>{
 assert.deepEqual(P.build([]),[]);assert.deepEqual(P.build([null,undefined]),[]);
 for(const input of [null,{},'source'])assert.throws(()=>P.build(input),TypeError);
 for(const patch of [{start:NaN},{end:Infinity},{start:-1},{end:-1},{start:2,end:1},{start:'0'},
  {id:42},{text:null},{speaker:1},{position:-1},{position:1.2},{position:NaN}]){
  const source=Object.freeze([Object.freeze({...cue('a'),...patch})]);
  assert.throws(()=>P.build(source),TypeError);
 }
 assert.throws(()=>P.build([cue('duplicate'),cue('duplicate',1,2)]),/Repeated/);
 assert.throws(()=>P.build([cue('a')],{source:{}}),/original cue array/);
});

test('large transcripts stay bounded and preserve one-to-one source ownership',()=>{
 const source=Array.from({length:20000},(_,i)=>cue('s'+i,i*.7,(i+1)*.7,i%5===4?'结束。':'连续字幕'));
 const passages=P.build(source),all=passages.flatMap(p=>p.cues);
 assert.equal(all.length,source.length);assert.equal(new Set(all).size,source.length);
 all.forEach((item,index)=>assert.equal(item,source[index]));
 assert.ok(passages.every(p=>p.cues.length<=P.LIMITS.cues&&p.end-p.start<=P.LIMITS.seconds));
});

test('seeded irregular and filtered transcripts preserve coverage, adjacency, bounds and timing lookup',()=>{
 let seed=6173;
 const random=limit=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%limit;};
 for(let trial=0;trial<250;trial++){
  let time=0;
  const source=Array.from({length:40},(_,i)=>{
   time=Math.max(0,time+(random(10)===0?-5:random(6)));
   return cue('s'+i,time,time+random(55),'字'.repeat(random(950))+(random(3)===0?'。':''),['A','B',null][random(3)]);
  });
  const filtered=source.filter(()=>random(5)!==0),before=JSON.stringify(source),passages=P.build(filtered,{source});
  assert.deepEqual(passages.flatMap(p=>p.cues),filtered);assert.equal(JSON.stringify(source),before);
  for(const passage of passages){
   assert.equal(passage.start,passage.cues[0].start);assert.equal(passage.end,Math.max(...passage.cues.map(s=>s.end)));
   if(passage.cues.length>1){
    assert.ok(passage.cues.length<=P.LIMITS.cues);
    assert.ok(passage.end-passage.start<=P.LIMITS.seconds);
    assert.ok(passage.cues.reduce((sum,s)=>sum+s.text.length,0)<=P.LIMITS.characters);
   }
   for(let i=1;i<passage.cues.length;i++){
    const prior=passage.cues[i-1],current=passage.cues[i];
    assert.equal(source.indexOf(current),source.indexOf(prior)+1);
    assert.equal(current.speaker,prior.speaker);assert.ok(current.start>=prior.start);assert.ok(current.start-prior.end<=2);
   }
  }
  for(const seconds of [0,20,50,100,500]){
   const active=filtered.map((s,index)=>({s,index})).filter(({s})=>s.start<=seconds&&(seconds<s.end||seconds===s.start&&s.start===s.end))
    .sort((a,b)=>b.s.start-a.s.start||b.index-a.index)[0]?.s;
   const next=filtered.map((s,index)=>({s,index})).filter(({s})=>s.start>seconds).sort((a,b)=>a.s.start-b.s.start||a.index-b.index)[0]?.s;
   const previous=filtered.map((s,index)=>({s,index})).filter(({s})=>s.end<=seconds).sort((a,b)=>b.s.end-a.s.end||b.index-a.index)[0]?.s;
   assert.equal(P.atTime(passages,seconds),P.locate(passages,(active||next||previous)?.id));
  }
 }
});
