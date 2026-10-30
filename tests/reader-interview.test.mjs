import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),I=require('../reader/interview.js'),E=require('../reader/editions.js'),C=require('../reader/core.js');
const stamp='2026-10-30T08:00:00.000Z';
const doc=()=>({...C.validate({title:'访谈',language:'zh',segments:[{id:'a',start:0,end:2,text:'为什么？',speaker:'采访者'},{id:'b',start:2,end:5,text:'我我觉得值得试试。',speaker:'嘉宾'},{id:'c',start:5,end:8,text:'也可能失败。',speaker:'嘉宾'},{id:'d',start:9,end:10,text:'嗯。',speaker:null}]}),key:'doc'});
const response=parts=>({answer:JSON.stringify({blocks:parts.map(c=>({heading:'',paragraphs:[c.text.replace('我我','我')],source_refs:[c.id]}))}),citations:parts.map(c=>c.id)});
test('interview plans send direct original speech and acoustic attribution; no compressed final request',()=>{
 const d=doc(),p=I.plan(d),j=I.create(p,'codex','chosen'),request=I.request(p,j);assert.equal(p.requests,p.chunks.length);assert.equal(request.model,'chosen');assert.equal(JSON.parse(request.segments[1].text).speech,d.segments[1].text);
 const result=I.accept(p,j,response(p.source));assert.equal(result.purpose,'interview');assert.equal(result.interview_process.basis,'direct_source');assert.equal(result.blocks[1].paragraphs[0],'我觉得值得试试。');assert.ok(I.cleanFinal(p,result,'codex','chosen'));assert.equal(I.cleanFinal(p,result,'claude','chosen'),null);assert.throws(()=>I.request(p,j));
});
for(const damage of ['omit','reorder','repeat','mix-speakers','merge-unknown','extra','malformed'])test('interview rejects '+damage+' before a reusable batch exists',()=>{
 const d=doc();if(damage==='merge-unknown')d.segments.push({id:'e',start:11,end:12,text:'好。',speaker:null});const p=I.plan(d),j=I.create(p,'codex'),value=response(p.source),data=JSON.parse(value.answer);
 if(damage==='omit')data.blocks.pop();if(damage==='reorder')data.blocks.reverse();if(damage==='repeat')data.blocks.push(data.blocks[0]);if(damage==='mix-speakers'){data.blocks[0].source_refs.push('b');data.blocks.splice(1,1);}if(damage==='merge-unknown'){data.blocks[3].source_refs.push('e');data.blocks.pop();}if(damage==='extra')data.blocks[0].source_refs=['invented'];value.answer=damage==='malformed'?'{':JSON.stringify(data);assert.throws(()=>I.accept(p,j,value));assert.equal(j.results.length,0);
});
test('source and task-bound generated version is accepted once; historical edition survives later source edits',()=>{
 let d=doc();const original=structuredClone(d);d=E.job(d,{id:'job-1',snapshotId:'snap',createdAt:stamp,provider:'codex',binding:'local'});const p=I.plan(d),j=I.create(p,'codex'),result=I.accept(p,j,response(p.source)),task={taskId:'task-1',kind:'interview',status:'succeeded',document:{key:d.key,revision:'job-1'},provider:'codex',result};
 assert.throws(()=>E.receive(d,'job-1',{...task,provider:'claude'},{createdAt:stamp}));d=E.receive(d,'job-1',task,{createdAt:stamp});assert.equal(E.receive(d,'job-1',task,{createdAt:stamp}),d);assert.equal(JSON.stringify(d.segments),JSON.stringify(original.segments));assert.equal(d.reading_editions.editions[0].method,'model');assert.deepEqual(C.parse(JSON.stringify(d),'draft.json').reading_editions,d.reading_editions);
 d.segments[1].text='后来修正';assert.equal(E.freshness(d,d.reading_editions.editions[0]),'stale');assert.match(E.evidenceMarkdown(d,'job-1'),/我我觉得/);assert.match(E.plainText(d,'job-1'),/我觉得/);
});
test('edited AI answers own edited offsets and frozen original evidence; future edits retain historical answer',()=>{
 let d=E.create(doc(),{id:'manual',snapshotId:'snap',createdAt:stamp});const b=d.reading_editions.editions[0].blocks[1],selection={blockId:b.id,blockText:E.blockText(b),from:0,to:3,text:E.blockText(b).slice(0,3)};
 d=E.answer(d,'manual',selection,{answer:'依据不足，请核对原声',citations:['b']},{id:'answer-1',createdAt:stamp,question:'解释',provider:'codex',model:'chosen-model',language:'zh'});assert.deepEqual(d.ai_answers,[]);assert.equal(d.reading_editions.answers[0].text,selection.text);assert.equal(d.reading_editions.answers[0].model,'chosen-model');
 assert.throws(()=>E.answer(d,'manual',selection,{answer:'伪引用',citations:['a']},{id:'answer-2',createdAt:stamp,question:'解释',provider:'codex',language:'zh'}));
 d=E.edit(d,'manual',b.id,{heading:'新标题',text:'修改后的整理正文'},1);assert.deepEqual(C.validate(d).reading_editions.answers[0].block_text,selection.blockText);assert.throws(()=>E.answer(d,'manual',selection,{answer:'迟到结果',citations:['b']},{id:'answer-3',createdAt:stamp,question:'解释',provider:'codex',language:'zh'}));
});
