// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import Coconut from '../reader/core.js';

test('playback index preserves closed intervals and last source order for unsorted overlaps and zero-duration cues',()=>{
 const cues=[{id:'long',start:0,end:100},{id:'late',start:20,end:30},{id:'earlier',start:5,end:25},{id:'point',start:25,end:25},{id:'tie',start:20,end:30}];
 const index=Coconut.createPlaybackIndex(cues);
 for(const time of [-1,0,4,5,19,20,24.9,25,25.1,30,30.1,100,100.1,NaN,Infinity]){
  assert.equal(index.find(time),cues.findLast(cue=>cue.start<=time&&cue.end>=time),String(time));
 }
 assert.equal(index.find(22).id,'tie');assert.equal(index.find(31).id,'long');
 assert.equal(Coconut.createPlaybackIndex([]).find(0),undefined);
});

test('playback index matches the linear oracle over seeded arbitrary timelines and all endpoints',()=>{
 let seed=76123;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
 for(const count of [1,7,100,1771]){
  const cues=Array.from({length:count},(_,i)=>{const start=Math.floor(random()*500);return {id:'cue-'+i,start,end:start+Math.floor(random()*100)};});
  const index=Coconut.createPlaybackIndex(cues);
  const times=[...cues.flatMap(cue=>[cue.start,cue.end]),...Array.from({length:500},()=>random()*650)];
  for(const time of times)assert.equal(index.find(time),cues.findLast(cue=>cue.start<=time&&cue.end>=time),count+' cues at '+time);
 }
});

test('50,000-cue playback index reads source timing only at construction and retains its documented snapshot',()=>{
 let reads=0;
 const cues=Array.from({length:50000},(_,i)=>({id:'cue-'+i,get start(){reads++;return i*2;},get end(){reads++;return i*2+1;}}));
 const index=Coconut.createPlaybackIndex(cues);assert.equal(reads,100000);
 for(let i=0;i<1000;i++){const position=i*47%50000;assert.equal(index.find(position*2+.5),cues[position]);}
 assert.equal(reads,100000,'playback events must not rescan cue timing');
 const source=[{id:'before',start:0,end:2}];const old=Coconut.createPlaybackIndex(source);
 source[0]={id:'after',start:10,end:12};
 assert.equal(old.find(1).id,'before');assert.equal(old.find(11),undefined);
 assert.equal(Coconut.createPlaybackIndex(source).find(11).id,'after');
});
