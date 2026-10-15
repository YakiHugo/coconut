import type { ReaderDocument } from './contracts';
export function safeSourceURL(value: unknown): string | null {
    if (typeof value !== 'string')
        return null;
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    }
    catch {
        return null;
    }
}
export function ReaderSource({ doc }: {
    doc: ReaderDocument;
}) {
    const provenance = (doc.provenance || {}) as Record<string, unknown>, url = safeSourceURL(doc.source_url);
    const kinds: Record<string, string> = { authored_demo: '自写演示内容，不是节目字幕或模型结果', publisher_transcript: '发布者提供的文字稿，未人工核对', platform_subtitles: '平台字幕', automatic_subtitles: '平台自动字幕', imported_subtitles: '导入字幕', local_asr: '本地语音识别' };
    return <details className="rw-source"><summary>来源与文字稿依据</summary><p>{doc.local_media_source ? '本地原文件：' + doc.local_media_source.name : url ? <a href={url} target="_blank" rel="noopener noreferrer">查看原始来源</a> : '未关联公开来源链接'}</p><p>{typeof provenance.kind === 'string' ? kinds[provenance.kind] || '文字稿来源类型：' + provenance.kind : '文字稿来源未标明'}</p>{typeof provenance.model === 'string' && <p>识别模型：{provenance.model}</p>}{typeof provenance.alignment_warning === 'string' && <p>时间对齐提示：{provenance.alignment_warning}</p>}{doc.segments.length > 0 && <p>原文可能有识别错误，请回听核对专有名词与重要信息。校准只影响播放映射，导出继续保留原始时间。</p>}</details>;
}
