import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Window} from 'happy-dom';
import Coconut from '../reader/core.js';
const root=new URL('../',import.meta.url);
const fixture=(count,offset=0)=>({key:'performance',title:'Authored performance fixture',language:'en',notes:{},source_media:{job_id:'a'.repeat(32),kind:'audio'},segments:Array.from({length:count},(_,i)=>({id:'cue-'+i,start:offset+i*2,end:offset+i*2+1.8,text:'Authored sentence '+i+'.'}))});
function setup(){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 for(const name of ['summary','core','passages','passage-playback'])w.eval(fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8'));
 w.eval(['app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+`
 window.readerProbe={set(doc){state={documents:[doc],active:doc.key};mediaWorkerReady=true;workspace='read';},render,renderPassages,renderPassagePlayback,playbackSegment};`);
 w.fetch=()=>{throw Error('No requests allowed');};
 return {w,$:id=>w.document.getElementById(id),probe:w.readerProbe};
}

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

test('app playback index is reused for time events and rebuilt on render, array replacement, or document switch',async()=>{
 const {w,$,probe}=setup();try{
  let builds=0;const create=w.Coconut.createPlaybackIndex;w.Coconut={...w.Coconut,createPlaybackIndex(cues){builds++;return create(cues);}};
  const doc=fixture(12);probe.set(doc);probe.render();
  const player=$('source-media').querySelector('audio');assert.ok(player);
  const initial=builds;
  for(let i=0;i<20;i++){player.currentTime=2.5;player.ontimeupdate();assert.equal(probe.playbackSegment().id,'cue-1');}
  assert.equal(builds,initial,'time updates and dock lookups share the same index');
  doc.segments[1].start=10;doc.segments[1].end=12;probe.render();
  assert.equal(probe.playbackSegment(),undefined);assert.ok(builds>initial);
  doc.segments=[{id:'replacement',start:0,end:20,text:'Replacement'}];
  assert.equal(probe.playbackSegment().id,'replacement');
  const other={...fixture(2),key:'other'};probe.set(other);
  assert.equal(probe.playbackSegment().id,'cue-1');
  const after=builds;probe.playbackSegment();assert.equal(builds,after);
 }finally{await w.happyDOM.close();}
});

test('passage control refreshes never rebuild the whole transcript and replacement controls use fresh ranges',async()=>{
 const {w,$,probe}=setup();try{
  const doc=fixture(20000);probe.set(doc);
  const player=w.document.createElement('audio');Object.defineProperty(player,'duration',{configurable:true,value:40000});$('source-media').replaceChildren(player);
  let builds=0;const build=w.CoconutPassages.build;w.CoconutPassages={...w.CoconutPassages,build(...args){builds++;return build(...args);}};
  probe.renderPassages(doc);assert.equal(builds,1);assert.equal($('passage-body').querySelectorAll('.passage-listen').length,8);
  for(let i=0;i<20;i++)probe.renderPassagePlayback({status:'idle'});
  assert.equal(builds,1);assert.ok([...$('passage-body').querySelectorAll('.passage-listen')].every(button=>!button.disabled));
  Object.defineProperty(player,'duration',{configurable:true,value:0});probe.renderPassagePlayback({status:'idle'});
  assert.ok([...$('passage-body').querySelectorAll('.passage-listen')].every(button=>button.disabled));assert.equal(builds,1);
  Object.defineProperty(player,'duration',{configurable:true,value:40000});
  const changed=fixture(12,50000);probe.set(changed);probe.renderPassages(changed);
  assert.equal(builds,2);assert.ok([...$('passage-body').querySelectorAll('.passage-listen')].every(button=>button.disabled),'same cue IDs must not reuse the old passage time bounds');
 }finally{await w.happyDOM.close();}
});
