import {getCue, type Projection} from '@coconut/reader/disfluency.js';
import type {ReaderCue} from './contracts';
import {speechParts, type SpeechPart} from './speech';

export type ReadingPiece =
    | {kind:'source'|'replacement'; text:string; from:number; to:number}
    | {kind:'mark'; text:string; at:number};
export type ReadingReplacement = {from:number; to:number; text:string};
export type ReadingRun = {cueId:string; pieces:ReadingPiece[]; speech:SpeechPart; mapped:boolean; edited:boolean};
export type ReadingParagraph = {runs:ReadingRun[]; separators:Map<number,string>};

export function readingParagraphs(cues:ReaderCue[], options:{
    separator:(left:string,right:string)=>string;
    displayText:(text:string)=>string;
    projection?:Projection;
    playbackCues?:ReadonlyMap<string,ReaderCue>;
    replacements?:ReadonlyMap<string,readonly ReadingReplacement[]>;
}):ReadingParagraph[] {
    const paragraphs:ReadingParagraph[]=[];
    const firstParagraph=():ReadingParagraph=>({runs:[],separators:new Map()});
    let paragraph=firstParagraph(), previous='';
    const paragraphBreak=()=>{
        if(paragraph.runs.some(run=>run.pieces.some(piece=>piece.text.trim()))) {
            paragraphs.push(paragraph);
            paragraph=firstParagraph();
        }
        previous='';
    };
    for(const cue of cues) {
        const playback=options.playbackCues?.get(cue.id)??cue;
        const shown=options.displayText(cue.text);
        const mapped=shown.length===cue.text.length;
        const edits=options.replacements?.get(cue.id)??[];
        const projection=mapped&&options.projection?getCue(options.projection,cue.id):null;
        const marks=new Map(projection?.marks.filter(mark=>!edits.some(edit=>edit.from<mark.at&&mark.at<edit.to)).map(mark=>[mark.at,mark.mark]));
        const breaks=new Set(projection?.breaks.filter(item=>!edits.some(edit=>edit.from<item.at&&item.at<edit.to)).map(item=>item.at));
        const hidden=projection?.spans.filter(span=>span.action==='hide'&&!edits.some(edit=>edit.from<span.to&&span.from<edit.to))??[];
        const edited=Boolean(edits.length||marks.size||breaks.size||hidden.length);
        const speech=mapped&&!edits.length?speechParts(playback):[{from:0,to:cue.text.length,start:playback.start,end:playback.end}];
        let cueText='';
        for(const part of speech) {
            const cuts=new Set([part.from,part.to]);
            const inside=(at:number)=>at>part.from&&at<part.to;
            for(const span of [...hidden,...edits]) {
                if(inside(span.from))cuts.add(span.from);
                if(inside(span.to))cuts.add(span.to);
            }
            for(const at of [...marks.keys(),...breaks])if(inside(at))cuts.add(at);
            const boundaries=[...cuts].sort((a,b)=>a-b);
            let pieces:ReadingPiece[]=[];
            const append=()=>{
                if(!pieces.length)return;
                const text=pieces.map(piece=>piece.text).join('');
                const gap=cueText||!previous?'':options.separator(previous,text);
                if(gap)paragraph.separators.set(paragraph.runs.length,gap);
                paragraph.runs.push({cueId:cue.id,speech:part,pieces,mapped,edited});
                cueText+=text;
                pieces=[];
            };
            for(let i=1;i<boundaries.length;i++) {
                const from=boundaries[i-1],to=boundaries[i];
                const replacement=edits.find(edit=>edit.from<=from&&to<=edit.to);
                if(replacement) {
                    if(from===replacement.from)pieces.push({kind:'replacement',from,to:replacement.to,text:options.displayText(replacement.text)});
                } else if(!hidden.some(span=>span.from<=from&&to<=span.to)) {
                    pieces.push({kind:'source',from,to,text:mapped?shown.slice(from,to):shown});
                }
                const mark=marks.get(to);
                if(mark)pieces.push({kind:'mark',at:to,text:mark});
                if(breaks.has(to)){append();paragraphBreak();}
            }
            append();
        }
        if(!cueText)paragraph.runs.push({cueId:cue.id,speech:speech[0],pieces:[],mapped,edited});
        else previous=cueText;
    }
    if(paragraph.runs.length) {
        // A terminal break can leave only omitted cue anchors. Keep them with
        // the preceding paragraph so they remain navigable without a blank row.
        if(paragraphs.length&&paragraph.runs.every(run=>!run.pieces.length))paragraphs.at(-1)!.runs.push(...paragraph.runs);
        else paragraphs.push(paragraph);
    }
    return paragraphs;
}

export type ReadingChapter = {cue_id:string;title:string;kind:'manual'|'publisher'|'model'};

export function readingChapters(cues:ReaderCue[],manual:readonly {cue_id:string;title:string}[],
    publisher:readonly {start:number;title:string}[],model:readonly {cue_id:string;title:string}[]):ReadingChapter[] {
    const positions=new Map(cues.map((cue,index)=>[cue.id,index]));
    const authored=manual.filter(chapter=>positions.has(chapter.cue_id)).map(chapter=>({...chapter,kind:'manual' as const}));
    const byCue=new Map(authored.map(chapter=>[chapter.cue_id,chapter] as [string,ReadingChapter]));
    if(publisher.length){
        let index=0;
        for(const chapter of publisher){
            while(index<cues.length&&cues[index].end<=chapter.start)index++;
            const cue=cues[index];
            if(cue&&!byCue.has(cue.id))byCue.set(cue.id,{cue_id:cue.id,title:chapter.title,kind:'publisher'});
        }
    }else if(!authored.length){
        for(const chapter of model)if(positions.has(chapter.cue_id)&&!byCue.has(chapter.cue_id))
            byCue.set(chapter.cue_id,{...chapter,kind:'model'});
    }
    return [...byCue.values()].sort((a,b)=>positions.get(a.cue_id)!-positions.get(b.cue_id)!);
}
