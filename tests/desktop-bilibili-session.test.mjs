import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createBilibiliBrowserSession} from '../desktop/bilibili-browser-session.mjs';
import {startBridge} from '../desktop/server.mjs';

async function fixture(t,readSession){
 const directory=await mkdtemp(path.join(os.tmpdir(),'coconut-browser-session-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const edgeDirectory=path.join(directory,'Edge'),configuration=path.join(directory,'settings','session.json');
 await mkdir(path.join(edgeDirectory,'Default'),{recursive:true});await writeFile(path.join(edgeDirectory,'Default','Cookies'),'authored database placeholder');
 const options={python:'/fixture/python',platform:'darwin',edgeDirectory,configuration,readSession};
 return {session:await createBilibiliBrowserSession(options),options,configuration,edgeDirectory};
}
test('connecting remembers only the selected profile, refreshes credentials, and disconnects across restarts',async t=>{
 let reads=0;const {session,options,configuration}=await fixture(t,async()=>({SESSDATA:'fixture-'+(++reads)}));
 assert.equal((await session.status()).connected,false);assert.equal(reads,0);
 const connected=await session.connect('Default');assert.equal(connected.connected,true);assert.equal(reads,1);
 assert.ok(!JSON.stringify(connected).includes('SESSDATA'));
 assert.deepEqual(JSON.parse(await readFile(configuration,'utf8')),{browser:'edge',profile:'Default'});
 assert.deepEqual(await session.cookies(),{SESSDATA:'fixture-2'});
 const restarted=await createBilibiliBrowserSession(options);assert.equal((await restarted.status()).connected,true);assert.equal(reads,2);
 await restarted.disconnect();assert.equal(await restarted.cookies(),null);
 assert.equal((await (await createBilibiliBrowserSession(options)).status()).connected,false);
});
test('unselected profiles and symlink escapes cannot reach the credential reader',async t=>{
 let reads=0;const {session,edgeDirectory}=await fixture(t,async()=>{reads++;return {SESSDATA:'fixture'};});
 for(const id of ['../Default','/tmp/arbitrary','Profile 9999'])await assert.rejects(session.connect(id));
 await symlink(path.join(edgeDirectory,'Default'),path.join(edgeDirectory,'Profile 1'));
 await assert.rejects(session.connect('Profile 1'));assert.equal(reads,0);
});
test('disconnect invalidates a pending connection and prevents persistence',async t=>{
 let release;const {session,options}=await fixture(t,()=>new Promise(resolve=>{release=resolve;}));
 const connecting=session.connect('Default');const rejected=assert.rejects(connecting);
 while(!release)await new Promise(resolve=>setImmediate(resolve));
 await session.disconnect();release({SESSDATA:'fixture'});await rejected;
 assert.equal((await session.status()).connected,false);
 assert.equal((await (await createBilibiliBrowserSession(options)).status()).connected,false);
});
test('browser API requires same-origin POST, rejects credential payloads, and never returns cookies',async t=>{
 let reads=0;const {session}=await fixture(t,async()=>{reads++;return {SESSDATA:'PRIVATE_FIXTURE_TOKEN'};});
 const server=await startBridge({port:0,bilibiliSession:session,captionService:{available:true,providers:['bilibili']}});
 t.after(()=>server.shutdown());const origin='http://127.0.0.1:'+server.address().port;
 const post=(body,headers={Origin:origin})=>fetch(origin+'/api/captions/session',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await post({action:'connect',browser:'edge',profile:'Default'},{})).status,403);assert.equal(reads,0);
 assert.equal((await post({action:'connect',browser:'edge',profile:'Default',cookies:{SESSDATA:'injected'}})).status,400);assert.equal(reads,0);
 const response=await post({action:'connect',browser:'edge',profile:'Default'});assert.equal(response.status,200);
 assert.ok(!(await response.text()).includes('PRIVATE_FIXTURE_TOKEN'));assert.equal(reads,1);
 const status=await fetch(origin+'/api/captions/session').then(response=>response.json());assert.equal(status.connected,true);assert.ok(!JSON.stringify(status).includes('SESSDATA'));
 assert.equal((await post({action:'disconnect'})).status,200);assert.equal(await session.cookies(),null);
});
