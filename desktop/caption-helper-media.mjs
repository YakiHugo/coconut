/** Read one verified helper-owned file before its private directory is removed. */
import path from 'node:path';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
export async function readHelperMedia(directory,result){
 const meta=result?.media;
 if(result?.status!=='media_ready'||meta?.filename!=='public-media.bin'||!((meta.type==='audio/mp4'&&meta.kind==='audio')||(meta.type==='video/mp4'&&meta.kind==='video'))||!Number.isSafeInteger(meta.bytes)||meta.bytes<12||meta.bytes>200*1024*1024||!/^[a-f0-9]{64}$/.test(meta.sha256||''))throw Error('公开媒体文件身份无效');
 let handle;
 try{
  handle=await open(path.join(directory,meta.filename),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const stat=await handle.stat();if(!stat.isFile()||stat.size!==meta.bytes)throw Error('公开媒体文件大小无效');
  const bytes=Buffer.alloc(meta.bytes);let offset=0;
  while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)break;offset+=read.bytesRead;}
  const extra=await handle.read(Buffer.alloc(1),0,1,bytes.length);
  if(offset!==bytes.length||extra.bytesRead||bytes.subarray(4,8).toString()!=='ftyp'||createHash('sha256').update(bytes).digest('hex')!==meta.sha256)throw Error('公开媒体文件校验失败');
  return {...result,bytes};
 }finally{await handle?.close();}
}
