import { useRef, useState, useSyncExternalStore } from 'react';
import type { Document } from './contracts';
import type { AppStore } from './store';
import { DocumentCard } from './document-card';

const letters = ['c', 'o', 'c', 'o', 'n', 'u', 't'];

export function CoconutWordmark() {
    const [playing, setPlaying] = useState<number[]>([]);
    const nextLetter = useRef(0);
    const play = (index: number) => {
        if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
            setPlaying(current => current.includes(index) ? current : [...current, index]);
        }
    };

    return <h1 id="discover-title" className="discover-title" aria-label="coconut" translate="no">
        <button type="button" className="coconut-wordmark" aria-label="播放 coconut 字标动画"
            onClick={() => {
                play(nextLetter.current);
                nextLetter.current = (nextLetter.current + 1) % letters.length;
            }}>
            {letters.map((letter, index) => <span key={index} className="coconut-letter" aria-hidden="true"
                data-playing={playing.includes(index) || undefined}
                onPointerEnter={event => { if (event.pointerType === 'mouse') play(index); }}
                onClick={event => { event.stopPropagation(); play(index); }}>
                <span className="coconut-glyph" onAnimationEnd={event => {
                    if (event.target === event.currentTarget) setPlaying(current => current.filter(active => active !== index));
                }}>
                    {letter}<i className="coconut-eye"/><i className="coconut-eye"/>
                </span>
            </span>)}
        </button>
    </h1>;
}

export function RecentTranscripts({ store }: { store: AppStore }) {
    const {documents} = useSyncExternalStore(store.subscribe, store.getSnapshot);
    // The library stores documents in insertion order, including legacy imports.
    const recent: Document[] = [];
    for (let index = documents.length - 1; index >= 0 && recent.length < 3; index--) {
        const document = documents[index];
        if (document.project_kind !== 'reading_collection' && document.segments.length) recent.push(document);
    }

    return <section className="recent-transcripts" aria-labelledby="recent-transcripts-title">
        <header>
            <h2 id="recent-transcripts-title">最近转录</h2>
            {documents.length > 0 && <button type="button" className="recent-transcripts-all" onClick={() => store.navigate('library')}>
                全部内容 <span aria-hidden="true">→</span>
            </button>}
        </header>
        {recent.length ? <ul className="document-grid">{recent.map(document => <li key={document.key}>
            <DocumentCard document={document} onOpen={store.select}/>
        </li>)}</ul> : <p>暂无转录</p>}
    </section>;
}
