import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {AppStore} from './store';
import type {TaskOverview} from './activity';
import type {Document} from './contracts';
import {attachTranscript} from './attach-transcript';
import {mergeAlignmentCandidate} from '@coconut/shared/source-alignment.js';
import {acquireAndTranscribe,useCombinedCapability} from './combined-source';
import {restoreSourceMedia} from './source-media';
import {ReadingReviewChoice,useReadingReviewChoice} from './reading-review-choice';
import {queueReadingReview} from './reading-review-state';
// @ts-expect-error Shared source ownership contract also runs on the server.
import {sourceMediaIdentity} from '@coconut/shared/source-media.js';
type Job={id:string;documentKey:string;source:string;binding:string;kind:'download'|'transcribe'|'align'|'download_transcribe';assetSha256:string|null;mediaReady?:boolean;state:string;updated:number;readingReviewProvider?:string;ingestionId:string|null;phase?:string;currentProfile?:boolean;resultAvailable?:boolean;error:string|null};
const videoSource=(doc:Document)=>typeof doc.source_url==='string'&&/^https:\/\/(?:www\.)?(?:bilibili\.com\/video\/|youtube\.com\/watch\?|youtu\.be\/)/.test(doc.source_url);
const labels:Record<string,string>={queued:'等待中',running:'进行中',ready:'已完成',failed:'失败',interrupted:'已中断，等待核对',cancelled:'已取消'};
function phaseLabel(phase?:string){if(!phase)return '';try{const value=JSON.parse(phase);if(value.phase==='fallback')return '完整下载后转录';const labels:Record<string,string>={context:'整理节目人物与术语',prepare:'准备音频',recognize:'识别文字',align:'对齐时间',speakers:'区分说话人',identity:'对应人物姓名',review:'AI 校对文字稿',save:'保存结果',done:'已完成'};return (labels[value.phase]||'')+(Number.isSafeInteger(value.chunk)&&value.chunk>0?' '+value.chunk+(Number.isSafeInteger(value.chunks)&&value.chunks>0?'/'+value.chunks:''):'');}catch{return '';}}
async function request(path:string,body?:unknown){const response=await fetch(path,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw Error(typeof data.error==='string'?data.error:'来源任务请求未完成');return data;}
async function digest(text:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');}
export function SourceJobsPanel({store,currentKey,taskHost,panelHost,onTasksChange}:{store:AppStore;currentKey:string|null;taskHost?:HTMLElement|null;panelHost?:HTMLElement|null;onTasksChange:(tasks:TaskOverview)=>void}){
 const combinedAvailable=useCombinedCapability();
 const connection=()=>{const client=(window as any).CoconutClientCapabilities;return {enabled:client?.allows('sourceJobs')===true,generation:client?.generation||0,identity:client?.identity(),libraryId:client?.current?.libraryId};};
 const [client,setClient]=useState(connection),enabled=client.enabled;
 const [jobs,setJobs]=useState<Job[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[consent,setConsent]=useState(false),[available,setAvailable]=useState(false);
 const [alignmentPreview,setAlignmentPreview]=useState<{id:string;aligned:number;total:number;state:string}|null>(null);
 const autoAccepted=useRef(new Set<string>()),autoQueued=useRef(new Set<string>());
 const operations=useRef(new AbortController());
 const generation=useRef(0),refreshing=useRef(false),doc=currentKey?store.getDocument(currentKey):null,source=doc?sourceMediaIdentity(doc):'',media=currentKey?store.getMedia(currentKey):null;
 const canTranscribe=doc?.project_kind==='audio_only'&&doc.segments.length===0;
 const reviewChoice=useReadingReviewChoice(enabled&&canTranscribe);
 const optedProvider=reviewChoice.checked?reviewChoice.provider:false;
 const saving=Boolean(store.getSnapshot?.().save.unsaved),dirty=Boolean(store.getSnapshot?.().dirty);
 useEffect(()=>{const changed=()=>{generation.current++;setClient(connection());};window.addEventListener('coconut-client-changed',changed);return()=>window.removeEventListener('coconut-client-changed',changed);},[]);
 useEffect(()=>{
  operations.current.abort();const operationController=new AbortController();operations.current=operationController;
  const version=++generation.current;setAlignmentPreview(null);setJobs([]);setConsent(false);setAvailable(false);setMessage('');setBusy(false);if(!enabled||!currentKey)return;
  let active=true,timer:ReturnType<typeof setTimeout>,completedDownload='';const attachment=new AbortController();
  const refresh=async()=>{
   if(!active||refreshing.current){if(active)timer=setTimeout(()=>void refresh(),1000);return;}refreshing.current=true;
   try{
    const data=await request('api/v1/source-jobs?'+new URLSearchParams({key:currentKey}));
    if(!Array.isArray(data.jobs)||data.jobs.some((job:Job)=>job.documentKey!==currentKey||!['download','transcribe','align','download_transcribe'].includes(job.kind)||!Object.hasOwn(labels,job.state)))throw Error('来源任务回执无效');
    if(!active||generation.current!==version)return;setJobs(data.jobs);
    const download=data.jobs.find((job:Job)=>(job.kind==='download'&&job.state==='ready'||job.kind==='download_transcribe'&&job.mediaReady===true&&!!job.assetSha256)),receipt=download?download.id+':'+(download.assetSha256||download.updated):'';
    if(receipt&&receipt!==completedDownload){const current=store.getMedia(currentKey);if(!current||!current.url.startsWith('blob:')&&current.availability!=='local_session'&&!current.nativeToken){if(await restoreSourceMedia(store,currentKey,attachment.signal,current?.identity))completedDownload=receipt;}}
   }catch(error){if(active&&generation.current===version)setMessage(error instanceof Error?error.message:String(error));}
   finally{refreshing.current=false;if(active)timer=setTimeout(()=>void refresh(),3000);}
  };
  void refresh();
  if(store.getDocument(currentKey)?.project_kind==='audio_only'){
   void request('api/v1/ingestions/capabilities').then(data=>{
   const latest=store.getDocument(currentKey);
   if(active&&generation.current===version&&latest?.project_kind==='audio_only'&&!latest.segments.length){setAvailable(data.transcription?.available===true);if(data.transcription?.available!==true)setMessage(data.transcription?.message||'转写执行器尚未就绪');}
  }).catch(()=>{});
  }
  return()=>{operationController.abort();active=false;attachment.abort();clearTimeout(timer);generation.current++;};
 },[enabled,client.generation,client.identity,currentKey,source,store]);
 useEffect(()=>{onTasksChange({total:jobs.length,running:jobs.filter(job=>['queued','running'].includes(job.state)).length,attention:jobs.filter(job=>['ready','failed','interrupted'].includes(job.state)).length});},[jobs,onTasksChange]);
 useEffect(()=>{
  const binding=doc?.local_job_binding as {id?:string}|undefined;
  const job=jobs.find(item=>item.readingReviewProvider&&item.state==='ready'&&item.ingestionId&&item.ingestionId===binding?.id);
  if(!enabled||!job||!doc?.segments.length||saving||dirty||doc.reading_review||autoQueued.current.has(job.id))return;
  autoQueued.current.add(job.id);
  void queueReadingReview(store,doc,job.readingReviewProvider!,job.id);
 },[doc,jobs,enabled,store,saving,dirty]);
 useEffect(()=>{
  if(!canTranscribe||!enabled||!currentKey||busy||saving||dirty)return;
  const job=jobs.find(item=>item.readingReviewProvider&&item.state==='ready'&&item.resultAvailable===true&&
   item.currentProfile!==false&&item.assetSha256&&media?.identity==='source-media-sha256:'+item.assetSha256);
  if(job&&!autoAccepted.current.has(job.id)){autoAccepted.current.add(job.id);void accept(job);}
 },[canTranscribe,enabled,currentKey,busy,jobs,media?.identity,store,saving,dirty]);
 if(!enabled||!doc||!currentKey||!doc.podcast_source&&!videoSource(doc)&&!media?.identity?.startsWith('source-media-sha256:')&&!jobs.length)return null;
 async function run(action:()=>Promise<void>){if(busy)return;const version=generation.current;setBusy(true);setMessage('');try{await action();}catch(error){if(generation.current===version)setMessage(error instanceof Error?error.message:String(error));}finally{if(generation.current===version)setBusy(false);}}
 const create=(kind:'download'|'transcribe'|'align'|'download_transcribe')=>run(async()=>{
  const key=currentKey!,original=store.getDocument(key),version=generation.current;
  if(kind==='download_transcribe'){const job=await acquireAndTranscribe(store,key,operations.current.signal,undefined,optedProvider);if(generation.current===version&&job){setJobs(previous=>[job,...previous.filter(value=>value.id!==job.id)]);setMessage('任务已提交。');}return;}
  const saved=await store.flush();if(!saved.ok||!original||store.getDocument(key)!==original)throw Error('请先确认来源项目已保存');
  const sourceHash=await digest(source);if(generation.current!==version||!connection().enabled||connection().identity!==client.identity)throw Error('所连接的书架或项目已变化，请重新确认');
  const data=await request('api/v1/source-jobs',{protocolVersion:1,libraryId:client.libraryId,key,source:sourceHash,operation_id:crypto.randomUUID(),kind,consent:true,...(kind==='transcribe'?{after_transcription_review:optedProvider}:{})});
  if(generation.current!==version)return;setJobs(previous=>[data.job,...previous.filter(job=>job.id!==data.job.id)]);setConsent(false);setMessage('任务已提交。');
 });
 const action=(job:Job,command:'cancel'|'retry')=>run(async()=>{const version=generation.current;const data=await request('api/v1/source-jobs/'+job.id+'/'+command,{protocolVersion:1});if(data.job?.id!==job.id||data.job?.kind!==job.kind||data.job?.source!==job.source)throw Error('来源任务回执身份不匹配');if(generation.current===version)setJobs(previous=>previous.map(value=>value.id===job.id?data.job:value));});
 const accept=(job:Job)=>run(async()=>{
  const key=currentKey!,original=store.getDocument(key),revision=store.getRevision(key),version=generation.current,mediaIdentity=store.getMedia(key)?.identity;
  if(!job.assetSha256||mediaIdentity!=='source-media-sha256:'+job.assetSha256||job.state!=='ready'||job.kind==='download_transcribe'&&(job.resultAvailable!==true||job.mediaReady!==true))throw Error('原声或文字稿尚未完成核验');
  const data=await request('api/v1/source-jobs/'+job.id+'/result');
  if(generation.current!==version||store.getMedia(key)?.identity!==mediaIdentity||data.job?.id!==job.id||data.job?.kind!==job.kind||data.job?.source!==job.source||data.job?.assetSha256!==job.assetSha256||data.job?.state!=='ready'||job.kind==='download_transcribe'&&(data.job?.resultAvailable!==true||data.job?.mediaReady!==true)||!original||store.getDocument(key)!==original||store.getRevision(key)!==revision||data.job.binding!==job.binding||data.job.ingestionId!==job.ingestionId||data.ingestion.id!==job.ingestionId)throw Error('项目或任务已变化，请刷新后核对');
  const value=data.ingestion.transcript?.document;if(!value)throw Error('任务尚未返回文字稿');
  const core=(window as any).Coconut,sourceDocument=core.validate(value);delete sourceDocument.source_media;if(sourceDocument.provenance){sourceDocument.provenance={...sourceDocument.provenance};delete sourceDocument.provenance.playback_warning;if(!Object.keys(sourceDocument.provenance).length)delete sourceDocument.provenance;}const next={...attachTranscript(original,value,core,(window as any).CoconutCanonicalLibrary.project),key,local_job_binding:{id:job.ingestionId,fingerprint:await digest(JSON.stringify(sourceDocument))}} as Document;
  if(generation.current!==version||store.getRevision(key)!==revision||store.getMedia(key)?.identity!==mediaIdentity)throw Error('项目已变化，请重新核对文字稿');
  const saved=await store.commitDocument(next,{key,revision});if(generation.current!==version)return;setMessage(saved?'文字稿已保存。':'文字稿保存尚未确认，请查看保存状态并保留备份。');
 });
 const previewAlignment=(job:Job)=>run(async()=>{const version=generation.current;const data=await request('api/v1/source-jobs/'+job.id+'/result');if(version!==generation.current)return;const report=data.alignment?.alignment_report;if(!Number.isSafeInteger(report?.aligned_cues)||!Number.isSafeInteger(report?.total_cues))throw Error('对齐报告不完整');setAlignmentPreview({id:job.id,aligned:report.aligned_cues,total:report.total_cues,state:report.status});});
 const acceptAlignment=(job:Job)=>run(async()=>{
  const key=currentKey!,original=store.getDocument(key),revision=store.getRevision(key),version=generation.current,identity=store.getMedia(key)?.identity;
  if(!original||!job.assetSha256||identity!=='source-media-sha256:'+job.assetSha256)throw Error('原声已变化，旧候选未应用');
  const data=await request('api/v1/source-jobs/'+job.id+'/result');
  if(generation.current!==version||store.getRevision(key)!==revision||store.getMedia(key)?.identity!==identity||data.job?.id!==job.id||data.job?.assetSha256!==job.assetSha256)throw Error('原稿或音频已变化，旧候选未应用');
  const merged=mergeAlignmentCandidate(original,data.alignment?.input,data.alignment?.document,data.alignment?.alignment_report,job.assetSha256);
  const next={...merged,source_alignment:{...(merged.source_alignment as object),asset_sha256:job.assetSha256,alignment_identity:data.alignment?.alignment_identity||null}};
  const saved=await store.commitDocument(next,{key,revision});if(generation.current!==version)return;setMessage(saved?'对齐候选已保存；文字准确性仍需回听核对。':'保存尚未确认，请保留原稿。');
 });
 const downloads=jobs.filter(job=>job.kind==='download'||job.kind==='download_transcribe'&&(canTranscribe||job.mediaReady===true||['running','queued'].includes(job.state))),transcriptions=jobs.filter(job=>(job.kind==='transcribe'||job.kind==='download_transcribe')&&job.currentProfile!==false&&media?.identity==='source-media-sha256:'+job.assetSha256);
 const download=downloads[0],missingAudio=!media,downloadRetry=missingAudio&&download&&(download.kind==='download'||canTranscribe)&&['failed','interrupted','cancelled'].includes(download.state);
 const tasks=<section className="ingestion-task-list" aria-label="服务端来源任务"><h2>此项目的来源任务</h2><p role="status">{message}</p>{jobs.map(job=><article key={job.id}><h3>{job.kind==='download'?'保存原声':job.kind==='download_transcribe'?'获取原声并转录':job.kind==='align'?'已有稿对齐':'识别文字稿'}</h3><p>{labels[job.state]}{job.state==='running'&&phaseLabel(job.phase)?' · '+phaseLabel(job.phase):''}{job.error?' · '+job.error:''}</p>{alignmentPreview?.id===job.id&&<p>时间候选覆盖 {alignmentPreview.aligned}/{alignmentPreview.total} 个片段；文字准确性尚未验证，请回听核对。</p>}<div>{alignmentPreview?.id===job.id&&<button disabled={busy} onClick={()=>void acceptAlignment(job)}>保留原稿并接入时间候选</button>}{job.kind==='align'&&job.state==='ready'&&media?.identity==='source-media-sha256:'+job.assetSha256&&<button disabled={busy} onClick={()=>void previewAlignment(job)}>查看对齐候选</button>}{['queued','running','interrupted'].includes(job.state)&&<button disabled={busy} onClick={()=>void action(job,'cancel')}>取消来源任务</button>}{(job.kind==='download'||job.kind==='align'||canTranscribe)&&(['failed','interrupted','cancelled'].includes(job.state)||job.kind==='download'&&job.state==='ready')&&<button disabled={busy} onClick={()=>void action(job,'retry')}>{job.kind==='download'&&job.state==='ready'?'重新获取原声':'核对并重试原任务'}</button>}{(job.kind==='transcribe'||job.kind==='download_transcribe')&&job.currentProfile!==false&&media?.identity==='source-media-sha256:'+job.assetSha256&&job.state==='ready'&&(job.kind==='download_transcribe'?job.resultAvailable===true&&job.mediaReady===true:job.resultAvailable!==false)&&canTranscribe&&<button disabled={busy} onClick={()=>void accept(job)}>将文字稿接入原项目</button>}</div></article>)}</section>;
 const panel=<section className="ingestion-panel" aria-label="服务端原声与文字稿"><h2>原声与文字稿</h2>{missingAudio&&download&&['queued','running','ready'].includes(download.state)&&<p role="status">{download.mediaReady===true?'原声已保存，正在载入播放器。':download.state==='queued'?'正在等待获取原声…':download.state==='running'?'正在获取原声，完成后会自动载入播放器。':download.kind==='download_transcribe'?'原声尚未确认保存。':'原声已保存，正在载入播放器。'}</p>}{downloadRetry&&<div><p role="alert">{download.error||'原声尚未获取，下载'+labels[download.state]+'。'}</p><button disabled={busy} onClick={()=>void action(download,'retry')}>{download.kind==='download_transcribe'?'重试获取原声并转录':'重试获取原声'}</button></div>}{(Boolean((doc.podcast_source as {media_url?:string}|undefined)?.media_url)||videoSource(doc))&&!media?.identity?.startsWith('source-media-sha256:')&&!downloads.length&&<><button disabled={busy} onClick={()=>void create('download')}>载入并保存原声</button>{combinedAvailable&&canTranscribe&&<button disabled={busy} onClick={()=>void create('download_transcribe')}>获取原声并转录</button>}</>}{doc.segments.length>0&&media?.identity?.startsWith('source-media-sha256:')&&<><p>原文保留；对齐只生成时间候选，不证明文字准确。</p><button disabled={busy} onClick={()=>void create('align')}>生成已有稿对齐候选</button></>}<p>原声与任务保存在所连接的服务，关闭页面后继续。</p>{canTranscribe&&<ReadingReviewChoice value={reviewChoice} when="转录后" disabled={busy}/>}{canTranscribe&&media?.identity?.startsWith('source-media-sha256:')&&!transcriptions.length&&<><label><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>确认使用服务中已有的模型识别原声</label><button disabled={busy||!consent||!available} onClick={()=>void create('transcribe')}>生成文字稿</button></>}<p role="status">{message}</p></section>;
 return <>{panelHost?createPortal(panel,panelHost):panelHost===undefined?panel:null}{taskHost?createPortal(tasks,taskHost):tasks}</>;
}
