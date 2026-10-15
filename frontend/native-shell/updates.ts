export type UpdateState = {status: string; version?: string; arch?: string; nextVersion?: string | null; developer?: boolean; message?: string; progress?: number};
export type UpdateBridge = {
    state(): Promise<UpdateState>; check(): Promise<UpdateState>; download(): Promise<UpdateState>; cancel(): Promise<UpdateState>; install(): Promise<UpdateState>; developer(enabled: boolean): Promise<UpdateState>;
    subscribe(listener: (state: UpdateState) => void): () => void;
};
const errorMessage = (value: unknown, fallback: string) => typeof (value as {message?: unknown})?.message === 'string' ? (value as {message: string}).message : fallback;
export type UpdateAction = 'check' | 'download' | 'cancel' | 'install' | 'developer';
export function createUpdatesController(bridge: UpdateBridge) {
    let snapshot: {state: UpdateState; pending: UpdateAction | null; error: string} = {state: {status: 'loading', message: '正在读取更新状态…'}, pending: null, error: ''};
    let closed = false, revision = 0, operation = 0, unsubscribe: (() => void) | null = null;
    const listeners = new Set<() => void>();
    const emit = () => { for (const listener of listeners) listener(); };
    const state = (value: UpdateState) => { if (closed || !value || typeof value.status !== 'string') return; revision++; snapshot = {...snapshot, state: {...value}, error: ''}; emit(); };
    const allowed = (action: UpdateAction) => {
        const status = snapshot.state.status;
        if (closed || status === 'loading') return false;
        if (action === 'cancel') return snapshot.pending !== 'cancel' && (['checking','downloading'].includes(status) || ['check','download'].includes(snapshot.pending || ''));
        if (snapshot.pending || ['checking','downloading','installing'].includes(status)) return false;
        if (action === 'download') return !!snapshot.state.nextVersion && ['available','error','cancelled'].includes(status);
        if (action === 'install') return status === 'ready';
        if (action === 'check') return status !== 'ready';
        return action === 'developer';
    };
    return {
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        allowed,
        async start() {
            if (closed || unsubscribe) return;
            try { unsubscribe = bridge.subscribe(state); const captured = revision; const result = await bridge.state(); if (!closed && revision === captured) state(result); }
            catch (error) { if (!closed) { snapshot = {...snapshot, state: {...snapshot.state, status: 'error'}, error: errorMessage(error, '无法读取更新状态。')}; emit(); } }
        },
        async run(action: UpdateAction, enabled?: boolean) {
            if (!allowed(action) || action === 'developer' && typeof enabled !== 'boolean') return false;
            const owned = ++operation, captured = revision;
            snapshot = {...snapshot, pending: action, error: ''}; emit();
            try {
                const result = await (action === 'developer' ? bridge.developer(enabled!) : bridge[action]());
                if (closed || operation !== owned) return false;
                // Push state wins over an older request's returned snapshot.
                if (revision === captured) state(result);
                return true;
            } catch (error) {
                if (!closed && operation === owned) { snapshot = {...snapshot, error: errorMessage(error, '更新操作失败，请重试。')}; emit(); }
                return false;
            } finally { if (!closed && operation === owned) { snapshot = {...snapshot, pending: null}; emit(); } }
        },
        dispose() { closed = true; operation++; unsubscribe?.(); unsubscribe = null; listeners.clear(); }
    };
}
export type UpdatesController = ReturnType<typeof createUpdatesController>;
