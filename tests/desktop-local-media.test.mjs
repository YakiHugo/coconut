import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {File} from 'node:buffer';
import {createHash,webcrypto,randomUUID} from 'node:crypto';
import {createLocalMediaService} from '../desktop/local-media.mjs';

// Exercise the sole production renderer's bounded identity algorithm.
const {build}=await import('esbuild');
const {outputFiles}=await build({entryPoints:['frontend/app/ingestion.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const {inspectFile}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
const fingerprintMedia=async file=>(await inspectFile(file)).identity;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t,{size=512*1024,sparse=false}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-native-media-'));
 const filePath=path.join(directory,'clip.mp3'),profile=path.join(directory,'profile');
 const bytes=sparse?null:Buffer.from(Array.from({length:size},(_,index)=>(index*13+11)%256));
 if(sparse){const handle=await fs.open(filePath,'w');await handle.truncate(size);await handle.close();}else await fs.writeFile(filePath,bytes);
 await fs.utimes(filePath,1700000000,1700000000);
 const source={version:1,kind:'audio',name:'clip.mp3',size,last_modified:1700000000000,type:'audio/mpeg'};
 const positions=[...new Set([0,Math.max(0,Math.floor((size-65536)/2)),Math.max(0,size-65536)])];
 const identity=sparse?'file-candidate-v1:'+JSON.stringify([source.name,size,source.last_modified,source.type,positions,positions.map(offset=>digest(Buffer.alloc(Math.min(65536,size-offset))))]):await fingerprintMedia(new File([bytes],source.name,{lastModified:source.last_modified,type:source.type}));
 source.fingerprint=digest(identity);
 const owner={key:'local-'+randomUUID(),epoch:1,library:randomUUID(),source};
 const services=[];
 const service=()=>{const value=createLocalMediaService({userDataDirectory:profile});services.push(value);return value;};
 t.after(async()=>{await Promise.all(services.map(value=>value.shutdown()));await fs.rm(directory,{recursive:true,force:true});});
 return {directory,filePath,profile,bytes,owner,identity,service};
}
async function serve(t,service){
 const server=http.createServer(async(req,res)=>{if(!await service.handle(req,res,new URL(req.url,'http://localhost').pathname)){res.writeHead(404);res.end('other');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 return 'http://127.0.0.1:'+server.address().port;
}
async function ready(t,options){
 const value=await fixture(t,options),service=value.service();
 assert.deepEqual(await service.remember(value.owner,value.filePath,value.identity),{status:'remembered'});
 const media=await service.resolve(value.owner);assert.equal(media.status,'ready');
 return {...value,native:service,media};
}
function assertPrivate(receipt,filePath){assert.equal(JSON.stringify(receipt).includes(filePath),false);assert.equal(Object.hasOwn(receipt,'path'),false);}

test('explicit remembering survives restart with the exact renderer identity and private path only in the registry',async t=>{
 const f=await fixture(t),first=f.service();
 assert.deepEqual(await first.resolve(f.owner),{status:'not-remembered'});
 assert.deepEqual(await first.remember({...f.owner,source:{...f.owner.source,unknown:'discard'}},f.filePath,f.identity),{status:'remembered'});
 const result=await first.resolve(f.owner);assert.equal(result.identity,f.identity);assert.equal(result.kind,'audio');assert.equal(result.name,'clip.mp3');assert.match(result.url,/^\/api\/local-media\/[a-f0-9]{48}$/);assertPrivate(result,f.filePath);
 const saved=JSON.parse(await fs.readFile(path.join(f.profile,'local-media.json'),'utf8'));
 assert.equal(saved.records[0].path,f.filePath);assert.equal(saved.records[0].owner.source.unknown,undefined);
 assert.match(saved.records[0].stat.ctimeNs,/^\d+$/);assert.match(saved.records[0].stat.ino,/^\d+$/);
 await first.shutdown();const restarted=f.service(),restored=await restarted.resolve(f.owner);
 assert.equal(restored.status,'ready');assert.equal(restored.identity,f.identity);assert.notEqual(restored.token,result.token);
 for(const owner of [{...f.owner,key:'other'},{...f.owner,epoch:2},{...f.owner,library:randomUUID()},{...f.owner,source:{...f.owner.source,name:'other.mp3'}}])assert.deepEqual(await restarted.resolve(owner),{status:'not-remembered'});
});

test('invalid owner, candidate, metadata, and non-regular file fail closed without a remembered receipt',async t=>{
 const f=await fixture(t),service=f.service();
 for(const owner of [null,{...f.owner,epoch:0},{...f.owner,epoch:1.2},{...f.owner,library:'not-a-library'},{...f.owner,source:{...f.owner.source,name:'../clip.mp3'}}])assert.deepEqual(await service.remember(owner,f.filePath,f.identity),{status:'unavailable'});
 assert.deepEqual(await service.remember(f.owner,'relative/clip.mp3',f.identity),{status:'unavailable'});
 assert.deepEqual(await service.remember(f.owner,f.filePath,f.identity+'x'),{status:'unavailable'});
 assert.deepEqual(await service.remember(f.owner,f.directory,f.identity),{status:'unavailable'});
 await fs.writeFile(f.filePath,Buffer.alloc(f.owner.source.size,77));await fs.utimes(f.filePath,1700000000,1700000000);
 assert.deepEqual(await service.remember(f.owner,f.filePath,f.identity),{status:'changed'});
 assert.deepEqual(await service.resolve(f.owner),{status:'not-remembered'});
});

test('missing file is reported without dropping the private reference or leaking the path',async t=>{
 const f=await ready(t);await fs.unlink(f.filePath);
 const result=await f.native.resolve(f.owner);assert.deepEqual(result,{status:'missing'});assertPrivate(result,f.filePath);
 const data=JSON.parse(await fs.readFile(path.join(f.profile,'local-media.json'),'utf8'));assert.equal(data.records.length,1);
 const base=await serve(t,f.native),response=await fetch(base+f.media.url);
 assert.equal(response.status,404);assert.deepEqual(await response.json(),{status:'missing'});
});

test('same-path replacement with identical bytes and mtime is rejected on resolve and on the actual streaming descriptor',async t=>{
 const f=await ready(t),replacement=path.join(f.directory,'replacement.mp3');
 await fs.writeFile(replacement,f.bytes);await fs.utimes(replacement,1700000000,1700000000);await fs.rename(replacement,f.filePath);
 assert.deepEqual(await f.native.resolve(f.owner),{status:'changed'});
 const base=await serve(t,f.native),response=await fetch(base+f.media.url);
 assert.equal(response.status,409);const body=await response.json();assert.deepEqual(body,{status:'changed'});assertPrivate(body,f.filePath);
});

test('ordinary same-inode changes outside all three samples are rejected even when mtime is restored',async t=>{
 const f=await ready(t),before=await fs.stat(f.filePath,{bigint:true});await delay(5);
 const changed=Buffer.from(f.bytes);changed[128*1024]^=255;
 const handle=await fs.open(f.filePath,'r+');await handle.write(changed.subarray(128*1024,128*1024+1),0,1,128*1024);await handle.close();await fs.utimes(f.filePath,1700000000,1700000000);
 const after=await fs.stat(f.filePath,{bigint:true});assert.equal(after.ino,before.ino);assert.equal(after.mtimeNs,before.mtimeNs);assert.notEqual(after.ctimeNs,before.ctimeNs);
 assert.equal(await fingerprintMedia(new File([changed],'clip.mp3',{lastModified:f.owner.source.last_modified,type:'audio/mpeg'})),f.identity,'bounded renderer candidate intentionally still matches');
 assert.deepEqual(await f.native.resolve(f.owner),{status:'changed'});
 const base=await serve(t,f.native),response=await fetch(base+f.media.url);assert.equal(response.status,409);assert.deepEqual(await response.json(),{status:'changed'});
});

test('GET, HEAD, seeking ranges and unsatisfiable ranges stream correct bytes',async t=>{
 const f=await ready(t,{size:200000}),base=await serve(t,f.native);
 const whole=await fetch(base+f.media.url);assert.equal(whole.status,200);assert.equal(whole.headers.get('content-type'),'audio/mpeg');assert.deepEqual(Buffer.from(await whole.arrayBuffer()),f.bytes);
 const head=await fetch(base+f.media.url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),'200000');assert.equal((await head.arrayBuffer()).byteLength,0);
 for(const [range,start,end] of [['bytes=1-9',1,9],['bytes=-5',199995,199999],['bytes=199990-',199990,199999],['bytes=0-999999',0,199999]]){
  const response=await fetch(base+f.media.url,{headers:{Range:range}});assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),`bytes ${start}-${end}/200000`);assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.bytes.subarray(start,end+1));
 }
 for(const range of ['bytes=','bytes=-0','bytes=200000-','bytes=8-7','bytes=0-1,5-6','bytes=999999999999999999999-','items=0-1']){
  const response=await fetch(base+f.media.url,{headers:{Range:range}});assert.equal(response.status,416,range);assert.equal(response.headers.get('content-range'),'bytes */200000');await response.arrayBuffer();
 }
 const rangedHead=await fetch(base+f.media.url,{method:'HEAD',headers:{Range:'bytes=10-19'}});assert.equal(rangedHead.status,206);assert.equal(rangedHead.headers.get('content-length'),'10');assert.equal((await rangedHead.arrayBuffer()).byteLength,0);
 assert.equal((await fetch(base+f.media.url,{method:'POST'})).status,405);
 assert.equal((await fetch(base+'/api/local-media/not-a-token')).status,404);
 assert.equal(await f.native.handle({},{},'/unrelated'),false);
});

test('a sparse 5 GiB original resolves and serves only the requested tail without full-file allocation',async t=>{
 const f=await ready(t,{size:5*1024*1024*1024,sparse:true}),base=await serve(t,f.native);
 const response=await fetch(base+f.media.url,{headers:{Range:'bytes=-32'}});assert.equal(response.status,206);assert.equal(response.headers.get('content-length'),'32');assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.alloc(32));
 const head=await fetch(base+f.media.url,{method:'HEAD'});assert.equal(head.headers.get('content-length'),String(f.owner.source.size));
});

test('forget persists before reporting success, keeps session playback and never deletes the original',async t=>{
 const f=await ready(t),base=await serve(t,f.native);
 assert.deepEqual(await f.native.forget({...f.owner,epoch:2}),{status:'not-remembered'});
 assert.equal((await f.native.resolve(f.owner)).status,'ready');
 assert.deepEqual(await f.native.forget(f.owner),{status:'forgotten'});
 const response=await fetch(base+f.media.url);assert.equal(response.status,200);await response.arrayBuffer();assert.equal((await fs.stat(f.filePath)).size,f.bytes.length);
 await f.native.release(f.media.token);assert.equal((await fetch(base+f.media.url)).status,404);
 assert.deepEqual(await f.service().resolve(f.owner),{status:'not-remembered'});
});

test('reconcile is all-or-nothing for valid catalog owners and retires removed, replaced and reset-library records',async t=>{
 const f=await fixture(t),service=f.service(),owners=[f.owner,{...f.owner,key:'second'},{...f.owner,key:'third'}];
 await Promise.all(owners.map(owner=>service.remember(owner,f.filePath,f.identity)));
 const media=await service.resolve(owners[1]);
 assert.deepEqual(await service.reconcile([owners[0],{}]),{status:'unavailable'});
 assert.deepEqual(await service.reconcile([owners[0],owners[0]]),{status:'unavailable'});
 assert.equal((await service.resolve(owners[1])).status,'ready');
 assert.deepEqual(await service.reconcile([owners[0],{...owners[1],epoch:2},{...owners[2],library:randomUUID()}]),{status:'reconciled',rememberedKeys:[owners[0].key]});
 assert.equal((await service.resolve(owners[0])).status,'ready');assert.deepEqual(await service.resolve(owners[1]),{status:'not-remembered'});assert.deepEqual(await service.resolve(owners[2]),{status:'not-remembered'});
 const base=await serve(t,service);assert.equal((await fetch(base+media.url)).status,404);
 const restarted=f.service();assert.equal((await restarted.resolve(owners[0])).status,'ready');assert.deepEqual(await restarted.resolve(owners[1]),{status:'not-remembered'});
 assert.deepEqual(await restarted.reconcile([]),{status:'reconciled',rememberedKeys:[]});assert.deepEqual(await restarted.resolve(owners[0]),{status:'not-remembered'});
});

test('atomic write failure neither reports success nor changes the in-memory registry',async t=>{
 const f=await ready(t),manifest=path.join(f.profile,'local-media.json'),backup=manifest+'.saved';
 await fs.rename(manifest,backup);await fs.mkdir(manifest);
 assert.deepEqual(await f.native.forget(f.owner),{status:'unavailable'});
 assert.deepEqual(await f.native.remember({...f.owner,key:'failed'},f.filePath,f.identity),{status:'unavailable'});
 assert.deepEqual(await f.native.resolve({...f.owner,key:'failed'}),{status:'not-remembered'});assert.equal((await f.native.resolve(f.owner)).status,'ready');
 assert.deepEqual((await fs.readdir(f.profile)).sort(),['local-media.json','local-media.json.saved']);
 await fs.rmdir(manifest);await fs.rename(backup,manifest);
 assert.equal((await f.service().resolve(f.owner)).status,'ready');
});

test('unwritable location and malformed or oversized registry stay unavailable without exposing filesystem errors',async t=>{
 const f=await fixture(t);await fs.writeFile(f.profile,'not a directory');
 assert.deepEqual(await f.service().remember(f.owner,f.filePath,f.identity),{status:'unavailable'});
 await fs.unlink(f.profile);await fs.mkdir(f.profile);
 for(const bytes of [Buffer.from('{broken'),Buffer.alloc(2*1024*1024+1,32)]){
  await fs.writeFile(path.join(f.profile,'local-media.json'),bytes);const service=f.service();
  const result=await service.resolve(f.owner);assert.deepEqual(result,{status:'unavailable'});assertPrivate(result,f.filePath);
  assert.deepEqual(await service.remember(f.owner,f.filePath,f.identity),{status:'unavailable'});assert.equal((await fs.stat(path.join(f.profile,'local-media.json'))).size,bytes.length);
 }
});

test('serialized remember and forget mutations do not lose unrelated records',async t=>{
 const f=await fixture(t),service=f.service(),other={...f.owner,key:'second'};
 const results=await Promise.all([service.remember(f.owner,f.filePath,f.identity),service.remember(other,f.filePath,f.identity),service.forget(f.owner)]);
 assert.deepEqual(results.map(value=>value.status),['remembered','remembered','forgotten']);
 const restarted=f.service();assert.deepEqual(await restarted.resolve(f.owner),{status:'not-remembered'});assert.equal((await restarted.resolve(other)).status,'ready');
});

test('token budget is bounded, release frees capacity, and releaseAll fences queued resolves across renderer lifetimes',async t=>{
 const f=await ready(t,{size:1000}),tokens=[f.media.token];
 for(let i=1;i<64;i++){const result=await f.native.resolve(f.owner);assert.equal(result.status,'ready');tokens.push(result.token);}
 assert.deepEqual(await f.native.resolve(f.owner),{status:'unavailable'});
 assert.deepEqual(await f.native.release(tokens[0]),{status:'released'});assert.equal((await f.native.resolve(f.owner)).status,'ready');
 await f.native.releaseAll();const base=await serve(t,f.native);assert.equal((await fetch(base+f.media.url)).status,404);
 const pending=f.native.resolve(f.owner);await f.native.releaseAll();assert.deepEqual(await pending,{status:'unavailable'});
 assert.equal((await f.native.resolve(f.owner)).status,'ready');
 await f.native.shutdown();assert.deepEqual(await f.native.resolve(f.owner),{status:'unavailable'});
});

async function pausedResponse(url){
 return new Promise((resolve,reject)=>{const request=http.get(url,response=>{response.pause();resolve({request,response});});request.once('error',reject);});
}
async function openMediaDescriptors(filePath){
 try{const entries=await fs.readdir('/proc/self/fd');const paths=await Promise.all(entries.map(entry=>fs.readlink('/proc/self/fd/'+entry).catch(()=>'')));return paths.filter(value=>value===filePath).length;}
 catch{return null;}
}
test('release, response abort and shutdown close active streaming descriptors',async t=>{
 const f=await ready(t,{size:64*1024*1024,sparse:true}),base=await serve(t,f.native);
 for(const mode of ['release','abort','shutdown']){
  const media=mode==='release'?f.media:await f.native.resolve(f.owner),{request,response}=await pausedResponse(base+media.url);
  response.on('error',()=>{});
  if(mode==='release')await f.native.release(media.token);
  else if(mode==='shutdown')await f.native.shutdown();
  else {request.destroy();response.destroy();await delay(30);}
  response.destroy();request.destroy();
  const descriptors=await openMediaDescriptors(f.filePath);if(descriptors!==null)assert.equal(descriptors,0,mode+' leaves no open media descriptors');
 }
});
