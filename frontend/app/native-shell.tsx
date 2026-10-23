import {flushSync} from 'react-dom';
import {useNativeCommands} from '../native-shell/command-hook';
import {NativeUpdates} from '../native-shell/updates-panel';
import type {AppStore} from './store';
/** Commands activate React-owned controls synchronously in the native gesture. */
export function NativeShell({store}:{store:AppStore}){
 const bridge=(window as any).coconutUpdates;
 useNativeCommands({timeOrigin:performance.timeOrigin,ready:()=>!!window.document.querySelector('.react-app'),blocked:command=>{
  const app=window.document.querySelector('.react-app');
  if(!app||app.closest('[inert]')||window.document.body.inert||window.document.querySelector('dialog[open],[aria-modal="true"]'))return true;
  return !['backup-library','find-transcript'].includes(command)&&!!store.closeSnapshot().nonContentReasons.length;
 },run:command=>{
  if(command==='open-local-media'||command==='import-transcript')flushSync(()=>store.navigate('discover'));
  const target=window.document.querySelector<HTMLInputElement|HTMLButtonElement>('.react-app [data-native-command="'+command+'"]');
  if(!target||target.disabled||target.matches(':disabled')||target.closest('[inert]'))return false;
  if(command==='find-transcript'){if(target instanceof HTMLButtonElement)flushSync(()=>target.click());const search=window.document.querySelector<HTMLInputElement>('.reader-workspace input[type=search]');if(!search||search.closest('[hidden],[inert]'))return false;search.focus();search.select();return window.document.activeElement===search;}
  for(const details of [...window.document.querySelectorAll<HTMLDetailsElement>('.react-app details')].filter(node=>node.contains(target)&&!node.open))details.querySelector<HTMLElement>('summary')?.click();
  target.click();return command==='open-local-media'||command==='import-transcript'?store.closeSnapshot().nonContentReasons.length>0:true;
 }},!!bridge);
 return bridge?<NativeUpdates bridge={bridge}/>:null;
}
