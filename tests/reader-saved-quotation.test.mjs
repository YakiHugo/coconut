import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import C from '../reader/core.js';
import Q from '../reader/quotation.js';
import {libraryHarness} from './helpers/large-library-harness.mjs';

const createdAt='2026-10-12T08:00:00.000Z';
const quoteSource=fs.readFileSync(new URL('../reader/quotation.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture({paired=false,source={},text='Repeated repeated 🌴\r\nwords 中文。'}={}){
 const doc={...C.validate({title:'Historical title',language:'en',source_url:'https://youtu.be/authored',...source,segments:[
  {id:'a',text,start:1.234,end:8.5,original_text:'Before correction',translations:{zh:{text:'历史译文，独立选择。',provider:'Authored provider',source_language:'en',source_text:text}}},
  {id:'b',text:'Unselected neighbor',start:9,end:12}],notes:{a:'Private cue note'}}),key:'saved-quotation'};
 const options={id:'saved',createdAt,confirmedAt:createdAt};
 const record=paired?C.pairedExactExcerptSnapshot(doc,[doc.segments[0]],[],9,text.length,C.translationSelectionModels(doc,[doc.segments[0]],'zh')[0],0,4,options):
  C.exactExcerptSnapshot(doc,[doc.segments[0]],[],9,text.length,options);
 doc.exact_excerpts=[record];doc.exact_excerpt_notes={saved:'Private personal note'};return doc;
}
function setup(doc=fixture()){
 const env=libraryHarness([doc],{probe:true,configureCore:w=>w.eval(quoteSource)});
 env.$('mode-passages').click();return env;
}
function inline(w){w.document.querySelector('#passage-body .reading-excerpt-open:not([hidden])').click();return w.document.querySelector('#reading-excerpts-list .saved-excerpt-copy');}
function clipboard(w,writeText){Object.defineProperty(w.navigator,'clipboard',{configurable:true,value:{writeText,readText(){throw Error('Clipboard must never be read');}}});}

test('saved citation uses only the historical exact selection, title, source and cue timing after edits and deletion',()=>{
 const doc=fixture(),record=doc.exact_excerpts[0],snapshot=JSON.stringify(record);
 const before=Q.savedAttribution(record,C);
 doc.title='Changed title';doc.source_url='https://youtu.be/replacement';doc.segments=[];
 assert.equal(Q.savedAttribution(record,C),before);assert.equal(JSON.stringify(record),snapshot);
 assert.ok(before.startsWith(record.text+'\n\n—— Historical title · 00:00:01.234–00:00:08.500 · 已修正文字稿'));
 assert.match(before,/来源：https:\/\/youtu.be\/authored\?t=1/);assert.match(before,/选取时快照/);assert.match(before,/并非逐字时间/);assert.ok(before.includes(createdAt));
 assert.doesNotMatch(before,/Changed title|replacement|Private|Before correction|Unselected neighbor/);
});

test('saved bilingual citation includes only selected translation and its saved provenance, independent time and confirmation',()=>{
 const doc=fixture({paired:true}),record=doc.exact_excerpts[0];
 doc.segments[0].translations.zh.text='Replacement translation';doc.segments[0].translations.zh.provider='New provider';
 const payload=Q.savedAttribution(record,C);
 assert.match(payload,/选取时译文（zh）：\n历史译文/);assert.match(payload,/译文时间：00:00:01.234–00:00:08.500/);
 assert.match(payload,/Authored provider/);assert.match(payload,/机器生成，需核对/);assert.match(payload,/译文生成时间：未记录/);
 assert.ok(payload.includes('配对确认时间：'+createdAt));assert.match(payload,/不等于译文人工核对/);
 assert.doesNotMatch(payload,/Replacement translation|New provider|独立选择|Private/);
});

test('independent bilingual cue ranges and saved quality warnings retain their distinct evidence',()=>{
 const doc=C.validate({title:'Independent bilingual evidence',language:'en',source_url:'',segments:[0,1,2].map(i=>({id:String(i),text:'Original '+i,start:i*5,end:i*5+4,
  translations:{zh:{text:'第'+i+'段译文',source_text:'Original '+i,source_language:'en',provider:'Authored provider',...(i===1?{quality_warnings:['numbers_changed']}:{})}}}))});
 const model=C.translationSelectionModels(doc,doc.segments,'zh')[0],record=C.pairedExactExcerptSnapshot(doc,doc.segments,[' ',' '],0,5,model,5,model.text.length,{id:'independent',createdAt,confirmedAt:createdAt});
 const payload=Q.savedAttribution(record,C);assert.match(payload,/00:00:00.000–00:00:04.000/);assert.match(payload,/译文时间：00:00:05.000–00:00:14.000/);
 assert.ok(payload.includes(record.translation.text));assert.match(payload,/选取时质量提示/);assert.ok(payload.includes(C.translationQualityMessage({quality_warnings:['numbers_changed']})));
 assert.doesNotMatch(payload,/第0段译文|Original 1|Original 2/);
});

test('legacy v1 source coverage stays honest without present-day metadata, unsafe URLs or private paths',()=>{
 const cases=[
  [{source_url:''},/未关联原站链接或媒体/],
  [{source_url:'',local_media_source:{version:1,kind:'audio',name:'private.wav',size:1,last_modified:0,type:'audio/wav',fingerprint:'a'.repeat(64)}},/本地原始媒体/],
  [{source_url:'https://youtu.be/authored',provenance:{kind:'authored_demo'}},/自写演示内容（无对应音视频）/],
 ];
 for(const [source,expected] of cases){const doc=fixture({source}),payload=Q.savedAttribution(doc.exact_excerpts[0],C);assert.match(payload,expected);assert.doesNotMatch(payload,/private.wav|选取时译文|译文生成时间/);if(source.provenance)assert.doesNotMatch(payload,/https:/);}
 // The formatter also refuses links when handed unsupported untrusted metadata.
 const record=JSON.parse(JSON.stringify(fixture().exact_excerpts[0]));
 for(const url of ['javascript:alert(1)','file:///private/secret.wav','https://user:secret@youtube.com/watch?v=x','https://unknown.example/']){
  record.snapshot.source.source_url=url;assert.doesNotMatch(Q.savedAttribution(record,C),/javascript:|file:|secret|unknown.example/);
 }
 record.snapshot.source.title='Historical\nOther';assert.match(Q.savedAttribution(record,C),/Historical\\nOther/);
 record.snapshot.source.source_url='';record.snapshot.source.podcast_source={feed_url:'https://podcast.example/feed.xml'};
 assert.match(Q.savedAttribution(record,C),/来源：https:\/\/podcast.example\/feed.xml（按时间手动定位）/);
});

test('saved direct-media attribution retains a validated historical URL and omits unsafe fallbacks',()=>{
 for(const media_kind of ['audio','video']){
  const url='https://podcast.example/original.'+(media_kind==='audio'?'mp3':'mp4');
  const doc=fixture({source:{source_url:'',podcast_source:{kind:'direct_media',media_url:url,media_kind}}}),record=doc.exact_excerpts[0];
  doc.podcast_source.media_url='https://podcast.example/current.mp3';doc.title='Current direct-media title';
  const payload=Q.savedAttribution(record,C);assert.ok(payload.includes('来源：'+url+'（按时间手动定位）'));
  assert.doesNotMatch(payload,/current.mp3|Current direct-media title|未关联原站链接或媒体|\?t=/);
 }
 const record=JSON.parse(JSON.stringify(fixture({source:{source_url:''}}).exact_excerpts[0]));
 for(const media_url of ['javascript:alert(1)','file:///private/audio.mp3','https://user:secret@podcast.example/audio.mp3','https://podcast.example:8443/audio.mp3']){
  record.snapshot.source.podcast_source={kind:'direct_media',media_url,media_kind:'audio'};
  const payload=Q.savedAttribution(record,C);assert.match(payload,/未关联原站链接或媒体/);assert.doesNotMatch(payload,/javascript:|file:|private|secret|8443/);
 }
 record.snapshot.source.podcast_source={kind:'direct_media',media_url:'https://podcast.example/authored.mp3',media_kind:'audio'};
 record.snapshot.source.provenance={kind:'authored_demo'};assert.doesNotMatch(Q.savedAttribution(record,C),/https:/);
});

test('inline and notebook controls copy one historical payload without changing reading, notes, media or saves',async()=>{
 const {w,$,pipeline}=setup(fixture({paired:true}));try{
  await pipeline.store.flush();const doc=w.libraryProbe.documents[0],before=JSON.stringify(doc),saved=w.localStorage.getItem('coconut-reader-v1'),prepares=pipeline.prepares;
  const source=w.document.querySelector('.passage-original'),html=source.innerHTML;let plays=0;const player=w.document.createElement('audio');player.play=()=>plays++;$('source-media').append(player);
  const writes=[];clipboard(w,async text=>writes.push(text));const control=inline(w),button=control.querySelector('button');
  assert.equal(button.textContent,'复制引用与出处');assert.equal(button.type,'button');button.focus();button.click();await tick();
  assert.equal(writes.length,1);assert.equal(writes[0],Q.savedAttribution(doc.exact_excerpts[0],C));assert.match(control.querySelector('[role="status"]').textContent,/已复制/);
  assert.equal(w.document.activeElement,button);assert.equal(control.querySelector('textarea'),null);
  $('reading-excerpts-close').click();$('open-library-notebook').click();const notebook=w.document.querySelector('#notebook-captures .saved-excerpt-copy');
  assert.ok(notebook);assert.equal(notebook.closest('details'),null);notebook.querySelector('button').click();await tick();assert.equal(writes[1],writes[0]);
  assert.equal(JSON.stringify(doc),before);assert.equal(w.localStorage.getItem('coconut-reader-v1'),saved);assert.equal(pipeline.prepares,prepares);
  assert.equal(source.innerHTML,html);assert.equal(player.isConnected,true);assert.equal(plays,0);assert.doesNotMatch(writes[0],/Private/);
 }finally{await w.happyDOM.close();}
});

test('clipboard failure retains a complete labeled readonly fallback and an honest status, with retry',async()=>{
 const {w,$}=setup();try{
  clipboard(w,async()=>{throw Error('Denied');});const control=inline(w),button=control.querySelector('button');button.focus();button.click();await tick();
  const field=control.querySelector('textarea');assert.ok(field);assert.equal(field.readOnly,true);assert.match(field.getAttribute('aria-label'),/完整引用与出处/);
  assert.equal(field.value,Q.savedAttribution(w.libraryProbe.documents[0].exact_excerpts[0],C).replace(/\r\n?/g,'\n'));
  assert.match(control.textContent,/未能自动复制/);assert.match(control.textContent,/手动复制/);assert.match(control.textContent,/换行/);assert.doesNotMatch(control.textContent,/已复制/);
  assert.equal(w.document.activeElement,field);assert.equal(field.selectionStart,0);assert.equal(field.selectionEnd,field.value.length);assert.equal(button.disabled,false);
  let copied;clipboard(w,async text=>{copied=text;});button.click();await tick();assert.ok(copied.includes('\r\n'));assert.match(control.textContent,/已复制/);
 }finally{await w.happyDOM.close();}
});

test('missing clipboard API uses the same manual fallback without claiming success',async()=>{
 const {w}=setup();try{
  Object.defineProperty(w.navigator,'clipboard',{value:undefined});const control=inline(w);control.querySelector('button').click();await tick();
  assert.match(control.textContent,/未能自动复制/);assert.ok(control.querySelector('textarea').value.startsWith('repeated 🌴'));
 }finally{await w.happyDOM.close();}
});

test('duplicate clicks, closed or paginated views and late failure do not reopen a dialog or steal focus',async()=>{
 const doc=fixture();doc.exact_excerpts=Array.from({length:9},(_,i)=>C.exactExcerptSnapshot(doc,[doc.segments[0]],[],9,doc.segments[0].text.length,{id:'saved'+i,createdAt}));delete doc.exact_excerpt_notes;
 const {w,$}=setup(doc);try{
  let reject,writes=0;clipboard(w,()=>{writes++;return new Promise((resolve,no)=>reject=no);});let control=inline(w),button=control.querySelector('button');button.focus();button.click();button.click();assert.equal(writes,1);assert.equal(button.getAttribute('aria-disabled'),'true');assert.equal(button.disabled,false);assert.ok(w.document.activeElement===button);
  $('reading-excerpts-next').click();const next=$('reading-excerpts-previous');next.focus();reject(Error('Denied'));await tick();assert.ok(w.document.activeElement===next);assert.equal(control.querySelector('textarea'),null);
  control=w.document.querySelector('#reading-excerpts-list .saved-excerpt-copy');button=control.querySelector('button');button.click();$('reading-excerpts-close').click();const focused=w.document.activeElement;reject(Error('Denied'));await tick();
  assert.equal($('reading-excerpts-dialog').open,false);assert.equal(w.document.activeElement,focused);assert.equal(control.querySelector('textarea'),null);
 }finally{await w.happyDOM.close();}
});

test('late clipboard failure cannot steal focus from note editing, and replaced records cannot trigger a write',async()=>{
 const {w,$}=setup();try{
  let reject,writes=0;clipboard(w,()=>{writes++;return new Promise((resolve,no)=>reject=no);});const control=inline(w),button=control.querySelector('button');button.focus();button.click();
  w.document.querySelector('.reading-excerpt-edit').click();const focus=w.document.activeElement;reject(Error('Denied'));await tick();assert.equal(w.document.activeElement,focus);assert.equal($('exact-note-dialog').open,true);
  $('exact-note-close').click();w.libraryProbe.documents[0].exact_excerpts=[];w.libraryProbe.render();assert.equal(button.disabled,true);button.click();assert.equal(writes,1);
 }finally{await w.happyDOM.close();}
});

test('notebook can copy a saved snapshot after its original cue is deleted',async()=>{
 const doc=fixture();doc.segments.shift();const {w,$}=setup(doc);try{
  let payload;clipboard(w,async text=>{payload=text;});$('open-library-notebook').click();
  assert.equal(w.document.querySelector('.notebook-open').disabled,true);w.document.querySelector('#notebook-captures .saved-excerpt-copy button').click();await tick();
  assert.equal(payload,Q.savedAttribution(doc.exact_excerpts[0],C));assert.match(payload,/Historical title/);
 }finally{await w.happyDOM.close();}
});

test('long saved quotation is never truncated to the row preview',async()=>{
 const doc=fixture({text:'Repeated '+('Full exact 🌴 '.repeat(1800))});
 const {w}=setup(doc);try{
  let payload;clipboard(w,async text=>{payload=text;});const control=inline(w);control.querySelector('button').click();await tick();
  assert.ok(payload.startsWith(doc.exact_excerpts[0].text));assert.ok(payload.length>20000);assert.ok(w.document.querySelector('.reading-excerpt-preview').textContent.length<400);
 }finally{await w.happyDOM.close();}
});

test('a late successful copy cannot change a reopened view or restore an old success notice',async()=>{
 const {w,$}=setup();try{
  let finish;clipboard(w,()=>new Promise(resolve=>finish=resolve));const previous=inline(w);previous.querySelector('button').click();$('reading-excerpts-close').click();
  const next=inline(w),focused=w.document.activeElement;finish();await tick();assert.equal(next.querySelector('[role="status"]').textContent,'');assert.equal(w.document.activeElement,focused);
 }finally{await w.happyDOM.close();}
});

test('copy controls and manual preview have accessible labels and touch-sized targets',async()=>{
 const {w}=setup();try{
  const style=w.document.createElement('style');style.textContent=fs.readFileSync(new URL('../reader/style.css',import.meta.url),'utf8');w.document.head.append(style);
  const control=inline(w),button=control.querySelector('button'),computed=w.getComputedStyle(button);
  assert.equal(computed.minHeight,'44px');assert.equal(computed.minWidth,'44px');assert.equal(control.querySelector('[role="status"]').getAttribute('aria-live'),'polite');
 }finally{await w.happyDOM.close();}
});
