import test from 'node:test';
import assert from 'node:assert/strict';
import C from '../reader/core.js';
import {subtitleFixtures, expectedCues, cueSnapshot} from './helpers/subtitle-import-fixtures.mjs';
import {incompleteSubtitleFixtures} from './helpers/incomplete-subtitle-fixtures.mjs';

const first = '17\n00:00:00,125 --> 00:00:01,250\nFirst line\nSecond line';
const last = '800\n00:00:03,000 --> 00:00:04,500\nLast';

for(const fixture of incompleteSubtitleFixtures)test(fixture.format+' incomplete timing and a truncated final block report original lines without fabricating cues',()=>{
 const result=C.parseWithDiagnostics(fixture.text,fixture.name);
 assert.deepEqual(result.document.segments.map(cue=>cue.text),fixture.cues);
 assert.deepEqual(result.diagnostics.map(({category,startLine,endLine,cueId})=>({category,startLine,endLine,cueId})),fixture.ranges.map(([startLine,endLine],index)=>({category:'malformed_timing',startLine,endLine,cueId:index?'4':'2'})));
 assert.ok(result.diagnostics[0].preview.includes('Omitted <img src=x> detail'));
 assert.equal(result.document.segments[1].start,3);
 assert.deepEqual(C.parse(fixture.text,fixture.name),result.document);
 assert.equal(Object.hasOwn(result.document,'diagnostics'),false);
});

test('incomplete timing is recognized only at subtitle lexical positions, never from clock prose',()=>{
 const clocks=['00:00:01,500','00:01.500'];
 for(const format of ['srt','vtt'])for(const clock of clocks){
  for(const timing of [clock,clock+' →',clock+' - 00:00:02',clock+'   00:00:02,']){
   for(const id of ['',format==='srt'?'42\n':'named-cue\n']){
    const input=[first,id+timing+'\nLost words',last].join('\n\n');
    const result=C.parseWithDiagnostics(input,'broken.'+format);
    assert.equal(result.diagnostics.length,1,JSON.stringify({format,id,timing}));
    assert.deepEqual(result.document.segments.map(cue=>cue.text),['First line\nSecond line','Last']);
   }
  }
  const prose=['12:00 - 13:00\nA daily schedule',clock+' is an example timestamp.',
   'It happens at '+clock,'Heading\nExplanation\n'+clock,clock+' '.repeat(50000)+'is a literal clock','999'];
  if(format==='srt')prose.push('An explanation\n'+clock+'\nThis is not a numbered SRT cue');
  if(format==='vtt')prose.push('NOTE explanation\n'+clock+'\nNot a cue','STYLE\n'+clock,'REGION\n'+clock);
  assert.deepEqual(C.parseWithDiagnostics([first,...prose,last].join('\n\n'),'prose.'+format).diagnostics,[]);
 }
});

test('partial SRT reports the skipped original block without changing surviving cues or parse return shape', () => {
 const skipped = '42\n00:00:01,500 -> 00:00:02,750\nCritical detail\nStill part of this cue';
 const input = [first, skipped, last].join('\n\n');
 const result = C.parseWithDiagnostics(input, 'Partial.SRT');
 assert.deepEqual(result.diagnostics, [{category:'malformed_timing', startLine:6, endLine:9, cueId:'42', preview:skipped}]);
 assert.deepEqual(cueSnapshot(result.document), [
  {id:'segment-1', start:0.125, end:1.25, text:'First line\nSecond line'},
  {id:'segment-2', start:3, end:4.5, text:'Last'},
 ]);
 assert.deepEqual(C.parse(input, 'Partial.SRT'), result.document);
 assert.equal(result.document.title, 'Partial');
 assert.equal(Object.hasOwn(result.document, 'diagnostics'), false);
 assert.equal(JSON.stringify(result.document).includes('Critical detail'), false);
});

test('line ranges retain BOM, CRLF, leading blank lines and whitespace-only separators', () => {
 const lines = [
  '', '', '91', '00:00:00,000 --> 00:00:01,000', 'First', '', ' \t', '',
  'missing-label', '00:00:01,000 -> 00:00:02,000', 'Lost', 'Second lost line', '', '',
  '400', '00:00:02,000 --> 00:00:03,000', 'Last', '',
 ];
 const result = C.parseWithDiagnostics('\uFEFF'+lines.join('\r\n'), 'original.srt');
 assert.deepEqual(result.diagnostics, [{
  category:'malformed_timing', startLine:9, endLine:12, cueId:'missing-label',
  preview:'missing-label\n00:00:01,000 -> 00:00:02,000\nLost\nSecond lost line',
 }]);
 assert.deepEqual(result.document.segments.map(s=>s.text), ['First', 'Last']);
 const loneCR = C.parseWithDiagnostics([first, '00:00:01,500 => 00:00:02,000\nLost', last].join('\n\n').replace(/\n/g, '\r'), 'legacy.srt');
 assert.equal(loneCR.diagnostics[0].startLine, 6);
 assert.equal(loneCR.diagnostics[0].endLine, 7);
});

test('malformed separators are recognized with and without arbitrary cue identifiers', () => {
 const separators = [' -> ', ' => ', ' -- > ', ' → ', ' - ', '   ', '->'];
 for (const separator of separators) {
  for (const id of ['', 'custom-label\n', '90210\n']) {
   const skipped = id+'00:00:01,500'+separator+'00:00:02,750\nMissing';
   const result = C.parseWithDiagnostics([first, skipped, last].join('\n\n'), 'range.srt');
   assert.equal(result.diagnostics.length, 1, JSON.stringify({separator, id}));
   assert.equal(result.diagnostics[0].category, 'malformed_timing');
   assert.equal(result.diagnostics[0].startLine, 6);
   assert.equal(result.diagnostics[0].endLine, id ? 8 : 7);
   assert.equal(result.diagnostics[0].cueId, id ? id.trim() : undefined);
  }
 }
});

test('VTT metadata is ignored even when it contains malformed or ordinary timing arrows', () => {
 const blocks = [
  'WEBVTT Authored fixture\n00:01.000 -> 00:02.000\nHeader metadata',
  'NOTE commentary\n00:01.000 --> 00:02.000\nComment text',
  'STYLE\n00:01.000 -> 00:02.000\n::cue { color: lime; }',
  'REGION\n00:01.000 -> 00:02.000\nwidth:80%',
  'named-opening\n00:01.000 --> 00:02.000 align:start\n<v Alice>Hello &amp; welcome</v>',
  'named-missing\n00:02.000 -> 00:03.000 align:start\nDropped words',
  'closing\n00:03.000 --> 00:04.000\nLast',
 ];
 // Header-based VTT detection is preserved even for an unusual filename.
 const {document, diagnostics} = C.parseWithDiagnostics('\uFEFF'+blocks.join('\r\n\r\n'), 'captions.txt');
 assert.deepEqual(diagnostics, [{category:'malformed_timing', startLine:21, endLine:23, cueId:'named-missing', preview:blocks[5]}]);
 assert.equal(document.segments.length, 2);
 assert.equal(document.segments[0].speaker, 'Alice');
 assert.equal(document.segments[0].text, 'Hello & welcome');
});

test('arbitrary blocks, number gaps and clock mentions in prose do not create loss warnings', () => {
 const unknown = [
  'Unrecognized metadata\nSome explanation',
  '999',
  '12:00 - 13:00\nA plain schedule without subtitle timestamps',
  'It happens at 00:01.000 -> 00:02.000\nA sentence, not a timing line',
  'Unknown heading\nDescription\n00:01.000 -> 00:02.000\nA quoted example, not a cue position',
  'word --> word',
 ];
 const result = C.parseWithDiagnostics([first, ...unknown, last].join('\n\n'), 'gaps.srt');
 assert.deepEqual(result.diagnostics, []);
 assert.deepEqual(result.document.segments.map(s=>s.id), ['segment-1', 'segment-2']);
});

test('recognized empty cues report loss without inventing text or validating formerly skipped timestamps', () => {
 const empty = 'empty-cue\n00:00:01,500 --> 00:00:02,750\n<b> </b>';
 const result = C.parseWithDiagnostics([first, empty, last].join('\n\n'), 'empty.srt');
 assert.deepEqual(result.diagnostics, [{category:'empty_cue', startLine:6, endLine:8, cueId:'empty-cue', preview:empty}]);
 assert.equal(result.document.segments.length, 2);
 const noPayload = C.parseWithDiagnostics([first, '00:00:01,500 --> 00:00:02,750', last].join('\n\n'), 'empty.srt');
 assert.deepEqual(noPayload.diagnostics, [{category:'empty_cue', startLine:6, endLine:6, preview:'00:00:01,500 --> 00:00:02,750'}]);
 const vtt = C.parseWithDiagnostics('WEBVTT\n\n00:01.000 --> 00:02.000\n<v Alice> </v>\n\n00:03.000 --> 00:04.000\nKept', 'empty.vtt');
 assert.equal(vtt.diagnostics[0].category, 'empty_cue');
 assert.equal(vtt.document.segments[0].text, 'Kept');
 // Legacy parse never called seconds() for an empty payload; preserve that.
 const invalidEmpty = C.parseWithDiagnostics([first, '00:99.000 --> 00:00.000\n<i></i>', last].join('\n\n'), 'empty.srt');
 assert.equal(invalidEmpty.diagnostics[0].category, 'empty_cue');
 assert.deepEqual(C.parse([first, empty, last].join('\n\n'), 'empty.srt'), result.document);
});

test('diagnostic previews and cue IDs are bounded plain source excerpts', () => {
 const id = 'a'.repeat(118)+'🌱'+'b'.repeat(1000);
 const skipped = id+'\n00:00:01,500 -> 00:00:02,750\n<script>not markup</script>'+'x'.repeat(10000);
 const {diagnostics} = C.parseWithDiagnostics([first, skipped, last].join('\n\n'), 'bounded.srt');
 assert.equal(diagnostics.length, 1);
 assert.ok(diagnostics[0].preview.length <= 240);
 assert.ok(diagnostics[0].cueId.length <= 120);
 assert.match(diagnostics[0].preview, /…$/);
 assert.equal(diagnostics[0].cueId, 'a'.repeat(118)+'…');
 const raw = C.parseWithDiagnostics([first, '00:00:01,500 -> 00:00:02,750\n<script>not markup</script>', last].join('\n\n'), 'plain.srt');
 assert.ok(raw.diagnostics[0].preview.includes('<script>not markup</script>'));
});

for (const fixture of subtitleFixtures) test(`${fixture.format.toUpperCase()} normal fixtures remain identical with no diagnostics`, () => {
 const result = C.parseWithDiagnostics(fixture.text, fixture.name);
 assert.deepEqual(result.diagnostics, []);
 assert.deepEqual(cueSnapshot(result.document), expectedCues);
 assert.deepEqual(result.document, C.parse(fixture.text, fixture.name));
 assert.equal(result.document.title, fixture.title);
});

test('JSON backup parsing uses the same validation and never persists diagnostics', () => {
 const original = C.validate({title:'Backup', segments:[{id:'source', start:1, end:2, text:'Kept'}], notes:{source:'Note'}});
 const input = JSON.stringify({...original, diagnostics:[{category:'untrusted'}]});
 const result = C.parseWithDiagnostics(input, 'backup.JSON');
 assert.deepEqual(result, {document:original, diagnostics:[]});
 assert.deepEqual(C.parse(input, 'backup.JSON'), original);
});

test('hard subtitle errors remain fatal and retain their original messages for both APIs', () => {
 const failures = [
  ['00:00:01,000-->00:00:02,000\nWords', '无法识别字幕时间'],
  ['00:99.000 --> 00:00:02,000\nWords', '字幕时间格式无效'],
  ['01:-01:01.000 --> 00:00:02,000\nWords', '字幕时间格式无效'],
  ['00:00:03,000 --> 00:00:02,000\nWords', '第 2 段内容或时间戳无效'],
  ['00:00:00,000 --> 00:00:02,000\nWords', '第 2 段内容或时间戳无效'],
 ];
 for (const [bad, message] of failures) {
  for (const parse of [C.parse, C.parseWithDiagnostics]) {
   assert.throws(()=>parse([first, bad, last].join('\n\n'), 'broken.srt'), {message});
  }
 }
});

test('zero usable cues and malformed JSON still fail instead of returning a warning-only document', () => {
 for (const parse of [C.parse, C.parseWithDiagnostics]) {
  for (const input of ['', 'Unrecognized text', '2\n00:00:01,000 -> 00:00:02,000\nLost', '2\n00:00:01,000\nLost', '2\n00:00:01,000 → 00:0', '00:00:01,000 --> 00:00:02,000\n<b></b>']) {
   assert.throws(()=>parse(input, 'empty.srt'), {message:'文字稿必须包含 1–100,000 个片段'});
  }
  assert.throws(()=>parse('{', 'broken.json'), SyntaxError);
  assert.throws(()=>parse('{"format":"coconut-library"}', 'library.json'), {message:'这是整书架备份，请使用「恢复书架备份」'});
 }
});
