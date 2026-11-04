import {useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode,type RefObject} from 'react';
import type {ReaderDocument} from './contracts';
import type {SourceSelection} from './domain';

function textPoint(node:HTMLElement,offset:number):{node:Node;offset:number} | null {
    if(!Number.isSafeInteger(offset)||offset<0)return null;
    const walker=document.createTreeWalker(node,4 /* SHOW_TEXT */);let text=walker.nextNode();
    while(text){if(offset<=text.textContent!.length)return {node:text,offset};offset-=text.textContent!.length;text=walker.nextNode();}
    return null;
}

function sourceRange(host:HTMLElement,doc:ReaderDocument,selection:SourceSelection):Range | null {
    const sourceNodes=new Map(Array.from(host.querySelectorAll<HTMLElement>('[data-source-id]'),node=>[node.dataset.sourceId!,node]));
    const lengths=new Map(doc.segments.map(cue=>[cue.id,cue.text.length]));
    const nodes=selection.cueIds.map(id=>sourceNodes.get(id));
    if(nodes.some(node=>!node))return null;
    let end=selection.to;
    for(let i=0;i<selection.cueIds.length-1;i++)end-=(lengths.get(selection.cueIds[i])??0)+selection.separators[i].length;
    const first=textPoint(nodes[0]!,selection.from),last=textPoint(nodes.at(-1)!,end);
    if(!first||!last)return null;
    const range=document.createRange();range.setStart(first.node,first.offset);range.setEnd(last.node,last.offset);return range;
}

/** Keep actions next to the source, including inside a narrow app side panel. */
export function SelectionToolbar({source,doc,selection,onDismiss,children}:{source:RefObject<HTMLDivElement|null>;doc:ReaderDocument;selection:SourceSelection;onDismiss:()=>void;children:ReactNode}) {
    const bar=useRef<HTMLElement>(null),dismiss=useRef(onDismiss);dismiss.current=onDismiss;
    const [placement,setPlacement]=useState({left:12,top:80,width:600,height:48,barWidth:240});
    useLayoutEffect(()=>{
        const node=bar.current,host=source.current;if(!node||!host)return;
        const range=sourceRange(host,doc,selection);
        let frame=0;
        const measure=()=>{
            const viewport=window.visualViewport,left=viewport?.offsetLeft??0,top=viewport?.offsetTop??0;
            const width=Math.min(viewport?.width??window.innerWidth,window.innerWidth),height=Math.min(viewport?.height??window.innerHeight,window.innerHeight);
            const rects=range?Array.from(range.getClientRects()):[];
            const anchor=rects.reverse().find(rect=>rect.bottom>top+56&&rect.top<top+height)||range?.getBoundingClientRect();
            const maxWidth=Math.min(600,width-24),barBox=node.getBoundingClientRect(),barHeight=barBox.height;
            const player=host.closest('.reader-workspace')?.querySelector('.rw-player')?.getBoundingClientRect();
            const bottom=Math.min(top+height-12,player&&player.height?player.top-12:Infinity);
            const safeTop=top+60;
            const next={left:Math.max(left+12,Math.min(anchor?.left??left+12,left+width-Math.min(barBox.width,maxWidth)-12)),
                top:Math.max(safeTop,Math.min(anchor&&anchor.bottom+8+barHeight<=bottom?anchor.bottom+8:(anchor?.top??bottom)-barHeight-8,bottom-barHeight)),
                width:maxWidth,height:barHeight||48,barWidth:barBox.width||240};
            setPlacement(old=>JSON.stringify(old)===JSON.stringify(next)?old:next);
        };
        const schedule=()=>{window.cancelAnimationFrame(frame);frame=window.requestAnimationFrame(measure);};
        const outside=(event:PointerEvent)=>{if(!node.contains(event.target as Node))dismiss.current();};
        measure();
        const observer=typeof window.ResizeObserver==='undefined'?null:new window.ResizeObserver(schedule);observer?.observe(node);
        window.addEventListener('scroll',schedule,true);window.addEventListener('resize',schedule);
        window.visualViewport?.addEventListener('resize',schedule);window.visualViewport?.addEventListener('scroll',schedule);
        document.addEventListener('pointerdown',outside);
        return()=>{window.cancelAnimationFrame(frame);observer?.disconnect();window.removeEventListener('scroll',schedule,true);window.removeEventListener('resize',schedule);
            window.visualViewport?.removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('scroll',schedule);document.removeEventListener('pointerdown',outside);};
    },[source,doc,selection]);
    return <aside ref={bar} className="rw-selection" aria-label="选中文字操作"
        style={{'--selection-left':placement.left+'px','--selection-top':placement.top+'px','--selection-height':placement.height+'px','--selection-width':placement.barWidth+'px',maxWidth:`min(${placement.width}px, calc(100dvw - 24px))`} as CSSProperties}
        onMouseDown={event=>{if(event.button===0&&(event.target as HTMLElement).closest('button')&&!(event.target as HTMLElement).closest('dialog'))event.preventDefault();}}>
        {children}
    </aside>;
}
