/** Private, opt-in original-file references. No media copy or portable document fields. */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {pipeline} from 'node:stream/promises';

const require=createRequire(import.meta.url);
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_BYTES=64*1024, MANIFEST_BYTES=2*1024*1024;
const MAX_RECORDS=256, MAX_TOKENS=64, MAX_STREAMS=16, MAX_PENDING=64;
const PREFIX='/api/local-media/';
const TYPES=new Set(['audio/mpeg','audio/mp3','audio/mp4','audio/x-m4a','audio/wav','audio/x-wav','audio/ogg','audio/flac','audio/x-flac','audio/aac','audio/opus','video/mp4','video/webm','audio/webm','video/quicktime','video/x-m4v','application/octet-stream']);
const STAT_FIELDS=['dev','ino','size','birthtimeNs','mtimeNs','ctimeNs'];
const hash=value=>createHash('sha256').update(value).digest('hex');
const status=value=>({status:value});
const fail=value=>Object.assign(new Error(value),{mediaStatus:value});
const publicStatus=error=>error?.mediaStatus||(['ENOENT','ENOTDIR'].includes(error?.code)?'missing':'unavailable');
const validPath=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!value.includes('\0')&&path.isAbsolute(value);
const offsets=size=>[...new Set([0,Math.max(0,Math.floor((size-SAMPLE_BYTES)/2)),Math.max(0,size-SAMPLE_BYTES)])];
function snapshot(stat){
 if(!stat.isFile()||stat.ino<=0n||stat.size<=0n||stat.size>BigInt(Number.MAX_SAFE_INTEGER)||stat.ctimeNs<=0n)throw fail('unavailable');
 return Object.fromEntries(STAT_FIELDS.map(key=>[key,String(stat[key])]));
}
const sameStat=(a,b)=>STAT_FIELDS.every(key=>a[key]===b[key]);
function byteRange(header,size){
 if(header===undefined)return {start:0,end:size-1,partial:false};
 const match=/^bytes=(\d*)-(\d*)$/.exec(header);
 if(!match||!match[1]&&!match[2])return null;
 const first=match[1]?Number(match[1]):null,last=match[2]?Number(match[2]):null;
 if(first!==null&&!Number.isSafeInteger(first)||last!==null&&!Number.isSafeInteger(last))return null;
 const start=first===null?Math.max(0,size-last):first,end=first===null||last===null?size-1:Math.min(last,size-1);
 return start>=size||end<start||first===null&&last===0?null:{start,end,partial:true};
}

export function createLocalMediaService({userDataDirectory,readerDirectory=path.resolve(ROOT,'../reader')}={}){
 if(!validPath(userDataDirectory))throw new Error('A local user data directory is required');
 const Coconut=require(path.join(readerDirectory,'core.js'));
 const manifest=path.join(userDataDirectory,'local-media.json');
 let records=new Map(),loaded=false,closed=false,pending=0,generation=0,queue=Promise.resolve();
 const tokens=new Map(),streams=new Set();
 function owner(value){
  const source=Coconut.localMediaSource(value?.source);
  if(typeof value?.key!=='string'||!value.key||value.key.length>1000||!Number.isSafeInteger(value.epoch)||value.epoch<=0||typeof value.library!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.library)||!source)throw fail('unavailable');
  return {key:value.key,epoch:value.epoch,library:value.library,source};
 }
 const recordKey=value=>JSON.stringify([value.library,value.key]);
 const validLibrary=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
 const ownerId=value=>JSON.stringify([value.key,value.epoch,value.library,value.source]);
 function validIdentity(identity,source){
  if(typeof identity!=='string'||identity.length>3000||!identity.startsWith('file-candidate-v1:')||hash(identity)!==source.fingerprint)return false;
  try{
   const data=JSON.parse(identity.slice('file-candidate-v1:'.length));
   return Array.isArray(data)&&data.length===6&&data[0]===source.name&&data[1]===source.size&&data[2]===source.last_modified&&data[3]===source.type&&
    JSON.stringify(data[4])===JSON.stringify(offsets(source.size))&&Array.isArray(data[5])&&data[5].length===data[4].length&&data[5].every(item=>typeof item==='string'&&/^[a-f0-9]{64}$/.test(item));
  }catch{return false;}
 }
 async function load(){
  if(loaded)return;
  let handle;
  try{
   handle=await fs.open(manifest,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK);
   const stat=await handle.stat();
   if(!stat.isFile()||stat.size>MANIFEST_BYTES)throw fail('unavailable');
   const buffer=Buffer.alloc(MANIFEST_BYTES+1);let length=0;
   while(length<buffer.length){const result=await handle.read(buffer,length,buffer.length-length,length);if(!result.bytesRead)break;length+=result.bytesRead;}
   if(length>MANIFEST_BYTES)throw fail('unavailable');
   const data=JSON.parse(buffer.subarray(0,length).toString('utf8'));
   if(data?.version!==1||!Array.isArray(data.records)||data.records.length>MAX_RECORDS)throw fail('unavailable');
   const next=new Map();
   for(const record of data.records){
    const normalized=owner(record?.owner);
    if(!validPath(record.path)||!validIdentity(record.identity,normalized.source)||!record.stat||!STAT_FIELDS.every(key=>typeof record.stat[key]==='string'&&/^-?\d{1,30}$/.test(record.stat[key]))||next.has(recordKey(normalized)))throw fail('unavailable');
    next.set(recordKey(normalized),{owner:normalized,path:record.path,identity:record.identity,stat:Object.fromEntries(STAT_FIELDS.map(key=>[key,record.stat[key]]))});
   }
   records=next;loaded=true;
  }catch(error){if(error.code==='ENOENT'){records=new Map();loaded=true;}else throw fail('unavailable');}
  finally{await handle?.close().catch(()=>{});}
 }
 async function persist(next){
  const data=JSON.stringify({version:1,records:[...next.values()]});
  if(next.size>MAX_RECORDS||Buffer.byteLength(data)>MANIFEST_BYTES)throw fail('unavailable');
  await fs.mkdir(userDataDirectory,{recursive:true});
  const temporary=manifest+'.'+randomBytes(12).toString('hex')+'.tmp';let handle;
  try{
   handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(data);await handle.sync();await handle.close();handle=null;
   await fs.rename(temporary,manifest);records=next;
  }finally{await handle?.close().catch(()=>{});await fs.unlink(temporary).catch(()=>{});}
 }
 function run(action){
  if(closed||pending>=MAX_PENDING)return Promise.resolve(status('unavailable'));
  pending++;
  const task=queue.then(async()=>{if(closed)return status('unavailable');await load();return action();}).catch(error=>status(publicStatus(error))).finally(()=>{pending--;});
  queue=task;return task;
 }
 async function checkedFile(record,{remember=false}={}){
  let handle;
  try{
   // Open first, then validate the descriptor used for sampling AND streaming.
   handle=await fs.open(record.path,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK);
   const before=snapshot(await handle.stat({bigint:true})),source=record.owner.source;
   if(!remember&&!sameStat(before,record.stat)||Number(before.size)!==source.size||Number(BigInt(before.mtimeNs)/1000000n)!==source.last_modified||path.basename(record.path)!==source.name)throw fail('changed');
   const type=source.type.toLowerCase(),extension=source.name.split('.').pop().toLowerCase();
   const kind=type.startsWith('video/')?'video':type.startsWith('audio/')?'audio':['mp4','webm','mov','m4v'].includes(extension)?'video':['mp3','m4a','wav','ogg','flac','aac','opus'].includes(extension)?'audio':null;
   if(type&&!TYPES.has(type)||kind!==source.kind)throw fail('unavailable');
   const positions=offsets(source.size),samples=[];
   for(const position of positions){
    const bytes=Buffer.alloc(Math.min(SAMPLE_BYTES,source.size-position));let length=0;
    while(length<bytes.length){const result=await handle.read(bytes,length,bytes.length-length,position+length);if(!result.bytesRead)throw fail('changed');length+=result.bytesRead;}
    if(position===0&&/^\s*(?:#EXTM3U|\[playlist\]|<\?xml|<MPD|<SmoothStreamingMedia|<ASX|<smil|<!doctype|<html)/i.test(bytes.subarray(0,1024).toString('utf8')))throw fail('unavailable');
    samples.push(hash(bytes));
   }
   const identity='file-candidate-v1:'+JSON.stringify([source.name,source.size,source.last_modified,source.type,positions,samples]);
   if(identity!==record.identity||!sameStat(before,snapshot(await handle.stat({bigint:true}))))throw fail('changed');
   return {handle,stat:before};
  }catch(error){await handle?.close().catch(()=>{});throw error;}
 }
 function cancelToken(token){
  tokens.delete(token);
  for(const stream of streams)if(stream.token===token){stream.cancelled=true;stream.source?.destroy();stream.res.destroy();}
 }
 function retire(predicate){for(const [token,record] of tokens)if(predicate(record))cancelToken(token);}
 const api={
  remember(value,filePath,identity){return run(async()=>{
   const normalized=owner(value);
   if(!validPath(filePath)||!validIdentity(identity,normalized.source))return status('unavailable');
   const record={owner:normalized,path:filePath,identity};
   const checked=await checkedFile(record,{remember:true});await checked.handle.close();record.stat=checked.stat;
   if(closed)return status('unavailable');
   const next=new Map(records);next.set(recordKey(normalized),record);await persist(next);
   retire(item=>recordKey(item.owner)===recordKey(normalized));
   return status('remembered');
  });},
  resolve(value){const requestedGeneration=generation;return run(async()=>{
   if(requestedGeneration!==generation)return status('unavailable');
   const normalized=owner(value),record=records.get(recordKey(normalized));
   if(!record||ownerId(record.owner)!==ownerId(normalized))return status('not-remembered');
   if(tokens.size>=MAX_TOKENS)return status('unavailable');
   const checked=await checkedFile(record);await checked.handle.close();
   if(closed)return status('unavailable');
   if(requestedGeneration!==generation)return status('unavailable');
   const token=randomBytes(24).toString('hex');tokens.set(token,record);
   return {status:'ready',token,url:PREFIX+token,kind:record.owner.source.kind,name:record.owner.source.name,identity:record.identity};
  });},
  forget(value){return run(async()=>{
   const normalized=owner(value),record=records.get(recordKey(normalized));
   if(!record||ownerId(record.owner)!==ownerId(normalized))return status('not-remembered');
   const next=new Map(records);next.delete(recordKey(normalized));await persist(next);
   // Opting out removes persistence, not the already selected session player.
   // Unlink/removal releases its attachment separately; reconcile fences owners.
   return status('forgotten');
  });},
  // A complete catalog authorizes pruning only its own namespace. Other
  // libraries (including retained browser recovery) remain intact even when
  // the current SQLite library is empty or reuses the same document keys.
  reconcile(values,library){return run(async()=>{
   if(!validLibrary(library)||!Array.isArray(values)||values.length>10000)return status('unavailable');
   const live=new Map();for(const value of values){const normalized=owner(value);if(normalized.library!==library||live.has(normalized.key))return status('unavailable');live.set(normalized.key,ownerId(normalized));}
   const next=new Map([...records].filter(([,record])=>record.owner.library!==library||live.get(record.owner.key)===ownerId(record.owner)));
   if(next.size!==records.size)await persist(next);
   retire(item=>item.owner.library===library&&live.get(item.owner.key)!==ownerId(item.owner));
   return {status:'reconciled',rememberedKeys:[...next.values()].filter(record=>record.owner.library===library).map(record=>record.owner.key)};
  });},
  async release(token){
   if(typeof token!=='string'||!tokens.has(token))return status('released');
   cancelToken(token);await Promise.all([...streams].filter(stream=>stream.token===token).map(stream=>stream.done));return status('released');
  },
  async releaseAll(){
   generation++;for(const token of tokens.keys())cancelToken(token);
   await Promise.all([...streams].map(stream=>stream.done));return status('released');
  },
  async shutdown(){
   closed=true;await api.releaseAll();await queue;
  },
  async handle(req,res,pathname){
   if(pathname!=='/api/local-media'&&!pathname.startsWith(PREFIX))return false;
   const reply=(code,value,headers={})=>{
    if(res.destroyed)return;
    const body=JSON.stringify(status(value));res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store',...headers});res.end(req.method==='HEAD'?undefined:body);
   };
   if(!['GET','HEAD'].includes(req.method)){reply(405,'unavailable',{Allow:'GET, HEAD'});return true;}
   const token=pathname.slice(PREFIX.length),record=/^[a-f0-9]{48}$/.test(token)&&tokens.get(token);
   if(closed||!record){reply(404,'not-remembered');return true;}
   if(streams.size>=MAX_STREAMS){reply(503,'unavailable');return true;}
   let finish;const operation={token,res,cancelled:false,done:new Promise(resolve=>{finish=resolve;})};streams.add(operation);
   const cancel=()=>{operation.cancelled=true;operation.source?.destroy();};
   req.once('aborted',cancel);res.once('close',cancel);
   let handle;
   try{
    const checked=await checkedFile(record);handle=checked.handle;
    if(operation.cancelled||closed||tokens.get(token)!==record)return true;
    const range=byteRange(req.headers.range,record.owner.source.size);
    if(!range){reply(416,'unavailable',{'Content-Range':'bytes */'+record.owner.source.size});return true;}
    const headers={'Content-Type':record.owner.source.type||'application/octet-stream','Content-Length':range.end-range.start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
    if(range.partial)headers['Content-Range']=`bytes ${range.start}-${range.end}/${record.owner.source.size}`;
    res.writeHead(range.partial?206:200,headers);
    if(req.method==='HEAD'){res.end();return true;}
    operation.source=handle.createReadStream({start:range.start,end:range.end,autoClose:false,highWaterMark:SAMPLE_BYTES});
    await pipeline(operation.source,res);
   }catch(error){
    if(!res.headersSent)reply(error?.mediaStatus==='changed'?409:error?.code==='ENOENT'||error?.code==='ENOTDIR'?404:503,publicStatus(error));
    else res.destroy();
   }finally{
    operation.source?.destroy();await handle?.close().catch(()=>{});
    req.off('aborted',cancel);res.off('close',cancel);streams.delete(operation);finish();
   }
   return true;
  }
 };
 return Object.freeze(api);
}
