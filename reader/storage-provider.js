(function(root){
 'use strict';
 const NAME='coconut-reader-library-v1',KEY='coconut-reader-v1',FENCE='coconut-reader-storage-fence-v1';
 const failure=(code,message)=>({ok:false,status:'failed',error:{code,message}});
 // Recovery is observational only. Never create a database, upgrade it, open a
 // readwrite transaction, initialize the old adapter, or alter a browser fence.
 async function browserRecovery({indexedDB,getStorage,name=NAME,openTimeoutMs=3000,summaryOnly=false}={}){
  let legacyRaw=null,fence=null,storageError=null;
  try{const storage=getStorage();legacyRaw=storage.getItem(KEY);fence=storage.getItem(FENCE);}catch{storageError='浏览器旧存储无法读取；请保留站点数据。';}
  const base={ok:true,format:'coconut-browser-recovery',version:1,database:name,legacyRaw,fence,stores:{}};
  if(!indexedDB)return {...base,warning:storageError};
  // Without enumeration, opening an unknown name could create a database.
  if(typeof indexedDB.databases!=='function')return {...base,warning:storageError||'无法只读检查旧浏览器数据库；请保留站点数据。'};
  try{
   let enumerationTimer;
   const databases=await Promise.race([indexedDB.databases(),new Promise((_,reject)=>{enumerationTimer=setTimeout(()=>reject(Error('旧浏览器数据库检查超时；请保留站点数据。')),openTimeoutMs);})]).finally(()=>clearTimeout(enumerationTimer));
   if(!databases.some(database=>database.name===name))return {...base,warning:storageError};
   if(summaryOnly)return {...base,hasDatabase:true,summaryOnly:true,warning:storageError};
   const stores=await new Promise((resolve,reject)=>{
    let db,settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);db?.close();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(Error('旧浏览器数据库暂时无法只读打开。')),openTimeoutMs);
    const request=indexedDB.open(name);
    request.onupgradeneeded=()=>{db=request.result;request.transaction.abort();finish(Error('旧数据库已变化；未创建或升级数据库。'));};
    request.onerror=()=>finish(request.error||Error('旧数据库不可读。'));
    request.onblocked=()=>finish(Error('旧数据库被其他窗口占用。'));
    request.onsuccess=()=>{
     db=request.result;if(settled){db.close();return;}db.onversionchange=()=>finish(Error('旧数据库已变化，请重新读取。'));
     const names=Array.from(db.objectStoreNames),snapshot={};if(!names.length){finish(null,snapshot);return;}
     let tx;try{tx=db.transaction(names,'readonly');}catch(error){finish(error);return;}
     for(const name of names){const store=tx.objectStore(name),keys=store.getAllKeys(),rows=store.getAll();let k,v;
      const collect=()=>{if(k&&v)snapshot[name]=k.map((key,index)=>({key,value:v[index]}));};
      keys.onsuccess=()=>{k=keys.result;collect();};rows.onsuccess=()=>{v=rows.result;collect();};
     }
     tx.oncomplete=()=>finish(null,snapshot);tx.onabort=()=>finish(tx.error||Error('旧数据库只读检查中断。'));tx.onerror=()=>{};
    };
   });return {...base,stores,warning:storageError};
  }catch(error){return {...base,warning:String(error?.message||error)};}
 }
 async function initialize({indexedDB,getStorage=()=>root.localStorage,validate,onStorage=()=>{},signal,name=NAME,openTimeoutMs}={}){
  if(signal?.aborted)return failure('cancelled','书架载入已暂停。');
  let browserAccessWarning=null;
  try{if(indexedDB===undefined)indexedDB=root.indexedDB;}catch{indexedDB=null;browserAccessWarning='浏览器旧数据库访问受限；请保留站点数据。';}
  // The browser snapshot is a recovery copy, never a candidate primary store.
  const readRecovery=()=>browserRecovery({indexedDB,getStorage,name,openTimeoutMs});
  const recovery=await browserRecovery({indexedDB,getStorage,name,openTimeoutMs,summaryOnly:true});
  const lifetime=new AbortController(),abort=()=>lifetime.abort();
  signal?.addEventListener('abort',abort,{once:true});
  const storage={readRecovery,shutdown:async()=>{lifetime.abort();}};onStorage(storage);
  const retained=typeof recovery.legacyRaw==='string'||recovery.fence!==null||recovery.hasDatabase===true||Object.keys(recovery.stores).length>0;
  const context={legacyRaw:recovery.legacyRaw,retainedBrowserData:retained,recoveryWarning:recovery.warning||browserAccessWarning||null,...(retained?{recovery}:{})};
  if(signal?.aborted||lifetime.signal.aborted){signal?.removeEventListener('abort',abort);return {...failure('cancelled','书架载入已暂停。'),...context};}
  try{
   const client=root.CoconutCanonicalLibrary?.create({validate,signal:lifetime.signal});
   if(!client)throw Error('电脑书架组件不可用，请修复安装后重试。');
   const result=await client.initializeServer();
   if(signal?.aborted||lifetime.signal.aborted){result.adapter.close();return {...failure('cancelled','书架载入已暂停。'),...context};}
   return {...result,...context};
  }catch(error){return {...failure(error.code||'library_unavailable',error.message||'电脑书架暂时不可用，请恢复服务后重试。'),...context};}finally{signal?.removeEventListener('abort',abort);}
 }
 const api={initialize,browserRecovery,NAME};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CoconutStorageProvider=api;
})(typeof window!=='undefined'?window:globalThis);
