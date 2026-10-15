import {useState} from 'react';
import {rawRecovery,recoveryJSON,type StorageResult,type RecoveryStorage} from './storage-controller';
import type {AppStore} from './store';
export function StorageSetup({result,storage,onRestart}:{result:StorageResult;storage?:RecoveryStorage;store?:AppStore;onRestart:()=>void;onLockChange?:(locked:boolean)=>void;onBusyChange?:(busy:boolean)=>void}){
 const [notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 function download(text:string,name:string){let url:string|undefined;try{url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setNotice('已发起恢复文件下载，请打开文件确认并妥善保留。原始浏览器数据保持不变。');}catch{setNotice('导出失败，请重试；原始浏览器数据仍保留。');}finally{if(url)setTimeout(()=>URL.revokeObjectURL(url!),60000);}}
 async function exportRecovery(){setBusy(true);try{const snapshot=storage?.readRecovery?await storage.readRecovery():result.recovery;if(!snapshot||(snapshot as any).ok===false||(snapshot as any).warning)throw Error((snapshot as any)?.warning||'无法完整读取恢复副本，请保留站点数据并重试。');download(recoveryJSON(snapshot),'coconut-browser-recovery.json');}catch(error){setNotice(error instanceof Error?error.message:'导出失败，请重试。');}finally{setBusy(false);}}
 return <section data-testid="storage-setup" aria-label="书架存储与恢复"><h2>书架存储与恢复</h2><p>{result.ok?'内容直接保存在已连接电脑的统一书架。':'电脑书架暂时不可用。恢复连接后重新载入；当前不会建立另一份浏览器书架。'}</p>
 {result.retainedBrowserData&&<p data-testid="storage-retained">检测到以前的浏览器数据，保留为只读恢复副本。它们未自动合并到电脑书架，也不会被删除。可导出备份后检查内容。</p>}
 {result.recoveryWarning&&<p role="alert">{result.recoveryWarning}</p>}
 {typeof result.legacyRaw==='string'&&<button data-testid="storage-export-raw" onClick={()=>{const file=rawRecovery(result.legacyRaw!);download(file.text,file.name);}}>导出原始旧存储</button>}
 {result.retainedBrowserData&&<button data-testid="storage-export-recovery" disabled={busy} onClick={()=>void exportRecovery()}>导出完整浏览器恢复文件</button>}
 {!result.ok&&<button data-testid="storage-retry" onClick={onRestart}>重新载入并核验</button>}
 <p role="status" data-testid="storage-status">{notice}</p></section>;
}
