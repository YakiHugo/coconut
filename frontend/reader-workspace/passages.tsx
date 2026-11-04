import { useMemo, type CSSProperties } from 'react';
import type { ReaderCue, ReaderDocument } from './contracts';
import { time, type SourceSelection } from './domain';
import { SourcePlaybackLink } from './source';
import {speechParts} from './speech';

function SpeechText({cue,current,seconds,position,selected}:{cue:ReaderCue;current?:string;seconds:number;position:string;selected?:SourceSelection|null}) {
    const parts=useMemo(()=>speechParts(cue),[cue]);
    const text=cue.text;
    const active=cue.id===current?parts.findIndex(part=>part.start<=seconds&&(seconds<part.end||part.start===part.end&&seconds===part.start)):-1;
    const selectedPart=(from:number,to:number)=>selected?.cueIds[0]===cue.id&&selected.from===from&&selected.to===to;
    if(parts.length===1)return <span data-source-id={cue.id} data-cue-id={cue.id} data-speech-from={0} data-speech-to={cue.text.length} className={(cue.id===position?'rw-current ':'')+'rw-speech'+(active===0?' rw-playing':'')+(selectedPart(0,cue.text.length)?' rw-selected-speech':'')}>{text}</span>;
    return <span data-source-id={cue.id} data-cue-id={cue.id} className={cue.id===position?'rw-current':''}>{parts.map((part,index)=><span key={part.from} className={'rw-speech'+(index===active?' rw-playing':'')+(selectedPart(part.from,part.to)?' rw-selected-speech':'')} data-speech-start={part.start} data-speech-from={part.from} data-speech-to={part.to}>{text.slice(part.from,part.to)}</span>)}</span>;
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

export function PassageView({ doc, cues, passages: supplied, current, seconds=0, position, onLocate, onPlayFrom, canListen = false, selected }: {
    selected?:SourceSelection|null;
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
        const notes = passage.cues.filter(cue => doc.notes?.[cue.id]?.trim());
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
            <p className="rw-original" tabIndex={0} aria-description="单击文字或按 Enter 选择片段并显示操作；拖选可精确选择。">{passage.cues.map((cue, i) => <span key={cue.id}>{i ? passageDomain().separator(passage.cues[i - 1].text, cue.text) : ''}<SpeechText selected={selected} cue={cue} current={current} seconds={seconds} position={position}/></span>)}</p>
            {doc.translation_view && <p className="rw-translation">{passage.cues.map(cue => cue.translations?.[doc.translation_view!]?.text ? (((window as unknown as { Coconut: { translationCurrent: (cue: ReaderCue, doc: ReaderDocument, item: unknown) => boolean } }).Coconut.translationCurrent(cue, doc, cue.translations[doc.translation_view!]) ? '' : '[旧译文，待核对] ') + cue.translations[doc.translation_view!].text) : '').filter(Boolean).join(' ')}</p>}
            {notes.length > 0 && <section className="rw-passage-notes" aria-label="段落笔记"><h3>段落笔记 · {notes.length}</h3>{notes.map(cue => <p key={cue.id}><button type="button" onClick={() => onLocate(cue.id)}>{time(cue.start)}</button> {doc.notes[cue.id]}</p>)}</section>}
        </section>;
    })}</div>;
}
