import React, {useState} from 'react';
import {installStartupLifecycle} from './startup-lifecycle';
import {StorageSetup} from './storage-setup';
import type {StorageResult,RecoveryStorage} from './storage-controller';
import { createRoot } from 'react-dom/client';
import { Application } from './application';
import { createAppStore } from './store';
import type { StoreDependencies } from './contracts';
import './style.css';
// Only DOM-free legacy domain/persistence modules cross this boundary.
const runtime = window as unknown as {
    CoconutClientCapabilities?:{refresh:()=>Promise<unknown>};
    Coconut: {
        validate: StoreDependencies['validate'];
        planLibraryBackup: StoreDependencies['planBackup'];
    };
    CoconutCanonicalLibrary:{project:StoreDependencies['project']};
    CoconutStorageProvider: {
        initialize: (options: unknown) => Promise<any>;
    };
    CoconutLibraryStore: {
        create: (options: unknown) => any;
    };
};
const host = document.getElementById('react-root')!;
const root = createRoot(host);
const startupAbort=new AbortController();let finishStartup!:()=>void,startupStorage:(RecoveryStorage&{shutdown?:()=>Promise<unknown>})|undefined;
const startupSettled=new Promise<void>(resolve=>{finishStartup=resolve;});
let shutdownOwner:typeof startupStorage,shutdownPromise:Promise<unknown>|undefined;
function shutdownStartup(){if(!startupStorage)return Promise.resolve();if(shutdownOwner!==startupStorage){shutdownOwner=startupStorage;shutdownPromise=Promise.resolve().then(()=>startupStorage?.shutdown?.());}return shutdownPromise!;}
const startup=(window as any).coconutUpdates?installStartupLifecycle(window as any,{abort:()=>{startupAbort.abort();void shutdownStartup().catch(()=>{});},settled:()=>startupSettled,shutdown:shutdownStartup,onPaused:()=>{void renderPausedStartup();}}):null;
async function renderPausedStartup(){
    startup?.setBusy(true);
    root.render(<main className="startup"><h1>正在暂停书架载入</h1><p>正在结束存储操作。原始数据与恢复标记保持不变。</p></main>);
    try{await startupSettled;await shutdownStartup();}catch{root.render(<main className="startup"><h1>存储操作尚未确认结束</h1><p>原始数据仍保留。请保持此窗口，等待存储操作结束。</p></main>);return;}
    startup?.setBusy(false);
    if(startup&&!startup.canRenderFailure())return;
    root.render(<main className="startup"><h1>书架载入已暂停</h1><p>关闭已取消。原始数据与恢复标记仍保留，重新载入后可继续核验书架。</p><button onClick={()=>location.reload()}>重新载入书架</button></main>);
}
const startupBusy=(busy:boolean)=>startup?.setBusy(busy);
function ReadyApplication({store,result,storage}:{store:ReturnType<typeof createAppStore>;result:StorageResult;storage?:RecoveryStorage}){
    const [locked,setLocked]=useState(false);
    return <><div inert={locked}><Application store={store}/></div><details className="storage-settings"><summary>书架存储与恢复</summary><StorageSetup result={result} storage={storage} store={store} onRestart={()=>location.reload()} onLockChange={setLocked}/></details></>;
}
async function start() {
    let result:any=null,storage:RecoveryStorage|undefined;
    root.render(<main className="startup"><h1>正在打开 Coconut</h1><p>载入完整书架；原始数据不会被清除。</p></main>);
    try {
        await runtime.CoconutClientCapabilities?.refresh();
        result = await runtime.CoconutStorageProvider.initialize({ validate: runtime.Coconut.validate,signal:startupAbort.signal,onStorage:(value:RecoveryStorage)=>{storage=value;startupStorage=value;if(startupAbort.signal.aborted)void shutdownStartup().catch(()=>{});} });
        if(startupAbort.signal.aborted)throw Error('书架载入已暂停。原始数据仍保留，请重新载入。');
        if (!result.ok || !result.loaded?.ok)
            throw Error(result.error?.message || '原有书架暂时无法完整核验。');
        let preferred=result.loaded.active;try{const saved=sessionStorage.getItem('coconut-reader-active-v1')||localStorage.getItem('coconut-reader-last-active-v1');if(result.loaded.documents.some((doc:{key:string})=>doc.key===saved))preferred=saved;}catch{}
        let nativeIdentity:string|null=null;if((window as any).coconutLocalMedia&&result.adapter.backend==='indexeddb')try{const identity=await result.adapter.mediaLibraryIdentity?.();if(identity?.ok)nativeIdentity=identity.identity;}catch{}
        if(startupAbort.signal.aborted)throw Error('书架载入已暂停。原始数据仍保留，请重新载入。');
        const store = createAppStore({nativeCatalogReady:()=>!!nativeIdentity&&result.adapter.backend==='indexeddb'&&!result.adapter.status?.().error,nativeOwner:key=>{const epoch=result.adapter.documentEpoch?.(key);return nativeIdentity&&epoch&&!result.adapter.status?.().error?{library:nativeIdentity,epoch}:null;}, documents: result.loaded.documents, active: preferred, validate: runtime.Coconut.validate, project:runtime.CoconutCanonicalLibrary.project, planBackup: runtime.Coconut.planLibraryBackup, createPipeline: getDocuments => runtime.CoconutLibraryStore.create({ adapter: result.adapter, getDocuments }) });
        result.adapter.subscribe?.(() => { const error = result.adapter.status?.().error; if (error)
            store.invalidateStorage(error.message); });
        window.addEventListener('beforeunload', event => { const value = store.getSnapshot(); if (value.dirty || value.save.unsaved) {
            event.preventDefault();
            event.returnValue = '';
        } });
        store.subscribe(()=>{const key=store.getSnapshot().activeKey;if(key)try{sessionStorage.setItem('coconut-reader-active-v1',key);localStorage.setItem('coconut-reader-last-active-v1',key);}catch{}});
        window.addEventListener('pagehide',()=>void store.flush());window.document.addEventListener('visibilitychange',()=>{if(window.document.hidden)void store.flush();});
        if(startup&&!startup.admit())return;
        root.render(<ReadyApplication store={store} result={result} storage={storage}/>);
    }
    catch (error) {
        if(startupAbort.signal.aborted)return; // The close/release owner renders only after storage shutdown settles.
        startup?.failed();if(startup&&!startup.canRenderFailure())return;
        root.render(<main className="startup"><h1>暂时无法打开书架</h1><p role="alert">{error instanceof Error ? error.message : '存储不可用'}</p><p>原始数据仍保留。不要清除浏览器数据。</p><StorageSetup result={result||{ok:false,error:{message:error instanceof Error?error.message:'存储不可用'}}} storage={storage} onBusyChange={startupBusy} onRestart={()=>location.reload()}/><a href="compatibility.html">打开兼容恢复工具</a></main>);
    }finally{finishStartup();}
}
void start();
