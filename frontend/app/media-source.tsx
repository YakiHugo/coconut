import React, { useEffect, useRef, useState } from 'react';
import {inspectFile} from './ingestion';
import {downloadedMediaFile} from './ingestion-media';
import {saveSourceMedia} from './source-media';
import {rememberIngestionFile} from './ingestion-binding';
import type { AppStore } from './store';
/** Remote descriptors are never direct playable URLs: download is explicit. */
export function MediaSource({ store, documentKey }: {
    store: AppStore;
    documentKey: string;
}) {
    const remote = store.getRemoteMedia(documentKey), [busy, setBusy] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState(''), owner = useRef<AbortController | null>(null), previousKey=useRef(documentKey);
    useEffect(()=>{
        if(previousKey.current!==documentKey){previousKey.current=documentKey;setBusy(false);setSaving(false);setError('');}
        const retire=()=>{owner.current?.abort();owner.current=null;};
        const pagehide=()=>{retire();setBusy(false);setSaving(false);};
        window.addEventListener('pagehide',pagehide);
        return()=>{window.removeEventListener('pagehide',pagehide);retire();};
    },[documentKey]);
    useEffect(()=>{store.setActivity('media-download',busy?'原声下载或保存仍在进行':null);return()=>store.setActivity('media-download',null);},[store,busy]);
    if ((window as any).CoconutClientCapabilities?.allows('sourceJobs') || !remote?.download || store.getMedia(documentKey))
        return null;
    const download = async () => {
        if (busy || owner.current)
            return;
        const sourceOwner=store.getDocument(documentKey),fileOwner=store.getFile(documentKey),mediaOwner=store.getMedia(documentKey),controller = new AbortController();
        const stillOwnsMedia=()=>store.getFile(documentKey)===fileOwner&&store.getMedia(documentKey)===mediaOwner;
        let unsubscribe=store.subscribe(()=>{
            if(owner.current===controller&&!stillOwnsMedia()){controller.abort();owner.current=null;setBusy(false);setSaving(false);}
        });
        owner.current = controller;
        setBusy(true);
        setSaving(false);
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
            if(owner.current!==controller||controller.signal.aborted||store.getDocument(documentKey)!==sourceOwner||!stillOwnsMedia())return;
            // A downloaded Blob is not durable. Keep the source project unchanged and
            // let the shared asset service attach playback only after confirmed storage.
            setSaving(true);
            rememberIngestionFile(file,inspected.source.fingerprint);
            // The storage helper now owns late attachment checks; its own successful
            // attachment must not be mistaken for a competing local selection.
            unsubscribe();unsubscribe=()=>{};
            await saveSourceMedia(store,documentKey,file,controller.signal);
        }
        catch (error) {
            if (owner.current === controller && !controller.signal.aborted)
                setError(error instanceof Error ? error.message : '下载失败');
        }
        finally {
            unsubscribe();
            if (owner.current === controller) {
                owner.current = null;
                setBusy(false);
                setSaving(false);
            }
        }
    };
    return <section className="remote-media"><button disabled={busy} onClick={() => void download()}>{busy ? saving ? '正在保存原声…' : '正在读取原声…' : '载入原声（最多 200 MiB）'}</button>{busy && <button onClick={() => { owner.current?.abort(); owner.current = null; setBusy(false); setSaving(false); }}>取消</button>}<p role="status">{error}</p></section>;
}
