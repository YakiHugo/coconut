import { Fragment, memo, useMemo, type CSSProperties } from 'react';
import type {Projection} from '@coconut/reader/disfluency.js';
import type { ReaderCue, ReaderDocument } from './contracts';
import { time } from './domain';
import { SourcePlaybackLink } from './source';
import type {PlaybackLocation} from './player';

import {readingParagraphs,type ReadingParagraph,type ReadingReplacement,type ReadingRun,type ReadingChapter,type ReadingJoin} from './reading-document';

const SpeechText=memo(function SpeechText({run,active,single}:{run:ReadingRun;active:boolean;single:boolean}) {
    const {speech,pieces,mapped,edited}=run;
    const exact=mapped&&!edited;
    return <span className={'rw-speech'+(active?' rw-playing':'')} data-speech-from={speech.from} data-speech-to={speech.to}
        data-speech-start={single?undefined:speech.start} data-reading-from={exact?speech.from:undefined} data-reading-to={exact?speech.to:undefined}>
        {pieces.map((piece,index)=>piece.kind==='mark'?<span key={index} data-cleanup-mark={piece.text} data-reading-at={piece.at}>{piece.text}</span>
            :exact||!mapped?piece.text:<span key={index} data-reading-from={piece.from} data-reading-to={piece.to}
                data-reading-replacement={piece.kind==='replacement'?'true':undefined}>{piece.text}</span>)}
    </span>;
});

function ReadingText({paragraph,current,activePartIndex,position,joins}:{paragraph:ReadingParagraph;current?:string;activePartIndex:number;position?:string;joins?:ReadonlyMap<string,ReadingJoin>}) {
    const groups:{runs:ReadingRun[];separator:string}[]=[];
    paragraph.runs.forEach((run,index)=>{
        const previous=groups.at(-1);
        if(previous?.runs[0].cueId===run.cueId)previous.runs.push(run);
        else groups.push({runs:[run],separator:paragraph.separators.get(index)??''});
    });
    return <p className="rw-original" data-reading-prose="true" tabIndex={0} aria-description="单击选取播放位置；按 Enter 选取当前位置；拖选可精确选择。">
        {groups.map(({runs,separator})=>{
            const {cueId,edited}=runs[0];
            const sentence=joins?.get(cueId)?.first;
            const active=(run:ReadingRun)=>cueId===current&&run.partIndex===activePartIndex;
            if(runs.length===1&&!edited){
                const run=runs[0];
                return <Fragment key={cueId}>{separator}<span data-source-id={cueId} data-cue-id={cueId} data-reading-sentence={sentence} data-speech-from={run.speech.from} data-speech-to={run.speech.to}
                    data-reading-from={run.mapped?run.speech.from:undefined} data-reading-to={run.mapped?run.speech.to:undefined}
                    className={'rw-speech'+(cueId===position?' rw-current':'')+(active(run)?' rw-playing':'')}>{run.pieces[0]?.text}</span></Fragment>;
            }
            return <Fragment key={cueId}>{separator}<span data-source-id={cueId} data-cue-id={cueId} data-reading-sentence={sentence}
                data-reading-edited={edited?'true':undefined} data-cleanup-applied={edited?'true':undefined}
                className={cueId===position?'rw-current':undefined}>
                {runs.filter(run=>run.pieces.length).map((run,index)=><SpeechText key={index} run={run} single={runs.length===1}
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

type PassageActions={onLocate:(id:string)=>void;onPlayFrom:(start:number)=>void};
type PassageRowProps=PassageActions & {
    passage:Passage; speakerIndex:number; compact:boolean; sourceUrl?:string;
    canListen:boolean; playbackCues?:ReadonlyMap<string,ReaderCue>;
    current?:string; activePartIndex:number; position?:string;
    displayText:(text:string)=>string; paragraphs:ReadingParagraph[]; joins?:ReadonlyMap<string,ReadingJoin>; chapter?:ReadingChapter; speakerName?:string;
};
const PassageRow=memo(function PassageRow({passage,speakerIndex,compact,sourceUrl,canListen,playbackCues,current,activePartIndex,position,displayText,paragraphs,joins,chapter,speakerName,onLocate,onPlayFrom}:PassageRowProps) {
    const playbackStart=playbackCues?.get(passage.cues[0].id)?.start??passage.start;
    return <section className={'rw-passage'+(compact?' rw-passage-compact':'')+(!passage.speaker?' rw-speaker-unknown':'')+(current?' rw-passage-playing':'')}
        style={{'--speaker-hue':[86,30,150,205,65][speakerIndex%5]} as CSSProperties}>
        {chapter&&<h2 className="rw-chapter-title">{displayText(chapter.title)}</h2>}
        <div className="rw-passage-heading notranslate" translate="no" default-translate="no"><div className="rw-passage-identity">
            <span className="rw-speaker-label">{speakerName||passage.speaker||'未标注'}</span>
            <div className="rw-cue-meta">
                {canListen?<button type="button" className="rw-time-link" aria-label={'从 '+time(playbackStart)+' 开始播放'} aria-current={current?'time':undefined} onClick={()=>onPlayFrom(playbackStart)}>▷ {time(playbackStart)}</button>
                    :sourceUrl?<SourcePlaybackLink sourceUrl={sourceUrl} start={passage.start} compact/>
                    :<button type="button" className="rw-time-link" onClick={()=>onLocate(passage.cues[0].id)}>{time(passage.start)}</button>}
            </div>
        </div></div>
        {paragraphs.map((paragraph,i)=><ReadingText key={i} paragraph={paragraph} current={current} activePartIndex={activePartIndex} position={position} joins={joins}/>)}
    </section>;
});
const unchanged=(text:string)=>text;
export function PassageView({doc,cues,passages:supplied,playbackCues,active,position,onLocate,onPlayFrom,canListen=false,displayText=unchanged,projection,replacements,speakerDisplay,chapters,joins}:PassageActions & {
    displayText?:(text:string)=>string; projection?:Projection;
    joins?:ReadonlyMap<string,ReadingJoin>; chapters?:ReadonlyMap<string,ReadingChapter>;
    replacements?:ReadonlyMap<string,readonly ReadingReplacement[]>; speakerDisplay?:(cue:ReaderCue)=>string|undefined;
    doc:ReaderDocument; cues:ReaderCue[]; passages?:Passage[]; active?:PlaybackLocation|null; position:string;
    playbackCues?:ReadonlyMap<string,ReaderCue>; canListen?:boolean;
}) {
    const {rows,byCue}=useMemo(()=>{
        const layout=supplied||passageDomain().build(cues,{source:doc.segments,layout:'reading'});
        const split=chapters?.size?layout.flatMap(passage=>{
            const cuts=[0,...passage.cues.flatMap((cue,i)=>i>0&&chapters.has(cue.id)?[i]:[]),passage.cues.length];
            if(cuts.length===2)return [passage];
            return cuts.slice(1).map((end,i)=>{
                const cues=passage.cues.slice(cuts[i],end),first=cues[0];
                return {...passage,key:'passage:'+first.id,start:first.start,end:Math.max(...cues.map(cue=>cue.end)),cues};
            });
        }):layout;

        const joined:Passage[]=[];
        for(const passage of split){
            const first=passage.cues[0].id,previous=joined.at(-1);
            if(previous&&joins?.get(first)?.previous===previous.cues.at(-1)?.id&&!chapters?.has(first)&&
                previous.cues.length+passage.cues.length<=100){
                joined[joined.length-1]={...previous,end:Math.max(previous.end,passage.end),cues:[...previous.cues,...passage.cues]};
            }else joined.push(passage);
        }

        const passages=joined;
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
            const first=passage.cues[0];
            const paragraphs=readingParagraphs(passage.cues,{separator:passageDomain().separator,displayText,projection,playbackCues,replacements,joins});
            return {passage,speakerIndex:Math.max(0,speakers.indexOf(speaker)),compact,paragraphs,
                chapter:chapters?.get(first.id),speakerName:speakerDisplay?.(first)};
        });
        return {rows,byCue};
    },[supplied,cues,doc.segments,displayText,projection,playbackCues,replacements,joins,chapters,speakerDisplay]);
    const activeRow=active&&byCue.get(active.cueId),locatedRow=byCue.get(position);
    const sourceUrl=typeof doc.source_url==='string'&&/^https?:/.test(doc.source_url)?doc.source_url:undefined;
    return <article className="rw-passages" lang={typeof doc.language==='string'?doc.language:undefined}>{rows.map(row=><PassageRow key={row.passage.key} {...row} sourceUrl={sourceUrl}
        canListen={canListen} playbackCues={playbackCues} current={row.passage===activeRow?active?.cueId:undefined}
        activePartIndex={row.passage===activeRow?active!.partIndex:-1} position={row.passage===locatedRow?position:undefined}
        displayText={displayText} joins={joins} onLocate={onLocate} onPlayFrom={onPlayFrom}/>)}</article>;
}
