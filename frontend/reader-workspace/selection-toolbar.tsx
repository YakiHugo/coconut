import {useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode,type RefObject} from 'react';
import type {ReaderDocument} from './contracts';
import type {SourceSelection} from './domain';
import {supportsTextHighlight,textRange} from './text-range';

function sourceRange(host:HTMLElement,doc:ReaderDocument,selection:SourceSelection):Range | null {
    const sourceNodes=new Map(Array.from(host.querySelectorAll<HTMLElement>('[data-source-id]'),node=>[node.dataset.sourceId!,node]));
    const lengths=new Map(doc.segments.map(cue=>[cue.id,cue.text.length]));
    const nodes=selection.cueIds.map(id=>sourceNodes.get(id));
    if(nodes.some(node=>!node))return null;
    let end=selection.to;
    for(let i=0;i<selection.cueIds.length-1;i++)end-=(lengths.get(selection.cueIds[i])??0)+selection.separators[i].length;
    if(nodes.length===1)return textRange(nodes[0]!,selection.from,end);
    const first=textRange(nodes[0]!,selection.from,nodes[0]!.textContent!.length),last=textRange(nodes.at(-1)!,0,end);
    if(!first||!last)return null;
    first.setEnd(last.endContainer,last.endOffset);return first;
}

/** Keep actions next to the source, including inside a narrow app side panel. */
export function SelectionToolbar({source,doc,selection,highlightSelection=false,onDismiss,children}:{source:RefObject<HTMLDivElement|null>;doc:ReaderDocument;selection:SourceSelection;highlightSelection?:boolean;onDismiss:()=>void;children:ReactNode}) {
    const bar=useRef<HTMLElement>(null),dismiss=useRef(onDismiss);dismiss.current=onDismiss;
    const [placement,setPlacement]=useState({left:12,top:80,width:600,height:48,barWidth:240});
    useLayoutEffect(()=>{
        const node=bar.current,host=source.current;if(!node||!host)return;
        const range=sourceRange(host,doc,selection);
        const highlight=range&&highlightSelection&&supportsTextHighlight()?new window.Highlight(range):null;
        if(highlight)window.CSS.highlights.set('coconut-word-selection',highlight);
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
        const outside=(event:PointerEvent)=>{
            const target=event.target as Node;
            // Pausing, seeking or changing speed should keep a local review
            // available, so the user can listen to that same passage again.
            const player=highlightSelection?host.closest('.reader-workspace')?.querySelector('.rw-player'):null;
            if(!node.contains(target)&&!player?.contains(target))dismiss.current();
        };
        measure();
        const observer=typeof window.ResizeObserver==='undefined'?null:new window.ResizeObserver(schedule);observer?.observe(node);
        window.addEventListener('scroll',schedule,true);window.addEventListener('resize',schedule);
        window.visualViewport?.addEventListener('resize',schedule);window.visualViewport?.addEventListener('scroll',schedule);
        document.addEventListener('pointerdown',outside);
        return()=>{window.cancelAnimationFrame(frame);observer?.disconnect();window.removeEventListener('scroll',schedule,true);window.removeEventListener('resize',schedule);
            if(highlight&&window.CSS.highlights.get('coconut-word-selection')===highlight)window.CSS.highlights.delete('coconut-word-selection');
            window.visualViewport?.removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('scroll',schedule);document.removeEventListener('pointerdown',outside);};
    },[source,doc,selection,highlightSelection]);
    return <aside ref={bar} className="rw-selection" aria-label="选中文字操作" aria-description={'所选原话：'+selection.text}
        style={{'--selection-left':placement.left+'px','--selection-top':placement.top+'px','--selection-height':placement.height+'px','--selection-width':placement.barWidth+'px',maxWidth:`min(${placement.width}px, calc(100dvw - 24px))`} as CSSProperties}
        onMouseDown={event=>{if(event.button===0&&(event.target as HTMLElement).closest('button')&&!(event.target as HTMLElement).closest('dialog'))event.preventDefault();}}>
        {children}
    </aside>;
}
