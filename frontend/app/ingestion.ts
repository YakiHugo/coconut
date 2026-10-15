export type Episode = {
    id: string;
    title: string;
    description?: string;
    media?: Array<{
        url: string;
        kind: 'audio' | 'video';
    }>;
    transcripts?: Array<{
        supported: boolean;
        url: string;
        type: string;
        language?: string;
    }>;
};
export type Ingestion = {
    id: string;
    state: 'ready' | 'awaiting_selection' | 'needs_transcription' | 'blocked';
    source: Record<string, unknown>;
    transcript?: {
        document?: unknown;
    };
    project?: {
        document?: unknown;
    };
    selection?: {
        feed_url: string;
        title?: string;
        episodes?: Episode[];
        feeds?: Array<{
            url: string;
            title: string;
        }>;
    };
    media?: {
        kind: 'audio' | 'video';
        name?: string;
        url?: string;
        download?: {
            endpoint: string;
            body: unknown;
        };
    };
    diagnostics?: Array<{category:string;startLine?:number;endLine?:number;cueId?:string;preview?:string}>;
    error?: {
        code: string;
        languages?: string[];
        message: string;
    };
    transcription?: {
        message: string;
    };
};
export async function ingest(body: unknown, signal: AbortSignal): Promise<Ingestion> {
    const response = await fetch('api/v1/ingestions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ protocolVersion: 1, ...body as object }), signal });
    const result = await response.json();
    if (!response.ok)
        throw Error(result.error?.message || result.error || '来源读取失败');
    if (result.protocolVersion !== 1 || !result.ingestion || !['ready', 'awaiting_selection', 'needs_transcription', 'blocked'].includes(result.ingestion.state))
        throw Error('来源服务版本不匹配，未导入内容。');
    return result.ingestion;
}
/** Same bounded identity protocol as the mature reader; never proof of every byte. */
export async function inspectFile(file: File) {
    const extension = file.name.split('.').pop()?.toLowerCase(), type = file.type.toLowerCase();
    const supported = new Set(['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/flac', 'audio/x-flac', 'audio/aac', 'audio/opus', 'video/mp4', 'video/webm', 'audio/webm', 'video/quicktime', 'video/x-m4v', 'application/octet-stream']);
    if (type && !supported.has(type))
        throw Error('请选择实际音频或视频文件。');
    const kind = type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : ['mp4', 'webm', 'mov', 'm4v'].includes(extension || '') ? 'video' : ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac', 'opus'].includes(extension || '') ? 'audio' : null;
    if (!kind || !Number.isSafeInteger(file.size) || file.size <= 0)
        throw Error('请选择可播放的音频或视频文件。');
    if (/^\s*(?:#EXTM3U|\[playlist\]|<\?xml|<MPD|<SmoothStreamingMedia|<ASX|<smil|<!doctype|<html)/i.test(await file.slice(0, 1024).text()))
        throw Error('不支持会连接远程地址的播放列表。');
    const hash = async (bytes: BufferSource) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    const size = 64 * 1024, offsets = [...new Set([0, Math.max(0, Math.floor((file.size - size) / 2)), Math.max(0, file.size - size)])], samples = [];
    for (const offset of offsets)
        samples.push(await hash(await file.slice(offset, offset + size).arrayBuffer()));
    const identity = 'file-candidate-v1:' + JSON.stringify([file.name, file.size, file.lastModified, file.type, offsets, samples]);
    return { kind: kind as 'audio' | 'video', identity, source: { version: 1, kind, name: file.name, size: file.size, last_modified: file.lastModified, type: file.type, fingerprint: await hash(new TextEncoder().encode(identity)) } };
}
