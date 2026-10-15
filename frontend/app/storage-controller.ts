import type {AppStore} from './store';
export type StorageAction='begin'|'connect'|'resume'|'cancel';
export type StorageResult={ok:boolean;backend?:string;connected?:boolean;legacyRaw?:string;recovery?:unknown;error?:{code?:string;message?:string};canonical?:{marker:()=>Promise<any>;request:()=>Promise<any>;begin:()=>Promise<any>;connect:()=>Promise<any>;resume:()=>Promise<any>;cancel:()=>Promise<any>}};
export type RecoveryStorage={canonicalRecovery?:()=>Promise<any>;readRecovery?:()=>Promise<any>};
type Review={action:StorageAction;revision?:number;documents?:unknown;count:number};
export type StorageState={busy:boolean;locked:boolean;message:string;review:Review|null;marker:any;discovered:boolean;canConnect:boolean;receipt:unknown};
export function createStorageController({result,store,onRestart,onLockChange=()=>{},refreshAccess=async()=>{},allows=()=>true}:{result:StorageResult;store?:AppStore;onRestart:()=>void;onLockChange?:(locked:boolean)=>void;refreshAccess?:()=>Promise<unknown>;allows?:(capability:string)=>boolean}){
 let state:StorageState={busy:false,locked:!result.ok,message:result.error?.message||'',review:null,marker:null,discovered:false,canConnect:false,receipt:null};
 let live=true,sequence=0,barrier:unknown=null;const listeners=new Set<()=>void>();
 const publish=(patch:Partial<StorageState>)=>{state={...state,...patch};if(live){onLockChange(state.locked);for(const listener of listeners)listener();}};
 const release=()=>{if(barrier){store?.releaseBarrier(barrier);barrier=null;}};
 const failure=(error:unknown)=>error instanceof Error?error.message:'操作未完成。原始数据仍保留，请重试或导出恢复文件。';
 async function inspect(){if(state.busy||!result.canonical)return;const ticket=++sequence;publish({busy:true});try{const marker=await result.canonical.marker();if(!live||ticket!==sequence)return;publish({marker,locked:!!marker&&result.backend!=='canonical'||marker?.state==='frozen'||!result.ok});}catch(error){if(live&&ticket===sequence)publish({locked:true,message:failure(error)});}finally{if(live&&ticket===sequence)publish({busy:false});}}
 async function discover(){if(state.busy||!result.canonical)return;const ticket=++sequence;publish({busy:true,message:'正在检查电脑书架…'});try{await refreshAccess();const server=await result.canonical.request();if(!live||ticket!==sequence)return;publish({discovered:true,canConnect:server.enabled&&server.binding?.protocolVersion===1,message:server.enabled?'电脑书架服务已连接。连接已有书架不会合并两份内容。':'电脑统一书架服务未启用；当前书架保持不变。'});}catch(error){if(live&&ticket===sequence)publish({canConnect:false,message:failure(error)});}finally{if(live&&ticket===sequence)publish({busy:false});}}
 function review(action:StorageAction){if(state.busy||!result.canonical)return;store?.setActivity('storage-review','正在确认书架存储操作');const snapshot=store?.getSnapshot();publish({review:{action,revision:snapshot?.revision,documents:snapshot?.documents,count:snapshot?.documents.length||0},message:''});}
 function dismiss(){if(!state.busy){store?.setActivity('storage-review',null);publish({review:null});}}
 async function confirm(){const capture=state.review;if(state.busy||!capture||!result.canonical)return;const ticket=++sequence;publish({busy:true,message:'正在核验存储并等待确认回执；请勿清除浏览器数据。'});
  try{
   await refreshAccess();if(!live||ticket!==sequence)return;
   if(!allows(capture.action==='connect'?'libraryWrite':'libraryMigration'))throw Error('当前连接不支持此操作。首次迁移和迁移管理请在电脑本机进行。');
   store?.setActivity('storage-review',null);
   if(store&&['begin','connect'].includes(capture.action)){
    if(store.getSnapshot().revision!==capture.revision)throw Error('书架在预览后发生变化，请重新检查并确认。');
    const before=store.closeSnapshot();if(!before.flushable)throw Error(before.reasons.join('；')||'请先完成当前操作。');
    barrier=store.acquireBarrier('canonical-storage-'+ticket);if(!barrier)throw Error('书架正由其他保存或关闭操作占用，请稍后重试。');
    publish({locked:true});const saved=await store.flush(barrier);
    if(!live||ticket!==sequence)return;
    if(!saved.ok||!store.barrierActive(barrier)||!store.closeSnapshot().safe||store.getSnapshot().documents!==capture.documents)throw Error('保存尚未完整确认或书架已变化；请重试，未开始迁移。');
   }else publish({locked:true});
   if(!live||ticket!==sequence)return;
   store?.setActivity('storage-transfer','书架迁移或连接正在等待最终回执');
   const response=await result.canonical[capture.action]();
   if(!response?.ok)throw Error(response?.error?.message||'操作尚未确认。');
   // No navigation or UI updates from an obsolete/unmounted owner. The
   // canonical protocol alone decides whether a durable transfer committed.
   if(!live||ticket!==sequence)return;
   publish({review:null,receipt:response.receipt||null,message:response.state==='cancelled'?'取消已经确认，正在重新载入浏览器书架。':'完整回执已核验，正在重新载入书架。'});onRestart();
  }catch(error){
   let marker:any;let known=false;try{marker=await result.canonical.marker();known=true;}catch{}
   if(known&&!marker)release();
   if(live&&ticket===sequence)publish({marker,locked:!known||!!marker||!result.ok,review:null,message:failure(error)});
  }finally{store?.setActivity('storage-review',null);store?.setActivity('storage-transfer',null);if(live&&ticket===sequence)publish({busy:false});}
 }
 return {getSnapshot:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},inspect,discover,review,dismiss,confirm,dispose(){store?.setActivity('storage-review',null);live=false;++sequence;listeners.clear();/* Never release a possibly frozen authority during an outstanding request. */if(!state.busy&&!state.locked)release();}};
}
// Refuse JSON projections that would silently discard damaged structured-clone
// data. The raw legacy string has a separate UTF-16-preserving envelope.
export function recoveryJSON(value:unknown):string{
 const seen=new Set<object>();function check(v:any):void{if(v===null||typeof v==='string'||typeof v==='boolean')return;if(typeof v==='number'&&Number.isFinite(v)&&!Object.is(v,-0))return;if(!v||typeof v!=='object'||seen.has(v)||!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)throw Error('存储含无法无损表示为 JSON 的记录。未导出不完整文件，请保留浏览器数据。');const keys=Reflect.ownKeys(v);if(keys.some(k=>typeof k!=='string'||!Object.getOwnPropertyDescriptor(v,k)?.enumerable&&!(Array.isArray(v)&&k==='length'))||Array.isArray(v)&&(Object.keys(v).length!==v.length||Object.keys(v).some((k,i)=>k!==String(i))))throw Error('存储记录不能无损导出，请保留浏览器数据。');seen.add(v);for(const key of Object.keys(v)){const d=Object.getOwnPropertyDescriptor(v,key)!;if(!('value'in d))throw Error('存储记录不能无损导出。');check(d.value);}seen.delete(v);}check(value);return JSON.stringify(value);
}
export function rawRecovery(raw:string){const wellFormed=new TextDecoder().decode(new TextEncoder().encode(raw))===raw;return {text:wellFormed?raw:JSON.stringify({format:'coconut-original-storage',version:1,encoding:'json-string',raw}),name:wellFormed?'coconut-original-local-storage.json':'coconut-original-storage-recovery.json'};}
