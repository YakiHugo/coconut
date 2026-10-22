// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import {createRequire} from 'node:module';

import {textExportFixture,originalText,originalParagraph} from './helpers/text-export-fixture.mjs';

const require=createRequire(import.meta.url);

const C=require('../reader/core.js');

const doc=()=>C.validate(textExportFixture());

test('whole readable text uses existing paragraph spacing, exact source/speakers and no private or historical content',()=>{
 const value=doc();value.exact_excerpts=[{text:'HISTORICAL EXCERPT SECRET'}];value.ai_answers=[{answer:'AI ANSWER SECRET'}];
 const before=JSON.stringify(value),subtitles=C.subtitleExport(value,'vtt',true).text,result=C.transcriptText(value);
 assert.equal(result.text,originalText);assert.equal(JSON.stringify(value),before);assert.equal(C.subtitleExport(value,'vtt',true).text,subtitles);
 assert.doesNotMatch(result.text,/SECRET|00:00|WEBVTT|原文：|译文/);assert.equal(result.translated,0);
});

test('optional translations keep current user text, distinguish missing and stale and never leak stale text',()=>{
 const value=doc(),result=C.transcriptText(value,'zh');assert.deepEqual({...result,text:undefined},{text:undefined,translated:1,missing:103,stale:1});
 assert.match(result.text,/译文（zh）：有效 1 段 · 缺失 103 段 · 过期 1 段/);
 assert.ok(result.text.includes('原文：\n'+originalParagraph+'\n译文（zh）：\n人工修正 <译文>。\n[译文已过期，未导出]\n[暂无译文]'));
 assert.doesNotMatch(result.text,/SECRET/);
 value.segments[0].text+=' corrected again';assert.equal(C.transcriptText(value,'zh').translated,0);assert.equal(C.transcriptText(value,'fr').missing,105);
});

test('source labels are truthful and raw local names, whitespace, newlines and speaker labels stay literal',()=>{
 const value=doc();value.source_url='';value.segments=[{id:'literal',start:0,end:1,text:'  leading\r\ntrailing  ',speaker:' Alice\n&Bob '}];
 assert.match(C.transcriptText(value).text,/来源：未关联来源/);assert.ok(C.transcriptText(value).text.endsWith('说话人： Alice\n&Bob \n  leading\r\ntrailing  \n'));
 value.source_media={kind:'audio',path:'/private/file.wav'};assert.match(C.transcriptText(value).text,/来源：本地原始媒体（无原站链接）/);assert.doesNotMatch(C.transcriptText(value).text,/private/);
 value.local_media_source={name:'Original <Audio>.wav'};assert.match(C.transcriptText(value).text,/来源：本地媒体：Original <Audio>\.wav/);
 value.podcast_source={kind:'direct_media',media_kind:'audio',media_url:'https://media.example/authored.mp3'};assert.match(C.transcriptText(value).text,/来源：https:\/\/media\.example\/authored\.mp3/);
 value.provenance={kind:'authored_demo'};value.source_url='https://www.youtube.com/watch?v=fake';assert.match(C.transcriptText(value).text,/来源：自写演示内容/);assert.doesNotMatch(C.transcriptText(value).text,/youtube/);
});

test('continuous reading export repeats labels only at turns and marks unknown speakers explicitly',()=>{
 const value=C.validate({title:'自写材料',segments:Array.from({length:43},(_,i)=>({id:'c'+i,start:i*2,end:i*2+2,text:'这是完整的原句。',speaker:i===40?null:'A'}))});
 const before=JSON.stringify(value),result=C.transcriptText(value,'',{layout:'reading'});
 assert.equal((result.text.match(/说话人：A/g)||[]).length,2);
 assert.equal((result.text.match(/说话人：未标注/g)||[]).length,1);
 assert.equal((result.text.match(/这是完整的原句。/g)||[]).length,43);
 assert.equal(JSON.stringify(value),before);
});
