// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

const fixture=(count=65)=>({title:'Action-specific reading',language:'en',notes:{'cue-0':'PRIVATE NOTE'},segments:Array.from({length:count},(_,i)=>({id:'cue-'+i,start:i*3,end:i*3+3,speaker:'Speaker',text:`Original sentence ${i}.`}))});

test('task submission and recovery bind model to receipt and preserve absent legacy model',async()=>{
 const {createRequire}=await import('node:module'),require=createRequire(import.meta.url),T=require('../reader/task-client.js');
 const doc={key:'doc',...fixture(2)},payload=T.submission(doc,{revision:'r',provider:'codex',model:'test-model',idempotencyKey:'key',consent:true});assert.equal(payload.model,'test-model');
 const result={purpose:'summary',answer:'mock',citations:['cue-0'],requested_model:'test-model',input_snapshot:{version:1,segments:payload.segments}};
 const task={taskId:'task',kind:'summary',status:'succeeded',provider:'codex',model:'test-model',document:payload.document,result};
 assert.equal(T.matchesResult(task,doc,'r'),true);assert.equal(T.recoveryFor(task).result.requested_model,'test-model');
 assert.equal(T.matchesResult({...task,model:'other'},doc,'r'),false);assert.equal(T.recoveryFor({...task,model:'other'}),null);
 delete task.model;delete result.requested_model;assert.equal(T.matchesResult(task,doc,'r'),true);assert.equal('model' in T.recoveryFor(task).task,false);
});
