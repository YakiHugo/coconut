import React, {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SelectionActions} from './selection-actions';
import type {NavigationPage, NavigationSession} from './contracts';

function Navigator() {
 const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null),time=useRef<HTMLInputElement>(null);
 const session=useRef<NavigationSession|null>(null);
 const [page,setPage]=useState<NavigationPage|null>(null),[available,setAvailable]=useState(false),[error,setError]=useState('');
 const close=(restore=true)=>{dialog.current?.close();session.current=null;setPage(null);setError('');if(restore)trigger.current?.focus({preventScroll:true});};
 useEffect(()=>{
  const update=()=>{setAvailable(Boolean(window.CoconutTranscriptNavigation?.available()));if(session.current&&!session.current.isCurrent())close(false);};
  update();window.addEventListener('coconut-render',update);window.addEventListener('coconut-navigation-ready',update);
  document.body.dataset.transcriptNavigation='ready';
  return ()=>{delete document.body.dataset.transcriptNavigation;window.removeEventListener('coconut-render',update);window.removeEventListener('coconut-navigation-ready',update);};
 },[]);
 const open=()=>{
  const next=window.CoconutTranscriptNavigation?.open();if(!next)return;
  session.current=next;setPage(next.read());setError('');dialog.current?.showModal();
 };
 const move=(next:number)=>{const value=session.current?.read(next);if(value){setPage(value);setError('');dialog.current?.querySelector<HTMLElement>('.navigator-results')?.focus();}else close(false);};
 const jump=(id:string)=>{const owner=session.current;if(!owner?.isCurrent()){close(false);return;}dialog.current?.close();if(owner.jump(id))close(false);else{dialog.current?.showModal();setError('原文已变化，请关闭后重新浏览。');}};
 const act=(kind:'search'|'chapters')=>{const owner=session.current;close();if(owner?.isCurrent())owner[kind]();};
 return <>
  <button ref={trigger} id="open-transcript-navigator" type="button" hidden={!available} aria-haspopup="dialog" aria-controls="transcript-navigator-dialog" onClick={open}>浏览全文 <span aria-hidden="true">↗</span></button>
  <dialog ref={dialog} id="transcript-navigator-dialog" className="transcript-navigator-dialog" aria-labelledby="transcript-navigator-title" onCancel={event=>{event.preventDefault();close();}}>
   <header><div><p className="eyebrow">原文导航</p><h2 id="transcript-navigator-title">浏览全文</h2></div><button type="button" onClick={()=>close()} aria-label="关闭原文导航">关闭</button></header>
   <p className="navigator-document">{page?.title}</p>
   <div className="navigator-tools"><button type="button" onClick={()=>act('search')}>查找文字</button><button type="button" onClick={()=>act('chapters')}>章节目录</button></div>
   <form onSubmit={event=>{event.preventDefault();const owner=session.current;if(!owner?.isCurrent()){close(false);return;}dialog.current?.close();if(owner.jumpTime(time.current?.value||''))close(false);else{dialog.current?.showModal();setError('请输入原文范围内的时间，例如 12:34 或 75 秒。');time.current?.focus();}}}>
    <label htmlFor="navigator-time">跳到时间</label><div className="navigator-time-entry"><input ref={time} id="navigator-time" placeholder="12:34 或秒数" autoComplete="off" aria-describedby="navigator-error"/><button type="submit">前往</button></div>
   </form>
   <p id="navigator-error" role="status" className="hint">{error}</p>
   <ol className="navigator-results" tabIndex={-1} aria-label="按时间排列的原文片段">{page?.cues.map(cue=><li key={cue.id}><button type="button" data-cue-id={cue.id} onClick={()=>jump(cue.id)} aria-current={cue.current?'location':undefined}><span className="navigator-time">{cue.time}</span><span>{cue.text||'（此片段没有文字）'}</span>{cue.current&&<span className="navigator-current">正在阅读</span>}</button></li>)}</ol>
   <footer><button type="button" disabled={!page||page.page===0} onClick={()=>move(page!.page-1)}>前面的原文</button><span role="status">{page?`${page.page+1} / ${page.pages} 页 · ${page.total} 段`:''}</span><button type="button" disabled={!page||page.page+1>=page.pages} onClick={()=>move(page!.page+1)}>后面的原文</button></footer>
   <p className="hint">定位只移动阅读位置，不播放声音，也不更改已存书签。</p>
  </dialog>
 </>;
}
const host=document.getElementById('transcript-navigator');
if(host)createRoot(host).render(<><Navigator/><SelectionActions/></>);
