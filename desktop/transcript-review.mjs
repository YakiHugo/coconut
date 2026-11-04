/** Recoverable post-ASR text review; no audio, personal notes or AI history sent. */
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createReviewProviders} from './review-providers.mjs';
const R=createRequire(import.meta.url)('../shared/transcript-review.js');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function atomic(file,value){await writeFile(file+'.tmp',JSON.stringify(value),{mode:0o600});await rename(file+'.tmp',file);}
export function createTranscriptReviewer({providers=createReviewProviders()}={}){
 return {
  status:providers.status,
  async review(document,{directory,provider='codex',model='',signal,onProgress=()=>{},jobId=''}={}){
   if(!['codex','kimi'].includes(provider)||!path.isAbsolute(directory||''))throw Error('校对提供商或目录无效');
   const plan=R.plan(document),identity=hash({version:1,input:plan.input,provider,model});
   const work=path.join(directory,identity);await mkdir(work,{recursive:true,mode:0o700});
   const results=[];
   for(let i=0;i<plan.batches.length;i++){
    signal?.throwIfAborted();onProgress({phase:'review',chunk:i+1,chunks:plan.batches.length});
    const batch=plan.batches[i],file=path.join(work,`batch-${i}.json`);let value;
    try{value=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(value===undefined){
     value=await providers.structured(provider,JSON.stringify({context:plan.input.context,...batch}),R.schema,R.instruction,{signal,model});
     signal?.throwIfAborted();value=R.validateBatch(batch,value);await atomic(file,value);
    }else value=R.validateBatch(batch,value);
    results.push(value);
   }
   const result=R.merge(document,plan.input,results,{provider,model,jobId});
   await atomic(path.join(work,'result.json'),result);
   return {input:plan.input,results,result,identity};
  }
 };
}
