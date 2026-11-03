import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createPublicFetcher,validatePodcastProxy} from '../desktop/public-http.mjs';
const execute=promisify(execFile),moduleUrl=new URL('../desktop/public-http.mjs',import.meta.url).href;
let directory,cert,key;
before(async()=>{
 directory=await mkdtemp(path.join(tmpdir(),'coconut-podcast-tls-'));
 await writeFile(path.join(directory,'openssl.cnf'),'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=www.xiaoyuzhoufm.com\n[ext]\nsubjectAltName=DNS:www.xiaoyuzhoufm.com,DNS:media.xyzcdn.net\nbasicConstraints=critical,CA:TRUE\n');
 await execute('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-sha256','-config',path.join(directory,'openssl.cnf'),'-keyout',path.join(directory,'key.pem'),'-out',path.join(directory,'cert.pem')],{timeout:20000});
 cert=await readFile(path.join(directory,'cert.pem'));key=await readFile(path.join(directory,'key.pem'));
});
after(async()=>{if(directory)await rm(directory,{recursive:true,force:true});});
async function fixture(t,{connectStatus=200,stall=false,respond}={}){
 const connects=[],requests=[],sni=[],sockets=new Set();
 const track=socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));};
 const origin=https.createServer({cert,key},(req,res)=>{
  requests.push({url:req.url,headers:req.headers});
  if(respond)return respond(req,res);
  res.writeHead(200,{'Content-Type':'text/plain','Content-Length':'7'});res.end('fixture');
 });
 origin.on('connection',track);origin.on('secureConnection',socket=>sni.push(socket.servername));
 await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));
 const proxy=http.createServer();proxy.on('connection',track);
 proxy.on('connect',(req,socket,head)=>{
  connects.push({url:req.url,headers:req.headers});
  if(stall)return;
  if(connectStatus!==200){socket.end(`HTTP/1.1 ${connectStatus} Denied\r\nContent-Length: 0\r\n\r\n`);return;}
  const upstream=net.connect(origin.address().port,'127.0.0.1',()=>{
   socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
   if(head.length)upstream.write(head);
   socket.pipe(upstream);upstream.pipe(socket);
  });
  track(upstream);socket.once('close',()=>upstream.destroy());upstream.once('close',()=>socket.destroy());
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const socket of sockets)socket.destroy();await Promise.all([new Promise(resolve=>proxy.close(resolve)),new Promise(resolve=>origin.close(resolve))]);});
 return {url:`http://127.0.0.1:${proxy.address().port}`,connects,requests,sni};
}
async function run(proxy,{url='https://www.xiaoyuzhoufm.com/episode/authored',trust=true,options={},owner=false,environment=null}={}){
 const code=`import {createPublicFetcher} from ${JSON.stringify(moduleUrl)};
 const fetch=createPublicFetcher(${owner?`{ownerSources:true,ownerNetwork:${JSON.stringify(environment?{mode:'environment',environment}:{mode:'custom',proxy})},lookup:async()=>{throw Error('Unexpected preflight DNS');}}`:`{xiaoyuzhouProxy:${JSON.stringify(proxy)},lookup:async()=>{throw Error('Unexpected origin DNS');},request:()=>{throw Error('Unexpected direct fallback');}}`});
 try {const r=await fetch(${JSON.stringify(url)},${JSON.stringify(options)});console.log(JSON.stringify({ok:true,body:r.body.toString(),length:r.length}));}
 catch(error){console.log(JSON.stringify({ok:false,error:error.message}));}`;
 const env={...process.env};delete env.NODE_EXTRA_CA_CERTS;delete env.NODE_TLS_REJECT_UNAUTHORIZED;
 if(trust)env.NODE_EXTRA_CA_CERTS=path.join(directory,'cert.pem');
 const {stdout}=await execute(process.execPath,['--input-type=module','-e',code],{env,timeout:10000});
 return JSON.parse(stdout);
}
test('podcast proxy is explicit, numeric loopback only and cannot contain credentials',()=>{
 for(const value of [null,undefined])assert.equal(validatePodcastProxy(value),null);
 for(const value of ['http://127.0.0.1:80','http://127.0.0.1:7897/','http://[::1]:65535'])assert.equal(validatePodcastProxy(value),value.replace(/\/$/,''));
 for(const value of ['',false,'http://localhost:7897','https://127.0.0.1:7897','http://127.0.0.2:7897','http://10.0.0.1:7897','http://u:p@127.0.0.1:7897','http://127.0.0.1:7897/path','http://127.0.0.1:7897?x=1','http://127.0.0.1:0','http://127.0.0.1:65536','http://127.0.0.1:7897\n',' http://127.0.0.1:7897'])assert.throws(()=>validatePodcastProxy(value));
});
test('real CONNECT keeps origin SNI and TLS verification, without local origin DNS or credentials',async t=>{
 const proxy=await fixture(t);const result=await run(proxy.url);
 assert.deepEqual(result,{ok:true,body:'fixture',length:7});
 assert.deepEqual(proxy.sni,['www.xiaoyuzhoufm.com']);
 assert.equal(proxy.connects[0].url,'www.xiaoyuzhoufm.com:443');
 assert.equal(proxy.requests[0].headers.host,'www.xiaoyuzhoufm.com');
 assert.equal(proxy.requests[0].headers['accept-encoding'],'identity');
 for(const {headers} of [...proxy.connects,...proxy.requests])for(const name of ['cookie','authorization','proxy-authorization'])assert.equal(headers[name],undefined);
});
test('standalone owner sources use the native Node proxy agent with real CONNECT and verified TLS',async t=>{
 const proxy=await fixture(t);assert.deepEqual(await run(proxy.url,{owner:true}),{ok:true,body:'fixture',length:7});
 assert.equal(proxy.connects[0].url,'www.xiaoyuzhoufm.com:443');assert.equal(proxy.sni[0],'www.xiaoyuzhoufm.com');
 assert.equal((await run(proxy.url,{owner:true,trust:false})).ok,false);
});
test('standalone HTTP ALL_PROXY aliases use the real tunnel instead of silently connecting directly',async t=>{
 const proxy=await fixture(t);
 for(const environment of [{ALL_PROXY:proxy.url},{all_proxy:proxy.url},{ALL_PROXY:'http://127.0.0.1:1',all_proxy:proxy.url}])assert.equal((await run(proxy.url,{owner:true,environment})).ok,true);
 assert.equal(proxy.connects.length,3);assert.ok(proxy.connects.every(connection=>connection.url==='www.xiaoyuzhoufm.com:443'));
});
test('untrusted certificates and mismatched origin names fail before an origin GET',async t=>{
 const proxy=await fixture(t);
 assert.equal((await run(proxy.url,{trust:false})).ok,false);
 assert.equal((await run(proxy.url,{url:'https://xiaoyuzhoufm.com/episode/authored'})).ok,false);
 assert.equal(proxy.requests.length,0);
});
test('proxy redirects stay within exact HTTPS origins and never silently fall back',async t=>{
 let target='https://media.xyzcdn.net/authored.m4a';
 const proxy=await fixture(t,{respond:(req,res)=>{
  if(req.url==='/episode/authored'){res.writeHead(302,{Location:target,'Set-Cookie':'private=ignored'});res.end();}
  else{res.writeHead(200,{'Content-Type':'text/plain'});res.end('media fixture');}
 }});
 assert.equal((await run(proxy.url)).body,'media fixture');assert.equal(proxy.connects.length,2);
 for(target of ['https://evil.example/path','https://127.0.0.1/private','https://www.xiaoyuzhoufm.com.evil.example/a','http://www.xiaoyuzhoufm.com/a','https://media.xyzcdn.net/a?token=secret']){
  const before=proxy.connects.length;assert.equal((await run(proxy.url)).ok,false);assert.equal(proxy.connects.length,before+1);
 }
 assert(proxy.requests.every(req=>!req.headers.cookie));
});
test('CONNECT denial and stalled tunnel cancellation are terminal, without direct fallback',async t=>{
 const denied=await fixture(t,{connectStatus:407});assert.equal((await run(denied.url)).ok,false);assert.equal(denied.requests.length,0);
 const stalled=await fixture(t,{stall:true});
 await assert.rejects(createPublicFetcher({xiaoyuzhouProxy:stalled.url})('https://www.xiaoyuzhoufm.com/episode/authored',{timeoutMs:30}),/取消或超时/);
 assert.equal(stalled.requests.length,0);
});
test('body limits, media header inspection and aborts still apply through the real tunnel',async t=>{
 const proxy=await fixture(t,{respond:(_req,res)=>{res.writeHead(200,{'Content-Type':'audio/mp4','Content-Length':'100'});res.end('x'.repeat(100));}});
 assert.equal((await run(proxy.url,{options:{maxBytes:50}})).ok,false);
 assert.deepEqual(await run(proxy.url,{options:{inspectMedia:true,maxMediaBytes:100}}),{ok:true,body:'',length:100});
 assert.equal((await run(proxy.url,{options:{inspectMedia:true,maxMediaBytes:99}})).ok,false);
 const slow=await fixture(t,{respond:(_req,res)=>{res.writeHead(200,{'Content-Type':'text/plain'});res.write('a');}});
 assert.match((await run(slow.url,{options:{timeoutMs:100}})).error,/取消或超时/);
});
test('configuring the scoped proxy preserves public DNS checks for every other source',async()=>{
 let requests=0,lookups=0;
 const fetch=createPublicFetcher({xiaoyuzhouProxy:'http://127.0.0.1:7897',lookup:async()=>{lookups++;return [{address:'198.18.0.10',family:4}];},request:()=>{requests++;}});
 for(const url of ['https://publisher.example/feed','https://media.xyzcdn.net.evil.example/a','http://www.xiaoyuzhoufm.com/a'])await assert.rejects(fetch(url),/非公开地址/);
 assert.equal(lookups,3);assert.equal(requests,0);
});
