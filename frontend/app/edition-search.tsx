import {useEffect,useState} from 'react';
import * as Editions from '../../reader/editions.js';
import type {Document} from './contracts';
type Hit={document:Document;edition:Editions.Edition;blockId:string;kind:string;text:string};
/** Cooperative, separately scoped index: editorial prose never enters source hits. */
export function EditionSearch({documents,query,onOpen}:{documents:readonly Document[];query:string;onOpen:(doc:Document,editionId:string,blockId:string)=>void}){
 const [state,setState]=useState<{pending:boolean;hits:Hit[];total:number}>({pending:true,hits:[],total:0}),[limit,setLimit]=useState(100);
 useEffect(()=>{let cancelled=false,timer:ReturnType<typeof setTimeout>;setState({pending:true,hits:[],total:0});setLimit(100);const needle=query.trim().toLocaleLowerCase(),hits:Hit[]=[];let total=0;
  function* scan(){for(const doc of documents){const state=Editions.state(doc);for(const edition of state.editions){
   const add=(blockId:string,kind:string,text:string)=>{if(needle&&!text.toLocaleLowerCase().includes(needle))return;total++;if(hits.length<1000){const snippet=(window as any).Coconut.librarySnippet(text,query);hits.push({document:doc,edition,blockId,kind,text:snippet?snippet.before+snippet.match+snippet.after:text.slice(0,180)});}};
   if(!needle){add(edition.blocks[0].id,'阅读版本',edition.title+' · '+edition.blocks.length+' 段');yield;continue;}
   for(const block of edition.blocks){add(block.id,'编辑正文',block.heading+'\n'+Editions.blockText(block));yield;}
   for(const excerpt of state.excerpts.filter(e=>e.edition_id===edition.id)){add(excerpt.block_id,'历史摘录',excerpt.text);yield;}
   for(const answer of state.answers?.filter(a=>a.edition_id===edition.id)||[]){add(answer.block_id,'AI 记录',answer.question+'\n'+answer.answer);yield;}
  }}}
  const iterator=scan();const step=()=>{if(cancelled)return;let n=0;while(n++<16){if(iterator.next().done){setState({pending:false,hits,total});return;}}timer=setTimeout(step,0);};timer=setTimeout(step,0);return()=>{cancelled=true;clearTimeout(timer);};
 },[documents,query]);
 return <section className="edition-library-search" aria-label="编辑稿检索"><p>搜索编辑正文、主题小标题、编辑稿摘录与 AI 记录；每条结果打开对应阅读版本。</p>{state.pending?<p role="status">正在检索编辑稿…</p>:<><p role="status">{state.total} 条结果{state.total>1000?'，显示前 1,000 条，请缩小关键词':''}</p><ol>{state.hits.slice(0,limit).map((hit,i)=><li key={i}><p>{hit.document.title} · {hit.edition.title} · {hit.kind}</p><p>{hit.text}</p><button onClick={()=>onOpen(hit.document,hit.edition.id,hit.blockId)}>打开编辑稿来源</button></li>)}</ol>{limit<state.hits.length&&<button onClick={()=>setLimit(n=>n+100)}>显示更多编辑稿结果</button>}</>}</section>;
}
