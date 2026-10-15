import React, {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {createUpdatesController, type UpdateBridge} from './updates';
/** No downloads or installation on mount. Main process still owns confirmation,
 * official release validation, native close approval and final installation. */
export function NativeUpdates({bridge}: {bridge: UpdateBridge}) {
    const [controller] = useState(() => createUpdatesController(bridge));
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const panel = useRef<HTMLDetailsElement>(null), {state, error, pending} = snapshot;
    useEffect(() => { void controller.start(); const open = () => { if (panel.current) { panel.current.open = true; panel.current.querySelector('summary')?.focus(); } }; const close = () => controller.dispose(); window.addEventListener('coconut-open-updates', open); window.addEventListener('pagehide', close); return () => { window.removeEventListener('coconut-open-updates', open); window.removeEventListener('pagehide', close); controller.dispose(); }; }, [controller]);
    return <details id="app-updates" ref={panel} className="native-updates"><summary>应用更新{state.status === 'ready' ? ' · 可安装' : state.status === 'downloading' ? ' · 下载中' : error || state.status === 'error' ? ' · 请重试' : ''}</summary>
        <p>Coconut {state.version || '—'}{state.arch ? ' · ' + (state.arch === 'arm64' ? 'Apple Silicon' : state.arch === 'x64' ? 'Intel' : state.arch) : ''}</p>
        <p role="status">{error || state.message || '更新状态暂不可用。'}</p>
        <label><input type="checkbox" checked={!!state.developer} disabled={!controller.allowed('developer')} onChange={event => void controller.run('developer', event.target.checked)}/>接收未签名开发版更新</label>
        <p>更新包由桌面程序从官方发布检查并校验。安装会另行确认，未保存内容会阻止安全重启。</p>
        <button type="button" disabled={!controller.allowed('check')} onClick={() => void controller.run('check')}>检查更新</button>
        {!!state.nextVersion && ['available','error','cancelled'].includes(state.status) && <button type="button" disabled={!controller.allowed('download')} onClick={() => void controller.run('download')}>下载 {state.nextVersion}</button>}
        {state.status === 'ready' && <button type="button" disabled={!controller.allowed('install')} onClick={() => void controller.run('install')}>安装并重启</button>}
        {(controller.allowed('cancel') || pending === 'cancel') && <button type="button" disabled={!controller.allowed('cancel')} onClick={() => void controller.run('cancel')}>取消更新任务</button>}
        {state.status === 'downloading' && <progress aria-label="更新下载进度" max={100} value={Math.max(0, Math.min(100, Number.isFinite(state.progress) ? state.progress! : 0))}/>}
    </details>;
}
