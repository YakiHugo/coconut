import {useEffect,useRef,useState} from 'react';
import type {ReaderDocument} from './contracts';
import {time} from './domain';
type SummaryAnswer={answer:string;citations:string[];provider?:string;requested_model?:string;input_snapshot?:{segments:Array<{id:string;text:string}>};summary_process?:{batches?:number}};
type SummaryDomain={latestSummary:(doc:ReaderDocument)=>SummaryAnswer|null;summaryFreshness:(answer:SummaryAnswer,doc:ReaderDocument)=>string;summaryReadiness:(doc:ReaderDocument)=>{ready:boolean;reason?:string};summaryMarkdown:(doc:ReaderDocument,answer:SummaryAnswer)=>string};
export function ReaderSummary({doc,onNavigate,onReturn,onOpenSummary}:{doc:ReaderDocument;onNavigate:(cueId:string)=>void;onReturn:()=>void;onOpenSummary?:()=>void}){
 const core=(window as unknown as {Coconut:SummaryDomain}).Coconut,answer=core.latestSummary(doc),freshness=answer?core.summaryFreshness(answer,doc):'empty',readiness=core.summaryReadiness(doc);
 const [download,setDownload]=useState<{url:string;name:string}|null>(null),[message,setMessage]=useState(''),link=useRef<HTMLAnchorElement>(null);
 useEffect(()=>{if(!download)return;link.current?.click();return()=>{const url=download.url;window.setTimeout(()=>URL.revokeObjectURL(url),60000);};},[download]);
 return <section className="rw-summary" aria-label="摘要阅读"><header><h2>{answer?'这篇的主要内容':'还没有保存的整篇摘要'}</h2><button onClick={onReturn}>返回原阅读状态</button>{onOpenSummary&&<button onClick={onOpenSummary}>{doc.summary_job?'查看分批进度与 AI 记录':'查看 AI 计划与记录'}</button>}</header>{answer?<><p role="status">{freshness==='current'?'覆盖当前整篇原文，模型结论仍需核对。':freshness==='stale'?'原文或整篇范围已经变化，这份历史摘要可能过期。':'缺少完整的原文依据，无法确认摘要覆盖范围。'}</p><p className="rw-summary-body" tabIndex={0} style={{whiteSpace:'pre-wrap'}}>{answer.answer}</p><p>{answer.provider||'未知提供商'}{answer.requested_model?' · '+answer.requested_model:''}{answer.summary_process?.batches&&answer.summary_process.batches>1?' · '+answer.summary_process.batches+' 批后汇总':''}</p><nav aria-label="摘要引用">{[...new Set(answer.citations||[])].map(id=>{const cue=doc.segments.find(item=>item.id===id);return cue&&freshness==='current'?<button key={id} onClick={()=>onNavigate(id)}>{time(cue.start)} · 核对原文</button>:<p key={id}>引用 {id}：{cue?'当前原文依据未核实，请查看保存的历史原文。':'原片段已不存在，不能跳转到其他片段代替。'}</p>;})}{!answer.citations?.length&&<p>这份摘要没有片段引用，请自行回听核对。</p>}</nav><SummaryEvidence answer={answer}/><button onClick={()=>{try{setDownload({url:URL.createObjectURL(new Blob([core.summaryMarkdown(doc,answer)],{type:'text/markdown;charset=utf-8'})),name:doc.title.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g,'_')+'-summary.md'});setMessage('已发起摘要下载，请确认文件已保存。');}catch{setMessage('摘要导出失败，记录仍保留。');}}}>导出这份摘要</button></>:<><p>这里仅显示真实保存的摘要，不会自动运行模型。</p>{doc.summary_job&&<p>有已保存的分批进度，整篇摘要尚未完成。继续前需要核对计划和确认。</p>}{!readiness.ready&&<p>{readiness.reason}</p>}</>}<a hidden ref={link} href={download?.url} download={download?.name}>下载摘要</a><p role="status">{message}</p></section>;
}

const EVIDENCE_PAGE_SIZE=50;
function SummaryEvidence({answer}:{answer:SummaryAnswer}){
 // A fresh DOM disclosure owns each answer lifetime. Native toggle events can be
 // queued after the browser changes .open but before React observes that change.
 // Reusing that element could let a retired event open the replacement answer.
 const [owner,setOwner]=useState({answer,generation:0});
 if(owner.answer!==answer){setOwner({answer,generation:owner.generation+1});return null;}
 return <SummaryEvidencePage key={owner.generation} answer={answer}/>;
}
function SummaryEvidencePage({answer}:{answer:SummaryAnswer}){
 // Keep all historical evidence intact; only the mounted view is paged.
 const [view,setView]=useState({open:false,page:0});
 const {open}=view,cues=answer.input_snapshot?.segments||[];
 const lastPage=Math.max(0,Math.ceil(cues.length/EVIDENCE_PAGE_SIZE)-1),page=Math.min(view.page,lastPage);
 return <details open={open} onToggle={event=>{const expanded=event.currentTarget.open;setView(previous=>previous.open===expanded?previous:{...previous,open:expanded});}}><summary>查看摘要生成时保存的原文依据</summary>{open&&(cues.length?<>
 <p role="status">原文依据 · 第 {page+1} / {lastPage+1} 页 · 共 {cues.length} 个片段</p>
 <nav aria-label="摘要原文依据分页"><button disabled={page===0} onClick={()=>setView({open:true,page:page-1})}>上一页原文依据</button><button disabled={page===lastPage} onClick={()=>setView({open:true,page:page+1})}>下一页原文依据</button></nav>
 {cues.slice(page*EVIDENCE_PAGE_SIZE,(page+1)*EVIDENCE_PAGE_SIZE).map((cue,index)=><section key={page*EVIDENCE_PAGE_SIZE+index} data-summary-evidence-id={cue.id}><small>片段 {cue.id}</small><p style={{whiteSpace:'pre-wrap'}}>{cue.text}</p></section>)}
 </>:<p>此记录未保存完整发送原文，不能用当前稿替代历史依据。</p>)}</details>;
}
