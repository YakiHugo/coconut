import { Fragment, memo, useMemo, type CSSProperties } from 'react';
import {getCue,type Projection,type ProjectedCue} from '@coconut/reader/disfluency.js';
import type { ReaderCue, ReaderDocument } from './contracts';
import { time } from './domain';
import { SourcePlaybackLink } from './source';
import {speechParts} from './speech';
import type {PlaybackLocation} from './player';

const SpeechText=memo(function SpeechText({cue,activePartIndex,current,displayText,projection}:{cue:ReaderCue;activePartIndex:number;current:boolean;displayText:(text:string)=>string;projection?:Projection}) {
    const parts=speechParts(cue);
    const text=useMemo(()=>displayText(cue.text),[cue.text,displayText]);
    const projected=projection?getCue(projection,cue.id):null;
    if(text.length!==cue.text.length)return <span data-source-id={cue.id} data-cue-id={cue.id} className={(current?'rw-current ':'')+'rw-speech'+(activePartIndex>=0?' rw-playing':'')}>{text}</span>;
    const aligned=projected;
    const visible=(from:number,to:number)=>!aligned||aligned.spans.some(span=>span.action==='keep'&&span.from<to&&span.to>from);
    const content=(from:number,to:number)=>sourceContent(text,from,to,aligned);
    if(parts.length===1)return <span data-source-id={cue.id} data-cue-id={cue.id} data-speech-from={0} data-speech-to={cue.text.length} data-cleanup-applied={aligned?'true':undefined} className={(current?'rw-current ':'')+'rw-speech'+(activePartIndex===0&&visible(0,cue.text.length)?' rw-playing':'')}>{content(0,text.length)}</span>;
    return <span data-source-id={cue.id} data-cue-id={cue.id} data-cleanup-applied={aligned?'true':undefined} className={current?'rw-current':''}>{parts.map((part,index)=><span key={part.from} className={'rw-speech'+(index===activePartIndex&&visible(part.from,part.to)?' rw-playing':'')} data-speech-start={part.start} data-speech-from={part.from} data-speech-to={part.to}>{content(part.from,part.to)}</span>)}</span>;
});

function sourceContent(text:string,from:number,to:number,projected:ProjectedCue|null) {
    if(!projected)return text.slice(from,to);
    const boundaries=new Set([from,to]);
    for(const span of projected.spans){if(span.from>from&&span.from<to)boundaries.add(span.from);if(span.to>from&&span.to<to)boundaries.add(span.to);}
    const marks=new Map(projected.marks.filter(mark=>mark.at>from&&mark.at<=to).map(mark=>[mark.at,mark]));
    const breaks=new Map(projected.breaks.filter(item=>item.at>from&&item.at<=to).map(item=>[item.at,item]));
    for(const at of [...marks.keys(),...breaks.keys()])boundaries.add(at);
    const cuts=[...boundaries].sort((a,b)=>a-b);
    return cuts.slice(1).map((end,index)=>{
        const begin=cuts[index],value=text.slice(begin,end),hidden=projected.spans.some(span=>span.action==='hide'&&span.from<=begin&&span.to>=end),mark=marks.get(end);
        return <Fragment key={begin}>
            {hidden?<span hidden data-cleanup-hidden="true" data-source-from={begin} data-source-to={end}>{value}</span>:value}
            {mark&&<span className="rw-reading-mark" aria-hidden="true" data-cleanup-mark={mark.mark} data-source-at={mark.at}/>}
            {breaks.has(end)&&<span className="rw-reading-break" aria-hidden="true" data-cleanup-break="true" data-source-at={end}/>}
        </Fragment>;
    });
}

export type Passage = { key: string; start: number; end: number; speaker: string | null; cues: ReaderCue[] };
export function passageDomain() {
    return (window as unknown as { CoconutPassages: {
        build: (cues: ReaderCue[], options: { source: ReaderCue[]; layout?: 'reading' }) => Passage[];
        separator: (left: string, right: string) => string;
        speakerIdentity: (cue: ReaderCue) => string | null;
        continuous: (left: ReaderCue, right: ReaderCue) => boolean;
    } }).CoconutPassages;
}

type PassageActions={onLocate:(id:string)=>void;onPlayFrom:(start:number)=>void};
type PassageRowProps=PassageActions & {
    passage:Passage; speakerIndex:number; compact:boolean; sourceUrl?:string;
    canListen:boolean; playbackCues?:ReadonlyMap<string,ReaderCue>;
    current?:string; activePartIndex:number; position?:string;
    displayText:(text:string)=>string; projection?:Projection;
};
const PassageRow=memo(function PassageRow({passage,speakerIndex,compact,sourceUrl,canListen,playbackCues,current,activePartIndex,position,displayText,projection,onLocate,onPlayFrom}:PassageRowProps) {
    const playbackStart=playbackCues?.get(passage.cues[0].id)?.start??passage.start;
    return <section className={'rw-passage'+(compact?' rw-passage-compact':'')+(!passage.speaker?' rw-speaker-unknown':'')+(current?' rw-passage-playing':'')}
        style={{'--speaker-hue':[86,30,150,205,65][speakerIndex%5]} as CSSProperties}>
        <div className="rw-passage-heading"><div className="rw-passage-identity">
            <span className="rw-speaker-label">{passage.speaker||'未标注'}</span>
            <div className="rw-cue-meta">
                {canListen?<button type="button" className="rw-time-link" aria-label={'从 '+time(playbackStart)+' 开始播放'} aria-current={current?'time':undefined} onClick={()=>onPlayFrom(playbackStart)}>▷ {time(playbackStart)}</button>
                    :sourceUrl?<SourcePlaybackLink sourceUrl={sourceUrl} start={passage.start} compact/>
                    :<button type="button" className="rw-time-link" onClick={()=>onLocate(passage.cues[0].id)}>{time(passage.start)}</button>}
            </div>
        </div></div>
        <p className="rw-original" tabIndex={0} aria-description="单击选取播放位置，双击播放，拖选可精确选择。">{passage.cues.map((cue,i)=>
            <span key={cue.id}>{i?passageDomain().separator(passage.cues[i-1].text,cue.text):''}
                <SpeechText cue={playbackCues?.get(cue.id)??cue} current={cue.id===position} activePartIndex={cue.id===current?activePartIndex:-1} displayText={displayText} projection={projection}/>
            </span>)}</p>
    </section>;
});
const unchanged=(text:string)=>text;
export function PassageView({doc,cues,passages:supplied,playbackCues,active,position,onLocate,onPlayFrom,canListen=false,displayText=unchanged,projection}:PassageActions & {
    displayText?:(text:string)=>string; projection?:Projection;
    doc:ReaderDocument; cues:ReaderCue[]; passages?:Passage[]; active?:PlaybackLocation|null; position:string;
    playbackCues?:ReadonlyMap<string,ReaderCue>; canListen?:boolean;
}) {
    const {rows,byCue}=useMemo(()=>{
        const passages=supplied||passageDomain().build(cues,{source:doc.segments,layout:'reading'});
        const speakers=[...new Set(doc.segments.map(cue=>passageDomain().speakerIdentity(cue)).filter(Boolean))];
        const sourcePositions=new Map(doc.segments.map((cue,index)=>[cue,index]));
        const byCue=new Map<string,Passage>();
        const continues=(left:Passage|undefined,right:Passage|undefined)=>Boolean(left&&right&&
            (sourcePositions.get(left.cues.at(-1)!)??-2)+1===sourcePositions.get(right.cues[0])&&
            passageDomain().continuous(left.cues.at(-1)!,right.cues[0]));
        const rows=passages.map((passage,index)=>{
            for(const cue of passage.cues)byCue.set(cue.id,passage);
            const speaker=passageDomain().speakerIdentity(passage.cues[0]);
            const compact=Boolean(speaker)&&passage.cues.reduce((length,cue)=>length+cue.text.length,0)<=80&&
                !continues(passages[index-1],passage)&&!continues(passage,passages[index+1]);
            return {passage,speakerIndex:Math.max(0,speakers.indexOf(speaker)),compact};
        });
        return {rows,byCue};
    },[supplied,cues,doc.segments]);
    const activeRow=active&&byCue.get(active.cueId),locatedRow=byCue.get(position);
    const sourceUrl=typeof doc.source_url==='string'&&/^https?:/.test(doc.source_url)?doc.source_url:undefined;
    return <div className="rw-passages">{rows.map(row=><PassageRow key={row.passage.key} {...row} sourceUrl={sourceUrl}
        canListen={canListen} playbackCues={playbackCues} current={row.passage===activeRow?active?.cueId:undefined}
        activePartIndex={row.passage===activeRow?active!.partIndex:-1} position={row.passage===locatedRow?position:undefined}
        displayText={displayText} projection={projection} onLocate={onLocate} onPlayFrom={onPlayFrom}/>)}</div>;
}
