const test=require('node:test'),assert=require('node:assert/strict'),R=require('../shared/transcript-review.js');
const doc=()=>({key:'one',title:'对话刘元',source_url:'https://example.test/episode',notes:{a:'私人笔记'},segments:[{id:'a',start:0,end:2,text:'刘源来了',speaker:'主持人',words:[{word:'刘',start:0,end:.2},{word:'源来了',start:.2,end:2}]}]});
const edit=(original,replacement,category='entity')=>({cue_id:'a',original,replacement,category,basis:'节目标题'});
const merge=(d,edits,issues=[])=>R.merge(d,R.snapshot(d),[{edits,issues}],{provider:'codex',jobId:'review-one'});
test('review snapshots exclude personal data and keep only grounded episode context',()=>{
 const d=doc();d.ai_answers=[{answer:'private answer'}];d.translation_glossary={secret:'private glossary'};d.segments[0].translations={en:'private translation'};
 const plan=R.plan(d),input=JSON.stringify(plan);assert.ok(!input.includes('私人笔记'));assert.ok(!input.includes('private'));assert.equal(plan.input.context.title,'对话刘元');
 assert.deepEqual(plan.batches[0].target_ids,['a']);
});
test('grounded names and punctuation project across word boundaries while retaining raw text and clocks',()=>{
 const d=doc(),original=structuredClone(d),result=merge(d,[edit('刘源','刘元'),edit('来了','来了。','punctuation')]);
 assert.equal(result.segments[0].text,'刘元来了。');assert.equal(result.segments[0].original_text,'刘源来了');
 assert.deepEqual(result.segments[0].words,[{word:'刘',start:0,end:.2},{word:'元来了。',start:.2,end:2}]);
 assert.deepEqual(result.notes,d.notes);assert.deepEqual(d,original);assert.equal(result.transcript_review.changes.length,2);
});
test('unfounded entities, changed numbers and negations, and inserted words stay as review issues',()=>{
 for(const [text,proposal] of [['刘源来了',edit('刘源','张元')],['投资12万',edit('12','20','typo')],['不能去',edit('不能','可以','typo')],['我参加',edit('我','你','typo')],['投资三万',edit('三','五','typo')],['刘源来了',edit('来了','已经来了','typo')]]){
  const d=doc();d.segments[0].text=text;delete d.segments[0].words;const result=merge(d,[proposal]);assert.equal(result.segments[0].text,text);assert.equal(result.transcript_review.issues.length,1);
 }
});
test('ambiguous locations, unknown IDs and overlapping edits cannot silently rewrite a cue',()=>{
 const d=doc();d.segments[0].text='刘源说刘源';delete d.segments[0].words;assert.equal(merge(d,[edit('刘源','刘元')]).transcript_review.changes.length,0);
 assert.throws(()=>merge(d,[{...edit('刘源','刘元'),cue_id:'not-sent'}]),/越界/);
 const before=doc(),result=merge(before,[edit('刘源','刘元'),edit('源','元','typo')]);assert.equal(result.transcript_review.changes.length,1);assert.equal(result.transcript_review.issues.length,1);
});
test('late results refuse changed sources while allowing concurrent personal annotations',()=>{
 const before=doc(),input=R.snapshot(before),output=[{edits:[edit('刘源','刘元')],issues:[]}],current=structuredClone(before);current.notes.a='更新的笔记';current.segments[0].translations={en:'saved'};
 const result=R.merge(current,input,output,{provider:'kimi'});assert.equal(result.notes.a,'更新的笔记');assert.deepEqual(result.segments[0].translations,current.segments[0].translations);
 for(const change of [d=>d.segments[0].text+='修改',d=>d.segments[0].start=.1,d=>d.segments[0].speaker='嘉宾',d=>d.title='另一节目']){const next=structuredClone(current);change(next);assert.throws(()=>R.merge(next,input,output,{}),/已变化/);}
});
test('long recordings use context-only neighbours and each cue is a target exactly once',()=>{
 const d=doc();d.segments=Array.from({length:200},(_,i)=>({id:String(i),start:i,end:i+1,text:'连续发言'.repeat(30),speaker:null}));
 const {batches}=R.plan(d);assert.ok(batches.length>1);assert.deepEqual(batches.flatMap(b=>b.target_ids),d.segments.map(c=>c.id));
 assert.ok(batches[1].cues.some(c=>!batches[1].target_ids.includes(c.id)));
 assert.throws(()=>R.validateBatch(batches[1],{edits:[{...edit('连续','继续','typo'),cue_id:batches[1].cues[0].id}],issues:[]}),/越界/);
});
