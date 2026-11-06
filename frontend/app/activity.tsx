import {useEffect,useId,useRef,useState} from 'react';
import type {SaveStatus} from './contracts';

export type TaskOverview = {total:number;running:number;attention:number};

/** Keep task receipts mounted across navigation and while the dialog is closed. */
export function ActivityCenter({save,tasks,onTaskHost}:{
    save:SaveStatus;tasks:TaskOverview;onTaskHost:(node:HTMLDivElement|null)=>void;
}) {
    const [open,setOpen]=useState(false),id=useId();
    const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null),closeButton=useRef<HTMLButtonElement>(null);
    useEffect(()=>{
        const node=dialog.current;
        if(!open){if(node?.open)node.close();return;}
        node?.showModal();closeButton.current?.focus({preventScroll:true});
        const closeOutside=(event:PointerEvent)=>{
            const target=event.target as Node,rect=node?.getBoundingClientRect();
            if(node&&(!node.contains(target)||(target===node&&rect&&(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom))))setOpen(false);
        };
        document.addEventListener('pointerdown',closeOutside);
        return()=>{document.removeEventListener('pointerdown',closeOutside);if(node?.open)node.close();trigger.current?.focus({preventScroll:true});};
    },[open]);
    return <div className="activity-center">
        <button ref={trigger} type="button" className="activity-trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={()=>setOpen(true)}><span className="activity-indicator" data-active={tasks.running>0||undefined} data-attention={tasks.attention>0||undefined} aria-hidden="true"/><span>任务与状态</span>{tasks.total>0&&<span className="activity-count">{tasks.running||tasks.total}</span>}</button>
        <dialog ref={dialog} id={id} className="activity-panel" aria-labelledby={id+'-title'} onCancel={event=>{event.preventDefault();setOpen(false);}} onKeyDown={event=>{if(event.key==='Escape'&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();setOpen(false);}}} onClose={()=>setOpen(false)}>
            <div className="activity-heading"><h2 id={id+'-title'}>任务与状态</h2><button ref={closeButton} type="button" aria-label="关闭任务与状态" onClick={()=>setOpen(false)}>×</button></div>
            <div className="activity-save"><span>书架保存</span><strong>{save.status==='saved'?'已保存':save.status==='pending'?'正在保存…':'保存未完成'}</strong></div>
            <div className="activity-section-heading"><h3>文字稿任务</h3>{tasks.total>0&&<span>{tasks.running?`${tasks.running} 项进行中`:tasks.attention?`${tasks.attention} 项待处理`:`${tasks.total} 项记录`}</span>}</div>
            {!tasks.total&&<p className="activity-empty">暂无任务</p>}
            <div ref={onTaskHost}/>

        </dialog>
    </div>;
}
