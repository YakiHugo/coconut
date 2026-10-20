import React, { useEffect, useRef, useState } from 'react';
import {inspectFile} from './ingestion';
import {downloadedMediaFile} from './ingestion-media';
import {rememberIngestionFile} from './ingestion-binding';
import type { AppStore } from './store';
/** Remote descriptors are never direct playable URLs: download is explicit. */
export function MediaSource({ store, documentKey }: {
    store: AppStore;
    documentKey: string;
}) {
    const remote = store.getRemoteMedia(documentKey), [busy, setBusy] = useState(false), [error, setError] = useState(''), owner = useRef<AbortController | null>(null);
    useEffect(()=>{const retire=()=>{owner.current?.abort();owner.current=null;};window.addEventListener('pagehide',retire);return()=>{window.removeEventListener('pagehide',retire);retire();};},[documentKey]);
    useEffect(()=>{store.setActivity('media-download',busy?'原声下载仍在进行':null);return()=>store.setActivity('media-download',null);},[store,busy]);
    if (!remote?.download || store.getMedia(documentKey))
        return null;
    const download = async () => {
        if (busy)
            return;
        const sourceOwner=store.getDocument(documentKey),controller = new AbortController();
        owner.current = controller;
        setBusy(true);
        setError('');
        try {
            // Trust the bounded protocol path, never a response-supplied arbitrary URL.
            if (remote.download?.endpoint !== '/api/podcasts/media')
                throw Error('原声下载协议不受支持。');
            const response = await fetch('api/podcasts/media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(remote.download.body), signal: controller.signal });
            if (!response.ok)
                throw Error('原声下载未完成，请重试或打开来源。');
            const reader = response.body?.getReader();
            if (!reader)
                throw Error('浏览器无法读取媒体流。');
            const chunks: Uint8Array<ArrayBuffer>[] = [], limit = 200 * 1024 * 1024;
            let bytes = 0;
            while (true) {
                const item = await reader.read();
                if (item.done)
                    break;
                bytes += item.value.byteLength;
                if (bytes > limit) {
                    await reader.cancel();
                    throw Error('媒体超过 200 MiB，本次未打开。');
                }
                chunks.push(new Uint8Array(item.value));
            }
            if (owner.current !== controller)
                return;
            const file=downloadedMediaFile(chunks,{name:remote.name,contentType:response.headers.get('content-type')||'',kind:remote.kind});
            const inspected=await inspectFile(file);
            if(owner.current!==controller||controller.signal.aborted||store.getDocument(documentKey)!==sourceOwner)return;
            rememberIngestionFile(file,inspected.source.fingerprint);store.setFile(documentKey,file);
            store.setMedia(documentKey, { url: URL.createObjectURL(file), kind: remote.kind, name: remote.name || '原声', identity: 'remote:' + JSON.stringify(remote.download.body), availability: 'remote' });
        }
        catch (error) {
            if (owner.current === controller && !controller.signal.aborted)
                setError(error instanceof Error ? error.message : '下载失败');
        }
        finally {
            if (owner.current === controller) {
                owner.current = null;
                setBusy(false);
            }
        }
    };
    return <section className="remote-media"><button disabled={busy} onClick={() => void download()}>{busy ? '正在读取原声…' : '载入原声（最多 200 MiB）'}</button>{busy && <button onClick={() => { owner.current?.abort(); owner.current = null; setBusy(false); }}>取消</button>}<p>只在点击后下载，本页保留；不会自动播放。载入后可检查本地识别服务，再明确生成文字稿。</p><p role="status">{error}</p></section>;
}
