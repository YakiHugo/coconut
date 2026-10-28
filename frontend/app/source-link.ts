/** Extract one explicit web link from a URL or a platform's share text. Never fetch on paste. */
export function parseSourceLink(text: string): {url: string; label: string} | null {
    const input = text.trim();
    const candidates = input.match(/https?:\/\/[^\s<>"'，。！？；、【】「」『』]+/gi)
        || (/^(?:[a-z\d-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s]*)?$/i.test(input) ? ['https://' + input] : []);
    const links = new Map<string, URL>();
    for (let candidate of candidates) {
        if (candidate !== input) candidate = candidate.replace(/[.,;!?:）]+$/, '');
        // Share text often wraps a URL in parentheses; preserve balanced URL path parentheses.
        while (candidate.endsWith(')') && (candidate.match(/\)/g)?.length || 0) > (candidate.match(/\(/g)?.length || 0)) candidate = candidate.slice(0, -1);
        try {
            const url = new URL(candidate);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || candidate.length > 4096) return null;
            links.set(url.href, url);
        } catch { return null; }
    }
    if (links.size !== 1) return null;
    const [url, parsed] = [...links][0], host = parsed.hostname.toLowerCase();
    const at = (domain: string) => host === domain || host.endsWith('.' + domain);
    const label = at('bilibili.com') || at('b23.tv') ? 'Bilibili' : at('youtube.com') || at('youtu.be') ? 'YouTube'
        : at('xiaoyuzhoufm.com') ? '小宇宙' : at('x.com') || at('twitter.com') ? 'X' : /\.(mp3|m4a|wav|ogg|mp4|webm)$/i.test(parsed.pathname) ? '音视频' : '播客 / 链接';
    return {url, label};
}
