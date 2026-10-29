import {useEffect,useRef} from 'react';
import type {SaveStatus} from './contracts';

export type TaskOverview = {total:number;running:number;attention:number};

/** Background progress and receipts stay separate from application settings. */
export function ActivityCenter({save,tasks,onTaskHost}:{
    save:SaveStatus;tasks:TaskOverview;onTaskHost:(node:HTMLDivElement|null)=>void;
}) {
    const host=useRef<HTMLDetailsElement>(null);
    useEffect(()=>{
        const closeOutside=(event:PointerEvent)=>{if(host.current?.open&&!host.current.contains(event.target as Node))host.current.open=false;};
        const closeKeyboard=(event:KeyboardEvent)=>{if(event.key==='Escape'&&host.current?.open){event.preventDefault();event.stopPropagation();host.current.open=false;host.current.querySelector('summary')?.focus();}};
        document.addEventListener('pointerdown',closeOutside);
        document.addEventListener('keydown',closeKeyboard);
        return()=>{document.removeEventListener('pointerdown',closeOutside);document.removeEventListener('keydown',closeKeyboard);};
    },[]);
    return <details className="activity-center" ref={host}>
        <summary><span className="activity-indicator" data-active={tasks.running>0||undefined} data-attention={tasks.attention>0||undefined} aria-hidden="true"/><span>任务与状态</span>{tasks.total>0&&<span className="activity-count">{tasks.running||tasks.total}</span>}</summary>
        <section className="activity-panel" aria-label="任务与状态">
            <div className="activity-heading"><div><p className="kicker">ACTIVITY</p><h2>任务与状态</h2></div><button type="button" aria-label="关闭任务与状态" onClick={()=>{if(host.current){host.current.open=false;host.current.querySelector('summary')?.focus();}}}>×</button></div>
            <div className="activity-save"><span>书架保存</span><strong>{save.status==='saved'?'所有修改已保存':save.status==='pending'?'书架正在保存':'请重试保存'}</strong></div>
            <div className="activity-section-heading"><h3>文字稿任务</h3><span>{tasks.running?`${tasks.running} 项进行中`:tasks.attention?`${tasks.attention} 项待处理`:`${tasks.total} 项记录`}</span></div>
            {!tasks.total&&<p className="activity-empty">暂无文字稿任务。打开原声后可生成文字稿。</p>}
            <div ref={onTaskHost}/>

        </section>
    </details>;
}
