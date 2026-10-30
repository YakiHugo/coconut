import type { ReaderCue, ReaderDocument } from './contracts';
import {blockText, type Block} from '../../reader/editions.js';
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
export function filterCues(doc: ReaderDocument, query: string, notesOnly: boolean, speaker: string | null) { const q = query.trim().toLocaleLowerCase(); return doc.segments.filter(cue => (!notesOnly || Boolean(doc.notes?.[cue.id]?.trim())) && (speaker === null || (cue.speaker || '') === speaker) && (!q || [cue.text, doc.notes?.[cue.id] || '', cue.speaker || '', cue.translations?.[doc.translation_view || '']?.text || ''].some(text => text.toLocaleLowerCase().includes(q)))); }
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
export function captureSourceSelection(host: HTMLElement, doc: ReaderDocument, selection: Selection | null, separator: (left: string, right: string) => string): SourceSelection | null {
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
        return null;
    const range = selection.getRangeAt(0);
    const element = (node: Node) => node.nodeType === 1 ? node as Element : node.parentElement;
    const first = element(range.startContainer)?.closest<HTMLElement>('[data-source-id]'), last = element(range.endContainer)?.closest<HTMLElement>('[data-source-id]');
    if (!first || !last || !host.contains(first) || !host.contains(last))
        return null;
    const fromIndex = doc.segments.findIndex(c => c.id === first.dataset.sourceId), toIndex = doc.segments.findIndex(c => c.id === last.dataset.sourceId);
    if (fromIndex < 0 || toIndex < fromIndex)
        return null;
    const cues = doc.segments.slice(fromIndex, toIndex + 1);
    const sourceNodes=new Map<string,HTMLElement>();
    for(const node of host.querySelectorAll<HTMLElement>('[data-source-id]')){
        if(sourceNodes.has(node.dataset.sourceId!))return null;
        sourceNodes.set(node.dataset.sourceId!,node);
    }
    if(cues.some(c=>sourceNodes.get(c.id)?.textContent!==c.text))return null;
    const start = range.cloneRange();
    start.selectNodeContents(first);
    start.setEnd(range.startContainer, range.startOffset);
    const end = range.cloneRange();
    end.selectNodeContents(last);
    end.setEnd(range.endContainer, range.endOffset);
    const separators = cues.slice(1).map((cue, i) => separator(cues[i].text, cue.text));
    const composed = cues.map((cue, i) => (i ? separators[i - 1] : '') + cue.text).join('');
    const from = start.toString().length, to = composed.length - last.textContent!.length + end.toString().length;
    if (to <= from)
        return null;
    const text=composed.slice(from,to);
    // A renderer must never label edited prose as a verbatim source node.
    if(first.textContent!==cues[0].text||last.textContent!==cues.at(-1)!.text)return null;
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

// The domain removal result uses undefined as a deletion instruction. Apply only
// these two known fields; canonical persistence must still reject unknown lossy data.
export function applyExactExcerptRemoval(doc:ReaderDocument,removal:Pick<ReaderDocument,'exact_excerpts'|'exact_excerpt_notes'>):ReaderDocument {
 const next={...doc};
 if(removal.exact_excerpts===undefined)delete next.exact_excerpts;else next.exact_excerpts=removal.exact_excerpts;
 if(removal.exact_excerpt_notes===undefined)delete next.exact_excerpt_notes;else next.exact_excerpt_notes=removal.exact_excerpt_notes;
 return next;
}
