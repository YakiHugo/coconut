import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { createPodcastSmokeDiagnostics } from './helpers/podcast-smoke-diagnostics.mjs';
import { createPodcastSources } from '../desktop/podcast-sources.mjs';
const url='https://publisher.example.org/feed.xml';
const lookup=async()=>[{address:'93.184.216.34',family:4}];
function transport(responses) {
 const calls=[];
 const request=(target,options,callback)=>{
  calls.push({target,options});const req=new EventEmitter();
  req.end=()=>queueMicrotask(()=>{
   const spec=responses.shift();assert.ok(spec,'Unexpected fixture request');
   if(spec.error){req.emit('error',spec.error);return;}
   if(spec.stall==='headers'){options.signal.addEventListener('abort',()=>req.emit('error',Object.assign(new Error('secret'),{code:'ABORT_ERR'})),{once:true});return;}
   const stream=spec.stall==='body'?new Readable({read(){}}):Readable.from([Buffer.from(spec.body||'authored fixture')]);
   stream.statusCode=spec.status||200;stream.headers={'content-type':'text/plain',...(spec.headers||{})};callback(stream);
   if(spec.stall==='body')options.signal.addEventListener('abort',()=>{stream.destroy(new Error('secret'));req.emit('error',Object.assign(new Error('secret'),{code:'ABORT_ERR'}));},{once:true});
  });return req;
 };
 return {calls,request};
}
function setup(responses,overrides={}) {const t=transport(responses);return {...t,diagnostics:createPodcastSmokeDiagnostics({lookup,request:t.request,...overrides})};}
async function failure(diagnostics,options={}) {try{await diagnostics.fetchResource(url,{types:new Set(['text/plain']),...options});assert.fail('Expected fixture rejection');}catch(error){return diagnostics.failure(error);}}
const clean=value=>{const text=JSON.stringify(value);for(const secret of ['secret','publisher.example','source-body','/private/','raw-message','X-Token'])assert.ok(!text.includes(secret),text);};

test('HTTP rejection records one attempt and status without leaking source, headers or body',async()=>{
 const {diagnostics,calls}=setup([{status:403,body:'source-body secret',headers:{'X-Token':'secret'}}]);const result=await failure(diagnostics);
 assert.equal(result.reason,'http_status_rejected');assert.equal(result.fetches_attempted,1);assert.equal(result.last_request.requests_attempted,1);assert.equal(result.last_request.responses_received,1);assert.equal(result.last_request.http_status,403);assert.equal(result.last_request.timeout,'none');assert.equal(result.last_request.timeout_ms,20000);assert.equal(result.last_request.outcome,'failure');assert.equal(calls.length,1);clean(result);
 assert.equal(calls[0].options.agent,false);assert.deepEqual(calls[0].options.headers,{'User-Agent':'Coconut/0.1 public-podcast-reader','Accept':'*/*','Accept-Encoding':'identity'});
});
test('DNS and transport errors retain only fixed approved codes, with no retry or raw diagnostics',async()=>{
 for(const [code,expected] of [['ENOTFOUND','ENOTFOUND'],['private-secret-code',null]]){
  const {diagnostics,calls}=setup([],{lookup:async()=>{throw Object.assign(new Error('raw-message /private/ secret'),{code});}});const result=await failure(diagnostics);
  assert.equal(result.reason,'dns_or_connection_failed');assert.equal(result.last_request.transport_code,expected);assert.equal(result.last_request.requests_attempted,0);assert.equal(calls.length,0);clean(result);
 }
 const {diagnostics,calls}=setup([{error:Object.assign(new Error('raw-message secret'),{code:'ECONNRESET'})}]);const result=await failure(diagnostics);
 assert.equal(result.reason,'connection_failed');assert.equal(result.last_request.transport_code,'ECONNRESET');assert.equal(result.last_request.responses_received,0);assert.equal(result.last_request.timeout,'none');assert.equal(calls.length,1);clean(result);
});
test('real resource deadlines and caller cancellation remain distinct for DNS, headers and body',async()=>{
 const hold=setTimeout(()=>{},1000);
 try{
  for(const stage of ['dns','headers','body'])for(const caller of ['none','deadline','cancel']){
   const controller=new AbortController(),signal=caller==='deadline'?AbortSignal.timeout(5):controller.signal;
   const {diagnostics,calls}=setup(stage==='dns'?[]:[{stall:stage}],stage==='dns'?{lookup:()=>new Promise(()=>{})}:{});
   const pending=failure(diagnostics,{timeoutMs:20,signal});if(caller==='cancel')setTimeout(()=>controller.abort(new Error('secret cancellation')),5);
   const result=await pending;
   assert.equal(result.reason,'request_aborted_or_timeout');assert.equal(result.last_request.timeout,caller==='none'?'resource_deadline':caller==='deadline'?'caller_deadline':'caller_cancelled');assert.equal(result.last_request.timeout_ms,20);assert.equal(calls.length,stage==='dns'?0:1);clean(result);
  }
 }finally{clearTimeout(hold);}
});
test('redirect observation preserves bounded transport and does not leak targets',async()=>{
 const {diagnostics,calls}=setup([{status:302,headers:{location:'https://cdn.example.org/secret?unrelated=secret'}},{status:503,body:'source-body'}]);const result=await failure(diagnostics);
 assert.equal(result.last_request.requests_attempted,2);assert.equal(result.last_request.responses_received,2);assert.equal(result.last_request.http_status,503);assert.equal(result.reason,'http_status_rejected');assert.equal(calls.length,2);clean(result);
 const loop=setup(Array.from({length:5},()=>({status:302,headers:{location:'/again'}})));const stopped=await failure(loop.diagnostics);assert.equal(stopped.reason,'invalid_redirect');assert.equal(loop.calls.length,5);
});
test('policy failures and unknown errors stay failed and unclassified without invented timeout',async()=>{
 const {diagnostics,calls}=setup([],{lookup:async()=>[{address:'127.0.0.1',family:4}]});const result=await failure(diagnostics);
 assert.equal(result.reason,'non_public_address');assert.equal(calls.length,0);assert.equal(result.last_request.timeout,'none');
 const unknown=diagnostics.failure(Object.assign(new Error('raw-message secret'),{code:'private-secret-code',stack:'/private/path'}));assert.equal(unknown.reason,'unclassified_failure');clean(unknown);
 const assertion=diagnostics.failure(Object.assign(new Error('secret actual and expected'),{code:'ERR_ASSERTION',actual:'source-body',expected:'secret'}));assert.equal(assertion.reason,'assertion_failed');clean(assertion);
});
test('actual importer/parser failure is distinguished from successful transcript fetch and assertion failures',async()=>{
 const rss=await readFile(new URL('./fixtures/podcasts/rss.xml',import.meta.url),'utf8');
 const {diagnostics,calls}=setup([{headers:{'content-type':'application/rss+xml'},body:rss},{headers:{'content-type':'application/rss+xml'},body:rss},{headers:{'content-type':'text/vtt'},body:'WEBVTT\n\ninvalid source-body secret'}]);
 const sources=createPodcastSources({fetchResource:diagnostics.fetchResource}),feed=await sources.discover({url});
 let caught;try{await sources.importEpisode({feedUrl:feed.feed_url,episodeId:feed.episodes[0].id});}catch(error){caught=error;}
 assert.ok(caught);const result=diagnostics.failure(caught);assert.equal(result.reason,'invalid_publisher_transcript');assert.equal(result.fetches_attempted,3);assert.equal(result.last_request.fetch_index,3);assert.equal(result.last_request.http_status,200);assert.equal(result.last_request.outcome,'success');assert.equal(result.last_request.timeout,'none');assert.equal(calls.length,3);clean(result);
});
test('smoke gate keeps deadlines, targets, assertions and nonzero failure exit',async()=>{
 const smoke=await readFile(new URL('./podcast-public-smoke.mjs',import.meta.url),'utf8');
 assert.match(smoke,/AbortSignal\.timeout\(180000\)/);assert.match(smoke,/stage='publisher transcript assertions'/);assert.match(smoke,/assert\.equal\(result\.status,'ready'\)/);assert.match(smoke,/assert\.ok\(result\.document\.segments\.length>10\)/);assert.match(smoke,/process\.exitCode=1/);assert.match(smoke,/diagnostic:diagnostics\.failure\(error\)/);
});
