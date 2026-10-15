import React, { useState, useMemo, useSyncExternalStore } from 'react';
import type { AppStore } from './store';
import {listeningPreference} from './preferences';
import {NativeShell} from './native-shell';
import {NativeClose} from './native-close';
import {Library,Collection} from './library';
import {NativeMedia} from './native-media';
import {IngestionPanel} from './ingestion-panel';
import {useNavigation} from './navigation';
import { MediaSource } from './media-source';
import { AiPanel } from './ai';
import type { AiSelection } from '../ai-workspace/contracts';
import {SubtitleRecovery} from '../recovery-import/recovery';
import { Discover } from './discover';
import { ReaderWorkspace } from '../reader-workspace/workspace';
import '../reader-workspace/workspace.css';
import {ReadingPreferences,useReadingPreferences} from '../reading-preferences/preferences';
import '../reading-preferences/preferences.css';
export function Application({ store }: {
    store: AppStore;
}) {
    const preferences=useReadingPreferences();
    const [summaryRequest,setSummaryRequest]=useState<{id:number;documentKey:string;revision:number}|null>(null);
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot), [query, setQuery] = useState(''), [selection, setSelection] = useState<AiSelection | null>(null), [reviewRequest,setReviewRequest]=useState<{id:number;cueId:string;documentKey:string;revision:number;target:string}|null>(null),[navigationRequest,setNavigationRequest]=useState<{id:number;cueId:string;documentKey:string;revision:number}|null>(null);
    const [readingViews]=useState(()=>(window as any).Coconut.createReadingViews({getSessionStorage:()=>sessionStorage,getStorage:()=>localStorage}));
    useNavigation(store,state);
    const document = store.getDocument(), unsaved = state.save.unsaved > 0;
    const media=document?store.getMedia(document.key):null;
    const listening=useMemo(()=>document&&media?listeningPreference(document.key,media.identity,localStorage,store.setMessage):null,[document?.key,media?.identity]);
    const savedView=document?readingViews.get(document.key):null;
    const exportBackup = () => { const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'coconut-library', version: 1, documents: store.recoveryDocuments(), active: state.activeKey })], { type: 'application/json' })); const link = window.document.createElement('a'); link.href = url; link.download = 'coconut-reading-backup.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); store.setMessage('已发起备份下载，请打开文件核对。下载不代表内容已保存。'); };
    return <div className="react-app"><NativeClose store={store}/><aside className="app-sidebar"><a className="app-brand" href="#discover" onClick={event => { event.preventDefault(); store.navigate('discover'); }}>coconut<span>声音，留下来。</span></a><nav aria-label="主要导航"><button aria-current={state.workspace === 'discover' ? 'page' : undefined} disabled={state.dirty} onClick={() => store.navigate('discover')}>发现与添加</button><button aria-current={state.workspace === 'library' ? 'page' : undefined} disabled={state.dirty} onClick={() => store.navigate('library')}>我的内容 <span>{state.documents.length}</span></button>{document && <button disabled={state.dirty} aria-current={state.workspace === 'read' ? 'page' : undefined} onClick={() => store.select(document.key)}>继续阅读</button>}</nav><div className="sidebar-foot"><NativeShell store={store}/><ReadingPreferences controller={preferences}/><button data-native-command="backup-library" onClick={exportBackup}>导出完整备份</button><a href="compatibility.html" onClick={event => { if (unsaved || state.dirty) {
        event.preventDefault();
        store.setMessage('请先保存或导出本页修改，再打开兼容阅读器。');
    } }}>兼容与恢复</a><span>本地阅读 · 原文与原声</span></div></aside><main id="main-content"><header className="app-header"><span>{state.workspace === 'read' ? document?.title : state.workspace === 'library' ? '我的内容' : '发现'}</span><span role="status">{state.save.status === 'saved' ? '已保存' : state.save.status === 'pending' ? '正在保存…' : '保存未完成'}</span>{unsaved && <button onClick={() => void store.retry()}>重试保存</button>}</header>{state.message && <p className="app-message" role="status">{state.message}</p>}{state.dirty && <p className="app-message">有尚未提交的编辑，请保存或取消后切换内容。</p>}
 {state.workspace === 'discover' && <Discover store={store}/>}
 {state.workspace === 'library' && <Library store={store}/>}
 {state.workspace === 'read' && document && <MediaSource key={'media:' + document.key} store={store} documentKey={document.key}/>}
 {state.workspace === 'read' && document?.project_kind==='reading_collection'&&<Collection store={store} document={document}/>}
 {state.workspace === 'read' && document && document.project_kind!=='reading_collection' && <ReaderWorkspace key={'reader:'+document.key} document={document} revision={store.getRevision(document.key)} media={media} initialView={savedView?{documentKey:document.key,...savedView}:undefined} shortcutsEnabled={preferences.values.shortcuts!=='off'} onOpenSummary={()=>setSummaryRequest({id:Date.now(),documentKey:document.key,revision:store.getRevision(document.key)})} onViewChange={view=>readingViews.record(view.documentKey,view.cueId,view.mode)} resumePosition={listening?.record} onMediaProgress={(seconds,duration)=>listening?.save(seconds,duration)} saveStatus={state.save.status} onSaveDocument={store.commitDocument} onReadingPosition={() => { }} onDirtyChange={store.setDirty} navigationRequest={navigationRequest} onReviewTranslation={cueId=>setReviewRequest({id:Date.now(),cueId,documentKey:document.key,revision:store.getRevision(document.key),target:String(document.translation_view||'zh')})} onVisibleSelection={value=>setSelection(previous=>previous?.documentKey===value.key&&previous.exactText&&previous.segments.every(old=>value.cueIds.includes(old.id)&&document.segments.some(cue=>cue.id===old.id&&cue.text===old.text))?previous:previous?.documentKey===value.key&&previous.revision===String(value.revision)&&!previous.exactText&&JSON.stringify(previous.segments.map(cue=>cue.id))===JSON.stringify(value.cueIds)?previous:{documentKey:value.key,revision:String(value.revision),segments:document.segments.filter(cue=>value.cueIds.includes(cue.id))})} onRequestAi={value => setSelection({ documentKey: value.key, revision: String(value.revision), exactText: value.text, scope: value.scope, segments: document.segments.filter(cue => value.cueIds.includes(cue.id)) })}/>}
 {state.workspace === 'read' && document && document.project_kind!=='reading_collection' && <AiPanel key={'ai:'+document.key} store={store} reviewRequest={reviewRequest} openRequest={summaryRequest} onNavigate={cueId=>setNavigationRequest({id:Date.now(),cueId,documentKey:document.key,revision:store.getRevision(document.key)})} selection={selection?.documentKey === document.key ? selection : null}/>}
 {state.workspace==='read'&&document?.project_kind==='audio_only'&&<details className="recovery-options"><summary>已有字幕？恢复到此原声项目</summary><SubtitleRecovery store={store} targetKey={document.key}/></details>}
 <NativeMedia store={store} documentKey={state.workspace==='read'?state.activeKey:null}/>
 <IngestionPanel store={store} currentKey={state.workspace==='read'?state.activeKey:null}/>
 </main></div>;
}
