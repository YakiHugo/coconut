// Compatibility renderer regression; this suite is not default React acceptance.
/** Authored Unicode source, real reader DOM/storage, and a bounded fake offline provider. No model calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import C from '../reader/core.js';
const root=new URL('../',import.meta.url),KEY='coconut-reader-v1';
const points=text=>Array.from(text).length;
const fixture=(count=40,text='A'.repeat(1499)+'.')=>({key:'offline-source',title:'Long offline source',language:'en',notes:{'cue-0':'Private note, never sent'},segments:Array.from({length:count},(_,index)=>({id:'cue-'+index,start:index*60,end:(index+1)*60,text}))});
function setup(doc=fixture(),{hold=0,fail=0}={}){
 const w=new Window({url:'http://127.0.0.1:8080/'}),$=id=>w.document.getElementById(id);
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/compatibility.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});w.localStorage.setItem(KEY,JSON.stringify({documents:[{...C.validate(doc),key:doc.key}],active:doc.key}));
 const requests=[];let release,failAt=fail;
 w.fetch=async(url,options)=>{
  if(url.endsWith('language-tools'))return {ok:true,json:async()=>({local_translation:true,ai:{codex:{ready:true},claude:{ready:true}}})};
  assert.equal(url,'api/translate');const request=JSON.parse(options.body),number=requests.push(request);
  // Mirror language_tools.py validate_segments. Its real model/tokenizer is not loaded.
  assert.ok(request.segments.length>=1&&request.segments.length<=32);
  assert.equal(new Set(request.segments.map(cue=>cue.id)).size,request.segments.length);
  for(const cue of request.segments){assert.ok(points(cue.id)>=1&&points(cue.id)<=200);assert.ok(points(cue.text)>=1&&points(cue.text)<=4000);}
  const characters=request.segments.reduce((sum,cue)=>sum+points(cue.text),0);
  if(characters>40000)return {ok:false,json:async()=>({error:'The translation batch is too large'})};
  assert.equal(JSON.stringify(request).includes('Private note'),false);
  if(number===hold)await new Promise(resolve=>{release=resolve;});
  if(number===failAt)throw new Error('Injected offline rejection');
  return {ok:true,json:async()=>({translations:request.segments.map(cue=>({id:cue.id,source_text:cue.text,text:'预置译文😀 '+cue.id,provider:'injected_offline'}))})};
 };
 w.eval(['summary','core','passages','passage-playback','library-store','app','language','translation-review'].map(file=>fs.readFileSync(new URL('reader/'+file+'.js',root),'utf8')).join('\n'));
 return {w,$,requests,release:()=>release?.(),clearFailure:()=>{failAt=0;},disk:()=>JSON.parse(w.localStorage.getItem(KEY)).documents};
}
async function ready(h){h.$('mode-transcript').click();h.$('language-panel').open=true;h.$('ai-task').value='translation';h.$('ai-task').onchange();await h.$('check-ai').onclick();}
const saved=h=>h.disk().find(doc=>doc.key==='offline-source');
const translated=doc=>doc.segments.filter(cue=>cue.translations?.zh);
const ids=requests=>requests.flatMap(request=>request.segments.map(cue=>cue.id));
async function load(h,doc){const text=JSON.stringify(doc);Object.defineProperty(h.$('file'),'files',{configurable:true,value:[{name:'authored.json',size:text.length,text:async()=>text}]});await h.$('file').onchange();}

test('offline plan respects both limits and returns each complete cue in source order without mutation',()=>{
 for(const [count,text,expected] of [[40,'A'.repeat(1500),[26,14]],[65,'A',[32,32,1]],[11,'中'.repeat(4000),[10,1]],[10,'中'.repeat(4000),[10]]]){
  const doc=fixture(count,text),before=JSON.stringify(doc),batches=C.offlineTranslationBatches(doc.segments);
  assert.deepEqual(batches.map(batch=>batch.length),expected);assert.equal(JSON.stringify(doc),before);
  assert.deepEqual(batches.flat(),doc.segments.map(({id,text})=>({id,text})));
  for(const batch of batches)assert.ok(batch.reduce((sum,cue)=>sum+points(cue.text),0)<=40000);
 }
 assert.deepEqual(C.offlineTranslationBatches([]),[]);
});

test('offline plan counts Unicode code points like Python, retaining emoji, CJK and combining marks',()=>{
 const doc=fixture(11,'😀'.repeat(2000)+'中'.repeat(2000));doc.segments[0].id='😀'.repeat(200);
 const batches=C.offlineTranslationBatches(doc.segments);
 assert.deepEqual(batches.map(batch=>batch.length),[10,1]);assert.equal(batches[0][0].id,doc.segments[0].id);
 assert.equal(batches[0][0].text.length,6000);assert.equal(points(batches[0][0].text),4000);
 assert.equal(C.offlineTranslationBatches(fixture(1,'e\u0301'.repeat(2000)).segments)[0][0].text,'e\u0301'.repeat(2000));
});

for(const [label,change] of [
 ['oversized ASCII',doc=>{doc.segments[35].text='A'.repeat(4001);}],
 ['oversized emoji',doc=>{doc.segments[35].text='😀'.repeat(4001);}],
 ['oversized combining text',doc=>{doc.segments[35].text='e\u0301'.repeat(2001);}],
 ['empty text',doc=>{doc.segments[35].text='';}],
 ['empty ID',doc=>{doc.segments[35].id='';}],
 ['oversized ID',doc=>{doc.segments[35].id='😀'.repeat(201);}],
 ['duplicate ID',doc=>{doc.segments[35].id=doc.segments[0].id;}],
])test(`offline plan rejects ${label} before returning a partial plan and never truncates source`,()=>{
 const doc=fixture();change(doc);const before=JSON.stringify(doc);assert.throws(()=>C.offlineTranslationBatches(doc.segments),/待译第 36 段.*尚未发送/);assert.equal(JSON.stringify(doc),before);
});

test('reader completes legal long cues in bounded requests instead of repeating a rejected 48,000-character batch',async()=>{
 const h=setup();try{await ready(h);await h.$('translate-document').onclick();
  assert.deepEqual(h.requests.map(request=>request.segments.length),[26,14]);assert.deepEqual(ids(h.requests),fixture().segments.map(cue=>cue.id));
  assert.equal(translated(saved(h)).length,40);assert.equal(saved(h).notes['cue-0'],'Private note, never sent');
  assert.match(h.$('language-status').textContent,/本次翻译完成.*保存 40 段/);
 }finally{await h.w.happyDOM.close();}
});

test('reader accepts supplementary Unicode within the Python per-cue and per-batch budgets',async()=>{
 const source=fixture(11,'😀'.repeat(2000)+'中'.repeat(2000)),h=setup(source);try{
  await ready(h);await h.$('translate-document').onclick();assert.deepEqual(h.requests.map(request=>request.segments.length),[10,1]);
  assert.deepEqual(h.requests.flatMap(request=>request.segments.map(cue=>cue.text)),source.segments.map(cue=>cue.text));assert.equal(translated(saved(h)).length,11);
  const backup=C.parse(JSON.stringify(saved(h)),'backup.json');assert.equal(translated(backup).length,11);assert.equal(backup.segments[0].translations.zh.source_text,source.segments[0].text);assert.equal(backup.segments[0].translations.zh.text,'预置译文😀 cue-0');
  const restored=setup(saved(h));try{await ready(restored);await restored.$('translate-document').onclick();assert.equal(restored.requests.length,0);assert.equal(translated(saved(restored)).length,11);}finally{await restored.w.happyDOM.close();}
 }finally{await h.w.happyDOM.close();}
});

for(const [label,value] of [['source','中'.repeat(4001)],['emoji','😀'.repeat(4001)],['ID','x'.repeat(201)]])test(`reader reports unsupported ${label} before sending or changing any document`,async()=>{
 const source=fixture();if(label==='ID')source.segments[35].id=value;else source.segments[35].text=value;
 const h=setup(source);try{await ready(h);const before=h.w.localStorage.getItem(KEY);await h.$('translate-document').onclick();
  assert.equal(h.requests.length,0);assert.match(h.$('notice').textContent,/待译第 36 段.*尚未发送离线翻译请求/);assert.equal(h.w.localStorage.getItem(KEY),before);assert.equal(h.$('translate-document').disabled,false);assert.equal(h.$('stop-translation').hidden,true);
 }finally{await h.w.happyDOM.close();}
});

for(const reason of ['stop','switch-document'])test(`offline ${reason} keeps its bounded current batch and a later retry skips saved targets`,async()=>{
 const h=setup(fixture(),{hold:1});let run;try{
  await ready(h);run=h.$('translate-document').onclick();assert.equal(h.requests.length,1);
  if(reason==='stop')h.$('stop-translation').click();else await load(h,{...fixture(1,'Other document source.'),key:'other',title:'Other source'});
  h.release();await run;assert.equal(h.requests.length,1);assert.equal(translated(saved(h)).length,26);
  if(reason==='switch-document'){
   assert.equal(translated(h.disk().find(doc=>doc.title==='Other source')).length,0);
   [...h.$('library').querySelectorAll('button')].find(button=>button.textContent.includes('Long offline source')).click();
  }
  const first=structuredClone(saved(h).segments.slice(0,26));h.$('mode-transcript').click();h.$('language-panel').open=true;
  await h.$('translate-document').onclick();assert.equal(h.requests.length,2);assert.deepEqual(ids(h.requests),fixture().segments.map(cue=>cue.id));
  assert.equal(translated(saved(h)).length,40);assert.deepEqual(saved(h).segments.slice(0,26),first);
 }finally{h.release();await run;await h.w.happyDOM.close();}
});

test('a failed later batch retries only remaining original cues and preserves completed results',async()=>{
 const h=setup(fixture(),{fail:2});try{
  await ready(h);await h.$('translate-document').onclick();assert.equal(h.requests.length,2);assert.equal(translated(saved(h)).length,26);assert.match(h.$('language-status').textContent,/Injected offline rejection/);
  const first=structuredClone(saved(h).segments.slice(0,26));h.clearFailure();await h.$('translate-document').onclick();
  assert.equal(h.requests.length,3);assert.deepEqual(h.requests[2],h.requests[1]);assert.deepEqual(saved(h).segments.slice(0,26),first);assert.equal(translated(saved(h)).length,40);
 }finally{await h.w.happyDOM.close();}
});

test('planning skips current saved translations, even if their original cue is no longer supported for new requests',async()=>{
 const source=fixture();source.segments[0].text='中'.repeat(4001);
 for(const cue of source.segments.slice(0,3))cue.translations={zh:{text:'Existing translation '+cue.id,source_text:cue.text,source_language:'en',document_language:'en',provider:'user'}};
 const h=setup(source);try{await ready(h);const before=structuredClone(saved(h).segments.slice(0,3));await h.$('translate-document').onclick();
  assert.deepEqual(h.requests.map(request=>request.segments.length),[26,11]);assert.deepEqual(ids(h.requests),source.segments.slice(3).map(cue=>cue.id));assert.deepEqual(saved(h).segments.slice(0,3),before);assert.equal(translated(saved(h)).length,40);
 }finally{await h.w.happyDOM.close();}
});

test('a manual translation saved during a bounded request still cannot be overwritten by its late reply',async()=>{
 const h=setup(fixture(),{hold:1});let run;try{
  await ready(h);run=h.$('translate-document').onclick();assert.equal(h.requests.length,1);
  h.w.CoconutTranslationReview.openEditor('offline-source','cue-0','zh');h.$('translation-edit-text').value='My reviewed translation';h.$('translation-edit-text').dispatchEvent(new h.w.Event('input'));
  await h.$('save-translation-edit').onclick(new h.w.Event('click'));h.release();await run;
  assert.equal(h.requests.length,1);assert.equal(saved(h).segments[0].translations.zh.text,'My reviewed translation');assert.equal(translated(saved(h)).length,1);assert.match(h.$('language-status').textContent,/已被人工修正或替换/);
 }finally{h.release();await run;await h.w.happyDOM.close();}
});
