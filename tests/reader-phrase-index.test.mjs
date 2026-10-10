/** Source-backed phrase search; authored strings only, no network or models. */
import test from 'node:test';
import assert from 'node:assert/strict';
import C from '../reader/core.js';
import P from '../reader/passages.js';
import {splitCueFixture} from './helpers/split-cue-fixture.mjs';
const cue=(id,text,start=0,extra={})=>({id,text,start,end:start+1,...extra});
const doc=(segments,extra={})=>({title:'Authored phrase test',language:'en',notes:{},segments,...extra});
const ids=result=>[...result.byCue.keys()];
const matching=(d,q,...filters)=>d.segments.filter(s=>C.matchesSegment(s,d,q,...filters)).map(s=>s.id);
const translation=(s,language,text)=>{s.translations??={};s.translations[language]={text,source_text:s.text,provider:'Authored',document_language:'en'};};

test('authored English and Chinese cross-cue phrases retain exact ranges, source IDs and raw document',()=>{
 const d=splitCueFixture(6),before=JSON.stringify(d);
 const english=C.searchDocument(d,'LEFT OUT THE TIME'),chinese=C.searchDocument(d,'但我们忽略了人们所需的时间');
 assert.deepEqual(ids(english),['split-1','split-2']);assert.deepEqual(ids(chinese),['split-1','split-2']);
 assert.deepEqual(english.byCue.get('split-1').text,[{start:11,end:19}]);
 assert.deepEqual(english.byCue.get('split-2').text,[{start:0,end:8}]);
 assert.deepEqual(chinese.byCue.get('split-1').translations.zh,[{start:0,end:6}]);
 assert.deepEqual(chinese.byCue.get('split-2').translations.zh,[{start:0,end:7}]);
 const hit=english.previews.get('text:split-1');assert.equal(hit.snippet.match,'left out the time');assert.deepEqual(hit.ids,['split-1','split-2']);
 assert.equal(english.byCue.get('split-2').phrases.text,hit);
 assert.equal(JSON.stringify(d),before);
});

test('joining is exactly the reader typography, preserving punctuation, CJK and verbatim whitespace',()=>{
 for(const [left,right,query] of [['hello',', world','hello, world'],['（','中文）','（中文）'],['安全','通过。','安全通过。'],['hello ',' world','hello  world'],['hello\n','world','hello\nworld']]){
  const d=doc([cue('a',left),cue('b',right,1)]);
  assert.equal(P.separator(left,right)+right,(left+P.separator(left,right)+right).slice(left.length));
  assert.deepEqual(matching(d,query),['a','b']);
 }
 assert.deepEqual(matching(doc([cue('a','hello,'),cue('b','world',1)]),'hello world'),[],'punctuation is never removed to invent a phrase');
 assert.deepEqual(matching(doc([cue('a','hello '),cue('b',' world',1)]),'hello world'),[],'source whitespace is never collapsed');
});

test('shared source continuity crosses layout caps but not speaker, time, hole or explicit position breaks',()=>{
 const segments=Array.from({length:105},(_,i)=>cue('s'+i,'word'+i,i));
 segments[15].text='cap boundary';segments[16].text='continues here';segments[99].text='page boundary';segments[100].text='continues too';
 const d=doc(segments);assert.ok(P.build(segments).length>1);
 assert.deepEqual(matching(d,'boundary continues'),['s15','s16','s99','s100']);
 for(const [a,b] of [[cue('a','left',0,{speaker:'A'}),cue('b','right',1,{speaker:'B'})],[cue('a','left'),cue('b','right',3.01)],[cue('a','left',2),cue('b','right',1)],[cue('a','left',0,{position:0}),cue('b','right',1,{position:2})]])assert.deepEqual(matching(doc([a,b]),'left right'),[]);
 assert.deepEqual(ids(P.searchIndex([cue('a','left'),null,cue('b','right',1)]).search('left right')),[]);
 assert.equal(P.continuous(cue('a','left'),cue('b','right',3)),true,'exactly two seconds matches existing passage rule');
});

test('every current saved language is independent; hidden, missing and stale fields cannot be joined',()=>{
 const d=doc([cue('a','first source'),cue('b','second source',1),cue('c','third source',2)]);
 translation(d.segments[0],'zh','中文');translation(d.segments[1],'zh','短语');translation(d.segments[2],'zh','尾部');
 translation(d.segments[0],'fr','bonjour');translation(d.segments[1],'fr','monde');
 assert.deepEqual(matching(d,'中文短语'),['a','b']);assert.deepEqual(matching(d,'bonjour monde'),['a','b']);
 assert.deepEqual(matching(d,'中文 monde'),[]);assert.deepEqual(matching(d,'source 中文'),[]);
 delete d.segments[1].translations.zh;C.invalidateSearch(d);assert.deepEqual(matching(d,'中文尾部'),[]);
 translation(d.segments[1],'zh','短语');d.segments[1].translations.zh.source_text='old';C.invalidateSearch(d);assert.deepEqual(matching(d,'中文短语'),[]);
 d.segments[1].translations.zh.source_text=d.segments[1].text;C.invalidateSearch(d);assert.deepEqual(matching(d,'中文短语'),['a','b']);
 assert.equal(C.libraryMatches(d,'中文短语','all','text'),false,'documented library scope is original and notes');
 assert.deepEqual(C.libraryHits(d,'first source second','text')[0].ids,['a','b']);
});

test('overlaps are complete and merged source ranges remain exact through case-fold expansion and emoji',()=>{
 const d=doc([cue('a','a'),cue('b','a',1),cue('c','a',2)]),result=C.searchDocument(d,'a a');
 assert.deepEqual(ids(result),['a','b','c']);for(const entry of result.byCue.values())assert.deepEqual(entry.text,[{start:0,end:1}]);
 const single=doc([cue('a','banana İİ 😀')]);
 assert.deepEqual(C.searchDocument(single,'ana').byCue.get('a').text,[{start:1,end:6}]);
 assert.deepEqual(C.searchDocument(single,'i̇i').byCue.get('a').text,[{start:7,end:9}]);
 assert.deepEqual(C.searchDocument(single,'😀').byCue.get('a').text,[{start:10,end:12}]);
 assert.equal(C.searchDocument(single,'i̇i').previews.get('text:a').snippet.match,'İİ');
 assert.deepEqual(C.searchDocument(single,'̇').byCue.get('a').text,[{start:7,end:9}]);
});

test('notes/speakers stay separate and metadata filters intersect real contributing cues without rebuilding',()=>{
 const d=doc([cue('a','first word',0,{speaker:'A'}),cue('b','second word',1,{speaker:'A',saved_excerpt:true})],{notes:{a:'private note',b:'   '}});
 const result=C.searchDocument(d,'word second');assert.deepEqual(matching(d,'word second'),['a','b']);
 assert.deepEqual(matching(d,'word second',true),['a']);assert.deepEqual(matching(d,'word second',false,true),['b']);
 assert.deepEqual(matching(d,'word A'),[]);assert.deepEqual(matching(d,'A private'),[]);assert.deepEqual(matching(d,'private note'),['a']);
 const beforeMetadata=C.searchDocument(d,'word second');d.notes.a='';d.notes.b='fresh private note';assert.deepEqual(matching(d,'word second',true),['b']);
 assert.equal(C.searchDocument(d,'word second'),beforeMetadata,'metadata does not invalidate source index or cached phrase');
});

test('explicit mutations, replacement identity/arrays and document language invalidate all dependent matches',()=>{
 const d=doc([cue('a','left'),cue('b','right',1)]);translation(d.segments[0],'zh','中文');translation(d.segments[1],'zh','短语');
 assert.deepEqual(matching(d,'left right'),['a','b']);d.segments[0].text='changed';C.invalidateSearch(d);
 assert.deepEqual(matching(d,'left right'),[]);assert.deepEqual(matching(d,'中文短语'),[]);
 translation(d.segments[0],'zh','新的');C.invalidateSearch(d);assert.deepEqual(matching(d,'新的短语'),['a','b']);
 d.language='fr';assert.deepEqual(matching(d,'新的短语'),[]);
 const restored={...d,language:'en',segments:structuredClone(d.segments)};assert.deepEqual(matching(restored,'新的短语'),['a','b']);
 d.segments=[cue('a','different'),cue('b','data',1)];assert.deepEqual(matching(d,'different data'),['a','b']);
});

test('source-backed previews stay bounded for oversized Unicode cues and long matching queries',()=>{
 const text='😀'.repeat(5000)+'needle'+'中'.repeat(5000),d=doc([cue('huge',text)]);
 const preview=C.searchDocument(d,'needle').previews.get('text:huge').snippet;
 assert.equal(preview.match,'needle');assert.equal(Array.from(preview.before).length,36);assert.equal(Array.from(preview.after).length,66);
 assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(Object.values(preview).join('')));
 const long=C.searchDocument(d,'中'.repeat(1000)).previews.get('text:huge').snippet;assert.equal(Array.from(long.match).length,121);assert.ok(JSON.stringify(long).length<400);
});

test('50,000-cue authored run indexes once, never rereads source on repeated queries and scans spans monotonically',t=>{
 let reads=0;
 const segments=Array.from({length:50000},(_,i)=>({id:'s'+i,start:i,end:i+1,get text(){reads++;return i%1000===499?'left needle':i%1000===500?'crossing right':'An authored source cue '+i+'.';}}));
 const before=process.memoryUsage().heapUsed,start=performance.now(),index=P.searchIndex(segments),built=performance.now();
 const result=index.search('needle crossing'),queried=performance.now(),afterBuildReads=reads;
 assert.equal(index.stats.runs,1);assert.equal(index.stats.spans,50000);assert.equal(result.byCue.size,100);assert.deepEqual([...result.previews.values()][0].ids,['s499','s500']);
 for(let i=0;i<100;i++)assert.equal(index.search('needle crossing'),result);
 const repeat=performance.now();index.search('absent marker');assert.equal(reads,afterBuildReads,'query work uses indexed text, never re-concatenating mutable document text');
 assert.ok(index.stats.characters<1600000);assert.equal(segments[499].text,'left needle');
 t.diagnostic(JSON.stringify({authoredCues:segments.length,characters:index.stats.characters,buildMs:Math.round(built-start),firstQueryMs:Math.round(queried-built),hundredCachedQueriesMs:Math.round(repeat-queried),heapDeltaMiB:Math.round((process.memoryUsage().heapUsed-before)/1048576),sourceReads:afterBuildReads}));
});

 test('long overlapping repeated phrases map source ranges once rather than scanning a window per occurrence',t=>{
 const d=doc(Array.from({length:20000},(_,i)=>cue('s'+i,'a',i))),query=Array(10001).fill('a').join(' '),start=performance.now();
 const result=C.searchDocument(d,query);assert.equal(result.byCue.size,20000);
 assert.deepEqual(result.byCue.get('s19999').text,[{start:0,end:1}]);assert.equal(result.byCue.get('s19999').phrases.text.cueCount,10001);
 assert.equal(result.previews.get('text:s0').ids.length,10001);
 t.diagnostic('20,000 repeated cues / 10,001-cue overlapping phrase: '+Math.round(performance.now()-start)+' ms');
});

 test('cue membership normalizes a long query once, not once per cue',()=>{
 const d=doc(Array.from({length:1000},(_,i)=>cue('s'+i,'a',i))),query=Array(501).fill('A').join(' '),lower=query.toLocaleLowerCase();
 const original=String.prototype.toLocaleLowerCase;let queryFolds=0;
 String.prototype.toLocaleLowerCase=function(...args){if(String(this)===query||String(this)===lower)queryFolds++;return original.apply(this,args);};
 try{assert.equal(matching(d,query).length,1000);assert.ok(queryFolds<=3,'normalizations: '+queryFolds);}finally{String.prototype.toLocaleLowerCase=original;}
});
