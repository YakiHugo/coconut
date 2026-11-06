import {useEffect,useRef,useState} from 'react';
import type {AppStore} from './store';
import {signature,merge} from '@coconut/shared/transcript-review';
type Job={id:string;documentKey:string;state:string;phase:string;provider:string;model:string;error?:string};
type Issue={cue_id:string;reason:string;proposal?:{original:string;replacement:string}};
const live=(job:Job|null)=>!!job&&['queued','running'].includes(job.state);
const label:Record<string,string>={queued:'等待校对',running:'正在校对',ready:'校对完成，等待保存',applied:'校对稿已保存',failed:'校对失败',interrupted:'校对已中断',cancelled:'校对已取消'};
async function api(route:string,body?:unknown){const response=await fetch('/api/v1/transcript-review/'+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);const value=await response.json();if(!response.ok)throw Error(typeof value.error==='string'?value.error:'校对请求未完成');return value;}
export function TranscriptReviewPanel({store,documentKey}:{store:AppStore;documentKey:string}){
 const [provider,setProvider]=useState('codex'),[model,setModel]=useState(''),[job,setJob]=useState<Job|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[issues,setIssues]=useState<Issue[]>([]),[page,setPage]=useState(0),[loading,setLoading]=useState(false),[activatedKey,setActivatedKey]=useState<string|null>(null);
 const generation=useRef(0),owner=useRef(documentKey),saving=useRef<number|null>(null),panel=useRef<HTMLElement>(null);owner.current=documentKey;
 const doc=store.getDocument(documentKey),dirty=store.getSnapshot().dirty,unsaved=store.getSnapshot().save.unsaved;
 useEffect(()=>{if(typeof IntersectionObserver==='undefined'||!panel.current)return;const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){setActivatedKey(documentKey);observer.disconnect();}});observer.observe(panel.current);return()=>observer.disconnect();},[documentKey]);
 useEffect(()=>{const request=++generation.current;setJob(null);setIssues([]);setMessage('');setPage(0);setBusy(false);
  if(activatedKey!==documentKey)return;
  setLoading(true);
  void Promise.all([api('capabilities'),api('jobs?key='+encodeURIComponent(documentKey))]).then(([caps,list])=>{if(request!==generation.current)return;const latest=list.jobs?.[0]||null;setProvider(latest?.provider||caps.defaultProvider||'codex');setModel(latest?.model||'');setJob(latest);}).catch(error=>{if(request===generation.current)setMessage(error.message);}).finally(()=>{if(request===generation.current)setLoading(false);});
  return()=>{generation.current++;};
 },[documentKey,activatedKey]);
 useEffect(()=>{if(!job||job.documentKey!==documentKey||!live(job))return;const request=generation.current;const timer=setTimeout(()=>{void api('jobs/'+job.id).then(value=>{if(request===generation.current)setJob(value.job);}).catch(error=>{if(request===generation.current)setMessage(error.message);});},1500);return()=>clearTimeout(timer);},[job,documentKey]);
 useEffect(()=>{
  if(!job||job.documentKey!==documentKey||!['ready','applied'].includes(job.state)||dirty||unsaved||saving.current===generation.current)return;
  const request=generation.current,active=job;saving.current=request;
  void (async()=>{
   const value=await api('jobs/'+active.id+'/result');if(request!==generation.current)return;
   const output=value.job;setIssues(output.result?.transcript_review?.issues||[]);
   if(active.state==='applied')return;
   const current=store.getDocument(documentKey);if(!current||store.getSnapshot().dirty||store.getSnapshot().save.unsaved)return;
   const prior=current.transcript_review as {job_id?:string}|undefined;
   if(prior?.job_id!==active.id){const next=merge(current,output.input,output.results,{provider:active.provider,model:active.model,jobId:active.id});if(!await store.commitDocument(next,{key:documentKey,revision:store.getRevision(documentKey)}))throw Error('校对稿尚未确认保存，请先处理保存状态');}
   if(request!==generation.current)return;
   const saved=await api('jobs/'+active.id+'/apply',{protocolVersion:1});if(request!==generation.current)return;
   setJob(saved.job);setMessage('校对稿已保存。');
  })().catch(error=>{if(request===generation.current)setMessage(error.message);}).finally(()=>{if(saving.current===request)saving.current=null;});
 },[job,documentKey,dirty,unsaved,store]);
 if(!doc?.segments.length)return null;
 async function start(){const key=documentKey,request=generation.current;setBusy(true);setMessage('');try{
  const current=store.getDocument(key);if(!current||store.getSnapshot().dirty||store.getSnapshot().save.unsaved)throw Error('请先保存当前编辑，再校对');
  const value=await api('jobs',{protocolVersion:1,operation_id:crypto.randomUUID(),key,provider,model,consent:true,source_signature:signature(current)});if(request===generation.current){setJob(value.job);setIssues([]);}
 }catch(error){if(request===generation.current)setMessage(error instanceof Error?error.message:String(error));}finally{if(owner.current===key)setBusy(false);}}
 async function action(verb:string){if(!job)return;const request=generation.current;setBusy(true);try{const value=await api('jobs/'+job.id+'/'+verb,{protocolVersion:1,consent:true});if(request===generation.current)setJob(value.job);}catch(error){if(request===generation.current)setMessage(error instanceof Error?error.message:String(error));}finally{if(request===generation.current)setBusy(false);}}
 const pending=doc.transcript_review as {state?:string;error?:string;issues?:Issue[];changes?:unknown[]}|undefined;
 const shown=issues.length?issues:pending?.issues||[];
 const time=(id:string)=>{const t=Math.floor(doc.segments.find(c=>c.id===id)?.start||0);return String(Math.floor(t/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0');};
 return <section ref={panel} className="rw-review-panel" aria-label="AI 校对文字稿" onFocusCapture={()=>setActivatedKey(documentKey)} onPointerEnter={()=>setActivatedKey(documentKey)}>
  <h3>AI 校对文字稿</h3>
  <p>发送文字与节目资料到所选 CLI，校对错字、人名、术语和标点。</p>
  <fieldset disabled={busy||loading||live(job)}><legend>校对提供商</legend>{[['codex','Codex CLI'],['kimi','Kimi CLI']].map(([id,name])=><label key={id}><input type="radio" name={'review-provider-'+documentKey} value={id} checked={provider===id} onChange={()=>setProvider(id)}/>{name} </label>)}</fieldset>
  <label>模型 <input type="text" value={model} maxLength={120} disabled={busy||loading||live(job)} placeholder="使用 CLI 默认模型" onChange={event=>setModel(event.target.value)}/></label>
  {job&&<p role="status">{label[job.state]||job.state}{job.phase.startsWith('review:')?' · 第 '+job.phase.slice(7)+' 批':''}{job.error?'：'+job.error:''}</p>}
  {!job&&pending?.state==='pending'&&<p role="status">转录已完成，AI 校对待继续。{pending.error||''}</p>}
  {message&&<p role="status">{message}</p>}
  <button type="button" disabled={busy||loading||live(job)||dirty||!!unsaved} onClick={()=>void start()}>{busy?'正在提交…':'开始全文校对'}</button>
  {job&&['failed','interrupted','cancelled'].includes(job.state)&&<button type="button" disabled={busy||dirty||!!unsaved} onClick={()=>void action('retry')}>继续原校对任务</button>}
  {live(job)&&<button type="button" disabled={busy} onClick={()=>void action('cancel')}>取消校对</button>}
  {shown.length>0&&<div><h4>待核对 · {shown.length} 处</h4><ol start={page*10+1}>{shown.slice(page*10,page*10+10).map((issue,i)=><li key={i}><strong>{time(issue.cue_id)}</strong> {issue.reason}{issue.proposal&&<p>原词：{issue.proposal.original}；建议：{issue.proposal.replacement}</p>}</li>)}</ol>{shown.length>10&&<nav aria-label="校对疑点分页"><button type="button" disabled={page===0} onClick={()=>setPage(p=>p-1)}>上一页</button><span> {page+1} / {Math.ceil(shown.length/10)} </span><button type="button" disabled={(page+1)*10>=shown.length} onClick={()=>setPage(p=>p+1)}>下一页</button></nav>}</div>}
 </section>;
}
