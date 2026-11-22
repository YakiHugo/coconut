import { Fragment, useMemo, type CSSProperties } from 'react';
import type {Projection} from '@coconut/reader/disfluency.js';
import type { ReaderCue, ReaderDocument } from './contracts';
import { time } from './domain';
import { SourcePlaybackLink } from './source';
import {readingParagraphs,type ReadingParagraph,type ReadingReplacement,type ReadingRun} from './reading-document';

function ReadingSpeech({run,active,single}:{run:ReadingRun;active:boolean;single:boolean}) {
    const {speech,pieces,mapped,edited}=run;
    const exact=mapped&&!edited;
    return <span className={'rw-speech'+(active?' rw-playing':'')} data-speech-from={speech.from} data-speech-to={speech.to}
        data-speech-start={single?undefined:speech.start} data-reading-from={exact?speech.from:undefined} data-reading-to={exact?speech.to:undefined}>
        {pieces.map((piece,index)=>piece.kind==='mark'?<span key={index} data-cleanup-mark={piece.text} data-reading-at={piece.at}>{piece.text}</span>
            :exact||!mapped?piece.text:<span key={index} data-reading-from={piece.from} data-reading-to={piece.to}
                data-reading-replacement={piece.kind==='replacement'?'true':undefined}>{piece.text}</span>)}
    </span>;
}

function ReadingText({paragraph,current,seconds,position}:{paragraph:ReadingParagraph;current?:string;seconds:number;position:string}) {
    const groups:{runs:ReadingRun[];separator:string}[]=[];
    paragraph.runs.forEach((run,index)=>{
        const previous=groups.at(-1);
        if(previous?.runs[0].cueId===run.cueId)previous.runs.push(run);
        else groups.push({runs:[run],separator:paragraph.separators.get(index)??''});
    });
    return <p className="rw-original" tabIndex={0} aria-description="单击选取播放位置；按 Enter 选取当前位置；拖选可精确选择。">
        {groups.map(({runs,separator})=>{
            const {cueId,edited}=runs[0];
            const active=(run:ReadingRun)=>cueId===current&&run.speech.start<=seconds&&(seconds<run.speech.end||seconds===run.speech.start&&seconds===run.speech.end);
            if(runs.length===1&&!edited){
                const run=runs[0];
                return <Fragment key={cueId}>{separator}<span data-source-id={cueId} data-cue-id={cueId} data-speech-from={run.speech.from} data-speech-to={run.speech.to}
                    data-reading-from={run.mapped?run.speech.from:undefined} data-reading-to={run.mapped?run.speech.to:undefined}
                    className={'rw-speech'+(cueId===position?' rw-current':'')+(active(run)?' rw-playing':'')}>{run.pieces[0]?.text}</span></Fragment>;
            }
            return <Fragment key={cueId}>{separator}<span data-source-id={cueId} data-cue-id={cueId}
                data-reading-edited={edited?'true':undefined} data-cleanup-applied={edited?'true':undefined}
                className={cueId===position?'rw-current':undefined}>
                {runs.filter(run=>run.pieces.length).map((run,index)=><ReadingSpeech key={index} run={run} single={runs.length===1}
                    active={active(run)}/>)}
            </span></Fragment>;
        })}
    </p>;
}

export type Passage = { key: string; start: number; end: number; speaker: string | null; cues: ReaderCue[] };
export function passageDomain() {
    return (window as unknown as { CoconutPassages: {
        build: (cues: ReaderCue[], options: { source: ReaderCue[]; layout?: 'reading' }) => Passage[];
        separator: (left: string, right: string) => string;
        speakerIdentity: (cue: ReaderCue) => string | null;
        continuous: (left: ReaderCue, right: ReaderCue) => boolean;
        searchIndex: (cues: ReaderCue[]) => {search:(query:string,scope:'text')=>{byCue:Map<string,unknown>}};
    } }).CoconutPassages;
}

export function PassageView({ doc, cues, passages: supplied, playbackCues, current, seconds=0, position, onLocate, onPlayFrom, canListen = false, displayText=(text:string)=>text,projection,replacements }: {
    displayText?:(text:string)=>string;
    projection?:Projection; replacements?:ReadonlyMap<string,readonly ReadingReplacement[]>;
    doc: ReaderDocument; cues: ReaderCue[]; passages?: Passage[]; current?: string; seconds?:number; position: string;
    playbackCues?: ReadonlyMap<string,ReaderCue>;
    onLocate: (id: string) => void; canListen?: boolean; onPlayFrom: (start: number) => void;
}) {
    const passages = supplied || passageDomain().build(cues, { source: doc.segments, layout: 'reading' });
    const reading = useMemo(()=>passages.map(passage=>readingParagraphs(passage.cues,{
        separator:passageDomain().separator,displayText,projection,playbackCues,replacements
    })),[passages,displayText,projection,playbackCues,replacements]);
    const speakers = useMemo(() => [...new Set(doc.segments.map(cue => passageDomain().speakerIdentity(cue)).filter(Boolean))], [doc.segments]);
    const sourcePositions = useMemo(() => new Map(doc.segments.map((cue,index) => [cue,index])), [doc.segments]);
    const continues = (left: Passage | undefined, right: Passage | undefined) => Boolean(left && right &&
        (sourcePositions.get(left.cues.at(-1)!) ?? -2) + 1 === sourcePositions.get(right.cues[0]) &&
        passageDomain().continuous(left.cues.at(-1)!,right.cues[0]));
    return <article className="rw-passages" lang={typeof doc.language==='string'?doc.language:undefined}>{passages.map((passage,index) => {
        const speakerIndex = Math.max(0, speakers.indexOf(passageDomain().speakerIdentity(passage.cues[0])));
        const hasSource = typeof doc.source_url === 'string' && /^https?:/.test(doc.source_url);
        const playbackStart = playbackCues?.get(passage.cues[0].id)?.start ?? passage.start;
        const playing = passage.cues.some(cue => cue.id === current);
        const compact = Boolean(passageDomain().speakerIdentity(passage.cues[0])) &&
            passage.cues.reduce((length,cue) => length + cue.text.length, 0) <= 80 &&
            !continues(passages[index-1],passage) && !continues(passage,passages[index+1]);
        return <section className={'rw-passage' + (compact ? ' rw-passage-compact' : '') + (!passage.speaker ? ' rw-speaker-unknown' : '') + (playing ? ' rw-passage-playing' : '')}
            key={passage.key} style={{ '--speaker-hue': [86, 30, 150, 205, 65][speakerIndex % 5] } as CSSProperties}>
            <div className="rw-passage-heading notranslate" translate="no">
                <div className="rw-passage-identity">
                <span className="rw-speaker-label">{passage.speaker || '未标注'}</span>
                <div className="rw-cue-meta">
                    {canListen ? <button type="button" className="rw-time-link" aria-label={'从 ' + time(playbackStart) + ' 开始播放'} aria-current={playing ? 'time' : undefined} onClick={() => { onLocate(passage.cues[0].id); onPlayFrom(playbackStart); }}>▷ {time(playbackStart)}</button>
                        : hasSource ? <SourcePlaybackLink sourceUrl={doc.source_url} start={passage.start} compact/>
                        : <button type="button" className="rw-time-link" onClick={() => onLocate(passage.cues[0].id)}>{time(passage.start)}</button>}
                </div>
                </div>
            </div>
            {reading[index].map((paragraph,i)=><ReadingText key={i} paragraph={paragraph} current={current} seconds={seconds} position={position}/>)}
        </section>;
    })}</article>;
}
