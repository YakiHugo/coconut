import {getCue, type Projection} from '@coconut/reader/disfluency.js';
import type {ReaderCue} from './contracts';
import {sourceClockForRange,speechParts, type SpeechPart} from './speech';

export type ReadingPiece =
    | {kind:'source'|'replacement'; text:string; from:number; to:number}
    | {kind:'mark'; text:string; at:number};
export type ReadingReplacement = {from:number; to:number; text:string};
export type ReadingJoin = {first:string;previous?:string};
export type ReadingRun = {cueId:string; pieces:ReadingPiece[]; speech:SpeechPart; mapped:boolean; edited:boolean};
export type ReadingParagraph = {runs:ReadingRun[]; separators:Map<number,string>};

export function readingParagraphs(cues:ReaderCue[], options:{
    separator:(left:string,right:string)=>string;
    displayText:(text:string)=>string;
    projection?:Projection;
    playbackCues?:ReadonlyMap<string,ReaderCue>;
    replacements?:ReadonlyMap<string,readonly ReadingReplacement[]>;
    joins?:ReadonlyMap<string,ReadingJoin>;
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
    for(const [index,cue] of cues.entries()) {
        const playback=options.playbackCues?.get(cue.id)??cue;
        const shown=options.displayText(cue.text);
        const mapped=shown.length===cue.text.length;
        const edits=options.replacements?.get(cue.id)??[];
        const join=options.joins?.get(cue.id);
        const joinedBefore=Boolean(join?.previous&&join.previous===cues[index-1]?.id);
        const joinedAfter=Boolean(cues[index+1]&&options.joins?.get(cues[index+1].id)?.previous===cue.id);
        const projection=mapped&&options.projection?getCue(options.projection,cue.id):null;
        const marks=new Map(projection?.marks.filter(mark=>!edits.some(edit=>edit.from<mark.at&&(mark.at<edit.to||join&&mark.at===edit.to))).map(mark=>[mark.at,mark.mark]));
        const breaks=new Set(projection?.breaks.filter(item=>!(joinedAfter&&item.at===cue.text.length)&&!edits.some(edit=>edit.from<item.at&&item.at<edit.to)).map(item=>item.at));
        const hidden=projection?.spans.filter(span=>span.action==='hide'&&!edits.some(edit=>edit.from<span.to&&span.from<edit.to))??[];
        const edited=Boolean(edits.length||marks.size||breaks.size||hidden.length);
        const speech=mapped&&!edits.length?speechParts(playback):[{from:0,to:cue.text.length,start:playback.start,end:playback.end}];
        const clock=edited?sourceClockForRange(playback):null;
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
                const gap=cueText||!previous||joinedBefore?'':options.separator(previous,text);
                if(gap)paragraph.separators.set(paragraph.runs.length,gap);
                const source=pieces.filter(piece=>piece.kind!=='mark');
                const clip=clock&&source.length?clock(source[0].from,source.at(-1)!.to,part):part;
                paragraph.runs.push({cueId:cue.id,speech:clip,pieces,mapped,edited});
                cueText+=text;
                pieces=[];
            };
            for(let i=1;i<boundaries.length;i++) {
                const from=boundaries[i-1],to=boundaries[i];
                const replacement=edits.find(edit=>edit.from<=from&&to<=edit.to);
                if(replacement) {
                    if(from===replacement.from)pieces.push({kind:'replacement',from,to:replacement.to,text:options.displayText(replacement.text)});
                } else if(!hidden.some(span=>span.from<=from&&to<=span.to)) {
                    pieces.push({kind:'source',from,to,text:mapped?shown.slice(from,to):edits.length?options.displayText(cue.text.slice(from,to)):shown});
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

export type ReadingAdjustment={cue_id:string;text:string};
export function readingAdjustments(cues:ReaderCue[],value:unknown,sourceSignature:string|undefined):ReadingAdjustment[] {
    const stored=value as {version?:unknown;source_signature?:unknown;edits?:unknown}|null;
    if(!sourceSignature||stored?.version!==1||stored.source_signature!==sourceSignature||
        !Array.isArray(stored.edits)||stored.edits.length>500)return [];
    const ids=new Set(cues.map(cue=>cue.id));
    const edits=new Map<string,ReadingAdjustment>();
    for(const entry of stored.edits){
        if(entry&&ids.has(entry.cue_id)&&typeof entry.text==='string'&&entry.text.trim()&&entry.text.length<=6000)
            edits.set(entry.cue_id,{cue_id:entry.cue_id,text:entry.text});
    }
    return [...edits.values()];
}

export function readingReplacements(cues:ReaderCue[],suggestions:ReadonlyMap<string,readonly ReadingReplacement[]>,
    adjustments:ReadingAdjustment[]):ReadonlyMap<string,readonly ReadingReplacement[]> {
    if(!adjustments.length)return suggestions;
    const result=new Map(suggestions),lengths=new Map(cues.map(cue=>[cue.id,cue.text.length]));
    for(const edit of adjustments){
        const to=lengths.get(edit.cue_id);
        if(to)result.set(edit.cue_id,[{from:0,to,text:edit.text}]);
    }
    return result;
}

export function readingSpeakerNames(value:unknown,groups:ReadonlyMap<string,ReaderCue>) {
    const names=new Map<string,string>();
    if(!Array.isArray(value))return names;
    for(const entry of value.slice(0,500)){
        if(entry&&typeof entry.id==='string'&&groups.has(entry.id)&&typeof entry.name==='string'&&
            entry.name.trim()&&entry.name.length<=120)names.set(entry.id,entry.name.trim());
    }
    return names;
}
