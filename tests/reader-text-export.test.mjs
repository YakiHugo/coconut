import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {textExportFixture,originalText,originalParagraph} from './helpers/text-export-fixture.mjs';
const require=createRequire(import.meta.url),C=require('../reader/core.js');
const doc=()=>C.validate(textExportFixture());
function setup(value=textExportFixture()){
 const env=libraryHarness([value],{probe:true}),downloads=[];env.w.URL.createObjectURL=blob=>{downloads.push({blob});return 'blob:authored-txt';};env.w.URL.revokeObjectURL=()=>{};
 env.w.document.addEventListener('click',event=>{if(event.target.matches?.('a[download]')){downloads.at(-1).name=event.target.download;event.preventDefault();}});
 return {...env,downloads};
}
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
test('full-script download ignores page, search, notes/excerpts/speaker filters and remains keyboard-accessible',async()=>{
 const env=setup(),{w,$,downloads}=env;try{
  $('mode-transcript').click();$('next-page').click();$('search').value='Unannotated full source 101';$('search').dispatchEvent(new w.Event('input'));
  $('export-menu').open=true;$('export-text').focus();$('export-text').click();assert.equal(await downloads[0].blob.text(),originalText);assert.equal(downloads[0].name,'Authored _ reading.txt');assert.equal(downloads[0].blob.type,'text/plain;charset=utf-8');assert.equal(w.document.activeElement,$('export-text'));assert.equal($('export-menu').open,true);assert.equal(w.document.querySelector('a[download]'),null);
  assert.match($('notice').textContent,/105 段/);
  $('search').value='';$('search').dispatchEvent(new w.Event('input'));$('speaker-filter').value=JSON.stringify('Bob');$('speaker-filter').dispatchEvent(new w.Event('change'));$('export-text').click();assert.equal(await downloads.at(-1).blob.text(),originalText);
  for(const id of ['filter-notes','filter-excerpts']){$(id).click();$('export-text').click();assert.equal(await downloads.at(-1).blob.text(),originalText);}
  w.URL.createObjectURL=()=>{throw Error('blocked');};$('export-text').click();assert.match($('notice').textContent,/整篇文字导出失败/);assert.equal(env.w.libraryProbe.documents[0].segments.length,105);
 }finally{await w.happyDOM.close();}
});
test('actual passage fallback language is exportable, collapsing it disables optional translations',async()=>{
 const value=textExportFixture();value.translation_view='';const {w,$,downloads}=setup(value);try{
  $('mode-passages').click();assert.equal($('text-bilingual').disabled,false);assert.match($('text-export-language').textContent,/zh/);assert.equal($('text-bilingual').checked,false);
  $('text-bilingual').checked=true;$('export-text').click();assert.match(await downloads[0].blob.text(),/人工修正 <译文>/);
  $('passage-toggle-translation').click();assert.equal($('text-bilingual').disabled,true);assert.equal($('text-bilingual').checked,false);$('export-text').click();assert.equal(await downloads[1].blob.text(),originalText);
  $('mode-transcript').click();assert.equal($('text-bilingual').disabled,true);
 }finally{await w.happyDOM.close();}
});
test('audio-only projects cannot export a fabricated transcript',async()=>{
 const value={key:'audio',title:'No transcript',project_kind:'audio_only',segments:[],local_media_source:{version:1,kind:'audio',name:'Original.wav',size:64,last_modified:7,type:'audio/wav',fingerprint:'a'.repeat(64)}};
 assert.throws(()=>C.transcriptText(C.validate(value)),/文字稿/);const {w,$,downloads}=setup(value);try{assert.equal($('export-text').disabled,true);assert.equal($('text-bilingual').disabled,true);$('export-text').click();assert.equal(downloads.length,0);}finally{await w.happyDOM.close();}
});

test('Summary mode does not advertise a retained but invisible translation language',async()=>{
 const {w,$,downloads}=setup();try{
  $('mode-summary').click();assert.equal($('text-bilingual').disabled,true);assert.equal($('export-text').disabled,false);
  $('mode-bilingual').click();assert.equal($('text-bilingual').disabled,false);$('text-bilingual').checked=true;
  $('mode-summary').click();assert.equal($('text-bilingual').disabled,true);assert.equal($('text-bilingual').checked,false);
  $('export-text').click();assert.equal(await downloads[0].blob.text(),originalText);
 }finally{await w.happyDOM.close();}
});
