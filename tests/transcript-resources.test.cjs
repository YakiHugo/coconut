const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../shared/transcript-resources.js');
const doc=()=>({key:'interview',title:'访谈',language:'zh',source_url:'https://example.test/video',notes:{one:'我的笔记'},provenance:{kind:'automatic_subtitles',media_duration:10},segments:[{id:'one',start:1,end:4,text:'我们开始吧',speaker:null},{id:'two',start:4,end:8,text:'今天聊人工智能',speaker:null}]});
test('resources choose punctuation and acoustic stages from evidence; timed source never requests ASR',()=>{
 const d=doc();assert.deepEqual(R.inspectResources(d,{punctuation:true}).steps,['punctuation']);assert.equal(R.inspectResources(d).requiresAudio,true);assert.equal(R.inspectResources(d).asr,false);
 assert.deepEqual(R.inspectResources(d,{audio:true,punctuation:true,speakers:true}).steps,['punctuation','speakers']);
 assert.equal(R.inspectResources({...d,segments:[]},{audio:true}).asr,true);
 assert.equal(R.inspectResources(d,{audio:true}).rows.find(r=>r.kind==='speakers').state,'missing_model');
 d.provenance.kind='publisher_transcript';assert.ok(!R.inspectResources(d,{punctuation:true}).steps.includes('punctuation'));
});
test('resolved acoustic processing leaves uncertain cues for review instead of endlessly recomputing',()=>{
 const d=doc();d.provenance.speaker_method='recording-acoustic-v1';d.provenance.punctuation_method='local-reading-v1';
 const plan=R.inspectResources(d,{audio:true,speakers:true,punctuation:true});assert.deepEqual(plan.steps,[]);assert.equal(plan.rows.find(r=>r.kind==='speakers').state,'needs_review');
});
test('snapshot excludes private notes and translations but retains source duration and manual histories',()=>{
 const d=doc();d.segments[0].translations={en:{text:'My translation'}};d.segments[0].original_text='识别原稿';d.project_note='私人记录';
 const input=R.processingSnapshot(d);assert.equal(input.media_duration,10);assert.equal(input.segments[0].original_text,'识别原稿');assert.ok(!JSON.stringify(input).includes('私人记录'));assert.ok(!JSON.stringify(input).includes('My translation'));assert.ok(!JSON.stringify(input).includes('我的笔记'));
});
test('merge preserves notes, translations, chapters and opaque records edited while models were running',()=>{
 const before=doc(),input=R.processingSnapshot(before),result=structuredClone(input);result.segments[0].text+='。';result.segments[0].original_text=input.segments[0].text;result.segments[0].speaker='说话人 1';result.provenance.speaker_method='recording-acoustic-v1';
 const current=structuredClone(before);current.title='改过的标题';current.notes.one='处理中写下的笔记';current.segments[0].translations={en:{text:'Saved translation'}};current.reading_chapters=[{cue_id:'one',title:'开场'}];current.opaque={keep:true};
 const merged=R.mergeProcessingResult(current,input,result);assert.equal(merged.notes.one,current.notes.one);assert.equal(merged.title,current.title);assert.deepEqual(merged.opaque,current.opaque);assert.deepEqual(merged.reading_chapters,current.reading_chapters);assert.deepEqual(merged.segments[0].translations,current.segments[0].translations);assert.equal(before.segments[0].speaker,null);
});
test('manual source edits, reordered timing, changed names and model rewrites cannot be overwritten',()=>{
 for(const mutate of [d=>d.segments[0].text+='修改',d=>d.segments[0].speaker='主持人',d=>d.segments.reverse(),d=>d.segments[0].start=.5]){const d=doc(),input=R.processingSnapshot(d);mutate(d);assert.throws(()=>R.mergeProcessingResult(d,input,input),/已变化/);}
 for(const mutate of [d=>d.segments.pop(),d=>d.segments[0].text='我们改聊投资吧',d=>d.segments[0].end=5]){const d=doc(),input=R.processingSnapshot(d),result=structuredClone(input);mutate(result);assert.throws(()=>R.mergeProcessingResult(d,input,result));}
 const d=doc();d.segments[0].speaker='人工标注';const input=R.processingSnapshot(d),result=structuredClone(input);result.segments[0].speaker='说话人 1';assert.throws(()=>R.mergeProcessingResult(d,input,result),/已有说话人/);
});
