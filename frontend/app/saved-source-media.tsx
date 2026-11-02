import {useEffect,useState} from 'react';
import type {AppStore} from './store';
import {restoreSourceMedia} from './source-media';
export function SavedSourceMedia({store,documentKey}:{store:AppStore;documentKey:string}){
 const media=store.getMedia(documentKey);
 const [error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 useEffect(()=>{const changed=()=>setAttempt(value=>value+1);window.addEventListener('coconut-client-changed',changed);return()=>window.removeEventListener('coconut-client-changed',changed);},[]);
 useEffect(()=>{if(!(window as any).CoconutClientCapabilities?.allows('sourceMedia')){setError('');return;}const controller=new AbortController();setError('');void restoreSourceMedia(store,documentKey,controller.signal).catch(error=>{if(!controller.signal.aborted)setError(error instanceof Error?error.message:'已保存原声暂时无法读取。');});return()=>controller.abort();},[store,documentKey,attempt,media?.identity]);
 if(media?.availability==='local_session'&&!media.nativeToken&&(window as any).CoconutClientCapabilities?.allows('sourceMedia'))return <p className="source-media-session-notice">当前原声是本页临时附件；重启不会保留这次选择，将按书架中已保存的来源恢复（若有）。</p>;
 return error?<section role="status"><p>{error} 原内容保留，不会自动重新下载。</p><button onClick={()=>setAttempt(value=>value+1)}>重试读取已保存原声</button></section>:null;
}
