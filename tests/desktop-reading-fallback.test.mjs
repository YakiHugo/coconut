import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createReadingFallback,planReadingFallback} from '../desktop/reading-fallback.mjs';
const R=createRequire(import.meta.url)('../shared/reading-fallback.js');
const doc=()=>({segments:Array.from({length:30},(_,i)=>({id:'c'+i,start:i,end:i+1,speaker:'speaker-a',text:i<3?'开始讨论这个实施方案呃讨论这个实施方案然后继续说明原来的安排。':'这是用于预算核对的普通背景句段，内容不需要改写或者进行其他操作。'}))});
const response=input=>{const p=JSON.parse(input),w=p.windows[0],t=w.targets.find(t=>t.kind.includes('repetition'));return {hides:t?[{window_id:w.window_id,target_id:t.target_id,from:t.from,to:t.to,original:t.original,reason:'literal immediate restart'}]:[],marks:[],abstentions:[]};};
async function directory(t){const p=await mkdtemp(path.join(tmpdir(),'coconut-reading-fallback-'));t.after(()=>rm(p,{recursive:true,force:true}));return p;}

test('missing provider is zero calls and does not require cache or modify source',async()=>{
 let calls=0;const d=doc(),before=structuredClone(d);
 const fallback=createReadingFallback({providers:{structured:async()=>{calls++;throw Error();}}});
 const r=await fallback.run(d,{maxWindows:2,maxRequests:1});
 assert.ok(r.windows.length);assert.equal(calls,0);assert.equal(r.stats.requests,0);assert.equal(r.stats.sentCharacters,0);assert.deepEqual(d,before);
});
test('hard routing budgets count context and repeated source strings, with bounded request/windows',()=>{
 const p=planReadingFallback(doc(),{maxFraction:1,maxWindows:2,maxRequests:1,windowsPerRequest:2,maxWindowCharacters:80});
 assert.ok(p.windows.length<=2);assert.ok(p.batches.length<=1);assert.ok(p.plannedCharacters<=Math.floor(p.input.characters*.1));
 assert.equal(p.plannedCharacters,p.batches.reduce((n,b)=>n+R.batchCharacters(b),0));
 assert.ok(p.windows.every(w=>w.text.length<=80));
 assert.ok(p.plannedCharacters>p.windows.reduce((n,w)=>n+w.text.length,0));
 assert.equal(planReadingFallback(doc(),{maxRequests:0}).windows.length,0);
});
test('explicit CLI output is source bounded and successful cache resumes at zero sends',async t=>{
 const dir=await directory(t);let calls=0;const d=doc(),before=structuredClone(d);
 const fallback=createReadingFallback({providers:{structured:async(provider,input)=>{assert.equal(provider,'codex');calls++;assert.ok(!input.includes('speaker-a'));return response(input);}}});
 const options={directory:dir,provider:'codex',maxRequests:1,maxWindows:2};
 const first=await fallback.run(d,options);assert.equal(calls,1);assert.ok(first.decisions.length);assert.ok(first.stats.sentCharacters<=Math.floor(first.stats.sourceCharacters*.1));
 assert.ok(first.stats.distinctSourceCharacters<=first.stats.sentCharacters);assert.equal(first.stats.repeatedSentCharacters,first.stats.sentCharacters-first.stats.distinctSourceCharacters);
 const second=await fallback.run(d,options);assert.equal(calls,1);assert.deepEqual(second.decisions,first.decisions);assert.equal(second.stats.cacheHits,1);assert.equal(second.stats.sentCharacters,0);
 assert.deepEqual(d,before);
 await fallback.run(d,{...options,model:'explicit-test-id'});assert.equal(calls,2);
});
test('unknown/failed requests stay local, retain source, and never automatically resend',async t=>{
 const dir=await directory(t);let calls=0;
 const fallback=createReadingFallback({providers:{structured:async()=>{calls++;throw Error('provider failed with untrusted private details');}}});
 const options={directory:dir,provider:'codex',maxRequests:1,maxWindows:2};
 const first=await fallback.run(doc(),options),second=await fallback.run(doc(),options);
 assert.equal(calls,1);assert.deepEqual(first.decisions,[]);assert.equal(first.stats.blockedRequests,1);assert.equal(second.stats.sentCharacters,0);
 assert.ok(!JSON.stringify(first).includes('untrusted private details'));
 const work=path.join(dir,first.identity),files=await readdir(work),cache=files.find(f=>f.startsWith('batch-')&&f.endsWith('.json'));
 await writeFile(path.join(work,cache),JSON.stringify({state:'pending'}));await fallback.run(doc(),options);assert.equal(calls,1);
});
test('two callers atomically claim one request instead of duplicate sends',async t=>{
 const dir=await directory(t);let calls=0;let release;const gate=new Promise(r=>{release=r;});
 const providers={structured:async(_,input)=>{calls++;await gate;return response(input);}};
 const options={directory:dir,provider:'codex',maxRequests:1,maxWindows:2};
 const first=createReadingFallback({providers}).run(doc(),options);
 while(calls===0)await new Promise(resolve=>setTimeout(resolve,1));
 const second=await createReadingFallback({providers}).run(doc(),options);assert.equal(second.stats.requests,0);assert.equal(second.stats.blockedRequests,1);
 release();await first;assert.equal(calls,1);
});
test('free rewrites, changed clocks, out-of-range hides, and invented marks are rejected',()=>{
 const p=planReadingFallback(doc(),{maxRequests:1}),batch=p.batches[0],valid=response(JSON.stringify(batch));
 assert.throws(()=>R.validateResponse(batch,{...valid,rewrite:'new prose'}),/结构/);
 const h=valid.hides[0];
 for(const changed of [{...h,to:h.to+1},{...h,from:-1},{...h,original:'invented'},{...h,start:0}])assert.deepEqual(R.validateResponse(batch,{...valid,hides:[changed]}).decisions,[]);
 const w=batch.windows[0];const forged={window_id:w.window_id,target_id:w.targets[0].target_id,at:w.from,mark:'。',reason:'invented point'};
 assert.deepEqual(R.validateResponse(batch,{hides:[],marks:[forged],abstentions:[]}).marks,[]);
});
test('entities, numbers, negations, answers, emphasis, quotes and grammatical repetition remain protected',()=>{
 const d=doc();d.transcription_glossary=[{term:'讨论这个实施方案'}];assert.equal(planReadingFallback(d).windows.length,0);
 for(const text of ['他说非常非常重要然后继续介绍相关的背景信息。','他说不是不是这个意思然后继续介绍相关的背景信息。','他说2026年2026年然后继续介绍相关的背景信息。','他说研究研究之后再做打算然后继续说明背景。','他说“讨论这个实施方案呃讨论这个实施方案”然后继续说明背景。','嗯，好的。']){
  const input=doc();input.segments=input.segments.map(c=>({...c,text}));assert.equal(planReadingFallback(input).windows.length,0,text);
 }
});
test('base masks remove already resolved repetition candidates',()=>{
 const d=doc(),p=planReadingFallback(d),first=p.windows[0].targets[0],base=d.segments.slice(0,3).map(c=>({cue_id:c.id,from:first.from,to:first.to,action:'hide'}));
 assert.equal(planReadingFallback(d,{baseDecisions:base}).windows.length,0);
});
test('provided boundary conflict permits only its fixed offset/allowed punctuation and does not send clocks',()=>{
 const d=doc();d.segments[3].text='😀这里结束前面的内容随后开始另外一个完整表达';
 const candidate={cue_id:'c3',at:12,reason:'acoustic and lexical boundary disagreement',allowed_marks:['。']};
 const p=planReadingFallback(d,{maxWindows:1,boundaryCandidates:[candidate]}),batch=p.batches[0],w=batch.windows[0],t=w.targets[0];
 assert.equal(t.kind,'strong_boundary_conflict');assert.ok(!Object.hasOwn(w,'speaker'));assert.ok(!Object.hasOwn(w,'start'));
 const value={hides:[],marks:[{window_id:w.window_id,target_id:t.target_id,at:t.at,mark:'。',reason:'complete expression boundary'}],abstentions:[]};
 assert.deepEqual(R.validateResponse(batch,value).marks,[{cue_id:'c3',at:12,mark:'。',reason:'llm_confirmed_local_boundary',method:'llm'}]);
 value.marks[0].mark='？';assert.deepEqual(R.validateResponse(batch,value).marks,[]);
 const split={cue_id:'c3',at:1,reason:'invalid surrogate split'};assert.equal(planReadingFallback({...d,segments:[d.segments[3]]},{boundaryCandidates:[split]}).windows.length,0);
});
