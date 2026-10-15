import type {CloseRequest} from '../native-media/close';
type Phase='loading'|'failed'|'admitting'|'ready'|'closed';
/** Preserve the mature startup close protocol without admitting the legacy renderer. */
export function installStartupLifecycle(host:Record<string,any>,deps:{abort:()=>void;settled:()=>Promise<unknown>;shutdown:()=>Promise<unknown>;onPaused:()=>void;now?:()=>number}){
 let phase:Phase='loading',busy=false,retired=0,latest=0,owner:{id:number;completion:Promise<boolean>}|null=null,applicationClose:any=null,applicationUpdate:any=null;
 const now=deps.now||Date.now,previousClose=Object.getOwnPropertyDescriptor(host,'coconutPrepareClose'),previousUpdate=Object.getOwnPropertyDescriptor(host,'coconutPrepareUpdate');
 const valid=(request?:CloseRequest)=>!!request&&request.kind==='close'&&Number.isSafeInteger(request.id)&&request.id>retired&&request.id>=latest&&Number.isFinite(request.expiresAt)&&request.expiresAt>now();
 function startupClose(mode='inspect',request?:CloseRequest):unknown{
  if(mode==='inspect')return {safe:phase==='failed'&&!busy,flushable:!busy&&phase!=='admitting',contentPending:0,contentFailed:false,nonContentReasons:busy?['书架存储操作尚未结束']:[],reasons:phase==='failed'&&!busy?[]:['正在核验完整书架，请等待操作结束。']};
  if(mode==='release'){if(!request||request.kind!=='close'||request.id!==owner?.id)return false;retired=Math.max(retired,request.id);owner=null;phase='failed';deps.onPaused();return true;}
  if(!['safe','discard'].includes(mode)||!valid(request)||busy||phase==='admitting'||phase==='closed')return false;
  latest=request!.id;if(owner)return owner.id===request!.id?owner.completion:false;
  const capture={id:request!.id,completion:Promise.resolve(false)};owner=capture;deps.abort();
  capture.completion=(async()=>{try{await deps.settled();await deps.shutdown();}catch{return false;}if(owner!==capture||capture.id<=retired||request!.expiresAt<=now())return false;phase='closed';return true;})();return capture.completion;
 }
 const close=(mode='inspect',request?:CloseRequest)=>{if(request&&request.id<=retired)return mode==='inspect'?null:false;return phase==='ready'&&applicationClose?applicationClose(mode,request):startupClose(mode,request);};
 const update=(lock=false,request?:CloseRequest)=>phase==='ready'&&applicationUpdate&&!(request&&request.id<=retired)?applicationUpdate(lock,request):false;
 Object.defineProperty(host,'coconutPrepareClose',{configurable:true,get:()=>close,set:hook=>{applicationClose=hook;if(phase==='admitting')phase='ready';}});
 Object.defineProperty(host,'coconutPrepareUpdate',{configurable:true,get:()=>update,set:hook=>{applicationUpdate=hook;}});
 return {admit(){if(owner||phase!=='loading')return false;phase=applicationClose?'ready':'admitting';return true;},failed(){if(!owner&&phase!=='closed')phase='failed';},setBusy(value:boolean){busy=value;},canAdmit:()=>!owner&&phase==='loading',canRenderFailure:()=>!owner&&phase!=='closed',dispose(){retired=Math.max(retired,latest);owner=null;if(previousClose)Object.defineProperty(host,'coconutPrepareClose',previousClose);else delete host.coconutPrepareClose;if(previousUpdate)Object.defineProperty(host,'coconutPrepareUpdate',previousUpdate);else delete host.coconutPrepareUpdate;}};
}
