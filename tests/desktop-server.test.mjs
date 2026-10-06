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
  const page = await fetch(origin+'/'); assert.equal(page.status,200); assert.match(await page.text(),/Coconut/);
  assert.match(page.headers.get('content-security-policy'),/script-src 'self'/); assert.equal(page.headers.get('x-frame-options'),'DENY');
  assert.equal((await fetch(origin+'/api/jobs')).status,200); assert.equal(calls.length,0);
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
