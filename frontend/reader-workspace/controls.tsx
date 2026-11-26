import {useEffect, useId, useRef, useState, type ReactNode} from 'react';

export type Choice = {value:string; label:string};

/** A shared listbox: no hidden native select, and one predictable keyboard path. */
export function ChoicePicker({label,value,options,disabled=false,onChange,onOpen}:{
    label:string;value:string;options:Choice[];disabled?:boolean;onChange:(value:string)=>void;onOpen?:()=>void;
}) {
    const id=useId(), host=useRef<HTMLDivElement>(null), trigger=useRef<HTMLButtonElement>(null), list=useRef<HTMLDivElement>(null);
    const [open,setOpen]=useState(false),[activeValue,setActiveValue]=useState<string|null>(null);
    const selected=options.findIndex(option=>option.value===value);
    const active=Math.max(0,options.findIndex(option=>option.value===activeValue));
    const choose=(option:Choice)=>{onChange(option.value);setOpen(false);trigger.current?.focus();};
    const show=(index=Math.max(0,selected))=>{
        setActiveValue(options[index]?.value??null);setOpen(true);
        if(!open)onOpen?.();
    };
    useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
    useEffect(()=>{
        if(!open)return;
        const scroll=list.current,item=scroll?.querySelector<HTMLElement>('[role=option][data-active=true]');
        if(scroll&&item){
            const top=item.offsetTop,bottom=top+item.offsetHeight;
            if(top<scroll.scrollTop)scroll.scrollTop=top;
            else if(bottom>scroll.scrollTop+scroll.clientHeight)scroll.scrollTop=bottom-scroll.clientHeight;
        }
    },[open,active,options.length]);
    useEffect(()=>{
        if(!open)return;
        const outside=(event:PointerEvent)=>{if(!host.current?.contains(event.target as Node))setOpen(false);};
        document.addEventListener('pointerdown',outside);
        return()=>document.removeEventListener('pointerdown',outside);
    },[open]);
    return <div className="rw-choice" ref={host} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setOpen(false);}}>
        <span id={id+'-label'} className="rw-choice-label">{label}</span>
        <button ref={trigger} type="button" role="combobox" aria-labelledby={id+'-label'} aria-expanded={open} aria-controls={open?id+'-list':undefined}
            aria-haspopup="listbox" aria-activedescendant={open&&options[active]?id+'-option-'+active:undefined} disabled={disabled}
            onClick={()=>open?setOpen(false):show()} onKeyDown={event=>{
                if(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229)return;
                if(options.length&&['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
                    event.preventDefault();
                    const next=event.key==='Home'?0:event.key==='End'?options.length-1:open?(active+(event.key==='ArrowDown'?1:-1)+options.length)%options.length:Math.max(0,selected);
                    show(next);
                }else if(open&&(event.key==='Enter'||event.key===' ')){
                    event.preventDefault();
                    if(options[active])choose(options[active]);
                }else if(open&&event.key==='Escape'){event.preventDefault();event.stopPropagation();setOpen(false);}
                else if(event.key==='Tab')setOpen(false);
            }}><span id={id+'-value'}>{options[selected]?.label||'请选择'}</span><span aria-hidden="true">⌄</span></button>
        {open&&<div id={id+'-list'} ref={list} role="listbox" aria-labelledby={id+'-label'} className="rw-choice-options">
            {options.map((option,index)=><div id={id+'-option-'+index} role="option" key={option.value} aria-selected={option.value===value}
                data-active={index===active} onPointerMove={()=>setActiveValue(option.value)} onPointerDown={event=>event.preventDefault()}
                onClick={()=>choose(option)}>{option.label}{option.value===value&&<span aria-hidden="true">✓</span>}</div>)}
        </div>}
    </div>;
}

/** Keep children mounted so closing a tool never interrupts its background task. */
export function ReaderDialog({open,title,onClose,children}:{open:boolean;title:string;onClose:()=>void;children:ReactNode}) {
    const dialog=useRef<HTMLDialogElement>(null),close=useRef<HTMLButtonElement>(null),id=useId();
    useEffect(()=>{
        const node=dialog.current;
        if(!open){if(node?.open)node.close();return;}
        const previous=document.activeElement as HTMLElement|null;
        node?.showModal();close.current?.focus({preventScroll:true});
        return()=>{if(node?.open)node.close();if(previous?.isConnected)previous.focus({preventScroll:true});};
    },[open]);
    return <dialog ref={dialog} className="rw-dialog notranslate" translate="no" default-translate="no" aria-labelledby={id} onCancel={event=>{event.preventDefault();onClose();}} onClose={()=>{if(open)onClose();}}>
        <header className="rw-dialog-heading"><h2 id={id} className="notranslate" translate="no" default-translate="no">{title}</h2><button ref={close} type="button" aria-label={'关闭'+title} onClick={onClose}>关闭 <span aria-hidden="true">×</span></button></header>
        {children}
    </dialog>;
}
