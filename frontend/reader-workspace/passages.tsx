import type { ReaderCue, ReaderDocument } from './contracts';
import { time } from './domain';
export type Passage = {
    key: string;
    start: number;
    end: number;
    speaker: string | null;
    cues: ReaderCue[];
};
export function passageDomain() {
    return (window as unknown as {
        CoconutPassages: {
            build: (cues: ReaderCue[], options: {
                source: ReaderCue[];
            }) => Passage[];
            separator: (left: string, right: string) => string;
        };
    }).CoconutPassages;
}
export function PassageView({ doc, cues, current, position, onLocate, onListen }: {
    doc: ReaderDocument;
    cues: ReaderCue[];
    current?: string;
    position: string;
    onLocate: (id: string) => void;
    onListen: (start: number, end: number) => void;
}) {
    const passages = passageDomain().build(cues, { source: doc.segments });
    return <div className="rw-passages">{passages.map(passage => <section className="rw-passage" key={passage.key}><div className="rw-cue-meta"><button onClick={() => onLocate(passage.cues[0].id)}>{time(passage.start)}</button><span>{passage.speaker}</span><button onClick={() => onListen(passage.start, passage.end)}>回听整段</button></div><p className="rw-original">{passage.cues.map((cue, i) => <span key={cue.id}>{i ? passageDomain().separator(passage.cues[i - 1].text, cue.text) : ''}<span data-source-id={cue.id} data-cue-id={cue.id} className={(cue.id === current ? 'rw-playing ' : '') + (cue.id === position ? 'rw-current' : '')} onDoubleClick={() => onLocate(cue.id)}>{cue.text}</span></span>)}</p>{doc.translation_view && <p className="rw-translation">{passage.cues.map(cue => cue.translations?.[doc.translation_view!]?.text ? (((window as unknown as {
                    Coconut: {
                        translationCurrent: (cue: ReaderCue, doc: ReaderDocument, item: unknown) => boolean;
                    };
                }).Coconut.translationCurrent(cue, doc, cue.translations[doc.translation_view!]) ? '' : '[旧译文，待核对] ') + cue.translations[doc.translation_view!].text) : '').filter(Boolean).join(' ')}</p>}</section>)}</div>;
}
