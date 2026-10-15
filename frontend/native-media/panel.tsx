import React, {useEffect, useReducer} from 'react';
import type {NativeMediaController} from './controller';
const messages: Record<string, string> = {
    unchecked: '可选：在这台电脑记住原文件。不复制文件，不上传。',
    remembered: '已在这台电脑记住原文件；重新打开时仅载入，不自动播放。',
    ready: '已载入本机原文件，未自动播放。文件信息与部分内容匹配，不是完整内容核验。',
    missing: '找不到原文件。请连接原磁盘后重试，或重新选择文件。笔记与书签仍保留。',
    changed: '原文件信息或内容已改变，请重新选择并核对声音。笔记与书签仍保留。',
    unavailable: '本机原文件引用暂不可用。请确认项目已保存，或重新选择文件。',
    'forget-failed': '旧引用未能取消，重启仍可能载入之前的文件。请重试“不再记住”。',
    forgotten: '已不再记住原文件。原文件没有删除，当前已载入的媒体不受影响。',
    'not-remembered': '未记住原文件。重新选择文件后可在本机回听。'
};
export function NativeMediaPanel({controller, documentKey, canRemember, hasMedia, onRelink}: {
    controller: NativeMediaController; documentKey: string; canRemember: boolean; hasMedia: boolean; onRelink: () => void;
}) {
    const [, refresh] = useReducer(value => value + 1, 0);
    useEffect(() => controller.subscribe(refresh), [controller]);
    useEffect(() => () => controller.invalidate(), [controller, documentKey]);
    // Initialization may complete after mount. The controller's checked guard
    // makes this safe across note saves and view re-renders.
    useEffect(() => { void controller.resolve(documentKey); });
    const state = controller.state(documentKey);
    return <section aria-label="本机原文件" className="native-media-panel">
        <label><input type="checkbox" checked={['remembered','ready','missing','changed'].includes(state.status)} disabled={!canRemember || state.pending} onChange={event => { void (event.target.checked ? controller.remember(documentKey) : controller.forget(documentKey)); }}/>在这台电脑记住原文件</label>
        {state.known && <button type="button" disabled={state.pending} onClick={() => void controller.forget(documentKey)}>不再记住</button>}
        {!hasMedia && !state.suppressed && ['missing','changed','unavailable','remembered','ready'].includes(state.status) && <button type="button" disabled={state.pending} onClick={() => void controller.resolve(documentKey, true)}>重试原文件</button>}
        {!hasMedia && <button type="button" onClick={() => { controller.invalidate(); onRelink(); }}>重新选择原文件</button>}
        <p role="status">{state.pending ? '正在处理原文件引用…' : messages[state.status] || messages.unchecked}</p>
    </section>;
}
