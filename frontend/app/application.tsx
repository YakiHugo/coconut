import React, { useState, useEffect, useMemo, useSyncExternalStore, useRef } from 'react';
import type { AppStore } from './store';
import {listeningPreference} from './preferences';
import {Settings} from './settings';
import {NativeClose} from './native-close';
import {Library,Collection} from './library';
import {openNotebookSource} from './notebook-source';
import type {ReaderNavigationRequest} from '../reader-workspace/contracts';
import {NativeMedia} from './native-media';
import {IngestionPanel} from './ingestion-panel';
import {useNavigation} from './navigation';
import { MediaSource } from './media-source';
import { AiPanel, type SelectionAiRequest } from './ai';
import type { AiSelection } from '../ai-workspace/contracts';
import {SubtitleRecovery} from '../recovery-import/recovery';
import { Discover } from './discover';
import {ToastProvider, useToast} from './toast';
import {ActivityCenter,type TaskOverview} from './activity';
import { ReaderWorkspace } from '../reader-workspace/workspace';
import '../reader-workspace/workspace.css';
import {useReadingPreferences} from '../reading-preferences/preferences';
import '../reading-preferences/preferences.css';
export function Application({ store,storageSettings }: {
    store: AppStore;storageSettings?:React.ReactNode;
}) {
    return <ToastProvider><ApplicationContent store={store} storageSettings={storageSettings}/></ToastProvider>;
}
function ApplicationContent({store,storageSettings}: {store:AppStore;storageSettings?:React.ReactNode}) {
    const [settingsOpen,setSettingsOpen]=useState(false);
    const [taskHost,setTaskHost]=useState<HTMLDivElement|null>(null);
    const [tasks,setTasks]=useState<TaskOverview>({total:0,running:0,attention:0});
    const notify = useToast();
    const preferences=useReadingPreferences();
    const [summaryRequest,setSummaryRequest]=useState<{id:number;documentKey:string;revision:number}|null>(null);
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot), [query, setQuery] = useState(''), [selection, setSelection] = useState<AiSelection | null>(null), [reviewRequest,setReviewRequest]=useState<{id:number;cueId:string;documentKey:string;revision:number;target:string}|null>(null),[navigationRequest,setNavigationRequest]=useState<ReaderNavigationRequest|null>(null);
    const navigationId=useRef(0);
    const [selectionRequest,setSelectionRequest]=useState<SelectionAiRequest|null>(null),[aiReturnRequest,setAiReturnRequest]=useState<{id:number;documentKey:string}|undefined>();
    const [readingViews]=useState(()=>(window as any).Coconut.createReadingViews({getSessionStorage:()=>sessionStorage,getStorage:()=>localStorage}));
    useNavigation(store,state);
    const document = store.getDocument(), unsaved = state.save.unsaved > 0;
    useEffect(() => {if (state.message && !unsaved) notify({message: state.message});}, [state.message, unsaved, notify]);
    useEffect(()=>{
        setSelectionRequest(previous=>state.workspace!=='read'||previous?.selection.documentKey!==document?.key?null:previous);
        setSelection(previous=>state.workspace!=='read'||previous?.documentKey!==document?.key?null:previous);
        if(state.workspace!=='read')setAiReturnRequest(undefined);
    },[state.workspace,document?.key]);
    useEffect(()=>{setSettingsOpen(false);},[state.workspace,state.activeKey]);
    const media=document?store.getMedia(document.key):null;
    const listening=useMemo(()=>document&&media?listeningPreference(document.key,media.identity,localStorage,store.setMessage):null,[document?.key,media?.identity]);
    const savedView=document?readingViews.get(document.key):null;
    const exportBackup = () => { const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'coconut-library', version: 1, documents: store.recoveryDocuments(), active: state.activeKey })], { type: 'application/json' })); const link = window.document.createElement('a'); link.href = url; link.download = 'coconut-reading-backup.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); store.setMessage('已发起备份下载，请打开文件核对。下载不代表内容已保存。'); };
    return <div className="react-app"><NativeClose store={store}/><aside className="app-sidebar"><a className="app-brand" href="#discover" onClick={event => { event.preventDefault(); setSettingsOpen(false);store.navigate('discover'); }}>coconut<span>LISTEN / READ / KEEP</span></a><nav aria-label="主要导航"><button aria-current={state.workspace === 'discover' ? 'page' : undefined} disabled={state.dirty} onClick={() => {setSettingsOpen(false);store.navigate('discover');}}>添加内容</button><button aria-current={state.workspace === 'library' ? 'page' : undefined} disabled={state.dirty} onClick={() => {setSettingsOpen(false);store.navigate('library');}}>我的内容 <span>{state.documents.length}</span></button>{document && <button disabled={state.dirty} aria-current={state.workspace === 'read' ? 'page' : undefined} onClick={() => {setSettingsOpen(false);store.select(document.key);}}>继续阅读</button>}</nav><div className="sidebar-foot"><Settings store={store} preferences={preferences} open={settingsOpen} onOpenChange={setSettingsOpen} onExportBackup={exportBackup} storageSettings={storageSettings}/></div></aside><main id="main-content" inert={settingsOpen}><header className="app-header"><span className="app-breadcrumb"><span>资料库</span><span aria-hidden="true">/</span>{state.workspace === 'read' ? document?.title : state.workspace === 'library' ? '我的内容' : '添加内容'}</span><div className="app-header-tools"><span className="save-indicator" data-state={state.save.status} role="status">{state.save.status === 'saved' ? '已保存' : state.save.status === 'pending' ? '正在保存…' : '保存未完成'}</span>{unsaved && <button onClick={() => void store.retry()}>重试保存</button>}<ActivityCenter save={state.save} tasks={tasks} onTaskHost={setTaskHost}/></div></header>{state.message && unsaved && <p className="app-message" role="status">{state.message}</p>}{state.dirty && <p className="app-message">有尚未提交的编辑，请保存或取消后切换内容。</p>}
 {state.workspace === 'discover' && <Discover store={store}/>}
 {state.workspace === 'library' && <Library store={store} onOpenSource={capture=>{const request=openNotebookSource(store,capture,++navigationId.current);if(request)setNavigationRequest(request);}}/>}
 {state.workspace === 'read' && document && <MediaSource key={'media:' + document.key} store={store} documentKey={document.key}/>}
 {state.workspace === 'read' && document?.project_kind==='reading_collection'&&<Collection store={store} document={document}/>}
 {state.workspace === 'read' && document && document.project_kind!=='reading_collection' && <ReaderWorkspace key={'reader:'+document.key} document={document} revision={store.getRevision(document.key)} media={media} initialView={savedView?{documentKey:document.key,...savedView}:undefined} aiReturnRequest={aiReturnRequest} shortcutsEnabled={preferences.values.shortcuts!=='off'} onOpenSummary={()=>setSummaryRequest({id:Date.now(),documentKey:document.key,revision:store.getRevision(document.key)})} onViewChange={view=>readingViews.record(view.documentKey,view.cueId,view.mode)} resumePosition={listening?.record} onMediaProgress={(seconds,duration)=>listening?.save(seconds,duration)} saveStatus={state.save.status} onSaveDocument={store.commitDocument} onReadingPosition={() => { }} onDirtyChange={store.setDirty} navigationRequest={navigationRequest} onNavigationHandled={request=>setNavigationRequest(current=>current===request?null:current)} onReviewTranslation={cueId=>setReviewRequest({id:Date.now(),cueId,documentKey:document.key,revision:store.getRevision(document.key),target:String(document.translation_view||'zh')})} onVisibleSelection={value=>setSelection(previous=>previous?.documentKey===value.key&&previous.exactText&&previous.segments.every(old=>value.cueIds.includes(old.id)&&document.segments.some(cue=>cue.id===old.id&&cue.text===old.text))?previous:previous?.documentKey===value.key&&previous.revision===String(value.revision)&&!previous.exactText&&JSON.stringify(previous.segments.map(cue=>cue.id))===JSON.stringify(value.cueIds)?previous:{documentKey:value.key,revision:String(value.revision),segments:document.segments.filter(cue=>value.cueIds.includes(cue.id))})} onRequestAi={value => {const selection={documentKey:value.key,revision:String(value.revision),exactText:value.text,scope:value.scope,segments:document.segments.filter(cue=>value.cueIds.includes(cue.id))};setSelection(selection);setSelectionRequest({id:++navigationId.current,intent:value.intent||'understand',selection});}}/>}
 {state.workspace === 'read' && document && document.project_kind!=='reading_collection' && <AiPanel key={'ai:'+document.key} store={store} selectionRequest={selectionRequest} onReturnToReading={()=>setAiReturnRequest({id:++navigationId.current,documentKey:document.key})} reviewRequest={reviewRequest} openRequest={summaryRequest} onNavigate={cueId=>setNavigationRequest({id:++navigationId.current,cueId,documentKey:document.key,revision:store.getRevision(document.key)})} selection={selection?.documentKey === document.key ? selection : null}/>}
 {state.workspace==='read'&&document?.project_kind==='audio_only'&&<details className="recovery-options"><summary>已有字幕？恢复到此原声项目</summary><SubtitleRecovery store={store} targetKey={document.key}/></details>}
 <NativeMedia store={store} documentKey={state.workspace==='read'?state.activeKey:null}/>
 <IngestionPanel store={store} currentKey={state.workspace==='read'?state.activeKey:null} taskHost={taskHost} onTasksChange={setTasks}/>
 </main></div>;
}
