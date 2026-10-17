import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';
const bundle=await build({entryPoints:['frontend/app/ai-request.ts'],bundle:true,format:'esm',platform:'node',write:false});const {createAiRequest}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
for(const local of [true,false])test('actual request adapter bounds local diagnostic disclosure: '+local,async()=>{const payload={error:'safe error',localProviderDetails:{message:'private diagnostic',upstreamCode:'quota',secret:'never carry'}};const request=createAiRequest(async()=>({ok:false,json:async()=>payload}),()=>local);await assert.rejects(request('ask',{question:'test'}),error=>{assert.equal(error.message,'safe error');assert.equal(error.localProviderDetails?.message,local?'private diagnostic':undefined);assert.equal(error.localProviderDetails?.secret,undefined);return true;});});
test('request adapter forwards the exact abort signal to fetch and propagates cancellation',async()=>{
 const controller=new AbortController();let observed;
 const request=createAiRequest(async(url,init)=>new Promise((resolve,reject)=>{observed=init.signal;assert.equal(url,'api/ask');observed.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});}),()=>true);
 const pending=request('ask',{question:'Authored'},controller.signal);assert.equal(observed,controller.signal);controller.abort();await assert.rejects(pending,{name:'AbortError'});
});
