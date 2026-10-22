import type { ReaderDocument } from './contracts';
import { time } from './domain';
import { getSourcePlaybackLink, safeSourceURL } from './source-playback';
export { safeSourceURL } from './source-playback';

export function SourcePlaybackLink({ sourceUrl, start, compact = false }: { sourceUrl: unknown; start: number; compact?: boolean }) {
    const link = getSourcePlaybackLink(sourceUrl, start);
    if (!link) return null;
    return <a href={link.url} target="_blank" rel="noopener noreferrer" aria-label={link.timed ? `在 ${link.platform} 从 ${time(Math.floor(start))} 播放` : '打开原站'} title={link.timed ? '在新标签页打开原站；播放与停止由原站控制' : '在新标签页打开原站；此来源不支持按段定位'}>{compact && link.timed ? `▷ ${time(start)}` : link.timed ? `在 ${link.platform} 从 ${time(Math.floor(start))} 播放 ↗` : '打开原站 ↗'}</a>;
}

export function ReaderSource({ doc }: {
    doc: ReaderDocument;
}) {
    const provenance = (doc.provenance || {}) as Record<string, unknown>, url = safeSourceURL(doc.source_url);
    const kinds: Record<string, string> = { authored_demo: '自写演示内容，不是节目字幕或模型结果', publisher_transcript: '发布者提供的文字稿，未人工核对', platform_subtitles: '平台字幕', automatic_subtitles: '平台自动字幕', imported_subtitles: '导入字幕', local_asr: '本地语音识别' };
    return <div className="rw-source">{url && <p><a href={url} target="_blank" rel="noopener noreferrer">打开原始来源 ↗</a> <small>在新标签页打开</small></p>}<details><summary>来源与文字稿依据</summary><p>{doc.local_media_source ? '本地原文件：' + doc.local_media_source.name : url ? <a href={url} target="_blank" rel="noopener noreferrer">查看原始来源</a> : '未关联公开来源链接'}</p><p>{typeof provenance.kind === 'string' ? kinds[provenance.kind] || '文字稿来源类型：' + provenance.kind : '文字稿来源未标明'}</p>{typeof provenance.model === 'string' && <p>识别模型：{provenance.model}</p>}{typeof provenance.alignment_warning === 'string' && <p>时间对齐提示：{provenance.alignment_warning}</p>}{typeof provenance.punctuation_method==='string' && <p>标点：本地模型自动恢复，保留识别原文，可在逐句校对中核对。</p>}{typeof provenance.speaker_method==='string' && <p>{String(provenance.speaker_status||'').startsWith('needs_review:')?'声音分组不稳定，未采用自动标签；可在逐句校对中手工标注。':'说话人：按声音自动分组，编号不代表真实身份，尚未人工核对。'}</p>}{typeof provenance.readability_warning === 'string' && <p>文字整理尚未完成，当前保留原始识别稿。</p>}{doc.segments.length > 0 && <p>原文可能有识别错误，请回听核对专有名词与重要信息。校准只影响播放映射，导出继续保留原始时间。</p>}</details></div>;
}
