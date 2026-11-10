import { Fragment, useMemo, type CSSProperties } from 'react';
import {getCue,type Projection,type ProjectedCue} from '@coconut/reader/disfluency.js';
import type { ReaderCue, ReaderDocument } from './contracts';
import { time } from './domain';
import { SourcePlaybackLink } from './source';
import {speechParts} from './speech';

function SpeechText({cue,current,seconds,position,displayText,projection}:{cue:ReaderCue;current?:string;seconds:number;position:string;displayText:(text:string)=>string;projection?:Projection}) {
    const parts=useMemo(()=>speechParts(cue),[cue]);
    const text=useMemo(()=>displayText(cue.text),[cue.text,displayText]);
    const projected=projection?getCue(projection,cue.id):null;
    const aligned=projected&&text.length===cue.text.length?projected:null;
    const visible=(from:number,to:number)=>!aligned||aligned.spans.some(span=>span.action==='keep'&&span.from<to&&span.to>from);
    const content=(from:number,to:number)=>sourceContent(text,from,to,aligned);
    const active=cue.id===current?parts.findIndex(part=>part.start<=seconds&&(seconds<part.end||part.start===part.end&&seconds===part.start)):-1;
    if(parts.length===1)return <span data-source-id={cue.id} data-cue-id={cue.id} data-speech-from={0} data-speech-to={cue.text.length} data-cleanup-applied={aligned?'true':undefined} className={(cue.id===position?'rw-current ':'')+'rw-speech'+(active===0&&visible(0,cue.text.length)?' rw-playing':'')}>{content(0,text.length)}</span>;
    return <span data-source-id={cue.id} data-cue-id={cue.id} data-cleanup-applied={aligned?'true':undefined} className={cue.id===position?'rw-current':''}>{parts.map((part,index)=><span key={part.from} className={'rw-speech'+(index===active&&visible(part.from,part.to)?' rw-playing':'')} data-speech-start={part.start} data-speech-from={part.from} data-speech-to={part.to}>{content(part.from,part.to)}</span>)}</span>;
}

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

export function PassageView({ doc, cues, passages: supplied, current, seconds=0, position, onLocate, onPlayFrom, canListen = false, displayText=(text:string)=>text,projection }: {
    displayText?:(text:string)=>string;
    projection?:Projection;
    doc: ReaderDocument; cues: ReaderCue[]; passages?: Passage[]; current?: string; seconds?:number; position: string;
    onLocate: (id: string) => void; canListen?: boolean; onPlayFrom: (start: number) => void;
}) {
    const passages = supplied || passageDomain().build(cues, { source: doc.segments, layout: 'reading' });
    const speakers = useMemo(() => [...new Set(doc.segments.map(cue => passageDomain().speakerIdentity(cue)).filter(Boolean))], [doc.segments]);
    const sourcePositions = useMemo(() => new Map(doc.segments.map((cue,index) => [cue,index])), [doc.segments]);
    const continues = (left: Passage | undefined, right: Passage | undefined) => Boolean(left && right &&
        (sourcePositions.get(left.cues.at(-1)!) ?? -2) + 1 === sourcePositions.get(right.cues[0]) &&
        passageDomain().continuous(left.cues.at(-1)!,right.cues[0]));
    return <div className="rw-passages">{passages.map((passage,index) => {
        const speakerIndex = Math.max(0, speakers.indexOf(passageDomain().speakerIdentity(passage.cues[0])));
        const hasSource = typeof doc.source_url === 'string' && /^https?:/.test(doc.source_url);
        const playing = passage.cues.some(cue => cue.id === current);
        const compact = Boolean(passageDomain().speakerIdentity(passage.cues[0])) &&
            passage.cues.reduce((length,cue) => length + cue.text.length, 0) <= 80 &&
            !continues(passages[index-1],passage) && !continues(passage,passages[index+1]);
        return <section className={'rw-passage' + (compact ? ' rw-passage-compact' : '') + (!passage.speaker ? ' rw-speaker-unknown' : '') + (playing ? ' rw-passage-playing' : '')}
            key={passage.key} style={{ '--speaker-hue': [86, 30, 150, 205, 65][speakerIndex % 5] } as CSSProperties}>
            <div className="rw-passage-heading">
                <div className="rw-passage-identity">
                <span className="rw-speaker-label">{passage.speaker || '未标注'}</span>
                <div className="rw-cue-meta">
                    {canListen ? <button type="button" className="rw-time-link" aria-label={'从 ' + time(passage.start) + ' 开始播放'} aria-current={playing ? 'time' : undefined} onClick={() => { onLocate(passage.cues[0].id); onPlayFrom(passage.start); }}>▷ {time(passage.start)}</button>
                        : hasSource ? <SourcePlaybackLink sourceUrl={doc.source_url} start={passage.start} compact/>
                        : <button type="button" className="rw-time-link" onClick={() => onLocate(passage.cues[0].id)}>{time(passage.start)}</button>}
                </div>
                </div>
            </div>
            <p className="rw-original" tabIndex={0} aria-description="单击选取播放位置；按 Enter 选取当前位置；拖选可精确选择。">{passage.cues.map((cue, i) => <span key={cue.id}>{i ? passageDomain().separator(passage.cues[i - 1].text, cue.text) : ''}<SpeechText cue={cue} current={current} seconds={seconds} position={position} displayText={displayText} projection={projection}/></span>)}</p>
        </section>;
    })}</div>;
}
