import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startBridge} from '../desktop/server.mjs';
async function setup(t,enabled=true){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-library-api-'));const server=await startBridge({port:0,...enabled?{libraryDirectory:directory}:{},providers:{status(){throw Error('No CLI probing');}}});t.after(async()=>{await new Promise(resolve=>server.shutdown(resolve));await fs.rm(directory,{recursive:true,force:true});});const origin=`http://127.0.0.1:${server.address().port}`;return {origin,server,get:url=>fetch(origin+url),post:(data,headers={Origin:origin,'Content-Type':'application/json'})=>fetch(origin+'/api/v1/library/commit',{method:'POST',headers,body:JSON.stringify(data)})};}
test('opt-in discovery never claims browser migration or changes default reader authority',async t=>{const {get}=await setup(t,false);const status=await(await get('/api/v1/library')).json();assert.equal(status.enabled,false);assert.equal(status.browserMigration,'not_started');assert.equal((await get('/api/health')).status,200);assert.equal((await get('/api/v1/library/catalog?protocolVersion=1')).status,503);});
test('versioned API persists snapshots and handles catalog, conflicts, unknown keys and origin boundaries',async t=>{
 const {get,post,origin}=await setup(t),status=await(await get('/api/v1/library')).json();assert.equal(status.enabled,true);assert.equal(status.browserMigration,'not_started');
 const input={protocolVersion:1,epoch:status.epoch,action:'put',key:'a',receiptKey:'create-a',expected:null,document:{key:'a',notes:['private'],translations:{en:'authored'}}};
 for(const Origin of [undefined,'null','https://attacker.example'])assert.equal((await post(input,{'Content-Type':'application/json',...(Origin?{Origin}:{})})).status,403);
 assert.equal((await post(input,{Origin:origin,'Content-Type':'text/plain'})).status,400);
 assert.equal((await post({...input,protocolVersion:2})).status,400);
 const saved=await post(input);assert.equal(saved.status,200);const receipt=await saved.json();assert.equal(receipt.token.revision,1);
 assert.deepEqual(await(await post(input)).json(),receipt);
 assert.equal((await post({...input,receiptKey:'stale'})).status,409);
 assert.equal((await get('/api/v1/library/document?key=a')).status,400);
 assert.deepEqual((await(await get('/api/v1/library/document?protocolVersion=1&key=a')).json()).record.document,input.document);
 assert.equal((await get('/api/v1/library/document?protocolVersion=1&key=missing')).status,404);
 const catalog=await(await get('/api/v1/library/catalog?protocolVersion=1')).json();assert.equal(catalog.entries.length,1);assert.equal(catalog.sequence,1);
 assert.equal((await get('/api/v1/library/catalog?protocolVersion=1&epoch=other')).status,409);
 assert.equal((await fetch(origin+'/api/v1/library',{headers:{Origin:'https://attacker.example'}})).status,403);
 assert.equal((await fetch(origin+'/api/v1/library/commit',{method:'DELETE',headers:{Origin:origin}})).status,405);
 assert.equal((await get('/api/v1/library/unknown')).status,404);
});
test('failed initialization leaves health and reader available and reports disabled library',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-library-broken-'));await fs.writeFile(path.join(directory,'library.sqlite'),'authored non-database content',{mode:0o600});
 const server=await startBridge({port:0,libraryDirectory:directory});t.after(async()=>{await new Promise(resolve=>server.shutdown(resolve));await fs.rm(directory,{recursive:true,force:true});});const origin=`http://127.0.0.1:${server.address().port}`;
 const status=await(await fetch(origin+'/api/v1/library')).json();assert.equal(status.enabled,false);assert.equal(status.unavailable.code,'library_unavailable');
 assert.equal((await fetch(origin+'/')).status,200);assert.equal((await(await fetch(origin+'/api/health')).json()).capabilities.canonical_library,false);
 assert.equal(await fs.readFile(path.join(directory,'library.sqlite'),'utf8'),'authored non-database content',{mode:0o600});
});
test('catalog continuation requires identity and sequence; request bodies are byte bounded',async t=>{
 const {get,origin}=await setup(t);
 assert.equal((await get('/api/v1/library/catalog?protocolVersion=1&after=a')).status,400);
 const http=await import('node:http');const status=await new Promise((resolve,reject)=>{const req=http.request(origin+'/api/v1/library/commit',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','Content-Length':17*1024*1024}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end('{}');});assert.equal(status,413);
});
test('older Node capability gate does not load SQLite or prevent serving the reader',async()=>{
 const {spawnSync}=await import('node:child_process');
 const script=`Object.defineProperty(process.versions,'node',{value:'22.0.0'});const {startBridge}=await import('./desktop/server.mjs');const server=await startBridge({port:0,libraryDirectory:'/unused-runtime-gated-library'});const origin='http://127.0.0.1:'+server.address().port;const status=await(await fetch(origin+'/api/v1/library')).json();if(status.enabled||status.unavailable.code!=='runtime_unsupported'||(await fetch(origin+'/')).status!==200)process.exitCode=1;await new Promise(resolve=>server.shutdown(resolve));`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);
});
test('malformed UTF-8 is rejected before any receipt or mutation',async t=>{
 const {get,origin}=await setup(t),status=await(await get('/api/v1/library')).json();
 const prefix=JSON.stringify({protocolVersion:1,epoch:status.epoch,action:'put',key:'a',receiptKey:'bad-utf8',expected:null,document:{key:'a',notes:'TOKEN'}}).split('TOKEN');
 const body=Buffer.concat([Buffer.from(prefix[0]),Buffer.from([0xc3,0x28]),Buffer.from(prefix[1])]);
 const response=await fetch(origin+'/api/v1/library/commit',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body});assert.equal(response.status,400);
 assert.equal((await(await get('/api/v1/library')).json()).sequence,0);assert.equal((await get('/api/v1/library/document?protocolVersion=1&key=a')).status,404);
});
