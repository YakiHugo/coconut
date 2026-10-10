/* Gate classic reader scripts on a complete storage snapshot. No dynamic code or network data. */
(() => {
 'use strict';
 const panel=document.getElementById('storage-startup'),message=document.getElementById('storage-startup-message');
 const retry=document.getElementById('storage-startup-retry'),rescue=document.getElementById('storage-startup-export');
 const recovery=document.getElementById('storage-startup-recovery');
 const shell=document.querySelector('.shell'),scripts=[...document.querySelectorAll('script[data-reader-script]')];
 const boot={phase:'loading',result:null};window.CoconutStorageBootstrap=boot;
 shell.inert=true;
 const reasons={blocked:'另一个窗口阻止了文档数据库升级。请关闭其他 Coconut 页面后重试。',
  'open-timeout':'打开文档数据库超时。请关闭其他 Coconut 页面，再重试。',
  version:'文档数据库版本已经改变。请刷新页面，或使用更新的 Coconut 版本。',
  corruption:'原有书架无法完整核验。原数据仍保留，请先导出原始数据备份。',
  'legacy-changed':'旧版页面修改了原书架。两份存储均保留，请先导出原始数据，再关闭旧版页面重试。',
  fenced:'本机已有存储升级标记，暂时不能退回兼容存储。请使用支持此数据库的浏览器或更新版本重试。',
  quota:'没有足够空间完成书架升级。原书架未删除，请先导出原始数据，再释放浏览器空间后重试。',
  denied:'浏览器禁止访问文档存储。请检查此站点的存储权限后重试。',
  unavailable:'文档数据库暂时不可用。请重试；原数据仍保留。'};
 // Startup owns no edits or model work. A native close cancels further script
 // admission, then awaits actual migration abort/commit before approving exit.
 let startupOwner=null,retiredThrough=0,latestAttempt=0;
 const valid=request=>request&&request.kind==='close'&&Number.isSafeInteger(request.id)&&request.id>retiredThrough&&request.id>=latestAttempt&&request.expiresAt>Date.now();
 function startupClose(mode='inspect',request){
  if(mode==='inspect')return {safe:boot.phase==='failed',flushable:true,readiness:boot.phase,
   contentPending:0,contentFailed:false,nonContentReasons:[],reasons:boot.phase==='failed'?[]:[message.textContent]};
  if(mode==='release'){
   if(!request||request.kind!=='close'||request.id!==startupOwner?.id)return false;
   retiredThrough=Math.max(retiredThrough,request.id);startupOwner=null;
   retry.hidden=false;boot.phase='failed';message.textContent='书架载入已暂停。原始数据仍保留，可以重试。';return true;
  }
  if(!['safe','discard'].includes(mode)||!valid(request))return false;
  latestAttempt=request.id;
  if(startupOwner)return startupOwner.id===request.id?startupOwner.completion:false;
  const owner={id:request.id,completion:null};startupOwner=owner;
  owner.completion=(async()=>{
   boot.controller?.abort();
   try{await scriptPending;}catch{}
   await boot.storage?.shutdown();
   if(startupOwner!==owner||request.id<=retiredThrough||request.expiresAt<=Date.now())return false;
   boot.phase='closed';return true;
  })();return owner.completion;
 }
 // updates.js installs its real hooks while its script is still admitted by
 // startup. Keep release/timeout routed to the startup owner until the whole
 // bootstrap is ready; a late script must not steal that ownership interval.
 let applicationClose=null,applicationUpdate=null;
 const close=(mode='inspect',request)=>{
  if(boot.phase!=='ready'||!applicationClose)return startupClose(mode,request);
  if(request?.id<=retiredThrough)return mode==='inspect'?null:false;
  return applicationClose(mode,request);
 };
 const update=(lock=false,request)=>boot.phase==='ready'&&applicationUpdate&&!(request?.id<=retiredThrough)?applicationUpdate(lock,request):false;
 Object.defineProperty(window,'coconutPrepareClose',{configurable:true,get:()=>close,set:hook=>{applicationClose=hook;}});
 Object.defineProperty(window,'coconutPrepareUpdate',{configurable:true,get:()=>update,set:hook=>{applicationUpdate=hook;}});
 function downloadRaw(){
  const raw=boot.result?.legacyRaw;
  if(typeof raw!=='string')return;
  let url,link;
  try{
   // Blob text uses Unicode scalar conversion. Preserve even literal lone
   // UTF-16 surrogates in damaged/hand-edited legacy data with a JSON envelope.
   const wellFormed=typeof raw.isWellFormed==='function'?raw.isWellFormed():new TextDecoder().decode(new TextEncoder().encode(raw))===raw;
   const content=wellFormed?raw:JSON.stringify({format:'coconut-original-storage',version:1,encoding:'json-string',raw});
   const blob=new Blob([content],{type:'application/json'});url=URL.createObjectURL(blob);link=document.createElement('a');
   link.href=url;link.download=wellFormed?'coconut-original-local-storage.json':'coconut-original-storage-recovery.json';link.hidden=true;document.body.append(link);link.click();
   const text=wellFormed?'已发起原始数据下载，请打开文件确认。这是未经改写的旧存储数据，请保留；下载不会修复或确认保存。':'原始数据含特殊字符，已发起无损封装下载；原始字符完整保存在 raw 字段中，请保留供恢复使用，不能直接作为书架备份导入。';
   document.getElementById('storage-recovery-hint').textContent=text;
   if(boot.phase==='ready')window.dispatchEvent(new CustomEvent('coconut-storage-export',{detail:{text}}));
  }catch{document.getElementById('storage-recovery-hint').textContent='原始数据下载失败，请重试。原数据仍保留。';}
  finally{link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),60000);}
 }
 // Application records are JSON data. Arbitrary structured-clone corruption
 // may not be: reject lossy JSON projection rather than report a complete rescue.
 function recoveryJSON(value){
  const seen=new Set();
  const check=value=>{
   if(value===null||typeof value==='string'||typeof value==='boolean')return;
   if(typeof value==='number'&&Number.isFinite(value)&&!Object.is(value,-0))return;
   if(typeof value!=='object'||seen.has(value))throw new Error('完整存储含无法无损表示为 JSON 的记录。未导出不完整文件；请保留浏览器数据，使用专门恢复工具处理。');
   if(!Array.isArray(value)&&Object.prototype.toString.call(value)!=='[object Object]'||Reflect.ownKeys(value).some(key=>typeof key!=='string'))throw new Error('完整存储含无法无损表示为 JSON 的记录。未导出不完整文件；请保留浏览器数据，使用专门恢复工具处理。');
   if(Array.isArray(value)&&(Object.keys(value).length!==value.length||Object.keys(value).some((key,index)=>key!==String(index))))throw new Error('完整存储含无法无损表示为 JSON 的记录。未导出不完整文件；请保留浏览器数据，使用专门恢复工具处理。');
   seen.add(value);for(const child of Object.values(value))check(child);seen.delete(value);
  };
  check(value);return JSON.stringify(value);
 }
 recovery.onclick=()=>{
  if(!boot.result?.recovery)return;let url,link;
  try{url=URL.createObjectURL(new Blob([recoveryJSON(boot.result.recovery)],{type:'application/json'}));link=document.createElement('a');link.href=url;link.download='coconut-storage-recovery.json';link.hidden=true;document.body.append(link);link.click();document.getElementById('storage-recovery-hint').textContent='已发起完整存储恢复文件下载。包含原始数据和所有数据库记录，请保留供恢复使用；这不是普通书架备份，不能直接导入。';}
  catch(error){document.getElementById('storage-recovery-hint').textContent=error.message||'完整存储导出失败，请重试；原数据仍保留。';}
  finally{link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),60000);}
 };
 rescue.onclick=downloadRaw;
 document.getElementById('export-original-storage').onclick=downloadRaw;
 function scriptReady(marker){
  return new Promise((resolve,reject)=>{
   const script=document.createElement('script');script.src=marker.src;script.async=false;
   const error=event=>{if(event.filename===script.src){cleanup();reject(new Error('阅读器脚本启动失败，请刷新页面重试。'));}};
   const cleanup=()=>window.removeEventListener('error',error);
   window.addEventListener('error',error);
   script.onload=()=>{cleanup();resolve();};script.onerror=()=>{cleanup();reject(new Error('阅读器资源加载失败，请检查连接后刷新重试。'));};
   document.head.append(script);
  });
 }
 let loading=false,scriptsStarted=false,scriptPending=null;
 async function start(){
  if(loading||startupOwner)return;loading=true;boot.controller=new AbortController();boot.storage=null;boot.phase='loading';retry.hidden=true;rescue.hidden=true;recovery.hidden=true;message.textContent='正在打开本机书架并核验原始数据…';
  try{
   const result=await CoconutStorageProvider.initialize({validate:Coconut.validate,signal:boot.controller.signal,onStorage:storage=>{boot.storage=storage;},onLifecycle:event=>{
    if(event.state==='open')message.textContent='正在载入书架；首次升级会保留完整原始数据，请稍候…';
   }});
   if(boot.controller.signal.aborted)return;
   boot.result=result;
   if(!result.ok)throw result.error;
   message.textContent='书架已载入，正在准备阅读器…';scriptsStarted=true;
   for(const marker of scripts){if(boot.controller.signal.aborted)return;scriptPending=scriptReady(marker);await scriptPending;}
   scriptPending=null;if(boot.controller.signal.aborted)return;
   boot.phase='ready';panel.hidden=true;shell.inert=false;document.body.dataset.storageBackend=result.backend;
   const original=document.getElementById('export-original-storage');original.hidden=typeof result.legacyRaw!=='string';
   const mode=document.getElementById('storage-backend-hint');mode.textContent=result.backend==='indexeddb'?
    '文档分开保存到本机数据库。原始旧书架仍保留，不自动清理；原始数据下载供恢复使用，不能作为普通书架备份直接导入。':'当前使用兼容存储，容量较小；保存失败时请导出完整备份。';
   mode.hidden=false;
   window.dispatchEvent(new CustomEvent('coconut-storage-ready',{detail:{backend:result.backend,migrated:result.migrated===true}}));
  }catch(error){
   if(boot.controller.signal.aborted)return;
   boot.phase='failed';message.textContent=reasons[error?.code]||error?.message||'书架暂时无法载入。原数据仍保留，请重试。';
   panel.dataset.state='failed';retry.hidden=false;retry.textContent=scriptsStarted?'刷新并重试':'重试载入';
   rescue.hidden=typeof boot.result?.legacyRaw!=='string';recovery.hidden=!boot.result?.recovery;
  }finally{loading=false;}
 }
 retry.onclick=()=>{if(scriptsStarted)location.reload();else void start();};
 void start();
})();
