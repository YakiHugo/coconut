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
