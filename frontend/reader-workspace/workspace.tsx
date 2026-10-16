import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReaderCue, ReaderDocument, ReaderWorkspaceProps, ReaderSourceTarget } from './contracts';
import { captureSourceSelection, filterCues, time, type SourceSelection } from './domain';
import { ReaderPlayer, type SeekIntent } from './player';
import {ReaderSummary} from './summary';
import {useReaderKeyboard} from '../reading-preferences/keyboard';
import { ReaderAnnotations, SourceCorrections } from './annotations';
import { PassageView, passageDomain } from './passages';
import { BilingualCapture } from './bilingual';
import { ReaderExports } from './exports';
import { ReaderSource } from './source';
type Domain = {
    exactExcerptTranslation: (record: unknown) => {
        text: string;
        language: string;
        providers: string[];
        reviewStates: string[];
    } | null;
    translationCurrent: (cue: ReaderCue, doc: ReaderDocument, value: unknown) => boolean;
    createPlaybackIndex: (cues: ReaderCue[]) => {
        find: (seconds: number) => ReaderCue | undefined;
    };
    exactExcerptSnapshot: (doc: ReaderDocument, cues: ReaderCue[], separators: string[], from: number, to: number, metadata: {
        id: string;
        createdAt: string;
    }) => {
        id: string;
        text: string;
        [key: string]: unknown;
    };
    exactExcerptDuplicate: (doc: ReaderDocument, record: unknown) => unknown;
    exactExcerptFreshness: (record: unknown, doc: ReaderDocument) => string;
    mediaTimingOffset: (doc: ReaderDocument, identity: string) => number;
};
const domain = () => (window as unknown as {
    Coconut: Domain;
}).Coconut;
const PAGE = 50;
const UNCONFIRMED_SAVE = '尚未保存。内容可能已更新或存储暂不可用，请保留草稿后重试。';
export function ReaderWorkspace(props: ReaderWorkspaceProps) { return <WorkspaceSession key={props.document.key} {...props}/>; }
function WorkspaceSession({ document: doc, revision, media, onSaveDocument, onReadingPosition, onRequestAi, onDirtyChange, onMediaProgress, saveStatus, onVisibleSelection, onReviewTranslation, navigationRequest, onNavigationHandled, initialView, onViewChange, resumePosition, shortcutsEnabled=false, onOpenSummary }: ReaderWorkspaceProps) {
    const validInitialView=initialView?.documentKey===doc.key&&doc.segments.some(cue=>cue.id===initialView.cueId)?initialView:null;
    const initialCue=validInitialView?.cueId||doc.readingPosition||doc.segments[0]?.id||'';
    const temporaryNavigation=useRef(false),viewCallback=useRef(onViewChange);viewCallback.current=onViewChange;
    const [mode, setMode] = useState<'transcript'|'passages'|'summary'>(validInitialView?.mode||'transcript'), [annotationDirty, setAnnotationDirty] = useState(false), [correctionDirty, setCorrectionDirty] = useState(false), [query, setQuery] = useState(''), [notesOnly, setNotesOnly] = useState(false), [speaker, setSpeaker] = useState<string | null>(null), [page, setPage] = useState(Math.floor(Math.max(0, doc.segments.findIndex(c => c.id === initialCue)) / PAGE)), [position, setPosition] = useState(initialCue), [clock, setClock] = useState(0), [follow, setFollow] = useState(false), [seek, setSeek] = useState<SeekIntent | null>(null), [status, setStatus] = useState(''), [busy, setBusy] = useState(false), [drafts, setDrafts] = useState<Record<string, string>>({}), [projectDraft, setProjectDraft] = useState<string | null>(null), [offset, setOffset] = useState(''), [offsetStarted,setOffsetStarted]=useState(false), [jump, setJump] = useState(''), [selection, setSelection] = useState<(SourceSelection & {
        revision: number;
    }) | null>(null);
    const handledNavigation=useRef<ReaderWorkspaceProps['navigationRequest']>(null);
    const [sourceFocus,setSourceFocus]=useState<{id:number;target:ReaderSourceTarget}|null>(null);
    const scopeRef=useRef<HTMLElement|null>(null),searchRef=useRef<HTMLInputElement|null>(null),helpClose=useRef<HTMLButtonElement|null>(null),helpDialog=useRef<HTMLDialogElement|null>(null);
    const [keyboardHelp,setKeyboardHelp]=useState(false);
    const readingReturn=useRef<{revision:number;mode:'transcript'|'passages';query:string;notesOnly:boolean;speaker:string|null;page:number;position:string}|null>(null);
    const unconfirmedSave=useRef<{key:string;revision:number;content:string}|null>(null);
    const latest = useRef({ doc, revision });
    latest.current = { doc, revision };
    const attachment=useRef<{signature:string|null;id:number}>({signature:null,id:0});
    const mediaSignature=media?JSON.stringify([media.identity,media.url]):null;
    if(attachment.current.signature!==mediaSignature)attachment.current={signature:mediaSignature,id:attachment.current.id+1};
    const visibleCallback=useRef(onVisibleSelection);visibleCallback.current=onVisibleSelection;
    const dirtyCallback = useRef(onDirtyChange);
    dirtyCallback.current = onDirtyChange;
    const host = useRef<HTMLDivElement>(null), seekId = useRef(0), saving = useRef(false), mounted = useRef(true), originalDraftRevision = useRef<number | null>(null);
    const dirty = Object.keys(drafts).length > 0 || projectDraft !== null;
    // A failed durable receipt may already have applied this edit to the live store.
    // Once that exact content is observable, it is no longer an unsubmitted draft;
    // the shell keeps the separate unsaved-content warning and retry controls.
    useEffect(() => {
        if (originalDraftRevision.current === null || originalDraftRevision.current === revision)
            return;
        if (Object.entries(drafts).every(([id, text]) => doc.notes?.[id] === text) && (projectDraft === null || doc.project_note === projectDraft)) {
            setDrafts({});
            setProjectDraft(null);
            originalDraftRevision.current = null;
        }
    }, [doc, revision, drafts, projectDraft]);
    useEffect(()=>{
        const receipt=unconfirmedSave.current;
        if(!receipt||busy||saveStatus!=='saved'||receipt.key!==doc.key||receipt.revision!==revision||receipt.content!==JSON.stringify(doc))return;
        unconfirmedSave.current=null;
        setStatus(current=>current===UNCONFIRMED_SAVE?'已保存':current);
    },[doc,revision,saveStatus,busy]);
    const calibrated = media ? domain().mediaTimingOffset(doc, media.identity) : 0;
    const calibrationDirty=offsetStarted&&(offset.trim()===''||!Number.isFinite(Number(offset))||Number(offset)!==calibrated);
    const anyDirty = dirty || annotationDirty || correctionDirty || calibrationDirty;
    const reportAnnotation = useCallback((value: boolean) => setAnnotationDirty(value), []), reportCorrection = useCallback((value: boolean) => setCorrectionDirty(value), []);
    useEffect(() => { dirtyCallback.current?.(anyDirty); }, [anyDirty]);
    useEffect(() => () => dirtyCallback.current?.(false), []);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useEffect(() => {
        if (!anyDirty)
            return;
        const listener = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
        window.addEventListener('beforeunload', listener);
        return () => window.removeEventListener('beforeunload', listener);
    }, [anyDirty]);
    useEffect(() => { setSelection(null); }, [revision]);
    useEffect(() => {
        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && selection) {
                setSelection(null);
                event.preventDefault();
            }
        };
        window.addEventListener('keydown', escape);
        return () => window.removeEventListener('keydown', escape);
    }, [selection]);

    const playbackIndex = useMemo(() => domain().createPlaybackIndex(doc.segments), [doc.segments, revision]);
    const activeCue = playbackIndex.find(clock - calibrated);
    const filtered = useMemo(() => filterCues(doc, query, notesOnly, speaker), [doc, query, notesOnly, speaker]);
    const maxPage = Math.max(0, Math.ceil(filtered.length / PAGE) - 1), visiblePage = Math.min(page, maxPage), shown = filtered.slice(visiblePage * PAGE, (visiblePage + 1) * PAGE);
    const visibleSignature=JSON.stringify(mode==='summary'?[]:shown.map(cue=>cue.id));
    useEffect(()=>{visibleCallback.current?.({key:doc.key,revision,cueIds:JSON.parse(visibleSignature)});},[doc.key,revision,visibleSignature,query,notesOnly,speaker,visiblePage,mode]);
    const speakers = [...new Set(doc.segments.map(c => c.speaker || ''))];
    const locate = (id: string,temporary=false) => {
        temporaryNavigation.current=temporary;
        const index = filtered.findIndex(c => c.id === id);
        if (index < 0) {
            setQuery('');
            setNotesOnly(false);
            setSpeaker(null);
            setPage(Math.floor(doc.segments.findIndex(c => c.id === id) / PAGE));
        }
        else
            setPage(Math.floor(index / PAGE));
        setPosition(id);
        onReadingPosition(id);
    };
    useEffect(()=>{
        const request=navigationRequest;
        if(!request||handledNavigation.current===request)return;
        handledNavigation.current=request;
        if(request.documentKey!==doc.key||request.revision!==revision||(request.source&&request.source.document!==doc)||anyDirty||busy){
            if(request.documentKey===doc.key)setStatus(anyDirty||busy?'请先保存或取消编辑，再定位来源。':'记录来源已变化，请返回笔记重新打开。');
            onNavigationHandled?.(request);return;
        }
        if(request.source){
            const target=request.source.target;
            temporaryNavigation.current=true;setFollow(false);setSelection(null);
            if(target.kind==='cue'||target.kind==='exact-excerpt'){
                if(target.cueId&&doc.segments.some(cue=>cue.id===target.cueId)){
                    setMode('transcript');setQuery('');setNotesOnly(false);setSpeaker(null);
                    setPage(Math.floor(doc.segments.findIndex(cue=>cue.id===target.cueId)/PAGE));setPosition(target.cueId);
                }
                setStatus(target.kind==='exact-excerpt'?(target.cueId?(target.freshness==='current'?'已定位摘录的当前原文；摘录仍保留选取时快照。':'已定位当前原文；来源已更新，摘录仍是历史快照。'):'原片段已缺失或顺序已变化；已定位历史摘录，未猜测当前原文。'):'已定位笔记与摘录的原文片段。');
            }else if(target.kind==='bookmark'){
                if(media){seekTo(target.time);setStatus('已定位时间书签 '+time(target.time)+'，未自动播放。');}
                else setStatus('已定位时间书签 '+time(target.time)+'。原声尚未载入，载入后请点击此书签定位。');
            }else setStatus('已定位项目笔记。');
            setSourceFocus({id:request.id,target});
        }else if(doc.segments.some(cue=>cue.id===request.cueId)){
            if(mode==='summary')navigateSummary(request.cueId);else locate(request.cueId,true);
        }
        onNavigationHandled?.(request);
    },[navigationRequest,doc,revision,anyDirty,busy]);
    useEffect(()=>{
        const target=sourceFocus?.target;if(!target)return;
        let element:HTMLElement|null=null;
        if(target.kind==='cue'||(target.kind==='exact-excerpt'&&target.cueId)){
            const row=host.current?.querySelector<HTMLElement>('[data-cue-id="'+CSS.escape(target.cueId!)+'"]');
            if(target.kind==='cue'){const notes=row?.querySelector('details');if(notes)notes.open=true;}
            element=row?.querySelector<HTMLElement>('.rw-original')||null;
        }else if(target.kind==='exact-excerpt')element=scopeRef.current?.querySelector<HTMLElement>('[data-excerpt-id="'+CSS.escape(target.excerptId)+'"]')||null;
        else if(target.kind==='bookmark')element=scopeRef.current?.querySelector<HTMLElement>('[data-bookmark-id="'+CSS.escape(target.bookmarkId)+'"] button')||null;
        else element=scopeRef.current?.querySelector<HTMLElement>('[aria-label="项目笔记"]')||null;
        element?.focus({preventScroll:true});element?.scrollIntoView?.({block:'center'});
    },[sourceFocus]);
    useEffect(()=>{if((mode!=='summary'&&(query.trim()||notesOnly||speaker!==null))||temporaryNavigation.current)return;const cueId=shown.some(cue=>cue.id===position)?position:shown[0]?.id;if(cueId)viewCallback.current?.({documentKey:doc.key,cueId,mode});},[doc.key,position,visiblePage,visibleSignature,mode,query,notesOnly,speaker]);
    useEffect(() => {
        if (follow && activeCue) {
            locate(activeCue.id);
        }
    }, [follow, activeCue?.id]);
    useEffect(() => {
        if (!position)
            return;
        const element = host.current?.querySelector(`[data-cue-id="${CSS.escape(position)}"]`);
        element?.scrollIntoView?.({ block: 'nearest' });
    }, [position, visiblePage]);
    const changeMode=(next:'transcript'|'passages'|'summary')=>{temporaryNavigation.current=false;setSelection(null);setFollow(false);if(next==='summary'&&mode!=='summary')readingReturn.current={revision,mode,query,notesOnly,speaker,page,position};setMode(next);};
    const returnToReading=()=>{const saved=readingReturn.current;if(saved&&saved.revision===revision&&doc.segments.some(cue=>cue.id===saved.position)){setMode(saved.mode);setQuery(saved.query);setNotesOnly(saved.notesOnly);setSpeaker(saved.speaker);setPage(saved.page);setPosition(saved.position);}else{setMode('transcript');setQuery('');setNotesOnly(false);setSpeaker(null);setPage(Math.floor(Math.max(0,doc.segments.findIndex(cue=>cue.id===position))/PAGE));if(saved)setStatus('原文已更新，已返回当前稿中的阅读位置。');}readingReturn.current=null;temporaryNavigation.current=false;};
    const navigateSummary=(cueId:string)=>{if(latest.current.doc!==doc||latest.current.revision!==revision)return;const index=doc.segments.findIndex(cue=>cue.id===cueId);if(index<0)return;setMode(readingReturn.current?.mode||'transcript');setQuery('');setNotesOnly(false);setSpeaker(null);setPage(Math.floor(index/PAGE));setPosition(cueId);onReadingPosition(cueId);temporaryNavigation.current=true;};
    useEffect(()=>{
        if(!keyboardHelp)return;
        const previous=document.activeElement as HTMLElement|null,dialog=helpDialog.current,close=helpClose.current;
        // The browser owns top-layer background exclusion; React owns its lifetime.
        dialog?.showModal();close?.focus();
        return()=>{const restore=document.activeElement===close||document.activeElement===dialog||document.activeElement===document.body; if(dialog?.open)dialog.close();if(restore&&previous?.isConnected)previous.focus({preventScroll:true});};
    },[keyboardHelp]);
    const keyboardPlayAttempt=useRef(0);
    const PLAY_FAILURE='播放未能开始，请使用播放器按钮。';
    const currentPlayer=()=>scopeRef.current?.querySelector<HTMLMediaElement>('audio,video')||null;
    useEffect(()=>{
        const player=currentPlayer();
        const cancel=()=>{keyboardPlayAttempt.current++;};
        const playing=()=>{cancel();setStatus(value=>value===PLAY_FAILURE?'':value);};
        player?.addEventListener('pause',cancel);player?.addEventListener('playing',playing);window.addEventListener('pagehide',cancel);
        return()=>{cancel();player?.removeEventListener('pause',cancel);player?.removeEventListener('playing',playing);window.removeEventListener('pagehide',cancel);};
    },[mediaSignature,attachment.current.id]);
    const toggleKeyboardPlayback=()=>{
        const player=currentPlayer();if(!player||!Number.isFinite(player.duration)||player.duration<=0)return false;
        const attempt=++keyboardPlayAttempt.current;
        if(!player.paused){player.pause();return true;}
        setStatus(value=>value===PLAY_FAILURE?'':value);
        const failed=(error:unknown)=>{if(!mounted.current||attempt!==keyboardPlayAttempt.current||currentPlayer()!==player||(error as {name?:string})?.name==='AbortError')return;setStatus(PLAY_FAILURE);};
        try{void player.play().then(()=>{if(mounted.current&&attempt===keyboardPlayAttempt.current&&currentPlayer()===player)setStatus(value=>value===PLAY_FAILURE?'':value);},failed);}catch(error){failed(error);}
        return true;
    };
    const shiftPlayback=(offset:number)=>{const player=currentPlayer();if(!player||!media||!Number.isFinite(player.duration)||player.duration<=0)return false;seekTo(Math.max(0,Math.min(player.duration,player.currentTime+offset)));return true;};
    useReaderKeyboard({scopeRef,searchRef,enabled:shortcutsEnabled,active:!keyboardHelp,actions:{find:()=>{if(mode==='summary'||!searchRef.current)return false;searchRef.current.focus();searchRef.current.select();return true;},help:()=>{setKeyboardHelp(true);return true;},back:()=>shiftPlayback(-5),forward:()=>shiftPlayback(5),play:toggleKeyboardPlayback,locate:()=>{if(!media||!activeCue)return false;if(mode==='summary')navigateSummary(activeCue.id);else locate(activeCue.id);return true;}}});
    const save = async (next: ReaderDocument, expectedRevision = revision) => {
        if (saving.current)
            return false;
        saving.current = true;
        unconfirmedSave.current=null;
        setBusy(true);
        try {
            const ok = await onSaveDocument(next, { key: doc.key, revision: expectedRevision });
            if (mounted.current)
                setStatus(ok ? '已保存' : UNCONFIRMED_SAVE);
            const applied = latest.current.doc.key === next.key && latest.current.revision !== expectedRevision && Object.entries(next).every(([key, value]) => JSON.stringify(latest.current.doc[key]) === JSON.stringify(value));
            if(!ok&&applied)unconfirmedSave.current={key:next.key,revision:latest.current.revision,content:JSON.stringify(latest.current.doc)};
            return ok || applied;
        }
        catch (error) {
            if (mounted.current)
                setStatus('保存失败：' + String(error instanceof Error ? error.message : error));
            return false;
        }
        finally {
            saving.current = false;
            if (mounted.current)
                setBusy(false);
        }
    };
    const startDraft = () => {
        if (originalDraftRevision.current === null)
            originalDraftRevision.current = revision;
    };
    const saveDrafts = async () => {
        const expected = originalDraftRevision.current ?? revision;
        if (expected !== revision) {
            setStatus('内容已在其他操作中更新。草稿仍保留，请复制草稿后取消，再重新编辑。');
            return;
        }
        const next = { ...doc, notes: { ...doc.notes, ...drafts }, ...(projectDraft !== null ? { project_note: projectDraft } : {}) };
        if (await save(next, expected)) {
            setDrafts({});
            setProjectDraft(null);
            originalDraftRevision.current = null;
        }
    };
    const seekTo = (seconds: number, end?: number, play = false) => {
        if (!media) {
            setStatus('此项目当前没有可播放的原文件。来源信息与文字稿仍保留。');
            return;
        }
        setSeek({ id: ++seekId.current, owner: media.identity, attachmentURL:media.url, attachmentId:attachment.current.id, seconds, end, play });
    };
    const capture = () => {
        if (!host.current)
            return;
        const value = captureSourceSelection(host.current, doc, window.getSelection(), passageDomain().separator);
        if (value)
            setFollow(false);
        setSelection(value ? { ...value, revision } : null);
    };
    const excerpt = async () => {
        if (!selection || selection.revision !== revision)
            return;
        const cues = selection.cueIds.map(id => doc.segments.find(c => c.id === id)!);
        if (cues.some(c => !c))
            return;
        try {
            const record = domain().exactExcerptSnapshot(doc, cues, selection.separators, selection.from, selection.to, { id: crypto.randomUUID(), createdAt: new Date().toISOString() });
            if (domain().exactExcerptDuplicate(doc, record)) {
                setStatus('这段原话已经保存。');
                return;
            }
            if (await save({ ...doc, exact_excerpts: [...(doc.exact_excerpts || []), record] }))
                setSelection(null);
        }
        catch (e) {
            setStatus(String(e instanceof Error ? e.message : e));
        }
    };
    return <article className="reader-workspace" ref={scopeRef} tabIndex={0} aria-label="阅读与原声工作区"><header><p className="rw-eyebrow">原文与原声</p><h1>{doc.title}</h1><p>{doc.segments.length ? `${doc.segments.length} 个片段 · ${time(doc.segments.at(-1)?.end || 0)}` : '原声项目 · 尚无文字稿'}</p>{saveStatus && saveStatus!=='saved' && <p role="status">{saveStatus==='pending'||saveStatus==='saving'?'正在保存…':'保存尚未确认，请保留本页修改。'}</p>}</header><ReaderSource doc={doc}/>
 {media ? <ReaderPlayer key={attachment.current.id} media={media} seek={seek?.attachmentId===attachment.current.id?seek:null} onTime={setClock} onProgress={onMediaProgress} resumePosition={resumePosition} onResume={seconds=>seekTo(seconds)}/> : <p className="rw-media-unavailable">{doc.local_media_source ? `原文件「${doc.local_media_source.name}」未在当前页面载入。文件关联信息不包含媒体文件。` : '尚无可播放的媒体。已导入的文字稿可以继续阅读。'}</p>}
 {media && doc.segments.length > 0 && <div className="rw-toolbar"><label><input type="checkbox" checked={follow} disabled={mode==='summary'} onChange={e => setFollow(e.target.checked)}/> 跟随播放</label><button type="button" disabled={!activeCue} onClick={() => activeCue && (mode==='summary'?navigateSummary(activeCue.id):locate(activeCue.id))}>定位当前原话</button><details><summary>时间校准 · {calibrated} 秒</summary><p>仅调整播放映射，不修改原始字幕时间。正数表示媒体比字幕晚。</p><label>偏移秒数 <input type="number" min="-3600" max="3600" step="0.1" value={offset} disabled={busy} onChange={e => {setOffsetStarted(true);setOffset(e.target.value);}}/></label><button disabled={busy || dirty || annotationDirty || correctionDirty || !media.identity.startsWith('file-candidate-v1:') || offset.trim() === '' || !Number.isFinite(Number(offset)) || Math.abs(Number(offset)) > 3600} onClick={async() => {if(await save({ ...doc, media_timing: { version: 1, identity: media.identity, offset: Number(offset) } })){setOffsetStarted(false);setOffset('');}}}>保存校准</button><button disabled={busy} onClick={()=>{setOffsetStarted(false);setOffset('');}}>取消校准草稿</button></details></div>}
 {doc.segments.length === 0 ? <section className="rw-empty"><h2>先播放原文件</h2><p>{doc.transcript_status === 'processing' ? '文字稿正在处理，完成前可以播放并记录想法。' : doc.transcript_status === 'unavailable' ? '没有取得可用的定时文字稿。尚未运行语音识别。' : '尚未取得文字稿，未运行语音识别。可以先播放并记录想法。'}</p></section> : <><nav className="rw-toolbar" aria-label="阅读筛选"><label>阅读方式 <select value={mode} onChange={e=>changeMode(e.target.value as typeof mode)}><option value="transcript">逐句</option><option value="passages">段落</option><option value="summary">摘要</option></select></label><label>搜索原话、译文和笔记 <input data-native-command="find-transcript" ref={searchRef} type="search" disabled={mode==='summary'} value={query} onChange={e => { setFollow(false); setQuery(e.target.value); setPage(0); }}/></label><label><input type="checkbox" checked={notesOnly} disabled={mode==='summary'} onChange={e => { setFollow(false); setNotesOnly(e.target.checked); setPage(0); }}/> 只看笔记</label>{speakers.length > 1 && <label>说话人 <select value={speaker === null ? '__all' : JSON.stringify(speaker)} disabled={mode==='summary'} onChange={e => { setFollow(false); setSpeaker(e.target.value === '__all' ? null : JSON.parse(e.target.value)); setPage(0); }}><option value="__all">全部</option>{speakers.map(s => <option value={JSON.stringify(s)} key={s}>{s || '未标注'}</option>)}</select></label>}<label>译文 <select value={doc.translation_view || ''} disabled={anyDirty || busy} onChange={e => save({ ...doc, translation_view: e.target.value })}><option value="">仅原文</option>{['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es'].map(lang => <option key={lang}>{lang}</option>)}</select></label></nav>
 <div hidden={mode==='summary'}><form className="rw-toolbar" onSubmit={e => {
                e.preventDefault();
                const parts = jump.trim().split(':');
                if (!parts.length || parts.length > 3 || parts.some(p => !/^\d+(?:\.\d+)?$/.test(p))) {
                    setStatus('请输入秒数或 分:秒 / 时:分:秒');
                    return;
                }
                const seconds = parts.reduce((value, p) => value * 60 + Number(p), 0);
                const cue = doc.segments.find(c => c.end >= seconds);
                if (cue) {
                    locate(cue.id);
                    seekTo(seconds + calibrated);
                }
                else
                    setStatus('时间超出文字稿范围');
            }}><label>跳转时间 <input value={jump} placeholder="12:34" onChange={e => setJump(e.target.value)}/></label><button type="submit">跳转</button><button type="button" disabled={busy || anyDirty || !position} onClick={() => save({ ...doc, readingPosition: position })}>读到这里</button>{doc.readingPosition && <button type="button" onClick={() => locate(doc.readingPosition!)}>回到已保存续点</button>}</form><p aria-live="polite">找到 {filtered.length} 个片段</p><div className="rw-cues" ref={host} onWheel={() => setFollow(false)} onTouchMove={() => setFollow(false)} onMouseUp={capture} onKeyUp={capture}>{mode === 'passages' ? <PassageView doc={doc} cues={shown} current={activeCue?.id} position={position} onLocate={locate} onListen={(start, end) => seekTo(start + calibrated, end + calibrated, true)}/> : shown.map(cue => <section key={cue.id} data-cue-id={cue.id} className={'rw-cue' + (cue.id === activeCue?.id ? ' rw-playing' : '') + (cue.id === position ? ' rw-current' : '')}><div className="rw-cue-meta"><button type="button" onClick={() => { locate(cue.id); seekTo(cue.start + calibrated); }}>{time(cue.start)}</button>{cue.speaker && <span>{cue.speaker}</span>}<button type="button" disabled={!media} onClick={() => seekTo(cue.start + calibrated, cue.end + calibrated, true)}>回听此段</button></div><p className="rw-original" tabIndex={0} data-source-id={cue.id}>{cue.text}</p>{doc.translation_view && cue.translations?.[doc.translation_view]?.text && <p className="rw-translation">{!domain().translationCurrent(cue, doc, cue.translations[doc.translation_view]) && <small>旧译文 · 原文已变化，请核对后更新。 </small>}{cue.translations[doc.translation_view].text}</p>}{onReviewTranslation&&doc.translation_view&&cue.translations?.[doc.translation_view]&&<button type="button" onClick={()=>onReviewTranslation(cue.id)}>核对译文</button>}<details open={Object.hasOwn(drafts, cue.id) ? true : undefined}><summary>笔记{doc.notes?.[cue.id] ? ' · 已有记录' : ''}</summary><textarea disabled={busy} aria-label={time(cue.start) + ' 的笔记'} value={drafts[cue.id] ?? doc.notes?.[cue.id] ?? ''} onChange={e => { startDraft(); setDrafts(old => ({ ...old, [cue.id]: e.target.value })); }}/></details></section>)}</div>
 <nav className="rw-toolbar" aria-label="片段分页"><button disabled={visiblePage === 0} onClick={() => {temporaryNavigation.current=false;setPage(visiblePage - 1);}}>上一页</button><span>第 {visiblePage + 1} / {maxPage + 1} 页</span><button disabled={visiblePage === maxPage} onClick={() => {temporaryNavigation.current=false;setPage(visiblePage + 1);}}>下一页</button></nav></div>{mode==='summary'&&<ReaderSummary doc={doc} onNavigate={navigateSummary} onReturn={returnToReading} onOpenSummary={onOpenSummary}/>}</>}
 {selection && <aside className="rw-selection" aria-label="选中文字操作"><p>{selection.text}</p><button disabled={busy || anyDirty} onClick={excerpt}>保存精确摘录</button><button onClick={() => onRequestAi({ key: doc.key, revision, text: selection.text, cueIds: selection.cueIds, scope: { kind: 'exact_source_selection', from: selection.from, to: selection.to, separators: selection.separators, cueIds: selection.cueIds } })}>询问 AI</button><button onClick={async () => {
                try {
                    await navigator.clipboard.writeText(selection.text);
                    setStatus('已复制选中原话');
                }
                catch {
                    setStatus('无法直接复制，请在选中文字上使用系统复制。');
                }
            }}>复制原话</button><BilingualCapture doc={doc} selection={selection} disabled={busy || anyDirty} save={save} onClose={() => setSelection(null)}/><button onClick={() => setSelection(null)}>关闭</button></aside>}
 <section><h2>项目笔记</h2><textarea disabled={busy} aria-label="项目笔记" value={projectDraft ?? doc.project_note ?? ''} onChange={e => { startDraft(); setProjectDraft(e.target.value); }}/>{dirty && <div className="rw-toolbar"><button disabled={busy} onClick={saveDrafts}>保存笔记</button><button disabled={busy} onClick={() => { setDrafts({}); setProjectDraft(null); originalDraftRevision.current = null; }}>取消修改</button><span>未提交的草稿</span></div>}</section>
 <section><h2>时间书签</h2><button disabled={!media || busy || anyDirty} onClick={() => save({ ...doc, timestamp_bookmarks: [...(doc.timestamp_bookmarks || []), { id: crypto.randomUUID(), time: Math.round(clock * 1000) / 1000, note: '' }] })}>记录当前播放位置 · {time(clock)}</button></section>
 {Boolean(doc.exact_excerpts?.length) && <section><h2>保存的精确摘录</h2>{doc.exact_excerpts!.map(record => <section key={record.id} data-excerpt-id={record.id} tabIndex={-1}><p>{record.text}</p>{domain().exactExcerptTranslation(record) && <p>摘录时译文（{domain().exactExcerptTranslation(record)!.language}）：{domain().exactExcerptTranslation(record)!.text} <small>分别选取并确认对应，不等于人工核对译文。</small></p>}<small>原文核对：{{ current: '与当前来源一致', stale: '来源或译文已更新；保留选取时快照', missing: '原片段已不在当前文稿；保留快照' }[domain().exactExcerptFreshness(record, doc)] || '待核对'}</small>{doc.exact_excerpt_notes?.[record.id] && <p>{doc.exact_excerpt_notes[record.id]}</p>}</section>)}</section>}
 <ReaderAnnotations doc={doc} revision={revision} disabled={busy || dirty || correctionDirty || calibrationDirty} save={save} locate={id=>locate(id,true)} seek={seekTo} position={position} dirty={reportAnnotation}/>{doc.segments.length > 0 && <SourceCorrections doc={doc} revision={revision} disabled={busy || dirty || annotationDirty || calibrationDirty} save={save} position={position} dirty={reportCorrection}/>}<button type="button" onClick={()=>setKeyboardHelp(true)}>阅读快捷键</button>{keyboardHelp&&<dialog ref={helpDialog} role="dialog" aria-modal="true" aria-label="阅读快捷键" onCancel={event=>{event.preventDefault();setKeyboardHelp(false);}} onClose={()=>setKeyboardHelp(false)} onKeyDown={event=>{if(event.key==='Tab'){event.preventDefault();helpClose.current?.focus();}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setKeyboardHelp(false);}}}><h2>阅读快捷键</h2><p>在阅读正文获得焦点时：/ 查找，J 后退5秒，L 前进5秒，K 播放/暂停，G 定位当前原话，? 显示帮助。Ctrl/⌘+F 在正文中查找。输入框、输入法和对话框中不接管这些键。</p><p>{shortcutsEnabled?'阅读快捷键已开启':'阅读快捷键已关闭；Ctrl/⌘+F 仍可在正文中查找。'}</p><button ref={helpClose} onClick={()=>setKeyboardHelp(false)}>关闭快捷键帮助</button></dialog>}<ReaderExports doc={doc} hasDrafts={anyDirty}/><p role="status" aria-live="polite">{status}</p></article>;
}
