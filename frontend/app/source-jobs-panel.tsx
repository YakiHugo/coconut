import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ChoicePicker} from '../reader-workspace/controls';
import type {AppStore} from './store';
import type {TaskOverview} from './activity';
import type {Document} from './contracts';
import {attachTranscript} from './attach-transcript';
import {mergeAlignmentCandidate} from '@coconut/shared/source-alignment.js';
import {restoreSourceMedia} from './source-media';
// @ts-expect-error Shared source ownership contract also runs on the server.
import {sourceMediaIdentity} from '@coconut/shared/source-media.js';
type Job={id:string;documentKey:string;source:string;binding:string;kind:'download'|'transcribe'|'align'|'download_transcribe'|'captions';automatic?:boolean;documentRevision?:number;languages?:string[];tracks?:{value:string;label:string}[];assetSha256:string|null;mediaReady?:boolean;state:string;updated:number;ingestionId:string|null;phase?:string;currentProfile?:boolean;resultAvailable?:boolean;error:string|null};
const videoSource=(doc:Document)=>typeof doc.source_url==='string'&&/^https:\/\/(?:www\.)?(?:bilibili\.com\/video\/|youtube\.com\/watch\?|youtu\.be\/)/.test(doc.source_url);
const labels:Record<string,string>={queued:'等待中',running:'进行中',ready:'已完成',failed:'失败',interrupted:'已中断，等待核对',cancelled:'已取消',absent:'作者未提供字幕',language_required:'选择作者字幕',unverified:'来源未提供字幕信息'};
function downloadProgress(phase?:string):{receivedBytes:number;totalBytes:number|null}|null{
 try{const value=JSON.parse(phase||'');if(value.phase!=='download'||!Number.isSafeInteger(value.receivedBytes)||value.receivedBytes<0)return null;
 return {receivedBytes:value.receivedBytes,totalBytes:Number.isSafeInteger(value.totalBytes)&&value.totalBytes>0&&value.totalBytes>=value.receivedBytes?value.totalBytes:null};}catch{return null;}
}
function downloadLabel(progress:{receivedBytes:number;totalBytes:number|null}){
 const mib=(bytes:number)=>(bytes/(1024*1024)).toFixed(1)+' MiB';
 return progress.totalBytes?`${mib(progress.receivedBytes)} / ${mib(progress.totalBytes)}（${Math.floor(progress.receivedBytes/progress.totalBytes*100)}%）`:`已下载 ${mib(progress.receivedBytes)}`;
}
function phaseLabel(phase?:string){const progress=downloadProgress(phase);if(progress)return '下载原声 '+downloadLabel(progress);if(!phase)return '';try{const value=JSON.parse(phase);if(value.phase==='fallback')return '完整下载后转录';const labels:Record<string,string>={resolve:'核对原声来源',check_captions:'检查作者字幕',context:'整理节目人物与术语',prepare:'准备音频',recognize:'识别文字',align:'对齐时间',speakers:'区分说话人',identity:'对应人物姓名',review:'AI 校对文字稿',save:'保存结果',done:'已完成'};return (labels[value.phase]||'')+(Number.isSafeInteger(value.chunk)&&value.chunk>0?' '+value.chunk+(Number.isSafeInteger(value.chunks)&&value.chunks>0?'/'+value.chunks:''):'');}catch{return '';}}
async function request(path:string,body?:unknown){const response=await fetch(path,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw Error(typeof data.error==='string'?data.error:'来源任务请求未完成');return data;}
async function digest(text:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');}
export function SourceJobsPanel({store,currentKey,taskHost,panelHost,processingHost,onTasksChange}:{store:AppStore;currentKey:string|null;taskHost?:HTMLElement|null;panelHost?:HTMLElement|null;processingHost?:HTMLElement|null;onTasksChange:(tasks:TaskOverview)=>void}){
 const connection=()=>{const client=(window as any).CoconutClientCapabilities;return {enabled:client?.allows('sourceJobs')===true,generation:client?.generation||0,identity:client?.identity(),libraryId:client?.current?.libraryId};};
 const [client,setClient]=useState(connection),enabled=client.enabled;
 const [jobs,setJobs]=useState<Job[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[consent,setConsent]=useState(false),[available,setAvailable]=useState(false);
 const [captionChoice,setCaptionChoice]=useState('');
 const refreshCurrent=useRef<((document?:boolean)=>void)|null>(null);
 const [alignmentPreview,setAlignmentPreview]=useState<{id:string;aligned:number;total:number;state:string}|null>(null);
 const generation=useRef(0),doc=currentKey?store.getDocument(currentKey):null,source=doc?sourceMediaIdentity(doc):'',media=currentKey?store.getMedia(currentKey):null;
 const saveState=store.getSnapshot();
 const canTranscribe=doc?.project_kind==='audio_only'&&doc.segments.length===0;
 useEffect(()=>{const changed=()=>{generation.current++;setClient(connection());};window.addEventListener('coconut-client-changed',changed);return()=>window.removeEventListener('coconut-client-changed',changed);},[]);
 useEffect(()=>{
  const version=++generation.current;setAlignmentPreview(null);setJobs([]);setConsent(false);setAvailable(false);setMessage('');setBusy(false);if(!enabled||!currentKey)return;
  const attachment=new AbortController();
  let active=true,connected=false,running=false,queued=false,wantsDocument=true,completedDownload='',adoptedRevision=0;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const schedule=(delay:number)=>{
   clearTimeout(timer);if(active)timer=setTimeout(()=>void refresh(),delay);
  };
  const refresh=async()=>{
   if(!active)return;
   if(running){queued=true;return;}
   running=true;
   try{
    const data=await request('api/v1/source-jobs?'+new URLSearchParams({key:currentKey}));
    if(!Array.isArray(data.jobs)||data.jobs.some((job:Job)=>job.documentKey!==currentKey||!['download','transcribe','align','download_transcribe','captions'].includes(job.kind)||!Object.hasOwn(labels,job.state)))throw Error('来源任务回执无效');
    if(!active||generation.current!==version)return;
    setJobs(data.jobs);
    const latest=Math.max(0,...data.jobs.map((job:Job)=>job.documentRevision||0));
    if(latest&&(wantsDocument||latest>adoptedRevision)&&!store.getSnapshot().dirty&&!store.getSnapshot().save.unsaved){
     wantsDocument=false;
     await store.refreshDocument(currentKey);
     if(store.getSnapshot().dirty||store.getSnapshot().save.unsaved)wantsDocument=true;
     else adoptedRevision=latest;
    }
    if(!active||generation.current!==version)return;
    const download=data.jobs.find((job:Job)=>(job.kind==='download'&&job.state==='ready'||job.kind==='download_transcribe'&&job.mediaReady===true&&!!job.assetSha256));
    const receipt=download?download.id+':'+(download.assetSha256||download.updated):'';
    if(receipt&&receipt!==completedDownload){
     const current=store.getMedia(currentKey);
     if(!current||!current.url.startsWith('blob:')&&current.availability!=='local_session'&&!current.nativeToken){
      if(await restoreSourceMedia(store,currentKey,attachment.signal,current?.identity))completedDownload=receipt;
     }
    }
   }catch(error){if(active&&generation.current===version)setMessage(error instanceof Error?error.message:String(error));}
   finally{
    running=false;
    if(!connected)wantsDocument=true;
    const delay=queued?120:connected?60000:15000;queued=false;schedule(delay);
   }
  };
  const refreshSoon=(document=false)=>{wantsDocument||=document;if(running)queued=true;else schedule(120);};
  refreshCurrent.current=refreshSoon;
  const events=typeof window.EventSource==='function'?new window.EventSource('api/v1/events'):null;
  const onEvent=(event:Event)=>{
   try{if(JSON.parse((event as MessageEvent).data)?.key===currentKey)refreshSoon(event.type==='document');}catch{}
  };
  events?.addEventListener('source-job',onEvent);
  events?.addEventListener('media',onEvent);
  events?.addEventListener('document',onEvent);
  if(events){
   events.onopen=()=>{connected=true;refreshSoon(true);};
   events.onerror=()=>{if(connected){connected=false;refreshSoon(true);}};
  }
  void refresh();
  if(store.getDocument(currentKey)?.project_kind==='audio_only')void request('api/v1/ingestions/capabilities').then(data=>{
   const latest=store.getDocument(currentKey);
   if(active&&generation.current===version&&latest?.project_kind==='audio_only'&&!latest.segments.length){setAvailable(data.transcription?.available===true);if(data.transcription?.available!==true)setMessage(data.transcription?.message||'转写执行器尚未就绪');}
  }).catch(()=>{});
  return()=>{active=false;attachment.abort();events?.close();clearTimeout(timer);refreshCurrent.current=null;generation.current++;};
 },[enabled,client.generation,client.identity,currentKey,source,store]);
 useEffect(()=>{if(!saveState.dirty&&!saveState.save.unsaved)refreshCurrent.current?.();},[saveState.dirty,saveState.save.unsaved]);
 useEffect(()=>{onTasksChange({total:jobs.length,running:jobs.filter(job=>['queued','running'].includes(job.state)).length,attention:jobs.filter(job=>['failed','interrupted','language_required'].includes(job.state)||job.state==='ready'&&!job.automatic&&job.kind!=='download').length});},[jobs,onTasksChange]);
 if(!enabled||!doc||!currentKey||!doc.podcast_source&&!videoSource(doc)&&!media?.identity?.startsWith('source-media-sha256:')&&!jobs.length)return null;
 async function run(action:()=>Promise<void>){if(busy)return;const version=generation.current;setBusy(true);setMessage('');try{await action();}catch(error){if(generation.current===version)setMessage(error instanceof Error?error.message:String(error));}finally{if(generation.current===version)setBusy(false);}}
 const create=(kind:'download'|'transcribe'|'align')=>run(async()=>{
  const key=currentKey!,original=store.getDocument(key),version=generation.current;
  const saved=await store.flush();if(!saved.ok||!original||store.getDocument(key)!==original)throw Error('请先确认来源项目已保存');
  const sourceHash=await digest(source);if(generation.current!==version||!connection().enabled||connection().identity!==client.identity)throw Error('所连接的书架或项目已变化，请重新确认');
  const data=await request('api/v1/source-jobs',{protocolVersion:1,libraryId:client.libraryId,key,source:sourceHash,operation_id:crypto.randomUUID(),kind,consent:true,...(kind==='download'?{}:{saveResult:true})});
  if(generation.current!==version)return;setJobs(previous=>[data.job,...previous.filter(job=>job.id!==data.job.id)]);setConsent(false);refreshCurrent.current?.();
 });
 const action=(job:Job,command:'cancel'|'retry',options?:{language?:string;track?:string})=>run(async()=>{const version=generation.current;const data=await request('api/v1/source-jobs/'+job.id+'/'+command,{protocolVersion:1,...options});if(data.job?.id!==job.id||data.job?.kind!==job.kind||data.job?.source!==job.source)throw Error('来源任务回执身份不匹配');if(generation.current===version){setJobs(previous=>previous.map(value=>value.id===job.id?data.job:value));setCaptionChoice('');refreshCurrent.current?.();}});
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
 const captions=jobs.find(job=>job.kind==='captions');
 const downloads=jobs.filter(job=>job.kind==='download'||job.kind==='download_transcribe'&&(canTranscribe||job.mediaReady===true||['running','queued'].includes(job.state))),transcriptions=jobs.filter(job=>(job.kind==='transcribe'||job.kind==='download_transcribe')&&job.currentProfile!==false&&media?.identity==='source-media-sha256:'+job.assetSha256);
 const download=downloads[0],missingAudio=!media,downloadRetry=missingAudio&&download&&(download.kind==='download'||canTranscribe)&&['failed','interrupted','cancelled'].includes(download.state);
 const recognition=transcriptions[0];
 const progress=download?.state==='running'?downloadProgress(download.phase):null;
 const tasks=<section className="ingestion-task-list" aria-label="服务端来源任务"><h2>此项目的来源任务</h2><p role="status">{message}</p>{jobs.map(job=><article key={job.id}><h3>{job.kind==='download'?'保存原声':job.kind==='download_transcribe'?'获取原声并转录':job.kind==='align'?'已有稿对齐':job.kind==='captions'?'作者字幕':'识别文字稿'}</h3><p>{labels[job.state]}{job.state==='running'&&phaseLabel(job.phase)?' · '+phaseLabel(job.phase):''}{job.error?' · '+job.error:''}</p>{alignmentPreview?.id===job.id&&<p>时间候选覆盖 {alignmentPreview.aligned}/{alignmentPreview.total} 个片段；文字准确性尚未验证，请回听核对。</p>}<div>{alignmentPreview?.id===job.id&&<button disabled={busy} onClick={()=>void acceptAlignment(job)}>保留原稿并接入时间候选</button>}{job.kind==='align'&&job.automatic!==true&&job.state==='ready'&&media?.identity==='source-media-sha256:'+job.assetSha256&&<button disabled={busy} onClick={()=>void previewAlignment(job)}>查看对齐候选</button>}{['queued','running','interrupted'].includes(job.state)&&<button disabled={busy} onClick={()=>void action(job,'cancel')}>取消来源任务</button>}{(job.kind==='download'||job.kind==='align'||job.kind==='captions'||canTranscribe)&&(['failed','interrupted','cancelled'].includes(job.state)||job.kind==='download'&&job.state==='ready')&&<button disabled={busy} onClick={()=>void action(job,'retry')}>{job.kind==='download'&&job.state==='ready'?'重新获取原声':'核对并重试原任务'}</button>}{(job.kind==='transcribe'||job.kind==='download_transcribe')&&job.automatic!==true&&job.currentProfile!==false&&media?.identity==='source-media-sha256:'+job.assetSha256&&job.state==='ready'&&(job.kind==='download_transcribe'?job.resultAvailable===true&&job.mediaReady===true:job.resultAvailable!==false)&&canTranscribe&&<button disabled={busy} onClick={()=>void accept(job)}>将文字稿接入原项目</button>}</div></article>)}</section>;
 const choices=captions?.tracks?.length?captions.tracks:(captions?.languages||[]).map(value=>({value,label:value}));
 const alignment=jobs.find(job=>job.kind==='align');
 const processing=doc.segments.length>0&&media?.identity?.startsWith('source-media-sha256:')?<section className="rw-source-alignment" aria-label="文字稿对齐">
    <h3>时间对齐</h3>
    {alignment&&<p>{labels[alignment.state]}{alignment.error?' · '+alignment.error:''}</p>}
    {alignment&&['failed','interrupted','cancelled'].includes(alignment.state)
      ?<button disabled={busy} onClick={()=>void action(alignment,'retry')}>重试时间对齐</button>
      :<button disabled={busy||alignment?.state==='running'||alignment?.state==='queued'} onClick={()=>void create('align')}>将文字稿与原声对齐</button>}
 </section>:null;
 const panel=<section className="source-job-status" aria-label="服务端原声与文字稿">
    {missingAudio&&download&&['queued','running','ready'].includes(download.state)&&
      <p role="status">{download.state==='queued'?'等待下载原声…':download.state==='running'?phaseLabel(download.phase)||'正在获取原声…':'正在载入原声…'}</p>}
    {missingAudio&&progress&&<progress aria-label="原声下载进度" max={progress.totalBytes||undefined} value={progress.totalBytes?progress.receivedBytes:undefined}/>}
    {downloadRetry&&<div><p role="alert">{download.error||'原声下载'+labels[download.state]}</p><button disabled={busy} onClick={()=>void action(download,'retry')}>重试获取原声</button></div>}
    {(Boolean((doc.podcast_source as {media_url?:string}|undefined)?.media_url)||videoSource(doc))&&!media?.identity?.startsWith('source-media-sha256:')&&!downloads.length&&
      <button disabled={busy} onClick={()=>void create('download')}>载入并保存原声</button>}
    {captions&&captions.state!=='ready'&&<div>
      <p role={captions.state==='failed'?'alert':'status'}>{captions.state==='running'?phaseLabel(captions.phase)||'检查作者字幕…':captions.error||labels[captions.state]}</p>
      {captions.state==='language_required'&&choices.length>0&&<>
        <ChoicePicker label="作者字幕" value={captionChoice} options={[{value:'',label:'选择字幕'},...choices]} disabled={busy} onChange={setCaptionChoice}/>
        <button disabled={busy||!captionChoice} onClick={()=>void action(captions,'retry',captions.tracks?.length?{track:captionChoice}:{language:captionChoice})}>获取所选字幕</button>
      </>}
      {(['failed','interrupted','cancelled'].includes(captions.state)||captions.state==='language_required'&&!choices.length)&&<button disabled={busy} onClick={()=>void action(captions,'retry')}>重试作者字幕</button>}
    </div>}
    {canTranscribe&&recognition&&['queued','running','failed','interrupted','cancelled'].includes(recognition.state)&&<div>
      <p role={recognition.state==='failed'?'alert':'status'}>{recognition.error||phaseLabel(recognition.phase)||labels[recognition.state]}</p>
      {['failed','interrupted','cancelled'].includes(recognition.state)&&<button disabled={busy} onClick={()=>void action(recognition,'retry')}>重试转写</button>}
    </div>}
    {canTranscribe&&media?.identity?.startsWith('source-media-sha256:')&&!transcriptions.length&&(!captions||!['running','queued'].includes(captions.state))&&<>
      <label><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>使用本机已配置模型</label>
      <button disabled={busy||!consent||!available} onClick={()=>void create('transcribe')}>生成文字稿</button>
    </>}
    {message&&<p role="status">{message}</p>}
 </section>;
 return <>
    {panelHost?createPortal(panel,panelHost):panelHost===undefined?panel:null}
    {processingHost?createPortal(processing,processingHost):processingHost===undefined?processing:null}
    {taskHost?createPortal(tasks,taskHost):tasks}
 </>;
}
