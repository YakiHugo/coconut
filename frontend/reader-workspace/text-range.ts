function textPoint(root:HTMLElement,offset:number,preferNext=false):{node:Node;offset:number}|null {
    if(!Number.isSafeInteger(offset)||offset<0)return null;
    const walker=root.ownerDocument.createTreeWalker(root,4 /* SHOW_TEXT */);
    let finalPoint:{node:Node;offset:number}|null=null;
    for(let node=walker.nextNode();node;node=walker.nextNode()){
        const length=node.textContent?.length??0;
        if(offset<length||offset===length&&!preferNext)return {node,offset};
        finalPoint={node,offset:length};
        offset-=length;
    }
    return offset===0?finalPoint:null;
}

/** UTF-16 offsets shared by original text, script conversion and exact excerpts. */
export function textRange(root:HTMLElement,from:number,to:number):Range|null {
    if(to<from)return null;
    // At a text-node boundary, a half-open range starts in the next node and
    // ends in the previous one. Empty display-only punctuation or line-break
    // elements between them must not distort one source glyph's geometry.
    const first=textPoint(root,from,true),last=from===to?first:textPoint(root,to);
    if(!first||!last)return null;
    const range=root.ownerDocument.createRange();
    range.setStart(first.node,first.offset);range.setEnd(last.node,last.offset);
    return range;
}

export function supportsTextHighlight():boolean {
    return typeof window.Highlight==='function'&&Boolean(window.CSS?.highlights);
}

/** Hit the actual glyph, rather than the nearest caret in a paragraph's padding. */
export function textOffsetAtPoint(root:HTMLElement,x:number,y:number):number|null {
    const doc=root.ownerDocument as Document & {
        caretPositionFromPoint?:(x:number,y:number)=>{offsetNode:Node;offset:number}|null;
        caretRangeFromPoint?:(x:number,y:number)=>Range|null;
    };
    const point=doc.caretPositionFromPoint?.(x,y);
    const caret=point?{node:point.offsetNode,offset:point.offset}:null;
    const legacy=!caret?doc.caretRangeFromPoint?.(x,y):null;
    const hit=caret||(legacy?{node:legacy.startContainer,offset:legacy.startOffset}:null);
    if(!hit||!root.contains(hit.node))return null;
    const before=doc.createRange();before.selectNodeContents(root);before.setEnd(hit.node,hit.offset);
    const offset=before.toString().length,text=root.textContent||'';
    // Carets snap to the nearer edge. Check the glyph on either side so clicking
    // the right half of a character still selects that character, including CJK.
    for(let from of [offset,offset-1]){
        if(from<0||from>=text.length)continue;
        if(/[\uDC00-\uDFFF]/u.test(text[from])&&from>0)from--;
        const range=textRange(root,from,from+(text.codePointAt(from)!>0xffff?2:1));
        if(range&&Array.from(range.getClientRects()).some(rect=>rect.width>0&&x>=rect.left&&x<=rect.right&&y>=rect.top&&y<=rect.bottom))return from;
    }
    return null;
}

/** Highlight display text without inserting nodes into a translatable paragraph. */
export function textHighlights(root:HTMLElement,needle:string,excluded:string):Range[] {
    const walker=root.ownerDocument.createTreeWalker(root,4);
    const spans:Array<{node:Node;from:number;to:number}>=[];
    let text='';
    for(let node=walker.nextNode();node;node=walker.nextNode()){
        if(node.parentElement?.closest(excluded))continue;
        const value=node.textContent??'';
        if(value){spans.push({node,from:text.length,to:text.length+value.length});text+=value;}
    }
    const escaped=Array.from(needle,char=>'.*+?^$()[]{}|\\'.includes(char)?'\\'+char:char).join('');
    const ranges:Range[]=[];
    let cursor=0;
    for(const match of text.matchAll(new RegExp(escaped,'giu'))){
        const from=match.index,to=from+match[0].length;
        while(spans[cursor]?.to<=from)cursor++;
        for(let i=cursor;spans[i]?.from<to;i++){
            const span=spans[i],range=root.ownerDocument.createRange();
            range.setStart(span.node,Math.max(from,span.from)-span.from);
            range.setEnd(span.node,Math.min(to,span.to)-span.from);
            ranges.push(range);
        }
    }
    return ranges;
}
