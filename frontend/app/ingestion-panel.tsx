import React,{useEffect,useState,useSyncExternalStore} from 'react';
import {ingestionBinding} from './ingestion-binding';
import {attachTranscript} from './attach-transcript';
import {createIngestionJobs} from './ingestion-jobs';
import type {AppStore} from './store';
import type {Document} from './contracts';
export function IngestionPanel({store,currentKey}:{store:AppStore;currentKey:string|null}){
 const [consent,setConsent]=useState(false);
 const [controller]=useState(()=>createIngestionJobs({
  withLock:run=>{if(!navigator.locks) return Promise.reject(Error('此浏览器不能安全协调多页面任务。请使用支持 Web Locks 的桌面浏览器。'));return navigator.locks.request('coconut-react-ingestion-journal-v1',run);},
  request:async(path,init)=>{const response=await fetch(path,init);const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error?.message||data.error||'任务请求失败'),{code:data.code,status:response.status});return data;},
  binding:(key,expected)=>ingestionBinding(store,key,expected),
  restoreMedia:(binding,job)=>{if(job.media)store.setMedia(binding.key,{url:job.media.url,kind:job.media.kind,name:job.media.name||job.source.name,identity:'local-job:'+job.id,availability:'remote'});},
  accept:async(value,binding,jobId)=>{const core=(window as any).Coconut,doc=store.getDocument(binding.key);if(!doc||store.getRevision(doc.key)!==binding.revision)return false;const source=core.validate(value);delete source.source_media;if(source.provenance){source.provenance={...source.provenance};delete source.provenance.playback_warning;if(!Object.keys(source.provenance).length)delete source.provenance;}const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(source)));const fingerprint=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');const next={...attachTranscript(doc,value,core,(window as any).CoconutCanonicalLibrary.project),key:doc.key,local_job_binding:{id:jobId,fingerprint}} as Document;return store.commitDocument(next,{key:doc.key,revision:binding.revision});},
  journal:{read:()=>localStorage.getItem('coconut-react-ingestion-jobs-v1'),write:value=>localStorage.setItem('coconut-react-ingestion-jobs-v1',value)},uuid:()=>crypto.randomUUID()
 }));
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot),doc=currentKey?store.getDocument(currentKey):null,file=currentKey?store.getFile(currentKey):null;
 useEffect(()=>{store.setActivity('asr',state.busy?'文字稿任务请求尚未完成':null);return()=>store.setActivity('asr',null);},[store,state.busy]);
 useEffect(()=>{setConsent(false);},[currentKey,file,doc?.local_media_source,doc?.podcast_source]);
 useEffect(()=>{const retire=()=>controller.dispose();window.addEventListener('pagehide',retire);return()=>{window.removeEventListener('pagehide',retire);retire();};},[controller]);
 const active=state.entries.filter(entry=>entry.job&&['queued','running'].includes(entry.job.state));
 const activeIds=active.map(entry=>entry.operation).join('|');
 useEffect(()=>{if(!activeIds)return;let alive=true,timer:ReturnType<typeof setTimeout>;const poll=async()=>{for(const operation of activeIds.split('|')){if(!alive)return;await controller.commands.refresh(operation);}if(alive)timer=setTimeout(()=>void poll(),3000);};timer=setTimeout(()=>void poll(),3000);return()=>{alive=false;clearTimeout(timer);};},[controller,activeIds]);
 if(!file&&!state.entries.length)return null;
 return <section className="ingestion-panel" aria-label="原声与文字稿任务"><h2>从原声到文字稿</h2>{doc?.project_kind==='audio_only'&&file&&<><p>将当前音视频发送到已配置的本机执行器，使用已有模型识别；不自动下载模型。</p><button disabled={state.busy} onClick={()=>void controller.commands.capabilities()}>检查本地识别服务</button><p role="status">{state.capabilityMessage}</p><label><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>我确认发送此文件并开始本地识别。关闭页面不会取消已经创建的任务。</label><button disabled={!consent||!state.available||state.busy} onClick={()=>{setConsent(false);void controller.commands.upload(doc.key,file);}}>生成文字稿</button></>}
 <p role="status">{state.message}</p>{state.entries.map(entry=><article key={entry.operation}><h3>{entry.name}</h3><p>{entry.job?.state||'回执未确认'} · {entry.message}</p>{entry.job&&<><small>任务 {entry.job.id}</small><div><button disabled={state.busy} onClick={()=>void controller.commands.restoreMedia(entry.operation)}>重新打开任务原声</button><button disabled={state.busy} onClick={()=>void controller.commands.refresh(entry.operation)}>刷新状态</button>{['queued','running'].includes(entry.job.state)&&<button disabled={state.busy} onClick={()=>void controller.commands.action(entry.operation,'cancel')}>取消任务</button>}{['failed','interrupted','cancelled'].includes(entry.job.state)&&<button disabled={state.busy} onClick={()=>void controller.commands.action(entry.operation,'retry')}>明确重试原任务</button>}{entry.job.state==='ready'&&<button disabled={state.busy} onClick={()=>void controller.commands.accept(entry.operation)}>将文字稿接入原项目</button>}</div></>}{entry.unknown&&<div><p>上传回执未确认。先按原操作核对，不按文件名猜测任务。</p><button disabled={state.busy} onClick={()=>void controller.commands.reconcile(entry.operation)}>核对原上传操作</button>{store.getFile(entry.binding.key)&&<button disabled={state.busy} onClick={()=>{const original=store.getFile(entry.binding.key);if(original)void controller.commands.resend(entry.operation,original);}}>明确重发同一原操作</button>}</div>}</article>)}</section>;
}
