// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import C from '../reader/core.js';

const points=text=>Array.from(text).length;

const fixture=(count=40,text='A'.repeat(1499)+'.')=>({key:'offline-source',title:'Long offline source',language:'en',notes:{'cue-0':'Private note, never sent'},segments:Array.from({length:count},(_,index)=>({id:'cue-'+index,start:index*60,end:(index+1)*60,text}))});

test('offline plan respects both limits and returns each complete cue in source order without mutation',()=>{
 for(const [count,text,expected] of [[40,'A'.repeat(1500),[26,14]],[65,'A',[32,32,1]],[11,'中'.repeat(4000),[10,1]],[10,'中'.repeat(4000),[10]]]){
  const doc=fixture(count,text),before=JSON.stringify(doc),batches=C.offlineTranslationBatches(doc.segments);
  assert.deepEqual(batches.map(batch=>batch.length),expected);assert.equal(JSON.stringify(doc),before);
  assert.deepEqual(batches.flat(),doc.segments.map(({id,text})=>({id,text})));
  for(const batch of batches)assert.ok(batch.reduce((sum,cue)=>sum+points(cue.text),0)<=40000);
 }
 assert.deepEqual(C.offlineTranslationBatches([]),[]);
});

test('offline plan counts Unicode code points like Python, retaining emoji, CJK and combining marks',()=>{
 const doc=fixture(11,'😀'.repeat(2000)+'中'.repeat(2000));doc.segments[0].id='😀'.repeat(200);
 const batches=C.offlineTranslationBatches(doc.segments);
 assert.deepEqual(batches.map(batch=>batch.length),[10,1]);assert.equal(batches[0][0].id,doc.segments[0].id);
 assert.equal(batches[0][0].text.length,6000);assert.equal(points(batches[0][0].text),4000);
 assert.equal(C.offlineTranslationBatches(fixture(1,'e\u0301'.repeat(2000)).segments)[0][0].text,'e\u0301'.repeat(2000));
});

for(const [label,change] of [
 ['oversized ASCII',doc=>{doc.segments[35].text='A'.repeat(4001);}],
 ['oversized emoji',doc=>{doc.segments[35].text='😀'.repeat(4001);}],
 ['oversized combining text',doc=>{doc.segments[35].text='e\u0301'.repeat(2001);}],
 ['empty text',doc=>{doc.segments[35].text='';}],
 ['empty ID',doc=>{doc.segments[35].id='';}],
 ['oversized ID',doc=>{doc.segments[35].id='😀'.repeat(201);}],
 ['duplicate ID',doc=>{doc.segments[35].id=doc.segments[0].id;}],
])test(`offline plan rejects ${label} before returning a partial plan and never truncates source`,()=>{
 const doc=fixture();change(doc);const before=JSON.stringify(doc);assert.throws(()=>C.offlineTranslationBatches(doc.segments),/待译第 36 段.*尚未发送/);assert.equal(JSON.stringify(doc),before);
});
