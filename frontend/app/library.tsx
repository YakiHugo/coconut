import {ChoicePicker} from '../reader-workspace/controls';
import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {DocumentCard} from './document-card';
import type {AppStore} from './store';
import type {Document} from './contracts';
import type {NotebookCapture} from './notebook-source';
const searchScopes=[
 {value:'title',label:'标题'},
 {value:'text',label:'原文全文'},
 {value:'translations',label:'译文'},
 {value:'notes',label:'笔记'},
];
const sessions=new WeakMap<AppStore,{query:string;scope:string;mode:string;limit:number;selected:string[];sourceKey?:string;documents:readonly Document[]}>();
const core=()=> (window as any).Coconut;
function download(name:string,text:string){const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
export function Library({store,onOpenSource}:{store:AppStore;onOpenSource:(capture:NotebookCapture)=>void}){
 const sourceKey=useRef(sessions.get(store)?.sourceKey),returnFocus=useRef(sourceKey.current),host=useRef<HTMLElement|null>(null);
 const [backupSelection]=useState(()=>core().createLibraryBackupSelection()),[,refreshSelection]=useState(0);
 const state=useSyncExternalStore(store.subscribe,store.getSnapshot),[query,setQuery]=useState(sessions.get(store)?.query||''),[scope,setScope]=useState(sessions.get(store)?.scope||'title'),[mode,setMode]=useState(sessions.get(store)?.mode||'documents'),[selected,setSelected]=useState<string[]>(sessions.get(store)?.documents===state.documents?sessions.get(store)?.selected||[]:[]),[title,setTitle]=useState('精选记录'),[limit,setLimit]=useState(sessions.get(store)?.limit||100),[removing,setRemoving]=useState<string|null>(null);
 useEffect(()=>{sessions.set(store,{query,scope,mode,limit,selected,sourceKey:sourceKey.current,documents:state.documents});},[store,query,scope,mode,limit,selected,state.documents]);
 const [,refreshSearch]=useState(0);
 const [search]=useState(()=>core().createLibrarySearch({getDocuments:()=>store.getSnapshot().documents,getRevision:()=>store.getSnapshot().documents,onChange:()=>refreshSearch(value=>value+1)}));
 const [notebook]=useState(()=>core().createLibraryNotebookSearch({getDocuments:()=>store.getSnapshot().documents,getRevision:()=>store.getSnapshot().documents,onChange:()=>refreshSearch(value=>value+1)}));
 useEffect(()=>()=>{search.cancel();notebook.cancel();},[search,notebook]);
 const searchJob=mode==='documents'?search.request(query,'all',scope):null,notebookJob=mode==='notebook'?notebook.request(query,'all'):null;
 const captures:NotebookCapture[]=notebookJob?.pending?[]:notebookJob?.captures||[];
 useEffect(()=>{const key=returnFocus.current;if(mode!=='notebook'||!key||notebookJob?.pending)return;const button=[...host.current?.querySelectorAll<HTMLButtonElement>('[data-notebook-source]')||[]].find(node=>node.dataset.notebookSource===key);if(button){const frame=requestAnimationFrame(()=>{if(button.isConnected){returnFocus.current=undefined;button.focus();}});return()=>cancelAnimationFrame(frame);}},[mode,notebookJob?.pending,captures]);
 const docs:Document[] = searchJob?.pending ? [] : [
    ...(searchJob?.docs || []),
    ...state.documents.filter(doc => doc.project_kind === 'reading_collection' && doc.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
 ];
 const create = () => {
    try {
        const chosen = captures.filter(capture => selected.includes(capture.key));
        if (!chosen.length) return;
        const items = chosen.map(capture => core().collectionItemFromCapture(capture, state.documents, {
            id: crypto.randomUUID(), createdAt: new Date().toISOString(),
        }));
        const doc = core().createReadingCollection({key:crypto.randomUUID(),title,items});
        if (store.addDocument(doc)) setSelected([]);
    } catch (error) {
        store.setMessage(error instanceof Error ? error.message : '记录已变化，请重新选择。');
    }
 };
 const exportSelected = () => {
    try {
        download('coconut-selected-backup.json', JSON.stringify(backupSelection.backup(state.documents, state.activeKey)));
    } catch (error) {
        store.setMessage(error instanceof Error ? error.message : '备份选择已变化。');
    }
 };
 const isNotebook = mode === 'notebook';
 const pending = searchJob?.pending || notebookJob?.pending;
 const resultCount = isNotebook ? captures.length : docs.length;

 return <section className="library-page" ref={host} aria-labelledby="library-title">
    <header className="library-heading">
        <h1 id="library-title">我的内容</h1>
        <nav aria-label="书架视图" className="library-tabs">
            <button type="button" aria-pressed={!isNotebook} onClick={() => setMode('documents')}>内容</button>
            <button type="button" aria-pressed={isNotebook} onClick={() => setMode('notebook')}>笔记与摘录</button>
        </nav>
    </header>
    <div className="library-tools">
        <div className="library-search">
            <label className="visually-hidden" htmlFor="library-query">查找内容</label>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>
            </svg>
            <input id="library-query" type="search" placeholder="查找内容" value={query}
                onChange={event => {setQuery(event.target.value);setLimit(100);setSelected([]);}}/>
        </div>
        {!isNotebook && <ChoicePicker label="搜索范围" value={scope} onChange={setScope} options={searchScopes}/>}
        {!isNotebook && <button className="library-secondary library-export" type="button" onClick={exportSelected}>导出所选篇目 JSON</button>}
        {store.canUndoRemove() && <button className="library-secondary" type="button" onClick={() => void store.undoRemove()}>撤销最近移除</button>}
    </div>
    {isNotebook ? <>
        <div className="library-notebook-tools">
            <label>精选标题 <input value={title} maxLength={500} onChange={event => setTitle(event.target.value)}/></label>
            <button type="button" className="library-primary" disabled={!selected.length || !title.trim()} onClick={create}>保存所选记录为精选</button>
            <button type="button" className="library-secondary" onClick={() => download('coconut-notes.md', core().libraryNotebookMarkdown(
                state.documents, [...new Set(captures.map(capture => capture.documentKey))],
            ))}>导出匹配篇目的全部笔记与摘录</button>
        </div>
        <ol className="library-captures">{captures.slice(0,limit).map(capture => <li key={capture.key}>
            <label><input type="checkbox" checked={selected.includes(capture.key)} onChange={event => {
                const checked = event.target.checked;
                setSelected(old => checked ? [...old,capture.key] : old.filter(key => key !== capture.key));
            }}/>{state.documents.find(doc => doc.key === capture.documentKey)?.title}</label>
            {capture.text && <p>{capture.text}</p>}
            {capture.note && <p>{capture.note}</p>}
            <button type="button" className="library-secondary" data-notebook-source={capture.key} onClick={() => {
                sourceKey.current = capture.key;
                sessions.set(store,{query,scope,mode,limit,selected,sourceKey:capture.key,documents:state.documents});
                onOpenSource(capture);
            }}>打开来源</button>
        </li>)}</ol>
    </> : <ul className="document-grid library-documents">{docs.slice(0,limit).map(doc => <li key={doc.key}>
        <DocumentCard document={doc} onOpen={store.select}/>
        <div className="library-document-actions">
            <label><input type="checkbox" aria-label={'选择备份 ' + doc.title} checked={backupSelection.has(doc)} onChange={event => {
                backupSelection.toggle(doc,event.target.checked,state.documents);
                refreshSelection(value => value + 1);
            }}/>备份</label>
            <button type="button" className="library-secondary" onClick={() => setRemoving(doc.key)}>移除</button>
        </div>
        {removing === doc.key && <div className="library-remove">
            <p>原音视频文件将保留。</p>
            <button type="button" className="library-secondary" disabled={state.dirty || !!state.save.unsaved} onClick={() => {
                setRemoving(null);
                void store.removeDocument(doc.key);
            }}>确认移除</button>
            <button type="button" className="library-secondary" onClick={() => setRemoving(null)}>取消</button>
        </div>}
    </li>)}</ul>}
    {pending && <p className="library-empty" role="status">正在搜索…</p>}
    {!pending && !resultCount && <p className="library-empty">
        {query.trim() ? '没有匹配的内容。' : isNotebook ? '暂无笔记与摘录。' : '从一个链接或音视频文件开始。'}
    </p>}
    {resultCount > limit && <button type="button" className="library-secondary" onClick={() => setLimit(old => old + 100)}>显示更多</button>}
 </section>;
}
export function Collection({store,document:doc}:{store:AppStore;document:Document}){const items=(doc.items||[]) as any[];const save=(next:any[])=>void store.commitDocument({...doc,items:next},{key:doc.key,revision:store.getRevision(doc.key)});return <section><h1>{doc.title}</h1><button onClick={()=>download(doc.title+'.md',core().readingCollectionMarkdown(doc,store.getSnapshot().documents))}>导出精选 Markdown</button><button onClick={()=>download(doc.title+'.json',JSON.stringify(doc))}>导出精选 JSON</button><ol>{items.map((item,index)=><li key={item.id}><h2>{item.snapshot.title}</h2><p>{item.snapshot.text}</p><p>{item.snapshot.note}</p><small>{item.created_at} · {core().readingCollectionItemState(item,store.getSnapshot().documents).status==='missing'?'来源标识已不在书架':'历史快照'}</small><button disabled={!index} onClick={()=>{const next=[...items];[next[index-1],next[index]]=[next[index],next[index-1]];save(next);}}>上移</button><button disabled={index===items.length-1} onClick={()=>{const next=[...items];[next[index+1],next[index]]=[next[index],next[index+1]];save(next);}}>下移</button><button onClick={()=>save(items.filter(value=>value!==item))}>移除精选条目</button></li>)}</ol></section>;}
