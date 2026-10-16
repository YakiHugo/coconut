import type {AppStore} from './store';
import type {ReaderDocument,ReaderNavigationRequest,ReaderSourceTarget} from '../reader-workspace/contracts';

/** Keep the actual search capture: the domain owns its source identity. */
export type NotebookCapture = {
    key:string;documentKey:string;id:string;text:string;note:string;time:number|null;excerpt:boolean;
    type:'cue'|'exact-excerpt'|'bookmark'|'project-note';
};
type NotebookDomain = {
    libraryCaptureCurrent:(capture:NotebookCapture,documents:readonly ReaderDocument[])=>boolean;
    exactExcerptState:(record:unknown,document:ReaderDocument)=>{freshness:'current'|'stale'|'missing';cueId:string|null};
};
export function openNotebookSource(store:AppStore,capture:NotebookCapture,id:number):ReaderNavigationRequest|null {
    const state=store.getSnapshot(),core=(window as unknown as {Coconut:NotebookDomain}).Coconut;
    if(state.dirty){store.setMessage('请先保存或取消编辑，再打开记录来源。');return null;}
    const doc=store.getDocument(capture.documentKey);
    if(!doc||!core.libraryCaptureCurrent(capture,state.documents)){
        store.setMessage('记录或来源已变化，请重新检索后打开。');return null;
    }
    let target:ReaderSourceTarget;
    if(capture.type==='cue')target={kind:'cue',cueId:capture.id};
    else if(capture.type==='exact-excerpt'){
        const record=(doc as ReaderDocument).exact_excerpts?.find(record=>record.id===capture.id);
        if(!record)return null;
        target={kind:'exact-excerpt',excerptId:capture.id,...core.exactExcerptState(record,doc)};
    }else if(capture.type==='bookmark'){
        if(capture.time===null||!Number.isFinite(capture.time)||capture.time<0)return null;
        target={kind:'bookmark',bookmarkId:capture.id,time:capture.time};
    }else target={kind:'project-note'};
    const request:ReaderNavigationRequest={id,documentKey:doc.key,revision:store.getRevision(doc.key),source:{document:doc,target}};
    return store.select(doc.key)?request:null;
}
