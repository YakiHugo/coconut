/** Recoverable post-ASR text review; no audio, personal notes or AI history sent. */
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createReviewProviders} from './review-providers.mjs';
import {identifySpeakers,prepareContext} from './speaker-identity.mjs';
const R=createRequire(import.meta.url)('../shared/transcript-review.js');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function atomic(file,value){await writeFile(file+'.tmp',JSON.stringify(value),{mode:0o600});await rename(file+'.tmp',file);}
export function createTranscriptReviewer({providers=createReviewProviders()}={}){
 return {
  status:providers.status,
  prepareContext:(document,options)=>prepareContext(document,{...options,providers}),
  identifySpeakers:(document,options)=>identifySpeakers(document,{...options,providers}),
  async reviewReading(document,{directory,provider='codex',model='',signal,onProgress=()=>{},jobId=''}){
   const plan=R.readingPlan(document);
   const identity=hash({version:2,input:plan.input,provider,model,kind:'reading',headings:document.reading_has_chapters!==true});
   const work=path.join(directory,identity);await mkdir(work,{recursive:true,mode:0o700});
   const opts={directory:work,provider,model,signal,onProgress};
   let contextDocument=document;
   try{contextDocument=await prepareContext(document,{...opts,providers});}
   catch(error){if(signal?.aborted)throw error;}
   let speakers=[];
   try{
    const named=await identifySpeakers(contextDocument,{...opts,providers});
    speakers=(named.speaker_identity_evidence?.assignments||[]).map(({id,name})=>({id,name}));
   }catch(error){if(signal?.aborted)throw error;}
   const context=R.context(contextDocument),edits=[],issues=[],headings=[],joins=[];
   const allowHeadings=document.reading_has_chapters!==true;
   let fallback=0,lastError;
   for(const [index,batch] of plan.batches.entries()){
    signal?.throwIfAborted();onProgress({phase:'review',chunk:index+1,chunks:plan.batches.length});
    const file=path.join(work,'batch-'+index+'.json');
    let value,reason='';
    try{value=R.readingBatch(batch,JSON.parse(await readFile(file,'utf8')),context);}
    catch(error){if(error.code!=='ENOENT')reason='已有批次无法验证';}
    for(let attempt=0;value===undefined&&attempt<2;attempt++){
     try{
      const output=await providers.structured(provider,JSON.stringify({context,...batch,allow_headings:allowHeadings,...(reason?{previous_error:reason}:{})}),R.readingSchema,R.readingInstruction,{signal,model});
      signal?.throwIfAborted();
      const checked=R.readingBatch(batch,output,context);
      await atomic(file,output);
      value=checked;
     }catch(error){
      if(signal?.aborted)throw error;
      lastError=error;
      reason=String(error.message||'精校批次失败').slice(0,200);
     }
    }
    if(value){joins.push(...value.joins);edits.push(...value.edits);issues.push(...value.issues);if(allowHeadings)headings.push(...value.headings);}
    else{fallback++;issues.push({cue_id:batch.target_ids[0],reason:'本批使用基础整理：'+reason});}
   }
   if(fallback===plan.batches.length)throw lastError??Error('AI 精校未返回可用批次');
   const reading_review={version:1,job_id:jobId,provider,model,source_signature:plan.source_signature,batches:plan.batches.length,fallback_batches:fallback,edits,issues,speakers,headings,joins};
   if(!R.readingReview({...document,reading_review}))throw Error('精校稿与原文不匹配');
   return {reading_review};
  },
  async review(document,{directory,provider='codex',model='',signal,onProgress=()=>{},jobId=''}={}){
   if(!R.REVIEW_PROVIDERS.includes(provider)||!path.isAbsolute(directory||''))throw Error('校对提供商或目录无效');
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
