/** Explicit, bounded local-CLI fallback. Source clocks/text are never rewritten. */
import {mkdir,readFile,writeFile,rename,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createReviewProviders} from './review-providers.mjs';
import {createProviders,runCommand,normalizeModel} from './providers.mjs';
const R=createRequire(import.meta.url)('../shared/reading-fallback.js');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const policyHash=hash({version:R.POLICY_VERSION,schema:R.schema,instruction:R.instruction});
const count=R.batchCharacters;
async function atomic(file,value){await writeFile(file+'.tmp',JSON.stringify(value),{mode:0o600});await rename(file+'.tmp',file);}
const safeUsage=value=>Object.fromEntries(['input_tokens','cached_input_tokens','output_tokens'].filter(k=>Number.isSafeInteger(value?.[k])&&value[k]>=0).map(k=>[k,value[k]]));
function transportMetadata(result){
 const events=[];for(const line of String(result.stdout||'').split('\n')){try{events.push(JSON.parse(line));}catch{}}
 const candidates=events.flatMap(e=>[e.model,e.model_id,e.turn?.model,e.response?.model]).filter(v=>typeof v==='string'&&/^[A-Za-z0-9._-]{1,120}$/u.test(v));
 const header=String(result.stderr||'').match(/^model:\s*([A-Za-z0-9._-]{1,120})\s*$/mu);if(header)candidates.push(header[1]);
 const models=[...new Set(candidates)],usage=events.filter(e=>e.type==='turn.completed').reduce((a,e)=>{for(const [k,v]of Object.entries(safeUsage(e.usage)))a[k]=(a[k]||0)+v;return a;},{});
 return {transported:true,actualModel:models.length===1?models[0]:null,emittedModels:models,modelMetadataUnavailable:models.length!==1,usage,exitCode:result.code};
}
function measuredProviders(){
 const metadata=[];
 const codex=createProviders({run:async(binary,args,options)=>{
  const isRequest=args[0]==='exec'&&args.includes('--json')&&args.includes('--output-schema');
  const started=Date.now();
  try{const result=await runCommand(binary,args,options);if(isRequest)metadata.push({...transportMetadata(result),durationMs:Date.now()-started});return result;}
  catch(error){if(isRequest)metadata.push({transported:true,actualModel:null,emittedModels:[],modelMetadataUnavailable:true,usage:{},durationMs:Date.now()-started,transportError:true});throw error;}
 }});
 return {...createReviewProviders({codex}),takeRequestMetadata:()=>metadata.shift()||{transported:false,actualModel:null,emittedModels:[],modelMetadataUnavailable:true,usage:{}}};
}
const failureReason=error=>error?.name==='AbortError'?'cancelled_unknown_request_state':error?.code==='provider_failed'?'provider_failed_no_automatic_retry':'failed_or_invalid_response_no_automatic_retry';
function distinctCharacters(windows){const byId=new Map();for(const w of windows){if(!byId.has(w.cue_id))byId.set(w.cue_id,new Set());for(let i=w.from;i<w.to;i++)byId.get(w.cue_id).add(i);}return [...byId.values()].reduce((n,s)=>n+s.size,0);}

export function planReadingFallback(document,options={}){return R.plan(document,options);}
export function createReadingFallback({providers}={}){
 const adapter=providers||measuredProviders();
 return {
  plan:planReadingFallback,
  async run(document,{directory,provider='',model='',signal,onProgress=()=>{},...options}={}){
   if(!['','codex'].includes(provider))throw Error('难例兜底只支持显式 Codex CLI；未配置时不会调用');
   model=normalizeModel(model);
   const plan=R.plan(document,options);
   const identity=hash({input:plan.input,policyHash,provider,model});
   const stats={provider:provider||null,requestedModel:model||'cli-default',actualModels:[],modelMetadataUnavailable:true,
    sourceCharacters:plan.input.characters,budgetCharacters:plan.budgetCharacters,plannedCharacters:plan.plannedCharacters,
    candidateCount:plan.candidateCount,plannedWindows:plan.windows.length,plannedRequests:plan.batches.length,
    requestsAttempted:0,requests:0,historicalRequests:0,historicalFailedRequests:0,cacheHits:0,blockedRequests:0,sentCharacters:0,distinctSourceCharacters:0,
    coverageFraction:0,repeatedSentCharacters:0,usage:{},requestMetadata:[],cancelled:false};
   const output={version:1,policyVersion:R.POLICY_VERSION,identity,policyHash,decisions:[],marks:[],issues:[],
    windows:plan.windows.map(({window_id,cue_id,from,to,targets})=>({window_id,cue_id,from,to,kinds:[...new Set(targets.map(t=>t.kind))]})),stats};
   if(!provider||!plan.batches.length)return output;
   if(!path.isAbsolute(directory||''))throw Error('难例兜底缓存目录必须为绝对路径');
   const work=path.join(directory,identity);await mkdir(work,{recursive:true,mode:0o700});
   const sentWindows=[];
   for(let i=0;i<plan.batches.length;i++){
    if(signal?.aborted){stats.cancelled=true;break;}
    const batch=plan.batches[i],file=path.join(work,`batch-${i}-${hash(batch)}.json`);let cache;
    try{cache=JSON.parse(await readFile(file,'utf8'));}
    catch(error){if(error.code!=='ENOENT'){output.issues.push({batch:i,reason:'invalid_cache_kept_without_resend'});stats.blockedRequests++;continue;}}
    if(cache!==undefined){
     if(cache.metadata?.transported===true){stats.historicalRequests++;if(cache.state!=='complete')stats.historicalFailedRequests++;}
     if(cache.state==='complete'){
      try{const checked=R.validateResponse(batch,cache.response);output.decisions.push(...checked.decisions);output.marks.push(...checked.marks);output.issues.push(...checked.issues);stats.cacheHits++;}
      catch{output.issues.push({batch:i,reason:'invalid_cached_response_kept_without_resend'});stats.blockedRequests++;}
      if(cache.metadata?.actualModel&&!stats.actualModels.includes(cache.metadata.actualModel))stats.actualModels.push(cache.metadata.actualModel);
     }else{output.issues.push({batch:i,reason:'previous_request_failed_or_unknown_no_automatic_resend'});stats.blockedRequests++;}
     continue;
    }
    // Reserve the source budget atomically across concurrent callers and
    // differing routing budgets. Pending/unknown attempts retain their charge.
    const cost=count(batch),lock=path.join(work,'budget.lock');let claimed=false,blocked='';
    try{
     await writeFile(lock,'reserved',{flag:'wx',mode:0o600});
     try{
      let reserved=0;
      for(const name of await readdir(work))if(name.startsWith('batch-')&&name.endsWith('.json')){
       let prior;try{prior=JSON.parse(await readFile(path.join(work,name),'utf8'));}catch{blocked='unknown_prior_budget_no_resend';break;}
       if(!Number.isSafeInteger(prior.reservedCharacters)||prior.reservedCharacters<0){blocked='unknown_prior_budget_no_resend';break;}
       reserved+=prior.reservedCharacters;
      }
      if(!blocked&&(reserved+cost>plan.budgetCharacters||stats.requestsAttempted>=plan.config.maxRequests))blocked='hard_budget_exhausted';
      if(!blocked){await writeFile(file,JSON.stringify({state:'pending',provider,requestedModel:model||'cli-default',inputHash:hash(batch),policyHash,reservedCharacters:cost}),{flag:'wx',mode:0o600});claimed=true;}
     }finally{await rm(lock,{force:true});}
    }catch(error){if(error.code==='EEXIST')blocked='request_or_budget_claimed_elsewhere_no_resend';else throw error;}
    if(!claimed){output.issues.push({batch:i,reason:blocked||'request_not_claimed'});stats.blockedRequests++;continue;}
    stats.requestsAttempted++;onProgress({phase:'reading-fallback',request:i+1,requests:plan.batches.length,windows:batch.windows.length});
    let metadata;
    const record=()=>{
     metadata=adapter.takeRequestMetadata?.()||{transported:true,actualModel:null,emittedModels:[],modelMetadataUnavailable:true,usage:{}};
     stats.requestMetadata.push(metadata);
     if(metadata.transported){stats.requests++;stats.historicalRequests++;stats.sentCharacters+=count(batch);sentWindows.push(...batch.windows);}
     if(metadata.actualModel&&!stats.actualModels.includes(metadata.actualModel))stats.actualModels.push(metadata.actualModel);
     for(const [k,v]of Object.entries(safeUsage(metadata.usage)))stats.usage[k]=(stats.usage[k]||0)+v;
    };
    try{
     const response=await adapter.structured('codex',JSON.stringify(batch),R.schema,R.instruction,{signal,model});
     record();const checked=R.validateResponse(batch,response);
     await atomic(file,{state:'complete',response,metadata,policyHash,inputHash:hash(batch),reservedCharacters:metadata.transported?cost:0});
     output.decisions.push(...checked.decisions);output.marks.push(...checked.marks);output.issues.push(...checked.issues);
    }catch(error){
     if(!metadata)record();const reason=failureReason(error);
     if(metadata.transported)stats.historicalFailedRequests++;
     try{await atomic(file,{state:'failed',reason,metadata,policyHash,inputHash:hash(batch),reservedCharacters:metadata.transported?cost:0});}catch{/* Pending claim remains blocked; never resend unknown work. */}
     output.issues.push({batch:i,reason});stats.blockedRequests++;
     if(signal?.aborted||error?.name==='AbortError'){stats.cancelled=true;break;}
    }
   }
   stats.distinctSourceCharacters=distinctCharacters(sentWindows);
   stats.coverageFraction=stats.sourceCharacters?stats.distinctSourceCharacters/stats.sourceCharacters:0;
   stats.repeatedSentCharacters=stats.sentCharacters-stats.distinctSourceCharacters;
   stats.modelMetadataUnavailable=stats.actualModels.length===0;
   await atomic(path.join(work,'result.json'),output);
   return output;
  }
 };
}
