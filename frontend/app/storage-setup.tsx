import {useEffect,useState,useSyncExternalStore} from 'react';
import type {AppStore} from './store';
import {createStorageController,rawRecovery,recoveryJSON,type StorageResult,type RecoveryStorage} from './storage-controller';
export function StorageSetup({result,storage,store,onRestart,onLockChange}:{result:StorageResult;storage?:RecoveryStorage;store?:AppStore;onRestart:()=>void;onLockChange?:(locked:boolean)=>void}){
 const access=(globalThis as any).CoconutClientCapabilities;
 const [controller]=useState(()=>createStorageController({result,store,onRestart,onLockChange,refreshAccess:()=>access?.refresh(),allows:cap=>!access||access.allows(cap)}));
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot);const [notice,setNotice]=useState('');
 useEffect(()=>{void controller.inspect();return()=>controller.dispose();},[controller]);
 function download(text:string,name:string){let url:string|undefined;try{url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setNotice('已发起恢复文件下载，请打开文件确认并妥善保留。这不是普通书架备份，不能直接导入；下载不会修复存储。');}catch{setNotice('下载未能完成，请重试。原始数据仍保留。');}finally{if(url)setTimeout(()=>URL.revokeObjectURL(url!),60000);}}
 async function exportRecovery(){try{const snapshot=storage?.canonicalRecovery?await storage.canonicalRecovery():storage?.readRecovery?await storage.readRecovery():result.recovery;if(!snapshot||(snapshot as any).ok===false)throw Error('完整恢复数据暂时无法读取，请重试。');download(recoveryJSON(snapshot),'coconut-storage-recovery.json');}catch(error){setNotice(error instanceof Error?error.message:'导出失败，请重试。');}}
 const interrupted=state.marker?.state==='frozen'||result.error?.code==='canonical_pending';
 const action=state.review?.action;
 return <section data-testid="storage-setup" aria-label="书架存储与恢复"><h2>书架存储与恢复</h2><p>{result.backend==='canonical'?'已连接电脑统一书架。连接前的浏览器记录保留为只读恢复副本。':result.backend==='indexeddb'?'当前使用本浏览器书架。迁移或连接电脑书架需要你明确确认。':'原始数据仍保留。请勿清除浏览器数据。'}</p>
 <p role="status" data-testid="storage-status" aria-live="polite">{state.message}</p>
 {result.canonical&&result.backend==='indexeddb'&&!state.locked&&<><button data-testid="storage-discover" disabled={state.busy} onClick={()=>void controller.discover()}>检查电脑书架</button>{(!access||access.allows('libraryMigration'))&&<button data-testid="storage-begin" disabled={state.busy} onClick={()=>controller.review('begin')}>迁移到此 PC 的统一书架</button>}{state.canConnect&&<button data-testid="storage-connect" disabled={state.busy} onClick={()=>controller.review('connect')}>连接已有电脑书架</button>}</>}
 {interrupted&&<><p>迁移中断，原始书架已冻结。只有确认完成或取消后才能恢复写入。</p><button data-testid="storage-resume" disabled={state.busy} onClick={()=>controller.review('resume')}>继续迁移</button><button data-testid="storage-cancel" disabled={state.busy} onClick={()=>controller.review('cancel')}>取消迁移</button></>}
 {state.review&&<div role="region" aria-label="确认书架存储操作"><h3>{action==='connect'?'连接已有电脑书架':action==='cancel'?'确认取消迁移':action==='resume'?'继续未完成迁移':'确认迁移书架'}</h3><p>{action==='connect'?'当前浏览器书架完整保留为只读恢复副本，不合并、不覆盖电脑书架。':action==='cancel'?'先核查电脑最终回执。如果迁移已经提交，将连接已完成的书架；只有服务器确认取消才恢复浏览器写入。':action==='resume'?'继续核验同一份冻结快照与回执，不重新选择或覆盖原始数据。':`将当前 ${state.review.count} 个项目及原始存储迁移到此 PC。先确认所有保存，迁移后停止浏览器写入；原始记录完整保留。`}</p><button data-testid="storage-review-confirm" disabled={state.busy} onClick={()=>void controller.confirm()}>确认{action==='cancel'?'取消':action==='connect'?'连接':action==='resume'?'继续':'迁移'}</button><button data-testid="storage-review-dismiss" disabled={state.busy} onClick={()=>controller.dismiss()}>返回</button></div>}
 {typeof result.legacyRaw==='string'&&<button data-testid="storage-export-raw" onClick={()=>{const file=rawRecovery(result.legacyRaw!);download(file.text,file.name);}}>导出原始旧存储</button>}
 {(result.recovery||storage)&&<button data-testid="storage-export-recovery" onClick={()=>void exportRecovery()}>导出完整存储恢复文件</button>}
 {(!result.ok||state.locked)&&<button data-testid="storage-retry" disabled={state.busy} onClick={onRestart}>重新载入并核验</button>}
 {notice&&<p role="status">{notice}</p>}
 </section>;
}
