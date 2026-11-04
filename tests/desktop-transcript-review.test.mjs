import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createTranscriptReviewer} from '../desktop/transcript-review.mjs';
import {createReviewProviders} from '../desktop/review-providers.mjs';
const doc=()=>({key:'recording',title:'对话刘元',segments:[{id:'a',start:0,end:1,text:'刘源',speaker:null}]});
test('completed batches resume without another model request; changed context uses separate work',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'coconut-review-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const d=doc();d.segments=Array.from({length:90},(_,i)=>({id:String(i),start:i,end:i+1,text:'一段话。'.repeat(20),speaker:null}));
 let calls=0,fail=true;const providers={structured:async()=>{calls++;if(calls===2&&fail)throw Error('interrupted');return {edits:[],issues:[]};}};
 const reviewer=createTranscriptReviewer({providers});await assert.rejects(reviewer.review(d,{directory}),/interrupted/);fail=false;
 await reviewer.review(d,{directory});assert.equal(calls,3);await reviewer.review(d,{directory});assert.equal(calls,3);
 await reviewer.review({...d,title:'第二期'},{directory});assert.equal(calls,5);
});
test('Kimi runs a no-tools profile with private input and rejects tool messages',async()=>{
 let calls=0,tool=false;
 const adapter=createReviewProviders({findKimi:async()=>'/kimi',run:async(binary,args,options)=>{
  calls++;if(args.includes('--help'))return {code:0,stdout:'--agent-file --skills-dir --output-format --prompt'};
  const file=args[args.indexOf('--agent-file')+1],profile=await readFile(file,'utf8');assert.match(profile,/tools: \[\]/);assert.match(profile,/subagents: \[\]/);assert.ok(profile.includes('private transcript'));assert.ok(!args.join(' ').includes('private transcript'));assert.equal(options.cwd,path.dirname(file));
  return {code:0,stdout:JSON.stringify(tool?{role:'assistant',tool_calls:[{}],content:'{}'}:{role:'assistant',content:'{"edits":[],"issues":[]}'})};
 }});
 assert.deepEqual(await adapter.structured('kimi','private transcript',{},'instruction'),{edits:[],issues:[]});tool=true;
 await assert.rejects(adapter.structured('kimi','private transcript',{},'instruction'),/工具/);assert.equal(calls,4);
});
