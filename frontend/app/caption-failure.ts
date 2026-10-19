/** Request-only observations. Never display arbitrary helper strings or persist them in documents. */
const stages = {
    initialization: '初始化字幕服务', extractor_setup: '准备字幕提取器', metadata: '读取视频信息',
    track_selection: '选择原语言字幕', caption_download: '下载字幕', caption_parse: '解析字幕',
    caption_output: '检查字幕输出', helper_execution: '运行字幕服务', reader_parse: '导入字幕文字稿',
} as const;
const reasons = {
    access_restricted: '公开入口受限', login_required: '来源要求登录', subtitle_login_required: '字幕要求登录',
    subtitle_token_required: '字幕需要访问凭据', rate_limited: '来源限制了请求频率', http_access_denied: '来源拒绝访问',
    transport_unavailable: '网络连接未完成', metadata_incomplete: '视频信息不完整', request_scope_stopped: '请求已停止',
    non_public_address: '来源地址不符合公开访问要求', identity_mismatch: '来源身份无法核对', budget_exceeded: '已达到本次读取上限',
    unexpected_response: '来源响应不符合预期', upstream_error: '来源服务返回错误', dependency_mismatch: '字幕组件版本不匹配',
    alternate_extractor_stopped: '已停止切换其他提取器', unsupported_request: '不支持此类读取请求', external_execution_stopped: '已停止外部执行',
    duration_unavailable: '无法确认视频时长', redirect_stopped: '跳转未通过检查', guard_stopped: '安全检查未通过',
    language_unknown: '尚未确认原语言', no_matching_track: '未找到匹配原语言的字幕轨道', invalid_caption_file: '字幕文件未通过检查',
    caption_parse_failed: '字幕内容无法解析', caption_download_or_file_failed: '字幕下载或文件检查未完成',
    extractor_error: '字幕提取器未完成', helper_error: '字幕服务未完成', proxy_configuration_invalid: '代理配置无效',
    proxy_unavailable: '代理连接未完成', proxy_auth_required: '代理要求认证', proxy_connect_rejected: '代理拒绝连接', origin_tls_failed: '来源安全连接未完成',
} as const;
export type CaptionFailureDiagnostic = {
    stage: keyof typeof stages; reason: keyof typeof reasons;
    requests_attempted: number | null; responses_received: number | null;
};
export function captionFailureDiagnostic(value: unknown): CaptionFailureDiagnostic | null {
    if (!value || typeof value !== 'object') return null;
    const d = value as CaptionFailureDiagnostic;
    if (typeof d.stage !== 'string' || typeof d.reason !== 'string' || !Object.hasOwn(stages, d.stage) || !Object.hasOwn(reasons, d.reason)) return null;
    const counts = [d.requests_attempted, d.responses_received];
    const unknown = ['helper_execution', 'reader_parse'].includes(d.stage) && counts.every(n => n === null);
    if (!unknown && (!counts.every(n => Number.isInteger(n) && n !== null && n >= 0 && n <= 32) || d.responses_received! > d.requests_attempted!)) return null;
    return {stage: d.stage, reason: d.reason, requests_attempted: d.requests_attempted, responses_received: d.responses_received};
}
export function captionFailureSummary(d: CaptionFailureDiagnostic): string {
    const counts = d.requests_attempted === null ? '请求与响应次数未知' : `尝试请求 ${d.requests_attempted} 次，收到响应 ${d.responses_received} 次`;
    return `停在「${stages[d.stage]}」：${reasons[d.reason]}。${counts}。请求次数不证明已连接到视频平台，收到响应也不代表取得字幕。`;
}
/** Only recognized HTTPS single-video paths; strip unrelated query data, never use receipt-provided URLs. */
export function captionOriginalURL(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 4096) return null;
    if (/^https:\/\/b23\.tv\/[A-Za-z0-9]+$/.test(value)) return value;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
        const host = url.hostname, path = url.pathname;
        if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) {
            const id = host === 'youtu.be' ? path.replace(/^\/|\/$/g, '') : path === '/watch' ? url.searchParams.get('v') : /^\/shorts\/[A-Za-z0-9_-]{11}\/?$/.test(path) ? path.split('/')[2] : null;
            return /^[A-Za-z0-9_-]{11}$/.test(id || '') && url.searchParams.getAll('v').length <= 1 ? 'https://www.youtube.com/watch?v=' + id : null;
        }
        if (['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(host) && /^\/video\/BV[A-Za-z0-9]{10}\/?$/.test(path)) {
            const parts = url.searchParams.getAll('p');
            return parts.length > 1 || parts.length === 1 && parts[0] !== '1' ? null : 'https://www.bilibili.com/video/' + path.split('/')[2];
        }
        if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(host) && /^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/status)\/[0-9]{1,20}\/?$/.test(path)) return 'https://x.com' + path.replace(/\/$/, '');
        return null;
    } catch { return null; }
}
