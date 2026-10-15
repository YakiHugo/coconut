import React, { useEffect, useRef, useState } from 'react';
import {searchCatalog} from './catalog';
import {SubtitleRecovery} from '../recovery-import/recovery';
import { Recovery } from './recovery';
import type { AppStore } from './store';
import { ingest, inspectFile, type Ingestion, type Episode } from './ingestion';
export function Discover({ store }: {
    store: AppStore;
}) {
    const [catalogQuery,setCatalogQuery]=useState('');
    const [candidate,setCandidate]=useState<{file:File;inspected:Awaited<ReturnType<typeof inspectFile>>;keys:string[]}|null>(null);
    const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [result, setResult] = useState<Ingestion | null>(null), [error, setError] = useState('');
    const owner = useRef<AbortController | null>(null), fileInput = useRef<HTMLInputElement>(null);
    const cancel = () => { setCandidate(null);store.invalidateMedia(); owner.current?.abort(); owner.current = null; setBusy(false); };
    useEffect(()=>{store.setActivity('source',busy||candidate?'正在读取来源或核对候选原文件':null);return()=>store.setActivity('source',null);},[store,busy,candidate]);
    useEffect(()=>{const retire=()=>{owner.current?.abort();owner.current=null;};window.addEventListener('pagehide',retire);return()=>{window.removeEventListener('pagehide',retire);retire();};},[]);
    const request = async (value: string, episode?: Episode, feed?: string) => {
        cancel();
        const controller = new AbortController();
        owner.current = controller;
        setBusy(true);
        setError('');
        setResult(null);
        try {
            const valueResult = await ingest({ source: { kind: 'url', url: feed || value }, ...(episode ? { episode: { feed_url: feed, episode_id: episode.id } } : {}) }, controller.signal);
            if (owner.current !== controller)
                return;
            setResult(valueResult);
            const content = valueResult.state === 'ready' ? valueResult.transcript?.document : valueResult.state === 'needs_transcription' ? valueResult.project?.document : null;
            if (content) {
                const doc = store.addDocument(content);
                if (doc && valueResult.media)
                    store.setRemoteMedia(doc.key, valueResult.media);
                if (valueResult.state === 'needs_transcription')
                    store.setMessage(valueResult.transcription?.message || '已打开原声项目，尚未配置文字稿识别。');
            }
            if (valueResult.state === 'blocked')
                setError(valueResult.error?.message || '暂时无法读取来源。');
        }
        catch (error) {
            if (owner.current === controller && !controller.signal.aborted)
                setError(error instanceof Error ? error.message : '来源读取失败');
        }
        finally {
            if (owner.current === controller) {
                owner.current = null;
                setBusy(false);
            }
        }
    };
    const openFile = async (file: File) => {
        cancel();
        const controller = new AbortController();
        owner.current = controller;
        setBusy(true);
        setError('');
        setCandidate(null);
        try {
            const inspected = await inspectFile(file);
            if (owner.current !== controller)
                return;
            const existing = store.getSnapshot().documents.filter(doc => (doc.local_media_source as {
                fingerprint?: string;
            } | undefined)?.fingerprint === inspected.source.fingerprint);
            if (existing.length > 0) {setCandidate({file,inspected,keys:existing.map(doc=>doc.key)});return;}
            const doc = existing[0] || store.addDocument({ project_kind: 'audio_only', title: file.name, local_media_source: inspected.source, segments: [] });
            if (!doc || owner.current !== controller)
                return;
            store.setFile(doc.key, file);
            store.setMedia(doc.key, { url: URL.createObjectURL(file), kind: inspected.kind, name: file.name, identity: inspected.identity, availability: 'local_session' });
            store.select(doc.key);
            store.setMessage('已打开本地原声。文件未上传，未自动播放；尚未配置语音识别，文字稿不会自动生成。');
        }
        catch (error) {
            if (owner.current === controller)
                setError(error instanceof Error ? error.message : '文件无法打开');
        }
        finally {
            if (owner.current === controller) {
                owner.current = null;
                setBusy(false);
            }
            if (fileInput.current)
                fileInput.current.value = '';
        }
    };
    const chooseCandidate=(key:string|null)=>{if(!candidate)return;const {file,inspected}=candidate;const existing=key?store.getDocument(key):null;if(key&&(!existing||(existing.local_media_source as {fingerprint?:string})?.fingerprint!==inspected.source.fingerprint)){setError('候选项目已变化，请重新打开文件。');setCandidate(null);return;}if(store.getSnapshot().dirty)return;const doc=existing||store.addDocument({project_kind:'audio_only',title:file.name,local_media_source:inspected.source,segments:[]});if(!doc)return;store.setFile(doc.key,file);store.setMedia(doc.key,{url:URL.createObjectURL(file),kind:inspected.kind,name:file.name,identity:inspected.identity,availability:'local_session'});setCandidate(null);store.select(doc.key);};
    return <section className="discover" aria-labelledby="discover-title">
  <p className="kicker">COCONUT / 从声音开始</p><h1 id="discover-title">今天，想听什么？</h1><p className="lede">从一段声音开始，留住值得重读的想法。</p>
  <form onSubmit={event => { event.preventDefault(); void request(url); }}><label htmlFor="source-url">播客或视频链接</label><div className="source-row"><input id="source-url" type="url" required maxLength={4096} value={url} onChange={event => { cancel(); setResult(null); setError(''); setUrl(event.target.value); }} placeholder="粘贴节目、单集或视频链接"/><button disabled={busy} type="submit">{busy ? '正在读取…' : '打开链接'}</button></div></form>
  <div className="source-actions"><button type="button" disabled={busy} onClick={() => {store.invalidateMedia();fileInput.current?.click();}}>打开音频或视频文件</button><input ref={fileInput} type="file" accept="audio/*,video/*" hidden onChange={event => { const file = event.target.files?.[0]; if (file)
        void openFile(file); }}/>{busy && <button onClick={cancel}>取消读取</button>}</div>
  {candidate&&<section aria-label="核对原声项目"><h2>核对原声来源</h2><p>部分文件采样与已有项目相同，但不能证明是同一原声。请核对文件名与项目后选择。已有笔记不会被覆盖。</p>{candidate.keys.map(key=><button key={key} onClick={()=>chooseCandidate(key)}>关联到 {store.getDocument(key)?.title||key}</button>)}<button onClick={()=>chooseCandidate(null)}>作为新原声项目打开</button><button onClick={()=>setCandidate(null)}>取消关联</button></section>}
  <p className="quiet">优先读取发布者或平台现成文字稿。不会自动调用 AI、运行识别或下载模型。</p>
  <p role="status" className="source-error">{error}</p>
  {result?.state === 'awaiting_selection' && <section className="episode-list" aria-label="选择播客单集"><h2>{result.selection?.title || '选择一集开始'}</h2>{result.selection?.feeds?.map(feed => <button key={feed.url} onClick={() => { setUrl(feed.url); void request(feed.url); }}>{feed.title}</button>)}{result.selection?.episodes?.map(episode => <article key={episode.id}><div><h3>{episode.title}</h3><p>{episode.transcripts?.some(track => track.supported) ? '发布者提供文字稿' : '检查文字稿可用性'}</p></div><button onClick={() => void request(url, episode, result.selection?.feed_url)}>打开单集</button></article>)}</section>}
  {result?.state === 'needs_transcription' && <section aria-label="文字稿状态"><h2>已找到原声，文字稿尚未就绪</h2><p>{result.transcription?.message || '此服务尚未配置语音识别。没有自动下载模型或运行识别。'}</p></section>}
  {!result&&<section className="podcast-catalog" aria-labelledby="catalog-title"><div><h2 id="catalog-title">从一个节目开始</h2><p className="quiet">内置公开节目目录。点击后读取最新单集；字幕可用性以发布者来源为准。</p></div><label htmlFor="catalog-query">查找内置节目</label><input id="catalog-query" type="search" value={catalogQuery} onChange={event=>setCatalogQuery(event.target.value)} placeholder="节目名称或主题"/><ul>{searchCatalog(catalogQuery).map(show=><li key={show.id}><div><h3>{show.title}</h3><p>{show.description}</p><a href={show.source} target="_blank" rel="noopener noreferrer">发布者网站</a></div><button disabled={busy} onClick={()=>{setUrl(show.feed);void request(show.feed);}}>查看单集</button></li>)}</ul>{!searchCatalog(catalogQuery).length&&<p>内置目录暂无匹配。也可以在上方粘贴发布者 RSS 或节目链接。</p>}</section>}
  <Recovery store={store}/><SubtitleRecovery store={store}/>
 </section>;
}
