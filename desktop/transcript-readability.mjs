/** Explicitly provisioned offline punctuation, shared by automatic caption imports. */
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../transcript_readability.py',import.meta.url));
const cancelled=()=>Object.assign(new Error('已取消文字整理'),{code:'READABILITY_CANCELLED'});
export function createCaptionReadability({python=process.env.COCONUT_READING_PYTHON,model=process.env.COCONUT_PUNCTUATION_MODEL,timeoutMs=120000}={}){
 if(!python||!model)return null;
 if(!path.isAbsolute(python)||!path.isAbsolute(model))throw new Error('本地文字整理须配置 Python 和标点模型的绝对路径');
 return (document,{signal}={})=>new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(cancelled());return;}
  const payload=JSON.stringify(document);
  if(Buffer.byteLength(payload)>8*1024*1024){reject(new Error('文字稿过大'));return;}
  let child,timeout,failure,bytes=0;const chunks=[];
  const stop=error=>{failure||=error;child?.kill('SIGKILL');};
  const abort=()=>stop(cancelled());
  try{
   child=spawn(python,['-I','-B',script,'--stdio','--punctuation-model',model],{
    shell:false,env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'},stdio:['pipe','pipe','pipe']});
  }catch(error){reject(error);return;}
  signal?.addEventListener('abort',abort,{once:true});
  timeout=setTimeout(()=>stop(new Error('本地文字整理超时')),timeoutMs);
  child.stdin.on('error',()=>{});
  child.stderr.on('data',()=>{});
  child.stdout.on('data',chunk=>{
   bytes+=chunk.length;
   if(bytes>16*1024*1024)stop(new Error('整理结果过大'));else chunks.push(chunk);
  });
  child.once('error',error=>{failure||=error;});
  child.once('close',code=>{
   clearTimeout(timeout);signal?.removeEventListener('abort',abort);
   if(failure||code!==0){reject(failure||new Error('本地文字整理失败'));return;}
   try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(error){reject(error);}
  });
  if(signal?.aborted)abort();else child.stdin.end(payload);
 });
}
