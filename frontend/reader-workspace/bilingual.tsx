import { useMemo, useState } from 'react';
import type { ReaderDocument } from './contracts';
import type { SourceSelection } from './domain';
type Model = {
    text: string;
    language: string;
    providers: string[];
    reviewStates: string[];
    qualityWarnings: string[];
};
type Core = {
    translationSelectionModels: (doc: ReaderDocument, cues: ReaderDocument['segments'], language: string) => Model[];
    pairedExactExcerptSnapshot: (doc: ReaderDocument, cues: ReaderDocument['segments'], separators: string[], from: number, to: number, model: Model, translationFrom: number, translationTo: number, metadata: {
        id: string;
        createdAt: string;
        confirmedAt: string;
    }) => NonNullable<ReaderDocument['exact_excerpts']>[number];
    exactExcerptDuplicate: (doc: ReaderDocument, record: unknown) => unknown;
};
export function BilingualCapture({ doc, selection, disabled, save, onClose }: {
    doc: ReaderDocument;
    selection: SourceSelection;
    disabled: boolean;
    save: (doc: ReaderDocument) => Promise<boolean>;
    onClose: () => void;
}) {
    const core = (window as unknown as {
        Coconut: Core;
    }).Coconut, cues = selection.cueIds.map(id => doc.segments.find(c => c.id === id)!);
    const models = useMemo(() => core.translationSelectionModels(doc, cues, doc.translation_view || ''), [doc, selection]);
    const [open, setOpen] = useState(false), [index, setIndex] = useState(0), [range, setRange] = useState<{
        from: number;
        to: number;
    } | null>(null), [confirmed, setConfirmed] = useState(false), [error, setError] = useState('');
    const model = models[index];
    return <div><button disabled={disabled || !models.length} onClick={() => setOpen(!open)}>保存双语摘录</button>{open && model && <section><p>原文选区：{selection.text}</p><label>已保存的译文片段<select value={index} onChange={e => { setIndex(Number(e.target.value)); setRange(null); setConfirmed(false); }}>{models.map((m, i) => <option key={i} value={i}>{m.language} · {m.text.slice(0, 50)}</option>)}</select></label><label>在下方选取对应译文<textarea readOnly value={model.text} onSelect={e => { const input = e.currentTarget; setRange(input.selectionEnd > input.selectionStart ? { from: input.selectionStart, to: input.selectionEnd } : null); setConfirmed(false); }}/></label><p>译文来源：{model.providers.join('、')}；{model.reviewStates.join('、')}</p>{model.qualityWarnings.length > 0 && <p>{model.qualityWarnings.join('；')}</p>}<label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/> 我确认两处选区表达相应内容；这不等于译文已经人工校对。</label><button disabled={disabled || !range || !confirmed} onClick={async () => {
                try {
                    const stamp = new Date().toISOString();
                    const record = core.pairedExactExcerptSnapshot(doc, cues, selection.separators, selection.from, selection.to, model, range!.from, range!.to, { id: crypto.randomUUID(), createdAt: stamp, confirmedAt: stamp });
                    if (core.exactExcerptDuplicate(doc, record)) {
                        setError('已保存相同双语摘录。');
                        return;
                    }
                    if (await save({ ...doc, exact_excerpts: [...(doc.exact_excerpts || []), record] }))
                        onClose();
                }
                catch (e) {
                    setError(String(e instanceof Error ? e.message : e));
                }
            }}>确认保存双语摘录</button><button onClick={() => setOpen(false)}>取消双语选取</button>{error && <p role="alert">{error}</p>}</section>}</div>;
}
