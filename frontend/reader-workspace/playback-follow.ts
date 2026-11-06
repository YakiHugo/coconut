import {useEffect, useMemo, type RefObject} from 'react';

function sourcePosition(host:HTMLElement, cueId:string, following:boolean) {
    const source=host.querySelector<HTMLElement>('[data-source-id="'+CSS.escape(cueId)+'"]');
    if(!source)return;
    // Measuring the row first lets content-visibility resolve offscreen text.
    source.closest('.rw-passage,.rw-cue')?.getBoundingClientRect();
    const highlighted=source.matches('.rw-playing')?source:source.querySelector<HTMLElement>('.rw-playing');
    // Word-aligned speech can have pauses between sentences. Keep the previous
    // viewport during those pauses instead of jumping back to the cue's start.
    if(following&&!highlighted&&(source.matches('.rw-speech')||source.querySelector('.rw-speech')))return;
    const speech=highlighted||source;
    const range=document.createRange();range.selectNodeContents(speech);
    const rect=[...(range.getClientRects?.()||speech.getClientRects())].find(rect=>rect.width>0&&rect.height>0);
    if(!rect)return;
    const workspace=host.closest('.reader-workspace');
    const tabs=workspace?.querySelector('.rw-content-switch')?.getBoundingClientRect();
    const search=workspace?.querySelector<HTMLElement>('.rw-search-panel');
    const player=workspace?.querySelector('.rw-player')?.getBoundingClientRect();
    // Reserve the sticky controls even before they reach the viewport's top.
    const top=24+(tabs?.height||0)+(search&&!search.hidden?search.getBoundingClientRect().height:0);
    const bottom=Math.min(window.innerHeight-24,player&&player.height>0?player.top-24:Infinity);
    if(bottom<=top)return;
    // Leave most of the reading area for upcoming speech and a little context above.
    const anchor=top+(bottom-top)/4;
    return {distance:rect.top-anchor};
}

function scrollKey(event:KeyboardEvent) {
    if(event.defaultPrevented||event.isComposing||event.keyCode===229)return false;
    const target=event.target instanceof Element?event.target:null;
    if(target?.closest('input,textarea,select,dialog,[role=combobox],[role=listbox],[contenteditable]:not([contenteditable="false"])'))return false;
    return ['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)&&!(event.key===' '&&target?.closest('button,a'));
}
const scrollbar=(event:PointerEvent)=>event.target===document.documentElement&&event.clientX>=document.documentElement.clientWidth;

/** One cancellable animation serves explicit location and automatic following. */
export function useReadingScroller(host:RefObject<HTMLDivElement|null>) {
    const scroller=useMemo(()=>{
        let animation:{frame:number;cueId:string;following:boolean}|null=null;
        const cancel=()=>{if(animation)window.cancelAnimationFrame(animation.frame);animation=null;};
        const scroll=(cueId:string,following:boolean)=>{
            // Follow the latest speech without restarting the easing on every
            // clock update, including a cue change during the transition.
            if(following&&animation){animation.cueId=cueId;animation.following=true;return;}
            cancel();
            const element=host.current;if(!element)return;
            const initial=sourcePosition(element,cueId,following);
            if(!initial||Math.abs(initial.distance)<1)return;
            if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){
                window.scrollBy({top:initial.distance,behavior:'instant'});return;
            }
            const duration=Math.min(480,240+Math.sqrt(Math.abs(initial.distance))*3);
            const started=window.performance.now(),current={frame:0,cueId,following};let previous=0;
            animation=current;
            const step=(now:number)=>{
                if(animation!==current)return;
                if(!element.isConnected){cancel();return;}
                const position=sourcePosition(element,current.cueId,current.following);
                if(!position){cancel();return;}
                const progress=Math.min(1,(now-started)/duration);
                const eased=progress<.5?4*progress**3:1-(-2*progress+2)**3/2;
                // Remeasure each frame: content-visibility can change document
                // height while distant paragraphs are brought into view.
                const fraction=progress===1?1:(eased-previous)/(1-previous);
                window.scrollBy({top:position.distance*fraction,behavior:'instant'});
                previous=eased;
                if(progress<1)current.frame=window.requestAnimationFrame(step);
                else animation=null;
            };
            current.frame=window.requestAnimationFrame(step);
        };
        return {locate:(cueId:string)=>scroll(cueId,false),follow:(cueId:string)=>scroll(cueId,true),cancel};
    },[host]);
    useEffect(()=>{
        const keyboard=(event:KeyboardEvent)=>{if(scrollKey(event))scroller.cancel();};
        const pointer=(event:PointerEvent)=>{if(scrollbar(event))scroller.cancel();};
        window.addEventListener('wheel',scroller.cancel,{passive:true});
        window.addEventListener('touchmove',scroller.cancel,{passive:true});
        window.addEventListener('keydown',keyboard);
        window.addEventListener('pointerdown',pointer);
        return()=>{
            scroller.cancel();window.removeEventListener('wheel',scroller.cancel);
            window.removeEventListener('touchmove',scroller.cancel);
            window.removeEventListener('keydown',keyboard);window.removeEventListener('pointerdown',pointer);
        };
    },[scroller]);
    return scroller;
}

export function usePlaybackFollow({scroller,enabled,cueId,clock,onSuspend}:{
    scroller:ReturnType<typeof useReadingScroller>;enabled:boolean;cueId?:string;clock:number;onSuspend:()=>void;
}) {
    useEffect(()=>{
        if(!enabled||cueId===undefined)return;
        scroller.follow(cueId);
    },[enabled,cueId,clock,scroller]);
    useEffect(()=>{if(!enabled)scroller.cancel();},[enabled,scroller]);
    useEffect(()=>{
        if(!enabled)return;
        const suspend=()=>onSuspend();
        const keyboard=(event:KeyboardEvent)=>{
            if(scrollKey(event))suspend();
        };
        const pointer=(event:PointerEvent)=>{
            if(scrollbar(event))suspend();
        };
        window.addEventListener('wheel',suspend,{passive:true});
        window.addEventListener('touchmove',suspend,{passive:true});
        window.addEventListener('keydown',keyboard);
        window.addEventListener('pointerdown',pointer);
        return()=>{
            window.removeEventListener('wheel',suspend);
            window.removeEventListener('touchmove',suspend);
            window.removeEventListener('keydown',keyboard);
            window.removeEventListener('pointerdown',pointer);
        };
    },[enabled,onSuspend]);
}
