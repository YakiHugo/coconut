/** One decision for window close and application quit. No teardown before approval. */
export function createCloseCoordinator({inspect,confirm,commit,finish,onError=()=>{},timeoutMs=8000}) {
 let pending=null,approved=false;
 async function bounded(operation){
  let timer;
  try{return await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('阅读器未能及时确认保存状态')),timeoutMs);})]);}
  finally{clearTimeout(timer);}
 }
 return {
  request(){
   if(approved)return Promise.resolve(true);
   if(pending)return pending;
   pending=(async()=>{
    try{
     let snapshot=await bounded(inspect);
     if(!snapshot||typeof snapshot.safe!=='boolean')throw new Error('无法确认阅读器保存状态');
     let locked=false;
     if(snapshot.safe)locked=await bounded(()=>commit('safe'));
     if(!locked){
      // A late import/result may have changed the state since the first read.
      snapshot=await bounded(inspect);
      if(!snapshot||typeof snapshot.safe!=='boolean')throw new Error('无法确认阅读器保存状态');
      if(!await confirm(snapshot))return false;
      locked=await bounded(()=>commit('discard'));
     }
     if(locked!==true)throw new Error('阅读器尚未准备好关闭');
     await finish();approved=true;return true;
    }catch(error){try{await onError(error);}catch{}return false;}
    finally{pending=null;}
   })();
   return pending;
  }
 };
}
