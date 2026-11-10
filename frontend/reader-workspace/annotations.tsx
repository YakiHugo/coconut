import { useEffect, useState } from 'react';
import type { ReaderDocument } from './contracts';
import { ChoicePicker } from './controls';

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
    createSourceCorrectionPreview: (doc: ReaderDocument, input: unknown) => Preview;
    applySourceCorrectionPreview: (doc: ReaderDocument, preview: Preview, indices: number[]) => unknown;
    createSpeakerCorrectionPreview: (doc: ReaderDocument, input: unknown) => unknown;
    applySpeakerCorrectionPreview: (doc: ReaderDocument, preview: unknown) => unknown;
};
const core = () => (window as unknown as {
    Coconut: Domain;
}).Coconut;
interface Props {
    doc: ReaderDocument;
    revision: number;
    disabled: boolean;
    save: (next: ReaderDocument, revision?: number) => Promise<boolean>;
    position: string;
    dirty: (value: boolean) => void;
}
export function SourceCorrections({ doc, revision, disabled, save, position, dirty }: Props) {
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
    return <section className="rw-corrections" aria-label="原文与说话人校正"><h3>原文与说话人校正</h3><p>校正保留原文历史、片段标识和时间。旧摘录仍保留选取时快照。</p><label>查找原文<input disabled={disabled} value={find} onChange={e => { setFind(e.target.value); setPreview(null); }}/></label><label>替换为<input disabled={disabled} value={replacement} onChange={e => { setReplacement(e.target.value); setPreview(null); }}/></label><button disabled={disabled || !find} onClick={showPreview}>预览修改</button>{preview && <section><p>{preview.value.total} 处匹配；已选 {selected.length} 处</p>{preview.value.hits.slice(page * 30, (page + 1) * 30).map(hit => <label key={hit.index}><input type="checkbox" checked={selected.includes(hit.index)} onChange={e => setSelected(old => e.target.checked ? [...old, hit.index] : old.filter(i => i !== hit.index))}/>{hit.before}<mark>{hit.match}</mark>{hit.after}</label>)}<button disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><button disabled={(page + 1) * 30 >= preview.value.total} onClick={() => setPage(page + 1)}>下一页</button><button disabled={disabled || !selected.length || preview.revision !== revision} onClick={apply}>应用所选修改</button></section>}
 {undo && <button disabled={disabled || JSON.stringify(doc.segments) !== undo.after} onClick={async () => {
                if (await save({ ...doc, segments: undo.before }, revision))
                    setUndo(null);
            }}>撤销本批原文校正</button>}
 <ChoicePicker label="修正范围" value={speakerScope} disabled={disabled} onChange={value => setSpeakerScope(value as typeof speakerScope)} options={[{value: 'cue', label: '仅当前片段'}, {value: 'speaker', label: '所有相同说话人标签'}]}/><label>当前片段的说话人<input disabled={disabled} value={speaker} onChange={e => setSpeaker(e.target.value)}/></label><button disabled={disabled || !position || !speaker.trim()} onClick={async () => {
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
        }}>恢复原始说话人</button><button disabled={disabled} onClick={() => { setFind(''); setReplacement(''); setSpeaker(''); setPreview(null); }}>取消校正草稿</button>{message && <p role="status">{message}</p>}</section>;
}
