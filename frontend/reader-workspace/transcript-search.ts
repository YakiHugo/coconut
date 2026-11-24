import {useEffect, useMemo, useState, type RefObject} from 'react';
import {literalSearch,translationTarget} from './domain';
import {supportsTextHighlight} from './text-range';

function textMatches(root:HTMLElement,pattern:RegExp) {
    const matches:Range[]=[];
    for(const paragraph of root.querySelectorAll<HTMLElement>('.rw-original,.rw-transcription-source p,.rw-original-history p')){
        const textNodes:{node:Node;start:number;end:number}[]=[];
        const walker=paragraph.ownerDocument.createTreeWalker(paragraph,4 /* SHOW_TEXT */,{
            acceptNode:node=>node.parentElement?.closest('[hidden],'+translationTarget)?2:1,
        });
        let text='';
        for(let node=walker.nextNode();node;node=walker.nextNode()){
            const start=text.length;
            text+=node.textContent||'';
            if(text.length>start)textNodes.push({node,start,end:text.length});
        }
        let first=0,last=0;
        for(const found of text.matchAll(pattern)){
            const start=found.index,end=start+found[0].length;
            while(textNodes[first].end<=start)first++;
            last=Math.max(first,last);
            while(textNodes[last].end<end)last++;
            const range=paragraph.ownerDocument.createRange();
            range.setStart(textNodes[first].node,start-textNodes[first].start);
            range.setEnd(textNodes[last].node,end-textNodes[last].start);
            matches.push(range);
        }
    }
    return matches;
}

export function useTranscriptSearch(
    host:RefObject<HTMLDivElement|null>,query:string,displayText:(text:string)=>string,
    enabled:boolean,content:unknown,mode:string,projection:unknown,review:unknown
) {
    const pattern=useMemo(()=>literalSearch(displayText(query)),[displayText,query]);
    const [result,setResult]=useState<{matches:Range[];index:number}|null>(null);
    useEffect(()=>{
        const root=host.current;
        if(!enabled||!pattern||!root){setResult(null);return;}
        const matches=textMatches(root,pattern);
        setResult({matches,index:0});
        if(!supportsTextHighlight())return;
        const highlight=new Highlight();
        for(const range of matches)highlight.add(range);
        CSS.highlights.set('coconut-search',highlight);
        return()=>{CSS.highlights.delete('coconut-search');};
    },[host,pattern,enabled,content,mode,projection,review]);
    const active=result?.matches[result.index];
    useEffect(()=>{
        if(!active||!enabled)return;
        if(supportsTextHighlight()){
            const highlight=new Highlight(active);
            highlight.priority=1;
            CSS.highlights.set('coconut-search-active',highlight);
        }
        const frame=window.requestAnimationFrame(()=>{
            const element=active.startContainer.parentElement;
            element?.closest('.rw-passage,.rw-cue')?.getBoundingClientRect();
            const rect=active.getBoundingClientRect?.();
            if(rect?.height){
                const workspace=element?.closest('.reader-workspace');
                const search=workspace?.querySelector('.rw-search-panel')?.getBoundingClientRect();
                const player=workspace?.querySelector('.rw-player')?.getBoundingClientRect();
                const top=search?.height?Math.max(0,search.bottom):0;
                const bottom=player?.height?player.top:window.innerHeight;
                const target=bottom>top?(top+bottom)/2:window.innerHeight/2;
                const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                window.scrollBy({top:rect.top+rect.height/2-target,behavior:reduced?'instant':'smooth'});
            }else element?.scrollIntoView?.({block:'center'});
        });
        return()=>{window.cancelAnimationFrame(frame);if(supportsTextHighlight())CSS.highlights.delete('coconut-search-active');};
    },[active,enabled]);
    const count=result?.matches.length??0;
    return {count,index:count?result!.index+1:0,move:(delta:number)=>{
        setResult(current=>current?.matches.length?{...current,index:(current.index+delta+current.matches.length)%current.matches.length}:current);
    }};
}
