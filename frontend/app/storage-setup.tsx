import {useState} from 'react';
import {rawRecovery,recoveryJSON,type StorageResult,type RecoveryStorage} from './storage-controller';
import type {AppStore} from './store';
export function StorageSetup({result,storage,onRestart}:{result:StorageResult;storage?:RecoveryStorage;store?:AppStore;onRestart:()=>void;onLockChange?:(locked:boolean)=>void;onBusyChange?:(busy:boolean)=>void}){
 const [notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 function download(text:string,name:string){let url:string|undefined;try{url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setNotice('已发起下载，请核对恢复文件。');}catch{setNotice('导出失败，请重试；原始浏览器数据仍保留。');}finally{if(url)setTimeout(()=>URL.revokeObjectURL(url!),60000);}}
 async function exportRecovery(){setBusy(true);try{const snapshot=storage?.readRecovery?await storage.readRecovery():result.recovery;if(!snapshot||(snapshot as any).ok===false||(snapshot as any).warning)throw Error((snapshot as any)?.warning||'无法完整读取恢复副本，请保留站点数据并重试。');download(recoveryJSON(snapshot),'coconut-browser-recovery.json');}catch(error){setNotice(error instanceof Error?error.message:'导出失败，请重试。');}finally{setBusy(false);}}
 return <section data-testid="storage-setup" aria-label="书架存储与恢复"><h2>书架存储与恢复</h2><p>{result.ok?'已连接电脑书架。':'电脑书架不可用，请恢复连接后重试。'}</p>
 {result.retainedBrowserData&&<p data-testid="storage-retained">旧浏览器数据保留为只读恢复副本，尚未合并到电脑书架。</p>}
 {result.recoveryWarning&&<p role="alert">{result.recoveryWarning}</p>}
 {typeof result.legacyRaw==='string'&&<button data-testid="storage-export-raw" onClick={()=>{const file=rawRecovery(result.legacyRaw!);download(file.text,file.name);}}>导出原始旧存储</button>}
 {result.retainedBrowserData&&<button data-testid="storage-export-recovery" disabled={busy} onClick={()=>void exportRecovery()}>导出完整浏览器恢复文件</button>}
 {!result.ok&&<button data-testid="storage-retry" onClick={onRestart}>重新载入并核验</button>}
 <p role="status" data-testid="storage-status">{notice}</p></section>;
}
