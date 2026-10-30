import {Fragment,useEffect,useMemo,useRef,useState} from 'react';
import * as Editions from '../../reader/editions.js';
import type {ReaderDocument,ReaderMedia} from './contracts';
import {captureEditionSelection,time} from './domain';

export function EditionPicker({doc,value,disabled,onChange,onCreate}:{doc:ReaderDocument;value:string;disabled:boolean;onChange:(value:string)=>void;onCreate:()=>void}){
 const versions=Editions.state(doc).editions;
 return <div className="rw-edition-picker" aria-label="阅读版本">
  <label>阅读版本 <select value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}><option value="source">连续文字稿</option>{versions.map((edition,index)=><option key={edition.id} value={edition.id}>{edition.title} · {index+1}</option>)}</select></label>
  <button type="button" disabled={disabled||versions.length>=Editions.LIMITS.editions} onClick={onCreate}>创建编辑访谈稿</button>
 </div>;
}

export function EditionReader({doc,edition,media,busy,saveStatus,onSave,onDirtyChange,onSource,onListen}:{doc:ReaderDocument;edition:Editions.Edition;media:ReaderMedia|null;busy:boolean;saveStatus?:string;onSave:(next:ReaderDocument)=>Promise<boolean>;onDirtyChange:(dirty:boolean)=>void;onSource:(cueId:string)=>void;onListen:(start:number,end:number)=>void}){
 const resolve=useMemo(()=>Editions.resolver(doc,edition),[doc,edition]);
 const current=useMemo(()=>Editions.freshness(doc,edition)==='current',[doc,edition]);
 const [draft,setDraft]=useState<{blockId:string;heading:string;text:string;revision:number}|null>(null),[message,setMessage]=useState(''),[query,setQuery]=useState('');
 const [selection,setSelection]=useState<ReturnType<typeof captureEditionSelection>>(null),[download,setDownload]=useState<{url:string;name:string}|null>(null);
 const host=useRef<HTMLDivElement|null>(null),link=useRef<HTMLAnchorElement|null>(null);
 const pendingEdit=useRef<{revision:number;blockId:string;heading:string;text:string}|null>(null);
 const canListen=current&&!!media&&(!edition.media_identity||edition.media_identity===media.identity);
 const blocks=useMemo(()=>{const q=query.trim().toLocaleLowerCase();return q?edition.blocks.filter(block=>(block.heading+'\n'+Editions.blockText(block)).toLocaleLowerCase().includes(q)):edition.blocks;},[query,edition]);
 useEffect(()=>{onDirtyChange(!!draft);return()=>onDirtyChange(false);},[!!draft,onDirtyChange]);
 useEffect(()=>{setSelection(null);},[doc,edition,query]);
 useEffect(()=>{
  const pending=pendingEdit.current,block=pending&&edition.blocks.find(block=>block.id===pending.blockId);
  if(saveStatus!=='saved'||!pending||edition.revision!==pending.revision||!block||block.heading!==pending.heading||Editions.blockText(block)!==pending.text)return;
  pendingEdit.current=null;
  setDraft(draft=>!draft?null:draft.text===pending.text&&draft.heading.trim()===pending.heading?null:{...draft,revision:edition.revision});
  setMessage('编辑稿保存已确认。');
 },[edition,saveStatus]);
 useEffect(()=>{if(!download)return;link.current?.click();return()=>{const url=download.url;window.setTimeout(()=>URL.revokeObjectURL(url),60000);};},[download]);
 useEffect(()=>{const position=Editions.state(doc).position;if(position?.edition_id===edition.id)host.current?.querySelector<HTMLElement>('[data-edition-section="'+CSS.escape(position.block_id)+'"]')?.scrollIntoView?.({block:'center'});},[]);
 async function saveDraft(){
  if(!draft)return;
  try{const next=Editions.edit(doc,edition.id,draft.blockId,{heading:draft.heading,text:draft.text},draft.revision),saved=next.reading_editions!.editions.find(item=>item.id===edition.id)!;
   pendingEdit.current={revision:saved.revision,blockId:draft.blockId,heading:draft.heading.trim(),text:Editions.blockText(saved.blocks.find(block=>block.id===draft.blockId)!)};
   if(await onSave(next)){pendingEdit.current=null;setDraft(null);setMessage('编辑稿已保存，来源文字保留。');}else setMessage('编辑稿尚未确认保存，草稿仍保留；可重试项目保存或复制草稿。');}
  catch(error){setMessage(error instanceof Error?error.message:String(error));}
 }
 async function saveExcerpt(){
  if(!selection)return;
  try{const next=Editions.excerpt(doc,edition.id,selection.blockId,selection.from,selection.to,{id:crypto.randomUUID(),createdAt:new Date().toISOString(),expectedText:selection.blockText});if(await onSave(next)){setSelection(null);setMessage('已保存编辑稿摘录，附带原文依据。');}else setMessage('摘录尚未确认保存，请检查项目保存状态。');}
  catch(error){setMessage(error instanceof Error?error.message:String(error));}
 }
 const excerpts=Editions.state(doc).excerpts.filter(item=>item.edition_id===edition.id);
 return <section className="rw-edition-reader" aria-label="编辑访谈稿">
  <p className="rw-edition-notice" role="note">人工编辑草稿 · 保留完整来源范围。创建时按发言组织原文，尚未自动润色；可逐段整理正文与主题小标题。</p>
  <p className="rw-edition-freshness" role="status">{current?'来源依据一致；整理后的文字不作为逐字原话。':'来源文字、人物或时间已变化。这份历史稿及其原文依据保留，当前原文跳转与回听已停用。'}</p>
  {current&&media&&!canListen&&<p>原声已更换，历史稿的回听已停用。</p>}
  <div className="rw-toolbar"><label>查找编辑稿 <input type="search" value={query} disabled={!!draft} onChange={event=>setQuery(event.target.value)}/></label><button type="button" disabled={!!draft||busy} onClick={()=>{try{setDownload({url:URL.createObjectURL(new Blob([Editions.markdown(doc,edition.id)],{type:'text/markdown;charset=utf-8'})),name:doc.title.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_')+'-interview.md'});}catch(error){setMessage(String(error));}}}>导出编辑稿 Markdown</button></div>
  {edition.blocks.some(block=>block.heading)&&<nav className="rw-edition-chapters" aria-label="编辑稿章节">{edition.blocks.filter(block=>block.heading).map(block=><button type="button" key={block.id} disabled={!!draft} onClick={()=>{setQuery('');requestAnimationFrame(()=>host.current?.querySelector<HTMLElement>('[data-edition-section="'+CSS.escape(block.id)+'"]')?.scrollIntoView?.({block:'start'}));}}>{block.heading}</button>)}</nav>}
  <div ref={host} onMouseUp={()=>setSelection(captureEditionSelection(host.current!,edition.blocks,window.getSelection()))} onKeyUp={event=>{if(!event.nativeEvent.isComposing&&['Shift','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))setSelection(captureEditionSelection(host.current!,edition.blocks,window.getSelection()));}}>
   {blocks.map(block=>{const evidence=resolve(block);return <section key={block.id} className="rw-edition-block" data-edition-section={block.id}>
    {block.heading&&<h2>{block.heading}</h2>}
    <p className="rw-speaker-label">{evidence.speaker||'未标注'}</p>
    {draft?.blockId===block.id?<div className="rw-edition-edit"><label>主题小标题 <input value={draft.heading} maxLength={500} disabled={busy} onChange={event=>setDraft({...draft,heading:event.target.value})}/></label><label>整理正文 <textarea value={draft.text} maxLength={100000} disabled={busy} onChange={event=>setDraft({...draft,text:event.target.value})}/></label><button type="button" disabled={busy} onClick={()=>void saveDraft()}>保存本段编辑</button><button type="button" disabled={busy} onClick={()=>{pendingEdit.current=null;setDraft(null);}}>取消本段编辑</button></div>
     :<div className="rw-edition-text" data-edition-block-id={block.id} tabIndex={0}>{block.paragraphs.map((text,index)=><Fragment key={index}>{index?'\n\n':''}<p>{text}</p></Fragment>)}</div>}
    <div className="rw-toolbar"><button type="button" disabled={busy||!!draft} onClick={()=>{setSelection(null);setDraft({blockId:block.id,heading:block.heading,text:Editions.blockText(block),revision:edition.revision});}}>编辑本段</button><button type="button" disabled={busy||!!draft} onClick={()=>void onSave(Editions.bookmark(doc,edition.id,block.id))}>读到这里</button></div>
    <details className="rw-edition-evidence"><summary>核对来源 · {evidence.cues.length} 个原片段</summary><p>以下是创建这份稿件时保存的原文依据，回听以完整原片段为边界。</p>{evidence.ranges.map((range,index)=><span className="rw-toolbar" key={index}>{canListen&&<button type="button" onClick={()=>onListen(range.start,range.end)}>回听来源 {time(range.start)}–{time(range.end)}</button>}</span>)}{current&&<button type="button" disabled={!!draft} onClick={()=>onSource(block.source_refs[0])}>打开对应原话</button>}{evidence.cues.map(cue=><p key={cue.id}><small>{time(cue.start)} · {cue.speaker||'未标注'}</small><br/>{cue.text}</p>)}</details>
   </section>;})}
  </div>
  {!blocks.length&&<p>编辑稿中没有匹配的内容。</p>}
  {selection&&!draft&&<aside className="rw-edition-selection" aria-label="编辑稿选中文字操作"><p>{selection.text}</p><button type="button" disabled={busy} onClick={()=>void saveExcerpt()}>保存编辑稿摘录</button><button type="button" onClick={()=>setSelection(null)}>关闭选文操作</button></aside>}
  {excerpts.length>0&&<details className="rw-edition-excerpts"><summary>编辑稿摘录 · {excerpts.length}</summary>{excerpts.map(item=>{const block=edition.blocks.find(block=>block.id===item.block_id);return <section key={item.id}><p>{item.text}</p><small>整理稿摘录 · {block&&Editions.blockText(block)===item.block_text?'正文一致':'正文已更新，摘录保留历史文字'} · {current?'来源一致':'历史来源'}</small></section>;})}</details>}
  <a hidden ref={link} href={download?.url} download={download?.name}>下载编辑稿</a><p role="status">{message}</p>
 </section>;
}
