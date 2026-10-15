/** Same-origin adapter to the existing optional Python import queue.
 * Configuration is process-owner only. Never starts Python or installs models.
 */
import {createRequire} from 'node:module';
const Coconut=createRequire(import.meta.url)('../reader/core.js');
import {remoteDiagnostic} from './client-access.mjs';
const MEDIA_TYPES={mp3:['audio','audio/mpeg'],wav:['audio','audio/wav'],m4a:['audio','audio/mp4'],ogg:['audio','audio/ogg'],flac:['audio','audio/flac'],mp4:['video','video/mp4'],webm:['video','video/webm']};
const MAX_UPLOAD=200*1024*1024, MAX_JSON=8*1024*1024;
const identifier=id=>{if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))throw new Error('导入任务标识无效');return id;};
const disabled={available:false,code:'asr_not_configured',model_download:false,message:'尚未连接本地转写执行器。请先配置已有 Python 导入服务；不会自动安装依赖或下载模型。'};
function executorOrigin(value){
 if(!value)return null;
 let url;try{url=new URL(value);}catch{throw new Error('COCONUT_ASR_EXECUTOR_URL 必须是本机 HTTP 服务地址');}
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('COCONUT_ASR_EXECUTOR_URL 只接受本机 HTTP 服务地址');
 return url.origin;
}
function operationIdentity(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.operation_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.operation_id)||typeof value.filename!=='string'||!value.filename||value.filename.length>300||/[\\/\u0000-\u001f\u007f]/.test(value.filename)||!MEDIA_TYPES[value.filename.split('.').at(-1).toLowerCase()]||!Number.isSafeInteger(value.size)||value.size<1||value.size>MAX_UPLOAD||typeof value.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.fingerprint)||!Number.isSafeInteger(value.last_modified)||value.last_modified<0||!['','zh','en','ja','ko','fr','de','es'].includes(value.language))throw new Error('上传操作身份无效');
 return {operation_id:value.operation_id,filename:value.filename,size:value.size,fingerprint:value.fingerprint,last_modified:value.last_modified,language:value.language};
}
function sameOperation(left,right){return Object.keys(left).every(key=>left[key]===right[key]);}
export function normalizeImportJob(job,expected={}){
 if(!job||job.options?.local_only!==true)throw new Error('此任务不是统一入口创建的本地转写任务');
 const states={queued:'queued',running:'running',done:'ready',failed:'failed',interrupted:'interrupted',cancelled:'cancelled'};
 if(typeof job.status!=='string'||!Object.hasOwn(states,job.status))throw new Error('执行器任务状态无效');
 if(typeof job.title!=='string'||!job.title||job.title.length>300||/[\\/\u0000-\u001f\u007f]/.test(job.title))throw new Error('执行器文件身份无效');
 const [kind,mimeType]=MEDIA_TYPES[job.title.split('.').at(-1).toLowerCase()]||[];
 const operation=job.upload_operation===undefined?null:operationIdentity(job.upload_operation);
 if(operation&&operation.filename!==job.title||expected.operation&&(!operation||!sameOperation(expected.operation,operation)))throw new Error('执行器上传操作身份不一致');
 if(!kind||expected.id!==undefined&&job.id!==expected.id||expected.filename!==undefined&&job.title!==expected.filename)throw new Error('执行器返回了不同的任务或文件');
 return {id:identifier(job.id),state:states[job.status],persistent:true,source:{kind:'file',name:job.title,...(operation?{operation_id:operation.operation_id,size:operation.size,fingerprint:operation.fingerprint,last_modified:operation.last_modified,language:operation.language}:{})},stage:remoteDiagnostic(job.stage||''),created:job.created,updated:job.updated,error:job.error?{code:'transcription_failed',message:remoteDiagnostic(job.error)}:null,transcript:null,media:{availability:'executor',kind,mimeType,name:job.title,url:`/api/v1/ingestions/jobs/${job.id}/media`}};
}
export function createIngestionExecutor({url=process.env.COCONUT_ASR_EXECUTOR_URL,fetchImpl=fetch}={}){
 const origin=executorOrigin(url);
 async function request(route,{signal,method='GET',body,headers={}}={}){
  if(!origin)throw Object.assign(new Error(disabled.message),{status:503});
  const response=await fetchImpl(origin+route,{method,signal:AbortSignal.any([AbortSignal.timeout(method==='POST'?300000:30000),...(signal?[signal]:[])]),redirect:'error',headers:{Origin:origin,...headers},...(body!==undefined?{body,duplex:'half'}:{})});
  return response;
 }
 async function json(route,options){
  const response=await request(route,options);let bytes=0,chunks=[];
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>MAX_JSON)throw new Error('执行器响应过大');chunks.push(chunk);}
  let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('执行器未返回有效 JSON');}
  if(!response.ok)throw Object.assign(new Error(data.error||'转写执行器请求失败'),{status:response.status});
  return data;
 }
 async function status({signal}={}){
  if(!origin)return {...disabled};
  try{
   const result=await json('/api/ingestion-executor/status',{signal:AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])])});
   if(typeof result.available!=='boolean'||result.model_download!==false||result.upload_operations!==1)throw new Error('执行器不支持只使用现有模型的转写协议');
   return {...result,automatic:false};
  }catch(error){if(signal?.aborted)throw error;return {available:false,code:'asr_executor_unavailable',model_download:false,message:'本地转写执行器未就绪，请检查已配置服务及其版本。'};}
 }
 async function get(id,{signal}={}){return normalizeImportJob(await json('/api/jobs/'+identifier(id),{signal}),{id});}
 async function recover(value,{signal}={}){
  const operation=operationIdentity(value),{operation_id,...fields}=operation;
  try{return normalizeImportJob(await json('/api/ingestion-executor/operations/'+operation_id+'?'+new URLSearchParams(fields),{signal}),{operation});}
  catch(error){if(error.status===404)error.taskCode='ingestion_operation_not_found';if(error.status===409)error.taskCode='ingestion_operation_conflict';throw error;}
 }
 async function upload(req,{filename,language='',operation_id,fingerprint,last_modified,signal}={}){
  const size=Number(req.headers['content-length']);
  if(req.headers['content-type']?.split(';')[0]!=='application/octet-stream'||!Number.isSafeInteger(size)||size<1||size>MAX_UPLOAD)throw Object.assign(new Error('请选择不超过 200 MiB 的音视频文件'),{status:413});
  if(typeof filename!=='string'||!filename||filename.length>300||/[\\/\u0000-\u001f]/.test(filename)||! /\.(mp3|mp4|wav|m4a|webm|ogg|flac)$/i.test(filename))throw new Error('音视频文件名称无效');
  if(!['','zh','en','ja','ko','fr','de','es'].includes(language))throw new Error('原语言标记无效');
  const operation=operationIdentity({operation_id,filename,size,fingerprint,last_modified,language});
  let existing=null;
  try{existing=await recover(operation,{signal});}catch(error){if(error.taskCode!=='ingestion_operation_not_found')throw error;}
  if(!existing){const ready=await status({signal});if(!ready.available)throw Object.assign(new Error(ready.message||'本地依赖或已下载模型尚未就绪'),{status:503});}
  const query=new URLSearchParams({...operation,local_only:'true'});
  async function* bounded(){let seen=0;for await(const chunk of req){seen+=chunk.length;if(seen>size)throw new Error('上传长度不一致');yield chunk;}if(seen!==size)throw new Error('上传未完成');}
  try{return normalizeImportJob(await json('/api/uploads?'+query,{signal,method:'POST',body:bounded(),headers:{'Content-Type':'application/octet-stream','Content-Length':String(size)}}),{filename,operation,...(existing?{id:existing.id}:{})});}
  catch(error){if(error.status===409)error.taskCode='ingestion_operation_conflict';throw error;}
 }
 async function action(id,action,{signal}={}){
  if(!['cancel','retry'].includes(action))throw new Error('任务操作无效');
  const before=await get(id,{signal});
  if(action==='retry'){const ready=await status({signal});if(!ready.available)throw Object.assign(new Error(ready.message||'本地转写执行器未就绪'),{status:503});}
  return normalizeImportJob(await json(`/api/jobs/${identifier(id)}/${action}`,{signal,method:'POST',body:'{}',headers:{'Content-Type':'application/json'}}),{id,filename:before.source.name,...(before.source.operation_id?{operation:operationIdentity({...before.source,filename:before.source.name})}:{})});
 }
 async function result(id,{signal}={}){
  const job=await get(id,{signal});
  if(job.state!=='ready')throw Object.assign(new Error('文字稿尚未完成'),{status:409});
  const document=await json(`/api/jobs/${identifier(id)}/result`,{signal});
  if(document?.schema_version!==1||document.project_kind||!Array.isArray(document.segments)||!document.segments.every(segment=>typeof segment?.id==='string'&&segment.id.length>0)||document.source_media?.job_id!==id||document.source_media?.kind!==job.media.kind)throw new Error('文字稿与任务媒体身份不一致');
  Coconut.validate(document); // Validate, but return the original evidence unchanged.
  return {...job,transcript:{document}};
 }
 async function media(id,req,res,{signal}={}){
  const job=await get(id,{signal});
  const range=req.headers.range;
  if(range!==undefined&&(typeof range!=='string'||!/^bytes=([0-9]*)-([0-9]*)$/.test(range)))throw Object.assign(new Error('媒体范围无效'),{status:416});
  const response=await request(`/api/ingestion-executor/jobs/${identifier(id)}/media`,{signal,method:req.method,headers:{...(range?{Range:range}:{})}});
  let accepted=false;
  try{
   const rawLength=response.headers.get('content-length'),length=Number(rawLength),type=response.headers.get('content-type');
   if(response.redirected||![200,206].includes(response.status)||type!==job.media.mimeType||!/^\d+$/.test(rawLength||'')||!Number.isSafeInteger(length)||length<1||length>MAX_UPLOAD||!['', 'identity'].includes(response.headers.get('content-encoding')||''))throw new Error('执行器媒体响应类型或大小无效');
   const contentRange=response.headers.get('content-range');
   if(response.status===200){if(job.source.size!==undefined&&length!==job.source.size)throw new Error('媒体长度与原始上传不一致');if(range!==undefined||contentRange!==null)throw new Error('执行器未返回所请求的媒体范围');}
   else{
    const match=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange||''),requested=/^bytes=(\d*)-(\d*)$/.exec(range||'');
    if(!match||!requested||!requested[1]&&!requested[2])throw new Error('执行器媒体范围无效');
    const [start,end,total]=match.slice(1).map(Number),first=requested[1]?Number(requested[1]):null,last=requested[2]?Number(requested[2]):null;
    if(job.source.size!==undefined&&total!==job.source.size)throw new Error('媒体范围总长与原始上传不一致');
    if(![start,end,total,...[first,last].filter(value=>value!==null)].every(Number.isSafeInteger)||total<1||total>MAX_UPLOAD||start<0||end<start||end>=total||length!==end-start+1||first===null&&last===0)throw new Error('执行器媒体范围无效');
    const expectedStart=first===null?Math.max(0,total-last):first,expectedEnd=first===null?total-1:last===null?total-1:Math.min(last,total-1);
    if(start!==expectedStart||end!==expectedEnd)throw new Error('执行器媒体范围与请求不一致');
   }
   const headers={'Content-Type':type,'Content-Length':String(length),'Accept-Ranges':'bytes',...(contentRange?{'Content-Range':contentRange}:{})};
   if(req.method==='HEAD'){await response.body?.cancel();res.writeHead(response.status,headers);res.end();accepted=true;return;}
   if(!response.body)throw new Error('执行器未返回媒体内容');
   res.writeHead(response.status,headers);accepted=true;
   let seen=0;
   for await(const chunk of response.body){
    if(res.destroyed)break;
    seen+=chunk.length;if(seen>length||seen>MAX_UPLOAD)throw new Error('执行器媒体内容超过声明长度');
    if(!res.write(chunk))await new Promise(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});
   }
   if(!res.destroyed){if(seen!==length)throw new Error('执行器媒体内容未完整返回');res.end();}
  }finally{if(!accepted)await response.body?.cancel().catch(()=>{});}
 }
 async function list({signal}={}){const data=await json('/api/jobs',{signal});return (data.jobs||[]).filter(job=>job.options?.local_only===true).map(normalizeImportJob);}
 return Object.freeze({status,upload,recover,get,action,result,media,list});
}
