import type { ReaderCue, ReaderDocument } from './contracts';
import {blockText, type Block} from '@coconut/reader/editions.js';
import {textRange} from './text-range';
export function time(seconds: number) { const n = Math.max(0, Math.floor(seconds)); return [n >= 3600 ? String(Math.floor(n / 3600)).padStart(2, '0') : null, String(Math.floor(n / 60) % 60).padStart(2, '0'), String(n % 60).padStart(2, '0')].filter(v => v !== null).join(':'); }
export function currentCue(cues: ReaderCue[], seconds: number): ReaderCue | undefined {
    let lo = 0, hi = cues.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cues[mid].start <= seconds)
            lo = mid + 1;
        else
            hi = mid;
    }
    for (let i = lo - 1; i >= 0; i--) {
        if (cues[i].start <= seconds && seconds < cues[i].end)
            return cues[i];
    }
    return undefined;
}
export function filterCues(doc: ReaderDocument, query: string, displayText:(text:string)=>string=text=>text, phraseHits?:ReadonlyMap<string,unknown>) { const q = displayText(query).trim().toLocaleLowerCase(); return doc.segments.filter(cue => !q || phraseHits?.has(cue.id) || [cue.text, doc.notes?.[cue.id] || '', cue.speaker || '', cue.translations?.[doc.translation_view || '']?.text || ''].some(text => displayText(text).toLocaleLowerCase().includes(q))); }
export function selectionOffsets(root: HTMLElement, selection: Selection | null): {
    from: number;
    to: number;
    text: string;
} | null {
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed)
        return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer))
        return null;
    const before = range.cloneRange();
    before.selectNodeContents(root);
    before.setEnd(range.startContainer, range.startOffset);
    const from = before.toString().length, to = from + range.toString().length;
    return to > from ? { from, to, text: range.toString() } : null;
}
export interface SourceSelection {
    cueIds: string[];
    from: number;
    to: number;
    text: string;
    separators: string[];
}
const readingPieces='[data-reading-from][data-reading-to]';
export const translationTarget='.immersive-translate-target-wrapper,[data-immersive-translate-translation-element-mark]';
const elementAt=(node:Node)=>node.nodeType===1?node as Element:node.parentElement;

function readingPoint(node:Node,offset:number,edge:'start'|'end',cue:ReaderCue,displayText:(text:string)=>string) {
    const element=elementAt(node);
    if(element?.closest(translationTarget))return null;
    const mark=element?.closest<HTMLElement>('[data-reading-at]');
    if(mark)return Number(mark.dataset.readingAt);
    const piece=element?.closest<HTMLElement>(readingPieces);
    if(!piece)return null;
    const from=Number(piece.dataset.readingFrom),to=Number(piece.dataset.readingTo);
    if(piece.dataset.readingReplacement)return edge==='start'?from:to;
    const shown=displayText(cue.text);
    if(shown.length!==cue.text.length||shown.slice(from,to)!==piece.textContent)return null;
    const before=node.ownerDocument!.createRange();
    before.selectNodeContents(piece);before.setEnd(node,offset);
    return from+before.toString().length;
}

export function readingSourceOffset(node:HTMLElement,cue:ReaderCue,offset:number,displayText:(text:string)=>string):number|null {
    const piece=node.closest<HTMLElement>(readingPieces);
    if(!piece||node.closest(translationTarget))return null;
    if(piece.dataset.readingReplacement)return Number(piece.dataset.readingFrom);
    const from=Number(piece.dataset.readingFrom),to=Number(piece.dataset.readingTo),shown=displayText(cue.text);
    return shown.length===cue.text.length&&shown.slice(from,to)===piece.textContent?from+offset:null;
}

/** Resolve canonical offsets against visible pieces, skipping omitted speech and editorial punctuation. */
export function visibleSourceRange(host:HTMLElement,doc:ReaderDocument,selection:SourceSelection):Range|null {
    const lengths=new Map(doc.segments.map(cue=>[cue.id,cue.text.length]));
    const nodesByCue=new Map<string,HTMLElement[]>();
    for(const node of host.querySelectorAll<HTMLElement>('[data-source-id]')) {
        if(node.closest(translationTarget))continue;
        const id=node.dataset.sourceId!,nodes=nodesByCue.get(id);
        if(nodes)nodes.push(node);else nodesByCue.set(id,[node]);
    }
    let shift=0,result:Range|null=null;
    for(const [index,id] of selection.cueIds.entries()) {
        const length=lengths.get(id)??0;
        const from=Math.max(0,selection.from-shift),to=Math.min(length,selection.to-shift);
        shift+=length+(selection.separators[index]?.length??0);
        for(const node of nodesByCue.get(id)??[]) {
            const pieces=node.querySelectorAll<HTMLElement>(readingPieces);
            if(!pieces.length&&node.dataset.readingEdited)continue;
            for(const piece of pieces.length?Array.from(pieces):[node]) {
                if(piece.closest(translationTarget)||piece.querySelector(translationTarget))continue;
                const start=Number(piece.dataset.readingFrom??0),end=Number(piece.dataset.readingTo??length);
                const a=Math.max(from,start),b=Math.min(to,end);
                if(b<=a)continue;
                const replaced=piece.dataset.readingReplacement;
                const range=textRange(piece,replaced?0:a-start,replaced?piece.textContent!.length:b-start);
                if(!range)continue;
                if(!result)result=range;
                else result.setEnd(range.endContainer,range.endOffset);
            }
        }
    }
    return result;
}

export function captureSourceSelection(host: HTMLElement, doc: ReaderDocument, selection: Selection | null, separator: (left: string, right: string) => string, displayText:(text:string)=>string=text=>text): SourceSelection | null {
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
        return null;
    const range = selection.getRangeAt(0);
    const startElement=elementAt(range.startContainer),endElement=elementAt(range.endContainer);
    if(startElement?.closest(translationTarget)||endElement?.closest(translationTarget))return null;
    const first=startElement?.closest<HTMLElement>('[data-source-id]'), last=endElement?.closest<HTMLElement>('[data-source-id]');
    if(!first||!last||!host.contains(first)||!host.contains(last))return null;
    const fromIndex=doc.segments.findIndex(cue=>cue.id===first.dataset.sourceId),toIndex=doc.segments.findIndex(cue=>cue.id===last.dataset.sourceId);
    if(fromIndex<0||toIndex<fromIndex)return null;
    const cues=doc.segments.slice(fromIndex,toIndex+1);
    const sourceNodes=new Map<string,HTMLElement[]>();
    for(const node of host.querySelectorAll<HTMLElement>('[data-source-id]')) {
        if(node.closest(translationTarget))continue;
        const id=node.dataset.sourceId!,nodes=sourceNodes.get(id);
        if(nodes)nodes.push(node);else sourceNodes.set(id,[node]);
    }
    const displayed=(cue:ReaderCue)=>{
        const nodes=sourceNodes.get(cue.id);
        return nodes?.some(node=>node.dataset.readingEdited)||nodes?.length===1&&nodes[0].textContent===displayText(cue.text)&&displayText(cue.text).length===cue.text.length;
    };
    if(cues.some(cue=>!displayed(cue)))return null;
    const point=(root:HTMLElement,cue:ReaderCue,node:Node,offset:number,edge:'start'|'end')=>{
        if(root.dataset.readingEdited)return readingPoint(node,offset,edge,cue,displayText);
        const before=range.cloneRange();before.selectNodeContents(root);before.setEnd(node,offset);
        return before.toString().length;
    };
    const from=point(first,cues[0],range.startContainer,range.startOffset,'start');
    const lastCue=cues.at(-1)!;
    const end=point(last,lastCue,range.endContainer,range.endOffset,'end');
    if(from===null||end===null)return null;
    const separators=cues.slice(1).map((cue,i)=>separator(cues[i].text,cue.text));
    const composed=cues.map((cue,i)=>(i?separators[i-1]:'')+cue.text).join('');
    const to=composed.length-lastCue.text.length+end;
    if(to<=from)return null;
    const text=composed.slice(from,to);
    return { cueIds: cues.map(c => c.id), from, to, text, separators };
}

export function captureEditionSelection(host:HTMLElement,blocks:Block[],selection:Selection|null):{blockId:string;from:number;to:number;text:string;blockText:string}|null{
 if(!selection||selection.isCollapsed||selection.rangeCount!==1)return null;
 const range=selection.getRangeAt(0),element=(node:Node)=>node.nodeType===1?node as Element:node.parentElement;
 const first=element(range.startContainer)?.closest<HTMLElement>('[data-edition-block-id]'),last=element(range.endContainer)?.closest<HTMLElement>('[data-edition-block-id]');
 if(!first||first!==last||!host.contains(first))return null;
 const block=blocks.find(block=>block.id===first.dataset.editionBlockId);if(!block)return null;
 const text=blockText(block);if(first.textContent!==text)return null;
 const before=range.cloneRange();before.selectNodeContents(first);before.setEnd(range.startContainer,range.startOffset);
 const from=before.toString().length,to=from+range.toString().length;
 if(to<=from||text.slice(from,to)!==range.toString())return null;
 return {blockId:block.id,from,to,text:text.slice(from,to),blockText:text};
}
