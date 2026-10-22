import type { CSSProperties } from 'react';
import type { ReaderCue, ReaderDocument } from './contracts';
import { time } from './domain';
import { SourcePlaybackLink } from './source';

export type Passage = { key: string; start: number; end: number; speaker: string | null; cues: ReaderCue[] };
export function passageDomain() {
    return (window as unknown as { CoconutPassages: {
        build: (cues: ReaderCue[], options: { source: ReaderCue[]; layout?: 'reading' }) => Passage[];
        separator: (left: string, right: string) => string;
    } }).CoconutPassages;
}

export function PassageView({ doc, cues, passages: supplied, current, position, onLocate, onInspect, onListen, canListen = false }: {
    doc: ReaderDocument; cues: ReaderCue[]; passages?: Passage[]; current?: string; position: string;
    onLocate: (id: string) => void; onInspect?: (id: string) => void; canListen?: boolean; onListen: (start: number, end: number) => void;
}) {
    const passages = supplied || passageDomain().build(cues, { source: doc.segments, layout: 'reading' });
    const speakers = [...new Set(doc.segments.map(cue => cue.speaker).filter(Boolean))];
    return <div className="rw-passages">{passages.map((passage, index) => {
        const turnStart = speakers.length > 0 && (index === 0 || passages[index - 1].speaker !== passage.speaker);
        const speakerIndex = Math.max(0, speakers.indexOf(passage.speaker));
        const hasSource = typeof doc.source_url === 'string' && /^https?:/.test(doc.source_url);
        const notes = passage.cues.filter(cue => doc.notes?.[cue.id]?.trim());
        return <section className={'rw-passage' + (turnStart ? ' rw-turn-start' : '') + (!passage.speaker ? ' rw-speaker-unknown' : '') + (passage.cues.some(cue => cue.id === current) ? ' rw-passage-playing' : '')}
            key={passage.key} style={{ '--speaker-hue': [42, 328, 168, 210, 275][speakerIndex % 5] } as CSSProperties}>
            <div className="rw-passage-heading">
                {turnStart && <span className="rw-speaker-avatar" aria-hidden="true">{passage.speaker ? speakerIndex + 1 : '?'}</span>}
                {turnStart && <span className="rw-speaker-label">{passage.speaker || '未标注'}</span>}
                <div className="rw-cue-meta">
                    {canListen ? <button type="button" className="rw-time-link" aria-label={'回听整段 · ' + time(passage.start)} onClick={() => { onLocate(passage.cues[0].id); onListen(passage.start, passage.end); }}>▷ {time(passage.start)}</button>
                        : hasSource ? <SourcePlaybackLink sourceUrl={doc.source_url} start={passage.start} compact/>
                        : <button type="button" className="rw-time-link" onClick={() => onLocate(passage.cues[0].id)}>{time(passage.start)}</button>}
                </div>
                {onInspect && <button type="button" className="rw-inspect-passage" onClick={() => onInspect(passage.cues[0].id)}>校对与笔记</button>}
            </div>
            <p className="rw-original" tabIndex={0}>{passage.cues.map((cue, i) => <span key={cue.id}>{i ? passageDomain().separator(passage.cues[i - 1].text, cue.text) : ''}<span data-source-id={cue.id} data-cue-id={cue.id} className={(cue.id === current ? 'rw-playing ' : '') + (cue.id === position ? 'rw-current' : '')} onDoubleClick={() => onLocate(cue.id)}>{cue.text}</span></span>)}</p>
            {doc.translation_view && <p className="rw-translation">{passage.cues.map(cue => cue.translations?.[doc.translation_view!]?.text ? (((window as unknown as { Coconut: { translationCurrent: (cue: ReaderCue, doc: ReaderDocument, item: unknown) => boolean } }).Coconut.translationCurrent(cue, doc, cue.translations[doc.translation_view!]) ? '' : '[旧译文，待核对] ') + cue.translations[doc.translation_view!].text) : '').filter(Boolean).join(' ')}</p>}
            {notes.length > 0 && <details className="rw-passage-notes"><summary>段落笔记 · {notes.length}</summary>{notes.map(cue => <p key={cue.id}><button type="button" onClick={() => onLocate(cue.id)}>{time(cue.start)}</button> {doc.notes[cue.id]}</p>)}</details>}
        </section>;
    })}</div>;
}
