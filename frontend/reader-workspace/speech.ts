import type {ReaderCue, ReaderDocument} from './contracts';
import type {SourceSelection} from './domain';

export type SpeechPart = {from:number; to:number; start:number; end:number};
type TimedWord = SpeechPart & {word:string};
export const LISTENING_LEAD_SECONDS=.5;

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

const MAX_SECONDS=4,MAX_CHARACTERS=36,PAUSE_SECONDS=.6;
const clauseEnd=(word:string)=>/[，,。.!?！？；;：:…\n][\s"'”’）)\]】」』]*$/u.test(word);
const segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter('zh',{granularity:'word'}):null;

/** One stable partition owns hover, selection and playback highlighting. */
export function speechParts(cue:ReaderCue):SpeechPart[] {
    const words=timedWords(cue);
    if(!words)return [{from:0,to:cue.text.length,start:cue.start,end:cue.end}];
    const lexicalEnds=new Set(segmenter?Array.from(segmenter.segment(cue.text)).filter(part=>part.isWordLike).map(part=>part.index+part.segment.length):[]);
    const parts:SpeechPart[]=[];
    for(let first=0;first<words.length;){
        const start=words[first].start,from=words[first].from;
        let end=start,lastLexical=first,last=first;
        for(let index=first;index<words.length;index++){
            const word=words[index],nextEnd=Math.max(end,word.end);
            if(index>first&&(nextEnd-start>MAX_SECONDS||word.to-from>MAX_CHARACTERS)){
                // Long clauses fall back to the last whole linguistic word.
                // An indivisible aligned unit keeps its actual interval.
                last=lastLexical>first?lastLexical:index;
                break;
            }
            end=nextEnd;last=index+1;
            if(lexicalEnds.has(word.from+word.word.trimEnd().length))lastLexical=last;
            const pause=words[index+1]&&words[index+1].start-end>=PAUSE_SECONDS;
            const substantial=end-start>=.8||word.to-from>=6;
            // Brief fillers such as “嗯，” stay with the following clause.
            if(pause||(clauseEnd(word.word)&&substantial)||last===words.length)break;
        }
        const group=words.slice(first,last);
        parts.push({from,to:group.at(-1)!.to,start,end:Math.max(...group.map(word=>word.end))});
        first=last;
    }
    return parts;
}

/** Every position within the hovered unit selects exactly that same unit. */
export function speechSelection(cue:ReaderCue,offset:number):SourceSelection|null {
    if(!Number.isSafeInteger(offset)||offset<0||offset>=cue.text.length)return null;
    const part=speechParts(cue).find(part=>part.from<=offset&&offset<part.to);
    if(!part)return null;
    const {from,to}=part;
    return {cueIds:[cue.id],from,to,text:cue.text.slice(from,to),separators:[]};
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
