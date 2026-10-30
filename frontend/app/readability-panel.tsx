import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {AppStore} from './store';
import {createReadabilityController} from './readability-controller';
import {inspectFile} from './ingestion';
import {downloadVideoAudio,validateDownloadedVideoMedia} from './video-audio';
import {sourceSignature} from '../../shared/transcript-resources.js';
const labels:Record<string,string>={transcript:'文字稿',punctuation:'标点与断句',speakers:'说话人',chapters:'章节'};
const phases:Record<string,string>={awaiting_media:'等待原声上传',queued:'等待本地整理',speakers:'正在按声音区分说话人',punctuation:'正在恢复标点',complete:'自动处理已结束',failed:'整理失败',interrupted:'整理已中断',cancelled:'整理已取消'};
const phaseLabel=(value:string)=>value.startsWith('speakers:')?'正在区分说话人 · 第 '+value.slice(9)+' 块':phases[value]||value;
export function ReadabilityPanel({store,documentKey}:{store:AppStore;documentKey:string|null}){
 const [controller]=useState(()=>createReadabilityController({getDocument:store.getDocument,getRevision:store.getRevision,getFile:store.getFile,getMedia:store.getMedia,canApply:()=>!store.getSnapshot().dirty,commit:store.commitDocument,uuid:()=>crypto.randomUUID(),request:async(url,init)=>{const response=await fetch(url,init),data=await response.json();if(!response.ok)throw Error(typeof data.error==='string'?data.error:'本地整理服务未就绪');return data;}}));
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot),doc=documentKey?store.getDocument(documentKey):null,file=documentKey?store.getFile(documentKey):null,media=documentKey?store.getMedia(documentKey):null;
 const [attachmentError,setAttachmentError]=useState(''),[attaching,setAttaching]=useState(false),attachment=useRef<AbortController|null>(null);
 const signature=doc?.segments.length?sourceSignature(doc):'',dirty=store.getSnapshot().dirty;
 useEffect(()=>{if(documentKey&&signature&&!dirty)void controller.refresh(documentKey,{automatic:true});},[controller,documentKey,signature,file,media?.identity,dirty]);
 useEffect(()=>{if(!documentKey||state.key!==documentKey||!state.job||!['queued','running','awaiting_media'].includes(state.job.state))return;const timer=setTimeout(()=>void controller.refresh(documentKey),1500);return()=>clearTimeout(timer);},[controller,documentKey,state.job,state.busy]);
 useEffect(()=>{store.setActivity('readability',state.busy?'正在核对或保存文字整理任务':null);return()=>store.setActivity('readability',null);},[state.busy,store]);
 useEffect(()=>{const retire=()=>{controller.dispose();attachment.current?.abort();};window.addEventListener('pagehide',retire);return()=>{window.removeEventListener('pagehide',retire);retire();};},[controller]);
 useEffect(()=>{attachment.current?.abort();setAttachmentError('');setAttaching(false);},[documentKey]);
 if(!doc?.segments.length)return null;
 async function attach(file:File){
  if(!doc||!documentKey||attaching)return;const key=documentKey,before=sourceSignature(doc),owner=new AbortController();attachment.current=owner;setAttaching(true);setAttachmentError('');
  try{
   const inspected=await inspectFile(file),provenance=doc.provenance as {media_duration?:number}|undefined,expected=Number(doc.media_duration||provenance?.media_duration||doc.segments.at(-1)?.end);
   if(Number.isFinite(expected)&&expected>0)await validateDownloadedVideoMedia(file,inspected.kind,expected,owner.signal);
   if(owner.signal.aborted||!store.getDocument(key)||sourceSignature(store.getDocument(key)!)!==before)throw Error('读取期间原稿已变化，请重新选择对应原声');
   store.setFile(key,file);store.setMedia(key,{url:URL.createObjectURL(file),kind:inspected.kind,name:file.name,identity:inspected.identity,availability:'local_session'});
  }catch(error){if(!owner.signal.aborted)setAttachmentError(error instanceof Error?error.message:String(error));}
  finally{if(attachment.current===owner){attachment.current=null;setAttaching(false);}}
 }
 async function loadSource(){
  if(!doc||!documentKey||attaching)return;const owner=new AbortController();attachment.current=owner;setAttaching(true);setAttachmentError('');
  const key=documentKey,before=sourceSignature(doc);
  try{
   const url=String(doc.source_url||''),language=typeof doc.language==='string'?doc.language:null;
   const result=await downloadVideoAudio({endpoint:'/api/videos/media',url,language},owner.signal,'source');
   await validateDownloadedVideoMedia(result.file,result.inspected.kind,result.project.media_duration,owner.signal);
   if(owner.signal.aborted||!store.getDocument(key)||sourceSignature(store.getDocument(key)!)!==before)throw Error('原稿已变化，原声未关联');
   store.setFile(key,result.file);store.setMedia(key,{url:URL.createObjectURL(result.file),kind:result.inspected.kind,name:result.file.name,identity:result.inspected.identity,availability:'local_session'});
  }catch(error){if(!owner.signal.aborted)setAttachmentError(error instanceof Error?error.message:String(error));}
  finally{if(attachment.current===owner){attachment.current=null;setAttaching(false);}}
 }
 const active=state.key===documentKey?state.job:null;
 return <details className="rw-resource-processing" aria-label="文字稿资源与整理">
  <summary>文字稿整理{active&&['queued','running','awaiting_media'].includes(active.state)?' · '+phaseLabel(active.phase):''}</summary>
  <p>复用已有字幕，按资源补齐标点与说话人；原文、笔记和时间定位保留。</p>
  <dl>{state.key===documentKey&&state.rows.map(row=><div key={row.kind} data-resource={row.kind} data-state={row.state}><dt>{labels[row.kind]}</dt><dd>{row.message}</dd></div>)}</dl>
  {active&&<p role="status">{phaseLabel(active.phase)}{active.error?'：'+active.error:''}</p>}
  <p role="status">{attachmentError||state.key===documentKey&&state.message}</p>
  {!media&&active?.media&&active.mediaIdentity&&<button type="button" onClick={()=>{const source=active.media!;store.setMedia(doc.key,{url:source.url,kind:source.kind,name:source.name,identity:active.mediaIdentity!,availability:'remote'});}}>重新载入任务原声</button>}
  {!media&&!active?.media&&state.capabilities?.sourceMedia&&typeof doc.source_url==='string'&&/^https:\/\/(?:www\.)?(?:bilibili\.com\/video\/|youtube\.com\/watch\?|youtu\.be\/)/.test(doc.source_url)&&<button type="button" disabled={attaching||state.busy} onClick={()=>void loadSource()}>{attaching?'正在载入对应原声…':'载入原声并继续整理'}</button>}
  {!file&&!active?.media&&<label className="rw-resource-file">{attaching?'正在核对原声…':'为这份文字稿补充对应原声'}<input type="file" accept="audio/*,video/*" disabled={attaching||state.busy} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void attach(file);}}/></label>}
  <button type="button" disabled={state.busy||attaching} onClick={()=>void controller.refresh(doc.key,{run:true})}>{active&&['failed','interrupted','cancelled'].includes(active.state)?'重试整理':'检查并继续整理'}</button>
  {active&&['queued','running','awaiting_media'].includes(active.state)&&<button type="button" disabled={state.busy} onClick={()=>void controller.cancel()}>取消整理</button>}
 </details>;
}
