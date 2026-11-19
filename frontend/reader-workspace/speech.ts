import type {ReaderCue, ReaderDocument} from './contracts';
import type {SourceSelection} from './domain';

export type SpeechPart = {from:number; to:number; start:number; end:number};
type TimedWord = SpeechPart & {word:string};
export const LISTENING_LEAD_SECONDS=.5;

/** Use only clocks whose text still exactly matches the displayed source. */
function timedWords(cue:ReaderCue):TimedWord[] | null {
    if(!Array.isArray(cue.words)||!cue.words.length)return null;
    const sourceAligned=Boolean(cue.alignment_media_sha256);
    const words:TimedWord[]=[];let offset=0,previous=cue.start;
    for(const value of cue.words){
        const word=value as {word?:unknown;start?:unknown;end?:unknown};
        if(typeof word?.word!=='string'||typeof word.start!=='number'||typeof word.end!=='number'||
            !Number.isFinite(word.start)||!Number.isFinite(word.end)||word.start<cue.start||word.start<previous||word.end<word.start||word.end>cue.end||
            sourceAligned&&(!word.word.trim()||word.end===word.start))return null;
        words.push({word:word.word,from:offset,to:offset+word.word.length,start:word.start,end:word.end});
        offset+=word.word.length;previous=sourceAligned?word.end:word.start;
    }
    return words.map(word=>word.word).join('')===cue.text?words:null;
}

/** Older accepted jobs kept the asset hash on the alignment receipt. */
function legacyBindings(alignment:unknown) {
    const receipt = alignment as {asset_sha256?:string;source_snapshot?:{segments?:ReaderCue[]};report?:{cues?:Array<{cue_id:string;status:string}>}}|undefined;
    const snapshot = receipt?.source_snapshot?.segments;
    const report = receipt?.report?.cues;
    if(typeof receipt?.asset_sha256!=='string'||!/^[a-f0-9]{64}$/.test(receipt.asset_sha256)||!Array.isArray(snapshot)||!Array.isArray(report))return null;
    const accepted = new Map(snapshot.flatMap((cue,index)=>{
        const result=report[index];
        return typeof cue?.id==='string'&&result?.status==='aligned'&&result.cue_id===cue.id?[[cue.id,cue] as const]:[];
    }));
    return {hash:receipt.asset_sha256,accepted};
}

export function sourcePlayback(cues:ReaderCue[],mediaIdentity?:string,alignment?:unknown){
    const gaps=new Map<string,{start:number;end:number}>();
    const legacy=legacyBindings(alignment);
    if(!legacy&&!cues.some(cue=>cue.alignment_media_sha256))return {cues,gaps};
    const playable=cues.map(cue=>{
        const original=legacy?.accepted.get(cue.id);
        const hash=cue.alignment_media_sha256 || (original?.text===cue.text&&original.start===cue.start&&original.end===cue.end ? legacy?.hash : undefined);
        if(!hash)return cue;
        return mediaIdentity==='source-media-sha256:'+hash
            ? {...cue,alignment_media_sha256:hash}
            : {...cue,words:undefined,alignment_media_sha256:undefined};
    });
    const anchors=playable.map(cue=>cue.alignment_media_sha256?timedWords(cue):null);
    for(let i=1;i<playable.length-1;i++){
        const cue=playable[i],start=anchors[i-1]?.at(-1)?.end,end=anchors[i+1]?.[0].start;
        if(start===undefined||end===undefined||end<=start||!cue.text.trim()||timedWords(cue))continue;
        gaps.set(cue.id,{start,end});
        playable[i]={...cue,start,end,words:undefined,alignment_media_sha256:undefined};
    }
    return {cues:playable,gaps};
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

/** Use the clicked word for accepted source alignment, or the reading unit otherwise. */
export function speechSelection(cue:ReaderCue,offset:number):SourceSelection|null {
    if(!Number.isSafeInteger(offset)||offset<0||offset>=cue.text.length)return null;
    const parts=(cue.alignment_media_sha256&&timedWords(cue))||speechParts(cue);
    const part=parts.find(part=>part.from<=offset&&offset<part.to);
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
