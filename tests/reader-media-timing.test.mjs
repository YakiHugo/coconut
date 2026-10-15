// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);

const Coconut=require('../reader/core.js');

const captions={title:'Calibration fixture',source_url:'https://www.youtube.com/watch?v=authored1234',segments:[{id:'a',start:10,end:12,text:'First authored cue'},{id:'b',start:20,end:24,text:'Second authored cue'}]};

test('bounded schema and source exports preserve canonical timestamps',()=>{
 const identity='file-candidate-v1:authored';
 const doc=Coconut.validate({...captions,media_timing:{version:1,identity,offset:2.1234}});
 assert.equal(doc.media_timing.offset,2.123);assert.equal(Coconut.mediaTimingOffset(doc,identity),2.123);assert.equal(Coconut.mediaTimingOffset(doc,'other'),0);
 for(const offset of [Infinity,NaN,'2',3600.01])assert.equal(Coconut.mediaTiming({version:1,identity,offset}),null);
 assert.equal(Coconut.mediaTimingRange({start:10,end:12},-11,120),null);assert.equal(Coconut.mediaTimingRange({start:10,end:12},110,120),null);
 assert.deepEqual(Coconut.mediaTimingRange({start:10,end:12},-10,120),{start:0,end:2});
 assert.equal(Coconut.subtitleExport(doc,'srt',false).text,Coconut.subtitleExport(Coconut.validate(captions),'srt',false).text);
 assert.equal(doc.segments[0].start,10);assert.match(Coconut.source(doc.source_url,10),/10/);
});
