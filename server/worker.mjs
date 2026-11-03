/** Own one optional Python worker; no package installation or model downloads. */
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('./asr-worker.py',import.meta.url));
export async function startAsrWorker({python,directory,modelDirectory,timeoutMs=15000,scriptPath=script}={}){
  const child=spawn(python,['-u',scriptPath,'--data-directory',directory],{shell:false,stdio:['pipe','pipe','pipe'],
    env:{...process.env,...(modelDirectory?{HF_HOME:modelDirectory}:{}),HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_IMPLICIT_TOKEN:'1'}});
  let stopped=false,shutdownPromise,settled=false,resolveExit;
  const exited=new Promise(resolve=>{resolveExit=resolve;});
  child.once('exit',()=>{stopped=true;resolveExit();});
  child.once('error',()=>{stopped=true;resolveExit();});
  // Diagnostics may contain machine paths; retain no stderr content or tokens.
  child.stderr.on('data',()=>{});
  child.stdin.on('error',()=>{}); // The worker can exit between the shutdown check and EOF.
  const shutdown=()=>shutdownPromise??=(async()=>{
    if(stopped)return;
    child.stdin.end();
    let timer;await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,10000);})]);clearTimeout(timer);
    if(!stopped){child.kill('SIGTERM');await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,3000);})]);clearTimeout(timer);}
    if(!stopped){child.kill('SIGKILL');await exited;}
  })();
  try{
    const port=await new Promise((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>finish(Error('Configured ASR worker did not become ready.')),timeoutMs);
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);child.stdout.removeListener('data',read);error?reject(error):resolve(value);};
      const read=chunk=>{output+=chunk.toString('utf8');if(output.length>1024)return finish(Error('Invalid ASR worker startup receipt.'));if(!output.includes('\n'))return;
        try{const value=JSON.parse(output.slice(0,output.indexOf('\n')));if(value.protocolVersion!==1||!Number.isInteger(value.port)||value.port<1||value.port>65535)throw Error();finish(null,value.port);}catch{finish(Error('Invalid ASR worker startup receipt.'));}};
      child.stdout.on('data',read);child.once('error',()=>finish(Error('Configured ASR Python could not be started.')));child.once('exit',()=>finish(Error('Configured ASR worker exited before readiness.')));
    });
    child.stdout.resume();
    return {origin:`http://127.0.0.1:${port}`,pid:child.pid,shutdown,get online(){return !stopped;}};
  }catch(error){await shutdown();throw error;}
}
