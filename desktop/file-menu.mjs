/** Bounded native File and Find commands. No paths, credentials or new renderer privileges. */
export function createFileMenu({window,origin,blocked=()=>false,now=Date.now}) {
 let generation=0,ready=false;
 const live=()=>!window.isDestroyed()&&!window.webContents.isDestroyed();
 const trusted=()=>live()&&[origin+'/',origin+'/index.html'].includes(window.webContents.getURL());
 const commands=[['import-transcript','导入文字稿…','CmdOrCtrl+O'],
  ['open-local-media','打开本地音频或视频…','CmdOrCtrl+Shift+O'],
  ['backup-library','导出整个书架的完整备份…','CmdOrCtrl+Shift+S'],
  ['find-transcript','查找当前文字稿…','CmdOrCtrl+F']];
 const items=commands.map(([id,label,accelerator])=>({id,label,accelerator,enabled:false,click:async()=>{
  if(!ready||!trusted()||blocked()||window.webContents.isLoadingMainFrame())return false;
  const issuedAt=now();
  try{return await window.webContents.executeJavaScript(`typeof window.coconutFileCommand === 'function' && window.coconutFileCommand(${JSON.stringify(id)},${JSON.stringify({issuedAt,expiresAt:issuedAt+2000})})`,true);}
  catch{return false;} // A closed/crashed/navigating renderer must never be retried.
 }}));
 // Electron clones templates into MenuItems. Keep both the template and the
 // actual installed items in sync; no ready notification grants IPC privileges.
 let installed=null;
 const enable=value=>{ready=value;for(const item of items){item.enabled=value;const native=installed?.getMenuItemById(item.id);if(native)native.enabled=value;}};
 const invalidate=()=>{generation++;enable(false);};
 window.webContents.on('did-start-loading',invalidate);
 window.webContents.on('render-process-gone',invalidate);
 window.on('closed',invalidate);
 window.webContents.on('did-finish-load',async()=>{
  const current=generation;if(!trusted())return;
  try{
   const loaded=await window.webContents.executeJavaScript(`new Promise(resolve=>{
    if(window.CoconutStorageBootstrap?.phase==='ready'){resolve(true);return;}
    const done=()=>{cleanup();resolve(true);},closed=()=>{cleanup();resolve(false);};
    function cleanup(){window.removeEventListener('coconut-storage-ready',done);window.removeEventListener('pagehide',closed);}
    window.addEventListener('coconut-storage-ready',done,{once:true});window.addEventListener('pagehide',closed,{once:true});
   })`);
   if(loaded&&current===generation&&trusted()&&!window.webContents.isLoadingMainFrame())enable(true);
  }catch{} // Failed bootstrap keeps the commands disabled; recovery UI stays available.
 });
 return {id:'coconut-file-menu',label:'文件',submenu:items.slice(0,3),findItem:items[3],
  // Main binds the real menu after buildFromTemplate, before loading any page.
  bind:menu=>{installed=menu;enable(ready);}};
}
