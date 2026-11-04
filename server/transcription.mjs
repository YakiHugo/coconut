/** One task process. Node owns scheduling/storage; Python owns computation only. */
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {StringDecoder} from 'node:string_decoder';
const script=fileURLToPath(new URL('../transcription.py',import.meta.url));
const offline={HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_IMPLICIT_TOKEN:'1'};
const phases=new Set(['prepare','recognize','align','speakers','save','done']);
export function createTranscriber({python,profile,scriptPath=script}={}){
 const configured=Boolean(python);
 async function execute(request,{probe=false,signal,onProgress=()=>{}}={}){
  if(!configured)throw Error('本地转录环境未配置');
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
   const child=spawn(python,['-u',scriptPath,...(probe?['--probe']:[])],{shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'],env:{...process.env,...offline,...(profile?.model_cache?{HF_HOME:profile.model_cache}:{})}});
   let buffer='',receipt,reason,killer;const decoder=new StringDecoder('utf8');
   const stop=()=>{reason??=signal?.reason||Error('转录已取消');try{if(process.platform!=='win32')process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{}killer??=setTimeout(()=>{try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}},3000);};
   const timer=setTimeout(()=>{reason=Error(probe?'转录环境检查超时':'转录任务超时');stop();},probe?15000:12*3600*1000);
   signal?.addEventListener('abort',stop,{once:true});
   child.stdin.on('error',()=>{});
   // No model text, raw exception, credentials or local paths in task progress.
   child.stderr.resume();
   child.stdout.on('data',chunk=>{
    buffer+=decoder.write(chunk);
    if(buffer.length>65536){reason=Error('转录进度回执过大');stop();return;}
    let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const value=JSON.parse(line);if(probe)receipt=value;else if(phases.has(value.phase))onProgress({phase:value.phase,...(Number.isInteger(value.chunk)&&Number.isInteger(value.chunks)?{chunk:value.chunk,chunks:value.chunks}:{})});else throw Error();}catch{reason=Error('转录进度回执无效');stop();}}
   });
   const settle=error=>{clearTimeout(timer);clearTimeout(killer);signal?.removeEventListener('abort',stop);child.stdin.destroy();error?reject(error):resolve(receipt);};
   child.once('error',()=>settle(Error('无法启动本地转录 Python')));
   child.once('close',code=>settle(reason||(code!==0?Error('本地转录未完成；已保存阶段可以明确重试'):probe&&typeof receipt?.available!=='boolean'?Error('转录环境回执无效'):null)));
   child.stdin.write(JSON.stringify({...request,profile})+'\n');
   if(probe)child.stdin.end();
   if(signal?.aborted)stop();
  });
 }
 return {
  profile,
  async status(){const base={local_only:true,model_download:false,automatic:false,backend:profile?.backend||'qwen-mlx',upload_operations:0};if(!configured)return {...base,available:false,code:'asr_not_configured',message:'请配置本地转录 Python 与模型目录；不会自动下载模型。'};try{return {...base,...await execute({}, {probe:true})};}catch{return {...base,available:false,code:'asr_executor_unavailable',message:'本地转录环境检查失败；阅读仍可使用。'};}},
  run({inputPath,sha256,workDirectory,title,hotwords,nameCorrections,speakerCount,signal,onProgress}){if(!path.isAbsolute(inputPath)||!path.isAbsolute(workDirectory))throw Error('转录只接受服务已保存的音频');return execute({input:inputPath,sha256,work:workDirectory,title,hotwords,name_corrections:nameCorrections,speaker_count:speakerCount},{signal,onProgress});},
 };
}
