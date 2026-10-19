import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mountedSourceApp,wait} from './helpers/mounted-source-app.mjs';
const url='https://www.youtube.com/watch?v=abcdefghijk';
const diagnostic={stage:'metadata',reason:'transport_unavailable',requests_attempted:2,responses_received:0};
const panel=x=>x.w.document.querySelector('[aria-label="本次字幕读取结果"]');
const fixture=(get=()=>diagnostic)=>({service:{ingest:async()=>({protocolVersion:1,ingestion:{id:'failure',state:'blocked',source:{},error:{code:'network_unavailable',message:'字幕读取未完成',diagnostic:await get()}}})}});
test('blocked captions show request-scoped evidence and safe original action, preserve link and explicit retry',async()=>{
 const x=await mountedSourceApp(fixture(()=>({...diagnostic,raw:'secret https://private.invalid/token'})));try{
  x.open(url);await wait(()=>panel(x));assert.match(panel(x).textContent,/读取视频信息/);assert.match(panel(x).textContent,/尝试请求 2 次.*收到响应 0 次/s);assert.match(panel(x).textContent,/不能据此判断.*字幕/s);assert.doesNotMatch(panel(x).textContent,/secret|private.invalid|transport_unavailable/);
  const link=panel(x).querySelector('a');assert.equal(link.textContent,'打开原站');assert.equal(link.href,url);assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');assert.equal(x.requests.length,1);assert.equal(x.docs().length,0);assert.equal(x.w.document.querySelector('#source-url').value,url);
  x.button('重试上次读取').click();await wait(()=>x.requests.length===2&&panel(x));assert.equal(x.requests.length,2);
  x.input(x.w.document.querySelector('#source-url'),'https://publisher.example/feed');await wait(()=>!panel(x));assert.equal(x.docs().length,0);
 }finally{await x.w.happyDOM.close();}
});
test('retry clears old evidence and cancelled late response cannot restore it',async()=>{
 let hold,release;const x=await mountedSourceApp(fixture(async()=>{if(hold)await hold;return diagnostic;}));try{
  x.open(url);await wait(()=>panel(x));hold=new Promise(r=>release=r);x.button('重试上次读取').click();await wait(()=>x.button('取消读取'));assert.equal(panel(x),null);x.button('取消读取').click();release();await new Promise(r=>setTimeout(r,30));assert.equal(panel(x),null);assert.equal(x.requests.length,2);assert.equal(x.docs().length,0);
 }finally{release?.();await x.w.happyDOM.close();}
});
test('unknown counters are not zero; malformed diagnostics are omitted while source recovery stays available',async()=>{
 let value={stage:'helper_execution',reason:'helper_error',requests_attempted:null,responses_received:null};const x=await mountedSourceApp(fixture(()=>value));try{
  x.open(url);await wait(()=>panel(x));assert.match(panel(x).textContent,/请求与响应次数未知/);assert.doesNotMatch(panel(x).textContent,/请求 0 次/);
  value={...diagnostic,reason:'https://private.invalid/secret'};x.open(url);await wait(()=>x.requests.length===2&&panel(x)&&!panel(x).querySelector('[data-caption-diagnostic]'));assert.equal(panel(x).querySelector('[data-caption-diagnostic]'),null);assert.ok(panel(x).querySelector('a'));
 }finally{await x.w.happyDOM.close();}
});
test('failure helpers strictly allowlist observations and original source destinations',async()=>{
 const output=await build({entryPoints:['frontend/app/caption-failure.ts'],bundle:true,format:'esm',write:false,platform:'node'}),api=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].contents).toString('base64'));
 assert.deepEqual(api.captionFailureDiagnostic({...diagnostic,raw:'secret'}),diagnostic);
 for(const patch of [{stage:'arbitrary'},{reason:'arbitrary'},{stage:['metadata']},{reason:['transport_unavailable']},{requests_attempted:-1},{requests_attempted:33},{requests_attempted:1.5},{responses_received:3},{responses_received:null},{requests_attempted:null,responses_received:null}])assert.equal(api.captionFailureDiagnostic({...diagnostic,...patch}),null);
 for(const value of ['javascript:alert(1)','https://youtube.com.evil.test/watch?v=abcdefghijk','https://user:pass@youtube.com/watch?v=abcdefghijk','http://youtube.com/watch?v=abcdefghijk','https://youtube.com:444/watch?v=abcdefghijk','https://youtube.com/redirect?q=https://evil.test','https://b23.tv/a?url=https://evil.test','https://www.bilibili.com/video/BV1xx411c7mD?p=2','https://youtube.com/watch?v=abcdefghijk&v=lmnopqrstuv'])assert.equal(api.captionOriginalURL(value),null,value);
 assert.equal(api.captionOriginalURL(url+'&tracking=secret#hash'),url);
 assert.equal(api.captionOriginalURL('https://youtu.be/abcdefghijk?si=secret'),url);
 assert.equal(api.captionOriginalURL('https://b23.tv/AbC12'),'https://b23.tv/AbC12');
 assert.equal(api.captionOriginalURL('https://www.bilibili.com/video/BV1xx411c7mD?share=secret'),'https://www.bilibili.com/video/BV1xx411c7mD');
 assert.equal(api.captionOriginalURL('https://twitter.com/user/status/123?s=20'),'https://x.com/user/status/123');
});

test('transport failures keep a safe original action; unrelated sources never receive one',async()=>{
 const x=await mountedSourceApp({service:{ingest:async()=>{throw Error('来源服务未响应');}}});try{
  x.open(url);await wait(()=>panel(x));assert.equal(panel(x).querySelector('a').href,url);assert.equal(x.requests.length,1);
  x.input(x.w.document.querySelector('#source-url'),'https://publisher.example/feed');await wait(()=>!panel(x));x.open('https://publisher.example/feed');await wait(()=>x.requests.length===2&&x.w.document.querySelector('.source-error').textContent==='来源服务未响应');assert.equal(panel(x),null);
 }finally{await x.w.happyDOM.close();}
});
