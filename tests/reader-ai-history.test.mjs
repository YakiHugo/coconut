// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import {createRequire} from 'node:module';

const C=createRequire(import.meta.url)('../reader/core.js');

function fixture(count=245,title='Authored AI history'){
 const segments=Array.from({length:3},(_,i)=>({id:'cue-'+i,text:`Authored source ${i}.`,start:i*4,end:i*4+4}));
 return {title,language:'en',segments,notes:{'cue-0':'Private note, never model input.'},ai_answers:Array.from({length:count},(_,i)=>({
  question:`Question ${i+1}`,answer:`Historical answer ${i+1}`,provider:'authored-fixture',purpose:i===1||i===24?'summary':'question',citations:['cue-'+(i%3)],input_snapshot:{version:1,segments:segments.map(({id,text})=>({id,text}))}
 }))};
}

test('all valid history, every summary and removed citation survive validation and both backup formats',()=>{
 const source=fixture(1205);source.ai_answers[0].citations=['removed-cue','cue-0'];
 source.ai_answers[0].input_snapshot.segments.push({id:'removed-cue',text:'Historical source retained after removal.'});
 delete source.ai_answers[2].input_snapshot;
 source.ai_answers.splice(17,0,null,{question:42,answer:'Invalid',citations:[]});
 const doc=C.validate(source),roundtrip=C.parse(JSON.stringify(doc),'history.json');
 assert.equal(doc.ai_answers.length,1205);assert.deepEqual(roundtrip.ai_answers,doc.ai_answers);
 assert.deepEqual(doc.ai_answers[0].citations,['removed-cue','cue-0']);assert.equal(C.answerFreshness(doc.ai_answers[0],doc),'stale');assert.equal(C.answerFreshness(doc.ai_answers[2],doc),'unknown');
 assert.equal(C.latestSummary(doc).answer,'Historical answer 25');assert.equal(doc.ai_answers.filter(a=>a.purpose==='summary').length,2);
 const backup={format:'coconut-library',version:1,active:'history',documents:[{...doc,key:'history'}]};
 const merged=C.mergeLibraryBackup({documents:[],active:null},JSON.parse(JSON.stringify(backup)));
 assert.deepEqual(merged.documents[0].ai_answers,doc.ai_answers);
 const report=C.aiReadingMarkdown(doc);assert.equal((report.match(/^## 回答 /gm)||[]).length,1205);assert.match(report,/Historical source retained after removal/);assert.match(report,/removed\\-cue · 原片段已移除/);
});
