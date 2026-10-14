import React, {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import type {SelectionActionSession} from './contracts';

/** Only frozen selection capabilities cross the boundary, never document data. */
export function SelectionActions() {
 const [selected,setSelected]=useState<SelectionActionSession|null>(null);
 const [preview,setPreview]=useState<SelectionActionSession|null>(null);
 const [position,setPosition]=useState({left:12,top:12});
 const toolbar=useRef<HTMLDivElement>(null),composing=useRef(false);
 useEffect(()=>{
  const update=(event?:Event)=>{
   if(composing.current||(event instanceof KeyboardEvent&&event.key==='Escape'))return;
   const bridge=window.CoconutSelectionActions;
   const nextPreview=bridge?.preview()||null;setPreview(nextPreview);
   if(nextPreview){setSelected(null);return;}
   // Focusing the actions must not discard the already captured exact range.
   if(toolbar.current?.contains(document.activeElement))return;
   const next=bridge?.capture()||null,rect=next?.bounds();
   if(next&&rect&&rect.bottom>0&&rect.top<innerHeight){
    setPosition({left:Math.max(12,Math.min(innerWidth-244,rect.left)),top:Math.max(8,Math.min(innerHeight-64,rect.bottom+8))});setSelected(next);
   }else setSelected(null);
  };
  const dismiss=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.isComposing){setSelected(null);if(toolbar.current?.contains(document.activeElement)){document.getSelection()?.anchorNode?.parentElement?.closest<HTMLElement>('.passage')?.focus({preventScroll:true});event.preventDefault();}}};
  const focus=()=>{if(!toolbar.current?.contains(document.activeElement)){setSelected(null);setPreview(window.CoconutSelectionActions?.preview()||null);}};
  const begin=()=>{composing.current=true;setSelected(null);};
  const end=()=>{composing.current=false;update();};
  const retire=()=>{setSelected(null);setPreview(window.CoconutSelectionActions?.preview()||null);};
  document.addEventListener('focusin',focus);
  document.addEventListener('selectionchange',update);document.addEventListener('pointerup',update);document.addEventListener('keyup',update);
  document.addEventListener('keydown',dismiss);document.addEventListener('compositionstart',begin);document.addEventListener('compositionend',end);
  window.addEventListener('coconut-selection-ready',update);window.addEventListener('coconut-render',retire);
  window.addEventListener('scroll',retire,true);window.addEventListener('resize',retire);update();
  return ()=>{
   document.removeEventListener('focusin',focus);
   document.removeEventListener('selectionchange',update);document.removeEventListener('pointerup',update);document.removeEventListener('keyup',update);
   document.removeEventListener('keydown',dismiss);document.removeEventListener('compositionstart',begin);document.removeEventListener('compositionend',end);
   window.removeEventListener('coconut-selection-ready',update);window.removeEventListener('coconut-render',retire);window.removeEventListener('scroll',retire,true);window.removeEventListener('resize',retire);
  };
 },[]);
 const actions=(owner:SelectionActionSession)=><>{(['explain','translate'] as const).map(intent=><button key={intent} type="button" onClick={()=>{if(owner.isCurrent())owner.run(intent);setSelected(null);}}>{intent==='explain'?'解释所选':'翻译所选'}</button>)}</>;
 const previewHost=document.getElementById('quotation-context-actions');
 return <>
  {selected&&createPortal(<div ref={toolbar} className="selection-actions" role="group" aria-label="所选原文操作" style={position} onPointerDown={event=>{if(event.pointerType==='mouse')event.preventDefault();}}>{actions(selected)}</div>,document.body)}
  {preview&&previewHost&&createPortal(<div className="quotation-context-actions" role="group" aria-label="所选原文操作">{actions(preview)}<span className="hint">先核对范围，再确认发送</span></div>,previewHost)}
 </>;
}
