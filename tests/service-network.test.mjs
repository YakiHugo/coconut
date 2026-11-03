import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createPublicFetcher} from '../desktop/public-http.mjs';
const url='https://www.xiaoyuzhoufm.com/episode/authored';
function fixture(responses){const calls=[];return {calls,request:(target,options,callback)=>{calls.push({target,options});const req=new EventEmitter();req.end=()=>queueMicrotask(()=>{const value=responses.shift(),res=Readable.from([Buffer.from(value.body||'authored')]);res.statusCode=value.status||200;res.headers=value.headers||{'content-type':'text/html'};callback(res);});return req;}};}
test('owner platform transport lets the system resolve Fake-IP without preempting the socket',async()=>{
 const fixtureResult=fixture([{}]);let lookups=0;
 const fetch=createPublicFetcher({ownerSources:true,lookup:async()=>{lookups++;return [{address:'198.18.1.211',family:4}];},request:fixtureResult.request});
 assert.equal((await fetch(url)).body.toString(),'authored');assert.equal(lookups,0);
 assert.equal(fixtureResult.calls[0].options.lookup,undefined);assert.ok(fixtureResult.calls[0].options.agent);
});
test('generic RSS and legacy callers keep the original destination policy',async()=>{
 for(const options of [{},{ownerSources:true}]){
  const fixtureResult=fixture([]),fetch=createPublicFetcher({...options,lookup:async()=>[{address:'198.18.1.211',family:4}],request:fixtureResult.request});
  await assert.rejects(fetch(options.ownerSources?'https://arbitrary.example/feed':url),/非公开/);assert.equal(fixtureResult.calls.length,0);
 }
});
test('standalone SOCKS settings fail configuration instead of silently bypassing the proxy',()=>{
 for(const name of ['HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy'])assert.throws(()=>createPublicFetcher({ownerSources:true,ownerNetwork:{mode:'environment',environment:{[name]:'socks5://127.0.0.1:7897'}}}),/SOCKS proxies are not supported/);
});
test('owner redirects remain HTTPS and inside the exact platform origins',async()=>{
 for(const target of ['https://127.0.0.1/private','https://evil.example/media','http://media.xyzcdn.net/audio','https://www.xiaoyuzhoufm.com.evil.example/audio']){
  const f=fixture([{status:302,headers:{location:target}}]);await assert.rejects(createPublicFetcher({ownerSources:true,request:f.request})(url));assert.equal(f.calls.length,1);
 }
 const f=fixture([{status:302,headers:{location:'https://media.xyzcdn.net/audio'}},{headers:{'content-type':'audio/mp4'},body:'bytes'}]);assert.equal((await createPublicFetcher({ownerSources:true,request:f.request})(url)).body.toString(),'bytes');
});
