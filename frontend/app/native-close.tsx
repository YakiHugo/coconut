import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {useNativeClose} from '../native-media/close-hook';
import type {AppStore} from './store';
export function NativeClose({store}:{store:AppStore}){
 const [returned,setReturned]=useState(false),[recovery,setRecovery]=useState<{fields:{label:string,value:string}[];text:string}|null>(null);
 const finalized=useRef(false),retry=useRef<HTMLButtonElement>(null),[paused,setPaused]=useState(false);
 const [deps]=useState(()=>({snapshot:store.closeSnapshot,acquireBarrier:(id:number)=>store.acquireBarrier(String(id)),barrierActive:store.barrierActive,releaseBarrier:(token:unknown)=>{store.releaseBarrier(token);},flush:store.flush,discardPending:store.discardPending,lockUI:()=>{
  const root=document.getElementById('react-root');if(!root)return()=>{};
  const previous=root.inert;root.inert=true;
  return()=>{if(finalized.current){root.inert=true;root.hidden=true;setPaused(true);}else root.inert=previous;};
 },finish:()=>{if(finalized.current)return;finalized.current=true;window.dispatchEvent(new Event('pagehide'));},updateReady:()=>!finalized.current&&store.closeSnapshot().safe&&!document.querySelector('dialog[open]')&&![...document.querySelectorAll('audio,video')].some(player=>!(player as HTMLMediaElement).paused)}));
 useNativeClose(deps,!!(window as any).coconutUpdates);
 useEffect(()=>{const restore=(event:PageTransitionEvent)=>{if(!event.persisted)return;const root=document.getElementById('react-root');if(!root)return;setRecovery({fields:[...root.querySelectorAll<HTMLTextAreaElement|HTMLInputElement>('textarea,input[type=text],input[type=search],input[type=url],input[type=number],input:not([type])')].filter(field=>field.value).map(field=>({label:field.getAttribute('aria-label')||field.labels?.[0]?.textContent||'文本草稿',value:field.value})),text:root.textContent||''});root.inert=true;root.hidden=true;finalized.current=true;setReturned(true);setPaused(true);};window.addEventListener('pageshow',restore);return()=>window.removeEventListener('pageshow',restore);},[]);
 function downloadRecovery(){const url=URL.createObjectURL(new Blob([JSON.stringify({format:'coconut-page-recovery',version:1,documents:store.recoveryDocuments(),page:recovery},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='coconut-page-recovery.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
 useEffect(()=>{if(paused)retry.current?.focus();},[paused]);
 return paused?createPortal(<main className="startup native-close-recovery"><h1>阅读已安全暂停</h1><p>{returned?'浏览器恢复了已暂停的页面。请先复制或导出下方文本草稿，再重新载入；重新载入会结束本页未保存的编辑。':'关闭已取消。保存结果仍保留；重新载入后即可继续阅读和选择文件。'}</p>{returned&&<><button onClick={downloadRecovery}>导出页面恢复快照</button><p>恢复快照包含本页书架内容、文本与输入框草稿，不包含媒体；请妥善保留。此文件供人工恢复，不能作为完整书架备份直接导入。</p>{recovery?.fields.map((field,index)=><label key={index}>{field.label}<textarea readOnly value={field.value}/></label>)}</>}<button ref={retry} onClick={()=>location.reload()}>重新载入阅读器</button></main>,document.body):null;
}
