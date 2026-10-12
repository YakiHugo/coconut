import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaStarted,mediaPaused} from './helpers/native-media-receipts.mjs';
const receipts=()=>({play:1,playing:1,pause:1,seeked:1});
test('a synchronous playing property cannot establish the next native event baseline',()=>{
 const before=receipts(),actual={paused:false,seeking:false,receipts:{...before}};assert.equal(mediaStarted(actual,before),false);
 actual.receipts.play++;assert.equal(mediaStarted(actual,before),false);actual.receipts.playing++;assert.equal(mediaStarted(actual,before),true);
});
test('seek-and-play ownership also waits for the actual new seeked receipt',()=>{
 const before=receipts(),actual={paused:false,seeking:false,receipts:{...before,play:2,playing:2}};assert.equal(mediaStarted(actual,before,{seek:true}),false);actual.receipts.seeked++;assert.equal(mediaStarted(actual,before,{seek:true}),true);
 for(const key of ['paused','seeking']){actual[key]=true;assert.equal(mediaStarted(actual,before,{seek:true}),false);actual[key]=false;}
});
test('a requested native pause waits for its receipt unless already paused',()=>{
 const before={paused:false,receipts:receipts()},actual={paused:true,receipts:receipts()};assert.equal(mediaPaused(actual,before),false);actual.receipts.pause++;assert.equal(mediaPaused(actual,before),true);assert.equal(mediaPaused({paused:true,receipts:receipts()},{paused:true,receipts:receipts()}),true);
});
test('settled baselines still reject every later seek, play or pause event',()=>{
 const baseline={seeks:1,plays:2,pauses:1};for(const key of Object.keys(baseline)){const after={...baseline,[key]:baseline[key]+1};assert.notEqual(JSON.stringify(after),JSON.stringify(baseline));}assert.equal(JSON.stringify({...baseline}),JSON.stringify(baseline));
});
