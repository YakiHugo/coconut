import { useEffect, useState } from 'react';
import type { ReaderDocument } from './contracts';
import { time,applyExactExcerptRemoval } from './domain';
type Chapter = {
    id: string;
    title: string;
    cue_id: string;
    time: number;
    note?: string;
};
type Preview = {
    hits: Array<{
        index: number;
        id: string;
        before: string;
        match: string;
        after: string;
    }>;
    total: number;
};
type Domain = {
    createReadingChapter: (doc: ReaderDocument, input: unknown) => Chapter;
    updateReadingChapter: (doc: ReaderDocument, id: string, input: unknown) => Chapter;
    readingChaptersWith: (doc: ReaderDocument, chapter: Chapter) => Chapter[];
    createSourceCorrectionPreview: (doc: ReaderDocument, input: unknown) => Preview;
    applySourceCorrectionPreview: (doc: ReaderDocument, preview: Preview, indices: number[]) => unknown;
    createSpeakerCorrectionPreview: (doc: ReaderDocument, input: unknown) => unknown;
    applySpeakerCorrectionPreview: (doc: ReaderDocument, preview: unknown) => unknown;
    exactExcerptNotesWith: (doc: ReaderDocument, id: string, text: string) => Record<string, string>;
    exactExcerptRemoval: (doc: ReaderDocument, id: string) => Partial<ReaderDocument>;
};
const core = () => (window as unknown as {
    Coconut: Domain;
}).Coconut;
interface Props {
    doc: ReaderDocument;
    revision: number;
    disabled: boolean;
    save: (next: ReaderDocument, revision?: number) => Promise<boolean>;
    locate: (id: string) => void;
    seek: (seconds: number) => void;
    position: string;
    dirty: (value: boolean) => void;
}
export function ReaderAnnotations({ doc, revision, disabled, save, locate, seek, position, dirty }: Props) {
    const [editing, setEditing] = useState<{
        kind: 'chapter' | 'bookmark' | 'excerpt';
        id: string;
        title: string;
        note: string;
        time: string;
        revision: number;
        anchor?:{cueId:string;start:number;end:number};
    } | null>(null), [message, setMessage] = useState('');
    useEffect(() => { dirty(Boolean(editing)); return () => dirty(false); }, [Boolean(editing), dirty]);
    const chapters = (doc.reading_chapters || []) as Chapter[];
    useEffect(() => {
        if (!editing || editing.revision === revision)
            return;
        const applied = editing.kind === 'excerpt' ? doc.exact_excerpt_notes?.[editing.id] === editing.note : editing.kind === 'bookmark' ? doc.timestamp_bookmarks?.some(item => item.id === editing.id && item.note === editing.note && item.time === Number(editing.time)) : chapters.some(item => (editing.id ? item.id === editing.id : item.cue_id === editing.anchor?.cueId) && item.title === editing.title && (item.note || '') === editing.note);
        if (applied)
            setEditing(null);
    }, [doc, revision, editing]);
    const commit = async () => {
        if (!editing)
            return;
        if (editing.revision !== revision) {
            setMessage('内容已更新，草稿仍保留。请复制后取消并重新编辑。');
            return;
        }
        try {
            let next = doc;
            if (editing.kind === 'chapter') {
                if(!editing.id && (!editing.anchor || !doc.segments.some(cue=>cue.id===editing.anchor!.cueId&&cue.start===editing.anchor!.start&&cue.end===editing.anchor!.end)))throw Error('创建章节时的原文位置已变化，请取消并重新选择。');
                const chapter = editing.id ? core().updateReadingChapter(doc, editing.id, { title: editing.title, note: editing.note }) : core().createReadingChapter(doc, { id: crypto.randomUUID(), title: editing.title, note: editing.note, cueId: editing.anchor!.cueId });
                next = { ...doc, reading_chapters: core().readingChaptersWith(doc, chapter) };
            }
            else if (editing.kind === 'bookmark') {
                const seconds = Number(editing.time);
                if (!Number.isFinite(seconds) || seconds < 0 || seconds > 604800)
                    throw Error('请输入有效的秒数');
                next = { ...doc, timestamp_bookmarks: doc.timestamp_bookmarks?.map(mark => mark.id === editing.id ? { ...mark, time: seconds, note: editing.note } : mark) };
            }
            else
                next = { ...doc, exact_excerpt_notes: core().exactExcerptNotesWith(doc, editing.id, editing.note) };
            if (await save(next, editing.revision))
                setEditing(null);
        }
        catch (e) {
            setMessage(String(e instanceof Error ? e.message : e));
        }
    };
    return <section className="rw-annotations"><h2>章节与记录</h2>{doc.segments.length > 0 && <><button disabled={disabled || Boolean(editing) || !position} onClick={() => {const cue=doc.segments.find(cue=>cue.id===position);if(cue)setEditing({ kind: 'chapter', id: '', title: '', note: '', time: '', revision,anchor:{cueId:cue.id,start:cue.start,end:cue.end} });}}>在当前片段创建章节</button>{chapters.map(item => <div key={item.id}><button onClick={() => locate(item.cue_id)} disabled={!doc.segments.some(c => c.id === item.cue_id)}>{time(item.time)} · {item.title}</button><span>{item.note}</span><button disabled={disabled || Boolean(editing)} onClick={() => setEditing({ kind: 'chapter', id: item.id, title: item.title, note: item.note || '', time: '', revision })}>编辑章节</button><button disabled={disabled || Boolean(editing)} onClick={() => save({ ...doc, reading_chapters: chapters.filter(c => c.id !== item.id) })}>删除章节</button></div>)}</>}
 {(doc.timestamp_bookmarks || []).map(item => <div key={item.id} data-bookmark-id={item.id}><button onClick={() => seek(item.time)}>{time(item.time)} · {item.note || '时间书签'}</button><button disabled={disabled || Boolean(editing)} onClick={() => setEditing({ kind: 'bookmark', id: item.id, title: '', note: item.note, time: String(item.time), revision })}>编辑书签</button><button disabled={disabled || Boolean(editing)} onClick={() => save({ ...doc, timestamp_bookmarks: doc.timestamp_bookmarks!.filter(c => c.id !== item.id) })}>删除书签</button></div>)}
 {(doc.exact_excerpts || []).map(item => <div key={item.id}><p>{item.text}</p><p>{doc.exact_excerpt_notes?.[item.id]}</p><button disabled={disabled || Boolean(editing)} onClick={() => setEditing({ kind: 'excerpt', id: item.id, title: '', note: doc.exact_excerpt_notes?.[item.id] || '', time: '', revision })}>编辑摘录笔记</button><button disabled={disabled || Boolean(editing)} onClick={() => save(applyExactExcerptRemoval(doc,core().exactExcerptRemoval(doc, item.id)))}>删除摘录</button></div>)}
 {editing && <form onSubmit={e => { e.preventDefault(); void commit(); }}><h3>编辑记录</h3>{editing.kind === 'chapter' && <label>章节标题<input disabled={disabled} value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })}/></label>}{editing.kind === 'bookmark' && <label>时间（秒）<input disabled={disabled} type="number" value={editing.time} onChange={e => setEditing({ ...editing, time: e.target.value })}/></label>}<label>备注<textarea disabled={disabled} value={editing.note} onChange={e => setEditing({ ...editing, note: e.target.value })}/></label><button disabled={disabled} type="submit">保存记录</button><button type="button" disabled={disabled} onClick={() => setEditing(null)}>取消</button></form>}{message && <p role="status">{message}</p>}</section>;
}
export function SourceCorrections({ doc, revision, disabled, save, position, dirty }: Pick<Props, 'doc' | 'revision' | 'disabled' | 'save' | 'position' | 'dirty'>) {
    const [find, setFind] = useState(''), [replacement, setReplacement] = useState(''), [speaker, setSpeaker] = useState(''), [speakerScope, setSpeakerScope] = useState<'cue' | 'speaker'>('cue'), [preview, setPreview] = useState<{
        doc: ReaderDocument;
        value: Preview;
        revision: number;
    } | null>(null), [selected, setSelected] = useState<number[]>([]), [page, setPage] = useState(0), [message, setMessage] = useState(''), [undo, setUndo] = useState<{
        before: ReaderDocument['segments'];
        after: string;
        pending?: boolean;
    } | null>(null);
    useEffect(() => { dirty(Boolean(find || replacement || speaker || preview)); return () => dirty(false); }, [Boolean(find || replacement || speaker || preview), dirty]);
    useEffect(() => {
        if (undo?.pending && JSON.stringify(doc.segments) === undo.after) {
            setFind('');
            setReplacement('');
            setUndo({ ...undo, pending: false });
        }
    }, [doc, revision, undo]);
    const showPreview = () => {
        try {
            const copy = structuredClone(doc), value = core().createSourceCorrectionPreview(copy, { find, replacement });
            setPreview({ doc: copy, value, revision });
            setSelected(value.hits.map(h => h.index));
            setPage(0);
            setMessage('');
        }
        catch (e) {
            setMessage(String(e instanceof Error ? e.message : e));
        }
    };
    const apply = async () => {
        if (!preview || preview.revision !== revision) {
            setMessage('原文已更新，请重新预览。');
            return;
        }
        try {
            const before = structuredClone(doc.segments);
            core().applySourceCorrectionPreview(preview.doc, preview.value, selected);
            const next = preview.doc;
            setPreview(null);
            setUndo({ before, after: JSON.stringify(next.segments), pending: true });
            if (await save(next, revision)) {
                setFind('');
                setReplacement('');
            }
        }
        catch (e) {
            setPreview(null);
            setMessage(String(e instanceof Error ? e.message : e));
        }
    };
    return <details className="rw-corrections"><summary>原文与说话人校正</summary><p>校正保留原文历史、片段标识和时间。旧摘录仍保留选取时快照。</p><label>查找原文<input disabled={disabled} value={find} onChange={e => { setFind(e.target.value); setPreview(null); }}/></label><label>替换为<input disabled={disabled} value={replacement} onChange={e => { setReplacement(e.target.value); setPreview(null); }}/></label><button disabled={disabled || !find} onClick={showPreview}>预览修改</button>{preview && <section><p>{preview.value.total} 处匹配；已选 {selected.length} 处</p>{preview.value.hits.slice(page * 30, (page + 1) * 30).map(hit => <label key={hit.index}><input type="checkbox" checked={selected.includes(hit.index)} onChange={e => setSelected(old => e.target.checked ? [...old, hit.index] : old.filter(i => i !== hit.index))}/>{hit.before}<mark>{hit.match}</mark>{hit.after}</label>)}<button disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><button disabled={(page + 1) * 30 >= preview.value.total} onClick={() => setPage(page + 1)}>下一页</button><button disabled={disabled || !selected.length || preview.revision !== revision} onClick={apply}>应用所选修改</button></section>}
 {undo && <button disabled={disabled || JSON.stringify(doc.segments) !== undo.after} onClick={async () => {
                if (await save({ ...doc, segments: undo.before }, revision))
                    setUndo(null);
            }}>撤销本批原文校正</button>}
 <label>修正范围<select value={speakerScope} disabled={disabled} onChange={e => setSpeakerScope(e.target.value as typeof speakerScope)}><option value="cue">仅当前片段</option><option value="speaker">所有相同说话人标签</option></select></label><label>当前片段的说话人<input disabled={disabled} value={speaker} onChange={e => setSpeaker(e.target.value)}/></label><button disabled={disabled || !position || !speaker.trim()} onClick={async () => {
            try {
                const next = structuredClone(doc), plan = core().createSpeakerCorrectionPreview(next, { cueId: position, scope: speakerScope, action: 'rename', speaker });
                core().applySpeakerCorrectionPreview(next, plan);
                if (await save(next, revision))
                    setSpeaker('');
            }
            catch (e) {
                setMessage(String(e instanceof Error ? e.message : e));
            }
        }}>保存说话人</button><button disabled={disabled || !position} onClick={async () => {
            try {
                const next = structuredClone(doc), plan = core().createSpeakerCorrectionPreview(next, { cueId: position, scope: speakerScope, action: 'restore' });
                core().applySpeakerCorrectionPreview(next, plan);
                await save(next, revision);
            }
            catch (e) {
                setMessage(String(e instanceof Error ? e.message : e));
            }
        }}>恢复原始说话人</button><button disabled={disabled} onClick={() => { setFind(''); setReplacement(''); setSpeaker(''); setPreview(null); }}>取消校正草稿</button>{message && <p role="status">{message}</p>}</details>;
}
