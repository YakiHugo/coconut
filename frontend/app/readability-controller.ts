import {processingSnapshot,sourceSignature,inspectResources,mergeProcessingResult,type ResourceDocument,type ResourceRow} from '../../shared/transcript-resources.js';
import type {Document,Media} from './contracts';
import {downloadedMediaFile,transcriptionFileIssue} from './ingestion-media';
export type ReadabilityCapabilities={available:boolean;punctuation:boolean;speakers:boolean;sourceMedia?:boolean;message:string};
export type ReadabilityJob={id:string;documentKey:string;state:string;phase:string;steps:string[];sourceDigest:string;resultDigest?:string|null;mediaIdentity:string|null;media?:{url:string;kind:'audio'|'video';name:string};needsMedia:boolean;error:string|null;input?:ResourceDocument;result?:ResourceDocument};
export type ReadabilityState={key:string|null;busy:boolean;message:string;capabilities:ReadabilityCapabilities|null;rows:ResourceRow[];job:ReadabilityJob|null};
type Dependencies={getDocument:(key:string)=>Document|null;getRevision:(key:string)=>number;getFile:(key:string)=>File|null;getMedia:(key:string)=>Media|null;canApply?:()=>boolean;commit:(doc:Document,expected:{key:string;revision:number})=>Promise<boolean>;request:(url:string,init?:RequestInit)=>Promise<any>;uuid:()=>string;fetchMedia?:(media:Media,signal:AbortSignal)=>Promise<File>};
const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
const liveStates=['queued','running','awaiting_media'];
export function createReadabilityController(deps:Dependencies){
 let deferred:{key:string;automatic?:boolean;run?:boolean}|null=null;
 let state:ReadabilityState={key:null,busy:false,message:'',capabilities:null,rows:[],job:null},generation=0,disposed=false,requestOwner:AbortController|null=null;
 const listeners=new Set<()=>void>();
 const emit=(patch:Partial<ReadabilityState>)=>{state={...state,...patch};for(const listener of listeners)listener();};
 const checkJob=(value:any,key:string):ReadabilityJob=>{const job=value?.job;if(!job||typeof job.id!=='string'||!/^[a-f0-9-]{36}$/.test(job.id)||job.documentKey!==key||!['awaiting_media','queued','running','ready','failed','interrupted','cancelled'].includes(job.state))throw Error('整理任务与当前文字稿不匹配');return job;};
 async function loadMedia(media:Media,signal:AbortSignal):Promise<File>{
  if(deps.fetchMedia)return deps.fetchMedia(media,signal);
  const url=new URL(media.url,location.href);
  if(!media.url.startsWith('blob:')&&(url.origin!==location.origin||!/^\/api\/(?:local-media\/|v1\/(?:ingestions|readability)\/jobs\/)/.test(url.pathname)))throw Error('请补充与此稿对应的原声文件。');
  const response=await fetch(media.url,{signal});if(!response.ok)throw Error('无法读取已载入的原声');
  const reader=response.body?.getReader();if(!reader)throw Error('浏览器无法读取原声');
  let size=0;const chunks:Uint8Array<ArrayBuffer>[]=[];
  try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>200*1024*1024)throw Error('原声超过 200 MiB');chunks.push(new Uint8Array(item.value));}}catch(error){await reader.cancel().catch(()=>{});throw error;}
  return downloadedMediaFile(chunks,{name:media.name,contentType:response.headers.get('Content-Type')||'',kind:media.kind});
 }
 async function apply(job:ReadabilityJob,key:string,request:number,signal:AbortSignal){
  const full=checkJob(await deps.request('api/v1/readability/jobs/'+job.id+'/result',{signal}),key);
  if(disposed||generation!==request||signal.aborted)return;
  const current=deps.getDocument(key),media=deps.getMedia(key);
  if(!current||!full.input||!full.result)throw Error('原稿或整理结果不完整');
  if(deps.canApply&&!deps.canApply()){emit({job:full,message:'整理已完成。保存或取消当前编辑后，将接入结果。'});return;}
  if(media&&full.mediaIdentity&&media.identity!==full.mediaIdentity)throw Error('原声已更换，旧整理结果未写入');
  const revision=deps.getRevision(key),next=mergeProcessingResult(current,full.input,full.result);
  if(full.mediaIdentity&&full.media)next.readability_job_binding={id:full.id,media_identity:full.mediaIdentity,source_url:current.source_url||'',media_duration:processingSnapshot(current).media_duration??null};
  const ok=await deps.commit(next,{key,revision});
  if(disposed||generation!==request)return;
  emit({job:full,message:ok?'整理结果已保存，原稿与已有笔记保留。':'整理结果尚未确认保存，请查看保存状态。',rows:inspectResources(next,{audio:!!deps.getFile(key)||!!media,...state.capabilities}).rows});
 }
 async function refresh(key:string,{automatic=false,run=false}={}){
  if(disposed)return;if(state.busy&&state.key===key){deferred={key,automatic:automatic||deferred?.automatic,run:run||deferred?.run};return;}
  const request=++generation;requestOwner?.abort();const owner=new AbortController();requestOwner=owner;
  emit({key,busy:true,message:state.key===key?state.message:'',job:state.key===key?state.job:null,rows:deps.getDocument(key)?inspectResources(deps.getDocument(key)!,{audio:!!deps.getFile(key)||!!deps.getMedia(key),...state.capabilities}).rows:[]});
  try{
   const caps=await deps.request('api/v1/readability/capabilities',{signal:owner.signal}) as ReadabilityCapabilities;
   if(disposed||generation!==request)return;
   if(typeof caps.available!=='boolean'||typeof caps.punctuation!=='boolean'||typeof caps.speakers!=='boolean')throw Error('本地整理服务未提供有效能力信息');
   let doc=deps.getDocument(key);if(!doc?.segments.length){emit({capabilities:caps,rows:doc?inspectResources(doc,{audio:!!deps.getFile(key),...caps}).rows:[]});return;}
   const file=deps.getFile(key),media=deps.getMedia(key),signature=sourceSignature(doc),sourceDigest=await digest(signature);
   const plan=inspectResources(doc,{audio:!!file||!!media,...caps});emit({capabilities:caps,rows:plan.rows});
   const listing=await deps.request('api/v1/readability/jobs?key='+encodeURIComponent(key),{signal:owner.signal});
   if(disposed||generation!==request||sourceSignature(deps.getDocument(key)!)!==signature)return;
   if(!Array.isArray(listing.jobs))throw Error('整理任务记录不完整');
   const jobs=listing.jobs.map((job:unknown)=>checkJob({job},key));
   let job=jobs.find((job:ReadabilityJob)=>(job.sourceDigest===sourceDigest||job.resultDigest===sourceDigest)&&(!media||!job.mediaIdentity||media.identity===job.mediaIdentity))||null;
   if(!job){
    const binding=doc.readability_job_binding as {id?:string;media_identity?:string;source_url?:string;media_duration?:number|null}|undefined;
    const original=binding&&binding.source_url===(doc.source_url||'')&&binding.media_duration===(processingSnapshot(doc).media_duration??null)?jobs.find((candidate:ReadabilityJob)=>candidate.id===binding.id&&candidate.mediaIdentity===binding.media_identity&&(!media||media.identity===candidate.mediaIdentity)&&candidate.media):null;
    if(original?.state==='ready'){emit({job:original,message:'任务原声已保留；当前稿的人工修改不会被旧整理结果覆盖。'});return;}
   }
   if(job){emit({job});
    if(job.state==='ready'){
     if(job.resultDigest===sourceDigest){
      if(job.mediaIdentity&&job.media&&!doc.readability_job_binding&&(!deps.canApply||deps.canApply())){
       const current=deps.getDocument(key);if(!current||sourceSignature(current)!==signature)return;
       const next={...current,readability_job_binding:{id:job.id,media_identity:job.mediaIdentity,source_url:current.source_url||'',media_duration:processingSnapshot(current).media_duration??null}};
       if(!await deps.commit(next,{key,revision:deps.getRevision(key)}))throw Error('原声关联尚未确认保存，请查看保存状态。');
      }
      emit({message:'整理结果已保留，可继续阅读或回听原声。'});return;
     }
     await apply(job,key,request,owner.signal);return;
    }
    if(liveStates.includes(job.state)){
     if(job.needsMedia&&file&&job.mediaIdentity===media?.identity){const issue=transcriptionFileIssue(file);if(issue)throw Error(issue);job=checkJob(await deps.request('api/v1/readability/jobs/'+job.id+'/media',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file,signal:owner.signal}),key);emit({job,message:'原声已接收，继续本地整理。'});}
     return;
    }
    if(!run)return;
    job=checkJob(await deps.request('api/v1/readability/jobs/'+job.id+'/retry',{method:'POST',signal:owner.signal}),key);emit({job});
    if(job.needsMedia&&file){job=checkJob(await deps.request('api/v1/readability/jobs/'+job.id+'/media',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file,signal:owner.signal}),key);emit({job});}return;
   }
   const olderActive=jobs.find((job:ReadabilityJob)=>liveStates.includes(job.state));
   if(olderActive){emit({job:olderActive,message:'旧原稿的整理任务仍在进行；当前稿未被覆盖，可先取消旧任务。'});return;}
   emit({job:null});
   const runnable=inspectResources(doc,{audio:!!file||run&&!!media,...caps});
   if(!runnable.steps.length||!run&&!automatic)return;
   let audio=file;
   if(run&&runnable.steps.includes('speakers')&&!audio&&media)audio=await loadMedia(media,owner.signal);
   if(audio){const issue=transcriptionFileIssue(audio);if(issue)throw Error(issue);}
   doc=deps.getDocument(key);if(!doc||sourceSignature(doc)!==signature)throw Error('原稿已变化，未发送整理任务');
   if((deps.getMedia(key)?.identity??null)!==(media?.identity??null)||file&&deps.getFile(key)!==file)throw Error('原声已变化，未发送旧资源的整理任务');
   const mediaInput=audio?{identity:media?.identity||'file:'+audio.name+':'+audio.size+':'+audio.lastModified,name:audio.name,size:audio.size}:null;
   job=checkJob(await deps.request('api/v1/readability/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:1,operation_id:deps.uuid(),document:processingSnapshot(doc),media:mediaInput}),signal:owner.signal}),key);
   if(disposed||generation!==request)return;emit({job,message:'已有文字稿已复用，正在补齐可用的整理步骤。'});
   if(job.needsMedia&&audio){job=checkJob(await deps.request('api/v1/readability/jobs/'+job.id+'/media',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:audio,signal:owner.signal}),key);if(!disposed&&generation===request)emit({job});}
  }catch(error){if(!disposed&&generation===request&&!owner.signal.aborted)emit({message:error instanceof Error?error.message:String(error)});}
  finally{if(!disposed&&generation===request){emit({busy:false});const next=deferred;deferred=null;if(next)queueMicrotask(()=>void refresh(next.key,next));}}
 }
 async function cancel(){const job=state.job,key=state.key;if(!job||!key||state.busy)return;emit({busy:true});try{const result=await deps.request('api/v1/readability/jobs/'+job.id+'/cancel',{method:'POST'});if(!disposed&&state.key===key)emit({job:checkJob(result,key),message:'整理已取消，原稿保留。'});}catch(error){if(!disposed)emit({message:error instanceof Error?error.message:String(error)});}finally{if(!disposed)emit({busy:false});}}
 return {subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},getSnapshot:()=>state,refresh,cancel,dispose(){disposed=true;generation++;requestOwner?.abort();listeners.clear();}};
}
