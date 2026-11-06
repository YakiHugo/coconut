import { useEffect, useRef, useState } from 'react';
import type { ReaderDocument } from './contracts';
import {ChoicePicker} from './controls';
type ExportKind = 'json' | 'txt' | 'srt' | 'vtt' | 'md';
type Core = {
    transcriptText: (doc: ReaderDocument, target: string, options?: {layout: 'reading'}) => {
        text: string;
        translated: number;
        missing: number;
        stale: number;
    };
    subtitleExport: (doc: ReaderDocument, format: 'srt' | 'vtt', bilingual: boolean, target: string) => {
        text: string;
        translated: number;
    };
    notebookMarkdown: (doc: ReaderDocument, target: string) => string;
};
export function ReaderExports({ doc, hasDrafts, displayText=(text:string)=>text }: {
    displayText?:(text:string)=>string;
    doc: ReaderDocument;
    hasDrafts: boolean;
}) {
    const [kind, setKind] = useState<ExportKind>('json'), [bilingual, setBilingual] = useState(false), [status, setStatus] = useState(''), [artifact, setArtifact] = useState<{
        url: string;
        name: string;
    } | null>(null);
    const link = useRef<HTMLAnchorElement>(null);
    useEffect(() => {
        if (!artifact)
            return;
        link.current?.click();
        return () => { const url = artifact.url; window.setTimeout(() => URL.revokeObjectURL(url), 60000); };
    }, [artifact]);
    useEffect(() => setBilingual(false), [doc.key, doc.translation_view]);
    useEffect(()=>{if(!doc.segments.length&&['txt','srt','vtt'].includes(kind))setKind('json');},[doc.segments.length,kind]);
    const download = () => {
        try {
            const core = (window as unknown as {
                Coconut: Core;
            }).Coconut, target = bilingual ? doc.translation_view || '' : '';
            let text = '', detail = '';
            if (kind === 'json') {
                text = JSON.stringify(doc, null, 2);
                detail = '完整项目数据，不包含媒体文件';
            }
            else if (kind === 'txt') {
                const result = core.transcriptText(doc, target, {layout: 'reading'});
                text = result.text;
                detail = target ? `有效译文 ${result.translated} 段，缺失 ${result.missing} 段，过期 ${result.stale} 段` : '整篇原文，不受当前筛选影响';
            }
            else if (kind === 'md') {
                text = core.notebookMarkdown(doc, target);
                detail = '阅读笔记与摘录；完整恢复请另存 JSON';
            }
            else {
                const result = core.subtitleExport(doc, kind, Boolean(target), target);
                text = result.text;
                detail = `原始时间戳${target ? `；附加 ${result.translated} 段有效译文，缺失或过期译文未导出` : ''}`;
            }
            if(['txt','srt','vtt'].includes(kind))text=displayText(text);
            const type = kind === 'json' ? 'application/json' : kind === 'vtt' ? 'text/vtt' : kind === 'md' ? 'text/markdown' : 'text/plain';
            setArtifact({ url: URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' })), name: doc.title.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_') + '.' + kind });
            setStatus('已发起下载：' + detail + '。');
        }
        catch (e) {
            setStatus('导出失败：' + String(e instanceof Error ? e.message : e));
        }
    };
    return <section className="rw-exports" aria-label="导出本篇内容"><h3>导出本篇内容</h3><p>不含原媒体。TXT 与字幕采用当前中文字形。</p><ChoicePicker label="文件格式" value={kind} onChange={value=>setKind(value as ExportKind)} options={[{value:'json',label:'Coconut JSON 完整项目'},...(doc.segments.length?[{value:'txt',label:'TXT 整篇文字'},{value:'srt',label:'SRT 字幕'},{value:'vtt',label:'VTT 字幕'}]:[]),{value:'md',label:'Markdown 阅读笔记'}]}/>{kind !== 'json' && <label><input type="checkbox" disabled={!doc.translation_view} checked={bilingual} onChange={e => setBilingual(e.target.checked)}/> 包含当前所选语言的有效译文</label>}<button disabled={hasDrafts || (!doc.segments.length && ['txt', 'srt', 'vtt'].includes(kind))} onClick={download}>下载本篇</button>{hasDrafts && <p>请先提交或取消草稿，再导出完整内容。</p>}<a ref={link} hidden href={artifact?.url} download={artifact?.name}>下载文件</a><p role="status">{status}</p></section>;
}
