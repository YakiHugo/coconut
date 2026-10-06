const test = require('node:test');
const assert = require('node:assert/strict');
const {parse, validate, source} = require('../reader/core.js');

test('exported JSON restores segment notes and excludes unknown segments', () => {
  const document = validate({title: 'Example', segments: [{id: 'a', start: 0, end: 2, text: 'Hello'}], notes: {a: 'Keep this thought', unknown: 'Ignore'}});
  const restored = parse(JSON.stringify(document), 'backup.json');
  assert.equal(restored.notes.a, 'Keep this thought');
  assert.equal(restored.notes.unknown, undefined);
});
test('untrusted note properties cannot change the object prototype', () => {
  const document = parse('{"segments":[{"id":"__proto__","start":0,"end":1,"text":"test"}],"notes":{"__proto__":"A valid note"}}', 'backup.json');
  assert.equal(Object.getPrototypeOf(document.notes), null);
  assert.equal(document.notes.__proto__, 'A valid note');
});
test('SRT timestamps preserve decimal seconds', () => {
  const document = parse('1\n00:00:01,250 --> 00:00:02,500\nHello', 'example.srt');
  assert.equal(document.segments[0].start, 1.25);
  assert.equal(document.segments[0].end, 2.5);
});
test('source links reject unsafe schemes and lookalike hosts', () => {
  assert.equal(source('javascript:alert(1)', 0), '');
  assert.equal(source('https://youtube.com.evil.example/a', 0), '');
  assert.equal(source('https://www.bilibili.com/video/example?p=2', 30), 'https://www.bilibili.com/video/example?p=2&t=30');
});
test('invalid segment chronology is rejected', () => {
  assert.throws(() => validate({segments: [{start: 2, end: 1, text: 'Invalid'}]}));
});
test('subtitle imports preserve code-like text and decode entities safely', () => {
  const doc = parse('1\n00:00:01,000 --> 00:00:02,000\n<b>React</b> &lt;T&gt; &amp; &#x4e2d; <T>', 'example.srt');
  assert.equal(doc.segments[0].text, 'React <T> & 中 <T>');
});
test('subtitle timestamps reject non-clock and signed components', () => {
  for (const time of ['00:99.000','01:-01:01.000','0x10:00.000']) {
    assert.throws(() => parse(`1\n${time} --> 02:00:00,000\nInvalid`, 'bad.srt'));
  }
});

test('uploaded-media backup preserves only a safe same-origin job association', () => {
  const {media} = require('../reader/core.js');
  const association = {job_id: '4a53b398274c4e5cb4f96c307110aabc', kind: 'audio'};
  const doc = validate({segments: [{start: 0, end: 1, text: 'Hello'}],
    source_media: {...association, url: 'https://evil.example/audio', path: '/private/audio.wav'}});
  assert.deepEqual(doc.source_media, association);
  assert.deepEqual(parse(JSON.stringify(doc), 'backup.json').source_media, association);
  assert.equal(media(doc.source_media), '/api/jobs/' + association.job_id + '/media');
  for (const value of [null, 'https://evil.example/media', [],
    {job_id: '../private', kind: 'audio'}, {job_id: association.job_id + '/other', kind: 'video'},
    {job_id: association.job_id.toUpperCase(), kind: 'audio'}, {job_id: association.job_id, kind: 'text'},
    {job_id: association.job_id}, {job_id: 123, kind: 'audio'}]) {
    assert.equal(media(value), '');
    assert.equal(validate({segments: doc.segments, source_media: value}).source_media, undefined);
  }
  assert.equal(parse('1\n00:00:00,000 --> 00:00:01,000\nHi', 'test.srt').source_media, undefined);
});

test('reading bookmarks accept only segment ids and survive JSON round trips',()=>{
 const input={title:'Resume',segments:[{id:'safe',start:0,end:1,text:'Read me'}],readingPosition:'safe'};
 assert.equal(parse(JSON.stringify(input),'resume.json').readingPosition,'safe');
 assert.equal(validate({...input,readingPosition:'missing'}).readingPosition,undefined);
 assert.equal(validate({...input,readingPosition:{id:'safe'}}).readingPosition,undefined);
});

test('X post source links seek without accepting arbitrary URLs or profiles',()=>{
 assert.equal(source('https://x.com/example/status/123?s=20&t=9#old',251.9),'https://x.com/example/status/123?s=20&t=251');
 assert.equal(source('https://twitter.com/i/status/123',0),'https://twitter.com/i/status/123?t=0');
 for(const url of ['https://x.com/example','https://x.com/search?q=video','https://x.com/example/status/nope',
   'https://x.com/example/status/123/video/1','http://x.com/example/status/123','https://x.com:8443/example/status/123',
   'https://user@x.com/example/status/123','https://x.com.evil.test/example/status/123'])assert.equal(source(url,1),'');
});
test('X word timing markup is stripped while text, generics and timestamp precision survive',()=>{
 const doc=parse('WEBVTT\n\n00:00:01.220 --> 00:00:03.400\n<X-word-ms ms=100,200 index=1 character_ranges=0-2,3-6>Use List<T> &amp; keep it</X-word-ms>\n','native.vtt');
 assert.equal(doc.segments[0].text,'Use List<T> & keep it');assert.equal(doc.segments[0].start,1.22);assert.equal(doc.segments[0].end,3.4);
});
test('platform media evidence survives backup without copying download URLs',()=>{
 const input={segments:[{start:0,end:1,text:'Fixture'}],provenance:{kind:'platform_subtitles',media_id:'123',media_duration:3251.648,url:'https://private.example'}};
 const output=parse(JSON.stringify(validate(input)),'backup.json');
 assert.deepEqual(output.provenance,{kind:'platform_subtitles',media_id:'123',media_duration:3251.648});
 for(const duration of [-1,0,Infinity,'3251',21601])assert.equal(validate({...input,provenance:{media_duration:duration}}).provenance.media_duration,undefined);
});

test('bilingual backup keeps source alignment and refuses injected translation fields',()=>{
 const doc=validate({language:'en',translation_view:'zh',segments:[{id:'a',start:1.2,end:3.4,text:'Source',translations:{zh:{text:'译文',source_text:'Source',source_language:'en',provider:'local_argos_test',url:'https://evil.example'},bad:{text:'bad'}}}],ai_answers:[{question:'Q',answer:'A',citations:['a','missing'],provider:'claude_subscription'}]});
 const restored=parse(JSON.stringify(doc),'backup.json');
 assert.equal(restored.language,'en');assert.equal(restored.translation_view,'zh');assert.equal(restored.segments[0].translations.zh.text,'译文');assert.equal(restored.segments[0].translations.zh.url,undefined);assert.equal(restored.segments[0].translations.bad,undefined);assert.deepEqual(restored.ai_answers[0].citations,['a']);assert.equal(restored.segments[0].start,1.2);
});

test('subscription windows preserve consented adjacency, character budgets and completed context',()=>{
 const C=require('../reader/core.js');
 const doc=validate({segments:Array.from({length:33},(_,i)=>({id:'s'+i,start:i,end:i+1,text:'Sentence '+i}))});
 const selected=doc.segments.map(s=>s.id);let plan=C.subscriptionPlan(doc,selected,'en','zh','chatgpt_subscription_translation');
 assert.equal(plan.windows.length,2);assert.deepEqual(plan.windows[1].segments.map(s=>s.id),['s32']);assert.deepEqual(plan.windows[1].context.map(s=>s.id),['s30','s31']);
 plan=C.subscriptionPlan(doc,['s0','s2'],'en','zh','chatgpt_subscription_translation');assert.equal(plan.windows.length,2);assert.deepEqual(plan.windows.map(w=>w.snapshot.map(s=>s.position)),[[0],[2]]);
 const long=validate({segments:Array.from({length:25},(_,i)=>({id:'l'+i,start:i,end:i+1,text:'x'.repeat(4000)}))});
 plan=C.subscriptionPlan(long,long.segments.map(s=>s.id),'en','zh','chatgpt_subscription_translation');assert.equal(plan.windows.length,5);
 assert.ok(plan.windows.every(w=>w.segments.length<=32&&w.snapshot.length<=36&&w.snapshot.reduce((n,s)=>n+s.text.length,0)<=40000));
 assert.equal(new Set(plan.windows.flatMap(w=>w.segments.map(s=>s.id))).size,25);
});

test('subscription context provenance survives backup and edits invalidate dependents without duplicating source',()=>{
 const C=require('../reader/core.js'),contextId='11111111-1111-4111-8111-111111111111';
 const snapshot=[{id:'a',text:'Do not send',position:0,start:0,end:1},{id:'b',text:'until approved',position:1,start:1,end:2}];
 const doc=validate({translation_contexts:{[contextId]:snapshot},segments:snapshot.map(s=>({...s,translations:{zh:{text:'译文',source_text:s.text,source_language:'en',provider:'chatgpt_subscription_translation',context_id:contextId}}}))});
 const restored=parse(JSON.stringify(doc),'backup.json');assert.equal(Object.keys(restored.translation_contexts).length,1);assert.ok(C.translationCurrent(restored.segments[1],restored,restored.segments[1].translations.zh));
 restored.segments[0].text='Send now';assert.equal(C.translationCurrent(restored.segments[1],restored,restored.segments[1].translations.zh),false);assert.equal(C.matchesSegment(restored.segments[1],restored,'译文'),false);
 const missing=validate({...doc,translation_contexts:{}});assert.equal(C.translationCurrent(missing.segments[1],missing,missing.segments[1].translations.zh),false);
});

test('saved excerpts validate strictly and roundtrip independently from notes and reading position',()=>{
 const C=require('../reader/core.js');
 const doc=C.validate({readingPosition:'b',notes:{b:'Only a note'},segments:[
  {id:'a',start:0,end:1,text:'Saved without a note',saved_excerpt:true},
  {id:'b',start:1,end:2,text:'Note without an excerpt',saved_excerpt:'true'},
  {id:'c',start:2,end:3,text:'No annotations',saved_excerpt:{enabled:true}},
 ]});
 const restored=C.parse(JSON.stringify(doc),'backup.json');
 assert.equal(restored.segments[0].saved_excerpt,true);assert.equal(restored.segments[1].saved_excerpt,undefined);assert.equal(restored.segments[2].saved_excerpt,undefined);
 assert.equal(restored.readingPosition,'b');assert.equal(restored.notes.a,undefined);
 assert.deepEqual(restored.segments.filter(s=>C.matchesSegment(s,restored,'',true)).map(s=>s.id),['b']);
 assert.deepEqual(restored.segments.filter(s=>C.matchesSegment(s,restored,'',false,true)).map(s=>s.id),['a']);
 assert.deepEqual(C.notebookSegments(restored).map(s=>s.id),['a','b']);
 assert.equal(C.parse('1\n00:00:00,000 --> 00:00:01,000\nHello','legacy.srt').segments[0].saved_excerpt,undefined);
});

test('notebook Markdown includes kept cues once with original source, corrections and notes',()=>{
 const C=require('../reader/core.js');
 const doc=C.validate({title:'A useful reading',source_url:'https://youtu.be/demo',translation_view:'zh',notes:{both:'My thought\nSecond line',note:'Only a note',empty:'  '},segments:[
  {id:'both',start:61.25,end:65,text:'Corrected quote',original_text:'Raw quote',saved_excerpt:true,speaker:'Speaker 1',translations:{zh:{text:'有效译文',source_text:'Corrected quote',provider:'local_test'}}},
  {id:'note',start:90,end:95,text:'Not excerpted'},
  {id:'empty',start:100,end:110,text:'Not included'},
  {id:'excerpt',start:120,end:125,text:'Saved only',saved_excerpt:true},
 ]});
 const output=C.notebookMarkdown(doc);
 assert.equal((output.match(/^## /gm)||[]).length,3);
 assert.match(output,/\[01:01–01:05\]\(https:\/\/youtu.be\/demo\?t=61\)/);
 assert.match(output,/原文（已修正）：\n\n> Corrected quote/);
 assert.match(output,/修正前文字稿：\n\n> Raw quote/);
 assert.match(output,/我的笔记：\n\n> My thought\n> Second line/);
 assert.match(output,/有效译文/);assert.match(output,/说话人标签：Speaker 1/);
 assert.doesNotMatch(output,/Not included/);assert.match(output,/Saved only/);
 assert.match(output,/完整恢复.*JSON/);
});

test('notebook Markdown treats hostile content as text and never exports unsafe or local media links',()=>{
 const C=require('../reader/core.js');
 const doc=C.validate({title:'Title\n# Injected',source_url:'javascript:alert(1)',source_media:{kind:'audio',job_id:'a'.repeat(32)},notes:{a:'![tracker](https://evil.test/image)\n<script>alert(1)</script>\n~~strike~~ $math$'},segments:[{id:'a',start:0,end:1,text:'<img src="https://evil.test/pixel">\n# Heading\n[open](javascript:alert(1))',saved_excerpt:true}]});
 const output=C.notebookMarkdown(doc);
 assert.match(output,/^# Title \\# Injected\n/);
 assert.doesNotMatch(output,/<(?:img|script)|\n# Heading|!\[tracker\]|\[open\]\(javascript|\/api\/jobs|aaaaaaaa/);
 assert.ok(output.includes('\\~\\~strike\\~\\~ \\$math\\$'));assert.match(output,/&lt;img/);assert.match(output,/未关联可用的原站链接/);
 const linked=C.notebookMarkdown({...doc,source_url:'https://youtu.be/demo?label=(value)'});
 assert.match(linked,/label=%28value%29/);
});

test('notebook excludes stale translations without dropping saved source or notes',()=>{
 const C=require('../reader/core.js');
 const doc=C.validate({translation_view:'zh',notes:{a:'Verify this'},segments:[{id:'a',start:0,end:1,text:'Updated',saved_excerpt:true,translations:{zh:{text:'Obsolete output',source_text:'Old',provider:'local_test'}}}]});
 const output=C.notebookMarkdown(doc);
 assert.doesNotMatch(output,/Obsolete output/);assert.match(output,/译文已过期/);assert.match(output,/Updated/);assert.match(output,/Verify this/);
});

test('answer freshness preserves exact ordered input through JSON and removed cue imports',()=>{
 const {answerFreshness}=require('../reader/core.js');
 const input=[{id:'a',text:'A'},{id:'b',text:'B'}];
 const original={segments:[...input,{id:'c',text:'C'}].map((s,i)=>({...s,start:i,end:i+1})),ai_answers:[{question:'Q',answer:'A',citations:['a'],input_snapshot:{version:1,segments:input}}]};
 const doc=parse(JSON.stringify(validate(original)),'backup.json');
 assert.equal(answerFreshness(doc.ai_answers[0],doc),'current');
 doc.segments[2].text='Unsent change';doc.segments[0].translations.zh={text:'New translation'};doc.notes.a='New note';
 assert.equal(answerFreshness(doc.ai_answers[0],doc),'current');
 doc.segments[1].text='Changed same ID';assert.equal(answerFreshness(doc.ai_answers[0],doc),'stale');
 doc.segments.splice(1,1);const removed=parse(JSON.stringify(doc),'backup.json');
 assert.equal(removed.ai_answers[0].input_snapshot.segments.length,2);assert.equal(answerFreshness(removed.ai_answers[0],removed),'stale');
 const reordered=validate({...original,segments:[{id:'b',text:'B',start:0,end:1},{id:'a',text:'A',start:1,end:2}]});
 assert.equal(answerFreshness(reordered.ai_answers[0],reordered),'stale');
});

test('legacy or malformed answer evidence stays unknown rather than silently becoming current',()=>{
 const {answerFreshness}=require('../reader/core.js');
 for(const input_snapshot of [undefined,{version:2,segments:[{id:'a',text:'A'}]},{version:1,segments:[]},{version:1,segments:[{id:'a',text:'A'},{id:'a',text:'A'}]},{version:1,segments:[{id:'a',text:42}]},{version:1,segments:[{id:'a',text:'x'.repeat(500001)}]}]){
  const doc=validate({segments:[{id:'a',text:'A',start:0,end:1}],ai_answers:[{question:'Q',answer:'Saved',citations:['a'],source_snapshot:{a:'A'},input_snapshot}]});
  assert.equal(doc.ai_answers[0].answer,'Saved');assert.equal(answerFreshness(doc.ai_answers[0],doc),'unknown');
 }
});

test('library recovery validates atomically and preserves conflicting versions without duplication',()=>{
 const C=require('../reader/core.js');
 const doc={...C.validate({title:'Original',segments:[{id:'a',text:'Corrected',original_text:'Raw',start:0,end:2,saved_excerpt:true}],notes:{a:'Note'},readingPosition:'a'}),key:'book'};
 const current={documents:[doc],active:'book'};
 const backup={format:'coconut-library',version:1,documents:[{...doc,title:'Changed'}],active:'book'};
 const merged=C.mergeLibraryBackup(current,backup);
 assert.equal(merged.documents.length,2);assert.equal(merged.documents[0],doc);assert.equal(merged.active,'book-restored-1');
 assert.equal(merged.documents[1].notes.a,'Note');assert.equal(merged.documents[1].readingPosition,'a');
 assert.equal(C.mergeLibraryBackup(merged,backup).documents.length,2);
 assert.equal(C.mergeLibraryBackup({documents:[],active:null},backup).documents[0].segments[0].original_text,'Raw');
 for(const invalid of [{...backup,version:2},{...backup,documents:[doc,doc]},{...backup,documents:[doc,{key:'bad',segments:[]}]}])assert.throws(()=>C.mergeLibraryBackup(current,invalid));
 assert.equal(current.documents.length,1);assert.equal(current.active,'book');
});

test('recovered maximum-length conflicting library keys remain valid on re-export',()=>{
 const C=require('../reader/core.js'), key='k'.repeat(200);
 const doc={...C.validate({title:'A',segments:[{start:0,end:1,text:'A'}]}),key};
 const backup={format:'coconut-library',version:1,documents:[{...doc,title:'B'}],active:key};
 const merged=C.mergeLibraryBackup({documents:[doc],active:key},backup);
 assert.equal(merged.documents[1].key.length,200);
 assert.equal(C.mergeLibraryBackup({documents:[],active:null},{...backup,...merged}).documents.length,2);
});

test('subtitle exports preserve millisecond timing and include only current bilingual content',()=>{
 const C=require('../reader/core.js');const doc=C.validate({translation_view:'zh',segments:[
 {id:'a',start:3599.9996,end:3601.002,text:'Corrected <script> & text\n\nnext',original_text:'Raw',translations:{zh:{text:'有效',source_text:'Corrected <script> & text\n\nnext',provider:'local'}}},
 {id:'b',start:3601.5,end:3602,text:'B',translations:{zh:{text:'过期',source_text:'Old',provider:'local'}}}],notes:{a:'Private note'}});
 const srt=C.subtitleExport(doc,'srt',true);assert.match(srt.text,/01:00:00,000 --> 01:00:01,002/);assert.equal(srt.translated,1);assert.match(srt.text,/有效/);assert.doesNotMatch(srt.text,/过期|Raw|Private note|<script>/);assert.match(srt.text,/&lt;script&gt; &amp; text\nnext/);
 const vtt=C.subtitleExport(doc,'vtt');assert.match(vtt.text,/^WEBVTT\n\n1\n01:00:00.000/);assert.doesNotMatch(vtt.text,/有效/);assert.throws(()=>C.subtitleExport(doc,'exe'));
 const restored=C.parse(srt.text,'copy.srt');assert.equal(restored.segments[1].start,3601.5);assert.equal(restored.segments[0].text,'Corrected <script> & text\nnext\n有效');
});

test('subtitle export keeps tiny cues visible and removes NUL separators before line filtering',()=>{
 const C=require('../reader/core.js');const doc=C.validate({segments:[{start:0,end:0.0004,text:'A\n\0\nB'},{start:1,end:1,text:'Still visible'}]});
 for(const format of ['srt','vtt']){
  const output=C.subtitleExport(doc,format).text;const restored=C.parse(output,'copy.'+format);
  assert.equal(restored.segments.length,2);assert.equal(restored.segments[0].end,.001);assert.equal(restored.segments[0].text,'A\nB');assert.equal(restored.segments[1].end,1.001);
 }
});

test('reading time accepts clock input and chooses containing or next cue without fabricating coverage',()=>{
 const C=require('../reader/core.js');for(const [input,value] of [['90',90],['01:02.125',62.125],['1:02:03',3723],['90:00',5400]])assert.equal(C.parseReadingTime(input),value);
 for(const input of ['', '-1','1:60','1:60:00','1e3','1:2:3:4','1:02.1234'])assert.equal(C.parseReadingTime(input),null);
 const doc=C.validate({segments:[{id:'a',start:3,end:10,text:'A'},{id:'b',start:5,end:7,text:'B'},{id:'c',start:12,end:14,text:'C'}]});
 assert.equal(C.segmentAtTime(doc,0).id,'a');assert.equal(C.segmentAtTime(doc,6).id,'b');assert.equal(C.segmentAtTime(doc,9).id,'a');assert.equal(C.segmentAtTime(doc,11).id,'c');assert.equal(C.segmentAtTime(doc,14).id,'c');assert.equal(C.segmentAtTime(doc,15),null);
});

test('AI reading report includes historical full input, freshness, safe citations and legacy boundaries',()=>{
 const C=require('../reader/core.js');const doc=C.validate({title:'Report\n# fake',source_url:'https://youtu.be/demo?label=(x)',segments:[{id:'a',start:1,end:2,text:'Changed'},{id:'b',start:3,end:4,text:'Uncited'}],ai_answers:[
 {question:'![track](https://evil.test)',answer:'<script>bad</script>',provider:'test',citations:['a'],input_snapshot:{version:1,segments:[{id:'a',text:'Historical'},{id:'b',text:'Uncited'}]}},
 {question:'Old Q',answer:'Old A',citations:[],provider:'legacy'}]});
 const output=C.aiReadingMarkdown(doc);assert.match(output,/Historical/);assert.match(output,/Uncited/);assert.match(output,/依据可能过期/);assert.match(output,/缺少完整发送原文/);assert.match(output,/不能用当前稿替代历史依据/);assert.doesNotMatch(output,/<script>|!\[track\]|\n# fake|> Changed/);assert.match(output,/label=%28x%29/);assert.equal((output.match(/^## 回答 /gm)||[]).length,2);
 const unsafe=C.aiReadingMarkdown({...doc,source_url:'javascript:alert(1)'});assert.doesNotMatch(unsafe,/javascript:/);
});

test('only explicit whole-document summaries are current and survive backups',()=>{
 const Coconut=require('../reader/core.js');
 const doc=Coconut.validate({title:'Podcast',segments:[{id:'one',start:0,end:10,text:'First'},{id:'two',start:10,end:20,text:'Second'}],ai_answers:[{question:'Q',answer:'Not a summary',citations:['one']},{purpose:'summary',question:'Summary',answer:'A grounded summary',provider:'codex',citations:['one'],input_snapshot:{version:1,segments:[{id:'one',text:'First'},{id:'two',text:'Second'}]}}]});
 const answer=Coconut.latestSummary(doc);assert.equal(answer.answer,'A grounded summary');assert.equal(Coconut.summaryFreshness(answer,doc),'current');
 assert.equal(Coconut.latestSummary({...doc,ai_answers:[doc.ai_answers[0]]}),null);
 assert.equal(Coconut.summaryFreshness(answer,{...doc,segments:[...doc.segments,{id:'three',start:20,end:30,text:'Added'}]}),'stale');
 assert.equal(Coconut.summaryFreshness({...answer,input_snapshot:undefined},doc),'unknown');
 assert.equal(Coconut.summaryFreshness({...answer,input_snapshot:{version:1,segments:[{id:'one',text:'First'}]}},doc),'stale');
 assert.equal(Coconut.latestSummary(Coconut.validate(JSON.parse(JSON.stringify(doc)))).purpose,'summary');
 assert.match(Coconut.summaryMarkdown(doc),/播客摘要/);assert.match(Coconut.summaryMarkdown(doc),/Second/);
});

test('later questions never evict the latest saved summary from the bounded history',()=>{
 const {retainAnswers,latestSummary}=require('../reader/core.js');
 const summary={purpose:'summary',question:'Summary',answer:'Keep this work',citations:[]};
 const answers=[summary,...Array.from({length:25},(_,i)=>({purpose:'question',question:String(i),answer:'Later question',citations:[]}))];
 const retained=retainAnswers(answers);assert.equal(retained.length,20);assert.equal(latestSummary({ai_answers:retained}),summary);assert.equal(retained.at(-1).question,'24');
 const doc=validate({segments:[{id:'a',start:0,end:1,text:'Source'}],ai_answers:answers});assert.equal(latestSummary(doc).answer,'Keep this work');
});

test('semantic-window planning prefers sentence and speaker boundaries without crossing selection gaps',()=>{
 const C=require('../reader/core.js');
 const doc=C.validate({language:'en',segments:Array.from({length:40},(_,i)=>({id:'s'+i,start:i,end:i+1,text:i===26?'Sentence ends.':'unfinished fragment',speaker:'A'}))});
 const plan=C.subscriptionPlan(doc,doc.segments.map(s=>s.id),'en','zh','chatgpt_subscription_translation');
 assert.equal(plan.windows[0].segments.length,27);
 assert.equal(plan.windows[1].context[0].id,'s25');
 assert.ok(plan.windows.every(w=>w.snapshot.every(c=>c.speaker==='A')));
 const sparse=C.subscriptionPlan(doc,['s0','s2'],'en','zh','chatgpt_subscription_translation');
 assert.deepEqual(sparse.windows.map(w=>w.snapshot.map(c=>c.id)),[['s0'],['s2']]);
});

test('glossary, speaker, memory revisions and quality warnings roundtrip conservatively',()=>{
 const C=require('../reader/core.js'),id='11111111-1111-4111-8111-111111111111';
 const snapshot=[{id:'a',text:'Coconut is offline,',position:0,start:0,end:4,speaker:'A',memory_text:'Coconut 离线时',memory_language:'zh'},
  {id:'b',text:'it must not send 12 requests.',position:1,start:4,end:8,speaker:'A'}];
 const terms=[{source:'Coconut',target:'Coconut'}];
 const input={language:'en',translation_glossary:{zh:terms},translation_contexts:{[id]:snapshot},segments:snapshot.map((c,i)=>({...c,translations:{zh:i===0?{text:'Coconut 离线时',source_text:c.text,source_language:'en',provider:'local'}:{text:'不得发送12次请求',source_text:c.text,source_language:'en',target_language:'zh',document_language:'en',provider:'chatgpt_subscription_translation',context_id:id,context_version:2,glossary_snapshot:terms,input_revision:'a'.repeat(64),quality_warnings:['numbers_changed','evil','numbers_changed']}}}))};
 const doc=C.parse(JSON.stringify(C.validate(input)),'saved.json');
 let item=doc.segments[1].translations.zh;
 assert.deepEqual(item.quality_warnings,['numbers_changed']);assert.equal(item.input_revision,'a'.repeat(64));
 assert.ok(C.translationCurrent(doc.segments[1],doc,item));
 doc.segments[0].speaker='B';assert.equal(C.translationCurrent(doc.segments[1],doc,item),false);doc.segments[0].speaker='A';
 doc.segments[0].translations.zh.text='新的建议';assert.equal(C.translationCurrent(doc.segments[1],doc,item),false);doc.segments[0].translations.zh.text='Coconut 离线时';
 doc.translation_glossary.zh[0].target='椰子';assert.equal(C.translationCurrent(doc.segments[1],doc,item),false);doc.translation_glossary.zh[0].target='Coconut';
 doc.language='fr';assert.equal(C.translationCurrent(doc.segments[1],doc,item),false);doc.language='en';
 delete item.glossary_snapshot;assert.equal(C.translationCurrent(doc.segments[1],doc,item),false);
});

test('context memory only reuses current warning-free translations inside consented cues',()=>{
 const C=require('../reader/core.js'),provider='chatgpt_subscription_translation',id='11111111-1111-4111-8111-111111111111';
 const cues=[{id:'a',text:'Coconut works.',position:0,start:0,end:2,speaker:null},{id:'b',text:'Next fragment',position:1,start:2,end:4,speaker:null}];
 const doc=C.validate({language:'en',translation_glossary:{zh:[{source:'Coconut',target:'Coconut'},{source:'AI',target:'人工智能'},{source:'other',target:'别的'}]},translation_contexts:{[id]:[cues[0]]},segments:cues.map((c,i)=>({...c,translations:i===0?{zh:{text:'Coconut 能运行。',source_text:c.text,source_language:'en',provider,context_id:id,context_version:2,glossary_snapshot:[{source:'Coconut',target:'Coconut'}]}}:{}}))});
 const plan=C.subscriptionPlan(doc,['a','b'],'en','zh',provider);
 assert.deepEqual(plan.windows[0].segments.map(c=>c.id),['b']);
 assert.deepEqual(plan.windows[0].glossary,[{source:'Coconut',target:'Coconut'}]);
 assert.deepEqual(plan.windows[0].memory,[{id:'a',source_text:'Coconut works.',text:'Coconut 能运行。'}]);
 assert.equal(plan.windows[0].snapshot[0].memory_text,'Coconut 能运行。');
 doc.segments[0].translations.zh.quality_warnings=['glossary_missing'];
 assert.equal(C.subscriptionPlan(doc,['a','b'],'en','zh',provider).windows[0].memory.length,0);
 assert.deepEqual(C.subscriptionPlan(doc,['b'],'en','zh',provider).windows[0].glossary,[]);
});

test('glossary validation rejects duplicate or malformed terms and uses literal bounded matches',()=>{
 const C=require('../reader/core.js');
 for(const value of [{},[{source:'AI',target:'人工智能'},{source:'ai',target:'爱'}],[{source:'x',target:'bad\nvalue'}]])assert.throws(()=>C.cleanGlossary(value,true));
 assert.deepEqual(C.relevantGlossary({translation_glossary:{zh:[{source:'AI',target:'人工智能'},{source:'C++',target:'C++'}]}},'zh',[{text:'A chair and C++'}]),[{source:'C++',target:'C++'}]);
});

test('memory freshness follows transitive source dependencies and terminates on cycles',()=>{
 const C=require('../reader/core.js'),one='11111111-1111-4111-8111-111111111111',two='22222222-2222-4222-8222-222222222222',provider='chatgpt_subscription_translation';
 const cues=['x','a','b'].map((id,i)=>({id,text:'Source '+id,position:i,start:i,end:i+1,speaker:null}));
 const doc=C.validate({language:'en',translation_contexts:{[one]:cues.slice(0,2),[two]:[{...cues[1],memory_text:'译文 a',memory_language:'zh'},cues[2]]},segments:cues.map((cue,i)=>({...cue,translations:i?{zh:{text:'译文 '+cue.id,source_text:cue.text,source_language:'en',provider,context_id:i===1?one:two,context_version:2,glossary_snapshot:[]}}:{}}))});
 assert.ok(C.translationCurrent(doc.segments[2],doc,doc.segments[2].translations.zh));
 doc.segments[0].text='Changed source outside b snapshot';
 assert.equal(C.translationCurrent(doc.segments[2],doc,doc.segments[2].translations.zh),false);
 assert.equal(C.subscriptionPlan(doc,['b'],'en','zh',provider).total,1);
 doc.segments[0].text=cues[0].text;
 doc.translation_contexts[one]=[{...cues[1]}, {...cues[2],memory_text:'译文 b',memory_language:'zh'}];
 assert.equal(C.translationCurrent(doc.segments[2],doc,doc.segments[2].translations.zh),true,'shared cycle is bounded and all actual evidence is still checked');
 doc.segments[1].text='Changed';assert.equal(C.translationCurrent(doc.segments[2],doc,doc.segments[2].translations.zh),false);
});

test('manual translation source remains independent of document language while later metadata changes invalidate',()=>{
 const C=require('../reader/core.js');
 const doc=C.validate({language:'en',segments:[{id:'a',start:0,end:1,text:'Bonjour',translations:{zh:{text:'你好',source_text:'Bonjour',source_language:'fr',document_language:'en',provider:'local'}}}]});
 assert.ok(C.translationCurrent(doc.segments[0],doc,doc.segments[0].translations.zh));
 doc.language='fr';assert.equal(C.translationCurrent(doc.segments[0],doc,doc.segments[0].translations.zh),false);
});
