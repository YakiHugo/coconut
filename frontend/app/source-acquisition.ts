import type {AppStore} from './store';
// @ts-expect-error Shared with the source-media service.
import {sourceMediaIdentity} from '@coconut/shared/source-media.js';
/** Start only acquisition, never ASR/review/translation. Server owns download lifetime. */
export async function acquireSourceAudio(store:AppStore,key:string,signal?:AbortSignal):Promise<void>{
 const client=(window as any).CoconutClientCapabilities;
 if(client?.allows('sourceJobs')!==true)throw Error('当前连接不支持持久保存原声，请连接本地服务后重试。');
 const identity=client.identity(),generation=client.generation,libraryId=client.current?.libraryId,doc=store.getDocument(key);
 if(!doc)throw Error('来源项目不存在。');
 const source=sourceMediaIdentity(doc),current=()=>!signal?.aborted&&client.allows('sourceJobs')===true&&client.identity()===identity&&client.generation===generation&&client.current?.libraryId===libraryId&&store.getDocument(key)&&sourceMediaIdentity(store.getDocument(key))===source;
 const saved=await store.flush();if(!saved.ok||!current())throw Error('原声未开始获取：来源或书架保存状态已变化。');
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source))),b=>b.toString(16).padStart(2,'0')).join('');
 if(!current())throw Error('原声未开始获取：连接或来源已变化。');
 const response=await fetch('api/v1/source-jobs',{method:'POST',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify({protocolVersion:1,libraryId,key,source:hash,operation_id:crypto.randomUUID(),kind:'download',consent:true})});
 const result=await response.json();if(!response.ok)throw Error(typeof result.error==='string'?result.error:'原声保存任务尚未确认，请在来源任务中核对。');
 if(!current())return;
 if(result.job?.documentKey!==key||result.job?.source!==hash||result.job?.kind!=='download')throw Error('原声任务回执身份不匹配，请查看原任务。');
}
