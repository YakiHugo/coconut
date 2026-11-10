import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const shortUrl='https://b23.tv/River12';
const canonical='https://www.bilibili.com/video/BV1xx411c7mD';
const episodeId='13579bdf2468ace013579bdf';
const pageUrl=`https://www.xiaoyuzhoufm.com/episode/${episodeId}`;
const page=Buffer.from('<!doctype html><script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({
 props:{pageProps:{episode:{
  eid:episodeId,pid:'2468ace013579bdf2468ace0',title:'原创测试：在桥上听风',duration:123,
  status:'NORMAL',payType:'FREE',isPrivateMedia:false,
  podcast:{pid:'2468ace013579bdf2468ace0',title:'原创测试声音'},
  media:{size:64,mimeType:'audio/mp4',source:{mode:'PUBLIC',url:'https://media.xyzcdn.net/authored-bridge.m4a'}},
  enclosure:{url:'https://media.xyzcdn.net/authored-bridge.m4a'},
  shownotes:'原创测试简介，不提供文字稿。'
 }}}
})+'</script>');
const directEnv={http_proxy:'',https_proxy:'',no_proxy:''};
const customProxy='http://127.0.0.1:7897';
const customEnv={http_proxy:'',https_proxy:customProxy,no_proxy:''};

function mockSourceNetwork(t){
 const requests=[],lookups=[],redirects=new Map([[shortUrl,canonical+'?share_source=copy&p=1']]);
 t.mock.method(dns,'lookup',async(hostname,options)=>{
  lookups.push({hostname,options});
  return [{address:'198.18.1.212',family:4}];
 });
 t.mock.method(http,'request',()=>assert.fail('Sources must keep HTTPS'));
 t.mock.method(https,'request',(url,options,callback)=>{
  const href=String(url);
  requests.push({url:href,options});
  assert.ok(redirects.has(href)||href===pageUrl,'Unexpected target fetch: '+href);
  const request=new EventEmitter();
  request.destroy=()=>request;
  request.end=()=>queueMicrotask(()=>{
   const response=Readable.from(href===pageUrl?[page]:[]);
   response.statusCode=href===pageUrl?200:302;
   response.headers=href===pageUrl?
    {'content-type':'text/html; charset=utf-8','content-length':String(page.length)}:
    {location:redirects.get(href)};
   callback(response);
  });
  return request;
 });
 syncBuiltinESMExports();
 t.after(()=>{
  t.mock.restoreAll();
  syncBuiltinESMExports();
 });
 return {requests,lookups,redirects};
}

function ambientProxy(t){
 const values={HTTP_PROXY:'http://127.0.0.1:65001',HTTPS_PROXY:'http://127.0.0.1:65002',
  ALL_PROXY:'socks5://127.0.0.1:65003',NO_PROXY:'*'};
 const keys=[...Object.keys(values),'http_proxy','https_proxy','all_proxy','no_proxy',
  'COCONUT_SOURCE_NETWORK','COCONUT_SOURCE_PROXY','COCONUT_CAPTION_PROXY','COCONUT_PODCAST_PROXY'];
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 for(const key of keys)delete process.env[key];
 Object.assign(process.env,values);
 t.after(()=>{
  for(const key of keys){
   if(previous[key]===undefined)delete process.env[key];
   else process.env[key]=previous[key];
  }
 });
 return values;
}

async function postIngestion(origin,url){
 const response=await fetch(origin+'/api/v1/ingestions',{
  method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
  body:JSON.stringify({protocolVersion:1,source:{kind:'url',url}})
 });
 return {status:response.status,body:await response.json()};
}

test('B23 Fake-IP reaches one HTTPS hop through default and configured entry networks',async t=>{
 const ambient=ambientProxy(t);
 const {requests,lookups,redirects}=mockSourceNetwork(t);
 const {createCaptionShortLinkResolver}=await import('../desktop/caption-short-link.mjs');
 const {startBridge}=await import('../desktop/server.mjs');
 const {startDevelopmentBridge}=await import('../desktop/dev.mjs');
 const {startDesktopService}=await import('../desktop/full-service.mjs');
 const entries=[
  {name:'low-level bridge defaults to explicit direct',kind:'bridge',proxyEnv:directEnv},
  {name:'development ignores ordinary ambient proxies',kind:'development',proxyEnv:directEnv},
  {name:'desktop ignores ordinary ambient proxies',kind:'desktop',env:ambient,proxyEnv:directEnv},
  {name:'desktop explicit COCONUT_SOURCE proxy reaches podcast and short link',kind:'desktop',
   env:{...ambient,COCONUT_SOURCE_NETWORK:'custom',COCONUT_SOURCE_PROXY:customProxy},proxyEnv:customEnv,podcast:true},
  {name:'development configured source proxy',kind:'development',
   sourceNetwork:{mode:'custom',proxy:customProxy},proxyEnv:customEnv},
  {name:'development podcast-only proxy does not affect B23',kind:'development',
   podcastProxy:'http://127.0.0.1:7898',proxyEnv:directEnv}
 ];
 assert.deepEqual(requests,[]);
 assert.deepEqual(lookups,[]);
 for(const entry of entries){
  await t.test(entry.name,async t=>{
   const directory=await mkdtemp(path.join(tmpdir(),'coconut-short-link-'));
   let server;
   t.after(async()=>{
    try{await server?.shutdown();}
    finally{await rm(directory,{recursive:true,force:true});}
   });
   const inference=t.mock.fn(()=>assert.fail('Short-link discovery must not invoke a model or download media'));
   const passiveStatus=t.mock.fn(async()=>({available:false,automatic:false,model_download:false}));
   const captionCalls=[];
   const captionService={available:true,providers:['bilibili'],importCaption:async data=>{
    captionCalls.push(data);
    return {status:'network_unavailable',message:'原创测试不请求字幕或媒体'};
   }};
   const options={port:0,taskDirectory:null,libraryDirectory:path.join(directory,'library'),
    providers:{ask:inference,status:inference},captionService,
    transcriber:{profile:{backend:'test'},status:passiveStatus,alignmentStatus:passiveStatus,run:inference,align:inference},
    readingPython:null,punctuationModel:null,segmentationModel:null,embeddingModel:null};
   const initialRequests=requests.length;
   if(entry.kind==='desktop'){
    server=await startDesktopService({...options,userDataDirectory:directory,env:entry.env});
   }else if(entry.kind==='development'){
    ({server}=await startDevelopmentBridge({...options,captionPython:null,captionProxy:null,
     podcastProxy:entry.podcastProxy??null,sourceNetwork:entry.sourceNetwork}));
   }else server=await startBridge(options);
   const origin=`http://127.0.0.1:${server.address().port}`;
   assert.equal(requests.length,initialRequests,'passive startup must not fetch a source');
   assert.equal(lookups.length,0,'passive startup must not resolve a source');
   const result=await postIngestion(origin,shortUrl);
   assert.equal(result.status,200,JSON.stringify(result.body));
   assert.equal(result.body.ingestion.source.url,canonical);
   assert.equal(result.body.ingestion.source.media_id,'BV1xx411c7mD');
   assert.equal(result.body.ingestion.error.code,'network_unavailable');
   assert.deepEqual(captionCalls,[{url:canonical,language:undefined}]);
   assert.equal(requests.length,initialRequests+1,'only the short-link hop reaches the transport');
   assert.equal(requests.at(-1).url,shortUrl);
   assert.equal(requests.at(-1).options.lookup,undefined,'owner HTTPS lets the configured transport resolve Fake-IP');
   assert.ok(requests.at(-1).options.agent instanceof https.Agent);
   assert.deepEqual(requests.at(-1).options.agent.options.proxyEnv,entry.proxyEnv);
   assert.equal(lookups.length,0,'neither the short link nor its target is pre-resolved');
   if(entry.podcast){
    const podcast=await postIngestion(origin,pageUrl);
    assert.equal(podcast.status,200,JSON.stringify(podcast.body));
    assert.equal(podcast.body.ingestion.state,'awaiting_selection');
    assert.equal(requests.at(-1).url,pageUrl);
    assert.deepEqual(requests.at(-1).options.agent.options.proxyEnv,entry.proxyEnv);
    assert.equal(lookups.length,0,'podcast and short link share the explicit source network');
   }
   if(entry.kind==='bridge'){
    const invalidTargets=[
     'https://b23.tv/SecondHop',
     'https://example.org/video/BV1xx411c7mD',
     'https://www.bilibili.com.evil.example/video/BV1xx411c7mD',
     'https://www.bilibili.com/video/invalidBV',
     canonical+'?p=2',canonical+'?p=1&p=2',
     canonical+'?access_token=private',
     'https://user:private@www.bilibili.com/video/BV1xx411c7mD',
     'http://www.bilibili.com/video/BV1xx411c7mD'
    ];
    for(const [index,target] of invalidTargets.entries()){
     const input='https://b23.tv/Invalid'+index;
     redirects.set(input,target);
     const before=requests.length;
     const invalid=await postIngestion(origin,input);
     assert.equal(invalid.status,200,JSON.stringify(invalid.body));
     assert.equal(invalid.body.ingestion.error.code,'short_link_unresolved');
     assert.equal(invalid.body.ingestion.source.url,input);
     assert.equal(requests.length,before+1,'invalid target must never be fetched');
     assert.equal(requests.at(-1).url,input);
     assert.equal(captionCalls.length,1,'invalid target must never reach captions');
     assert.equal(lookups.length,0,'target validation must not resolve a destination');
    }
    const resolver=createCaptionShortLinkResolver();
    const before=requests.length;
    for(const input of ['http://b23.tv/River12','https://www.b23.tv/River12',
     'https://b23.tv.evil.example/River12','https://b23.tv/River12?share=1',
     'https://user:private@b23.tv/River12']){
     await assert.rejects(resolver(input),/官方 Bilibili/);
    }
    assert.equal(requests.length,before,'nonofficial short links must fail before transport');
   }
   assert.equal(inference.mock.callCount(),0);
  });
 }
});

test('SOCKS source configuration stays lazy and fails its first short-link use without fallback',async t=>{
 const {requests,lookups}=mockSourceNetwork(t);
 const {createCaptionShortLinkResolver}=await import('../desktop/caption-short-link.mjs');
 const {startDevelopmentBridge}=await import('../desktop/dev.mjs');
 const network={mode:'environment',environment:{ALL_PROXY:'socks5://127.0.0.1:7897'}};
 const resolver=createCaptionShortLinkResolver({ownerNetwork:network});
 assert.deepEqual(requests,[]);
 await assert.rejects(resolver(shortUrl),/SOCKS proxies are not supported/);
 assert.deepEqual(requests,[]);
 assert.deepEqual(lookups,[]);
 const inference=t.mock.fn(()=>assert.fail('No captions, model or media requests are allowed'));
 const {server,origin}=await startDevelopmentBridge({
  port:0,taskDirectory:null,libraryDirectory:null,captionPython:null,captionProxy:null,podcastProxy:null,
  sourceNetwork:network,readingPython:null,punctuationModel:null,segmentationModel:null,embeddingModel:null,
  providers:{ask:inference,status:inference},
  captionService:{available:true,providers:['bilibili'],importCaption:inference}
 });
 t.after(()=>server.shutdown());
 assert.equal((await fetch(origin+'/')).status,200,'SOCKS video configuration must preserve reading startup');
 const result=await postIngestion(origin,shortUrl);
 assert.equal(result.status,200);
 assert.equal(result.body.ingestion.error.code,'short_link_unresolved');
 assert.match(result.body.ingestion.error.message,/仅支持 HTTP 代理/);
 assert.deepEqual(requests,[]);
 assert.deepEqual(lookups,[]);
 assert.equal(inference.mock.callCount(),0);
});

test('entry-provided short-link resolvers remain injectable',async t=>{
 const {startDevelopmentBridge}=await import('../desktop/dev.mjs');
 const {startDesktopService}=await import('../desktop/full-service.mjs');
 for(const kind of ['development','desktop']){
  await t.test(kind,async t=>{
   const directory=await mkdtemp(path.join(tmpdir(),'coconut-short-link-injection-'));
   let server;
   t.after(async()=>{
    try{await server?.shutdown();}
    finally{await rm(directory,{recursive:true,force:true});}
   });
   const resolve=t.mock.fn(async()=>canonical);
   const options={port:0,taskDirectory:null,libraryDirectory:path.join(directory,'library'),
    providers:{ask:()=>assert.fail('No model'),status:()=>assert.fail('No provider probe')},
    captionShortLinkResolver:resolve,
    captionService:{available:true,providers:['bilibili'],importCaption:async()=>({status:'network_unavailable',message:'原创测试'})},
    readingPython:null,punctuationModel:null,segmentationModel:null,embeddingModel:null};
   if(kind==='desktop')server=await startDesktopService({...options,userDataDirectory:directory,env:{}});
   else ({server}=await startDevelopmentBridge({...options,captionPython:null,captionProxy:null,podcastProxy:null}));
   const result=await postIngestion(`http://127.0.0.1:${server.address().port}`,shortUrl);
   assert.equal(result.status,200);
   assert.equal(result.body.ingestion.source.url,canonical);
   assert.equal(resolve.mock.callCount(),1);
  });
 }
});
