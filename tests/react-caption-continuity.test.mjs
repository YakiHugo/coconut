import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {captionContinuityFixture,captionFixtureURL as url} from './fixtures/caption-continuity.mjs';
import {mountedSourceApp,wait} from './helpers/mounted-source-app.mjs';
const region=x=>x.w.document.querySelector('[aria-label="字幕解析检查"]');
test('actual caption service language recovery carries explicit choice and retains URL without guessing',async()=>{
 const f=captionContinuityFixture(),x=await mountedSourceApp(f);try{
  x.open(url);await wait(()=>x.w.document.querySelector('[aria-label="选择视频原语言"]'));
  assert.equal(x.docs().length,0);assert.equal(x.button('按所选原语言重试').disabled,true);assert.deepEqual(f.requests.map(r=>r.language),[null]);
  x.button('我的内容 0').click();await wait(()=>x.w.document.querySelector('.library-page'));await x.discover();assert.equal(x.w.document.querySelector('#source-url').value,url);
  const select=x.w.document.querySelector('[aria-label="选择视频原语言"] select');assert.deepEqual([...select.options].map(o=>o.value),['','en','fr']);x.select(select,'en');await wait(()=>!x.button('按所选原语言重试').disabled);
  x.button('按所选原语言重试').click();await wait(()=>x.docs().length===1);assert.deepEqual(f.requests.map(r=>r.language),[null,'en']);assert.equal(x.docs()[0].language,'en');assert.equal(x.docs()[0].source_url,url);
  await x.discover();assert.equal(x.w.document.querySelector('#source-url').value,url);x.input(x.w.document.querySelector('#source-url'),'https://x.com/other/status/999');await wait(()=>!x.w.document.querySelector('[aria-label="选择视频原语言"]'));assert.equal(x.docs().length,1);
 }finally{await x.w.happyDOM.close();}
});
test('actual partial SRT requires review, cancellation saves nothing, confirmation saves remaining source',async()=>{
 const f=captionContinuityFixture();f.state.mode='partial';const x=await mountedSourceApp(f);try{
  x.open(url);await wait(()=>region(x));assert.equal(x.docs().length,0);assert.match(region(x).textContent,/时间格式无效.*Missing authored detail 1/s);assert.match(region(x).textContent,/片段无可读文字/);assert.equal(region(x).querySelector('script'),null);assert.equal(x.button('加入书架'),undefined);
  x.button('取消本次导入').click();await wait(()=>!region(x));assert.equal(x.docs().length,0);assert.equal(x.w.document.querySelector('#source-url').value,url);
  x.open(url);await wait(()=>region(x));x.button('保留剩余文字稿，继续').click();await wait(()=>x.docs().length===1);const saved=x.docs()[0];assert.equal(saved.segments.length,2);assert.equal(saved.diagnostics,undefined);assert.equal(saved.source_url,url);
  await x.discover();x.open(url);await wait(()=>region(x));assert.equal(x.w.document.querySelector('.source-project-choice'),null);x.button('取消本次导入').click();assert.deepEqual(x.docs()[0],saved);
 }finally{await x.w.happyDOM.close();}
});
test('existing project is untouched until both loss review and explicit existing-project choice',async()=>{
 const f=captionContinuityFixture();f.state.mode='clean';const document=(await f.service.ingest({protocolVersion:1,source:{kind:'url',url}})).ingestion.transcript.document;document.key='original';document.project_note='Keep original note';f.state.mode='partial';const x=await mountedSourceApp(f,[document]);try{
  const original=x.docs()[0];x.open(url);await wait(()=>region(x));assert.deepEqual(x.docs()[0],original);x.button('保留剩余文字稿，继续').click();await wait(()=>x.w.document.querySelector('.source-project-choice'));assert.deepEqual(x.docs()[0],original);x.button('继续已有项目 · original').click();await wait(()=>x.w.document.querySelector('.reader-workspace'));assert.deepEqual(x.docs()[0],original);
 }finally{await x.w.happyDOM.close();}
});
test('fatal parse remains blocked; absent helper choices are honest; stale cancelled requests never add',async()=>{
 const f=captionContinuityFixture();f.state.mode='fatal';const x=await mountedSourceApp(f);let release;try{
  x.open(url);await wait(()=>x.w.document.querySelector('.source-error').textContent);assert.equal(x.docs().length,0);assert.equal(region(x),null);
  f.state.mode='missing_choices';x.open(url);await wait(()=>x.w.document.body.textContent.includes('没有返回可选语言'));assert.equal(x.w.document.querySelector('[aria-label="选择视频原语言"] select'),null);assert.equal(x.docs().length,0);
  f.state.mode='partial';f.state.hold=new Promise(r=>release=r);x.open(url);await wait(()=>x.button('取消读取'));x.button('取消读取').click();release();f.state.hold=null;await new Promise(r=>setTimeout(r,25));assert.equal(region(x),null);assert.equal(x.docs().length,0);
 }finally{release?.();await x.w.happyDOM.close();}
});
test('loss classification gates dropped cues, not every informational diagnostic',async()=>{
 const output=await build({entryPoints:['frontend/app/caption-receipt.ts'],bundle:true,format:'esm',write:false,platform:'node'}),api=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].contents).toString('base64'));
 assert.equal(api.hasCaptionLoss([{category:'metadata_note'}]),false);assert.equal(api.hasCaptionLoss([{category:'malformed_timing'}]),true);assert.deepEqual(api.captionLanguageChoices(['en','en','https://secret.example','fr']),['en','fr']);
});
