import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {createAiRequest} from './ai-request';
import { createAiController } from '../ai-workspace/controller';
import { AiWorkspace } from '../ai-workspace/workspace';
import type { AiSelection } from '../ai-workspace/contracts';
import type { AppStore } from './store';
import type { Document } from './contracts';
export type SelectionAiRequest={id:number;intent:'understand'|'translate';selection:AiSelection};
export function AiPanel({ store, selection, reviewRequest, openRequest, onNavigate, selectionRequest, onReturnToReading }: {
    store: AppStore;
    selection: AiSelection | null;
    selectionRequest?:SelectionAiRequest|null;
    onReturnToReading?:()=>void;
    reviewRequest?:{id:number;cueId:string;documentKey:string;revision:number;target:string}|null;
    openRequest?:{id:number;documentKey:string;revision:number}|null;
    onNavigate:(cueId:string)=>void;
}) {
    const navigation=useRef(onNavigate);navigation.current=onNavigate;
    const [open,setOpen]=useState(false),[focusRequest,setFocusRequest]=useState(0);
    const panel=useRef<HTMLDetailsElement|null>(null),handledSelection=useRef(0);
    const [controller] = useState(() => {
        const runtime = window as any;
        return createAiController({ core: runtime.Coconut, summary: runtime.CoconutSummary, tasks: runtime.CoconutTasks, document: () => store.getDocument(), documents: () => [...store.getSnapshot().documents], getRevision: store.getRevision,
            commit: async (next, expected) => ({ ok: await store.commitDocument(next as Document, expected) }),
            request: createAiRequest(fetch,( )=>runtime.CoconutClientCapabilities.local()&&runtime.CoconutClientCapabilities.current?.mode==='local'),
            access: runtime.CoconutClientCapabilities, journal: { read: () => localStorage.getItem('coconut-background-summary-v1'), write: value => localStorage.setItem('coconut-background-summary-v1', value) }, navigate: id => navigation.current(id), download: (name, text) => { const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })); const link = window.document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); }, uuid: () => crypto.randomUUID() });
    });
    const app = useSyncExternalStore(store.subscribe, store.getSnapshot), snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const document = store.getDocument(), revision = document ? store.getRevision(document.key) : -1;
    useEffect(()=>{store.setActivity('ai',snapshot.busy?'AI 请求仍在进行':null);return()=>store.setActivity('ai',null);},[store,snapshot.busy]);
    const dirty = snapshot.hasDirtyDrafts;
    useEffect(() => { store.setDirty(dirty, 'ai'); return () => store.setDirty(false, 'ai'); }, [store, dirty]);
    useEffect(() => { controller.setDocument(document, String(revision), selection); }, [controller, document, revision, selection]);
    useEffect(() => { const changed = () => controller.connectionChanged(), hidden = () => { controller.connectionChanged(); controller.clearTransientError(); }; window.addEventListener('coconut-client-changed', changed); window.addEventListener('offline', changed); window.addEventListener('pagehide', hidden); return () => { window.removeEventListener('coconut-client-changed', changed); window.removeEventListener('offline', changed); window.removeEventListener('pagehide', hidden); controller.dispose(); }; }, [controller]);
    useEffect(()=>{if(reviewRequest&&document?.key===reviewRequest.documentKey&&revision===reviewRequest.revision){controller.commands.configure({target:reviewRequest.target});controller.commands.openReview(reviewRequest.cueId);setOpen(true);}},[controller,reviewRequest]);
    useEffect(()=>{if(openRequest&&document?.key===openRequest.documentKey&&revision===openRequest.revision)setOpen(true);},[openRequest]);
    useEffect(()=>{
        const request=selectionRequest;if(!request||handledSelection.current===request.id||request.selection!==selection||request.selection.documentKey!==document?.key||request.selection.revision!==String(revision))return;
        handledSelection.current=request.id;
        controller.commands.configure({purpose:'question',execution:'foreground',question:request.intent==='translate'?'请只将所选原文翻译为目标语言。其余原文只作上下文，不要翻译未选中的内容。':'请结合上下文解释所选原文的意思，说明关键概念；若依据不足，请明确指出。'});
        setOpen(true);setFocusRequest(request.id);
    },[selectionRequest,selection,document,revision,controller]);
    useEffect(()=>{if(!open||!focusRequest)return;const heading=panel.current?.querySelector<HTMLElement>('.ai-workspace h2');heading?.focus({preventScroll:true});panel.current?.scrollIntoView?.({block:'start'});},[open,focusRequest]);
    const watching = snapshot.connected && snapshot.tasks.some(task => task.unknown || ['queued', 'running', 'cancel_requested'].includes(task.status));
    useEffect(() => { if (!watching)
        return; let active = true, timer: ReturnType<typeof setTimeout>; const poll = async () => { await controller.commands.refreshTasks(); if (active)
        timer = setTimeout(() => void poll(), 4000); }; timer = setTimeout(() => void poll(), 4000); return () => { active = false; clearTimeout(timer); }; }, [controller, watching]);
    return <details ref={panel} className="react-ai-panel" open={open} onToggle={event=>{setOpen(event.currentTarget.open);if(!event.currentTarget.open){controller.commands.stop();controller.clearTransientError();}}}><summary>AI 与译文核对</summary>{selectionRequest?.selection.documentKey===document?.key&&onReturnToReading&&<button type="button" onClick={()=>{controller.commands.stop();setOpen(false);onReturnToReading();}}>{snapshot.busy?'停止并返回所选原文':'返回所选原文'}</button>}<AiWorkspace snapshot={snapshot} commands={controller.commands}/></details>;
}
