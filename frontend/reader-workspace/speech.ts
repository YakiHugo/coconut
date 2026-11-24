import type {ReaderCue, ReaderDocument} from './contracts';
import type {SourceSelection} from './domain';

export type SpeechPart = {from:number; to:number; start:number; end:number};
type TimedWord = SpeechPart & {word:string;clock:'observed'|'collapsed'|'unverified'};
const WORD_CLOCK_TOLERANCE=.05+1e-9;
export const LISTENING_LEAD_SECONDS=.5;

function hasWordAlignment(cue:ReaderCue){
    return Boolean(cue.alignment_media_sha256)||(cue.timing_basis==='word'&&cue.alignment_status==='complete');
}

/** Keep text offsets for every token while isolating invalid clocks. */
function timedWords(cue:ReaderCue):TimedWord[] | null {
    if(!Array.isArray(cue.words)||!cue.words.length)return null;
    const words:TimedWord[]=[],trusted:TimedWord[]=[];
    let offset=0;
    for(const value of cue.words){
        const word=value as {word?:unknown;start?:unknown;end?:unknown};
        if(typeof word?.word!=='string')return null;
        if(!word.word.length)continue;
        const from=offset,to=offset+word.word.length;
        offset=to;
        let start=cue.start,end=cue.start,clock:TimedWord['clock']='unverified';
        if(typeof word.start==='number'&&typeof word.end==='number'&&Number.isFinite(word.start)&&Number.isFinite(word.end)&&
            word.start>=cue.start-WORD_CLOCK_TOLERANCE&&word.end<=cue.end+WORD_CLOCK_TOLERANCE&&word.end>=word.start){
            start=Math.max(cue.start,word.start);end=Math.min(cue.end,word.end);
            if(start===end)clock='collapsed';
            if(start<end)clock='observed';
        }
        const token:TimedWord={word:word.word,from,to,start,end,clock};
        words.push(token);
        if(clock!=='observed')continue;
        const prior=trusted.at(-1);
        if(prior&&prior.end>start){
            if(prior.end-start<=WORD_CLOCK_TOLERANCE&&end>prior.end)token.start=prior.end;
            else if(prior.end>end&&(trusted.at(-2)?.end??cue.start)<=start){
                // A single reported clock can span later, otherwise coherent words.
                prior.clock='unverified';trusted.pop();
            }else{token.clock='unverified';continue;}
        }
        trusted.push(token);
    }
    if(!trusted.length||words.map(word=>word.word).join('')!==cue.text)return null;
    let edge=cue.start;
    for(const word of words){
        if(word.clock==='observed')edge=word.end;
        else if(word.clock==='unverified')word.start=word.end=edge;
    }
    return words;
}

export function sourcePlayback(cues:ReaderCue[],mediaIdentity?:string){
    const gaps=new Map<string,{start:number;end:number}>();
    if(!cues.some(cue=>cue.alignment_media_sha256))return {cues,gaps};
    const playable=cues.map(cue=>cue.alignment_media_sha256&&mediaIdentity!=='source-media-sha256:'+cue.alignment_media_sha256
        ? {...cue,words:undefined,alignment_media_sha256:undefined,timing_basis:'segment'} : cue);
    const anchors=playable.map(cue=>cue.alignment_media_sha256?timedWords(cue)?.filter(word=>word.clock==='observed'):null);
    for(let i=1;i<playable.length-1;i++){
        const cue=playable[i],start=anchors[i-1]?.at(-1)?.end,end=anchors[i+1]?.[0].start;
        if(cue.end>cue.start||start===undefined||end===undefined||end<=start||!cue.text.trim()||timedWords(cue))continue;
        gaps.set(cue.id,{start,end});
        playable[i]={...cue,start,end,words:undefined,alignment_media_sha256:undefined};
    }
    return {cues:playable,gaps};
}

const MAX_SECONDS=4,MAX_CHARACTERS=36,PAUSE_SECONDS=.6;
const clauseEnd=(word:string)=>/[，,。.!?！？；;：:…\n][\s"'”’）)\]】」』]*$/u.test(word);
const segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter('zh',{granularity:'word'}):null;

/** One stable partition owns hover, selection and playback highlighting. */
const partsByCue=new WeakMap<ReaderCue,SpeechPart[]>();
export function speechParts(cue:ReaderCue):SpeechPart[] {
    const known=partsByCue.get(cue);
    if(known)return known;
    const parts=buildSpeechParts(cue);
    partsByCue.set(cue,parts);
    return parts;
}
function buildSpeechParts(cue:ReaderCue):SpeechPart[] {
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
            const next=words[index+1];
            const pause=next&&next.start-end>=PAUSE_SECONDS;
            const clockGap=next&&(word.clock==='unverified')!==(next.clock==='unverified');
            const substantial=end-start>=.8||word.to-from>=6;
            // Brief fillers such as “嗯，” stay with the following clause.
            if(pause||clockGap||(clauseEnd(word.word)&&substantial)||last===words.length)break;
        }
        const group=words.slice(first,last);
        parts.push({from,to:group.at(-1)!.to,start,end:Math.max(...group.map(word=>word.end))});
        first=last;
    }
    return parts;
}

/** Use the actual word when its timing is verified; otherwise select the reading unit. */
export function speechSelection(cue:ReaderCue,offset:number):SourceSelection|null {
    if(!Number.isSafeInteger(offset)||offset<0||offset>=cue.text.length)return null;
    const parts=(hasWordAlignment(cue)&&timedWords(cue))||speechParts(cue);
    const part=parts.find(part=>part.from<=offset&&offset<part.to);
    if(!part)return null;
    const {from,to}=part;
    return {cueIds:[cue.id],from,to,text:cue.text.slice(from,to),separators:[]};
}

export function selectionPlaybackStart(doc:ReaderDocument,selection:SourceSelection,rangeEnd?:(cue:ReaderCue)=>number|undefined):{seconds:number;wordAligned:boolean;end?:number} | null {
    const start=doc.segments.findIndex(cue=>cue.id===selection.cueIds[0]);
    if(start<0||selection.from<0||selection.to<=selection.from)return null;
    let offset=0;
    for(const [index,id] of selection.cueIds.entries()){
        const cue=doc.segments[start+index];if(!cue||cue.id!==id)return null;
        const from=Math.max(0,selection.from-offset),to=Math.min(cue.text.length,selection.to-offset);
        if(to>from){
            const words=timedWords(cue);
            const index=words?.findIndex(word=>word.to>from&&word.from<to)??-1;
            if(words&&index>=0){
                const word=words[index];
                if(word.clock==='observed')
                    return {seconds:word.start,wordAligned:true};
            }
            const end=rangeEnd?.(cue);
            return {seconds:cue.start,wordAligned:false,...(end===undefined?{}:{end})};
        }
        offset+=cue.text.length+(selection.separators[index]?.length??0);
    }
    return null;
}
