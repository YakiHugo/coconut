const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('coconutUpdates',Object.freeze({
  state:()=>ipcRenderer.invoke('coconut:update','state'),
  check:()=>ipcRenderer.invoke('coconut:update','check'),
  download:()=>ipcRenderer.invoke('coconut:update','download'),
  cancel:()=>ipcRenderer.invoke('coconut:update','cancel'),
  install:()=>ipcRenderer.invoke('coconut:update','install'),
  developer:enabled=>ipcRenderer.invoke('coconut:update','developer',enabled),
  subscribe:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('coconut:update-state',listener);return()=>ipcRenderer.removeListener('coconut:update-state',listener);}
}));
