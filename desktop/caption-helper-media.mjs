/** Read one verified helper-owned file before its private directory is removed. */
import path from 'node:path';
import {open,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
export async function readHelperMedia(directory,result,{consume,signal,openFile=open,warn=console.warn}={}){
 const meta=result?.media;
 if(result?.status!=='media_ready'||meta?.filename!=='public-media.bin'||!((meta.type==='audio/mp4'&&meta.kind==='audio')||(meta.type==='video/mp4'&&meta.kind==='video'))||!Number.isSafeInteger(meta.bytes)||meta.bytes<12||meta.bytes>200*1024*1024||!/^[a-f0-9]{64}$/.test(meta.sha256||''))throw Error('公开媒体文件身份无效');
 let handle,consumed=false;
 try{
  handle=await openFile(path.join(directory,meta.filename),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const stat=await handle.stat();if(!stat.isFile()||stat.size!==meta.bytes)throw Error('公开媒体文件大小无效');
  if(consume){
   const digest=createHash('sha256');let size=0,prefix=Buffer.alloc(0);
   for await(const chunk of handle.createReadStream({autoClose:false,start:0})){
    signal?.throwIfAborted();size+=chunk.length;if(size>meta.bytes)throw Error('公开媒体文件校验失败');
    if(prefix.length<12)prefix=Buffer.concat([prefix,chunk.subarray(0,12-prefix.length)]);digest.update(chunk);
   }
   if(size!==meta.bytes||prefix.subarray(4,8).toString()!=='ftyp'||digest.digest('hex')!==meta.sha256)throw Error('公开媒体文件校验失败');
   signal?.throwIfAborted();
   const body=handle.createReadStream({autoClose:false,start:0,signal});
   try{const value=await consume({...result,body});if(!body.readableEnded)throw Error('公开媒体未完整保存');consumed=true;return value;}finally{body.destroy();}
  }
  const bytes=Buffer.alloc(meta.bytes);let offset=0;
  while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)break;offset+=read.bytesRead;}
  const extra=await handle.read(Buffer.alloc(1),0,1,bytes.length);
  if(offset!==bytes.length||extra.bytesRead||bytes.subarray(4,8).toString()!=='ftyp'||createHash('sha256').update(bytes).digest('hex')!==meta.sha256)throw Error('公开媒体文件校验失败');
  return {...result,bytes};
 }finally{try{await handle?.close();}catch(error){if(!consumed)throw error;warn('Coconut: temporary media handle cleanup failed after successful storage.');}}
}

/** Cleanup cannot turn an already accepted durable asset into a failed download. */
export async function cleanupHelperMedia(directory,consumed,{remove=rm,warn=console.warn}={}){
 if(!directory)return;
 try{await remove(directory,{recursive:true,force:true,maxRetries:2,retryDelay:100});}
 catch(error){if(!consumed)throw error;warn('Coconut: temporary media cleanup failed after successful storage.');}
}
