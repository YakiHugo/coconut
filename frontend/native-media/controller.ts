/** Desktop references never enter portable documents. The host supplies only
 * owners backed by successful canonical save receipts, not optimistic sources. */
export type Owner = {library: string; key: string; epoch: number; source: Record<string, unknown>};
export type Attachment = {url: string; kind: 'audio' | 'video'; name: string; identity: string};
export type NativeAttachment = Attachment & {availability: 'local_session'; nativeToken: string; release: () => void};
export type Receipt = {status: string; token?: string; url?: string; kind?: 'audio' | 'video'; name?: string; identity?: string; rememberedKeys?: string[]};
export type Bridge = {reconcile(owners: Owner[]): Promise<Receipt>; resolve(owner: Owner): Promise<Receipt>; remember(owner: Owner, file: File, identity: string): Promise<Receipt>; forget(owner: Owner): Promise<Receipt>; release(token: string): Promise<unknown>};
export type Dependencies = {
    bridge: Bridge;
    owner(key: string): Owner | null;
    active(key: string): boolean;
    media(key: string): Attachment | null;
    file(key: string): File | null;
    attach(key: string, media: NativeAttachment): void;
};
export type State = {status: string; known: boolean; pending: boolean; suppressed: boolean; checked: boolean};
type Entry = State & {owner: Owner; revision: number};
const id = (owner: Owner | null) => JSON.stringify(owner);
export function createNativeMediaController(deps: Dependencies) {
    const entries = new Map<string, Entry>(), listeners = new Set<() => void>();
    let ready = false, closed = false, generation = 0, queue: Promise<unknown> = Promise.resolve();
    const emit = () => { for (const listener of listeners) listener(); };
    const mutate = <T,>(run: () => Promise<T>): Promise<T> => { const next = queue.then(run, run); queue = next.catch(() => {}); return next; };
    const release = (token?: string) => { if (token) void deps.bridge.release(token).catch(() => {}); };
    const entry = (key: string) => {
        const owner = deps.owner(key); if (!ready || closed || !owner) return null;
        let value = entries.get(key);
        if (!value || id(value.owner) !== id(owner)) {
            value = {owner: structuredClone(owner), revision: 0, status: 'unchecked', known: false, pending: false, suppressed: false, checked: false};
            entries.set(key, value);
        }
        return value;
    };
    const current = (value: Entry) => !closed && entries.get(value.owner.key) === value && id(deps.owner(value.owner.key)) === id(value.owner);
    async function resolve(key: string, retry = false) {
        const value = entry(key);
        if (!value || value.pending || value.suppressed || (!retry && value.checked) || !deps.active(key) || deps.media(key)) return;
        const revision = ++value.revision, selection = generation;
        value.pending = true; value.checked = true; emit();
        let receipt: Receipt; try { receipt = await deps.bridge.resolve(value.owner); } catch { receipt = {status: 'unavailable'}; }
        if (!current(value) || revision !== value.revision || generation !== selection || !deps.active(key) || deps.media(key) || value.suppressed) {
            release(receipt.token);
            if (value.revision === revision) { value.pending = false; value.checked = deps.active(key); emit(); }
            return;
        }
        value.pending = false; value.status = receipt.status;
        value.known = ['ready', 'missing', 'changed', 'unavailable'].includes(receipt.status);
        if (receipt.status === 'ready') {
            if (!receipt.token || !receipt.url || !receipt.identity || !receipt.name || !['audio', 'video'].includes(receipt.kind || '')) {
                release(receipt.token); value.status = 'unavailable';
            } else {
                let released = false;
                const token = receipt.token;
                deps.attach(key, {url: receipt.url, kind: receipt.kind!, name: receipt.name, identity: receipt.identity, availability: 'local_session', nativeToken: token,
                    release: () => { if (!released) { released = true; release(token); } }});
            }
        } else release(receipt.token);
        emit();
    }
    return {
        /** Complete catalog only, after storage bootstrap; never a filtered shelf. */
        async initialize(owners: Owner[]) {
            if (closed || ready) return;
            try {
                const receipt = await mutate(() => deps.bridge.reconcile(structuredClone(owners)));
                if (closed) return;
                if (receipt.status !== 'reconciled' || !Array.isArray(receipt.rememberedKeys)) throw Error('unavailable');
                ready = true;
                for (const owner of owners) { const value = entry(owner.key); if (value && id(value.owner) === id(owner)) { value.known = receipt.rememberedKeys.includes(owner.key); value.status = value.known ? 'remembered' : 'unchecked'; } }
            } catch { ready = false; }
            emit();
        },
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        state(key: string): State { const value = entry(key); return value ? {status: value.status, known: value.known, pending: value.pending, suppressed: value.suppressed, checked: value.checked} : {status: 'unavailable', known: false, pending: false, suppressed: true, checked: false}; },
        resolve,
        /** Call before navigation, picker start/cancel, detach or source replacement. */
        invalidate() { generation++; },
        selected(key: string) { generation++; const value = entry(key); if (value) { value.revision++; value.pending = false; value.checked = true; value.suppressed = false; value.status = 'unchecked'; emit(); } },
        suppress(key: string) { generation++; const value = entries.get(key); if (value) { value.revision++; value.pending = false; value.checked = true; value.suppressed = true; emit(); } },
        async remember(key: string) {
            const value = entry(key), media = deps.media(key), file = deps.file(key);
            if (!value || value.pending || !media || !file) return;
            const revision = ++value.revision; value.pending = true; emit();
            await mutate(async () => {
                let receipt: Receipt;
                try { receipt = await deps.bridge.remember(value.owner, file, media.identity); } catch { receipt = {status: 'unavailable'}; }
                if (!current(value) || value.revision !== revision || deps.media(key) !== media || deps.file(key) !== file) {
                    if (receipt.status === 'remembered') await deps.bridge.forget(value.owner).catch(() => {});
                    if (value.revision === revision) value.pending = false;
                    emit(); return;
                }
                value.pending = false; value.status = receipt.status; value.known ||= receipt.status === 'remembered'; value.checked = true; value.suppressed = false; emit();
            });
        },
        async forget(key: string) {
            const value = entry(key); if (!value || value.pending) return;
            const revision = ++value.revision; value.pending = true; value.suppressed = true; value.checked = true; emit();
            let receipt: Receipt; try { receipt = await mutate(() => deps.bridge.forget(value.owner)); } catch { receipt = {status: 'unavailable'}; }
            if (!current(value) || value.revision !== revision) return;
            value.pending = false;
            value.status = ['forgotten', 'not-remembered'].includes(receipt.status) ? 'forgotten' : 'forget-failed';
            if (value.status === 'forgotten') value.known = false;
            emit();
        },
        /** After committed replacement/removal, retire the exact PREVIOUS owner.
         * Await before enabling remember for a replacement, even same fingerprint. */
        async retire(owner: Owner) {
            generation++; const value = entries.get(owner.key);
            if (value && id(value.owner) === id(owner)) { value.revision++; value.pending = true; value.suppressed = true; emit(); }
            let receipt: Receipt; try { receipt = await mutate(() => deps.bridge.forget(owner)); } catch { receipt = {status: 'unavailable'}; }
            const ok = ['forgotten', 'not-remembered'].includes(receipt.status);
            if (value && entries.get(owner.key) === value) { value.pending = false; value.known = !ok; value.status = ok ? 'unchecked' : 'forget-failed'; emit(); }
            return ok;
        },
        dispose() { closed = true; generation++; listeners.clear(); }
    };
}
export type NativeMediaController = ReturnType<typeof createNativeMediaController>;
