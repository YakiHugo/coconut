import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {startBridge} from '../desktop/server.mjs';
import {privateProxyProfile,privateProxyFromEnvironment,authorizeClient} from '../desktop/client-access.mjs';
const Tasks=createRequire(import.meta.url)('../reader/task-client.js');
const profile={type:'tailscale-serve',origin:'https://reader.fixture.ts.net',ownerLogin:'owner@example.test',backendLabel:'我的测试电脑'};
const headers={Host:'reader.fixture.ts.net','Tailscale-User-Login':profile.ownerLogin,'X-Forwarded-Host':'reader.fixture.ts.net','X-Forwarded-Proto':'https'};
async function setup(t,options={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-private-')),calls=[];
 const providers={status:async()=>({ready:false,reason:'请在电脑上登录官方 CLI'}),ask:async data=>{calls.push(data);return {answer:'Summary',citations:['a']};},structured:async()=>({translations:[{id:'a',text:'译文'}]}),exclusive:async action=>action()};
 const server=await startBridge({port:0,libraryDirectory:path.join(directory,'library'),taskDirectory:path.join(directory,'tasks'),providers,privateProxy:profile,...options});
 t.after(async()=>{await server.shutdown();await fs.rm(directory,{recursive:true,force:true});});
 const request=(url='/api/health',{method='GET',extra={},body,remote=true}={})=>new Promise((resolve,reject)=>{
   const h={...(remote?headers:{Host:`127.0.0.1:${server.address().port}`}),...extra};
   if(body!==undefined)h['Content-Type']='application/json';
   const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:url,method,headers:h},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,text,data:()=>JSON.parse(text)}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
 });
 const post=(url,body,extra={})=>request(url,{method:'POST',body,extra:{Origin:profile.origin,...extra}});
 return {server,request,post,calls,directory};
}
test('profile is explicitly disabled by default and fails closed on partial/invalid configuration',async t=>{
 assert.equal(privateProxyFromEnvironment({}),null);
 for(const value of [{...profile,origin:'http://reader.fixture.ts.net'},{...profile,origin:profile.origin+'/'},{...profile,origin:'https://*.ts.net'},{...profile,ownerLogin:''},{...profile,ownerLogin:'a,b'},{...profile,backendLabel:'/home/owner'}])assert.throws(()=>privateProxyProfile(value));
 assert.throws(()=>privateProxyFromEnvironment({COCONUT_PRIVATE_ORIGIN:profile.origin}));
 const {request,calls}=await setup(t,{privateProxy:null});assert.equal((await request()).status,403);assert.equal((await request('/api/health',{remote:false})).status,200);assert.equal(calls.length,0);
});
test('owner authorization rejects wrong host, origin, identity, proxy-localhost downgrade, Funnel and duplicate headers',async t=>{
 const {request,server,calls}=await setup(t);
 for(const extra of [{Host:'attacker.example'},{Origin:'null'},{Origin:'https://attacker.example'},{'Tailscale-User-Login':'other@example.test'},{'Tailscale-User-Login':''},{'Tailscale-Funnel-Request':'?1'},{'Tailscale-Funnel-Request':''},{'X-Forwarded-Proto':'http'},{'X-Forwarded-Host':'other.example'},{Forwarded:'host=reader.fixture.ts.net'},{'Sec-Fetch-Site':'cross-site'},{Host:`localhost:${server.address().port}`},{'Tailscale-User-Login':[profile.ownerLogin,profile.ownerLogin]}])assert.equal((await request('/api/health',{extra})).status,403,JSON.stringify(extra));
 for(const extra of [{'X-Forwarded-For':'100.64.0.1'},{'Tailscale-User-Name':'Owner'},{Forwarded:'for=127.0.0.1'}])assert.equal((await request('/api/health',{remote:false,extra})).status,403);
 const fake={headers,rawHeaders:[],socket:{remoteAddress:'100.64.0.1'}};assert.equal(authorizeClient(fake,{port:server.address().port,profile:privateProxyProfile(profile)}),null);assert.equal(calls.length,0);
});
test('passive owner discovery exposes request capabilities and same library without disk paths or provider calls',async t=>{
 const {request,calls,directory}=await setup(t),remote=(await request()).data(),local=(await request('/api/health',{remote:false})).data();
 assert.equal(remote.client.mode,'private-owner');assert.equal(remote.client.backendLabel,profile.backendLabel);assert.equal(remote.client.capabilities.localMedia,false);assert.equal(remote.client.capabilities.libraryMigration,false);assert.equal(remote.client.capabilities.aiActions,true);assert.equal(remote.client.capabilities.backgroundTasks,true);
 assert.equal(remote.client.libraryId,local.client.libraryId);assert.notEqual(remote.client.id,local.client.id);assert.equal(remote.library_storage,undefined);assert.ok(!JSON.stringify(remote).includes(directory));
 assert.equal((await request('/api/v1/executor')).data().remoteSubmission,true);assert.equal((await request('/api/v1/executor',{remote:false})).data().remoteSubmission,false);
 assert.equal((await request('/')).status,200);assert.equal((await request('/api/v1/library')).status,200);assert.equal((await request('/api/v1/tasks')).status,200);assert.equal(calls.length,0);
 for(const url of ['/api/local-media','/api/local-media/opaque-token','/api/v1/library/migration?protocolVersion=1'])assert.equal((await request(url)).status,403);
});
test('owner library writes keep explicit Origin, CAS receipts and same shared library',async t=>{
 const {request,post,calls}=await setup(t),epoch=(await request('/api/v1/library')).data().epoch;
 const value={protocolVersion:1,epoch,action:'put',key:'a',receiptKey:'phone-note-1',expected:null,document:{key:'a',title:'Phone note',notes:{a:'My note'}}};
 assert.equal((await post('/api/v1/library/commit',value,{Origin:''})).status,403);
 const receipt=await post('/api/v1/library/commit',value);assert.equal(receipt.status,200);assert.deepEqual((await post('/api/v1/library/commit',value)).data(),receipt.data());
 const read=(await request('/api/v1/library/document?protocolVersion=1&key=a',{remote:false})).data();assert.equal(read.record.document.title,'Phone note');
 assert.equal((await post('/api/v1/library/commit',{...value,receiptKey:'conflict'})).status,409);assert.equal(calls.length,0);
});
test('owner explicit AI and background submissions retain consent and task idempotency',async t=>{
 const {post,request,calls}=await setup(t),body={consent:true,question:'Q',provider:'codex',segments:[{id:'a',text:'Source'}]};
 assert.equal((await post('/api/ask',{...body,consent:false})).status,400);assert.equal((await post('/api/ask',body,{Origin:''})).status,403);assert.equal(calls.length,0);
 assert.equal((await post('/api/ask',body)).status,200);assert.equal(calls.length,1);
 const value=Tasks.submission({key:'a',segments:body.segments},{revision:'1',provider:'codex',idempotencyKey:'phone-intent',consent:true});
 const first=await post('/api/v1/tasks',value);assert.equal(first.status,202);const duplicate=await post('/api/v1/tasks',value);assert.equal(duplicate.status,200);assert.equal(duplicate.data().task.taskId,first.data().task.taskId);
 for(let i=0;i<100;i++){if((await request('/api/v1/tasks/'+first.data().task.taskId)).data().task.status==='succeeded')break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(calls.length,2);
});
test('remote diagnostic errors preserve actionable details and codes while redacting local paths',async t=>{
 const {post}=await setup(t,{providers:{ask:async()=>{throw Object.assign(Error('CLI model unavailable; check /Users/owner/private/cli.json and retry'),{code:'model_unavailable'});}}});
 const error=await post('/api/ask',{consent:true});assert.equal(error.data().code,'model_unavailable');assert.match(error.data().error,/model unavailable/);assert.ok(!error.text.includes('/Users/owner'));
});
test('owner resume is explicit, consented, identity-fenced and idempotent after provider failure',async t=>{
 let calls=0;const {post,request}=await setup(t,{providers:{ask:async()=>{if(++calls===1)throw Error('Model unavailable at /home/fixture/config');return {answer:'Recovered',citations:['a']};}}});
 const submission=Tasks.submission({key:'resume',segments:[{id:'a',text:'Source'}]},{revision:'1',provider:'codex',idempotencyKey:'phone-resume-intent',consent:true});
 const first=(await post('/api/v1/tasks',submission)).data().task;let failed;
 for(let i=0;i<100;i++){failed=(await request('/api/v1/tasks/'+first.taskId)).data().task;if(failed.status==='failed')break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(failed.status,'failed');assert.equal(calls,1);assert.ok(!failed.error.message.includes('/home/fixture'));assert.equal(failed.error.code,'provider_failed');
 const body={protocolVersion:1,consent:true,resumeKey:'resume-intent',attemptId:failed.attemptId,inputDigest:failed.inputDigest};
 assert.equal((await post('/api/v1/tasks/'+first.taskId+'/resume',{...body,consent:false})).status,409);
 assert.equal((await post('/api/v1/tasks/'+first.taskId+'/resume',{...body,inputDigest:'wrong'})).status,409);assert.equal(calls,1);
 const resumed=await post('/api/v1/tasks/'+first.taskId+'/resume',body);assert.equal(resumed.status,202);
 const replay=await post('/api/v1/tasks/'+first.taskId+'/resume',body);assert.equal(replay.status,200);assert.equal(replay.data().task.attemptId,resumed.data().task.attemptId);
 assert.equal((await post('/api/v1/tasks/'+first.taskId+'/cancel',{protocolVersion:2,expected:{taskId:first.taskId,attemptId:failed.attemptId,inputDigest:failed.inputDigest}})).status,409);
 for(let i=0;i<100;i++){if((await request('/api/v1/tasks/'+first.taskId)).data().task.status==='succeeded')break;await new Promise(r=>setTimeout(r,5));}assert.equal(calls,2);
});
test('owner translation and public-source imports use existing bounded routes',async t=>{
 const calls=[];const {post}=await setup(t,{providers:{structured:async()=>{calls.push('translate');return {translations:[{id:'a',text:'译文'}]};},exclusive:async f=>f()},captionService:{available:true,importCaption:async()=>{calls.push('caption');return {status:'ready'};}},podcastSources:{discover:async()=>{calls.push('podcast');return {episodes:[]};}}});
 const value={consent:true,source:'en',target:'zh',segments:[{id:'a',text:'Source'}]};assert.equal((await post('/api/translate-subscription',{...value,consent:false})).status,400);assert.deepEqual(calls,[]);
 assert.equal((await post('/api/translate-subscription',value)).status,200);assert.equal((await post('/api/captions/import',{url:'https://public.example/caption'})).status,200);assert.equal((await post('/api/podcasts/discover',{url:'https://public.example/feed'})).status,200);assert.deepEqual(calls,['translate','caption','podcast']);
});
for(const entry of ['server.mjs','dev.mjs'])test('actual '+entry+' entry reads explicit private profile with temporary storage',async t=>{
 const {spawn}=await import('node:child_process');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-private-entry-'));
 await fs.cp(new URL('../desktop/',import.meta.url),path.join(directory,'desktop'),{recursive:true,filter:source=>!source.includes('node_modules')&&!source.includes('/dist')&&!source.includes('/helper-build')});
 await fs.cp(new URL('../reader/',import.meta.url),path.join(directory,'reader'),{recursive:true});
 const child=spawn(process.execPath,[path.join(directory,'desktop',entry),...(entry==='server.mjs'?['--port','0']:[])],{env:{HOME:directory,PATH:'/no-provider-fixture',COCONUT_PRIVATE_PROXY:profile.type,COCONUT_PRIVATE_ORIGIN:profile.origin,COCONUT_PRIVATE_OWNER:profile.ownerLogin,COCONUT_BACKEND_LABEL:profile.backendLabel},stdio:['ignore','pipe','pipe']});
 let exited=false;const exit=new Promise(resolve=>child.once('exit',()=>{exited=true;resolve();}));
 t.after(async()=>{if(!exited){child.kill('SIGTERM');await exit;}await fs.rm(directory,{recursive:true,force:true});});
 let output='',errors='';child.stderr.on('data',b=>errors+=b);
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Entry startup timeout: '+errors)),5000);child.stdout.on('data',b=>{output+=b;const match=output.match(/http:\/\/127\.0\.0\.1:(\d+)/);if(match){clearTimeout(timer);resolve(Number(match[1]));}});child.once('exit',()=>{clearTimeout(timer);reject(Error('Entry exited: '+errors));});});
 const result=await new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port,path:'/api/health',headers},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text)}));});req.on('error',reject);});
 assert.equal(result.status,200);assert.equal(result.data.client.mode,'private-owner');assert.equal(result.data.client.backendLabel,profile.backendLabel);assert.equal(result.data.client.capabilities.backgroundTasks,true);
});
test('remote diagnostics redact arbitrary roots, spaced paths, Windows and UNC without changing answers',async t=>{
 const paths=['/root/.config/private.json','/mnt/secret/config','/Volumes/Backup/private/db.sqlite','/Users/Jane Doe/private.json','"/some custom root/My private document.txt"','C:\\Users\\Jane Doe\\private.json','\\\\fileserver\\private share\\secret.txt'];
 const {post}=await setup(t,{providers:{ask:async data=>{if(data.question==='answer')return {answer:paths.join('\n')};throw Object.assign(Error('Model unavailable; inspect '+data.question+'; retry on the serving computer'),{code:'model_unavailable'});}}});
 for(const value of paths){const response=await post('/api/ask',{consent:true,question:value});assert.equal(response.data().code,'model_unavailable');assert.equal(response.data().error,'Model unavailable; inspect [本机路径]; retry on the serving computer',value);}
 const answer=await post('/api/ask',{consent:true,question:'answer'});assert.equal(answer.data().answer,paths.join('\n'));
});

test('diagnostic path delimiters include punctuation without stripping ordinary HTTPS links',async()=>{
 const {remoteDiagnostic}=await import('../desktop/client-access.mjs');
 assert.equal(remoteDiagnostic('failed:/root/private/file; retry'),'failed:[本机路径]; retry');
 assert.equal(remoteDiagnostic('See https://example.test/help for instructions'),'See https://example.test/help for instructions');
});
