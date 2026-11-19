import {useEffect,useState} from 'react';
import type {AppStore} from './store';
// @ts-expect-error Shared source identity.
import {sourceMediaIdentity} from '@coconut/shared/source-media.js';
export function supportsCombined(value:any):boolean{return value?.protocolVersion===1&&value.downloadTranscribe?.available===true&&value.downloadTranscribe.local_only===true&&value.downloadTranscribe.acquisitionMode==='incremental-experimental-v1'&&value.downloadTranscribe.backend==='qwen-mlx'&&value.downloadTranscribe.fallback==='complete-file';}
const client=()=> (window as any).CoconutClientCapabilities;
const connection=()=>JSON.stringify([client()?.identity(),client()?.generation,client()?.current?.libraryId]);
export async function combinedCapability(signal?:AbortSignal):Promise<boolean>{if(client()?.allows('sourceJobs')!==true)return false;const scope=connection();const response=await fetch('api/v1/source-jobs/capabilities',{signal});return response.ok&&supportsCombined(await response.json())&&connection()===scope&&client()?.allows('sourceJobs')===true;}
export function useCombinedCapability(){const [available,setAvailable]=useState(false);useEffect(()=>{let controller:AbortController;const refresh=()=>{controller?.abort();controller=new AbortController();const current=controller;setAvailable(false);void combinedCapability(current.signal).then(value=>{if(!current.signal.aborted)setAvailable(value);}).catch(()=>{});};refresh();window.addEventListener('coconut-client-changed',refresh);return()=>{controller.abort();window.removeEventListener('coconut-client-changed',refresh);};},[]);return available;}
type Intent={id:string;binding?:string;promise?:Promise<any>};
const intents=new WeakMap<AppStore,Map<string,Intent>>();
/** Explicit local-only intent. Reuse uncertain submissions, never upgrade download. */
export async function acquireAndTranscribe(store:AppStore,key:string,signal?:AbortSignal,cancelRequested:()=>boolean=()=>false){
 const scope=connection(),doc=store.getDocument(key),libraryId=client()?.current?.libraryId;if(!doc)throw Error('来源项目不存在');
 const mediaIdentity=store.getMedia(key)?.identity,source=sourceMediaIdentity(doc);
 const current=()=>{
  const latest=store.getDocument(key);
  return !signal?.aborted&&connection()===scope&&client()?.allows('sourceJobs')===true&&latest?.project_kind==='audio_only'&&!latest.segments?.length&&store.getMedia(key)?.identity===mediaIdentity&&sourceMediaIdentity(latest)===source;
 };
 if(doc.project_kind!=='audio_only'||doc.segments?.length||mediaIdentity?.startsWith('source-media-sha256:'))throw Error('此项目已有原声或文字稿，请打开项目核对');
 if(!await combinedCapability(signal)||!current())throw Error('当前连接不支持获取原声并转录');
 const saved=await store.flush();if(!saved.ok||!current())throw Error('来源或保存状态已变化，任务未提交');
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source))),b=>b.toString(16).padStart(2,'0')).join('');if(!current())throw Error('来源已变化，任务未提交');
 let map=intents.get(store);if(!map){map=new Map();intents.set(store,map);}const token=JSON.stringify([scope,key,hash]);let intent=map.get(token),existing=!!intent;if(!intent){intent={id:crypto.randomUUID()};map.set(token,intent);}
 const requestedId=intent.id;
 const acceptReceipt=(job:any,requestId:string)=>{
  const idValid=typeof job?.id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(job.id);
  const nonceValid=job?.id===requestId?(job.requestedOperationId===undefined||job.requestedOperationId===requestId):job?.requestedOperationId===requestId;
  if(!idValid||!nonceValid||job.documentKey!==key||job.source!==hash||job.kind!=='download_transcribe'||typeof job.binding!=='string'||!/^[a-f0-9]{64}$/.test(job.binding)||intent!.binding&&intent!.binding!==job.binding)throw Error('来源任务回执身份不匹配');
  // A durable alias is accepted only with explicit server nonce evidence. All
  // subsequent reads and actions address the verified canonical task identity.
  intent!.id=job.id;intent!.binding=job.binding;return job;
 };
 const lookup=async(id:string)=>{const found=await fetch('api/v1/source-jobs/'+id);if(found.ok){const data=await found.json();return acceptReceipt(data.job,id);}if(found.status!==404)throw Error('任务尚未核实，请在来源任务中核对');return null;};
 if(!intent.promise){intent.promise=(async()=>{
  if(existing){const found=await lookup(requestedId);if(found)return found;}
  if(!current())throw Error('来源已变化，任务未提交');
  // Navigation does not discard the durable receipt. Explicit stop is a
  // separately confirmed server action, never an aborted HTTP request.
  const response=await fetch('api/v1/source-jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:1,libraryId,key,source:hash,operation_id:requestedId,kind:'download_transcribe',localOnly:true,acquisitionMode:'incremental-experimental-v1',consent:true})});
  const data=await response.json();if(!response.ok)throw Error(data.error||'任务尚未确认，请在来源任务中核对');return acceptReceipt(data.job,requestedId);
 })().finally(()=>{intent!.promise=undefined;});}
 let job;try{job=await intent.promise;}finally{
  if(cancelRequested()&&connection()===scope){
   const target=job||await lookup(intent.id);if(!target)throw Error('取消尚未确认，请在来源任务中核对');
   const response=await fetch('api/v1/source-jobs/'+target.id+'/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:1})});const data=await response.json();if(!response.ok)throw Error('取消尚未确认，请在来源任务中核对');const cancelled=acceptReceipt(data.job,target.id);if(cancelled.state!=='cancelled')throw Error('取消尚未确认，请在来源任务中核对');
  }
 }
 if(!current())return null;if(job.currentProfile===false)throw Error('任务使用的来源或模型已变化，请打开项目重新确认');if(['cancelled','failed','interrupted'].includes(job.state))throw Error('此来源已有未完成任务，请打开项目核对并重试');return job;
}
