/** Include durable tasks from every project in native close/update gates. */
export function sourceTaskLifecycleGuard(service){
 const current=request=>request&&Number.isInteger(request.id)&&request.expiresAt>Date.now();
 const active=()=>service?.activity().active||0;
 return {
  inspect(snapshot){const count=active();return count?{...snapshot,safe:false,flushable:false,reasons:[...(snapshot?.reasons||[]),`${count} 个来源下载、转录或对齐任务尚未完成；退出后需明确重试`]}:snapshot;},
  prepare(mode,request){
   if(!current(request)||service?.pause(request.id)===false)return false;
   if(mode!=='discard'&&active()>0){service?.resume(request.id);return false;}
   return true;
  },
  release(request){if(request)service?.resume(request.id);},
  idle:()=>active()===0,
 };
}
