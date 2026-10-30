import {useEffect,useState,useSyncExternalStore} from 'react';
import * as Editions from '../../reader/editions.js';
import * as Interview from '../../reader/interview.js';
import {createInterviewController} from './interview-controller';
import type {AppStore} from './store';
const labels:Record<string,string>={queued:'排队中',running:'生成中',succeeded:'已完成，待接收',failed:'失败，可明确续跑',interrupted:'中断，可明确续跑',cancel_requested:'正在取消',cancelled:'已取消'};
export function InterviewPanel({store,documentKey}:{store:AppStore;documentKey:string}){
 const runtime=window as any;
 const [controller]=useState(()=>createInterviewController({store,access:runtime.CoconutClientCapabilities,client:runtime.CoconutTasks.createClient(),engine:Interview,uuid:()=>crypto.randomUUID()}));
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot),app=useSyncExternalStore(store.subscribe,store.getSnapshot),doc=store.getDocument(documentKey);
 const sourceSignature=doc?.segments.length?JSON.stringify(Editions.snapshot(doc)):'';
 const [provider,setProvider]=useState<'codex'|'claude'>('codex'),[model,setModel]=useState(''),[consent,setConsent]=useState(false);
 useEffect(()=>setConsent(false),[sourceSignature]);
 useEffect(()=>{const changed=()=>{controller.changed();setConsent(false);};window.addEventListener('coconut-client-changed',changed);return()=>{window.removeEventListener('coconut-client-changed',changed);controller.dispose();};},[controller]);
 useEffect(()=>{store.setActivity('interview',state.busy?'正在核对或保存编辑访谈任务':null);return()=>store.setActivity('interview',null);},[store,state.busy]);
 const jobs=doc?Editions.state(doc).jobs||[]:[];
 const watching=Object.values(state.tasks).some(t=>['queued','running','cancel_requested'].includes(t.status));
 useEffect(()=>{if(!watching||state.busy)return;const timer=setTimeout(()=>void controller.refresh(documentKey),4000);return()=>clearTimeout(timer);},[watching,state,controller,documentKey]);
 if(!doc?.segments.length)return null;
 let notice='';try{notice=Interview.notice(Interview.plan(doc));}catch(e){notice=e instanceof Error?e.message:String(e);}
 const run=(action:()=>Promise<void>)=>{setConsent(false);void action();};
 const blocked=state.busy||app.dirty||app.save.status!=='saved';
 return <details className="rw-interview-generation" aria-label="生成编辑访谈稿"><summary>生成编辑访谈稿{watching?' · 后台处理中':''}</summary><p>连续文字稿保留原话顺序与时间；编辑访谈稿整理口语、自然段与主题小标题，保留问答和原文依据。</p><p role="note">{notice}</p><div className="rw-toolbar"><label>编辑提供商 <select value={provider} disabled={blocked} onChange={e=>{setProvider(e.target.value as typeof provider);setConsent(false);}}><option value="codex">Codex</option><option value="claude">Claude</option></select></label><label>编辑模型 <input value={model} maxLength={120} disabled={blocked} placeholder="留空使用提供商默认" onChange={e=>{setModel(e.target.value);setConsent(false);}}/></label><button disabled={blocked} onClick={()=>{setConsent(false);void controller.refresh(documentKey);}}>检查编辑任务与连接</button></div><label><input type="checkbox" checked={consent} disabled={blocked} onChange={e=>setConsent(e.target.checked)}/>我确认上述范围与额度，允许离页后继续；重试与续跑可能再次使用额度</label><button disabled={blocked||!state.connected||!consent} onClick={()=>run(()=>controller.submit(documentKey,provider,model,consent))}>开始生成编辑访谈稿</button><p role="status">{state.message}</p>
 {jobs.map(j=>{const t=state.tasks[j.id],accepted=Editions.state(doc).editions.some(e=>e.id===j.id),bound=j.binding===runtime.CoconutClientCapabilities.identity();return <section key={j.id}><p>{j.provider}{j.model?' · '+j.model:''} · {accepted?'已接收为阅读版本':t?labels[t.status]||t.status:'提交状态待查询'}{t?` · ${t.progress.completed}/${t.progress.total} 批`:''}</p>{t?.error&&<p>{t.error.message}</p>}<p>此任务发送提交时冻结的 {Editions.state(doc).snapshots.find(s=>s.id===j.source_snapshot_id)?.source.cues.length||0} 个片段与原人物标签；续跑沿用 {j.provider}{j.model?' / '+j.model:' 默认模型'}，只复用已保存批次。{t?.resume?.outcomeUnknown?'上次在途请求的结果与额度未知，继续可能再次计费。':''}</p>{Editions.state(doc).snapshots.find(s=>s.id===j.source_snapshot_id)&&JSON.stringify(Editions.state(doc).snapshots.find(s=>s.id===j.source_snapshot_id)!.source)!==JSON.stringify(Editions.snapshot(doc))&&<p>当前原稿已变化；任务保留提交时来源，接收后显示为历史版本。</p>}{!bound?<p>此任务属于其他执行器连接，保留冻结来源。</p>:<div className="rw-toolbar">{!t&&!j.cancel_requested&&<button disabled={blocked||!consent||!state.connected} onClick={()=>run(()=>controller.retry(documentKey,j.id,consent))}>确认重试提交（先查询原任务）</button>}{t?.resume?.eligible&&!j.cancel_requested&&<button disabled={blocked||!consent} onClick={()=>run(()=>controller.resume(documentKey,j.id,consent))}>确认续跑编辑任务（剩余 {t.resume.remainingRequests} 次）</button>}{t?.status==='succeeded'&&!accepted&&!j.cancel_requested&&<button disabled={blocked} onClick={()=>void controller.receive(documentKey,j.id)}>接收为新阅读版本</button>}{!accepted&&(!t||['queued','running','cancel_requested','failed','interrupted'].includes(t.status))&&<button disabled={blocked} onClick={()=>void controller.cancel(documentKey,j.id)}>取消此编辑任务</button>}</div>}</section>;})}
 </details>;
}
