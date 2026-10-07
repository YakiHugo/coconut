/** Packaged macOS entry point. The renderer never receives Node, shell or credential access. */
import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge } from './server.mjs';
import { createCaptionHelper } from './caption-helper.mjs';
import { createCaptionService } from './caption-service.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 47831; // Stable origin preserves the local bookshelf between launches.
let server, window;
function ordinaryWebLink(value) {
  try { const url = new URL(value); return ['https:','http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on('second-instance',()=>{ if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',()=>server?.shutdown());
  app.whenReady().then(async()=>{
    const readerDirectory = app.isPackaged ? path.join(process.resourcesPath,'reader') : path.resolve(ROOT,'../reader');
    let captionService=null;
    if(app.isPackaged){
      const helper=createCaptionHelper({resourcesPath:process.resourcesPath});
      const status=await helper.status();
      if(status.ready)captionService=createCaptionService({helper,readerDirectory,enabledProviders:['x']});
    }
    server = await startBridge({port:PORT,readerDirectory,captionService});
    const origin = `http://127.0.0.1:${PORT}`;
    window = new BrowserWindow({width:1280,height:880,minWidth:780,minHeight:620,show:process.env.COCONUT_SMOKE_TEST !== '1',title:'Coconut',
      webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false}});
    window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    window.webContents.session.setPermissionCheckHandler(()=>false);
    window.webContents.on('will-attach-webview',event=>event.preventDefault());
    window.webContents.on('will-navigate',(event,url)=>{
      if (url !== origin+'/' && url !== origin+'/index.html') event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(({url})=>{
      // Only a normal web link is handed to the system browser. Never custom schemes or file paths.
      if (ordinaryWebLink(url)) void shell.openExternal(url);
      return {action:'deny'};
    });
    await window.loadURL(origin+'/');
    if (process.env.COCONUT_SMOKE_TEST === '1') {
      const result = await window.webContents.executeJavaScript(`(async()=>{
        const health=await (await fetch('/api/health')).json();
        return {reader:!!document.querySelector('#import'),
          scripts:typeof Coconut==='object',isolated:typeof require==='undefined'&&typeof process==='undefined',
          bridge:health.runtime==='desktop-bridge'&&health.capabilities.local_agents===true,
          pythonDisabled:health.capabilities.media_import===false};
      })()`);
      if (!Object.values(result).every(Boolean)) throw new Error('Desktop smoke test failed: '+JSON.stringify(result));
      console.log('Coconut desktop smoke passed: packaged reader, isolated renderer and zero-Python bridge');
      app.quit();
    }
  }).catch(error=>{
    const message = error.code === 'EADDRINUSE' ? `本机端口 ${PORT} 已被占用。请关闭另一份 Coconut 后重试；不会自动改地址，以免书架看起来丢失。` : 'Coconut 启动未完成。请检查安装包，稍后重试。';
    if (process.env.COCONUT_SMOKE_TEST === '1') console.error(error.message); else dialog.showErrorBox('Coconut',message);
    server?.shutdown();
    app.exit(1);
  });
}
