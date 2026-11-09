import type {AppStore} from './store';
// @ts-expect-error shared CommonJS contract is also used by the Node service.
import {sourceMediaIdentity} from '@coconut/shared/source-media.js';
type Receipt={protocolVersion:1;binding:string;sha256:string;size:number;type:string;name:string;kind:'audio'|'video'};
const hex=/^[a-f0-9]{64}$/;
function receipt(value:unknown):Receipt{const r=value as Receipt;if(r?.protocolVersion!==1||!hex.test(r.binding)||!hex.test(r.sha256)||!Number.isSafeInteger(r.size)||r.size<1||r.size>200*1024*1024||!['audio','video'].includes(r.kind)||typeof r.type!=='string'||!r.type.startsWith(r.kind+'/')||typeof r.name!=='string'||r.name.length>300)throw Error('已保存媒体的回执无效。');return r;}
function attach(store:AppStore,key:string,media:Receipt){store.setMedia(key,{url:'api/v1/source-media/content?'+new URLSearchParams({key,binding:media.binding,sha256:media.sha256}),kind:media.kind,name:media.name,identity:'source-media-sha256:'+media.sha256,availability:'remote'});}
async function sha256(text:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');}
/** Successful completion means both document and bytes have durable receipts. */
export async function saveSourceMedia(store:AppStore,key:string,file:File,signal:AbortSignal):Promise<void>{
 const doc=store.getDocument(key);if(!doc||signal.aborted)throw Error('来源已关闭，媒体未保存。');const source=sourceMediaIdentity(doc),activity='source-media-save:'+key,previousMedia=store.getMedia(key),previousFile=store.getFile(key),controller=new AbortController();
 const changed=()=>store.getDocument(key)!==doc||store.getMedia(key)!==previousMedia||store.getFile(key)!==previousFile,abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});const unsubscribe=store.subscribe(()=>{if(changed())abort();});store.setActivity(activity,'原声正在保存到电脑书架');
 try{const saved=await store.flush();if(!saved.ok)throw Error('来源内容尚未保存，原声未写入。');if(controller.signal.aborted||changed()||sourceMediaIdentity(store.getDocument(key))!==source)throw Error('来源已变化，媒体未保存。');
 const sourceHash=await sha256(source);if(controller.signal.aborted||changed())throw Error('来源已变化，媒体未保存。');
 const response=await fetch('api/v1/source-media?'+new URLSearchParams({key,source:sourceHash,name:file.name}),{method:'POST',headers:{'Content-Type':file.type},body:file,signal:controller.signal});const data=await response.json();if(!response.ok)throw Error(typeof data.error==='string'?data.error:'原声尚未保存，请重试。');const media=receipt(data.media);
 if(controller.signal.aborted||changed())throw Error('来源已变化；已保存原声未附加到当前页面，请重新打开来源。');unsubscribe();store.setFile(key,file);attach(store,key,media);
 }finally{unsubscribe();signal.removeEventListener('abort',abort);store.setActivity(activity,null);}
}
/** Reads only the local saved receipt; never re-fetches provider media or starts ASR. */
export async function restoreSourceMedia(store:AppStore,key:string,signal:AbortSignal,replaceIdentity?:string):Promise<boolean>{
 const doc=store.getDocument(key),previousFile=store.getFile(key),previousMedia=store.getMedia(key);if(!doc||signal.aborted||previousMedia&&(previousMedia.identity!==replaceIdentity||!replaceIdentity||previousMedia.url.startsWith('blob:')))return false;
 const response=await fetch('api/v1/source-media?'+new URLSearchParams({key,source:await sha256(sourceMediaIdentity(doc))}),{signal});if(response.status===404)return false;
 const data=await response.json();if(!response.ok)throw Error(typeof data.error==='string'?data.error:'已保存原声暂时无法读取。');const media=receipt(data.media);
 if(signal.aborted||store.getDocument(key)!==doc||store.getMedia(key)!==previousMedia||store.getFile(key)!==previousFile)return false;if(previousMedia?.identity!=='source-media-sha256:'+media.sha256)attach(store,key,media);return true;
}
