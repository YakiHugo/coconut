import {useEffect,useRef,type ReactNode} from 'react';
import type {AppStore} from './store';
import {BilibiliSession} from './bilibili-session';
import {NativeShell} from './native-shell';
import {ReadingPreferences,type ReadingPreferencesController} from '../reading-preferences/preferences';
import {SubtitleRecovery} from '../recovery-import/recovery';
import {Recovery} from './recovery';

/** Settings stay mounted so closing the surface never destroys an import draft. */
export function Settings({store,preferences,open,onOpenChange,onExportBackup,storageSettings}:{
    store:AppStore;preferences:ReadingPreferencesController;open:boolean;onOpenChange:(open:boolean)=>void;onExportBackup:()=>void;storageSettings?:ReactNode;
}) {
    const host=useRef<HTMLDetailsElement>(null);
    const close=()=>{onOpenChange(false);host.current?.querySelector('summary')?.focus();};
    useEffect(()=>{
        if(!open)for(const details of host.current?.querySelectorAll<HTMLDetailsElement>('.subtitle-recovery[open]')||[])details.open=false;
    },[open]);
    useEffect(()=>{
        const showUpdates=()=>{onOpenChange(true);};
        window.addEventListener('coconut-open-updates',showUpdates);
        return()=>window.removeEventListener('coconut-open-updates',showUpdates);
    },[onOpenChange]);
    return <details className="app-settings" ref={host} open={open} onToggle={event=>{if(event.currentTarget.open!==open)onOpenChange(event.currentTarget.open);}}>
        <summary onClick={event=>{event.preventDefault();onOpenChange(!open);}}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--surface)"/><circle cx="15" cy="17" r="3" fill="var(--surface)"/></svg>设置</summary>
        <section className="settings-panel" aria-label="设置" onKeyDown={event=>{if(event.key==='Escape'&&!event.defaultPrevented&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();close();}}}>
            <header className="settings-heading"><div><p className="kicker">PREFERENCES</p><h1>设置</h1></div><button type="button" aria-label="关闭设置" onClick={close}>×</button></header>
            <div className="settings-group"><div><h2>阅读与外观</h2></div><div><ReadingPreferences controller={preferences} expanded/></div></div>
            <div className="settings-group settings-connections"><div><h2>来源连接</h2></div><div><BilibiliSession disabled={store.getSnapshot().dirty}/></div></div>
            <div className="settings-group"><div><h2>数据与导入</h2></div><div><button className="settings-backup" data-native-command="backup-library" onClick={onExportBackup}>导出完整备份<span aria-hidden="true">↗</span></button><SubtitleRecovery store={store} label="导入字幕"/><Recovery store={store}/>{storageSettings}</div></div>
            <NativeShell store={store} onSettingsChange={onOpenChange}/>
        </section>
    </details>;
}
