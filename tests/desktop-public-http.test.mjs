import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createPublicFetcher, isPublicAddress, publicUrl } from '../desktop/public-http.mjs';
const allowed=new Set(['text/plain']);
function fakeTransport(responses) {
 const calls=[];
 const request=(url,options,callback)=>{
  calls.push({url:url.href,options});const req=new EventEmitter();
  req.end=()=>queueMicrotask(()=>{
   const spec=responses.shift();if(!spec){req.emit('error',new Error('No fixture'));return;}
   if(spec.error){req.emit('error',spec.error);return;}
   const stream=Readable.from(spec.chunks||[Buffer.from(spec.body||'OK')]);stream.statusCode=spec.status||200;stream.headers={'content-type':'text/plain',...(spec.headers||{})};callback(stream);
  });return req;
 };
 return {calls,request};
}
const lookup=async()=>[{address:'93.184.216.34',family:4}];
test('public IP validation covers IPv4 obfuscation, mapped IPv6, link-local, reserved and transition ranges',()=>{
 for(const ip of ['127.0.0.1','0.0.0.0','10.1.2.3','100.64.0.1','169.254.169.254','172.16.5.1','192.168.1.1','192.0.0.8','192.0.2.1','198.18.0.1','224.0.0.1','255.255.255.255','::1','::ffff:8.8.8.8','fe80::1','fc00::1','2001:db8::1','2002:7f00:1::','2001::1','3fff::1'])assert.equal(isPublicAddress(ip),false,ip);
 for(const ip of ['8.8.8.8','93.184.216.34','2606:4700:4700::1111'])assert.equal(isPublicAddress(ip),true,ip);
 for(const url of ['http://2130706433/a','http://0177.0.0.1/a','http://0x7f000001/a','http://[::1]/a','http://localhost/a','http://foo.local/a','https://u:p@example.org/a','file:///etc/passwd','https://example.org:444/a','https://example.org/a?token=secret','https://example.org/a?X-Amz-Signature=secret','https://example.org./a'])assert.throws(()=>publicUrl(url),undefined,url);
 assert.equal(publicUrl('https://[2606:4700:4700::1111]/a').hostname,'[2606:4700:4700::1111]');
});
test('DNS is checked once per request and socket lookup is pinned to exactly that public record',async()=>{
 let resolutions=0;const {request,calls}=fakeTransport([{body:'hello',headers:{'content-length':'5'}}]);
 const fetch=createPublicFetcher({lookup:async()=>{resolutions++;return lookup();},request});const response=await fetch('https://example.org/feed',{types:allowed});
 assert.equal(response.body.toString(),'hello');assert.equal(resolutions,1);assert.equal(calls[0].options.agent,false);assert.deepEqual(calls[0].options.headers,{'User-Agent':'Coconut/0.1 public-podcast-reader','Accept':'*/*','Accept-Encoding':'identity'});
 calls[0].options.lookup('attacker.example',{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'93.184.216.34');assert.equal(family,4);});
 calls[0].options.lookup('attacker.example',{all:true},(error,records)=>{assert.equal(error,null);assert.deepEqual(records,[{address:'93.184.216.34',family:4}]);});
});
test('mixed public/private DNS answers fail closed without making a request',async()=>{
 const {request,calls}=fakeTransport([]);const fetch=createPublicFetcher({lookup:async()=>[...await lookup(),{address:'10.0.0.1',family:4}],request});
 await assert.rejects(fetch('https://example.org/feed'),/非公开地址/);assert.equal(calls.length,0);
});
test('every redirect destination is revalidated and DNS pinned without forwarding cookies',async()=>{
 const {request,calls}=fakeTransport([{status:302,headers:{location:'https://cdn.example.org/feed','set-cookie':'secret=value'}},{body:'final'}]);
 const names=[];const fetch=createPublicFetcher({lookup:async host=>{names.push(host);return lookup();},request});const result=await fetch('https://example.org/feed',{types:allowed});
 assert.equal(result.body.toString(),'final');assert.deepEqual(names,['example.org','cdn.example.org']);assert.equal(calls[1].options.headers.Cookie,undefined);
 for(const location of ['http://127.0.0.1/secret','http://cdn.example.org/feed','https://user:secret@example.org/feed','https://cdn.example.org/feed?access_token=secret']){
  const t=fakeTransport([{status:302,headers:{location}}]);await assert.rejects(createPublicFetcher({lookup,request:t.request})('https://example.org/feed'));assert.equal(t.calls.length,1);
 }
});
test('redirect DNS rebinding to private and unbounded redirect loops fail closed',async()=>{
 const t=fakeTransport([{status:302,headers:{location:'https://evil.example.org/feed'}}]);let n=0;
 await assert.rejects(createPublicFetcher({lookup:async()=>++n===1?lookup():[{address:'127.0.0.1',family:4}],request:t.request})('https://example.org/feed'),/非公开/);assert.equal(t.calls.length,1);
 const loop=fakeTransport(Array.from({length:5},()=>({status:302,headers:{location:'/again'}})));await assert.rejects(createPublicFetcher({lookup,request:loop.request})('https://example.org/feed'),/重定向过多/);assert.equal(loop.calls.length,5);
});
test('body, declared length, content type, compression and HTTP status are bounded before parser use',async()=>{
 const cases=[{body:'abcd',headers:{'content-length':'4'}},{chunks:[Buffer.from('ab'),Buffer.from('cd')]},{headers:{'content-length':'NaN'}},{body:'ab',headers:{'content-length':'3'}},{headers:{'content-type':'text/html'}},{headers:{'content-encoding':'gzip'}},{status:401},{status:206}];
 for(const spec of cases){const t=fakeTransport([spec]);await assert.rejects(createPublicFetcher({lookup,request:t.request})('https://example.org/feed',{maxBytes:3,types:allowed}));}
});
test('media inspection only accepts supported actual MIME and stops before downloading body',async()=>{
 const t=fakeTransport([{headers:{'content-type':'audio/mpeg','content-length':'100'},body:'must not download'}]);
 const response=await createPublicFetcher({lookup,request:t.request})('https://example.org/media',{maxBytes:1,maxMediaBytes:100,inspectMedia:true,types:allowed});
 assert.equal(response.body.length,0);assert.equal(response.length,100);assert.equal(response.type,'audio/mpeg');
 const hls=fakeTransport([{headers:{'content-type':'application/vnd.apple.mpegurl'},body:'playlist'}]);await assert.rejects(createPublicFetcher({lookup,request:hls.request})('https://example.org/media',{inspectMedia:true,types:allowed}),/内容类型/);
});
test('abort during DNS and DNS timeout do not start a connection; diagnostic errors contain no URLs',async()=>{
 const t=fakeTransport([]),controller=new AbortController();const fetch=createPublicFetcher({lookup:()=>new Promise(()=>{}),request:t.request});
 const pending=fetch('https://example.org/feed',{signal:controller.signal});controller.abort();await assert.rejects(pending,/取消或超时/);assert.equal(t.calls.length,0);
 const keepAlive=setTimeout(()=>{},100);try{await assert.rejects(fetch('https://example.org/feed',{timeoutMs:10}),/取消或超时/);}finally{clearTimeout(keepAlive);}
 const error=Object.assign(new Error('PRIVATE PATH OR SECRET'),{code:'ENOTFOUND'});await assert.rejects(createPublicFetcher({lookup:async()=>{throw error;},request:t.request})('https://example.org/feed'),e=>!e.message.includes('SECRET'));
});
test('known CDN signatures and credential naming variants are refused before DNS',()=>{
 for(const key of ['auth_key','hdnts','hdnea','accessToken','access-token','Policy','Key-Pair-Id','X-Amz-Credential','apiKey','refresh_token'])assert.throws(()=>publicUrl('https://example.org/a?'+key+'=secret'),/访问令牌|签名/);
});
test('deadline and cancellation terminate requests waiting for headers or stalled mid-body',async()=>{
 for(const mode of ['headers','body'])for(const cancel of [false,true]){
  let destroyed=false;const controller=new AbortController();
  const request=(_url,options,callback)=>{
   const req=new EventEmitter();req.end=()=>queueMicrotask(()=>{
    let stream;
    if(mode==='body'){stream=new Readable({read(){}});stream.statusCode=200;stream.headers={'content-type':'text/plain'};callback(stream);stream.push(Buffer.from('a'));}
    options.signal.addEventListener('abort',()=>{destroyed=true;stream?.destroy(new Error('aborted'));req.emit('error',new Error('aborted'));},{once:true});
   });return req;
  };
  const hold=setTimeout(()=>{},100),fetch=createPublicFetcher({lookup,request});
  try{const pending=fetch('https://example.org/feed',{timeoutMs:20,signal:controller.signal});if(cancel)setTimeout(()=>controller.abort(),5);await assert.rejects(pending,/取消或超时/);assert.equal(destroyed,true);}finally{clearTimeout(hold);}
 }
});
