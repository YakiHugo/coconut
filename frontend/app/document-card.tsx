import type { Document } from './contracts';
import { time } from '../reader-workspace/domain';

function documentSource(document: Document) {
    const video = document.video_source as { provider?: string } | undefined;
    const provenance = document.provenance as { source_platform?: string } | undefined;
    const platform = video?.provider || provenance?.source_platform;
    if (platform === 'youtube') return { label: 'YouTube', cover: 'violet' };
    if (platform === 'bilibili') return { label: 'B 站', cover: 'amber' };
    if (document.podcast_source) return { label: '播客', cover: 'green' };
    return { label: '文字稿', cover: 'blue' };
}

export function DocumentCard({ document, onOpen }: { document: Document; onOpen: (key: string) => void }) {
    const source = documentSource(document);
    const duration = document.media_duration;
    const size = typeof duration === 'number' && Number.isFinite(duration) && duration > 0
        ? time(duration) : `${document.segments.length} 段`;
    const collection = document.project_kind === 'reading_collection';
    const firstItem = collection && Array.isArray(document.items) ? document.items[0]?.snapshot : null;
    const excerpt = document.segments.find(cue => cue.text.trim())?.text.trim()
        || (typeof firstItem?.text === 'string' ? firstItem.text : '');
    const detail = collection ? '精选记录' : document.segments.length
        ? `${source.label} · ${size}` : '原声 · 文字稿待生成';

    return <button type="button" className="document-card" onClick={() => onOpen(document.key)}>
        <span className="document-card-details">
            <strong>{document.title}</strong>
            <small>{detail}</small>
        </span>
        <span className="document-card-cover" data-cover={collection ? 'amber' : source.cover} aria-hidden="true">
            {excerpt
                ? <span className="document-card-excerpt">{excerpt}</span>
                : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M4 10v4m4-7v10m4-13v16m4-11v6m4-5v4"/>
                </svg>}
        </span>
    </button>;
}
