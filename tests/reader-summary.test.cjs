const test=require('node:test');
const assert=require('node:assert/strict');
const S=require('../reader/summary.js');
const C=require('../reader/core.js');
const document=(count=801)=>({segments:Array.from({length:count},(_,i)=>({id:'source-'+i,start:i,end:i+1,text:'Original source '+i}))});
const note=(request)=>({answer:'A mocked batch note, not real model quality.',citations:[request.segments[0].id]});

test('whole source is covered in order without loss, including very long cues and Unicode boundaries',()=>{
 for(const doc of [document(5001),{segments:[{id:'one',text:'😀\\"中文'.repeat(50000)}]}]){
  const p=S.plan(doc);assert.ok(p.chunks.length>1);assert.ok(p.requests<=65);
  for(const [position,cue] of doc.segments.entries()){
   const parts=p.chunks.flatMap(c=>c.parts).filter(c=>c.position===position);
   assert.equal(parts.map(c=>c.text).join(''),cue.text);
   let offset=0;for(const part of parts){assert.equal(part.offset,offset);offset+=part.text.length;assert.ok(!/^[\uDC00-\uDFFF]/.test(part.text));assert.ok(!/[\uD800-\uDBFF]$/.test(part.text));}
  }
  for(const chunk of p.chunks){assert.ok(chunk.parts.length<=400);assert.ok(chunk.parts.reduce((n,c)=>n+c.text.length,0)<=16000);assert.ok(JSON.stringify(chunk.parts.map(({id,text})=>({id,text}))).length<=48000);}
 }
});

test('all batches are required before aggregation and all final citations map to original IDs',()=>{
 const p=S.plan(document()),job=S.create(p,'codex');let final;
 for(let i=0;i<p.chunks.length;i++){
  const request=S.request(p,job);assert.deepEqual(request.segments,p.chunks[i].parts.map(({id,text})=>({id,text})));
  final=S.accept(p,job,note(request));assert.equal(final,null);
 }
 const request=S.request(p,job);assert.equal(request.segments.length,p.chunks.length);assert.ok(request.segments.every(s=>s.id.startsWith('batch-')));
 assert.throws(()=>S.accept(p,job,{answer:'Bad',citations:['invented']}),/引用/);
 final=S.accept(p,job,{answer:'Final mocked synthesis',citations:request.segments.map(s=>s.id)});
 assert.deepEqual(final.citations,p.chunks.map(c=>c.parts[0].id));assert.ok(final.citations.every(id=>p.source.some(c=>c.id===id)));
 assert.equal(final.summary_process.batches,3);assert.equal(final.input_snapshot.segments.length,801);
});

test('long summary survives document export/import with complete snapshot and stale-source detection',()=>{
 const doc=document(5001),p=S.plan(doc),job=S.create(p,'claude');
 for(const _ of p.chunks)S.accept(p,job,note(S.request(p,job)));
 const final=S.accept(p,job,{answer:'Final mocked synthesis',citations:['batch-1','batch-13']});
 const restored=C.parse(JSON.stringify({...doc,ai_answers:[final]}),'summary.json');
 assert.equal(restored.ai_answers[0].input_snapshot.segments.length,5001);assert.equal(C.summaryFreshness(restored.ai_answers[0],restored),'current');
 assert.equal(restored.ai_answers[0].summary_process.requests,14);assert.match(C.summaryMarkdown(restored),/13 批原文笔记完成后再汇总/);
 for(const change of [d=>d.segments[4000].text+=' changed',d=>d.segments.pop(),d=>d.segments.push({id:'extra',text:'Extra'})]){
  const modified=structuredClone(restored);change(modified);assert.equal(C.summaryFreshness(modified.ai_answers[0],modified),'stale');
 }
});

test('checkpoints survive export/import, mark uncertain requests interrupted, and never carry final answers',()=>{
 const doc=document(),p=S.plan(doc),job=S.create(p,'codex');S.accept(p,job,note(S.request(p,job)));job.status='running';job.in_flight=1;
 const restored=C.parse(JSON.stringify({...doc,summary_job:job}),'checkpoint.json');
 assert.equal(restored.summary_job.status,'interrupted');assert.equal(restored.summary_job.results.length,1);assert.equal(restored.summary_job.in_flight,null);assert.equal(C.latestSummary(restored),null);
 assert.equal(S.request(p,restored.summary_job).segments[0].id,p.chunks[1].parts[0].id);assert.ok(S.current(restored.summary_job,restored));
 restored.segments[0].text='Changed';assert.equal(S.current(restored.summary_job,restored),false);
 assert.equal(S.clean({...job,results:[{answer:'Bad',citations:['made-up']}]}),null);
 assert.equal(S.clean({...job,results:Array(65).fill({answer:'Bad',citations:['source-0']})}),null);
});

test('bounded plans reject oversized work and malformed or citation-free results without retry or truncation',()=>{
 assert.throws(()=>S.plan(document(20001)),/20,000/);assert.throws(()=>S.plan({segments:[{id:'a',text:'a'.repeat(1000001)}]}),/1,000,000/);
 assert.throws(()=>S.plan({project_kind:'audio_only',segments:[]}),/没有文字稿/);
 const p=S.plan(document()),job=S.create(p,'codex');
 for(const value of [{answer:'No citations',citations:[]},{answer:'x'.repeat(1201),citations:['source-0']},{answer:'Not this chunk',citations:['source-800']}])assert.throws(()=>S.accept(p,job,value),/未保存/);
 assert.equal(job.results.length,0);assert.match(S.notice(p,job),/共 4 次/);assert.match(S.notice(p,job),/具体 token 和剩余额度未知/);
});
