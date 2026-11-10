import {useEffect,useRef,useState} from 'react';
import type {AppStore} from './store';
import {signature,createProjection} from '@coconut/reader/disfluency.js';
type Job={id:string;documentKey:string;state:string;phase:string;provider:string;model:string;error?:string};
type ReadingPlan=NonNullable<ReturnType<AppStore['getDocument']>>['reading_cleanup'];
const live=(job:Job|null)=>!!job&&['queued','running'].includes(job.state);
const labels:Record<string,string>={queued:'等待整理',running:'正在整理',ready:'整理完成，等待保存',applied:'整理结果已保存',failed:'整理未完成',interrupted:'整理已中断',cancelled:'整理已取消'};
const phases:Record<string,string>={rules:'口语规则',boundaries:'停顿与断句',fallback:'疑难片段',validate:'核对来源'};
async function api(route:string,body?:unknown){const response=await fetch('/api/v1/clean-reading/'+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
 const value=await response.json();if(!response.ok)throw Error(typeof value.error==='string'?value.error:'阅读整理未完成');return value;}
export function CleanReadingPanel({store,documentKey}:{store:AppStore;documentKey:string}){
 const [fallback,setFallback]=useState(false),[model,setModel]=useState(''),[job,setJob]=useState<Job|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[activated,setActivated]=useState<string|null>(null),[loading,setLoading]=useState(false),[summary,setSummary]=useState<{edits?:number;marks?:number;breaks?:number;llmCalls?:number;issues?:number}|null>(null);
 const host=useRef<HTMLElement>(null),generation=useRef(0),owner=useRef(documentKey),applying=useRef(false);owner.current=documentKey;
 const snapshot=store.getSnapshot(),doc=store.getDocument(documentKey),blocked=snapshot.dirty||snapshot.save.unsaved>0;
 useEffect(()=>{if(typeof IntersectionObserver==='undefined'||!host.current)return;const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){setActivated(documentKey);observer.disconnect();}});observer.observe(host.current);return()=>observer.disconnect();},[documentKey]);
 useEffect(()=>{const request=++generation.current;setJob(null);setSummary(null);setMessage('');setFallback(false);setBusy(false);
  if(activated!==documentKey)return;setLoading(true);
  void Promise.all([api('capabilities'),api('jobs?key='+encodeURIComponent(documentKey))]).then(([,result])=>{if(request===generation.current)setJob(result.jobs?.[0]||null);}).catch(error=>{if(request===generation.current)setMessage(error.message);}).finally(()=>{if(request===generation.current)setLoading(false);});
  return()=>{generation.current++;};
 },[documentKey,activated]);
 useEffect(()=>{if(!job||job.documentKey!==documentKey||!live(job))return;const request=generation.current,timer=setTimeout(()=>void api('jobs/'+job.id).then(value=>{if(request===generation.current)setJob(value.job);}).catch(error=>{if(request===generation.current)setMessage(error.message);}),1200);return()=>clearTimeout(timer);},[job,documentKey]);
 async function apply(){
  if(!job||job.documentKey!==documentKey||!['ready','applied'].includes(job.state)||applying.current||blocked)return;
  const request=generation.current,active=job;applying.current=true;
  try{
   const output=(await api('jobs/'+active.id+'/result')).job;if(request!==generation.current)return;
   const plan=output.reading_cleanup;
   setSummary({...plan.stats,issues:plan.issues?.length||0});
   if(active.state==='applied')return;
   const current=store.getDocument(documentKey);if(!current||store.getSnapshot().dirty||store.getSnapshot().save.unsaved>0)return;
   if(signature(current)!==output.sourceSignature)throw Error('原文、时间或人物已变化，未应用旧结果');
   createProjection(current,{decisions:plan.decisions,marks:plan.marks||[],breaks:plan.breaks||[],policyVersion:plan.policyVersion,sourceSignature:plan.sourceSignature});
   if(JSON.stringify(current.reading_cleanup)!==JSON.stringify(plan)&&!await store.commitDocument({...current,reading_cleanup:plan as ReadingPlan},{key:documentKey,revision:store.getRevision(documentKey)}))throw Error('整理结果尚未确认保存，请先处理保存状态');
   if(request!==generation.current)return;const saved=await api('jobs/'+active.id+'/apply',{protocolVersion:1});if(request===generation.current)setJob(saved.job);
  }catch(error){if(request===generation.current)setMessage(error instanceof Error?error.message:String(error));}
  finally{applying.current=false;}
 }
 useEffect(()=>{if(job&&['ready','applied'].includes(job.state)&&!blocked)void apply();},[job,blocked,documentKey]);
 if(!doc?.segments.length)return null;
 async function start(){const request=generation.current;setBusy(true);setMessage('');try{
  const current=store.getDocument(documentKey);if(!current||store.getSnapshot().dirty||store.getSnapshot().save.unsaved>0)throw Error('请先保存当前编辑');
  const result=await api('jobs',{protocolVersion:1,operation_id:crypto.randomUUID(),key:documentKey,source_signature:signature(current),fallback,model:fallback?model:'',consent:fallback});
  if(request===generation.current){setJob(result.job);setSummary(null);}
 }catch(error){if(request===generation.current)setMessage(error instanceof Error?error.message:String(error));}finally{if(owner.current===documentKey)setBusy(false);}}
 async function action(verb:string){if(!job)return;const request=generation.current;setBusy(true);setMessage('');try{const result=await api('jobs/'+job.id+'/'+verb,{protocolVersion:1});if(request===generation.current)setJob(result.job);}catch(error){if(request===generation.current)setMessage(error instanceof Error?error.message:String(error));}finally{if(request===generation.current)setBusy(false);}}
 return <section ref={host} className="rw-clean-reading-panel" aria-label="口语与断句整理" onFocusCapture={()=>setActivated(documentKey)} onPointerEnter={()=>setActivated(documentKey)}>
  <h3>口语与断句整理</h3>
  <p>本地规则先处理，保留原稿与回听位置。</p>
  <label><input type="checkbox" checked={fallback} disabled={busy||loading||live(job)} onChange={event=>setFallback(event.target.checked)}/> 疑难片段使用 Codex CLI 兜底</label>
  {fallback&&<><p>仅发送限量疑难片段，最多覆盖原文 10%，使用 CLI 的连接与额度。</p><label>模型 <input value={model} maxLength={120} disabled={busy||live(job)} placeholder="使用 CLI 默认模型" onChange={event=>setModel(event.target.value)}/></label></>}
  {job&&<p role="status">{labels[job.state]||job.state}{live(job)&&phases[job.phase]?' · '+phases[job.phase]:''}{job.error?'：'+job.error:''}</p>}
  {summary&&<p>精简 {summary.edits||0} 处 · 标点 {summary.marks||0} 处 · 换行 {summary.breaks||0} 处 · LLM 请求 {summary.llmCalls||0} 次{summary.issues?` · ${summary.issues} 处待核对`:''}</p>}
  {message&&<p role="status">{message}</p>}
  <div className="rw-toolbar"><button type="button" disabled={busy||loading||live(job)||blocked} onClick={()=>void start()}>{busy?'正在提交…':'整理口语与断句'}</button>
   {job&&['failed','interrupted','cancelled'].includes(job.state)&&<button type="button" disabled={busy||blocked} onClick={()=>void action('retry')}>继续整理任务</button>}
   {job?.state==='ready'&&<button type="button" disabled={busy||blocked} onClick={()=>void apply()}>保存整理结果</button>}
   {live(job)&&<button type="button" disabled={busy} onClick={()=>void action('cancel')}>取消整理</button>}
  </div>
 </section>;
}
