import test from 'node:test';
import assert from 'node:assert/strict';
import {providerFailure} from '../desktop/provider-errors.mjs';
import {startBridge} from '../desktop/server.mjs';
const lines=(...events)=>events.map(JSON.stringify).join('\n');
test('explicit failure keeps upstream fields without guessing status or cause from prose',()=>{
 const error=providerFailure('codex',{code:1,stdout:lines({type:'turn.started'},{type:'error',message:'Request failed',code:'service_unavailable'},{type:'turn.failed',error:{message:'Service is temporarily unavailable',code:'service_unavailable',status_code:503}}),stderr:'private stderr'});
 assert.equal(error.code,'provider_failed');
 assert.equal(error.providerDiagnostics.upstreamCode,'service_unavailable');
 assert.equal(error.providerDiagnostics.upstreamStatus,503);
 assert.match(error.message,/Service is temporarily unavailable/);
 const unknown=providerFailure('codex',{code:1,stdout:lines({type:'error',message:'HTTP 429 maybe quota, model or auth'})});
 assert.equal(unknown.providerDiagnostics.upstreamStatus,null);
 assert.equal(unknown.providerDiagnostics.upstreamCode,null);
});
test('failure events override exit zero; noisy malformed output never becomes diagnostic text',()=>{
 const error=providerFailure('codex',{code:0,stdout:'PRIVATE NOISE\n{bad\n'+lines({type:'turn.failed',error:{message:'Failed to connect',code:'connection_error'}})});
 assert.equal(error.providerDiagnostics.malformedLines,2);assert.match(error.message,/Failed to connect/);
 assert.ok(!JSON.stringify(error).includes('PRIVATE'));
 assert.equal(providerFailure('codex',{code:0,stdout:lines({type:'turn.completed'})}),null);
 const generic=providerFailure('codex',{code:1,stdout:'private prompt',stderr:'private credentials'});
 assert.equal(generic.providerDiagnostics.message,null);assert.equal(generic.providerDiagnostics.stderrBytes,19);
});
test('diagnostics redact inputs, credentials, paths and URLs and remain bounded',()=>{
 for(const secret of ['private transcript sentence','private question']){
  const error=providerFailure('codex',{code:1,stdout:lines({type:'error',message:'Rejected '+secret})},JSON.stringify({question:'private question',transcript:[{text:'private transcript sentence'}]}));
  assert.ok(!JSON.stringify(error).includes(secret));assert.ok(!error.message.includes(secret));
 }
 for(const value of ['Authorization: Bearer secret-value','api_key=secret-value','password: secret-value','https://host/private?token=secret-value','/Users/person/private file.txt','C:\\Users\\person\\private.txt','sk-secret-value']){
  const error=providerFailure('codex',{code:1,stdout:lines({type:'error',message:value}),stderr:value.repeat(1000)});
  assert.ok(!JSON.stringify(error).includes('secret-value'));assert.ok(!JSON.stringify(error).includes('person'));
 }
 const error=providerFailure('codex',{code:1,stdout:lines({type:'error',message:'Error. '.repeat(10000),code:'x'.repeat(1000)}),stderr:'x'.repeat(500000)});
 assert.ok(error.message.length<=300);assert.ok(JSON.stringify(error).length<1200);assert.equal(error.providerDiagnostics.upstreamCode,null);
});
test('Claude explicit error envelope carries the same bounded diagnostics',()=>{
 const error=providerFailure('claude',{code:1,stdout:lines({type:'result',subtype:'error_during_execution',is_error:true,error:{message:'Request refused',code:'request_refused'}})});
 assert.equal(error.providerDiagnostics.provider,'claude');assert.equal(error.providerDiagnostics.upstreamCode,'request_refused');
});
test('API separates Coconut HTTP 400 from explicit upstream status and returns diagnostic code',async t=>{
 const failure=providerFailure('codex',{code:1,stdout:lines({type:'turn.failed',error:{message:'Service unavailable',code:'service_unavailable',status:503}})});
 const server=await startBridge({port:0,providers:{ask:async()=>{throw failure;}}});
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const origin='http://127.0.0.1:'+server.address().port;
 const result=await fetch(origin+'/api/ask',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({consent:true})});
 const data=await result.json();
 assert.equal(result.status,400);assert.equal(data.localHttpStatus,400);assert.equal(data.code,'provider_failed');assert.equal(data.providerDiagnostics.upstreamStatus,503);assert.match(data.error,/Service unavailable/);
});
test('unknown prose and error codes cannot disclose partial sources, IDs or arbitrary credentials',()=>{
 const input=JSON.stringify({transcript:[{id:'cust-secret-id',text:'The merger price is 173 million dollars and will be announced next Monday.'}]});
 for(const message of ['Rejected excerpt: The merger price is 173 million dollars','cust-secret-id','MySecretCredential123','paraphrased source detail']){
  const error=providerFailure('codex',{code:1,stdout:lines({type:'turn.failed',error:{message,code:'MySecretCredential123'}})},input);
  assert.equal(error.providerDiagnostics.message,null);assert.equal(error.providerDiagnostics.upstreamCode,null);
  assert.equal(error.providerDiagnostics.unrecognizedDetailsOmitted,true);
  assert.ok(!JSON.stringify(error).includes(message));assert.ok(!error.message.includes(message));
 }
});
test('earlier structured code is retained when terminal failure only supplies a safe message',()=>{
 const error=providerFailure('codex',{code:1,stdout:lines({type:'error',code:'rate_limit_exceeded',status_code:429},{type:'turn.failed',error:{message:'Rate limit exceeded'}})});
 assert.equal(error.providerDiagnostics.upstreamCode,'rate_limit_exceeded');assert.equal(error.providerDiagnostics.upstreamStatus,429);
 assert.equal(error.providerDiagnostics.message,'Rate limit exceeded');
});
test('transient local details retain unknown error prose but redact standard secrets and bound text',()=>{
 const result=message=>providerFailure('codex',{code:1,stdout:lines({type:'error',message,code:'new_provider_error'})},JSON.stringify({question:'my private question',transcript:[{id:'cue',text:'my private source'}]}));
 assert.equal(result('An unfamiliar provider error').localProviderDetails.message,'An unfamiliar provider error');
 for(const message of ['Authorization: Bearer secret-value','api_key=secret-value','/Users/person/private file.txt','https://host/private?token=secret-value','my private source','my private question']){
  const detail=JSON.stringify(result(message).localProviderDetails);assert.ok(!detail.includes('secret-value'));assert.ok(!detail.includes('person'));assert.ok(!detail.includes('my private'));
 }
 assert.ok(result('Long prose. '.repeat(1000)).localProviderDetails.message.length<=180);
 assert.ok(!Object.keys(result('Private diagnostic')).includes('localProviderDetails'));
});
test('desktop packaging includes the provider diagnostics dependency',async()=>{
 const {readFile}=await import('node:fs/promises');
 const packaging=await readFile(new URL('../desktop/package.mjs',import.meta.url),'utf8');
 assert.match(packaging,/'providers\.mjs','provider-errors\.mjs'/);
});
