import React, { useEffect, useRef, useMemo, useSyncExternalStore } from 'react';
import { attachTranscript } from '../app/attach-transcript';
import type { Document } from '../app/contracts';
import type { AppStore } from '../app/store';
import { createRecoveryController, type Domain, type AttachScope, type RecoveryController } from './controller';
// Session lifetime only. Closing this panel or navigating never erases a paste draft.
const sessions = new WeakMap<AppStore, Map<string, RecoveryController>>();
export function SubtitleRecovery({ store, targetKey }: { store: AppStore; targetKey?: string }) {
  const controller = useMemo(() => {
    let group = sessions.get(store);
    if (!group) { group = new Map(); sessions.set(store, group); }
    const sessionKey = targetKey || 'standalone';
    let existing = group.get(sessionKey);
    if (!existing) {
      const runtime = window as unknown as { Coconut: Domain & { validate(value: unknown): Record<string, unknown>; attachProjectTranscript(project: unknown, source: unknown): Record<string, unknown> }; CoconutCanonicalLibrary: { project(raw: unknown, normalized: unknown): Document } };
      const sourceIdentity = () => [store.getMedia(targetKey!), store.getRemoteMedia(targetKey!), store.getFile(targetKey!)];
      const current = (scope: AttachScope) => !!scope.sourceIdentity?.every((value, index) => value === sourceIdentity()[index]) && store.getSnapshot().activeKey === scope.key && store.getDocument(scope.key) === scope.identity && store.getRevision(scope.key) === scope.revision && store.getDocument(scope.key)?.project_kind === 'audio_only';
      existing = createRecoveryController(store, runtime.Coconut, targetKey ? {
        capture() { const doc = store.getDocument(targetKey); return doc?.project_kind === 'audio_only' && store.getSnapshot().activeKey === targetKey ? { key: targetKey, revision: store.getRevision(targetKey), title: doc.title, identity: doc, sourceIdentity: sourceIdentity() } : null; },
        current,
        async commit(source, scope) {
          if (!current(scope) || store.getSnapshot().dirty) return false;
          const next = attachTranscript(scope.identity as Document, source, runtime.Coconut, runtime.CoconutCanonicalLibrary.project);
          if (!current(scope)) return false;
          return store.commitDocument(next, {key: scope.key, revision: scope.revision});
        },
      } : undefined, 'subtitle-recovery:' + sessionKey);
      group.set(sessionKey, existing);
    }
    return existing;
  }, [store, targetKey]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { const retire = () => controller.pause(); window.addEventListener('pagehide', retire); return () => { window.removeEventListener('pagehide', retire); retire(); }; }, [controller]);
  return <details className="subtitle-recovery" onToggle={event => { if (!event.currentTarget.open) controller.pause(); }}>
    <summary>高级恢复：导入或粘贴 SRT / VTT 字幕</summary>
    <p>适用于已经有字幕的情况。仅在本机解码与核对，不会上传文件。默认新增独立内容；可明确选择为尚无文字稿的原声项目补充字幕。已有正文不会被替换。</p>
    <p>草稿仅保留到本次页面关闭；刷新前请保存原始文件或复制文字。</p>
    {state.paused && <button onClick={() => controller.resume()}>继续核对保留的草稿</button>}
    {targetKey && <section aria-label="选择字幕恢复目标">
      <button disabled={state.applying} aria-pressed={state.mode === 'new'} onClick={() => controller.chooseMode('new')}>新增独立内容</button>
      <button disabled={state.applying} aria-pressed={state.mode === 'attach'} onClick={() => controller.chooseMode('attach')}>补充到当前原声项目（重新核对）</button>
      {state.mode === 'attach' && <p>{state.target ? `附加目标：${state.target.title}。只接收一份已核对字幕，保留原媒体、项目笔记和书签。` : '附加目标尚未确认，请重新选择。'}</p>}
    </section>}
    <fieldset disabled={state.applying}><legend>字幕预览与核对</legend>
    <label>字幕标题<input value={state.title} maxLength={200} onChange={event => controller.edit({ title: event.target.value })}/></label>
    <label>字幕格式<select value={state.format} onChange={event => controller.edit({ format: event.target.value })}><option value="auto">自动识别</option><option value="srt">SRT</option><option value="vtt">VTT</option></select></label>
    <label>粘贴带完整起止时间的字幕<textarea value={state.text} rows={8} onChange={event => controller.edit({ text: event.target.value })}/></label>
    <button onClick={() => controller.previewPaste()}>预览粘贴字幕</button>
    <button disabled={state.busy} onClick={() => input.current?.click()}>选择字幕文件（可多选）</button>
    <input ref={input} hidden type="file" accept=".srt,.vtt" multiple onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; void controller.chooseFiles(files); }}/>
    <ol>{state.rows.map(row => <li key={row.id}>
      <h3>{row.name}</h3>
      {row.bytes && <label>原始文件编码<select value={row.encoding} onChange={event => controller.encoding(row.id, event.target.value)}>{controller.encodings().map(option => <option key={option.id} value={option.id} disabled={!option.available}>{option.label}{!option.available && '（当前浏览器不支持）'}</option>)}</select></label>}
      {row.error && <p role="alert">{row.error}</p>}
      {row.parsed && <><p>{(row.parsed.document as {segments: unknown[]}).segments.length} 条字幕。{row.parsed.diagnostics.length > 0 && `部分字幕未导入：${row.parsed.diagnostics.length} 项诊断。请先检查原文。`}</p>
        {row.parsed.diagnostics.length > 0 && <pre>{JSON.stringify(row.parsed.diagnostics, null, 2)}</pre>}
        <details><summary>核对原始字幕全文</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: '24rem', overflow: 'auto' }}>{row.text}</pre></details>
        <label><input type="checkbox" checked={row.reviewed} onChange={event => controller.review(row.id, event.target.checked)}/>我已核对文字、编码和诊断，确认加入</label></>}
      <button onClick={() => controller.remove(row.id)}>移除此预览</button>
    </li>)}</ol>
    </fieldset>
    <button disabled={state.applying || state.busy || state.paused || !state.rows.some(row => row.parsed && row.reviewed)} onClick={() => void controller.apply()}>{state.mode === 'attach' ? '将已核对字幕附加到目标项目' : '加入已核对的字幕'}</button>
    <button onClick={() => controller.pause()}>取消读取 / 保留草稿</button>
    <p role="status">{state.busy ? '正在按选择顺序读取；核对前不会加入书架。' : state.message}</p>
  </details>;
}
