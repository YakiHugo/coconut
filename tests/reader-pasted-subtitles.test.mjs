// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import {createHash,webcrypto} from 'node:crypto';

import C from '../reader/core.js';

import {subtitleFixtures,expectedCues,note,cueSnapshot} from './helpers/subtitle-import-fixtures.mjs';

const srt='1\n00:00:01,125 --> 00:00:03,875\nFirst authored line 你好 🌿\nA second line &amp; detail.\n\n2\n00:00:04,000 --> 00:00:05,250\nSecond cue';

const vtt='WEBVTT\n\nopening\n00:01.125 --> 00:03.875 align:start\n<v Alice &amp; Bob>Hello &lt;Team&gt; 🌿</v>\n\nreply\n00:04.000 --> 00:05.250\n<v Chen>Reply</v>';

const digest=doc=>createHash('sha256').update(JSON.stringify(doc)).digest('hex');

for(const f of subtitleFixtures)test('paste parser preserves '+f.format+' BOM, CRLF, multilingual text, exact cue times and file identity',()=>{
 const result=C.parsePastedSubtitles(f.text,{title:f.title,format:'auto'});
 assert.equal(result.format,f.format);assert.equal(result.bytes,Buffer.byteLength(f.text,'utf8'));
 assert.deepEqual(result.diagnostics,[]);assert.deepEqual(cueSnapshot(result.document),expectedCues);
 assert.deepEqual(result.document,C.parse(f.text,f.name));assert.equal(digest(result.document),digest(C.parse(f.text,f.name)));
 assert.equal(Object.hasOwn(result.document,'diagnostics'),false);assert.equal(Object.hasOwn(result.document,'bytes'),false);
});

test('paste parser uses trimmed title or a stable default, with no fabricated source or language',()=>{
 const named=C.parsePastedSubtitles(srt,{title:'  Lesson.with.dots  ',format:'srt'}).document;
 assert.deepEqual(named,C.parse(srt,'Lesson.with.dots.srt'));assert.equal(named.title,'Lesson.with.dots');
 const unnamed=C.parsePastedSubtitles(srt,{title:' \t ',format:'auto'}).document;
 assert.equal(unnamed.title,'粘贴字幕');assert.equal(unnamed.source_url,'');assert.equal(unnamed.language,'');assert.equal(unnamed.provenance,undefined);
 assert.deepEqual(C.parsePastedSubtitles(srt).document,unnamed);
});

test('VTT header, headerless complete timing rows, voices and encoded markup use the original VTT parser',()=>{
 for(const text of [vtt,vtt.replace('WEBVTT\n\n',''),'00:00:01.125 --> 00:00:03.875\n<v Narrator>One &amp; two</v>']){
  const result=C.parsePastedSubtitles(text,{title:'Voices',format:'auto'});assert.equal(result.format,'vtt');assert.deepEqual(result.document,C.parse(text,'Voices.vtt'));
 }
 const result=C.parsePastedSubtitles(vtt,{title:'Voices',format:'vtt'});
 assert.equal(result.document.segments[0].speaker,'Alice & Bob');assert.equal(result.document.segments[0].text,'Hello <Team> 🌿');
 assert.equal(result.document.segments[1].speaker,'Chen');assert.equal(result.document.segments[1].start,4);assert.equal(result.document.segments[1].end,5.25);
});

test('paste parser is strict about cue timing and format without changing legacy file parsing',()=>{
 const invalid=[
  '', 'A transcript with no timestamps.', '00:01 Hello there', '[00:01] Only a start', '00:00:01,000\nOnly a start',
  '1\n00:00:01,000 -->\nNo end', '1\n--> 00:00:02,000\nNo start',
  '1\n00:00:01 --> 00:00:02\nNo milliseconds',
  '1\n0:00:01,000 --> 0:00:02,000\nShort hour',
  '1\n00:00:01,00 --> 00:00:02,000\nShort milliseconds',
  '1\n00:60:01,000 --> 00:60:02,000\nBad minutes',
  '1\n-00:00:01,000 --> 00:00:02,000\nNegative clock',
  '1\n00:00:03,000 --> 00:00:02,000\nReverse interval',
  '1\n00:00:01,000-->00:00:02,000\nNo spaces',
  'heading\nextra line\n00:00:01,000 --> 00:00:02,000\nMisplaced timing',
  JSON.stringify({title:'JSON',segments:[{start:0,end:1,text:'Must use JSON import'}]}),
 ];
 for(const input of invalid)assert.throws(()=>C.parsePastedSubtitles(input,{format:'auto'}),undefined,input);
 for(const input of ['1\n00:01,000 --> 00:02,000\nShort SRT','1\n00:00:01.000 --> 00:00:02.000\nVTT clock'])assert.throws(()=>C.parsePastedSubtitles(input,{format:'srt'}));
 assert.throws(()=>C.parsePastedSubtitles(srt,{format:'vtt'}));assert.throws(()=>C.parsePastedSubtitles(vtt,{format:'srt'}));
 assert.throws(()=>C.parsePastedSubtitles(srt,{format:'json'}));
 assert.equal(C.parse('1\n00:01,000 --> 00:02,000\nLegacy short clock','legacy.srt').segments[0].start,1);
 assert.equal(C.parse('heading\nextra line\n00:00:01,000 --> 00:00:02,000\nLegacy timing position','legacy.srt').segments[0].text,'Legacy timing position');
});

test('partial malformed-block diagnostics retain original CRLF/BOM line numbers and never become cue metadata',()=>{
 const first='17\n00:00:01,125 --> 00:00:03,875\nFirst\nSecond line',bad='42\n00:00:04,000 -> 00:00:05,000\n<img src=x onerror=alert(1)>',last='800\n00:00:06,000 --> 00:00:07,000\nLast';
 const text='\uFEFF'+[first,bad,last].join('\r\n\r\n').replace(/(?<!\r)\n/g,'\r\n');
 const result=C.parsePastedSubtitles(text,{title:'Partial',format:'srt'}),file=C.parseWithDiagnostics(text,'Partial.srt');
 assert.deepEqual(result.document,file.document);assert.deepEqual(result.diagnostics,file.diagnostics);
 assert.equal(result.diagnostics[0].startLine,6);assert.equal(result.diagnostics[0].endLine,8);assert.equal(result.diagnostics[0].cueId,'42');
 assert.deepEqual(result.document.segments.map(s=>s.text),['First\nSecond line','Last']);
 assert.equal(JSON.stringify(result.document).includes('onerror'),false);
});

test('15 MiB limit counts UTF-8 bytes, accepts its exact boundary and rejects above it before parsing',()=>{
 const limit=15*1024*1024,prefix='1\n00:00:00,000 --> 00:00:01,000\n';
 const remaining=limit-Buffer.byteLength(prefix),text=prefix+'界'.repeat(Math.floor(remaining/3))+'a'.repeat(remaining%3);
 assert.ok(text.length<limit/2,'fixture distinguishes UTF-16 length from UTF-8 byte size');
 const result=C.parsePastedSubtitles(text,{format:'srt'});assert.equal(result.bytes,limit);assert.equal(result.document.segments[0].text,text.slice(prefix.length));
 assert.throws(()=>C.parsePastedSubtitles(text+'a',{format:'srt'}),/15 MiB/);
 assert.throws(()=>C.parsePastedSubtitles('x'.repeat(limit+1),{format:'auto'}),/15 MiB/);
});

test('pasted text still enforces the existing 100,000 cue and monotone-start validation limits',()=>{
 const cue='00:00:00,000 --> 00:00:00,001\na';
 assert.throws(()=>C.parsePastedSubtitles(Array.from({length:100001},()=>cue).join('\n\n'),{format:'srt'}),/100,000/);
 assert.throws(()=>C.parsePastedSubtitles('1\n00:00:02,000 --> 00:00:03,000\nFirst\n\n2\n00:00:01,000 --> 00:00:02,000\nOut of order',{format:'srt'}),/时间戳无效/);
});
