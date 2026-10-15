import React, { useEffect, useRef, useState } from 'react';
import {useOwnedPicker} from '../native-shell/owned-picker-hook';
import type { AppStore } from './store';
export function Recovery({ store }: {
    store: AppStore;
}) {
    const [review, setReviewState] = useState<File | null>(null), [busy, setBusyState] = useState(false), [message, setMessage] = useState('');
    const picker=useOwnedPicker({scope:'json-backup',setActivity:store.setActivity,reason:'正在选择备份文件'});
    const activity=useRef({busy:false,review:false});const syncActivity=()=>store.setActivity('backup',activity.current.busy||activity.current.review?'正在读取或核对备份':null);
    const setBusy=(value:boolean)=>{activity.current.busy=value;syncActivity();setBusyState(value);};const setReview=(value:File|null)=>{activity.current.review=!!value;syncActivity();setReviewState(value);};
    useEffect(()=>()=>store.setActivity('backup',null),[store]);
    const input = useRef<HTMLInputElement>(null), owner = useRef(0);
    useEffect(()=>{const retire=()=>{owner.current++;};window.addEventListener('pagehide',retire);return()=>{window.removeEventListener('pagehide',retire);retire();};},[]);
    const read = async (file: File,current=()=>true) => { const request = ++owner.current, revision = store.getSnapshot().revision; setReview(null); setBusy(true); setMessage(''); try {
        const bytes = await file.arrayBuffer();
        if (request !== owner.current||!current())
            return;
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const backup = JSON.parse(text);
        if (request !== owner.current||!current())
            return;
        await store.restoreJSON(backup, revision);
        if (request === owner.current)
            setMessage('恢复结果见上方保存状态。');
    }
    catch (error) {
        if (request === owner.current)
            setMessage(error instanceof Error ? error.message : '读取失败，原书架保留。');
    }
    finally {
        if (request === owner.current)
            setBusy(false);
        if (input.current)
            input.current.value = '';
    } };
    return <details className="recovery-entry"><summary>已有文字稿或需要恢复数据？</summary><p>恢复完整 JSON 书架备份会保留当前内容；不同版本分别保存。</p><button disabled={busy} onClick={() => {if(store.closeSnapshot().nonContentReasons.length)return;const captured=store.getSnapshot();picker.controller.begin(input.current,()=>{const value=store.getSnapshot();return value.workspace===captured.workspace&&value.activeKey===captured.activeKey&&value.documents===captured.documents;});}}>恢复书架备份</button><input key={picker.inputKey} ref={input} hidden type="file" accept=".json" onChange={event => {const element=event.currentTarget,file=element.files?.[0];void picker.controller.accept(element,async({current})=>{if(!file||!current())return;owner.current++;if(file.size>50*1024*1024)setReview(file);else await read(file,current);});}}/>{review && <section role="group" aria-label="确认读取大型备份"><p>{review.name} · {(review.size / 1024 / 1024).toFixed(2)} MiB。读取大型备份可能占用较多内存，原文件不会改变。</p><button onClick={() => void read(review)}>确认读取</button><button onClick={() => { setReview(null); if (input.current)
        input.current.value = ''; }}>取消</button></section>}{busy && <button onClick={() => { owner.current++; setBusy(false); setMessage('已取消后续读取；已开始的保存以实际回执为准。'); }}>取消读取</button>}<p role="status">{message}</p><p>字幕与编码核对在下方完成；原始存储救援也可在书架存储设置中导出。</p></details>;
}
