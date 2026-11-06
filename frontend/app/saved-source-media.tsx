import {useEffect,useState} from 'react';
import type {AppStore} from './store';
import {restoreSourceMedia} from './source-media';
export function SavedSourceMedia({store,documentKey}:{store:AppStore;documentKey:string}){
 const media=store.getMedia(documentKey);
 const [error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 useEffect(()=>{const changed=()=>setAttempt(value=>value+1);window.addEventListener('coconut-client-changed',changed);return()=>window.removeEventListener('coconut-client-changed',changed);},[]);
 useEffect(()=>{if(!(window as any).CoconutClientCapabilities?.allows('sourceMedia')){setError('');return;}const controller=new AbortController();setError('');void restoreSourceMedia(store,documentKey,controller.signal).catch(error=>{if(!controller.signal.aborted)setError(error instanceof Error?error.message:'已保存原声暂时无法读取。');});return()=>controller.abort();},[store,documentKey,attempt,media?.identity]);
 if(media?.availability==='local_session'&&!media.nativeToken&&(window as any).CoconutClientCapabilities?.allows('sourceMedia'))return <p className="source-media-session-notice">此原声仅在本次打开期间可用。</p>;
 return error?<section role="status"><p>{error}</p><button onClick={()=>setAttempt(value=>value+1)}>重试读取已保存原声</button></section>:null;
}
