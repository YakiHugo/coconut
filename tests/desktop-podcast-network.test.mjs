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

const episodeId='1234567890abcdef12345678';
const showId='abcdef1234567890abcdef12';
const episodeTitle='原创测试：沿着河岸听见城市';
const mediaUrl='https://media.xyzcdn.net/authored-riverside.m4a';
const page=Buffer.from('<!doctype html><script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({
  props:{pageProps:{episode:{
    eid:episodeId,pid:showId,title:episodeTitle,duration:321,
    status:'NORMAL',payType:'FREE',isPrivateMedia:false,
    podcast:{pid:showId,title:'原创测试播客'},
    media:{size:64,mimeType:'audio/mp4',source:{mode:'PUBLIC',url:mediaUrl}},
    enclosure:{url:mediaUrl},
    shownotes:'原创页面简介，不能作为文字稿。'
  }}}
})+'</script>');

function mockSourceNetwork(t){
  const requests=[],lookups=[];
  t.mock.method(dns,'lookup',async(hostname,options)=>{
    lookups.push({hostname,options});
    return [{address:'198.18.1.211',family:4}];
  });
  t.mock.method(http,'request',(url,options)=>{
    requests.push({url:String(url),options});
    throw Error('Unexpected HTTP source request');
  });
  t.mock.method(https,'request',(url,options,callback)=>{
    requests.push({url:String(url),options});
    const target=new URL(url);
    const isPage=['www.xiaoyuzhoufm.com','xiaoyuzhoufm.com'].includes(target.hostname)&&
      target.pathname==='/episode/'+episodeId;
    assert.ok(isPage||target.href===mediaUrl,'Unexpected HTTPS source: '+target.href);
    const request=new EventEmitter();
    request.destroy=()=>request;
    request.end=()=>queueMicrotask(()=>{
      const body=isPage?page:Buffer.from('authored audio fixture');
      const response=Readable.from([body]);
      response.statusCode=200;
      response.headers={'content-type':isPage?'text/html; charset=utf-8':'audio/mp4',
        'content-length':String(body.length)};
      callback(response);
    });
    return request;
  });
  // public-http uses a named DNS import; keep it in sync with the builtin mock.
  syncBuiltinESMExports();
  t.after(()=>{
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return {requests,lookups};
}

async function postIngestion(origin,url){
  const response=await fetch(origin+'/api/v1/ingestions',{
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
    body:JSON.stringify({protocolVersion:1,source:{kind:'url',url}})
  });
  return {status:response.status,body:await response.json()};
}

test('desktop and development default podcast adapters support owner Fake-IP without weakening RSS DNS checks',async t=>{
  const {requests,lookups}=mockSourceNetwork(t);
  // Import after installing DNS mocks so even the legacy singleton fetcher cannot
  // escape into real DNS when this regression fails.
  const {startDesktopService}=await import('../desktop/full-service.mjs');
  const {startDevelopmentBridge}=await import('../desktop/dev.mjs');
  const environmentNetwork={mode:'environment',environment:{
    HTTPS_PROXY:'http://127.0.0.1:7897',NO_PROXY:'media.xyzcdn.net'
  }};
  const entries=[
    {name:'desktop default direct network',desktop:true,proxyEnv:{http_proxy:'',https_proxy:'',no_proxy:''}},
    {name:'development default direct network',proxyEnv:{http_proxy:'',https_proxy:'',no_proxy:''}},
    {name:'development configured source network',sourceNetwork:environmentNetwork,
      proxyEnv:{http_proxy:'',https_proxy:'http://127.0.0.1:7897',no_proxy:'media.xyzcdn.net'}}
  ];
  assert.deepEqual(requests,[],'module initialization must not request a source');
  assert.deepEqual(lookups,[],'module initialization must not resolve a source');

  for(const entry of entries){
    await t.test(entry.name,async t=>{
      const directory=await mkdtemp(path.join(tmpdir(),'coconut-podcast-network-'));
      let server;
      t.after(async()=>{
        try{await server?.shutdown();}
        finally{await rm(directory,{recursive:true,force:true});}
      });
      const inference=t.mock.fn(()=>assert.fail('Metadata discovery must not run or probe a model'));
      const transcriptionStatus=t.mock.fn(async()=>({
        available:false,automatic:false,model_download:false
      }));
      const transcriber={profile:{backend:'test'},status:transcriptionStatus,
        alignmentStatus:transcriptionStatus,run:inference,align:inference};
      const options={port:0,libraryDirectory:path.join(directory,'library'),
        taskDirectory:path.join(directory,'tasks'),
        providers:{ask:inference,status:inference},transcriber,
        readingPython:null,punctuationModel:null,segmentationModel:null,embeddingModel:null};
      const initialRequests=requests.length,initialLookups=lookups.length;
      let origin;
      if(entry.desktop){
        server=await startDesktopService({...options,userDataDirectory:directory,env:{}});
        origin=`http://127.0.0.1:${server.address().port}`;
      }else{
        const started=await startDevelopmentBridge({...options,captionPython:null,
          captionProxy:null,podcastProxy:null,sourceNetwork:entry.sourceNetwork});
        server=started.server;
        origin=started.origin;
      }
      assert.equal(requests.length,initialRequests,'startup must not fetch source metadata');
      assert.equal(lookups.length,initialLookups,'startup must not resolve source hosts');
      assert.equal(inference.mock.callCount(),0,'startup must remain passive');
      assert.equal(transcriptionStatus.mock.callCount(),0,'startup must not probe transcription');

      for(const hostname of ['www.xiaoyuzhoufm.com','xiaoyuzhoufm.com']){
        const url=`https://${hostname}/episode/${episodeId}`;
        const before=requests.length;
        const result=await postIngestion(origin,url);
        assert.equal(result.status,200,JSON.stringify(result.body));
        const {ingestion}=result.body;
        assert.equal(ingestion.state,'awaiting_selection');
        assert.equal(ingestion.source.url,url);
        assert.equal(ingestion.selection.source_type,'xiaoyuzhou_public_page');
        assert.equal(ingestion.selection.feed_url,url);
        assert.equal(ingestion.selection.episodes.length,1);
        const [episode]=ingestion.selection.episodes;
        assert.equal(episode.title,episodeTitle);
        assert.equal(episode.source_url,`https://www.xiaoyuzhoufm.com/episode/${episodeId}`);
        assert.equal(episode.media[0].url,mediaUrl);
        assert.deepEqual(episode.transcripts,[]);
        assert.equal(requests.length,before+1,'discovery reads only the authored metadata page');
        assert.equal(lookups.length,initialLookups,'owner HTTPS must leave DNS to the transport');
        assert.equal(requests.at(-1).url,url);
        assert.equal(requests.at(-1).options.lookup,undefined);
        assert.ok(requests.at(-1).options.agent instanceof https.Agent);
        assert.deepEqual(requests.at(-1).options.agent.options.proxyEnv,entry.proxyEnv);
      }

      const media=await postIngestion(origin,mediaUrl);
      assert.equal(media.status,200,JSON.stringify(media.body));
      assert.equal(media.body.ingestion.state,'needs_transcription');
      assert.equal(media.body.ingestion.media.url,mediaUrl);
      assert.equal(lookups.length,initialLookups,'the exact HTTPS platform media host also skips DNS');
      assert.equal(requests.at(-1).url,mediaUrl);
      assert.equal(requests.at(-1).options.lookup,undefined);
      assert.deepEqual(requests.at(-1).options.agent.options.proxyEnv,entry.proxyEnv);

      const strictUrls=[
        'https://publisher.example.org/feed.xml',
        `http://www.xiaoyuzhoufm.com/episode/${episodeId}`,
        `http://xiaoyuzhoufm.com/episode/${episodeId}`,
        'http://media.xyzcdn.net/authored-riverside.m4a',
        'https://www.xiaoyuzhoufm.com.evil.example/feed.xml',
        'https://subdomain.xiaoyuzhoufm.com/feed.xml',
        'https://media.xyzcdn.net.evil.example/feed.xml',
        'https://cdn.xyzcdn.net/feed.xml'
      ];
      const acceptedRequests=requests.length;
      for(const url of strictUrls){
        const before=lookups.length;
        const result=await postIngestion(origin,url);
        assert.equal(result.status,400,url+': '+JSON.stringify(result.body));
        assert.match(result.body.error,/非公开地址/);
        assert.equal(lookups.length,before+1,url+' must pass through strict DNS validation');
        assert.deepEqual(lookups.at(-1),{
          hostname:new URL(url).hostname,options:{all:true,verbatim:true}
        });
        assert.equal(requests.length,acceptedRequests,'Fake-IP must be rejected before HTTP(S) transport');
      }
      assert.equal(inference.mock.callCount(),0,'discovery never runs or probes a model');
    });
  }

  await t.test('development SOCKS configuration preserves passive startup and fails podcast requests without direct fallback',async t=>{
    const directory=await mkdtemp(path.join(tmpdir(),'coconut-podcast-socks-'));
    let server;
    t.after(async()=>{
      try{await server?.shutdown();}
      finally{await rm(directory,{recursive:true,force:true});}
    });
    const inference=t.mock.fn(()=>assert.fail('SOCKS configuration must not invoke or probe a model'));
    const passiveStatus=t.mock.fn(async()=>({
      available:false,automatic:false,model_download:false,code:'asr_not_configured'
    }));
    const initialRequests=requests.length,initialLookups=lookups.length;
    const started=await startDevelopmentBridge({
      port:0,taskDirectory:path.join(directory,'tasks'),libraryDirectory:path.join(directory,'library'),
      captionPython:null,captionProxy:null,podcastProxy:null,
      readingPython:null,punctuationModel:null,segmentationModel:null,embeddingModel:null,
      sourceNetwork:{mode:'environment',environment:{ALL_PROXY:'socks5://127.0.0.1:7897'}},
      providers:{ask:inference,status:inference},
      ingestionExecutor:{status:passiveStatus,list:inference,upload:inference}
    });
    server=started.server;
    assert.equal(passiveStatus.mock.callCount(),0,'startup must not probe transcription');
    assert.equal((await fetch(started.origin+'/')).status,200);
    const capabilities=await fetch(started.origin+'/api/v1/ingestions/capabilities');
    assert.equal(capabilities.status,200);
    const body=await capabilities.json();
    assert.equal(body.protocolVersion,1);
    assert.equal(body.url,true);
    assert.equal(body.transcription.available,false);
    assert.equal(passiveStatus.mock.callCount(),1);
    assert.equal(requests.length,initialRequests,'startup and capabilities must not fetch sources');
    assert.equal(lookups.length,initialLookups,'startup and capabilities must not resolve sources');

    const result=await postIngestion(started.origin,`https://www.xiaoyuzhoufm.com/episode/${episodeId}`);
    assert.equal(result.status,400,JSON.stringify(result.body));
    assert.match(result.body.error,/SOCKS proxies are not supported/);
    assert.equal(requests.length,initialRequests,'unsupported SOCKS must not fall back to direct HTTP(S)');
    assert.equal(lookups.length,initialLookups,'unsupported SOCKS must fail before source DNS');
    assert.equal(inference.mock.callCount(),0,'startup, capabilities and failed discovery never invoke models');
  });
});
