/** Renderer half of desktop/close-coordinator.mjs. No destructive work during inspection. */
export type CloseRequest = {id: number; kind: 'close' | 'update'; expiresAt: number};
export type CloseSnapshot = {safe: boolean; flushable: boolean; reasons: string[]; nonContentReasons: string[]};
export type CloseDependencies = {
    snapshot(): CloseSnapshot;
    acquireBarrier(id: number): unknown;
    barrierActive(token: unknown): boolean;
    releaseBarrier(token: unknown): void;
    flush(token?: unknown): Promise<{ok: boolean}>;
    discardPending(token: unknown): Promise<{ok: boolean}>;
    lockUI(): () => void;
    /** Synchronous final listening write and cancellation of async ingress. */
    finish(): void;
    updateReady(): boolean;
    now?: () => number;
};
type Owner = CloseRequest & {token: unknown; retired: boolean; locked: boolean; unlock: () => void; completion: Promise<boolean>};
export function createCloseController(deps: CloseDependencies) {
    const now = deps.now || Date.now;
    let owner: Owner | null = null, latest = 0, latestKind: CloseRequest['kind'] | null = null, retired = 0, disposed = false;
    const validId = (request?: CloseRequest): request is CloseRequest => !!request && Number.isSafeInteger(request.id) && request.id > 0 && ['close','update'].includes(request.kind);
    const current = (request: CloseRequest | undefined, kind: CloseRequest['kind']) => {
        if (disposed || !validId(request) || request.kind !== kind || !Number.isFinite(request.expiresAt) || request.expiresAt <= now() || request.id <= retired || request.id < latest || (owner && (owner.id !== request.id || owner.kind !== request.kind))) return false;
        latest = request.id; latestKind = request.kind; return true;
    };
    const releaseOwner = (value: Owner) => {
        if (owner !== value) return false;
        owner = null; value.retired = true;
        try { value.unlock(); } finally { deps.releaseBarrier(value.token); }
        return true;
    };
    const owns = (value: Owner) => !disposed && owner === value && !value.retired && value.id > retired && value.expiresAt > now() && deps.barrierActive(value.token);
    const release = (request?: CloseRequest) => {
        if (!validId(request) || request.id > latest || (request.id === latest && request.kind !== latestKind)) return false;
        retired = Math.max(retired, request.id);
        return owner?.id === request.id && owner.kind === request.kind ? releaseOwner(owner) : false;
    };
    const commit = (mode: 'safe' | 'discard', request: CloseRequest): Promise<boolean> | boolean => {
        if (!current(request, request.kind)) return false;
        if (owner) return owner.completion;
        const snapshot = deps.snapshot();
        if (mode === 'safe' && (!snapshot.flushable || (request.kind === 'update' && !deps.updateReady()))) return false;
        const token = deps.acquireBarrier(request.id); if (!token) return false;
        let unlock: () => void;
        try { unlock = deps.lockUI(); } catch { deps.releaseBarrier(token); return false; }
        const value: Owner = {...request, token, retired: false, locked: false, unlock, completion: Promise.resolve(false)};
        owner = value;
        value.completion = Promise.resolve().then(async () => {
            try {
                if (!owns(value)) return false;
                const receipt = await (mode === 'discard' ? deps.discardPending(token) : deps.flush(token));
                if (!receipt.ok || !owns(value)) return false;
                if (mode === 'safe' && (!deps.snapshot().safe || (request.kind === 'update' && !deps.updateReady()))) return false;
                deps.finish();
                if (!owns(value)) return false;
                value.locked = true;
                return true;
            } catch { return false; }
            finally { if (!value.locked) releaseOwner(value); }
        });
        return value.completion;
    };
    return {
        close(mode = 'inspect', request?: CloseRequest): CloseSnapshot | null | boolean | Promise<boolean> {
            if (mode === 'release') return release(request);
            if (mode === 'inspect') return !disposed && (!request || current(request, 'close')) ? deps.snapshot() : null;
            if ((mode !== 'safe' && mode !== 'discard') || !current(request, 'close')) return false;
            return commit(mode, request!);
        },
        update(lock = false, request?: CloseRequest): boolean | Promise<boolean> {
            if (disposed || (request && !current(request, 'update'))) return false;
            if (lock) return request ? commit('safe', request) : false;
            if (owner || !deps.updateReady()) return false;
            return (async () => {
                try {
                    const receipt = await deps.flush();
                    if (!receipt.ok || disposed || (request && !current(request, 'update')) || owner) return false;
                    return deps.snapshot().safe && deps.updateReady();
                } catch { return false; }
            })();
        },
        dispose() { disposed = true; retired = Math.max(retired, latest); if (owner) releaseOwner(owner); }
    };
}
