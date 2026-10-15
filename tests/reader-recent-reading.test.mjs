// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import Coconut from '../reader/core.js';

const KEY='coconut-reading-recency-v1';

const docs=()=>['a','b','c'].map(key=>({key,title:'Authored '+key,language:'en',notes:{cue:'Note '+key},readingPosition:'cue',segments:[{id:'cue',start:0,end:5,text:'Source '+key}]}));

function disk(){const map=new Map();return {getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,String(value)),removeItem:key=>map.delete(key)};}

test('bounded preference merges alternating windows, tombstones, malformed records and backwards clocks',()=>{
 const storage=disk(),a=Coconut.createReadingRecency({getStorage:()=>storage,now:()=>100}),b=Coconut.createReadingRecency({getStorage:()=>storage,now:()=>90});
 a.record('a');b.record('b');a.refresh();assert.ok(a.time('b')>a.time('a'));
 b.record('a',true);a.record('c');assert.equal(a.time('a'),0);assert.ok(a.time('b')>0);
 for(let i=0;i<600;i++)a.record('key-'+i);
 assert.equal(JSON.parse(storage.getItem(KEY)).events.length,512);assert.equal(a.time('b'),0);
 storage.setItem(KEY,JSON.stringify({version:1,events:[['bad',NaN,false],['bad2',-1,false],['bad3',3,'yes'],['ok',9999,false],['ok',9999,true]]}));
 const clean=Coconut.createReadingRecency({getStorage:()=>storage});assert.equal(clean.time('ok'),0);assert.equal(clean.time('bad3'),0);
 storage.setItem(KEY,'{broken');assert.doesNotThrow(()=>clean.record('safe'));
});

test('equal/unknown recency uses stable added order and never mutates the source',()=>{
 const documents=docs();assert.deepEqual(Coconut.sortedLibrary(documents,'opened',key=>key==='c'?3:0).map(d=>d.key),['c','a','b']);
 assert.deepEqual(Coconut.sortedLibrary(documents,'opened',()=>5),documents);assert.deepEqual(documents.map(d=>d.key),['a','b','c']);
});

test('completely unavailable preference storage keeps bounded recency in memory',()=>{
 const prefs=Coconut.createReadingRecency({getStorage(){throw Error('Storage denied');},now:()=>7});
 assert.doesNotThrow(()=>prefs.record('a'));assert.equal(prefs.time('a'),7);assert.doesNotThrow(()=>prefs.refresh());assert.equal(prefs.time('a'),7);
});
