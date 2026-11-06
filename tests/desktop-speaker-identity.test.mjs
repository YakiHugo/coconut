import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {identifySpeakers} from '../desktop/speaker-identity.mjs';
const doc={notes:{private:'never send'},speaker_identity_evidence:{source_url:'https://publisher.example/episode',speakers:[{id:'voice-b',name:'张元',role:'嘉宾'},{id:'voice-a',name:'陈旌',role:'主持人'}]},segments:[{id:'a1',speaker_id:'voice-a',speaker:'说话人 1',text:'张元，欢迎来到节目。',start:0,end:2,words:[{word:'张元，欢迎来到节目。',start:0,end:2}]},{id:'a2',speaker_id:'voice-a',speaker:'说话人 1',text:'我作为主持人想问一下。',start:2,end:4},{id:'b1',speaker_id:'voice-b',speaker:'说话人 2',text:'大家好，我是张元。',start:4,end:6},{id:'b2',speaker_id:'voice-b',speaker:'说话人 2',text:'我在基金做投资十年。',start:6,end:8}]};
const response={assignments:[{speaker_id:'voice-a',name:'陈旌',reason:'主持人对嘉宾发问',evidence:[{cue_id:'a1',quote:'欢迎来到节目'},{cue_id:'a2',quote:'作为主持人'}]},{speaker_id:'voice-b',name:'张元',reason:'自我介绍和投资履历',evidence:[{cue_id:'b1',quote:'我是张元'},{cue_id:'b2',quote:'基金做投资'}]}]};
async function fixture(fn){const directory=await mkdtemp(path.join(tmpdir(),'coconut-identities-'));try{await fn(directory);}finally{await rm(directory,{recursive:true,force:true});}}
test('names acoustic groups using citations rather than roster order; caches safely and preserves clocks',()=>fixture(async directory=>{let calls=0;const options={directory,provider:'codex',providers:{structured:async(p,input)=>{calls++;assert.equal(p,'codex');assert.ok(!input.includes('never send'));return response;}}};const before=structuredClone(doc),r=await identifySpeakers(doc,options);assert.equal(r.segments[0].speaker,'陈旌（主持人）');assert.equal(r.segments[2].speaker,'张元（嘉宾）');assert.deepEqual(r.segments.map(({speaker,...s})=>s),doc.segments.map(({speaker,...s})=>s));assert.deepEqual(doc,before);assert.equal(r.speaker_identity_evidence.assignments.length,2);await identifySpeakers(doc,options);assert.equal(calls,1);}));
test('unknown names, ambiguous duplicate identities and quotes from other voices do not rename groups',()=>fixture(async directory=>{for(const mutate of [r=>r.assignments[0].name='不存在的人',r=>r.assignments[0].name='张元',r=>r.assignments[0].evidence[0]={cue_id:'b1',quote:'我是张元'},r=>r.assignments[0].evidence[0].quote='没有说过的内容']){const value=structuredClone(response);mutate(value);const result=await identifySpeakers(doc,{directory:path.join(directory,Math.random().toString()),provider:'codex',providers:{structured:async()=>value}});assert.equal(result.segments[0].speaker,'说话人 1');}}));

test('native chunk identities are not submitted for automatic recording-wide naming',()=>fixture(async directory=>{
 const native=structuredClone(doc);for(const cue of native.segments){cue.speaker_scope='chunk';cue.chunk_index=0;}
 const before=structuredClone(native);let calls=0;
 const result=await identifySpeakers(native,{directory,provider:'codex',providers:{structured:async()=>{calls++;throw Error('Chunk identities must not be sent');}}});
 assert.equal(calls,0);assert.deepEqual(result,before);
}));

test('recording-scoped native groups remain nameable while chunk-local cues stay excluded',()=>fixture(async directory=>{
 const native=structuredClone(doc);for(const cue of native.segments)cue.speaker_scope='recording';
 const local={id:'local',speaker_id:'speaker-0003',speaker:'第2块 · S01',speaker_scope:'chunk',chunk_index:1,text:'LOCAL_SCOPE_ONLY',start:1800,end:1802};
 native.segments.push(local);
 const result=await identifySpeakers(native,{directory,provider:'codex',providers:{structured:async(_provider,input)=>{assert.ok(!input.includes('LOCAL_SCOPE_ONLY'));assert.ok(!input.includes('speaker-0003'));return response;}}});
 assert.equal(result.segments[0].speaker,'陈旌（主持人）');assert.equal(result.segments[2].speaker,'张元（嘉宾）');
 assert.deepEqual(result.segments.at(-1),local);assert.equal(result.segments[0].speaker_scope,'recording');
}));

test('recording-wide naming cannot rename an excluded chunk cue with a colliding numeric ID',()=>fixture(async directory=>{
 const native=structuredClone(doc);
 const local={id:'local',speaker_id:doc.segments[0].speaker_id,speaker:'第2块 · S01',speaker_scope:'chunk',chunk_index:1,text:'LOCAL_SCOPE_ONLY',start:1800,end:1802};
 native.segments.push(local);
 const result=await identifySpeakers(native,{directory,provider:'codex',providers:{structured:async(_provider,input)=>{assert.ok(!input.includes('LOCAL_SCOPE_ONLY'));return response;}}});
 assert.equal(result.segments[0].speaker,'陈旌（主持人）');assert.deepEqual(result.segments.at(-1),local);
}));

test('pre-ASR metadata extraction accepts literal roster and terms, excludes discussed people from voices',()=>fixture(async directory=>{
 const {prepareContext}=await import('../desktop/speaker-identity.mjs');const d={title:'对话张元，与王弘的十年',transcription_context:{source_url:'https://publisher.example/ep',description:'Voices：张元｜投资人；陈旌｜主持人。话题：Manus、王弘。'}};
 const r=await prepareContext(d,{directory,provider:'codex',providers:{structured:async()=>({roster_complete:true,participants:[{name:'张元',role:'嘉宾',quote:'张元｜投资人'},{name:'陈旌',role:'主持人',quote:'陈旌｜主持人'}],terms:[{term:'Manus',quote:'话题：Manus'},{term:'虚构拼写',quote:'话题：Manus'}]})}});
 assert.deepEqual(r.speaker_identity_evidence.speakers.map(x=>x.name),['张元','陈旌']);assert.equal(r.speaker_identity_evidence.expected_speakers,2);assert.deepEqual(r.transcription_glossary.map(x=>x.term),['Manus']);assert.equal(d.speaker_identity_evidence,undefined);
}));
