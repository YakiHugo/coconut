/** Owned copies of explicitly downloaded source media. No network or transcription. */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import identity from '../shared/source-media.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=(message,status=503)=>Object.assign(Error(message),{status});
const LIMIT=200*1024*1024,BUDGET=2*1024*1024*1024;
const TYPES=new Set(['audio/mpeg','audio/mp4','audio/wav','audio/ogg','audio/flac','audio/aac','audio/webm','video/mp4','video/webm','video/ogg','video/quicktime']);
export async function createSourceMediaStore({directory,libraryStore}){
 if(!path.isAbsolute(directory)||!libraryStore)throw fail('Source media requires a canonical library');
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 async function privatePath(file,isDirectory=false){const stat=await fs.lstat(file);if(stat.isSymbolicLink()||!(isDirectory?stat.isDirectory():stat.isFile())||!isDirectory&&stat.nlink!==1||process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.getuid()))throw fail('Unsafe source media storage');return stat;}
 await privatePath(directory,true);
 // The canonical library exclusive writer owns this directory. Interrupted
 // uploads have no receipt; remove only our private, generated staging names.
 for(const item of await fs.readdir(directory))if(/^[a-f0-9]{40}\.tmp$/.test(item)){const file=path.join(directory,item);await privatePath(file);await fs.unlink(file);}
 let pending=0,queue=Promise.resolve(),closed=false;const active=new Set();
 function owner(key){const record=libraryStore.get(key);if(!record||record.deleted)throw fail('Source document is unavailable',404);const library=libraryStore.describe().binding.mediaLibraryIdentity,source=hash(identity.sourceMediaIdentity(record.document));return {binding:hash(JSON.stringify([library,key,record.identity.lifetime,source])),source};}
 const filename=(name)=>path.join(directory,name);
 async function read(key,expected,{verify=true}={}){const current=owner(key);if(expected&&current.binding!==expected)throw fail('Source document changed',409);let record;try{const file=filename(current.binding+'.json');const stat=await privatePath(file);if(stat.size>4096)throw fail('Invalid media receipt');record=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
 if(record.binding!==current.binding||record.protocolVersion!==1||!/^[a-f0-9]{64}$/.test(record.sha256)||!Number.isSafeInteger(record.size)||record.size<1||record.size>LIMIT||!TYPES.has(record.type)||record.kind!==(record.type.startsWith('video/')?'video':'audio')||typeof record.name!=='string'||record.name.length>300)throw fail('Invalid media receipt');
 const blob=filename(record.sha256+'.media'),blobStat=await privatePath(blob);if(blobStat.size!==record.size)throw fail('Saved media changed',409);
 if(verify){const handle=await fs.open(blob,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),digest=createHash('sha256');try{for await(const chunk of handle.createReadStream({autoClose:false}))digest.update(chunk);}finally{await handle.close();}if(digest.digest('hex')!==record.sha256)throw fail('Saved media failed integrity check; explicitly download again to repair',409);}
 if(owner(key).binding!==current.binding)throw fail('Source document changed',409);return record;}
 async function atomic(file,bytes){const temporary=filename(randomBytes(20).toString('hex')+'.tmp');let handle;try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;await fs.rename(temporary,file);const dir=await fs.open(directory,'r');try{await dir.sync();}finally{await dir.close();}}finally{await handle?.close();await fs.unlink(temporary).catch(()=>{});}}
 async function saveInternal(key,source,stream,{type,name,signal}={}){
 if(closed||pending>=2)throw fail('Source media storage is busy');
 if(!TYPES.has(type)||typeof name!=='string'||!name||name.length>300||/[\\/\u0000-\u001f\u007f]/.test(name))throw fail('Invalid media file',400);
 const before=owner(key);if(source!==before.source)throw fail('Source document changed',409);
 pending++;const temporary=filename(randomBytes(20).toString('hex')+'.tmp');let handle,size=0;const digest=createHash('sha256');
 try{handle=await fs.open(temporary,'wx',0o600);for await(const chunk of stream){if(signal?.aborted||closed)throw fail('Media save cancelled',409);size+=chunk.length;if(size>LIMIT)throw fail('Media exceeds 200 MiB',413);digest.update(chunk);await handle.writeFile(chunk);}if(!size)throw fail('Empty media file',400);await handle.sync();await handle.close();handle=null;
 const sha256=digest.digest('hex'),record={protocolVersion:1,binding:before.binding,sha256,size,type,name,kind:type.startsWith('video/')?'video':'audio'};
 const operation=queue.then(async()=>{if(closed||signal?.aborted||owner(key).binding!==before.binding)throw fail('Source document changed',409);
 const blob=filename(sha256+'.media');let exists=false;try{const stat=await privatePath(blob);const digest=createHash('sha256');const existing=await fs.open(blob,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{for await(const chunk of existing.createReadStream({autoClose:false}))digest.update(chunk);}finally{await existing.close();}if(stat.size!==size||digest.digest('hex')!==sha256)await fs.rename(temporary,blob);exists=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!exists){let used=0;for(const item of await fs.readdir(directory))if(/^[a-f0-9]{64}\.media$/.test(item))used+=(await privatePath(filename(item))).size;if(used+size>BUDGET)throw fail('Source media storage exceeds 2 GiB; preserve or move the library before retrying',413);await fs.rename(temporary,blob);}
 await atomic(filename(before.binding+'.json'),JSON.stringify(record));if(signal?.aborted||owner(key).binding!==before.binding)throw fail('Source document changed',409);return record;});queue=operation.catch(()=>{});return await operation;
 }finally{pending--;await handle?.close();await fs.unlink(temporary).catch(()=>{});}}
 async function stream(key,binding,expectedDigest,req,res){const record=await read(key,binding,{verify:false});if(!record)throw fail('Saved media is unavailable',404);if(record.sha256!==expectedDigest)throw fail('Saved media was replaced',409);const file=filename(record.sha256+'.media');await privatePath(file);const handle=await fs.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const stat=await handle.stat();if(stat.size!==record.size)throw fail('Saved media changed',409);const digest=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false,start:0}))digest.update(chunk);if(digest.digest('hex')!==record.sha256)throw fail('Saved media failed integrity check',409);
 if(owner(key).binding!==binding)throw fail('Source document changed',409);
 let start=0,end=record.size-1,partial=false;const value=req.headers.range;if(value!==undefined){const match=/^bytes=(\d*)-(\d*)$/.exec(value);if(!match||!match[1]&&!match[2])throw fail('Invalid range',416);const first=match[1]?Number(match[1]):null,last=match[2]?Number(match[2]):null;if(first!==null&&!Number.isSafeInteger(first)||last!==null&&!Number.isSafeInteger(last)||first===null&&last===0)throw fail('Invalid range',416);start=first===null?Math.max(0,record.size-last):first;end=first===null||last===null?end:Math.min(last,end);if(start>end||start>=record.size)throw fail('Invalid range',416);partial=true;}
 const headers={'Content-Type':record.type,'Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};if(partial)headers['Content-Range']=`bytes ${start}-${end}/${record.size}`;res.writeHead(partial?206:200,headers);if(req.method==='HEAD')res.end();else await pipeline(handle.createReadStream({autoClose:false,start,end}),res);
 }catch(error){if(error.status===416)res.setHeader('Content-Range','bytes */'+record.size);throw error;}finally{await handle.close();}}
 function save(...args){const operation=saveInternal(...args);active.add(operation);void operation.finally(()=>active.delete(operation)).catch(()=>{});return operation;}
 async function input(key,binding,sha256){
 const record=await read(key,binding,{verify:false});if(!record||record.sha256!==sha256)throw fail('Saved media was replaced',409);
 const handle=await fs.open(filename(sha256+'.media'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const digest=createHash('sha256'),info=await handle.stat();if(info.size!==record.size)throw fail('Saved media changed',409);
 for await(const chunk of handle.createReadStream({autoClose:false,start:0}))digest.update(chunk);
 if(digest.digest('hex')!==sha256||owner(key).binding!==binding)throw fail('Saved media or source changed',409);
 return {record,body:handle.createReadStream({autoClose:false,start:0}),close:()=>handle.close()};
 }catch(error){await handle.close();throw error;}}
 return {owner,read,save,stream,input,async shutdown(){closed=true;await Promise.allSettled([...active]);await queue;}};
}
/** Called only after the bridge validates host, origin and Fetch Metadata. */
export async function handleSourceMediaRequest({req,res,pathname,origin,json,store,signal}){
 if(!pathname.startsWith('/api/v1/source-media'))return false;
 try{if(!store)throw fail('Saved source media is unavailable',503);const params=new URL(req.url,origin).searchParams,key=params.get('key');if(!key||key.length>1000)throw fail('Document key required',400);
 if(pathname==='/api/v1/source-media/content'&&['GET','HEAD'].includes(req.method)){await store.stream(key,params.get('binding'),params.get('sha256'),req,res);return true;}
 if(pathname!=='/api/v1/source-media')throw fail('Unknown source media endpoint',404);
 if(req.method==='GET'){if(store.owner(key).source!==params.get('source'))throw fail('Source document changed',409);const record=await store.read(key);json(record?200:404,{protocolVersion:1,media:record});return true;}
 if(req.method!=='POST')throw fail('Method not allowed',405);if(req.headers.origin!==origin)throw fail('Same-origin request required',403);
 const length=req.headers['content-length'];if(length&&(!/^\d+$/.test(length)||Number(length)>LIMIT))throw fail('Media exceeds 200 MiB',413);
 const record=await store.save(key,params.get('source'),req,{type:req.headers['content-type'],name:params.get('name'),signal});json(200,{protocolVersion:1,media:record});return true;
 }catch(error){if(!res.headersSent)json(error.status||503,{code:'source_media_unavailable',error:error.status?error.message:'Saved media is unavailable; preserve the library and retry'});else res.destroy();return true;}
}
