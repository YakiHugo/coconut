/** Local-only recovery. Parsing/decoding belong to the existing Coconut domain. */
export type Parsed = { document: unknown; diagnostics: unknown[] };
export type Domain = {
  SUBTITLE_IMPORT_BYTES: number;
  subtitleEncodings(): Array<{ id: string; label: string; available: boolean }>;
  decodeSubtitleBytes(bytes: Uint8Array, selected?: string | null): { ok: boolean; encoding: string; text?: string; error?: string };
  parseWithDiagnostics(text: string, filename: string): Parsed;
  parsePastedSubtitles(text: string, options: { title: string; format: string }): Parsed;
};
type Store = { setDirty(value: boolean, owner: string): void; addDocument(value: unknown): unknown; };
export type AttachScope = { key: string; revision: number; title: string; identity: unknown; sourceIdentity?: readonly unknown[] };
export type Attachment = {
  capture(): AttachScope | null;
  current(scope: AttachScope): boolean;
  commit(document: unknown, scope: AttachScope): Promise<boolean>;
};
export type Row = { id: number; name: string; bytes?: Uint8Array; text: string; encoding: string; parsed?: Parsed; error: string; reviewed: boolean };
export type State = { title: string; text: string; format: string; rows: Row[]; busy: boolean; applying: boolean; mode: 'new' | 'attach'; target: AttachScope | null; paused: boolean; message: string };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '读取失败，原始内容保留。';
export function createRecoveryController(store: Store, domain: Domain, attachment?: Attachment, owner = 'subtitle-recovery') {
  let state: State = { title: '', text: '', format: 'auto', rows: [], busy: false, applying: false, mode: 'new', target: null, paused: false, message: '' };
  let generation = 0, nextId = 0;
  const listeners = new Set<() => void>();
  const draft = () => !!(state.text || state.title || state.rows.length || state.busy);
  const publish = () => { store.setDirty(!state.paused && draft(), owner); for (const listener of listeners) listener(); };
  const update = (patch: Partial<State>) => { state = { ...state, ...patch }; publish(); };
  const replaceRow = (id: number, patch: Partial<Row>) => update({ rows: state.rows.map(row => row.id === id ? { ...row, ...patch } : row) });
  const decode = (row: Row, selected?: string) => {
    if (!row.bytes) return row;
    try {
      const result = domain.decodeSubtitleBytes(row.bytes, selected);
      if (!result.ok) return { ...row, encoding: result.encoding, text: '', parsed: undefined, reviewed: false, error: result.error || '无法解码原始字幕。' };
      const text = result.text!, parsed = domain.parseWithDiagnostics(text, row.name);
      return { ...row, text, encoding: result.encoding, parsed, error: '', reviewed: false };
    } catch (error) { return { ...row, text: '', parsed: undefined, reviewed: false, error: errorMessage(error) }; }
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    encodings: () => domain.subtitleEncodings(),
    chooseMode(mode: 'new' | 'attach') {
      if (state.applying) return;
      generation++;
      const target = mode === 'attach' ? attachment?.capture() || null : null;
      update({ mode, target, busy: false, paused: false, rows: state.rows.map(row => ({ ...row, reviewed: false, ...(row.error === '等待读取' ? {error: '读取已取消，请重新选择此文件。'} : {}) })), message: mode === 'attach' && !target ? '此项目已有正文或来源已变化，不能附加。请保留草稿或新增独立内容。' : '' });
    },
    edit(patch: Partial<Pick<State, 'title' | 'text' | 'format'>>) {
      if (state.applying) return;
      // Editing a paste invalidates only its own preview, never selected files.
      update({ ...patch, paused: false, rows: state.rows.filter(row => row.encoding !== 'Unicode'), message: '' });
    },
    previewPaste() {
      if (state.applying) return;
      try {
        const parsed = domain.parsePastedSubtitles(state.text, { title: state.title, format: state.format });
        update({ paused: false, message: '', rows: [...state.rows.filter(row => row.encoding !== 'Unicode'), { id: ++nextId, name: state.title || '粘贴字幕', text: state.text, encoding: 'Unicode', parsed, error: '', reviewed: false }] });
      } catch (error) { update({ message: errorMessage(error), paused: false }); }
    },
    async chooseFiles(files: ArrayLike<{ name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }>) {
      if (state.applying || !files.length) return; // A native picker cancellation is not a state change.
      const request = ++generation;
      update({ busy: true, paused: false, message: '', rows: state.rows.map(row => row.error === '等待读取' ? { ...row, error: '读取已取消，请重新选择此文件。' } : row) });
      // Append in selection order. Existing recovery drafts are never replaced.
      const selected = Array.from(files).map(file => ({ file, id: ++nextId }));
      update({ rows: [...state.rows, ...selected.map(({ file, id }) => ({ id, name: file.name, text: '', encoding: '', error: '等待读取', reviewed: false }))] });
      for (const { file, id } of selected) {
        if (request !== generation) return;
        try {
          if (!/\.(srt|vtt)$/i.test(file.name)) throw Error('请选择 SRT / VTT 文件；JSON 请使用书架备份恢复。');
          if (file.size > domain.SUBTITLE_IMPORT_BYTES) throw Error('字幕超过 15 MiB，请拆分后重试。');
          const buffer = await file.arrayBuffer();
          if (request !== generation) return;
          if (buffer.byteLength > domain.SUBTITLE_IMPORT_BYTES) throw Error('字幕超过 15 MiB，请拆分后重试。');
          const row = state.rows.find(row => row.id === id);
          if (row) replaceRow(id, decode({ ...row, bytes: new Uint8Array(buffer) }));
        } catch (error) { if (request === generation) replaceRow(id, { error: errorMessage(error) }); }
      }
      if (request === generation) update({ busy: false });
    },
    encoding(id: number, selected: string) {
      if (state.applying) return;
      const row = state.rows.find(row => row.id === id);
      if (row) { update({ paused: false }); replaceRow(id, decode(row, selected || undefined)); }
    },
    review(id: number, reviewed: boolean) { if (state.applying) return; const row = state.rows.find(row => row.id === id); if (row?.parsed) { update({ paused: false }); replaceRow(id, { reviewed }); } },
    remove(id: number) { if (state.applying) return; update({ rows: state.rows.filter(row => row.id !== id) }); },
    pause() {
      generation++;
      update({ paused: true, busy: false, target: null, rows: state.rows.map(row => row.error === '等待读取' ? { ...row, error: '读取已取消，请重新选择此文件。' } : row), message: '已暂停。草稿保留在本次打开的页面中，可继续核对。' });
    },
    resume() { update({ paused: false, message: '' }); },
    async apply() {
      if (state.busy || state.applying || state.paused) return;
      const ready = state.rows.filter(row => row.parsed && row.reviewed);
      if (!ready.length) return;
      if (state.mode === 'attach') {
        const target = state.target;
        if (ready.length !== 1) { update({ message: '每次只能选择一份已核对字幕附加到原项目。' }); return; }
        if (!target || !attachment?.current(target)) { update({ message: '原项目或来源已变化，请重新选择附加目标并核对。草稿保留。' }); return; }
        const request = ++generation, row = ready[0];
        update({ applying: true, message: '正在保存到原项目；已开始的保存以页面回执为准。' });
        store.setDirty(false, owner);
        try {
          const ok = await attachment.commit(row.parsed!.document, target);
          if (request !== generation) return;
          if (!ok) { update({ message: '附加尚未确认保存，草稿保留。请查看页面保存状态并重试保存或导出备份，不要重复附加。' }); return; }
          update({ target: null, rows: state.rows.filter(item => item.id !== row.id), ...(!row.bytes ? {text: '', title: ''} : {}), message: '已将字幕保存到原项目，原媒体与笔记保留。' });
        } catch (error) { if (request === generation) update({ message: errorMessage(error) }); }
        finally { update({ applying: false }); }
        return;
      }
      // Release only this editor's guard. Any other dirty owner still blocks admission.
      store.setDirty(false, owner);
      const accepted = new Set<number>(); let failure = '';
      for (const row of ready) {
        try { if (!store.addDocument(row.parsed!.document)) { failure = '内容尚未加入，草稿保留。请先处理其他未完成的修改或保存问题。'; break; } accepted.add(row.id); }
        catch (error) { failure = errorMessage(error); break; }
      }
      const pasteAccepted = ready.some(row => accepted.has(row.id) && !row.bytes);
      update({ rows: state.rows.filter(row => !accepted.has(row.id)), ...(pasteAccepted ? { text: '', title: '' } : {}), message: failure || `已加入 ${accepted.size} 份内容；保存结果请查看页面保存状态。` });
    },
  };
}
export type RecoveryController = ReturnType<typeof createRecoveryController>;
