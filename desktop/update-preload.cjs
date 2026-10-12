const {contextBridge,ipcRenderer,webUtils}=require('electron');
contextBridge.exposeInMainWorld('coconutUpdates',Object.freeze({
  state:()=>ipcRenderer.invoke('coconut:update','state'),
  check:()=>ipcRenderer.invoke('coconut:update','check'),
  download:()=>ipcRenderer.invoke('coconut:update','download'),
  cancel:()=>ipcRenderer.invoke('coconut:update','cancel'),
  install:()=>ipcRenderer.invoke('coconut:update','install'),
  developer:enabled=>ipcRenderer.invoke('coconut:update','developer',enabled),
  subscribe:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('coconut:update-state',listener);return()=>ipcRenderer.removeListener('coconut:update-state',listener);}
}));

// Only an actual user-selected File has a native path. Keep it inside the
// isolated preload/main bridge; the reader receives receipts and opaque URLs.
contextBridge.exposeInMainWorld('coconutLocalMedia',Object.freeze({
  remember:(owner,file,identity)=>{
    let path;try{path=webUtils.getPathForFile(file);}catch{return Promise.resolve({status:'unavailable'});}
    return path?ipcRenderer.invoke('coconut:local-media','remember',{owner,path,identity}):Promise.resolve({status:'unavailable'});
  },
  resolve:owner=>ipcRenderer.invoke('coconut:local-media','resolve',{owner}),
  forget:owner=>ipcRenderer.invoke('coconut:local-media','forget',{owner}),
  reconcile:owners=>ipcRenderer.invoke('coconut:local-media','reconcile',{owners}),
  release:token=>ipcRenderer.invoke('coconut:local-media','release',{token})
}));
