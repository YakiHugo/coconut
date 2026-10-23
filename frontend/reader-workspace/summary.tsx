import {useEffect,useMemo,useRef,useState, type ReactNode} from 'react';
import type {ReaderCue,ReaderDocument} from './contracts';
import {time} from './domain';
type SummaryAnswer={answer:string;citations:string[];provider?:string;requested_model?:string;input_snapshot?:{segments:Array<{id:string;text:string}>};summary_process?:{batches?:number}};
type SummaryDomain={latestSummary:(doc:ReaderDocument)=>SummaryAnswer|null;summaryFreshness:(answer:SummaryAnswer,doc:ReaderDocument)=>string;summaryReadiness:(doc:ReaderDocument)=>{ready:boolean;reason?:string};summaryMarkdown:(doc:ReaderDocument,answer:SummaryAnswer)=>string};
export function ReaderSummary({doc,onNavigate,onReturn,onOpenSummary,selectedCueId,canListen=false,onListen}:{doc:ReaderDocument;onNavigate:(cueId:string)=>void;onReturn:()=>void;onOpenSummary?:()=>void;selectedCueId?:string;canListen?:boolean;onListen?:(cue:ReaderCue)=>void}){
 const core=(window as unknown as {Coconut:SummaryDomain}).Coconut,answer=core.latestSummary(doc),freshness=useMemo(()=>answer?core.summaryFreshness(answer,doc):'empty',[answer,doc]),readiness=useMemo(()=>core.summaryReadiness(doc),[doc]);
 const [download,setDownload]=useState<{url:string;name:string}|null>(null),[message,setMessage]=useState(''),link=useRef<HTMLAnchorElement>(null);
 const cues=useMemo(()=>new Map(doc.segments.map(cue=>[cue.id,cue])),[doc.segments]);
 useEffect(()=>{if(!download)return;link.current?.click();return()=>{const url=download.url;window.setTimeout(()=>URL.revokeObjectURL(url),60000);};},[download]);
 return <section className="rw-summary" aria-label="摘要阅读">
  <header className="rw-summary-heading"><span className="rw-eyebrow">内容摘要</span><h2>{answer?'先了解这段内容':'还没有保存的整篇摘要'}</h2><div><button onClick={onReturn}>继续阅读全文</button>{onOpenSummary&&<button onClick={onOpenSummary}>{doc.summary_job?'查看分批进度与 AI 记录':'查看 AI 计划与记录'}</button>}</div></header>
  {answer?<>
   <p className="rw-summary-freshness" role="status">{freshness==='current'?'覆盖当前整篇原文，模型结论仍需核对。':freshness==='stale'?'原文或整篇范围已经变化，这份历史摘要可能过期。':'缺少完整的原文依据，无法确认摘要覆盖范围。'}</p>
   <div className="rw-summary-body" tabIndex={0}><SummaryText text={answer.answer} citations={new Set(freshness==='current'?answer.citations:[])} onNavigate={onNavigate}/></div>
   <nav className="rw-summary-citations" aria-label="摘要引用"><h3>回到原话</h3><p>点击时间，前往文字稿中的对应位置。</p>{[...new Set(answer.citations||[])].map(id=>{
    const cue=cues.get(id);
    return cue&&freshness==='current'?<section key={id} className={'rw-summary-citation'+(selectedCueId===id?' rw-citation-current':'')} data-citation-id={id}>
     <div><button aria-current={selectedCueId===id?'location':undefined} onClick={()=>onNavigate(id)}>{time(cue.start)} · 核对原文</button>{canListen&&onListen&&<button className="rw-citation-listen" aria-label={'回听摘要引用 · '+time(cue.start)} onClick={()=>{onNavigate(id);onListen(cue);}}>▷ 回听</button>}</div>
     {cue.speaker&&<small>{cue.speaker}</small>}<p>{cue.text}</p>
    </section>:<p key={id}>引用 {id}：{cue?'当前原文依据未核实，请查看保存的历史原文。':'原片段已不存在，不能跳转到其他片段代替。'}</p>;
   })}{!answer.citations?.length&&<p>这份摘要没有片段引用，请自行回听核对。</p>}</nav>
   <details className="rw-summary-provenance"><summary>摘要来源与导出</summary><p>{answer.provider||'未知提供商'}{answer.requested_model?' · '+answer.requested_model:''}{answer.summary_process?.batches&&answer.summary_process.batches>1?' · '+answer.summary_process.batches+' 批后汇总':''}</p><button onClick={()=>{try{setDownload({url:URL.createObjectURL(new Blob([core.summaryMarkdown(doc,answer)],{type:'text/markdown;charset=utf-8'})),name:doc.title.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g,'_')+'-summary.md'});setMessage('已发起摘要下载，请确认文件已保存。');}catch{setMessage('摘要导出失败，记录仍保留。');}}}>导出这份摘要</button></details>
   <SummaryEvidence answer={answer}/>
  </>:<><p>这里仅显示真实保存的摘要，不会自动运行模型。</p>{doc.summary_job&&<p>有已保存的分批进度，整篇摘要尚未完成。继续前需要核对计划和确认。</p>}{!readiness.ready&&<p>{readiness.reason}</p>}</>}
  <a hidden ref={link} href={download?.url} download={download?.name}>下载摘要</a><p role="status">{message}</p>
 </section>;
}
// Only explicit, current source IDs become navigation controls. Model text is
// rendered as text; HTML, arbitrary links and guessed timestamp matches stay inert.
function SummaryText({text,citations,onNavigate}:{text:string;citations:Set<string>;onNavigate:(id:string)=>void}){
 const inline=(value:string):ReactNode[]=>value.split(/(\*\*[^*\n]+\*\*|\[[^\]\n]+\])/g).map((part,index)=>{
  if(part.startsWith('**')&&part.endsWith('**'))return <strong key={index}>{part.slice(2,-2)}</strong>;
  const id=part.slice(1,-1);
  return part.startsWith('[')&&citations.has(id)?<button key={index} className="rw-inline-citation" onClick={()=>onNavigate(id)} aria-label={'核对引用 '+id}>{part}</button>:part;
 });
 return <>{text.split(/\n\s*\n/).map((block,index)=>{
  const heading=block.match(/^#{1,4}\s+([^\n]+)$/);
  if(heading)return <h3 key={index}>{inline(heading[1])}</h3>;
  const lines=block.split('\n');
  if(lines.every(line=>/^\s*[-*]\s+/.test(line)))return <ul key={index}>{lines.map((line,i)=><li key={i}>{inline(line.replace(/^\s*[-*]\s+/,''))}</li>)}</ul>;
  return <p key={index} style={{whiteSpace:'pre-wrap'}}>{inline(block)}</p>;
 })}</>;
}
function SummaryEvidence({answer}:{answer:SummaryAnswer}){
 // Fresh disclosures prevent queued native toggle events from opening a
 // replacement answer. Historical evidence never substitutes the current draft.
 const [owner,setOwner]=useState({answer,generation:0});
 if(owner.answer!==answer){setOwner({answer,generation:owner.generation+1});return null;}
 return <SummaryEvidenceContent key={owner.generation} answer={answer}/>;
}
function SummaryEvidenceContent({answer}:{answer:SummaryAnswer}){
 const [open,setOpen]=useState(false),cues=answer.input_snapshot?.segments||[];
 return <details className="rw-summary-evidence" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>查看摘要生成时保存的原文依据</summary>{open&&(cues.length?<>
  <p>原文依据 · 共 {cues.length} 个片段 · 连续阅读</p>
  {cues.map((cue,index)=><section key={index} data-summary-evidence-id={cue.id}><small>片段 {cue.id}</small><p style={{whiteSpace:'pre-wrap'}}>{cue.text}</p></section>)}
 </>:<p>此记录未保存完整发送原文，不能用当前稿替代历史依据。</p>)}</details>;
}
