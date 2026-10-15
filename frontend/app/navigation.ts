import {useEffect,useRef} from 'react';
import type {AppStore} from './store';
import type {AppSnapshot} from './contracts';
const route=(state:AppSnapshot)=>state.workspace==='read'&&state.activeKey?'#read/'+encodeURIComponent(state.activeKey):'#'+state.workspace;
/** Browser history carries only a library key; never transcript/source text. */
export function useNavigation(store:AppStore,state:AppSnapshot){
 const established=useRef(false),applying=useRef(false),previous=useRef(route(state));
 useEffect(()=>{
  const apply=()=>{const current=store.getSnapshot(),hash=location.hash;
   if(current.dirty){history.replaceState(null,'',previous.current);store.setMessage('请先保存或取消编辑，再返回其他内容。');return;}
   applying.current=true;
   if(hash.startsWith('#read/')){let key='';try{key=decodeURIComponent(hash.slice(6));}catch{}if(!store.select(key)){store.navigate('library');}}
   else store.navigate(hash==='#library'?'library':'discover');
  };
  if(location.hash)apply();else history.replaceState(null,'',previous.current);
  window.addEventListener('popstate',apply);return()=>window.removeEventListener('popstate',apply);
 },[store]);
 useEffect(()=>{
  const next=route(state);if(!established.current){established.current=true;previous.current=next;return;}
  if(next!==previous.current){if(!applying.current)history.pushState(null,'',next);else if(location.hash!==next)history.replaceState(null,'',next);previous.current=next;
   const heading=window.document.querySelector<HTMLElement>('#main-content h1');heading?.setAttribute('tabindex','-1');heading?.focus({preventScroll:true});
  }
  applying.current=false;
 },[state.workspace,state.activeKey,store]);
}
