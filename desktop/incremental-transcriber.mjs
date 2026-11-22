/** Trusted service-only worker transport. A media lease owns the caller's FD. */
import {spawn} from 'node:child_process';
import {fstatSync} from 'node:fs';
import path from 'node:path';
import {StringDecoder} from 'node:string_decoder';
const phases=new Set(['prepare','recognize','align','speakers','save','done']);
const fallbackReasons=new Set(['stream_decode_unavailable','canonical_pcm_mismatch']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const offline={HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_IMPLICIT_TOKEN:'1'};
export function startIncrementalProcess({python,profile,scriptPath},{attemptId,mediaFd,workDirectory,sourceSnapshot,title,context,hotwords,nameCorrections,speakerCount,pcmCache,signal,onProgress=()=>{}}){
 if(!python||profile?.backend!=='qwen-mlx')throw Error('本地增量转录环境未配置');
 signal?.throwIfAborted();
 if(!uuid.test(attemptId)||!Number.isInteger(mediaFd)||mediaFd<3||!path.isAbsolute(workDirectory||'')||sourceSnapshot===undefined)throw Error('增量转录只接受服务拥有的媒体句柄与任务身份');
 try{if(!fstatSync(mediaFd).isFile())throw Error();}catch{throw Error('增量转录媒体句柄无效');}
 const initial=JSON.stringify({operation:'transcribe_incremental',protocol_version:1,attempt_id:attemptId,media_fd:3,work:workDirectory,source_snapshot:sourceSnapshot,title,context,hotwords,name_corrections:nameCorrections,speaker_count:speakerCount,profile,local_only:true})+'\n';
 if(Buffer.byteLength(initial)>65536)throw Error('增量转录任务上下文过大');
 // spawn duplicates this descriptor into child fd 3. Never close caller mediaFd.
 const child=spawn(python,['-u',scriptPath],{shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe',mediaFd],env:{...process.env,...offline,COCONUT_PCM_CACHE:path.isAbsolute(pcmCache||'')?pcmCache:'',...(profile?.model_cache?{HF_HOME:profile.model_cache}:{})}});
 let maxWatermark=0,sentWatermark=0,pendingSeal=null,sealRequested=false,sealSent=false,blocked=false,scheduled=false,settled=false,stopping=false,reason,killer,buffer='';
 const decoder=new StringDecoder('utf8');let resolve,reject;
 const completion=new Promise((a,b)=>{resolve=a;reject=b;});void completion.catch(()=>{});
 const kill=kind=>{try{if(child.pid){if(process.platform!=='win32')process.kill(-child.pid,kind);else child.kill(kind);}}catch{}};
 function stop(error=Error('增量转录已取消')){
  if(settled||stopping)return;stopping=true;reason??=error;
  // Best effort notification; signal escalation remains authoritative under backpressure.
  if(!blocked&&!child.stdin.destroyed)child.stdin.write(JSON.stringify({type:'abort',attempt_id:attemptId})+'\n');
  kill('SIGTERM');killer=setTimeout(()=>kill('SIGKILL'),3000);
 }
 const abort=()=>stop(signal?.reason||Error('增量转录已取消'));
 const timer=setTimeout(()=>stop(Error('本地转录任务超时')),12*3600*1000);
 signal?.addEventListener('abort',abort,{once:true});
 function write(value){blocked=!child.stdin.write(JSON.stringify(value)+'\n');}
 function pump(){
  scheduled=false;if(settled||stopping||blocked)return;
  if(maxWatermark>sentWatermark){sentWatermark=maxWatermark;write({type:'append',attempt_id:attemptId,available_bytes:sentWatermark});if(blocked)return;}
  if(pendingSeal){const value=pendingSeal;pendingSeal=null;sealSent=true;write({type:'seal',attempt_id:attemptId,...value});}
 }
 function schedule(){if(!scheduled&&!settled&&!stopping){scheduled=true;queueMicrotask(pump);}}
 child.stdin.on('drain',()=>{blocked=false;schedule();});
 child.stdin.on('error',()=>stop(Error('增量转录控制通道已关闭')));
 child.stderr.resume();
 child.stdout.on('data',chunk=>{
  if(stopping||settled)return;buffer+=decoder.write(chunk);
  if(buffer.length>65536){stop(Error('转录进度回执过大'));return;}
  let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
   try{
    const value=JSON.parse(line);let progress;
    if(value.phase==='fallback'&&fallbackReasons.has(value.reason))progress={phase:'fallback',reason:value.reason};
    else if(phases.has(value.phase)){
     if(value.chunk!==undefined&&(!Number.isSafeInteger(value.chunk)||value.chunk<0)||value.chunks!=null&&(!Number.isSafeInteger(value.chunks)||value.chunks<0))throw Error();
     progress={phase:value.phase,...(Number.isSafeInteger(value.chunk)?{chunk:value.chunk}:{}),...(Number.isSafeInteger(value.chunks)?{chunks:value.chunks}:{})};
    }else throw Error();
    onProgress(progress);
   }catch{stop(Error('转录进度回执无效'));return;}
  }
 });
 function finish(error){if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killer);signal?.removeEventListener('abort',abort);child.stdin.destroy();error?reject(error):resolve();}
 child.once('error',()=>finish(Error('无法启动本地转录 Python')));
 child.once('close',code=>{buffer+=decoder.end();finish(reason||(code!==0?Error('本地增量转录未完成；完整媒体可明确重试'):!sealSent?Error('增量转录尚未完成媒体封存'):buffer.trim()?Error('转录进度回执无效'):null));});
 blocked=!child.stdin.write(initial);
 if(signal?.aborted)abort();
 return {
  appendWatermark(n){if(settled||stopping)return;if(sealRequested)throw Error('媒体已封存');if(!Number.isSafeInteger(n)||n<maxWatermark)throw Error('媒体水位必须单调递增');maxWatermark=n;schedule();},
  seal({size,sha256}){if(settled||stopping)throw Error('增量转录已结束');if(sealRequested||!Number.isSafeInteger(size)||size<1||size<maxWatermark||!/^[a-f0-9]{64}$/.test(sha256||''))throw Error('媒体封存身份无效');sealRequested=true;maxWatermark=size;pendingSeal={size,sha256};schedule();},
  abort,completion,
 };
}
