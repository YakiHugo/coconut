import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {serviceConfig} from '../server/config.mjs';
import {startService} from '../server/main.mjs';
import {createOwnerAccess} from '../desktop/owner-access.mjs';
import {startBridge} from '../desktop/server.mjs';

const token='authored-owner-test-key-with-at-least-32-characters';
const publicOrigin='https://reader.example.test';
async function setup(t,extra={}){
 const directory=await mkdtemp(path.join(tmpdir(),'coconut-service-'));let server;
 const env={COCONUT_PORT:'0',COCONUT_DATA_DIRECTORY:directory,...extra};
 const started=await startService({env});server=started.server;
 t.after(async()=>{await server.shutdown();await rm(directory,{recursive:true,force:true});});
 const request=(route='/',{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
  const req=http.request(started.origin+route,{method,headers:{...(env.COCONUT_PUBLIC_ORIGIN?{Host:new URL(env.COCONUT_PUBLIC_ORIGIN).host}:{}),...headers}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text,json:()=>JSON.parse(text)}));});req.on('error',reject);req.end(body);
 });
 const login=async()=>{const response=await request('/auth/login',{method:'POST',headers:{Origin:env.COCONUT_PUBLIC_ORIGIN,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token}).toString()});assert.equal(response.status,303);return response.headers['set-cookie'][0].split(';')[0];};
 return {...started,directory,env,request,login,setServer:value=>{server=value;}};
}
test('configuration keeps deployment paths independent of cwd and rejects partial exposure',()=>{
 const config=serviceConfig({COCONUT_DATA_DIRECTORY:'/absolute/data',COCONUT_PORT:'8123'});
 assert.equal(config.host,'127.0.0.1');assert.equal(config.port,8123);assert.equal(config.network.mode,'direct');
 for(const env of [{COCONUT_HOST:'0.0.0.0'},{COCONUT_PORT:'-1'},{COCONUT_PORT:'65536'},{COCONUT_DATA_DIRECTORY:'relative'},
  {COCONUT_PUBLIC_ORIGIN:publicOrigin},{COCONUT_OWNER_TOKEN:token},{COCONUT_PRIVATE_PROXY:'tailscale-serve'},
  {COCONUT_HOST:'0.0.0.0',COCONUT_PUBLIC_ORIGIN:'http://reader.example.test',COCONUT_OWNER_TOKEN:token},
  {COCONUT_SOURCE_NETWORK:'direct',COCONUT_PODCAST_PROXY:'http://127.0.0.1:7897'}])assert.throws(()=>serviceConfig(env));
 const environment=serviceConfig({HTTPS_PROXY:'http://127.0.0.1:7897',NO_PROXY:'localhost'}).network;
 assert.equal(environment.mode,'environment');assert.equal(environment.environment.NO_PROXY,'localhost');
 assert.equal(serviceConfig({COCONUT_SOURCE_NETWORK:'direct',HTTPS_PROXY:'http://127.0.0.1:7897'}).network.mode,'direct');
 assert.throws(()=>createOwnerAccess({origin:publicOrigin,token:'short'}));
});
test('standalone local service opens one canonical library without any model or Electron',async t=>{
 const {request,directory}=await setup(t);assert.equal((await request()).status,200);
 const health=(await request('/api/health')).json();assert.equal(health.client.capabilities.libraryWrite,true);
 assert.equal(health.library_storage.mode,'service');assert.equal(health.library_storage.directory,path.join(directory,'library'));
 assert.equal((await request('/api/v1/executor')).json().enabled,true);
 assert.equal((await request('/api/v1/ingestions/capabilities')).json().transcription.available,false);
});
test('hosted owner login protects the real HTTP APIs and preserves sessions across service restart',async t=>{
 const setupResult=await setup(t,{COCONUT_HOST:'0.0.0.0',COCONUT_PUBLIC_ORIGIN:publicOrigin,COCONUT_OWNER_TOKEN:token});
 const {request,login,env,directory,setServer}=setupResult;
 assert.equal((await request()).headers.location,'/login');assert.equal((await request('/api/health')).status,401);
 assert.equal((await request('/api/health',{headers:{'Tailscale-User-Login':'owner','X-Forwarded-Proto':'https'}})).status,401);
 assert.equal((await request('/api/health',{headers:{Host:new URL(setupResult.origin).host}})).status,403,'A proxy rewriting Host to localhost cannot downgrade authentication');
 assert.equal((await request('/login')).status,200);
 assert.equal((await request('/auth/login',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token}).toString()})).status,403);
 const wrong=await request('/auth/login',{method:'POST',headers:{Origin:publicOrigin,'Content-Type':'application/x-www-form-urlencoded'},body:'token=wrong'});assert.equal(wrong.status,401);assert.ok(!wrong.text.includes(token));
 const cookie=await login(),headers={Cookie:cookie,Origin:publicOrigin,'Content-Type':'application/json'};
 const health=(await request('/api/health',{headers})).json();assert.equal(health.client.mode,'private-owner');assert.equal(health.library_storage,undefined);assert.equal(health.client.capabilities.localMedia,false);
 for(const route of ['/api/local-media','/api/captions/session'])assert.equal((await request(route,{headers})).status,403);
 assert.equal((await request('/api/health',{headers:{...headers,Origin:'https://evil.example'}})).status,403);
 const epoch=(await request('/api/v1/library',{headers})).json().epoch;
 const document={key:'authored',title:'Across deployments',segments:[],notes:{a:'keep this'}};
 const commit={protocolVersion:1,epoch,receiptKey:randomUUID(),action:'put',key:document.key,expected:null,document};
 assert.equal((await request('/api/v1/library/commit',{method:'POST',headers,body:JSON.stringify(commit)})).status,200);
 await setupResult.server.shutdown();
 // Same data and secret, different listener port: the browser identity remains.
 const restarted=await startService({env});setServer(restarted.server);
 const response=await new Promise((resolve,reject)=>{http.get(restarted.origin+'/api/v1/library/document?protocolVersion=1&key=authored',{headers:{Host:new URL(publicOrigin).host,Cookie:cookie}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text)}));}).on('error',reject);});
 assert.equal(response.status,200);assert.deepEqual(response.data.record.document,document);
 const rotated=createOwnerAccess({origin:publicOrigin,token:token+'rotated'});assert.equal(rotated.authenticated({headers:{host:new URL(publicOrigin).host,cookie},rawHeaders:[]}),false);
 assert.ok(directory);
});
test('session validation rejects expiry, duplicate cookies, forged signatures and wrong hosts',()=>{
 let time=1800000000000;const authority=createOwnerAccess({origin:publicOrigin,token,now:()=>time});
 const cookie=authority.discoveryHeaders().Cookie,base={headers:{host:new URL(publicOrigin).host,cookie},rawHeaders:[]};
 assert.equal(authority.authenticated(base),true);
 for(const headers of [{...base.headers,cookie:cookie+'; '+cookie},{...base.headers,cookie:cookie+'x'},{...base.headers,host:'other.example'}])assert.equal(authority.authenticated({...base,headers}),false);
 assert.equal(authority.authenticated({...base,rawHeaders:['Cookie',cookie,'Cookie',cookie]}),false);
 time+=13*60*60*1000;assert.equal(authority.authenticated(base),false);
});
test('source execution follows authenticated owner permission rather than browser location',async t=>{
 const authority=createOwnerAccess({origin:publicOrigin,token});let calls=0;
 const server=await startBridge({port:0,ownerAccess:authority,captionService:{available:true,ownerLocalOnly:true,providers:['youtube'],importCaption:async()=>{calls++;return {status:'ready',document:{title:'Authored',segments:[]}};}}});t.after(()=>server.shutdown());
 const response=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/api/v1/ingestions',method:'POST',headers:{Host:new URL(publicOrigin).host,Origin:publicOrigin,...authority.discoveryHeaders(),'Content-Type':'application/json'}},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(body)}));});req.on('error',reject);req.end(JSON.stringify({protocolVersion:1,source:{kind:'url',url:'https://www.youtube.com/watch?v=BaW_jenozKc'}}));});
 assert.equal(response.status,200);assert.equal(response.data.ingestion.state,'ready');assert.equal(calls,1);
});
