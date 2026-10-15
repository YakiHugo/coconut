import React, { useEffect, useRef, useState } from 'react';
import type { AppStore } from './store';
export function Recovery({ store }: {
    store: AppStore;
}) {
    const [review, setReview] = useState<File | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
    useEffect(()=>{store.setActivity('backup',busy||review?'正在读取或核对备份':null);return()=>store.setActivity('backup',null);},[store,busy,review]);
    const input = useRef<HTMLInputElement>(null), owner = useRef(0);
    useEffect(()=>{const retire=()=>{owner.current++;};window.addEventListener('pagehide',retire);return()=>{window.removeEventListener('pagehide',retire);retire();};},[]);
    const read = async (file: File) => { const request = ++owner.current, revision = store.getSnapshot().revision; setReview(null); setBusy(true); setMessage(''); try {
        const bytes = await file.arrayBuffer();
        if (request !== owner.current)
            return;
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const backup = JSON.parse(text);
        if (request !== owner.current)
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
    return <details className="recovery-entry"><summary>已有文字稿或需要恢复数据？</summary><p>恢复完整 JSON 书架备份会保留当前内容；不同版本分别保存。</p><button disabled={busy} onClick={() => input.current?.click()}>恢复书架备份</button><input ref={input} hidden type="file" accept=".json" onChange={event => { const file = event.target.files?.[0]; if (!file)
        return; owner.current++; if (file.size > 50 * 1024 * 1024)
        setReview(file);
    else
        void read(file); }}/>{review && <section role="group" aria-label="确认读取大型备份"><p>{review.name} · {(review.size / 1024 / 1024).toFixed(2)} MiB。读取大型备份可能占用较多内存，原文件不会改变。</p><button onClick={() => void read(review)}>确认读取</button><button onClick={() => { setReview(null); if (input.current)
        input.current.value = ''; }}>取消</button></section>}{busy && <button onClick={() => { owner.current++; setBusy(false); setMessage('已取消后续读取；已开始的保存以实际回执为准。'); }}>取消读取</button>}<p role="status">{message}</p><p>原始存储救援暂时使用兼容阅读器；字幕与编码核对在下方的恢复导入中完成。</p><a href="./" onClick={event => { if (store.getSnapshot().save.unsaved || store.getSnapshot().dirty) {
        event.preventDefault();
        setMessage('请先保存或导出本页修改。');
    } }}>打开兼容恢复工具</a></details>;
}
