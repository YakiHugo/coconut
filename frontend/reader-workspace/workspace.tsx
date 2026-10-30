import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReaderCue, ReaderDocument, ReaderWorkspaceProps, ReaderSourceTarget } from './contracts';
import { captureSourceSelection, filterCues, time, type SourceSelection } from './domain';
import { ReaderPlayer, type SeekIntent } from './player';
import {ReaderSummary} from './summary';
import {useReaderKeyboard} from '../reading-preferences/keyboard';
import { ReaderAnnotations, SourceCorrections } from './annotations';
import { PassageView, passageDomain } from './passages';
import { BilingualCapture } from './bilingual';
import { ReaderExports } from './exports';
import { ReaderSource, SourcePlaybackLink } from './source';
import { ReadingModeTabs } from './mode-tabs';
import {EditionPicker,EditionReader} from './editions';
import * as Editions from '../../reader/editions.js';
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
const UNCONFIRMED_SAVE = '尚未保存。内容可能已更新或存储暂不可用，请保留草稿后重试。';
export function ReaderWorkspace(props: ReaderWorkspaceProps) { return <WorkspaceSession key={props.document.key} {...props}/>; }
function WorkspaceSession({ document: doc, revision, media, onSaveDocument, onReadingPosition, onRequestAi, onDirtyChange, onMediaProgress, saveStatus, onVisibleSelection, onReviewTranslation, navigationRequest, onNavigationHandled, initialView, onViewChange, resumePosition, shortcutsEnabled=false, onOpenSummary, aiReturnRequest, resourcePanel }: ReaderWorkspaceProps) {
    const modeTabsId = useId();
    const [editionId,setEditionId]=useState(()=>Editions.state(doc).position?.edition_id||'source'),[editionDirty,setEditionDirty]=useState(false);
    const edition=Editions.state(doc).editions.find(item=>item.id===editionId);
    const validInitialView=initialView?.documentKey===doc.key&&doc.segments.some(cue=>cue.id===initialView.cueId)?initialView:null;
    const initialCue=validInitialView?.cueId||doc.readingPosition||doc.segments[0]?.id||'';
    const temporaryNavigation=useRef(false),viewCallback=useRef(onViewChange);viewCallback.current=onViewChange;
    const [mode, setMode] = useState<'transcript'|'passages'|'summary'>(validInitialView?.mode||'passages'), [annotationDirty, setAnnotationDirty] = useState(false), [correctionDirty, setCorrectionDirty] = useState(false), [query, setQuery] = useState(''), [notesOnly, setNotesOnly] = useState(false), [speaker, setSpeaker] = useState<string | null>(null), [searchOpen, setSearchOpen] = useState(false), [locationTick,setLocationTick]=useState(0), [position, setPosition] = useState(initialCue), [clock, setClock] = useState(0), [follow, setFollow] = useState(false), [seek, setSeek] = useState<SeekIntent | null>(null), [status, setStatus] = useState(''), [busy, setBusy] = useState(false), [drafts, setDrafts] = useState<Record<string, string>>({}), [projectDraft, setProjectDraft] = useState<string | null>(null), [offset, setOffset] = useState(''), [offsetStarted,setOffsetStarted]=useState(false), [jump, setJump] = useState(''), [selection, setSelection] = useState<(SourceSelection & {
        revision: number;
    }) | null>(null);
    const [editionFocus,setEditionFocus]=useState<{id:number;blockId:string}|null>(null);
    const handledNavigation=useRef<ReaderWorkspaceProps['navigationRequest']>(null);
    const aiReturn=useRef<{selection:SourceSelection;cues:{id:string;text:string;speaker:string|null}[];mode:typeof mode;query:string;notesOnly:boolean;speaker:string|null;position:string}|null>(null);
    const handledAiReturn=useRef(0),[restoreSelection,setRestoreSelection]=useState<SourceSelection|null>(null);
    useEffect(()=>{
        if(!aiReturnRequest||aiReturnRequest.documentKey!==doc.key||handledAiReturn.current===aiReturnRequest.id)return;
        handledAiReturn.current=aiReturnRequest.id;const saved=aiReturn.current;
        if(!saved)return;
        if(editionDirty){setStatus('请先保存或取消编辑稿草稿，再返回原文。');return;}
        const unavailable=()=>{setSelection(null);scopeRef.current?.focus({preventScroll:true});setStatus('选中的原文或阅读筛选已变化，请重新选择；未恢复旧选区。');};
        const start=doc.segments.findIndex(cue=>cue.id===saved.cues[0]?.id);
        if(start<0||!saved.cues.every((cue,index)=>doc.segments[start+index]?.id===cue.id&&doc.segments[start+index]?.text===cue.text&&(doc.segments[start+index]?.speaker||null)===cue.speaker)){unavailable();return;}
        const visible=filterCues(doc,saved.query,saved.notesOnly,saved.speaker);
        if(!saved.cues.every(cue=>visible.some(current=>current.id===cue.id))){unavailable();return;}
        setEditionId('source');setMode(saved.mode);setQuery(saved.query);setNotesOnly(saved.notesOnly);setSpeaker(saved.speaker);setSearchOpen(Boolean(saved.query));setPosition(saved.position);setFollow(false);
        setSelection({...saved.selection,revision});setRestoreSelection(saved.selection);
    },[aiReturnRequest,doc,revision]);
    useEffect(()=>{
        if(!restoreSelection)return;
        const first=host.current?.querySelector<HTMLElement>('[data-source-id="'+CSS.escape(restoreSelection.cueIds[0])+'"]');
        const focus=first?.closest<HTMLElement>('.rw-original');setRestoreSelection(null);
        if(!focus){setSelection(null);scopeRef.current?.focus({preventScroll:true});setStatus('所选原文当前不可见，请重新选择；未恢复旧选区。');return;}
        focus.focus({preventScroll:true});first?.scrollIntoView?.({block:'center'});setStatus('已回到所选原文，可继续阅读或重新选择。');
    },[restoreSelection]);
    const [sourceFocus,setSourceFocus]=useState<{id:number;target:ReaderSourceTarget}|null>(null);
    const scopeRef=useRef<HTMLElement|null>(null),searchRef=useRef<HTMLInputElement|null>(null),helpClose=useRef<HTMLButtonElement|null>(null),helpDialog=useRef<HTMLDialogElement|null>(null);
    const [keyboardHelp,setKeyboardHelp]=useState(false),[summaryCitation,setSummaryCitation]=useState('');
    const projectNoteRef=useRef<HTMLDetailsElement|null>(null);
    const filtersActive=Boolean(query.trim()||notesOnly||speaker!==null);
    const noteCount=Object.values(doc.notes||{}).filter(Boolean).length;
    const recordCount=noteCount+(doc.project_note?1:0)+(doc.timestamp_bookmarks?.length||0)+(Array.isArray(doc.reading_chapters)?doc.reading_chapters.length:0)+(doc.exact_excerpts?.length||0);
    const readingReturn=useRef<{revision:number;mode:'transcript'|'passages';query:string;notesOnly:boolean;speaker:string|null;position:string}|null>(null);
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
    const scrollSource=(element:HTMLElement|null|undefined)=>element?.scrollIntoView?.({block:'nearest'});
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
    const anyDirty = dirty || annotationDirty || correctionDirty || calibrationDirty || editionDirty;
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
    const selectionSource = () => selection?.revision===revision
        ? host.current?.querySelector<HTMLElement>('[data-source-id="'+CSS.escape(selection.cueIds[0])+'"]')?.closest<HTMLElement>('.rw-original') : null;
    const dismissSelection = () => {
        const source=selectionSource();
        window.getSelection()?.removeAllRanges();setSelection(null);
        source?.focus({preventScroll:true});
    };
    useEffect(() => {
        const selectionKeyboard = (event: KeyboardEvent) => {
            if(!selection||selection.revision!==revision||event.defaultPrevented||event.isComposing||event.keyCode===229||event.altKey||event.ctrlKey||event.metaKey)return;
            const target=event.target;
            if(!(target instanceof HTMLElement)||target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return;
            const source=selectionSource(),bar=scopeRef.current?.querySelector<HTMLElement>('.rw-selection');
            const original=target.closest('.rw-original');
            const inSource=!!original&&!!host.current?.contains(original)&&selection.cueIds.some(id=>original.querySelector('[data-source-id="'+CSS.escape(id)+'"]')||original.getAttribute('data-source-id')===id),inBar=!!bar&&bar.contains(target);
            if(!inSource&&!inBar)return;
            if(event.key==='Escape'){event.preventDefault();dismissSelection();return;}
            if(event.key!=='Tab')return;
            const first=bar?.querySelector<HTMLButtonElement>('button:not(:disabled)');
            if(!event.shiftKey&&inSource&&first){event.preventDefault();first.focus({preventScroll:true});}
            else if(event.shiftKey&&target===first&&source){event.preventDefault();source.focus({preventScroll:true});}
        };
        const scope=scopeRef.current;scope?.addEventListener('keydown',selectionKeyboard);
        return () => scope?.removeEventListener('keydown',selectionKeyboard);
    }, [selection,revision]);

    const playbackIndex = useMemo(() => domain().createPlaybackIndex(doc.segments), [doc.segments, revision]);
    const activeCue = media ? playbackIndex.find(clock - calibrated) : undefined;
    const filtered = useMemo(() => filterCues(doc, query, notesOnly, speaker), [doc, query, notesOnly, speaker]);
    const shown = filtered;
    const passages = useMemo(()=>passageDomain().build(filtered,{source:doc.segments,layout:'reading'}),[doc.segments,filtered]);
    const visibleSignature=JSON.stringify(mode==='summary'||edition?[]:shown.map(cue=>cue.id));
    useEffect(()=>{visibleCallback.current?.({key:doc.key,revision,cueIds:JSON.parse(visibleSignature)});},[doc.key,revision,visibleSignature,query,notesOnly,speaker,mode]);
    const speakers = [...new Set(doc.segments.map(c => c.speaker || ''))];
    const locate = (id: string,temporary=false) => {
        if(editionDirty)return;setEditionId('source');
        temporaryNavigation.current=temporary;
        const index = filtered.findIndex(c => c.id === id);
        if (index < 0) {
            setQuery('');
            setNotesOnly(false);
            setSpeaker(null);
        }
        setPosition(id);setLocationTick(value=>value+1);
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
        if(request.edition){
            const e=Editions.state(doc).editions.find(e=>e.id===request.edition.editionId);
            if(e?.blocks.some(b=>b.id===request.edition.blockId)){setSelection(null);setSearchOpen(false);setFollow(false);setEditionId(e.id);setEditionFocus({id:request.id,blockId:request.edition.blockId});}
            else setStatus('编辑稿来源已变化，请重新检索');
            onNavigationHandled?.(request);return;
        }
        if(request.source){
            setEditionId('source');
            const target=request.source.target;
            temporaryNavigation.current=true;setFollow(false);setSelection(null);
            if(target.kind==='cue'||target.kind==='exact-excerpt'){
                if(target.cueId&&doc.segments.some(cue=>cue.id===target.cueId)){
                    setMode('transcript');setQuery('');setNotesOnly(false);setSpeaker(null);
                    setPosition(target.cueId);
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
        else {if(projectNoteRef.current)projectNoteRef.current.open=true;element=scopeRef.current?.querySelector<HTMLElement>('[aria-label="项目笔记"]')||null;}
        element?.focus({preventScroll:true});
        const cueId=target.kind==='cue'||target.kind==='exact-excerpt'?target.cueId:null;
        const source=cueId?host.current?.querySelector<HTMLElement>('[data-source-id="'+CSS.escape(cueId)+'"]'):null;
        scrollSource(source||element);
    },[sourceFocus]);
    useEffect(()=>{if((mode!=='summary'&&(query.trim()||notesOnly||speaker!==null))||temporaryNavigation.current)return;const cueId=shown.some(cue=>cue.id===position)?position:shown[0]?.id;if(cueId)viewCallback.current?.({documentKey:doc.key,cueId,mode});},[doc.key,position,visibleSignature,mode,query,notesOnly,speaker]);
    useEffect(() => {
        if (follow && activeCue) {
            locate(activeCue.id);
        }
    }, [follow, activeCue?.id]);
    useEffect(() => {
        if (!position)
            return;
        const element = host.current?.querySelector<HTMLElement>(`[data-cue-id="${CSS.escape(position)}"]`);
        scrollSource(element);
    }, [position, locationTick, mode, query, notesOnly, speaker]);
    const readingAnchor=()=>{
        const pane=scopeRef.current?.querySelector<HTMLElement>('.rw-reading-pane');
        if(!pane||pane.hidden)return position;
        const top=Math.max(64,pane.getBoundingClientRect().top+64),bottom=window.innerHeight-120;
        const current=host.current?.querySelector<HTMLElement>('[data-source-id="'+CSS.escape(position)+'"]')?.getBoundingClientRect();
        if(current&&current.bottom>top&&current.top<bottom)return position;
        const row=[...(host.current?.querySelectorAll<HTMLElement>('.rw-original')||[])].find(node=>node.getBoundingClientRect().bottom>top);
        return row?.getAttribute('data-source-id')||row?.querySelector<HTMLElement>('[data-source-id]')?.dataset.sourceId||position;
    };
    const changeMode=(next:'transcript'|'passages'|'summary')=>{const anchor=readingAnchor(),wasTemporary=temporaryNavigation.current;temporaryNavigation.current=false;setSelection(null);setFollow(false);if(next==='summary'&&mode!=='summary'&&!wasTemporary)readingReturn.current={revision,mode,query,notesOnly,speaker,position:anchor};if(next!=='summary'){setPosition(anchor);setSearchOpen(Boolean(query));}else setSummaryCitation('');setMode(next);if(next==='summary')setSearchOpen(false);};
    const returnToReading=()=>{const saved=readingReturn.current;if(saved&&saved.revision===revision&&doc.segments.some(cue=>cue.id===saved.position)){setMode(saved.mode);setQuery(saved.query);setNotesOnly(saved.notesOnly);setSpeaker(saved.speaker);setSearchOpen(Boolean(saved.query));setPosition(saved.position);}else{setMode('transcript');setQuery('');setNotesOnly(false);setSpeaker(null);if(saved)setStatus('原文已更新，已返回当前稿中的阅读位置。');}readingReturn.current=null;temporaryNavigation.current=false;};
    const navigateSummary=(cueId:string)=>{setEditionId('source');if(latest.current.doc!==doc||latest.current.revision!==revision)return;const index=doc.segments.findIndex(cue=>cue.id===cueId);if(index<0)return;setMode('passages');setSummaryCitation(cueId);setSearchOpen(false);setFollow(false);setSelection(null);setQuery('');setNotesOnly(false);setSpeaker(null);setPosition(cueId);setLocationTick(value=>value+1);onReadingPosition(cueId);temporaryNavigation.current=true;};
    useEffect(()=>{
        if(!summaryCitation||mode==='summary')return;
        const source=host.current?.querySelector<HTMLElement>('[data-source-id="'+CSS.escape(summaryCitation)+'"]');
        source?.closest<HTMLElement>('.rw-original')?.focus({preventScroll:true});
        // Focus expands content-visibility paragraphs before measuring the target.
        const frame=window.requestAnimationFrame(()=>source?.scrollIntoView?.({block:'center'}));
        return()=>window.cancelAnimationFrame(frame);
    },[summaryCitation,locationTick]);
    useEffect(()=>{
        if(!keyboardHelp)return;
        const previous=document.activeElement as HTMLElement|null,dialog=helpDialog.current,close=helpClose.current;
        // The browser owns top-layer background exclusion; React owns its lifetime.
        dialog?.showModal();close?.focus();
        return()=>{const restore=document.activeElement===close||document.activeElement===dialog||document.activeElement===document.body; if(dialog?.open)dialog.close();if(restore&&previous?.isConnected)previous.focus({preventScroll:true});};
    },[keyboardHelp]);
    const pendingSearchResults=useRef(false),pendingSearchReturn=useRef(false);
    const searchTrigger=useRef<HTMLButtonElement|null>(null),searchReturn=useRef<HTMLElement|null>(null),pendingSearchFocus=useRef(false);
    const openSearch=()=>{
        if(editionDirty)return false;setEditionId('source');
        if(!doc.segments.length)return false;
        temporaryNavigation.current=false;setSummaryCitation('');
        if(!searchOpen)searchReturn.current=document.activeElement as HTMLElement|null;
        pendingSearchFocus.current=true;
        if(mode==='summary')changeMode('passages');
        setSearchOpen(true);
        if(searchOpen&&mode!=='summary'){searchRef.current?.focus();searchRef.current?.select();pendingSearchFocus.current=false;}
        return true;
    };
    useEffect(()=>{
        if(!searchOpen||mode==='summary'||!pendingSearchFocus.current)return;
        pendingSearchFocus.current=false;searchRef.current?.focus();searchRef.current?.select();
    },[searchOpen,mode]);
    useEffect(()=>{
        if(mode!=='summary')return;
        const frame=window.requestAnimationFrame(()=>scopeRef.current?.querySelector<HTMLElement>('.rw-summary-heading')?.scrollIntoView?.({block:'start'}));
        return()=>window.cancelAnimationFrame(frame);
    },[mode]);
    useEffect(()=>{
        if(!pendingSearchResults.current||!searchOpen||mode==='summary')return;
        pendingSearchResults.current=false;
        const frame=window.requestAnimationFrame(()=>{
            const first=host.current?.querySelector<HTMLElement>('.rw-original');
            if(first){first.getBoundingClientRect();first.scrollIntoView?.({block:'center'});}
            else scopeRef.current?.querySelector<HTMLElement>('.rw-search-empty')?.scrollIntoView?.({block:'center'});
        });
        return()=>window.cancelAnimationFrame(frame);
    },[query]);
    const closeSearch=()=>{
        pendingSearchReturn.current=true;setSearchOpen(false);setQuery('');
    };
    useEffect(()=>{
        if(searchOpen||!pendingSearchReturn.current)return;
        pendingSearchReturn.current=false;
        const previous=searchReturn.current;
        const source=host.current?.querySelector<HTMLElement>('[data-source-id="'+CSS.escape(position)+'"]')?.closest<HTMLElement>('.rw-original');
        (previous?.isConnected&&!previous.closest('[hidden]')?previous:source||searchTrigger.current)?.focus({preventScroll:true});
    },[searchOpen]);
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
    useReaderKeyboard({scopeRef,searchRef,enabled:shortcutsEnabled,active:!keyboardHelp,actions:{find:openSearch,help:()=>{setKeyboardHelp(true);return true;},back:()=>shiftPlayback(-5),forward:()=>shiftPlayback(5),play:toggleKeyboardPlayback,locate:()=>{if(!media||!activeCue)return false;if(mode==='summary')navigateSummary(activeCue.id);else locate(activeCue.id);return true;}}});
    const save = async (next: ReaderDocument, expectedRevision = revision, requireReceipt = false) => {
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
            return ok || (!requireReceipt && applied);
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
    const requestSelectionAi=(intent:'understand'|'translate')=>{
        if(!selection||selection.revision!==revision||busy||anyDirty)return;
        aiReturn.current={selection:{...selection},cues:selection.cueIds.map(id=>({id,text:doc.segments.find(cue=>cue.id===id)!.text,speaker:doc.segments.find(cue=>cue.id===id)!.speaker||null})),mode,query,notesOnly,speaker,position};
        onRequestAi({key:doc.key,revision,intent,text:selection.text,cueIds:selection.cueIds,scope:{kind:'exact_source_selection',from:selection.from,to:selection.to,separators:selection.separators,cueIds:selection.cueIds}});
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
    return <article className={"reader-workspace"+(media?" rw-has-player":"")} ref={scopeRef} tabIndex={0} aria-label="阅读与原声工作区"><header><p className="rw-eyebrow">原文与原声</p><h1>{doc.title}</h1><p>{doc.segments.length ? `${time(doc.segments.at(-1)?.end || 0)} · ${speakers.filter(Boolean).length ? speakers.filter(Boolean).length+(doc.provenance && typeof doc.provenance==='object' && (doc.provenance as Record<string,unknown>).speaker_method && (doc.provenance as Record<string,unknown>).speaker_method!=='unavailable'?' 个声音分组 · ':' 位说话人 · ') : ''}文字稿` : '原声项目 · 尚无文字稿'}</p>{saveStatus && saveStatus!=='saved' && <p role="status">{saveStatus==='pending'||saveStatus==='saving'?'正在保存…':'保存尚未确认，请保留本页修改。'}</p>}</header><ReaderSource doc={doc}/>{resourcePanel}
 {media ? <ReaderPlayer key={attachment.current.id} media={media} seek={seek?.attachmentId===attachment.current.id?seek:null} onTime={setClock} onProgress={onMediaProgress} resumePosition={resumePosition} onResume={seconds=>seekTo(seconds)} follow={follow} onFollow={setFollow} canFollow={doc.segments.length>0&&(mode!=='summary')&&!edition} onLocate={activeCue?()=>mode==='summary'?navigateSummary(activeCue.id):locate(activeCue.id):undefined}/> : <p className="rw-media-unavailable">{doc.source_url ? '原声尚未载入，可点击段落时间在原站回听。' : doc.local_media_source ? '原声尚未载入，重新选择关联文件后可在此回听。' : '尚无可播放的媒体，文字稿可继续阅读。'}</p>}
 {media && doc.segments.length > 0 && <div className="rw-toolbar"><details><summary>时间校准 · {calibrated} 秒</summary><p>仅调整播放映射，不修改原始字幕时间。正数表示媒体比字幕晚。</p><label>偏移秒数 <input type="number" min="-3600" max="3600" step="0.1" value={offset} disabled={busy} onChange={e => {setOffsetStarted(true);setOffset(e.target.value);}}/></label><button disabled={busy || dirty || annotationDirty || correctionDirty || !media.identity.startsWith('file-candidate-v1:') || offset.trim() === '' || !Number.isFinite(Number(offset)) || Math.abs(Number(offset)) > 3600} onClick={async() => {if(await save({ ...doc, media_timing: { version: 1, identity: media.identity, offset: Number(offset) } })){setOffsetStarted(false);setOffset('');}}}>保存校准</button><button disabled={busy} onClick={()=>{setOffsetStarted(false);setOffset('');}}>取消校准草稿</button></details></div>}
 {doc.segments.length === 0 ? <section className="rw-empty"><h2>先播放原文件</h2><p>{doc.transcript_status === 'processing' ? '文字稿正在处理，完成前可以播放并记录想法。' : doc.transcript_status === 'unavailable' ? '没有取得可用的定时文字稿。尚未运行语音识别。' : '尚未取得文字稿，未运行语音识别。可以先播放并记录想法。'}</p></section> : <><EditionPicker doc={doc} value={edition?.id||'source'} disabled={anyDirty||busy} onChange={value=>{setSelection(null);setSearchOpen(false);setFollow(false);setEditionId(value);}} onCreate={()=>{try{const id=crypto.randomUUID(),next=Editions.create(doc,{id,snapshotId:crypto.randomUUID(),createdAt:new Date().toISOString(),mediaIdentity:media?.identity});void save(next,revision,true).then(ok=>{if(ok){setSelection(null);setSearchOpen(false);setFollow(false);setEditionId(id);}});}catch(error){setStatus(error instanceof Error?error.message:String(error));}}}/>{edition?<EditionReader key={edition.id} doc={doc} edition={edition} focusBlock={editionFocus} media={media} busy={busy} saveStatus={saveStatus} onSave={next=>save(next,revision,true)} onDirtyChange={setEditionDirty} onSource={id=>{setMode('passages');locate(id);}} onListen={(start,end)=>seekTo(start+calibrated,end+calibrated,true)}/>:<>{Array.isArray(doc.reading_chapters)&&doc.reading_chapters.length>0&&<nav className="rw-edition-chapters" aria-label="连续文字稿章节">{(doc.reading_chapters as Array<{id:string;title:string;cue_id:string}>).map(c=><button key={c.id} disabled={anyDirty||busy||!doc.segments.some(s=>s.id===c.cue_id)} onClick={()=>locate(c.cue_id,true)}>{c.title}</button>)}</nav>}<div className="rw-content-switch"><ReadingModeTabs mode={mode} id={modeTabsId} onChange={changeMode}/><button type="button" className="rw-search-trigger" data-native-command="find-transcript" ref={searchTrigger} aria-label="搜索文字稿" aria-expanded={searchOpen&&mode!=='summary'} aria-controls={`${modeTabsId}-search`} onClick={openSearch}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><span>查找</span><kbd>⌘ / Ctrl F</kbd></button></div><div role="tabpanel" id={`${modeTabsId}-panel`} aria-labelledby={`${modeTabsId}-${mode}`}><div className="rw-search-panel" id={`${modeTabsId}-search`} hidden={!searchOpen||mode==='summary'} onKeyDown={event=>{if(searchOpen&&mode!=='summary'&&event.key==='Escape'&&!event.nativeEvent.isComposing&&event.nativeEvent.keyCode!==229){event.preventDefault();event.stopPropagation();closeSearch();}}}><label><span className="rw-sr-only">搜索原话、译文和笔记</span><input ref={searchRef} type="search" placeholder="输入关键词，查找原话、译文或笔记…" value={query} onChange={e=>{pendingSearchResults.current=true;setFollow(false);setQuery(e.target.value);}}/></label><span className="rw-search-count" role="status">{query.trim()?`${filtered.length} / ${doc.segments.length} 个片段`:'输入关键词查找'}</span><button type="button" aria-label="关闭搜索" onClick={closeSearch}>关闭 <kbd>Esc</kbd></button></div><nav className="rw-toolbar rw-reading-controls" aria-label="阅读筛选" hidden={mode==='summary'}><label>译文 <select value={doc.translation_view || ''} disabled={anyDirty || busy} onChange={e => save({ ...doc, translation_view: e.target.value })}><option value="">仅原文</option>{['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es'].map(lang => <option key={lang}>{lang}</option>)}</select></label><button type="button" className="rw-records-link" onClick={()=>{const records=scopeRef.current?.querySelector<HTMLElement>('.rw-records');records?.focus({preventScroll:true});records?.scrollIntoView?.({block:'start'});}}>阅读记录{recordCount ? ` · ${recordCount}` : ''}</button></nav>
 <div className="rw-reading-layout"><div className="rw-reading-pane" hidden={mode==='summary'}>{summaryCitation&&<div className="rw-citation-return"><span>正在阅读摘要引用的原文</span><button type="button" onClick={()=>changeMode('summary')}>返回摘要 ↑</button></div>}<details className="rw-find-options"><summary>筛选与定位{filtersActive ? ` · 已筛选 ${filtered.length} / ${doc.segments.length} 个片段` : ''}</summary><div className="rw-toolbar"><label><input type="checkbox" checked={notesOnly} disabled={mode==='summary'} onChange={e => { setFollow(false); setNotesOnly(e.target.checked); }}/> 只看笔记</label>{speakers.length > 1 && <label>说话人 <select value={speaker === null ? '__all' : JSON.stringify(speaker)} disabled={mode==='summary'} onChange={e => { setFollow(false); setSpeaker(e.target.value === '__all' ? null : JSON.parse(e.target.value)); }}><option value="__all">全部</option>{speakers.map(s => <option value={JSON.stringify(s)} key={s}>{s || '未标注'}</option>)}</select></label>}{filtersActive&&<button type="button" onClick={()=>{setQuery('');setNotesOnly(false);setSpeaker(null);}}>清除阅读筛选</button>}</div><form className="rw-toolbar" onSubmit={e => {
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
            }}><label>跳转时间 <input value={jump} placeholder="12:34" onChange={e => setJump(e.target.value)}/></label><button type="submit">跳转</button></form></details><div className="rw-toolbar rw-reading-position"><button type="button" disabled={busy || anyDirty || !position} onClick={() => save({ ...doc, readingPosition: readingAnchor() })}>读到这里</button>{doc.readingPosition && <button type="button" onClick={() => locate(doc.readingPosition!)}>回到已保存续点</button>}</div>{filtersActive&&<p className="rw-filter-status" role="status">当前显示 {filtered.length} / {doc.segments.length} 个片段{query.trim()?` · 搜索：${query}`:''}{notesOnly?' · 只看笔记':''}{speaker!==null?` · 说话人：${speaker||'未标注'}`:''}</p>}{filtersActive&&shown.length===0&&<p className="rw-search-empty">没有找到匹配的片段，试试其他关键词或清除筛选。</p>}<div className="rw-cues" ref={host} onWheel={() => setFollow(false)} onTouchMove={() => setFollow(false)} onMouseUp={capture} onKeyUp={event=>{if(!event.nativeEvent.isComposing&&(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)||((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a')))capture();}}>{mode !== 'transcript' ? <PassageView canListen={Boolean(media)} doc={doc} cues={shown} passages={passages} current={activeCue?.id} position={position} onLocate={locate} onInspect={id=>{setMode('transcript');setSelection(null);setFollow(false);setPosition(id);}} onPlayFrom={start => { setFollow(true); seekTo(start + calibrated, undefined, true); }} onListen={(start, end) => seekTo(start + calibrated, end + calibrated, true)}/> : shown.map(cue => <section key={cue.id} data-cue-id={cue.id} className={'rw-cue' + (cue.id === activeCue?.id ? ' rw-playing' : '') + (cue.id === position ? ' rw-current' : '')}><div className="rw-cue-meta"><button type="button" onClick={() => { locate(cue.id); seekTo(cue.start + calibrated); }}>{time(cue.start)}</button>{cue.speaker && <span>{cue.speaker}</span>}{media ? <button type="button" onClick={() => seekTo(cue.start + calibrated, cue.end + calibrated, true)}>回听此段</button> : <SourcePlaybackLink sourceUrl={doc.source_url} start={cue.start}/>}</div><p className="rw-original" tabIndex={0} data-source-id={cue.id}>{cue.text}</p>{doc.translation_view && cue.translations?.[doc.translation_view]?.text && <p className="rw-translation">{!domain().translationCurrent(cue, doc, cue.translations[doc.translation_view]) && <small>旧译文 · 原文已变化，请核对后更新。 </small>}{cue.translations[doc.translation_view].text}</p>}{onReviewTranslation&&doc.translation_view&&cue.translations?.[doc.translation_view]&&<button type="button" onClick={()=>onReviewTranslation(cue.id)}>核对译文</button>}<>{typeof cue.original_text==='string' && cue.original_text!==cue.text && <details className="rw-original-history"><summary>识别原文</summary><p>{cue.original_text}</p></details>}</><details open={Object.hasOwn(drafts, cue.id) ? true : undefined}><summary>笔记{doc.notes?.[cue.id] ? ' · 已有记录' : ''}</summary><textarea disabled={busy} aria-label={time(cue.start) + ' 的笔记'} value={drafts[cue.id] ?? doc.notes?.[cue.id] ?? ''} onChange={e => { startDraft(); setDrafts(old => ({ ...old, [cue.id]: e.target.value })); }}/></details></section>)}</div>
 </div>{mode==='summary'&&<div className="rw-summary-pane"><ReaderSummary doc={doc} selectedCueId={position} canListen={Boolean(media)} onListen={cue=>seekTo(cue.start+calibrated,cue.end+calibrated,true)} onNavigate={navigateSummary} onReturn={returnToReading} onOpenSummary={onOpenSummary}/></div>}</div></div></>}</>}
 {selection && <aside className="rw-selection" aria-label="选中文字操作"><p>{selection.text}</p>{media && <button type="button" onClick={()=>{const cues=doc.segments.filter(cue=>selection.cueIds.includes(cue.id));if(cues.length)seekTo(cues[0].start+calibrated,Math.max(...cues.map(cue=>cue.end))+calibrated,true);}}>回听所选片段</button>}<button disabled={busy || anyDirty} onClick={excerpt}>保存精确摘录</button><button disabled={busy||anyDirty} onClick={()=>requestSelectionAi('understand')}>理解选中文字</button><button disabled={busy||anyDirty} onClick={()=>requestSelectionAi('translate')}>翻译选中文字</button><button onClick={async () => {
                try {
                    await navigator.clipboard.writeText(selection.text);
                    setStatus('已复制选中原话');
                }
                catch {
                    setStatus('无法直接复制，请在选中文字上使用系统复制。');
                }
            }}>复制原话</button><BilingualCapture doc={doc} selection={selection} disabled={busy || anyDirty} save={save} onClose={() => setSelection(null)}/><button onClick={dismissSelection}>关闭</button></aside>}
 <section className="rw-records" tabIndex={-1} aria-label="阅读记录"><header><h2>阅读记录</h2>{mode!=='summary'&&shown.length>0&&<button type="button" className="rw-records-link" onClick={()=>{const original=host.current?.querySelector<HTMLElement>('[data-source-id="'+CSS.escape(position)+'"]')?.closest<HTMLElement>('.rw-original')||host.current?.querySelector<HTMLElement>('.rw-original');original?.focus({preventScroll:true});original?.scrollIntoView?.({block:'center'});}}>返回正文</button>}<p>{recordCount ? `已保留 ${recordCount} 条笔记、书签、章节与摘录` : '把值得重读的想法留在这里。'}{noteCount>0&&` · ${noteCount} 条片段笔记在对应原文旁`}</p></header><details className="rw-project-note" ref={projectNoteRef} open={Boolean(doc.project_note)||projectDraft!==null||dirty?true:undefined}><summary>项目笔记{doc.project_note?' · 已有记录':' · 添加想法'}</summary><textarea disabled={busy} aria-label="项目笔记" value={projectDraft ?? doc.project_note ?? ''} onChange={e => { startDraft(); setProjectDraft(e.target.value); }}/>{dirty && <div className="rw-toolbar"><button disabled={busy} onClick={saveDrafts}>保存笔记</button><button disabled={busy} onClick={() => { setDrafts({}); setProjectDraft(null); originalDraftRevision.current = null; }}>取消修改</button><span>未提交的草稿</span></div>}</details>
 <section><h2>时间书签</h2><button disabled={!media || busy || anyDirty} onClick={() => save({ ...doc, timestamp_bookmarks: [...(doc.timestamp_bookmarks || []), { id: crypto.randomUUID(), time: Math.round(clock * 1000) / 1000, note: '' }] })}>记录当前播放位置 · {time(clock)}</button></section>
 {Boolean(doc.exact_excerpts?.length) && <section><h2>保存的精确摘录</h2>{doc.exact_excerpts!.map(record => <section key={record.id} data-excerpt-id={record.id} tabIndex={-1}><p>{record.text}</p>{domain().exactExcerptTranslation(record) && <p>摘录时译文（{domain().exactExcerptTranslation(record)!.language}）：{domain().exactExcerptTranslation(record)!.text} <small>分别选取并确认对应，不等于人工核对译文。</small></p>}<small>原文核对：{{ current: '与当前来源一致', stale: '来源或译文已更新；保留选取时快照', missing: '原片段已不在当前文稿；保留快照' }[domain().exactExcerptFreshness(record, doc)] || '待核对'}</small>{doc.exact_excerpt_notes?.[record.id] && <p>{doc.exact_excerpt_notes[record.id]}</p>}</section>)}</section>}
 <ReaderAnnotations doc={doc} revision={revision} disabled={busy || dirty || correctionDirty || calibrationDirty} save={save} locate={id=>locate(id,true)} seek={seekTo} position={position} dirty={reportAnnotation}/></section><section className="rw-tools" aria-label="阅读工具">{doc.segments.length > 0 && <SourceCorrections doc={doc} revision={revision} disabled={busy || dirty || annotationDirty || calibrationDirty} save={save} position={position} dirty={reportCorrection}/>}<button type="button" onClick={()=>setKeyboardHelp(true)}>阅读快捷键</button>{keyboardHelp&&<dialog ref={helpDialog} role="dialog" aria-modal="true" aria-label="阅读快捷键" onCancel={event=>{event.preventDefault();setKeyboardHelp(false);}} onClose={()=>setKeyboardHelp(false)} onKeyDown={event=>{if(event.key==='Tab'){event.preventDefault();helpClose.current?.focus();}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setKeyboardHelp(false);}}}><h2>阅读快捷键</h2><p>在阅读正文获得焦点时：/ 查找，J 后退5秒，L 前进5秒，K 播放/暂停，G 定位当前原话，? 显示帮助。Ctrl/⌘+F 在正文中查找。输入框、输入法和对话框中不接管这些键。</p><p>{shortcutsEnabled?'阅读快捷键已开启':'阅读快捷键已关闭；Ctrl/⌘+F 仍可在正文中查找。'}</p><button ref={helpClose} onClick={()=>setKeyboardHelp(false)}>关闭快捷键帮助</button></dialog>}<ReaderExports doc={doc} hasDrafts={anyDirty}/></section><p role="status" aria-live="polite">{status}</p></article>;
}
