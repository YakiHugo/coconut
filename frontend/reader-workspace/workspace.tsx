import {readingReviewSubmissionFailure} from '../app/reading-review-state';
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReaderCue, ReaderDocument, ReaderWorkspaceProps, ReaderSourceTarget } from './contracts';
import { captureSourceSelection, readingSourceOffset, time, translationTarget, visibleSourceRange, type SourceSelection } from './domain';
import { ReaderPlayer, PLAYBACK_RATES, type PlaybackLocation, type SeekIntent } from './player';
import {ReaderSummary} from './summary';
import {useReaderKeyboard} from '../reading-preferences/keyboard';
import { PassageView, passageDomain } from './passages';
import { BilingualCapture } from './bilingual';
import { ReaderExports } from './exports';
import { ReaderSource, SourcePlaybackLink, safeSourceURL } from './source';
import {ReaderDialog} from './controls';
import { ReadingModeTabs } from './mode-tabs';
import {scriptConverter} from '../reading-preferences/chinese-script';
import {SelectionToolbar} from './selection-toolbar';
import {LISTENING_LEAD_SECONDS,selectionPlaybackStart,sourcePlayback,speechParts,speechSelection} from './speech';
import {supportsTextHighlight,textOffsetAtPoint,textRange} from './text-range';
import {usePlaybackFollow,useReadingScroller} from './playback-follow';
import {prepareCleanup} from './cleanup';
import {useTranscriptSearch} from './transcript-search';
import {readingReview} from '@coconut/shared/transcript-review';
import {readingAdjustments,readingChapters,readingReplacements,readingSpeakerNames} from './reading-document';
type Domain = {
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
    mediaTimingOffset: (doc: ReaderDocument, identity: string) => number;
    createReadingChapter: (doc:ReaderDocument,input:{id:string;title:string;cueId:string})=>{id:string};
    updateReadingChapter: (doc:ReaderDocument,id:string,input:{title:string})=>{id:string};
    readingChaptersWith: (doc:ReaderDocument,input:{id:string})=>unknown;
};
const domain = () => (window as unknown as {
    Coconut: Domain;
}).Coconut;
const UNCONFIRMED_SAVE = '尚未保存。内容可能已更新或存储暂不可用，请保留草稿后重试。';
export function ReaderWorkspace(props: ReaderWorkspaceProps) { return <WorkspaceSession key={props.document.key} {...props}/>; }
function WorkspaceSession({ document: doc, revision, media, onSaveDocument, onReadingPosition, onRequestAi, onDirtyChange, onMediaProgress, saveStatus, onVisibleSelection, navigationRequest, onNavigationHandled, initialView, onViewChange, shortcutsEnabled=false, onOpenSummary, aiReturnRequest, resourcePanel, sourcePanel, sourceStatus, chineseScript='source' }: ReaderWorkspaceProps) {
    const modeTabsId = useId();
    const [reviewFailure,setReviewFailure]=useState('');
    useEffect(()=>{
        const read=()=>setReviewFailure(readingReviewSubmissionFailure(doc.key));
        const update=(event:Event)=>{if((event as CustomEvent<string>).detail===doc.key)read();};
        read();window.addEventListener('coconut-reading-review-started',update);
        return()=>window.removeEventListener('coconut-reading-review-started',update);
    },[doc.key]);
    const [toolsOpen,setToolsOpen]=useState(false),[tool,setTool]=useState('source');
    const openTools=(next:string)=>{setTool(next);setToolsOpen(true);};
    const displayText=useMemo(()=>scriptConverter(chineseScript,navigator.languages||[navigator.language]),[chineseScript,(navigator.languages||[navigator.language]).join(',')]);
    useEffect(()=>{setSelection(null);},[displayText]);
    const validInitialView=initialView?.documentKey===doc.key&&doc.segments.some(cue=>cue.id===initialView.cueId)?initialView:null;
    const initialCue=validInitialView?.cueId||doc.readingPosition||doc.segments[0]?.id||'';
    const temporaryNavigation=useRef(false),viewCallback=useRef(onViewChange);viewCallback.current=onViewChange;
    const [mode, setMode] = useState<'transcript'|'passages'|'summary'>(validInitialView?.mode||'passages'), [query, setQuery] = useState(''), [searchOpen, setSearchOpen] = useState(false), [locationTick,setLocationTick]=useState(0), [position, setPosition] = useState(initialCue), [follow, setFollow] = useState(false), [seek, setSeek] = useState<SeekIntent | null>(null), [status, setStatus] = useState(''), [busy, setBusy] = useState(false), [offset, setOffset] = useState(''), [offsetStarted,setOffsetStarted]=useState(false), [selection, setSelection] = useState<(SourceSelection & {
        revision: number; review?:boolean;
    }) | null>(null);
    const draggingSource=useRef(false);
    const cleanup=useMemo(()=>prepareCleanup(doc),[doc.key,doc.segments,doc.reading_cleanup]);
    const cleanupActive=mode==='passages'&&cleanup.state==='ready'&&Boolean(cleanup.hiddenCount||cleanup.markCount||cleanup.breakCount);
    useEffect(()=>{window.getSelection()?.removeAllRanges();setSelection(null);},[cleanup.projection]);
    const availableReview=useMemo(()=>readingReview(doc),[doc.segments,doc.reading_review]);
    const [selectedReview,setSelectedReview]=useState(()=>availableReview);
    const [initialReviewJob,setInitialReviewJob]=useState('');
    useEffect(()=>{
        const received=(event:Event)=>{
            const value=(event as CustomEvent<{key:string;jobId:string}>).detail;
            if(value?.key===doc.key)setInitialReviewJob(value.jobId);
        };
        window.addEventListener('coconut-reading-review-opened',received);
        return()=>window.removeEventListener('coconut-reading-review-opened',received);
    },[doc.key]);
    useEffect(()=>{
        if(initialReviewJob&&availableReview?.jobId===initialReviewJob){
            setInitialReviewJob('');setSelectedReview(availableReview);
        }
    },[initialReviewJob,availableReview]);
    const activeReview=availableReview&&selectedReview?.sourceSignature===availableReview.sourceSignature
        ?selectedReview.jobId===availableReview.jobId&&selectedReview.fallbackBatches===availableReview.fallbackBatches?availableReview:selectedReview
        :null;
    const speakerGroups=useMemo(()=>{
        const result=new Map<string,ReaderCue>(),identity=passageDomain().speakerIdentity;
        for(const cue of doc.segments){
            const id=identity(cue);
            if(id&&!result.has(id))result.set(id,cue);
        }
        return result;
    },[doc.segments]);
    const speakerAliases=useMemo(()=>readingSpeakerNames(doc.reading_speakers,speakerGroups),[doc.reading_speakers,speakerGroups]);
    const speakerDisplay=useCallback((cue:ReaderCue)=>{
        const group=passageDomain().speakerIdentity(cue);
        if(group&&speakerAliases.has(group))return speakerAliases.get(group);
        return (typeof cue.speaker_id==='string'&&!Object.hasOwn(cue,'original_speaker')?activeReview?.speakers.get(cue.speaker_id):undefined)
            ??cue.speaker??undefined;
    },[speakerAliases,activeReview]);
    const adjustments=useMemo(()=>readingAdjustments(doc.segments,doc.reading_adjustments,activeReview?.sourceSignature),
        [doc.segments,doc.reading_adjustments,activeReview?.sourceSignature]);
    const replacements=useMemo(()=>activeReview?readingReplacements(doc.segments,activeReview.edits,adjustments):undefined,
        [doc.segments,activeReview,adjustments]);
    const joins=useMemo(()=>{
        const stored=activeReview?.joins;
        if(!stored?.size||!adjustments.length)return stored;
        const interrupted=new Set(adjustments.map(edit=>stored.get(edit.cue_id)?.first));
        return new Map([...stored].filter(([,join])=>!interrupted.has(join.first)));
    },[activeReview,adjustments]);
    const chapters=useMemo(()=>{
        const context=doc.transcription_context as {chapters?:Array<{start:number;title:string}>}|undefined;
        const manual=doc.reading_chapters as Array<{cue_id:string;title:string}>|undefined;
        return readingChapters(doc.segments,manual??[],context?.chapters??[],activeReview?.headings??[]);
    },[doc.segments,doc.reading_chapters,doc.transcription_context,activeReview]);
    const chaptersByCue=useMemo(()=>new Map(chapters.map(chapter=>[chapter.cue_id,chapter])),[chapters]);
    const handledNavigation=useRef<ReaderWorkspaceProps['navigationRequest']>(null);
    const aiReturn=useRef<{selection:SourceSelection;cues:{id:string;text:string;speaker:string|null}[];mode:typeof mode;query:string;position:string}|null>(null);
    const handledAiReturn=useRef(0),[restoreSelection,setRestoreSelection]=useState<SourceSelection|null>(null);
    useEffect(()=>{
        if(!aiReturnRequest||aiReturnRequest.documentKey!==doc.key||handledAiReturn.current===aiReturnRequest.id)return;
        handledAiReturn.current=aiReturnRequest.id;const saved=aiReturn.current;
        if(!saved)return;
        const unavailable=()=>{setSelection(null);scopeRef.current?.focus({preventScroll:true});setStatus('选中的原文已变化，请重新选择；未恢复旧选区。');};
        const start=doc.segments.findIndex(cue=>cue.id===saved.cues[0]?.id);
        if(start<0||!saved.cues.every((cue,index)=>doc.segments[start+index]?.id===cue.id&&doc.segments[start+index]?.text===cue.text&&(doc.segments[start+index]?.speaker||null)===cue.speaker)){unavailable();return;}
        setMode(saved.mode);setQuery(saved.query);setSearchOpen(Boolean(saved.query));setPosition(saved.position);setFollow(false);
        setSelection({...saved.selection,revision});setRestoreSelection(saved.selection);
    },[aiReturnRequest,doc,revision,displayText]);
    useEffect(()=>{
        if(!restoreSelection)return;
        const first=host.current?.querySelector<HTMLElement>('[data-source-id="'+CSS.escape(restoreSelection.cueIds[0])+'"]');
        const focus=first?.closest<HTMLElement>('.rw-original');setRestoreSelection(null);
        if(!focus){setSelection(null);scopeRef.current?.focus({preventScroll:true});setStatus('所选原文当前不可见，请重新选择；未恢复旧选区。');return;}
        focus.focus({preventScroll:true});first?.scrollIntoView?.({block:'center'});setStatus('');
    },[restoreSelection]);
    const [sourceFocus,setSourceFocus]=useState<{id:number;target:ReaderSourceTarget}|null>(null);
    const scopeRef=useRef<HTMLElement|null>(null),searchRef=useRef<HTMLInputElement|null>(null),helpClose=useRef<HTMLButtonElement|null>(null),helpDialog=useRef<HTMLDialogElement|null>(null);
    const [keyboardHelp,setKeyboardHelp]=useState(false),[summaryCitation,setSummaryCitation]=useState('');
    const readingReturn=useRef<{revision:number;mode:'transcript'|'passages';query:string;position:string}|null>(null);
    const unconfirmedSave=useRef<{key:string;revision:number;content:string}|null>(null);
    const latest = useRef({ doc, revision });
    latest.current = { doc, revision };
    const attachment=useRef<{signature:string|null;id:number}>({signature:null,id:0});
    const mediaSignature=media?JSON.stringify([media.identity,media.url]):null;
    if(attachment.current.signature!==mediaSignature)attachment.current={signature:mediaSignature,id:attachment.current.id+1};
    const visibleCallback=useRef(onVisibleSelection);visibleCallback.current=onVisibleSelection;
    const dirtyCallback = useRef(onDirtyChange);
    dirtyCallback.current = onDirtyChange;
    const host = useRef<HTMLDivElement>(null), seekId = useRef(0), saving = useRef(false), mounted = useRef(true);
    const readingScroller=useReadingScroller(host);
    const handledLocation=useRef(0);
    const suspendFollow=useCallback(()=>setFollow(false),[]);
    useEffect(()=>{setFollow(false);setSelection(null);},[mediaSignature]);
    const scrollSource=(element:HTMLElement|null|undefined)=>element?.scrollIntoView?.({block:'nearest'});
    useEffect(()=>{
        const receipt=unconfirmedSave.current;
        if(!receipt||busy||saveStatus!=='saved'||receipt.key!==doc.key||receipt.revision!==revision||receipt.content!==JSON.stringify(doc))return;
        unconfirmedSave.current=null;
        setStatus(current=>current===UNCONFIRMED_SAVE?'已保存':current);
    },[doc,revision,saveStatus,busy]);
    const calibrated = media ? domain().mediaTimingOffset(doc, media.identity) : 0;
    const calibrationDirty=offsetStarted&&(offset.trim()===''||!Number.isFinite(Number(offset))||Number(offset)!==calibrated);
    const anyDirty = calibrationDirty;
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
            if(!(target instanceof HTMLElement)||target.closest('dialog,input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return;
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

    const playback = useMemo(() => sourcePlayback(doc.segments,media?.identity,doc.source_alignment), [doc.segments, media?.identity,doc.source_alignment]);
    const playbackCues = useMemo(() => new Map(playback.cues.map(cue=>[cue.id,cue])), [playback.cues]);
    const playbackIndex = useMemo(() => domain().createPlaybackIndex(playback.cues), [playback.cues]);
    const publisherTranscript = (doc.provenance as {kind?:string}|undefined)?.kind === 'publisher_transcript';
    const cueRangeEnd = (cue:ReaderCue) => (publisherTranscript || cue.timing_basis==='segment' || playback.gaps.has(cue.id)) && cue.end > cue.start ? cue.end : undefined;
    const [activePlayback,setActivePlayback]=useState<{attachmentId:number;location:PlaybackLocation|null}|null>(null);
    const attachmentId=attachment.current.id;
    const active=media&&activePlayback?.attachmentId===attachmentId?activePlayback.location:null;
    const locateTime=useCallback((seconds:number):PlaybackLocation|null=>{
        const time=seconds-calibrated,cue=playbackIndex.find(time);
        if(!cue)return null;
        const partIndex=mode==='passages'?speechParts(cue).findIndex(part=>part.start<=time&&time<part.end):-1;
        return {cueId:cue.id,partIndex};
    },[playbackIndex,calibrated,mode]);
    const onLocationChange=useCallback((location:PlaybackLocation|null)=>setActivePlayback({attachmentId,location}),[attachmentId]);
    const search=useTranscriptSearch(host,query,displayText,searchOpen&&mode!=='summary',doc.segments,mode,cleanup.projection,activeReview);
    const passages=useMemo(()=>passageDomain().build(doc.segments,{source:doc.segments,layout:'reading'}),[doc.segments]);
    const summaryOpen=mode==='summary';
    const visibleCueIds=useMemo(()=>summaryOpen?[]:doc.segments.map(cue=>cue.id),[doc.segments,summaryOpen]);
    useEffect(()=>{visibleCallback.current?.({key:doc.key,revision,cueIds:visibleCueIds});},[doc.key,revision,visibleCueIds]);
    const speakerCount=useMemo(()=>new Set(doc.segments.map(cue=>cue.speaker).filter(Boolean)).size,[doc.segments]);
    const locate=useCallback((id:string,temporary=false)=>{
        setFollow(false);
        temporaryNavigation.current=temporary;
        setPosition(id);setLocationTick(value=>value+1);
        onReadingPosition(id);
    },[onReadingPosition]);
    useEffect(()=>{
        const request=navigationRequest;
        if(!request||handledNavigation.current===request)return;
        handledNavigation.current=request;
        if(request.documentKey!==doc.key||request.revision!==revision||(request.source&&request.source.document!==doc)||anyDirty||busy){
            if(request.documentKey===doc.key)setStatus(anyDirty||busy?'请先保存或取消时间校准。':'记录来源已变化，请返回笔记重新打开。');
            onNavigationHandled?.(request);return;
        }
        if(request.source){

            const target=request.source.target;
            temporaryNavigation.current=true;setFollow(false);setSelection(null);
            if(target.kind==='cue'||target.kind==='exact-excerpt'){
                if(target.cueId&&doc.segments.some(cue=>cue.id===target.cueId)){
                    setMode('transcript');setQuery('');
                    setPosition(target.cueId);
                }
                setStatus(target.kind==='exact-excerpt'?(target.cueId?(target.freshness==='current'?'已定位摘录的当前原文；摘录仍保留选取时快照。':'已定位当前原文；来源已更新，摘录仍是历史快照。'):'原片段已缺失或顺序已变化；已定位历史摘录，未猜测当前原文。'):'已定位笔记与摘录的原文片段。');
            }else if(target.kind==='bookmark'){
                if(media){seekTo(target.time);setStatus('已定位时间书签 '+time(target.time)+'，未自动播放。');}
                else setStatus('时间书签 '+time(target.time)+'。原声尚未载入，请载入原文件后在播放器定位。');
            }else setStatus('已打开笔记所属文稿；项目笔记保存在「我的内容」中。');
            setSourceFocus({id:request.id,target});
        }else if(doc.segments.some(cue=>cue.id===request.cueId)){
            if(request.reviewIssue){setToolsOpen(false);setMode('transcript');setSelection(null);locate(request.cueId,true);}
            else if(mode==='summary')navigateSummary(request.cueId);else locate(request.cueId,true);
        }
        onNavigationHandled?.(request);
    },[navigationRequest,doc,revision,anyDirty,busy]);
    useEffect(()=>{
        const target=sourceFocus?.target;if(!target)return;
        let element:HTMLElement|null=null;
        if(target.kind==='cue'||(target.kind==='exact-excerpt'&&target.cueId)){
            const row=host.current?.querySelector<HTMLElement>('[data-cue-id="'+CSS.escape(target.cueId!)+'"]');
            element=row?.querySelector<HTMLElement>('.rw-original')||null;
        }else if(target.kind==='bookmark')element=scopeRef.current?.querySelector<HTMLElement>('.rw-player-play')||scopeRef.current;
        else element=scopeRef.current;
        element?.focus({preventScroll:true});
        const cueId=target.kind==='cue'||target.kind==='exact-excerpt'?target.cueId:null;
        const source=cueId?host.current?.querySelector<HTMLElement>('[data-source-id="'+CSS.escape(cueId)+'"]'):null;
        scrollSource(source||element);
    },[sourceFocus]);
    useEffect(()=>{if(temporaryNavigation.current)return;const cueId=playbackCues.has(position)?position:doc.segments[0]?.id;if(cueId)viewCallback.current?.({documentKey:doc.key,cueId,mode});},[doc.key,doc.segments,position,playbackCues,mode]);
    const following=follow&&!!media&&mode!=='summary'&&!anyDirty&&!toolsOpen&&!keyboardHelp;
    usePlaybackFollow({scroller:readingScroller,enabled:following,cueId:active?.cueId,partIndex:active?.partIndex??-1,onSuspend:suspendFollow});
    useEffect(()=>{
        if(following&&active?.cueId){
            setPosition(active.cueId);
            onReadingPosition(active.cueId);
        }
    },[following,active?.cueId]);
    useEffect(() => {
        const requested=handledLocation.current!==locationTick;
        handledLocation.current=locationTick;
        if (follow&&!requested)
            return;
        const element = host.current?.querySelector<HTMLElement>(`[data-cue-id="${CSS.escape(position)}"]`);
        if(requested){
            readingScroller.locate(position);
        }else{
            readingScroller.cancel();scrollSource(element);
        }
    }, [position, locationTick, mode]);
    const readingAnchor=()=>{
        if(selection?.revision===revision)return selection.cueIds[0];
        const pane=scopeRef.current?.querySelector<HTMLElement>('.rw-reading-pane');
        if(!pane||pane.hidden)return position;
        const top=Math.max(64,pane.getBoundingClientRect().top+64),bottom=window.innerHeight-120;
        const current=host.current?.querySelector<HTMLElement>('[data-source-id="'+CSS.escape(position)+'"]')?.getBoundingClientRect();
        if(current&&current.bottom>top&&current.top<bottom)return position;
        const row=[...(host.current?.querySelectorAll<HTMLElement>('.rw-original')||[])].find(node=>node.getBoundingClientRect().bottom>top);
        return row?.getAttribute('data-source-id')||row?.querySelector<HTMLElement>('[data-source-id]')?.dataset.sourceId||position;
    };
    const showReview=(show:boolean)=>{
        const anchor=readingAnchor();
        window.getSelection()?.removeAllRanges();setSelection(null);setFollow(false);
        setSelectedReview(show?availableReview:null);
        if(mode!=='passages')setMode('passages');
        if(anchor){setPosition(anchor);setLocationTick(value=>value+1);}
    };
    const changeMode=(next:'transcript'|'passages'|'summary')=>{const anchor=readingAnchor(),wasTemporary=temporaryNavigation.current;temporaryNavigation.current=false;window.getSelection()?.removeAllRanges();setSelection(null);setFollow(false);if(next==='summary'&&mode!=='summary'&&!wasTemporary)readingReturn.current={revision,mode,query,position:anchor};if(next!=='summary'){setPosition(anchor);setSearchOpen(Boolean(query));}else setSummaryCitation('');setMode(next);if(next==='summary')setSearchOpen(false);};
    const returnToReading=()=>{const saved=readingReturn.current;if(saved&&saved.revision===revision&&doc.segments.some(cue=>cue.id===saved.position)){setMode(saved.mode);setQuery(saved.query);setSearchOpen(Boolean(saved.query));setPosition(saved.position);}else{setMode('passages');setQuery('');if(saved)setStatus('原文已更新，已返回当前稿中的阅读位置。');}readingReturn.current=null;temporaryNavigation.current=false;};
    const navigateSummary=(cueId:string)=>{if(latest.current.doc!==doc||latest.current.revision!==revision)return;const index=doc.segments.findIndex(cue=>cue.id===cueId);if(index<0)return;setMode('passages');setSummaryCitation(cueId);setSearchOpen(false);setFollow(false);setSelection(null);setQuery('');setPosition(cueId);setLocationTick(value=>value+1);onReadingPosition(cueId);temporaryNavigation.current=true;};
    useEffect(()=>{
        if(!summaryCitation||mode==='summary')return;
        const source=host.current?.querySelector<HTMLElement>('[data-source-id="'+CSS.escape(summaryCitation)+'"]');
        source?.closest<HTMLElement>('.rw-original')?.focus({preventScroll:true});
        // Focus expands content-visibility paragraphs before measuring the target.
        const frame=window.requestAnimationFrame(()=>readingScroller.locate(summaryCitation));
        return()=>window.cancelAnimationFrame(frame);
    },[summaryCitation,locationTick]);
    useEffect(()=>{
        if(!keyboardHelp)return;
        const previous=document.activeElement as HTMLElement|null,dialog=helpDialog.current,close=helpClose.current;
        // The browser owns top-layer background exclusion; React owns its lifetime.
        dialog?.showModal();close?.focus();
        return()=>{const restore=document.activeElement===close||document.activeElement===dialog||document.activeElement===document.body; if(dialog?.open)dialog.close();if(restore&&previous?.isConnected)previous.focus({preventScroll:true});};
    },[keyboardHelp]);
    const pendingSearchReturn=useRef(false);
    const searchTrigger=useRef<HTMLButtonElement|null>(null),searchReturn=useRef<HTMLElement|null>(null),pendingSearchFocus=useRef(false);
    const openSearch=()=>{
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
    const shiftRate=(direction:number)=>{const player=currentPlayer();if(!player)return false;const current=player.playbackRate;
        const next=direction>0?PLAYBACK_RATES.find(rate=>rate>current):[...PLAYBACK_RATES].reverse().find(rate=>rate<current);
        if(next!==undefined)player.playbackRate=next;return true;};
    useReaderKeyboard({scopeRef,searchRef,enabled:shortcutsEnabled,active:!keyboardHelp,actions:{find:openSearch,help:()=>{setKeyboardHelp(true);return true;},back:()=>shiftPlayback(-5),forward:()=>shiftPlayback(5),play:toggleKeyboardPlayback,slower:()=>shiftRate(-1),faster:()=>shiftRate(1),locate:()=>{if(!active)return false;if(mode==='summary')navigateSummary(active.cueId);else locate(active.cueId);return true;}}});
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
    const seekTo=useCallback((seconds:number,play=false,end?:number)=>{
        if (!media) {
            setStatus('此项目当前没有可播放的原文件。来源信息与文字稿仍保留。');
            return;
        }
        setSeek({ id: ++seekId.current, owner: media.identity, attachmentURL:media.url, attachmentId:attachment.current.id, seconds, play, end });
    },[media?.identity,media?.url]);
    const playFrom=useCallback((seconds:number,lead=0,end?:number)=>{
        const start=Math.max(0,seconds+calibrated-lead);
        setFollow(true);
        // Explicit playback always brings its source to the reading anchor,
        // including when the selected speech is already somewhere on screen.
        const cue=playbackIndex.find(seconds);
        if(cue){setPosition(cue.id);setLocationTick(value=>value+1);}
        seekTo(start,true,end===undefined?undefined:end+calibrated);
    },[calibrated,playbackIndex,seekTo]);
    const playCue=useCallback((cue:ReaderCue)=>playFrom(playbackCues.get(cue.id)?.start??cue.start),[playFrom,playbackCues]);
    const jumpCue=useCallback((cue:ReaderCue)=>{
        locate(cue.id);
        if(media)seekTo((playbackCues.get(cue.id)?.start??cue.start)+calibrated);
    },[locate,media?.identity,playbackCues,calibrated,seekTo]);
    const followNow=()=>{
        if(mode==='summary')changeMode('passages');
        setFollow(true);
        const cueId=active?.cueId||position;
        if(cueId){setPosition(cueId);setLocationTick(value=>value+1);}
    };
    const capture = () => {
        if (!host.current)
            return;
        const value = captureSourceSelection(host.current, doc, window.getSelection(), passageDomain().separator,displayText);
        if (value)
            setFollow(false);
        const next=value?{...value,revision}:null;
        setSelection(previous=>value&&previous?.review&&previous.revision===revision&&previous.from===value.from&&previous.to===value.to&&previous.text===value.text&&JSON.stringify(previous.cueIds)===JSON.stringify(value.cueIds)?previous:JSON.stringify(previous)===JSON.stringify(next)?previous:next);
    };
    useEffect(()=>{
        const finish=()=>{if(draggingSource.current){draggingSource.current=false;capture();}};
        const cancel=()=>{draggingSource.current=false;};
        document.addEventListener('pointerup',finish,true);document.addEventListener('pointercancel',cancel,true);window.addEventListener('blur',cancel);
        return()=>{document.removeEventListener('pointerup',finish,true);document.removeEventListener('pointercancel',cancel,true);window.removeEventListener('blur',cancel);};
    },[doc,revision,displayText]);
    const hitSpeech=(node:HTMLElement,point?:{x:number;y:number})=>{
        const source=node.closest<HTMLElement>('[data-source-id]'),id=source?.dataset.sourceId;
        const cue=id?playbackCues.get(id):undefined;
        if(!source||!cue||node.closest(translationTarget))return;
        const mapped=node.closest<HTMLElement>('[data-reading-from]')||node.querySelector<HTMLElement>('[data-reading-from]');
        if(source.dataset.readingEdited){
            if(!mapped||!source.contains(mapped))return;
            const local=point?textOffsetAtPoint(mapped,point.x,point.y):0;
            const offset=local===null?null:readingSourceOffset(mapped,cue,local,displayText);
            return offset===null?null:{source,cue,offset};
        }
        if(source.textContent!==displayText(cue.text)||source.textContent.length!==cue.text.length)return;
        const offset=point?textOffsetAtPoint(source,point.x,point.y):Number(node.dataset.speechFrom??node.dataset.readingFrom??0);
        return offset===null?null:{source,cue,offset};
    };
    const selectSpeech=(node:HTMLElement,point?:{x:number;y:number})=>{
        const hit=hitSpeech(node,point);
        if(!hit)return;
        const {source,cue,offset}=hit;
        const value=speechSelection(cue,offset);
        if(!value)return;
        const range=source.dataset.readingEdited&&host.current?visibleSourceRange(host.current,doc,value):textRange(source,value.from,value.to);
        if(!range)return;
        setFollow(false);
        const native=window.getSelection();native?.removeAllRanges();
        // Custom highlights do not change the browser's double-click word or
        // drag-selection anchors. Older engines retain a native range fallback.
        if(range&&!supportsTextHighlight())native?.addRange(range);
        setSelection({...value,revision,review:true});
        node.closest<HTMLElement>('.rw-original')?.focus({preventScroll:true});
    };
    useEffect(()=>{
        let frame=0;
        const changed=()=>{
            window.cancelAnimationFrame(frame);frame=window.requestAnimationFrame(()=>{
                const range=window.getSelection();
                if(!draggingSource.current&&range&&!range.isCollapsed&&range.rangeCount===1&&host.current?.contains(range.getRangeAt(0).commonAncestorContainer))capture();
            });
        };
        document.addEventListener('selectionchange',changed);
        return()=>{window.cancelAnimationFrame(frame);document.removeEventListener('selectionchange',changed);};
    },[doc,revision,displayText]);
    const playSelection=()=>{
        if(!selection||selection.revision!==revision)return;
        const start=selectionPlaybackStart({...doc,segments:playback.cues},selection,cueRangeEnd);if(!start)return;
        const aligned=selection.cueIds[0]&&playbackCues.get(selection.cueIds[0])?.alignment_media_sha256;
        const lead=start.wordAligned||publisherTranscript||start.end!==undefined||aligned?0:LISTENING_LEAD_SECONDS;
        playFrom(start.seconds,lead,start.end);
        window.getSelection()?.removeAllRanges();setSelection(null);
        setStatus(!lead||start.wordAligned?'':'已带少量前文从原片段开始播放。');
    };
    const requestSelectionAi=(intent:'understand'|'translate')=>{
        if(!selection||selection.revision!==revision||busy||anyDirty)return;
        aiReturn.current={selection:{...selection},cues:selection.cueIds.map(id=>({id,text:doc.segments.find(cue=>cue.id===id)!.text,speaker:doc.segments.find(cue=>cue.id===id)!.speaker||null})),mode,query,position};
        onRequestAi({key:doc.key,revision,intent,text:selection.text,cueIds:selection.cueIds,scope:{kind:'exact_source_selection',from:selection.from,to:selection.to,separators:selection.separators,cueIds:selection.cueIds}});
        window.getSelection()?.removeAllRanges();setSelection(null);
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
    const sourceUrl=safeSourceURL(doc.source_url);
    return <article className={"reader-workspace"+(media?" rw-has-player":"")} ref={scopeRef} data-following={following} tabIndex={0} aria-label="阅读与原声工作区">
    <header className="rw-document-header">
        <h1 className="notranslate" translate="no" default-translate="no">{doc.title}</h1>
        <div className="rw-document-meta notranslate" translate="no" default-translate="no">
            <span>{doc.segments.length ? time(doc.segments.at(-1)?.end || 0) : '原声项目 · 尚无文字稿'}</span>
            {speakerCount>0&&<span>{speakerCount}{(doc.provenance as Record<string,unknown>|undefined)?.speaker_method&&(doc.provenance as Record<string,unknown>).speaker_method!=='unavailable'?' 个声音分组':' 位说话人'}</span>}
            {sourceUrl&&<a href={sourceUrl} target="_blank" rel="noopener noreferrer">原始来源 ↗</a>}
            <button type="button" className="rw-source-entry" onClick={()=>openTools('source')}>来源与整理</button>
        </div>
        {saveStatus && saveStatus!=='saved' && <p role="status">{saveStatus==='pending'||saveStatus==='saving'?'正在保存…':'保存尚未确认，请保留本页修改。'}</p>}
        {sourceStatus}
        {reviewFailure&&<p role="status">自动精校未提交。{reviewFailure} <button type="button" onClick={()=>openTools('processing')}>打开精校</button></p>}
    </header>
    <ReaderDialog open={toolsOpen} title="来源与整理" onClose={()=>setToolsOpen(false)}>
        <nav className="rw-tool-nav" aria-label="文字稿工具">
            {[['source','原始来源'],...(chapters.length?[['chapters','章节']]:[]),...(resourcePanel?[['processing','文字整理']]:[]),...(media&&doc.segments.length?[['timing','时间校准']]:[])].map(([id,label])=><button type="button" key={id} aria-current={tool===id?'page':undefined} onClick={()=>setTool(id)}>{label}</button>)}
        </nav>
        <div className="rw-tool-content" hidden={tool!=='source'}>{doc.segments.length>0&&<button type="button" disabled={anyDirty||busy} onClick={()=>{changeMode('transcript');setToolsOpen(false);}}>逐句原文</button>}<ReaderSource doc={doc}/>{media?.availability==='local_session'&&<p>刷新后需重新选择原文件。</p>}{doc.segments.length>0&&sourcePanel}</div>
        <div className="rw-tool-content" hidden={tool!=='chapters'}>
            <nav aria-label="章节目录"><ol className="rw-chapter-list">{chapters.map(chapter=><li key={chapter.cue_id}>
                <button type="button" onClick={()=>{setToolsOpen(false);locate(chapter.cue_id,true);}}>{displayText(chapter.title)}</button>
            </li>)}</ol></nav>
        </div>
        <div className="rw-tool-content" hidden={tool!=='processing'}>{resourcePanel}</div>
        <div className="rw-tool-content" hidden={tool!=='timing'}>{media && doc.segments.length > 0 && <section className="rw-calibration"><h3>时间校准</h3><p>当前偏移：{calibrated} 秒</p><p>仅调整播放映射，不修改原始字幕时间。正数表示媒体比字幕晚。</p><label>偏移秒数 <input type="number" min="-3600" max="3600" step="0.1" value={offset} disabled={busy} onChange={e => {setOffsetStarted(true);setOffset(e.target.value);}}/></label><button disabled={busy || !media.identity.startsWith('file-candidate-v1:') || offset.trim() === '' || !Number.isFinite(Number(offset)) || Math.abs(Number(offset)) > 3600} onClick={async() => {if(await save({ ...doc, media_timing: { version: 1, identity: media.identity, offset: Number(offset) } })){setOffsetStarted(false);setOffset('');}}}>保存校准</button><button disabled={busy} onClick={()=>{setOffsetStarted(false);setOffset('');}}>取消校准草稿</button></section>}</div>
        {(tool==='timing')&&status&&<p role="status">{status}</p>}
    </ReaderDialog>
 {media ? <ReaderPlayer key={attachment.current.id} media={media} seek={seek?.attachmentId===attachment.current.id?seek:null} locateTime={locateTime} onLocationChange={onLocationChange} follow={following} onFollow={doc.segments.length?followNow:undefined} onProgress={onMediaProgress}/> : (!sourceStatus&&(!sourcePanel||doc.segments.length>0)) && <p className="rw-media-unavailable">{doc.source_url ? '原声未载入。' : doc.local_media_source ? '重新选择原文件以载入原声。' : '未关联原声。'}</p>}

 {doc.segments.length === 0 ? (media || !sourcePanel&&!sourceStatus) && <section className="rw-empty"><h2>先播放原文件</h2><p>{doc.transcript_status === 'processing' ? '文字稿处理中…' : '暂无文字稿。'}</p></section> : <>
 <div className="rw-content-switch"><ReadingModeTabs mode={mode} id={modeTabsId} onChange={changeMode}/><button type="button" className="rw-search-trigger" data-native-command="find-transcript" ref={searchTrigger} aria-label="搜索文字稿" aria-expanded={searchOpen&&mode!=='summary'} aria-controls={`${modeTabsId}-search`} onClick={openSearch}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><span>查找</span></button></div>
 {mode==='passages'&&(availableReview||chapters.length>0)&&<div className="rw-review-version notranslate" translate="no" default-translate="no">
    {chapters.length>0&&<button type="button" onClick={()=>openTools('chapters')}>章节</button>}
    {availableReview&&<button type="button" onClick={()=>showReview(!activeReview)}>{activeReview?'查看基础稿':'查看精校稿'}</button>}
    {activeReview&&activeReview.issues.length>0&&<button type="button" onClick={()=>openTools('processing')}>{activeReview.issues.length} 处待核对</button>}
    {activeReview&&activeReview.fallbackBatches>0&&<button type="button" onClick={()=>openTools('processing')}>{activeReview.fallbackBatches} 批待核对</button>}
 </div>}
 <div role="tabpanel" id={`${modeTabsId}-panel`} aria-labelledby={`${modeTabsId}-${mode}`}>
 <div className="rw-search-panel" id={`${modeTabsId}-search`} hidden={!searchOpen||mode==='summary'} onKeyDown={event=>{
    if(!searchOpen||mode==='summary'||event.nativeEvent.isComposing||event.nativeEvent.keyCode===229)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeSearch();}
    else if(event.key==='Enter'&&event.target===searchRef.current){event.preventDefault();setFollow(false);search.move(event.shiftKey?-1:1);}
 }}>
    <label><span className="rw-sr-only">搜索文字稿</span><input ref={searchRef} type="search" placeholder="搜索文字稿" value={query} onChange={e=>{setFollow(false);setQuery(e.target.value);}}/></label>
    {query.trim()&&<span className="rw-search-count" role="status">{search.count?`第 ${search.index} / ${search.count} 处`:'无匹配'}</span>}
    <button type="button" aria-label="上一处" disabled={!search.count} onClick={()=>{setFollow(false);search.move(-1);}}>↑</button>
    <button type="button" aria-label="下一处" disabled={!search.count} onClick={()=>{setFollow(false);search.move(1);}}>↓</button>
    <button type="button" aria-label="关闭搜索" onClick={closeSearch}>关闭</button>
 </div>
 <div className="rw-reading-layout"><div className="rw-reading-pane" hidden={mode==='summary'}>
 {mode==='passages'&&cleanup.state==='unavailable'&&<p className="rw-cleanup-notice notranslate" translate="no" default-translate="no" role="status">{cleanup.message}</p>}
 {summaryCitation&&<div className="rw-citation-return"><span>正在阅读摘要引用的原文</span><button type="button" onClick={()=>changeMode('summary')}>返回摘要 ↑</button></div>}
 <div className="rw-cues" ref={host} onPointerDown={event=>{if(event.button===0&&(event.target as HTMLElement).closest('.rw-original')){draggingSource.current=true;setSelection(null);setFollow(false);}}} onCopy={event=>{if(selection?.review&&selection.revision===revision&&window.getSelection()?.isCollapsed&&(event.target as HTMLElement).closest('.rw-original')){event.preventDefault();event.clipboardData.setData('text/plain',selection.text);}}} onMouseUp={capture} onClick={event=>{
                if(event.button!==0||event.detail!==1||!window.getSelection()?.isCollapsed||(event.target as HTMLElement).closest('[data-cleanup-mark],[data-cleanup-break]'))return;
                const speech=(event.target as HTMLElement).closest<HTMLElement>('.rw-speech,[data-source-id]');
                if(speech&&host.current?.contains(speech))selectSpeech(speech,{x:event.clientX,y:event.clientY});
            }} onDoubleClick={event=>{
                if(!media||event.button!==0||(event.target as HTMLElement).closest('[data-cleanup-mark],[data-cleanup-break]'))return;
                const hit=hitSpeech(event.target as HTMLElement,{x:event.clientX,y:event.clientY});
                if(!hit)return;
                const {cue,offset}=hit,selection={cueIds:[cue.id],from:offset,to:offset+1,text:cue.text.slice(offset,offset+1),separators:[]};
                const start=selectionPlaybackStart({ ...doc,segments:playback.cues },selection);
                if(!start)return;
                window.getSelection()?.removeAllRanges();setSelection(null);playFrom(start.seconds);
            }} onKeyDown={event=>{
                if(event.key!=='Enter'||event.nativeEvent.isComposing||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
                const paragraph=event.target as HTMLElement;
                if(!paragraph.matches('.rw-original')||!window.getSelection()?.isCollapsed)return;
                const speech=paragraph.querySelector<HTMLElement>('.rw-speech.rw-playing')||paragraph.querySelector<HTMLElement>('.rw-speech')||(paragraph.matches('[data-source-id]')?paragraph:null);
                if(speech){event.preventDefault();selectSpeech(speech);}
            }} onKeyUp={event=>{if(!event.nativeEvent.isComposing&&(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)||((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a')))capture();}}>
 {mode==='summary'?null:mode==='passages'?<PassageView displayText={displayText} projection={cleanupActive?cleanup.projection:undefined} replacements={replacements} joins={joins} speakerDisplay={speakerDisplay} chapters={chaptersByCue} canListen={Boolean(media)} doc={doc} cues={doc.segments} passages={passages} playbackCues={playbackCues} active={active} position={position} onLocate={locate} onPlayFrom={playFrom}/> : doc.segments.map(cue=>
    <TranscriptRow key={cue.id} cue={cue} current={cue.id===position} playing={cue.id===active?.cueId} displayText={displayText}
        canListen={Boolean(media)} sourceUrl={sourceUrl||undefined} onJump={jumpCue} onPlay={playCue}/>
 )}</div>
 </div>{mode==='summary'&&<div className="rw-summary-pane"><ReaderSummary doc={doc} selectedCueId={position} canListen={Boolean(media)} onListen={playCue} onNavigate={navigateSummary} onReturn={returnToReading} onOpenSummary={onOpenSummary}/></div>}</div></div></>}
 {doc.segments.length===0&&sourcePanel}
 {selection?.revision===revision && <SelectionToolbar source={host} doc={doc} selection={selection} highlightSelection={Boolean(selection.review)} onDismiss={()=>setSelection(null)}>
    {media&&<button type="button" aria-label="从所选位置播放" onClick={playSelection}><span aria-hidden="true">▷</span> 播放</button>}
    <button type="button" aria-label="复制原话" onClick={async()=>{
        try{await navigator.clipboard.writeText(selection.text);setStatus('已复制选中原话');}
        catch{setStatus('无法直接复制，请在选中文字上使用系统复制。');}
    }}>复制</button>
    <button type="button" aria-label="保存精确摘录" disabled={busy||anyDirty} onClick={excerpt}>摘录</button>
    <button type="button" aria-label="理解选中文字" disabled={busy||anyDirty} onClick={()=>requestSelectionAi('understand')}>理解</button>
    <button type="button" aria-label="翻译选中文字" disabled={busy||anyDirty} onClick={()=>requestSelectionAi('translate')}>翻译</button>
    <BilingualCapture doc={doc} selection={selection} disabled={busy||anyDirty} save={save} onClose={()=>setSelection(null)}/>
    <button type="button" className="rw-selection-close" aria-label="关闭选文操作" onClick={dismissSelection}>×</button>
 </SelectionToolbar>}

 <section className="rw-tools" aria-label="阅读工具"><button type="button" onClick={()=>setKeyboardHelp(true)}>阅读快捷键</button>{keyboardHelp&&<dialog ref={helpDialog} role="dialog" aria-modal="true" aria-label="阅读快捷键" onCancel={event=>{event.preventDefault();setKeyboardHelp(false);}} onClose={()=>setKeyboardHelp(false)} onKeyDown={event=>{if(event.key==='Tab'){event.preventDefault();helpClose.current?.focus();}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setKeyboardHelp(false);}}}><h2>阅读快捷键</h2><p>在阅读正文获得焦点时：/ 查找，← / J 后退 5 秒，→ / L 前进 5 秒，空格 / K 播放或暂停，[ / ] 降低或提高倍率，G 定位当前原话，? 显示帮助。</p><p>{shortcutsEnabled?'阅读快捷键已开启':'阅读快捷键已关闭'}</p><button ref={helpClose} onClick={()=>setKeyboardHelp(false)}>关闭快捷键帮助</button></dialog>}<ReaderExports displayText={displayText} doc={doc} hasDrafts={anyDirty}/></section><p role="status" aria-live="polite">{status}</p></article>;
}


const TranscriptRow=memo(function TranscriptRow({cue,current,playing,displayText,canListen,sourceUrl,onJump,onPlay}:{
    cue:ReaderCue;current:boolean;playing:boolean;displayText:(text:string)=>string;canListen:boolean;sourceUrl?:string;
    onJump:(cue:ReaderCue)=>void;onPlay:(cue:ReaderCue)=>void;
}) {
    const text=displayText(cue.text);
    return <section data-cue-id={cue.id} className={'rw-cue'+(playing?' rw-playing':'')+(current?' rw-current':'')}>
        <div className="rw-cue-meta">
            <button type="button" onClick={()=>onJump(cue)}>{time(cue.start)}</button>
            {cue.speaker&&<span>{cue.speaker}</span>}
            {canListen?<button type="button" onClick={()=>onPlay(cue)}>从此处播放</button>:<SourcePlaybackLink sourceUrl={sourceUrl} start={cue.start}/>}
        </div>
        <p className="rw-original" tabIndex={0} aria-description="单击选取播放位置，双击播放，拖选可精确选择。" data-source-id={cue.id}>{text}</p>
        {text!==cue.text&&<section className="rw-transcription-source" aria-label="转录原文"><h3>转录原文</h3><p>{cue.text}</p></section>}
        {typeof cue.original_text==='string'&&cue.original_text!==cue.text&&<section className="rw-original-history"><h3>识别原文</h3><p>{cue.original_text}</p></section>}
    </section>;
});
