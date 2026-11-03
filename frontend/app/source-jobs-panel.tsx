import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {AppStore} from './store';
import type {TaskOverview} from './activity';
import type {Document} from './contracts';
import {attachTranscript} from './attach-transcript';
import {restoreSourceMedia} from './source-media';
// @ts-expect-error Shared source ownership contract also runs on the server.
import {sourceMediaIdentity} from '../../shared/source-media.js';
type Job={id:string;documentKey:string;source:string;binding:string;kind:'download'|'transcribe';assetSha256:string|null;state:string;updated:number;ingestionId:string|null;error:string|null};
const labels:Record<string,string>={queued:'等待中',running:'进行中',ready:'已完成',failed:'失败',interrupted:'已中断，等待核对',cancelled:'已取消'};
async function request(path:string,body?:unknown){const response=await fetch(path,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw Error(typeof data.error==='string'?data.error:'来源任务请求未完成');return data;}
async function digest(text:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');}
export function SourceJobsPanel({store,currentKey,taskHost,onTasksChange}:{store:AppStore;currentKey:string|null;taskHost?:HTMLElement|null;onTasksChange:(tasks:TaskOverview)=>void}){
 const connection=()=>{const client=(window as any).CoconutClientCapabilities;return {enabled:client?.allows('sourceJobs')===true,generation:client?.generation||0,identity:client?.identity(),libraryId:client?.current?.libraryId};};
 const [client,setClient]=useState(connection),enabled=client.enabled;
 const [jobs,setJobs]=useState<Job[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[consent,setConsent]=useState(false),[available,setAvailable]=useState(false);
 const generation=useRef(0),refreshing=useRef(false),doc=currentKey?store.getDocument(currentKey):null,source=doc?sourceMediaIdentity(doc):'',media=currentKey?store.getMedia(currentKey):null;
 useEffect(()=>{const changed=()=>{generation.current++;setClient(connection());};window.addEventListener('coconut-client-changed',changed);return()=>window.removeEventListener('coconut-client-changed',changed);},[]);
 useEffect(()=>{
  const version=++generation.current;setJobs([]);setConsent(false);setAvailable(false);setMessage('');setBusy(false);if(!enabled||!currentKey)return;
  let active=true,timer:ReturnType<typeof setTimeout>,completedDownload='';const attachment=new AbortController();
  const refresh=async()=>{
   if(!active||refreshing.current){if(active)timer=setTimeout(()=>void refresh(),1000);return;}refreshing.current=true;
   try{
    const data=await request('api/v1/source-jobs?'+new URLSearchParams({key:currentKey}));
    if(!Array.isArray(data.jobs)||data.jobs.some((job:Job)=>job.documentKey!==currentKey||!['download','transcribe'].includes(job.kind)||!Object.hasOwn(labels,job.state)))throw Error('来源任务回执无效');
    if(!active||generation.current!==version)return;setJobs(data.jobs);
    const download=data.jobs.find((job:Job)=>job.kind==='download'&&job.state==='ready'),receipt=download?download.id+':'+download.updated:'';
    if(receipt&&receipt!==completedDownload){completedDownload=receipt;const current=store.getMedia(currentKey);if(!current||current.identity?.startsWith('source-media-sha256:'))await restoreSourceMedia(store,currentKey,attachment.signal,current?.identity);}
   }catch(error){if(active&&generation.current===version)setMessage(error instanceof Error?error.message:String(error));}
   finally{refreshing.current=false;if(active)timer=setTimeout(()=>void refresh(),3000);}
  };
  void refresh();
  void request('api/v1/ingestions/capabilities').then(data=>{if(active&&generation.current===version){setAvailable(data.transcription?.available===true);if(data.transcription?.available!==true)setMessage(data.transcription?.message||'转写执行器尚未就绪');}}).catch(()=>{});
  return()=>{active=false;attachment.abort();clearTimeout(timer);generation.current++;};
 },[enabled,client.generation,client.identity,currentKey,source,store]);
 useEffect(()=>{onTasksChange({total:jobs.length,running:jobs.filter(job=>['queued','running'].includes(job.state)).length,attention:jobs.filter(job=>['ready','failed','interrupted'].includes(job.state)).length});},[jobs,onTasksChange]);
 if(!enabled||!doc||!currentKey)return null;
 async function run(action:()=>Promise<void>){if(busy)return;const version=generation.current;setBusy(true);setMessage('');try{await action();}catch(error){if(generation.current===version)setMessage(error instanceof Error?error.message:String(error));}finally{if(generation.current===version)setBusy(false);}}
 const create=(kind:'download'|'transcribe')=>run(async()=>{
  const key=currentKey!,original=store.getDocument(key),version=generation.current;
  const saved=await store.flush();if(!saved.ok||!original||store.getDocument(key)!==original)throw Error('请先确认来源项目已保存');
  const sourceHash=await digest(source);if(generation.current!==version||!connection().enabled||connection().identity!==client.identity)throw Error('所连接的书架或项目已变化，请重新确认');
  const data=await request('api/v1/source-jobs',{protocolVersion:1,libraryId:client.libraryId,key,source:sourceHash,operation_id:crypto.randomUUID(),kind,consent:true});
  if(generation.current!==version)return;setJobs(previous=>[data.job,...previous.filter(job=>job.id!==data.job.id)]);setConsent(false);setMessage('已交给所连接的服务执行。关闭页面后可重新打开此项目查看。');
 });
 const action=(job:Job,command:'cancel'|'retry')=>run(async()=>{const version=generation.current;const data=await request('api/v1/source-jobs/'+job.id+'/'+command,{protocolVersion:1});if(generation.current===version)setJobs(previous=>previous.map(value=>value.id===job.id?data.job:value));});
 const accept=(job:Job)=>run(async()=>{
  const key=currentKey!,original=store.getDocument(key),revision=store.getRevision(key),version=generation.current;
  const data=await request('api/v1/source-jobs/'+job.id+'/result');
  if(generation.current!==version||!original||store.getDocument(key)!==original||store.getRevision(key)!==revision||data.job.binding!==job.binding||data.job.ingestionId!==job.ingestionId||data.ingestion.id!==job.ingestionId)throw Error('项目或任务已变化，请刷新后核对');
  const value=data.ingestion.transcript?.document;if(!value)throw Error('任务尚未返回文字稿');
  const core=(window as any).Coconut,sourceDocument=core.validate(value);delete sourceDocument.source_media;if(sourceDocument.provenance){sourceDocument.provenance={...sourceDocument.provenance};delete sourceDocument.provenance.playback_warning;if(!Object.keys(sourceDocument.provenance).length)delete sourceDocument.provenance;}const next={...attachTranscript(original,value,core,(window as any).CoconutCanonicalLibrary.project),key,local_job_binding:{id:job.ingestionId,fingerprint:await digest(JSON.stringify(sourceDocument))}} as Document;
  if(generation.current!==version||store.getRevision(key)!==revision)throw Error('项目已变化，请重新核对文字稿');
  const saved=await store.commitDocument(next,{key,revision});setMessage(saved?'文字稿已保存到原项目，已有项目笔记和时间书签保留。':'文字稿保存尚未确认，请查看保存状态并保留备份。');
 });
 const downloads=jobs.filter(job=>job.kind==='download'),transcriptions=jobs.filter(job=>job.kind==='transcribe'&&media?.identity==='source-media-sha256:'+job.assetSha256);
 const tasks=<section className="ingestion-task-list" aria-label="服务端来源任务"><h2>此项目的来源任务</h2>{jobs.map(job=><article key={job.id}><h3>{job.kind==='download'?'保存原声':'识别文字稿'}</h3><p>{labels[job.state]}{job.error?' · '+job.error:''}</p><div>{['queued','running','interrupted'].includes(job.state)&&<button disabled={busy} onClick={()=>void action(job,'cancel')}>取消来源任务</button>}{(['failed','interrupted','cancelled'].includes(job.state)||job.kind==='download'&&job.state==='ready')&&<button disabled={busy} onClick={()=>void action(job,'retry')}>{job.kind==='download'&&job.state==='ready'?'重新获取原声':'核对并重试原任务'}</button>}{job.kind==='transcribe'&&media?.identity==='source-media-sha256:'+job.assetSha256&&job.state==='ready'&&doc.project_kind==='audio_only'&&<button disabled={busy} onClick={()=>void accept(job)}>将文字稿接入原项目</button>}</div></article>)}</section>;
 return <><section className="ingestion-panel" aria-label="服务端原声与文字稿"><h2>原声与文字稿</h2>{!!doc.podcast_source&&!media&&!downloads.length&&<button disabled={busy} onClick={()=>void create('download')}>载入并保存原声</button>}<p>原声和任务保存在所连接的服务。关闭页面或换浏览器后，重新打开此项目即可继续查看。</p>{doc.project_kind==='audio_only'&&media?.identity?.startsWith('source-media-sha256:')&&!transcriptions.length&&<><label><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>确认使用服务中已有的模型识别原声</label><button disabled={busy||!consent||!available} onClick={()=>void create('transcribe')}>生成文字稿</button></>}<p role="status">{message}</p></section>{taskHost?createPortal(tasks,taskHost):tasks}</>;
}
