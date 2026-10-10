import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startBridge } from '../desktop/server.mjs';

async function setup(t) {
  const calls = [];
  const providers = {status:async provider=>{calls.push(['status',provider]);return {ready:false,reason:'Test only'};},
    ask:async data=>{calls.push(['ask',data]);return {answer:'Result',citations:['a'],provider:'chatgpt_subscription'};},
    structured:async(_provider,input)=>{calls.push(['translate',JSON.parse(input)]);return {translations:[{id:'a',text:'译文'}]};},
    exclusive:async action=>action()};
  const server = await startBridge({port:0,providers});
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return {calls,server,origin:`http://127.0.0.1:${server.address().port}`};
}
const body = {consent:true,question:'Q',language:'en',provider:'codex',segments:[{id:'a',text:'Source'}]};
test('startup, assets and health are passive; declared capabilities match runtime',async t=>{
  const {calls,origin} = await setup(t);
  const health = await (await fetch(origin+'/api/health')).json();
  assert.equal(health.local_worker,false); assert.equal(health.runtime,'desktop-bridge');
  assert.equal(health.capabilities.local_agents,true); assert.equal(health.capabilities.media_import,false); assert.equal(health.capabilities.local_translation,false);
  const page = await fetch(origin+'/'); assert.equal(page.status,200); const index=await page.text(); assert.match(index,/Coconut/);
  for(const [,src] of index.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]+)"/g)){
    const script=await fetch(origin+'/'+src);assert.equal(script.status,200,'index-declared asset '+src);const payload=await script.arrayBuffer();
    const head=await fetch(origin+'/'+src,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-type'),script.headers.get('content-type'));
    assert.equal((await head.arrayBuffer()).byteLength,0);
    if(src.startsWith('library-store.js'))assert.match(Buffer.from(payload).toString('utf8'),/CoconutLibraryStore/);
  }
  assert.equal((await fetch(origin+'/summary.js')).status,200);
  for(const name of ['passages.js','passage-playback.js','translation-review.js'])assert.equal((await fetch(origin+'/'+name)).status,200);
  assert.equal((await fetch(origin+'/updates.js')).status,200);
  const mark=await fetch(origin+'/coconut-mark.png');assert.equal(mark.status,200);assert.equal(mark.headers.get('content-type'),'image/png');
  assert.deepEqual(new Uint8Array(await mark.arrayBuffer()).slice(0,8),new Uint8Array([137,80,78,71,13,10,26,10]));
  assert.match(page.headers.get('content-security-policy'),/script-src 'self'/); assert.equal(page.headers.get('x-frame-options'),'DENY');
  assert.equal((await fetch(origin+'/api/jobs')).status,501); assert.equal(calls.length,0);
  assert.equal((await fetch(origin+'/package.json')).status,404);
  assert.equal((await fetch(origin+'/.env')).status,404);
  assert.equal((await fetch(origin+'/api/language-tools',{method:'HEAD'})).status,404); assert.equal(calls.length,0);
});
test('only explicit status endpoint probes agent status, no inference',async t=>{
  const {calls,origin} = await setup(t); const status = await (await fetch(origin+'/api/language-tools')).json();
  assert.equal(status.local_translation,false); assert.equal(status.ai.codex.ready,false);
  assert.deepEqual(calls,[['status','codex'],['status','claude']]);
});
test('cross-origin, opaque-origin, missing Origin and DNS rebinding cannot start a local agent',async t=>{
  const {calls,origin,server} = await setup(t);
  for (const headers of [{Origin:'https://attacker.example'},{Origin:'null'},{}, {Origin:origin,'Sec-Fetch-Site':'cross-site'}]) {
    const result = await fetch(origin+'/api/ask',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    assert.equal(result.status,403);
  }
  const wrongHost = await new Promise((resolve,reject)=>{
    const request = http.request({host:'127.0.0.1',port:server.address().port,path:'/api/health',headers:{Host:'attacker.example'}},response=>{response.resume();resolve(response.statusCode);});
    request.on('error',reject);request.end();
  });
  assert.equal(wrongHost,403); assert.equal(calls.length,0);
});
test('hosted reader cannot discover agent status through cross-site fetches',async t=>{
  const {calls,origin} = await setup(t);
  assert.equal((await fetch(origin+'/api/language-tools',{headers:{Origin:'https://yakihugo.github.io','Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal(calls.length,0);
});
test('consent and JSON validation happen before starting the provider',async t=>{
  const {calls,origin} = await setup(t);
  for (const [requestBody,type] of [[{...body,consent:false},'application/json'],[null,'application/json'],[body,'text/plain']]) {
    assert.equal((await fetch(origin+'/api/ask',{method:'POST',headers:{Origin:origin,'Content-Type':type},body:JSON.stringify(requestBody)})).status,400);
  }
  assert.equal(calls.length,0);
  const sent = await fetch(origin+'/api/ask',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal(sent.status,200); assert.equal((await sent.json()).answer,'Result'); assert.equal(calls.length,1);
});
test('request size is bounded and unsupported processing is explicitly unavailable',async t=>{
  const {calls,origin} = await setup(t);
  const tooBig = await fetch(origin+'/api/ask',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'x'.repeat(1024*1024+1)});
  assert.equal(tooBig.status,413);
  const disabled = await fetch(origin+'/api/uploads',{method:'POST',headers:{Origin:origin}});
  assert.equal(disabled.status,501); assert.match((await disabled.json()).error,/轻量版/); assert.equal(calls.length,0);
});
test('translation endpoint preserves complete V2 source provenance without actual inference',async t=>{
  const {calls,origin} = await setup(t);
  const result = await fetch(origin+'/api/translate-subscription',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
    body:JSON.stringify({consent:true,source:'en',target:'zh',segments:[{id:'a',text:'Source'}]})});
  assert.equal(result.status,200);
  const output = await result.json(); assert.equal(output.translations[0].context_version,2); assert.equal(output.translations[0].source_text,'Source');
  assert.equal(calls.length,1); assert.equal(calls[0][0],'translate');
});
test('desktop shutdown synchronously cancels active provider work before process exit',async t=>{
  let requestSignal, notifyStarted;
  const started = new Promise(resolve=>{notifyStarted=resolve;});
  const providers = {ask:async(_data,{signal})=>{
    requestSignal=signal;notifyStarted();
    return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('Canceled')),{once:true}));
  }};
  const server=await startBridge({port:0,providers});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const request=fetch(origin+'/api/ask',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}).catch(()=>null);
  await started;
  server.shutdown();
  assert.equal(requestSignal.aborted,true);
  await request;
});

test('source imports require same-origin JSON and route only to bounded podcast service',async t=>{
 const calls=[];
 const source={discover:async(data,{signal})=>{calls.push(['discover',data,signal]);return {kind:'feed',episodes:[]};},importEpisode:async data=>{calls.push(['import',data]);return {status:'needs_transcription'};},downloadMedia:async data=>{calls.push(['media',data]);return {body:Buffer.from('ID3 fixture'),type:'audio/mpeg',kind:'audio',filename:'podcast-audio'};}};
 const server=await startBridge({port:0,podcastSources:source,providers:{status:async()=>{throw new Error('Must not probe CLI');}}});t.after(()=>new Promise(resolve=>server.shutdown(resolve)));const origin=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(origin+'/api/health').then(r=>r.json())).capabilities.podcast_import,true);assert.equal(calls.length,0);
 for(const endpoint of ['discover','import','media']){
  assert.equal((await fetch(origin+'/api/podcasts/'+endpoint,{method:'POST',headers:{Origin:'https://attacker.example','Content-Type':'application/json'},body:'{}'})).status,403);
  const result=await fetch(origin+'/api/podcasts/'+endpoint,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({url:'https://publisher.example/feed'})});assert.equal(result.status,200);
  if(endpoint==='media'){assert.equal(result.headers.get('X-Coconut-Media-Kind'),'audio');assert.equal(await result.text(),'ID3 fixture');}
 }
 assert.deepEqual(calls.map(c=>c[0]),['discover','import','media']);assert.equal(calls[0][2].aborted,false);
});

test('caption acquisition is disabled unless the separately verified service is explicitly available',async t=>{
 const {origin}=await setup(t);const health=await (await fetch(origin+'/api/health')).json();assert.equal(health.capabilities.caption_import,false);
 const result=await fetch(origin+'/api/captions/import',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({url:'https://x.com/example/status/123'})});assert.equal(result.status,501);
});

test('caption endpoint has the same origin, type and cancellation boundary without AI consent',async t=>{
 let calls=0;const server=await startBridge({port:0,captionService:{available:true,importCaption:async(data,{signal})=>{calls++;assert.ok(signal instanceof AbortSignal);assert.equal(data.url,'https://x.com/example/status/123');return {status:'unavailable'};}}});
 t.after(()=>new Promise(resolve=>{server.shutdown(resolve);}));const origin=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await (await fetch(origin+'/api/health')).json()).capabilities.caption_import,true);assert.equal(calls,0);
 for(const Origin of ['https://attacker.example','null'])assert.equal((await fetch(origin+'/api/captions/import',{method:'POST',headers:{Origin,'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(origin+'/api/captions/import',{method:'POST',headers:{Origin:origin,'Content-Type':'text/plain'},body:'{}'})).status,400);assert.equal(calls,0);
 const result=await fetch(origin+'/api/captions/import',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({url:'https://x.com/example/status/123'})});assert.equal(result.status,200);assert.equal(calls,1);
});
