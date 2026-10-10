/** Packaged macOS entry point. The renderer never receives Node, shell or credential access. */
import { app, BrowserWindow, dialog, shell, ipcMain, Menu } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { startBridge } from './server.mjs';
import { createCaptionHelper } from './caption-helper.mjs';
import { createCaptionService } from './caption-service.mjs';
import { Updater } from './updater.mjs';
import { prepareInstall } from './update-install.mjs';
import { createCloseCoordinator, createLifecycleOwnership } from './close-coordinator.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 47831; // Stable origin preserves the local bookshelf between launches.
let server, window, captionHelper, updater, updateTimer, updateInterval;
const startupAbort=new AbortController();
let quitting=false,quitReady=false,closeCoordinator;
function finishQuit(){
 if(quitting)return;
 quitting=true;
 clearTimeout(updateTimer);clearInterval(updateInterval);updater?.cancel();
 startupAbort.abort();server?.shutdown();
 const finish=()=>{if(quitReady)return;quitReady=true;app.quit();};
 if(!captionHelper){finish();return;}
 const failSafe=setTimeout(finish,5000);
 Promise.resolve().then(()=>captionHelper.shutdown()).catch(()=>{}).finally(()=>{clearTimeout(failSafe);finish();});
}
function ordinaryWebLink(value) {
  try { const url = new URL(value); return ['https:','http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on('second-instance',()=>{ if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{
    if(quitReady)return;
    event.preventDefault();
    if(closeCoordinator&&window&&!window.isDestroyed())void closeCoordinator.request();
    else finishQuit();
  });
  app.whenReady().then(async()=>{
    if(startupAbort.signal.aborted)return;
    let installing;
    try{installing=JSON.parse(await readFile(path.join(app.getPath('userData'),'updates/install-lock.json'),'utf8'));}catch{}
    let helperAlive=false;
    if(Number.isSafeInteger(installing?.helperPid)&&installing.helperPid>0){try{process.kill(installing.helperPid,0);helperAlive=true;}catch{}}
    if(installing&&(helperAlive||installing.expires>Date.now())&&installing.version!==app.getVersion()){
      dialog.showErrorBox('Coconut 正在安装更新','请等待安装完成后再启动。当前应用不会在运行中被替换。');app.quit();return;
    }
    const readerDirectory = app.isPackaged ? path.join(process.resourcesPath,'reader') : path.resolve(ROOT,'../reader');
    const windowIcon=app.isPackaged?path.join(process.resourcesPath,'coconut-icon.png'):path.join(readerDirectory,'coconut-mark.png');
    // Packaged macOS uses the signed bundle icon; development has no app bundle.
    if(!app.isPackaged&&process.platform==='darwin')app.dock?.setIcon(windowIcon);
    let captionService=null;
    if(app.isPackaged){
      captionHelper=createCaptionHelper({resourcesPath:process.resourcesPath});
      const status=await captionHelper.status({signal:startupAbort.signal});
      if(startupAbort.signal.aborted)return;
      if(status.ready)captionService=createCaptionService({helper:captionHelper,readerDirectory,enabledProviders:['x']});
    }
    server = await startBridge({port:PORT,readerDirectory,captionService});
    if(startupAbort.signal.aborted){server.shutdown();return;}
    const origin = `http://127.0.0.1:${PORT}`;
    window = new BrowserWindow({width:1280,height:880,minWidth:780,minHeight:620,show:process.env.COCONUT_SMOKE_TEST !== '1',title:'Coconut',icon:windowIcon,
      webPreferences:{preload:path.join(ROOT,'update-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false}});
    const lifecycle=createLifecycleOwnership();
    const readerClose=(mode,request)=>window.webContents.executeJavaScript(`typeof window.coconutPrepareClose === "function" ? window.coconutPrepareClose(${JSON.stringify(mode)},${JSON.stringify(request)}) : null`);
    closeCoordinator=createCloseCoordinator({
      lifecycle,
      inspect:request=>readerClose('inspect',request),
      commit:(mode,request)=>readerClose(mode,request),
      release:attempt=>{void readerClose('release',attempt).catch(()=>{});},
      confirm:async snapshot=>{
        const answer=await dialog.showMessageBox(window,{type:'warning',title:'关闭 Coconut？',message:'还有未保存的编辑或进行中的工作',
          detail:(snapshot.reasons||[]).join('；')+'。继续编辑可保存或导出备份。直接退出会丢弃未保存内容并中断任务；已发送的模型请求可能已经使用额度。',
          buttons:['继续编辑','放弃未保存内容并退出'],defaultId:0,cancelId:0,noLink:true});
        return answer.response===1;
      },
      finish:async attempt=>{await window.webContents.session.flushStorageData();if(!lifecycle.owns(attempt))throw new Error('关闭操作已取消');finishQuit();},
      onError:async()=>{if(window.isDestroyed())return;return dialog.showMessageBox(window,{type:'warning',title:'暂时无法安全关闭',message:'无法确认阅读器的保存状态，Coconut 已保持打开。',detail:'请等待阅读器恢复后保存或导出备份，再尝试退出。强制退出或系统终止仍可能丢失未保存内容。',buttons:['继续等待'],defaultId:0,cancelId:0});}
    });
    // Native close and Cmd-Q use the same gate. OS termination/crashes cannot be
    // guaranteed recoverable; no browser beforeunload prompt is involved here.
    window.on('close',event=>{if(!quitReady){event.preventDefault();void closeCoordinator.request();}});
    updater=new Updater({directory:path.join(app.getPath('userData'),'updates'),version:app.getVersion()});
    await updater.initialize();
    updater.on('state',state=>{if(!window.isDestroyed())window.webContents.send('coconut:update-state',state);});
    async function installUpdate(){
      if(updater.state.status!=='ready'||!updater.release||lifecycle.busy())return updater.snapshot();
      if(!app.isPackaged)throw new Error('开发运行不能替换已安装应用');
      const attempt=lifecycle.begin('update');let install,started=false;
      // Reserve this updater before the first await, but leave ordinary quit
      // available while the confirmation/staging work is still non-final.
      updater.change({status:'installing',message:'正在确认安装，当前版本继续运行…'});
      const safe=lock=>lifecycle.call(attempt,request=>window.webContents.executeJavaScript(`typeof window.coconutPrepareUpdate === "function" && window.coconutPrepareUpdate(${lock?'true':'false'},${JSON.stringify(request)})`));
      const current=()=>{if(!lifecycle.current(attempt))throw new Error('已有关闭操作，安装已暂停。');};
      try{
        if(!await safe(false))throw new Error('请先完成编辑、暂停播放和处理任务，并确保书架已保存，再安装更新。');
        const confirmation=await dialog.showMessageBox(window,{type:'question',title:'安装 Coconut 更新',message:`安装 ${updater.release.version} 并重启？`,detail:'书架已保存。未签名应用可能需要 macOS 安全确认；旧应用会保留在 Applications 中。书架、笔记和设置不会移动。重启后本地媒体需重新选择。',buttons:['稍后','安装并重启'],defaultId:0,cancelId:0});
        current();
        if(confirmation.response!==1)return updater.change({status:'ready',message:'已推迟安装，下载保留，可以稍后重试。'});
        updater.change({status:'installing',message:'正在验证应用结构并准备安装…'});
        install=await prepareInstall({directory:updater.directory,release:updater.release,appPath:path.resolve(process.resourcesPath,'../..'),version:app.getVersion(),arch:process.arch});
        current();
        if(!lifecycle.claim(attempt))throw new Error('已有关闭操作，安装已暂停。');
        // Recheck after staging, then use exactly the same renderer ownership
        // and final listening flush as native close. No second discard dialog
        // may cancel quit after the installer has already been launched.
        if(!await safe(true))throw new Error('出现新的工作或未保存修改，安装已暂停。完成后请重试。');
        await window.webContents.session.flushStorageData();current();
        await install.start();started=true;current();
        finishQuit();return updater.snapshot();
      }catch(error){
        if(install&&!started)await install.discard().catch(()=>{});
        return updater.change({status:'ready',message:'安装未完成：'+error.message+'。当前应用和数据保留，可以重试。'});
      }finally{
        if(!started){
          lifecycle.retire(attempt);
          if(!window.isDestroyed())void readerClose('release',attempt).catch(()=>{});
        }
      }
    }
    ipcMain.handle('coconut:update',async(event,action,value)=>{
      if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||![origin+'/',origin+'/index.html'].includes(event.senderFrame.url))throw new Error('更新请求来源无效');
      if(action==='state')return updater.snapshot();
      if(action==='check')return updater.check({manual:true});
      if(action==='download')return updater.download();
      if(action==='cancel')return updater.cancel();
      if(action==='developer')return updater.setDeveloper(value);
      if(action==='install')return installUpdate();
      throw new Error('不支持的更新操作');
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Coconut',submenu:[{role:'about'},{label:'检查更新…',click:()=>{void updater.check({manual:true});void window.webContents.executeJavaScript('document.getElementById("app-updates").open=true');}},{type:'separator'},{role:'quit'}]},{role:'editMenu'},{role:'windowMenu'}]));
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
    if(app.isPackaged&&process.env.COCONUT_SMOKE_TEST!=='1'){
      const automatic=()=>{void updater.check().then(state=>{if(state.status==='available')return updater.download();}).catch(()=>{updater.change({status:'error',message:'更新检查未完成，请手动重试。'});});};
      updateTimer=setTimeout(automatic,12000);updateTimer.unref();
      updateInterval=setInterval(automatic,6*60*60*1000);updateInterval.unref();
    }
    if (process.env.COCONUT_SMOKE_TEST === '1') {
      const result = await window.webContents.executeJavaScript(`(async()=>{
        const health=await (await fetch('/api/health')).json();
        return {reader:!!document.querySelector('#import'),
          scripts:typeof Coconut==='object',isolated:typeof require==='undefined'&&typeof process==='undefined',
          bridge:health.runtime==='desktop-bridge'&&health.capabilities.local_agents===true,
          asrDisabled:health.capabilities.media_import===false};
      })()`);
      if (!Object.values(result).every(Boolean)) throw new Error('Desktop smoke test failed: '+JSON.stringify(result));
      console.log('Coconut desktop smoke passed: packaged reader, isolated renderer and no user-installed Python');
      app.quit();
    }
  }).catch(error=>{
    if(startupAbort.signal.aborted)return;
    const message = error.code === 'EADDRINUSE' ? `本机端口 ${PORT} 已被占用。请关闭另一份 Coconut 后重试；不会自动改地址，以免书架看起来丢失。` : 'Coconut 启动未完成。请检查安装包，稍后重试。';
    if (process.env.COCONUT_SMOKE_TEST === '1') console.error(error.message); else dialog.showErrorBox('Coconut',message);
    server?.shutdown();
    app.exit(1);
  });
}
