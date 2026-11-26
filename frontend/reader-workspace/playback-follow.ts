import {useEffect, useMemo, useRef, type RefObject} from 'react';

import {readingBounds, readingPosition, readingScrollContainer, type ReadingPosition} from './reading-position';

function sourceTarget(host:HTMLElement, position:ReadingPosition, following:boolean) {
    const selector='[data-source-id="'+CSS.escape(position.cueId)+'"]';
    if(following){
        const cue=host.querySelector<HTMLElement>(selector+':has(.rw-playing),'+selector+'.rw-playing')??host.querySelector<HTMLElement>(selector);
        if(!cue)return;
        const speech=cue.matches('.rw-playing')?cue:cue.querySelector<HTMLElement>('.rw-playing');
        // Word-aligned speech can have pauses between sentences.
        if(!speech&&(cue.matches('.rw-speech')||cue.querySelector('.rw-speech')))return;
        return {cue,speech:speech??cue};
    }
    const cues=host.querySelectorAll<HTMLElement>(selector);
    if(!cues.length)return;
    if(position.speechFrom!==undefined){
        const part=`[data-speech-from="${position.speechFrom}"]`;
        for(const cue of cues){
            const speech=cue.matches(part)?cue:cue.querySelector<HTMLElement>(part);
            if(speech)return {cue,speech};
        }
    }
    const cue=cues[0];
    return {cue,speech:cue.querySelector<HTMLElement>('[data-speech-from]')??cue};
}

function sourcePosition(host:HTMLElement, viewport:HTMLElement|Window, position:ReadingPosition, following:boolean) {
    const target=sourceTarget(host,position,following);
    if(!target)return;
    const {cue,speech}=target;
    const row=cue.closest('.rw-passage,.rw-cue');
    row?.getBoundingClientRect();
    const range=document.createRange();range.selectNodeContents(speech);
    const rect=[...(range.getClientRects?.()||speech.getClientRects())].find(rect=>rect.width>0&&rect.height>0)
        ||(!following?row?.getBoundingClientRect():null);
    if(!rect)return;
    const {top,bottom}=readingBounds(host,viewport);
    if(bottom-top<=48)return;
    // Place the sentence a quarter of the way down the reading area.
    const anchor=top+24+(bottom-top-48)/4;
    return {distance:rect.top-anchor,visible:rect.bottom>top&&rect.top<bottom,position:readingPosition(cue,speech)};
}

function scrollKey(event:KeyboardEvent) {
    if(event.defaultPrevented||event.isComposing||event.keyCode===229)return false;
    const target=event.target instanceof Element?event.target:null;
    if(target?.closest('input,textarea,select,dialog,[role=combobox],[role=listbox],[contenteditable]:not([contenteditable="false"])'))return false;
    return ['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)&&!(event.key===' '&&target?.closest('button,a'));
}
function scrollbar(event:PointerEvent) {
    const target=event.target;
    if(!(target instanceof HTMLElement))return false;
    if(target===document.documentElement)return event.clientX>=target.clientWidth;
    return target.id==='main-content'&&event.clientX>=target.getBoundingClientRect().left+target.clientLeft+target.clientWidth;
}

/** Following, locating and reopening share the same placement. */
export function useReadingScroller(host:RefObject<HTMLDivElement|null>, onScroll:()=>void, onManualScroll:()=>void) {
    const callbacks=useRef({onScroll,onManualScroll});
    callbacks.current={onScroll,onManualScroll};
    const scroller=useMemo(()=>{
        type Arrival = (position:ReadingPosition)=>void;
        let animation:{frame:number;position:ReadingPosition;following:boolean;onArrive?:Arrival}|null=null;
        let restoreFrame=0;
        const cancel=()=>{
            if(animation)window.cancelAnimationFrame(animation.frame);
            window.cancelAnimationFrame(restoreFrame);
            animation=null;restoreFrame=0;
        };
        const move=(viewport:HTMLElement|Window, distance:number)=>{
            viewport.scrollBy?.({top:distance,behavior:'instant'});
            callbacks.current.onScroll();
        };
        const scroll=(position:ReadingPosition,following:boolean,onArrive?:Arrival)=>{
            // Retarget in place as playback advances during an animation.
            if(following&&animation){Object.assign(animation,{position,following,onArrive});return;}
            cancel();
            const element=host.current;if(!element)return;
            const viewport=readingScrollContainer(element);
            const initial=sourcePosition(element,viewport,position,following);
            if(!initial)return;
            const arrive=(target:ReadingPosition,follow:boolean,callback?:Arrival)=>{
                if(!callback)return;
                const settled=sourcePosition(element,viewport,target,follow);
                if(settled?.visible)callback(settled.position);
            };
            if(Math.abs(initial.distance)<1||window.matchMedia('(prefers-reduced-motion: reduce)').matches){
                if(Math.abs(initial.distance)>=1)move(viewport,initial.distance);
                arrive(position,following,onArrive);return;
            }
            const duration=Math.min(480,240+Math.sqrt(Math.abs(initial.distance))*3);
            const started=window.performance.now(),current={frame:0,position,following,onArrive};let previous=0;
            animation=current;
            const step=(now:number)=>{
                if(animation!==current)return;
                if(!element.isConnected){cancel();return;}
                const target=sourcePosition(element,viewport,current.position,current.following);
                if(!target){cancel();return;}
                const progress=Math.min(1,(now-started)/duration);
                const eased=progress<.5?4*progress**3:1-(-2*progress+2)**3/2;
                // Offscreen rows can change size when brought into view.
                const fraction=progress===1?1:(eased-previous)/(1-previous);
                move(viewport,target.distance*fraction);
                previous=eased;
                if(progress<1)current.frame=window.requestAnimationFrame(step);
                else{animation=null;arrive(current.position,current.following,current.onArrive);}
            };
            current.frame=window.requestAnimationFrame(step);
        };
        const restore=(position:ReadingPosition, fromStart=false)=>{
            cancel();
            const element=host.current;if(!element)return;
            const viewport=readingScrollContainer(element);
            if(fromStart){
                viewport.scrollTo?.({top:0,behavior:'instant'});
                callbacks.current.onScroll();
                return;
            }
            // Make content-visibility lay out a distant sentence before measuring its line.
            sourceTarget(element,position,false)?.speech.scrollIntoView?.({block:'center',behavior:'instant'});
            const align=()=>{
                const target=sourcePosition(element,viewport,position,false);
                if(target&&Math.abs(target.distance)>=1)move(viewport,target.distance);
                else callbacks.current.onScroll();
            };
            align();
            // Recheck after layout has expanded the newly visible rows.
            restoreFrame=window.requestAnimationFrame(()=>{
                if(element.isConnected)align();
                restoreFrame=0;
            });
        };
        const follow=(cueId:string)=>{
            const position={cueId};
            const target=host.current&&sourceTarget(host.current,position,true);
            scroll(position,true);
            if(target)return readingPosition(target.cue,target.speech);
        };
        return {locate:(cueId:string,onArrive?:Arrival)=>scroll({cueId},false,onArrive),follow,restore,cancel,
            cancelFollowing:()=>{if(animation?.following)cancel();}};
    },[host]);
    useEffect(()=>{
        const manual=(event:Event)=>{
            if(event.target instanceof Element&&event.target.closest('dialog[open]'))return;
            scroller.cancel();callbacks.current.onManualScroll();
        };
        const keyboard=(event:KeyboardEvent)=>{if(scrollKey(event))manual(event);};
        const pointer=(event:PointerEvent)=>{if(scrollbar(event))manual(event);};
        window.addEventListener('wheel',manual,{passive:true});
        window.addEventListener('touchmove',manual,{passive:true});
        window.addEventListener('keydown',keyboard);
        window.addEventListener('pointerdown',pointer);
        return()=>{
            scroller.cancel();window.removeEventListener('wheel',manual);
            window.removeEventListener('touchmove',manual);window.removeEventListener('keydown',keyboard);window.removeEventListener('pointerdown',pointer);
        };
    },[scroller]);
    return scroller;
}

export function usePlaybackFollow({scroller,enabled,cueId,partIndex,onPosition}:{
    scroller:ReturnType<typeof useReadingScroller>;enabled:boolean;cueId?:string;partIndex:number;onPosition:(position:ReadingPosition)=>void;
}) {
    useEffect(()=>{
        if(!enabled||cueId===undefined){scroller.cancelFollowing();return;}
        const position=scroller.follow(cueId);
        if(position)onPosition(position);
    },[enabled,cueId,partIndex,scroller,onPosition]);
}
