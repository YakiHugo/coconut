import { useMemo, useState } from 'react';
import type { ReaderDocument } from './contracts';
import type { SourceSelection } from './domain';
import {ChoicePicker,ReaderDialog} from './controls';
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
    const available = useMemo(() => [...new Set(cues.flatMap(cue=>Object.keys(cue.translations||{})))].map(language=>({language,models:core.translationSelectionModels(doc,cues,language)})).filter(value=>value.models.length), [core,doc,selection]);
    const [language, setLanguage] = useState(doc.translation_view || '');
    const models = (available.find(value=>value.language===language)||available[0])?.models||[];
    const selectedLanguage = models[0]?.language||'';
    const [open, setOpen] = useState(false), [index, setIndex] = useState(0), [range, setRange] = useState<{
        model: Model;
        from: number;
        to: number;
    } | null>(null), [confirmed, setConfirmed] = useState(false), [error, setError] = useState('');
    const model = models[index]||models[0], currentRange=range?.model===model?range:null;
    if(!models.length)return null;
    return <><button type="button" aria-label="保存双语摘录" disabled={disabled} onClick={() => setOpen(true)}>双语摘录</button><ReaderDialog open={open} title="保存双语摘录" onClose={()=>setOpen(false)}>{model&&<section><p>原文选区：{selection.text}</p>{available.length>1&&<ChoicePicker label="译文语言" value={selectedLanguage} onChange={value=>{setLanguage(value);setIndex(0);setRange(null);setConfirmed(false);setError('');}} options={available.map(({language})=>({value:language,label:language}))}/>}<ChoicePicker label="已保存的译文片段" value={String(models.indexOf(model))} onChange={value=>{setIndex(Number(value));setRange(null);setConfirmed(false);setError('');}} options={models.map((m,i)=>({value:String(i),label:m.language+" · "+m.text.slice(0,50)}))}/><label>在下方选取对应译文<textarea readOnly value={model.text} onSelect={e => { const input = e.currentTarget; setRange(input.selectionEnd > input.selectionStart ? { model, from: input.selectionStart, to: input.selectionEnd } : null); setConfirmed(false); }}/></label><p>译文来源：{model.providers.join('、')}；{model.reviewStates.join('、')}</p>{model.qualityWarnings.length > 0 && <p>{model.qualityWarnings.join('；')}</p>}<label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/> 我确认两处选区表达相应内容；这不等于译文已经人工校对。</label><button disabled={disabled || !currentRange || !confirmed} onClick={async () => {
                try {
                    const stamp = new Date().toISOString();
                    const record = core.pairedExactExcerptSnapshot(doc, cues, selection.separators, selection.from, selection.to, model, currentRange!.from, currentRange!.to, { id: crypto.randomUUID(), createdAt: stamp, confirmedAt: stamp });
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
            }}>确认保存双语摘录</button><button onClick={() => setOpen(false)}>取消双语选取</button>{error && <p role="alert">{error}</p>}</section>}</ReaderDialog></>;
}
