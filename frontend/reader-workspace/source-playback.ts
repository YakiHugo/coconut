/** Public navigation only: never fetch, embed, or resolve a redirect on the user's behalf. */
export function safeSourceURL(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
}

export type SourcePlaybackLink = { url: string; timed: boolean; platform: 'YouTube' | 'B站' | null };

/** Transcript timestamps are seconds, independent of local-media calibration. */
export function getSourcePlaybackLink(value: unknown, seconds: number): SourcePlaybackLink | null {
    const safe = safeSourceURL(value);
    if (!safe) return null;
    const fallback: SourcePlaybackLink = { url: safe, timed: false, platform: null };
    if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(Math.floor(seconds))) return fallback;
    const url = new URL(safe), host = url.hostname.toLowerCase();
    // Only exact public platform hosts and recognized video routes get timestamp semantics.
    if (url.port) return fallback;
    let videoId: string | null = null;
    if (host === 'youtu.be') videoId = /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1] || null;
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
        videoId = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|live|embed)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1] || null;
    }
    if (videoId && /^[\w-]{11}$/.test(videoId)) {
        // Canonical watch URLs support timestamps for Shorts, live and embed sources too.
        const target = new URL('https://www.youtube.com/watch');
        target.searchParams.set('v', videoId);
        target.searchParams.set('t', `${Math.floor(seconds)}s`);
        return { url: target.href, timed: true, platform: 'YouTube' };
    }
    if (['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(host) && /^\/video\/(?:BV[A-Za-z0-9]{10}|av\d+)\/?$/.test(url.pathname)) {
        url.protocol = 'https:';
        url.hash = '';
        // Keep multipart p and other source parameters, replace all stale timestamp values.
        url.searchParams.delete('start_progress');
        url.searchParams.set('t', String(Math.floor(seconds)));
        return { url: url.href, timed: true, platform: 'B站' };
    }
    return fallback;
}
