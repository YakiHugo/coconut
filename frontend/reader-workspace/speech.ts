import type {ReaderCue, ReaderDocument} from './contracts';
import type {SourceSelection} from './domain';

export type SpeechPart = {from:number; to:number; start:number; end:number};
type TimedWord = SpeechPart & {word:string};

/** Use only clocks whose text still exactly matches the displayed source. */
function timedWords(cue:ReaderCue):TimedWord[] | null {
    if(!Array.isArray(cue.words)||!cue.words.length)return null;
    const words:TimedWord[]=[];let offset=0,previous=cue.start;
    for(const value of cue.words){
        const word=value as {word?:unknown;start?:unknown;end?:unknown};
        if(typeof word?.word!=='string'||typeof word.start!=='number'||typeof word.end!=='number'||
            !Number.isFinite(word.start)||!Number.isFinite(word.end)||word.start<cue.start||word.start<previous||word.end<word.start||word.end>cue.end)return null;
        words.push({word:word.word,from:offset,to:offset+word.word.length,start:word.start,end:word.end});
        offset+=word.word.length;previous=word.start;
    }
    return words.map(word=>word.word).join('')===cue.text?words:null;
}

/** Sentence highlights inherit real word intervals, never interpolated times. */
export function speechParts(cue:ReaderCue):SpeechPart[] {
    const words=timedWords(cue);
    if(!words)return [{from:0,to:cue.text.length,start:cue.start,end:cue.end}];
    const parts:SpeechPart[]=[];let from=0,start=words[0].start,end=start;
    for(const [index,word] of words.entries()){
        end=Math.max(end,word.end);
        if(/[.!?。！？…][\s"'”’）)\]】」』]*$/u.test(word.word)||index===words.length-1){
            if(word.to>from)parts.push({from,to:word.to,start,end});from=word.to;
            start=words[index+1]?.start??end;end=start;
        }
    }
    return parts;
}

export function selectionPlaybackStart(doc:ReaderDocument,selection:SourceSelection):{seconds:number;wordAligned:boolean} | null {
    const start=doc.segments.findIndex(cue=>cue.id===selection.cueIds[0]);
    if(start<0||selection.from<0||selection.to<=selection.from)return null;
    let offset=0;
    for(const [index,id] of selection.cueIds.entries()){
        const cue=doc.segments[start+index];if(!cue||cue.id!==id)return null;
        const from=Math.max(0,selection.from-offset),to=Math.min(cue.text.length,selection.to-offset);
        if(to>from){
            const word=timedWords(cue)?.find(word=>word.to>from&&word.from<to);
            return {seconds:word?.start??cue.start,wordAligned:Boolean(word)};
        }
        offset+=cue.text.length+(selection.separators[index]?.length??0);
    }
    return null;
}
