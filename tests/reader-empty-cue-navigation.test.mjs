// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import C from '../reader/core.js';

function fixture(id=''){
 const doc={...C.validate({title:'Authored empty cue source',language:'en',segments:Array.from({length:180},(_,i)=>({id:i===155?id:'cue-'+i,start:i*10,end:i*10+4,text:'Authored passage '+i+'.'})),notes:{[id]:'Original private needle'}}),key:'target'};
 doc.exact_excerpts=[C.exactExcerptSnapshot(doc,[doc.segments[155]],[],0,doc.segments[155].text.length,{id:'precise-target',createdAt:'2026-10-14T00:00:00.000Z'})];
 const other={...C.validate({title:'Other document',segments:[{id:'other',start:0,end:5,text:'Unrelated text.'}]}),key:'other'};
 return [other,doc];
}

test('cue validation preserves an empty string but never treats numeric zero as a string identity',()=>{
 const source=fixture()[1];assert.equal(C.validate(source).segments[155].id,'');
 assert.equal(C.validate({segments:[{id:0,text:'Zero is not a cue string.',start:0,end:1}]}).segments[0].id,'segment-1');
});
