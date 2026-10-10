/** One main-process owner for final native close and update installation. */
export function createLifecycleOwnership({timeoutMs=8000,now=Date.now}={}) {
 let nextId=0,generation=0,owner=null;
 const current=attempt=>!!attempt&&!attempt.retired&&(owner===attempt||(!owner&&attempt.generation===generation));
 const retire=attempt=>{if(!attempt)return;attempt.retired=true;if(owner===attempt)owner=null;};
 return {
  begin(kind){return {id:++nextId,kind,generation,retired:false};},
  current,
  busy:()=>!!owner,
  owns:attempt=>owner===attempt&&!attempt.retired,
  claim(attempt){
   if(!current(attempt))return false;
   if(owner===attempt)return true;
   owner=attempt;generation++;return true;
  },
  retire,
  async call(attempt,operation){
   if(!current(attempt))throw new Error('关闭或安装操作已取消，请重试。');
   // A queued renderer call can execute after its main-process timeout. The
   // renderer checks this deadline before any final lock or cancellation.
   const request={id:attempt.id,kind:attempt.kind,expiresAt:now()+timeoutMs};let timer;
   try{
    const result=await Promise.race([Promise.resolve().then(()=>{if(!current(attempt))throw new Error('关闭或安装操作已取消，请重试。');return operation(request);}),new Promise((_,reject)=>{
     timer=setTimeout(()=>{retire(attempt);reject(new Error('阅读器未能及时确认保存状态'));},timeoutMs);
    })]);
    if(now()>=request.expiresAt)throw new Error('阅读器未能及时确认保存状态');
    if(!current(attempt))throw new Error('关闭或安装操作已取消，请重试。');
    return result;
   }catch(error){retire(attempt);throw error;}
   finally{clearTimeout(timer);}
  }
 };
}

/** One decision for window close and application quit. No teardown before approval. */
export function createCloseCoordinator({inspect,confirm,commit,finish,release=()=>{},onError=()=>{},timeoutMs=8000,lifecycle=createLifecycleOwnership({timeoutMs})}) {
 let pending=null,approved=false;
 return {
  request(){
   if(approved)return Promise.resolve(true);
   if(pending)return pending;
   const attempt=lifecycle.begin('close');
   // An update owns only its final install/quit interval, never its download
   // or staging. It will finish the same quit path without another question.
   if(!lifecycle.claim(attempt))return Promise.resolve(false);
   pending=(async()=>{
    let released=false;
    const abandon=async()=>{lifecycle.retire(attempt);if(!released){released=true;try{await release(attempt);}catch{}}};
    try{
     let snapshot=await lifecycle.call(attempt,inspect);
     if(!snapshot||typeof snapshot.safe!=='boolean')throw new Error('无法确认阅读器保存状态');
     let locked=false;
     if(snapshot.safe||snapshot.flushable===true)locked=await lifecycle.call(attempt,request=>commit('safe',request));
     if(!locked){
      // A late import/result may have changed the state since the first read.
      snapshot=await lifecycle.call(attempt,inspect);
      if(!snapshot||typeof snapshot.safe!=='boolean')throw new Error('无法确认阅读器保存状态');
      if(!await confirm(snapshot))return false;
      locked=await lifecycle.call(attempt,request=>commit('discard',request));
     }
     if(locked!==true||!lifecycle.owns(attempt))throw new Error('阅读器尚未准备好关闭');
     await finish(attempt);
     if(!lifecycle.owns(attempt))throw new Error('关闭操作已取消，请重试。');
     approved=true;return true;
    }catch(error){await abandon();try{await onError(error);}catch{}return false;}
    finally{if(!approved)await abandon();pending=null;}
   })();
   return pending;
  }
 };
}
