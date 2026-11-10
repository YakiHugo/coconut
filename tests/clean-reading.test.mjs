import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import D from '../reader/disfluency.js';
import {createCleanReadingPlanner,mergeReadingEdits,readingSource} from '../desktop/clean-reading.mjs';
test('merging rule/fallback masks keeps generated marks at the same visible boundary',()=>{
 const doc={key:'x',segments:[{id:'a',start:0,end:3,text:'今天，嗯，然后继续。'}]};
 const edits=mergeReadingEdits(doc,{decisions:[{cue_id:'a',from:2,to:5,action:'hide',reason:'pause'},{cue_id:'a',from:4,to:6,action:'hide',reason:'comma'}],marks:[{cue_id:'a',at:5,mark:'。',reason:'boundary',method:'rule'}]});
 assert.equal(edits.decisions.length,1);assert.equal(edits.marks[0].at,2);
 const p=D.createProjection(doc,{...edits});assert.equal(p.cues[0].readingText,'今天。后继续。');
 assert.throws(()=>mergeReadingEdits(doc,{marks:[{cue_id:'a',at:2,mark:'。'},{cue_id:'a',at:2,mark:'，'}]}),/冲突/);
});
test('source snapshot excludes private material, retains term protection, and has identical source identity',()=>{
 const doc={key:'x',title:'名字',notes:{a:'secret'},transcription_glossary:[{term:'实体',source:'publisher'}],speaker_identity_evidence:{speakers:[{name:'嘉宾'}]},segments:[{id:'a',start:0,end:1,text:'实体来了'}]};
 const input=readingSource(doc);assert.equal(input.notes,undefined);assert.deepEqual(input.transcription_glossary,[{term:'实体'}]);assert.equal(D.signature(input),D.signature(doc));
});
test('local boundary issues survive optional fallback and candidates reach its bounded router',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'coconut-clean-plan-'));let received;
 try{
  const doc={key:'x',title:'authored',segments:[{id:'a',start:0,end:3,text:'今天讨论然后继续。'}]};
  const planner=createCleanReadingPlanner({run:async()=>({code:0,stdout:JSON.stringify({decisions:[],policyVersion:'rules'})}),fallback:{run:async(source,options)=>{received=options;return {decisions:[],marks:[],issues:[],stats:{requests:0}};}}});
  const result=await planner.prepare(doc,{directory:dir,boundaryPlan:{decisions:[],marks:[],breaks:[],issues:[{cue_id:'a',from:0,to:8,reason:'needs_context',candidate_marks:[{at:4,mark:'。'}]}]}});
  assert.equal(result.reading_cleanup.issues.length,1);assert.equal(received.boundaryCandidates[0].at,4);assert.deepEqual(received.boundaryCandidates[0].allowed_marks,['。']);assert.equal(result.reading_cleanup.stats.llmCalls,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
