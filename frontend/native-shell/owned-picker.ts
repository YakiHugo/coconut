export type PickerInput = {value: string; click(): void; addEventListener?(type: string, listener: () => void): void; removeEventListener?(type: string, listener: () => void): void};
let nextPickerInstance = 0;
export type PickerWork = {signal: AbortSignal; current(): boolean};
export type PickerDependencies = {
    /** A unique component scope, e.g. media-picker or subtitle-picker:<project>. */
    scope: string;
    setActivity(owner: string, reason: string | null): void;
    reason: string;
};
type Operation = {id: number; input: PickerInput; authority: () => boolean; abort: AbortController; working: boolean; retired: boolean; activity: string; cancel: () => void};
/** Every OS chooser uses a fresh React-keyed input. Reusing a DOM input cannot
 * distinguish an old chooser's late change from the new chooser's result. */
export function createOwnedPicker(deps: PickerDependencies) {
    const instance = ++nextPickerInstance;
    let current: Operation | null = null, generation = 0, inputKey = 0, closed = false;
    const used = new WeakSet<PickerInput>(), work = new Set<Operation>(), listeners = new Set<() => void>();
    const emit = () => { for (const listener of listeners) listener(); };
    const clear = (input: PickerInput) => { input.value = ''; };
    const authorized = (authority: () => boolean) => { try { return authority(); } catch { return false; } };
    const owns = (operation: Operation) => !closed && current === operation && !operation.retired && !operation.abort.signal.aborted && authorized(operation.authority);
    function retire(operation = current) {
        if (!operation) return;
        operation.retired = true; operation.abort.abort(); operation.input.removeEventListener?.('cancel', operation.cancel); clear(operation.input);
        if (current === operation) { current = null; inputKey++; emit(); }
        // An in-flight read/write must settle before native close sees no work.
        if (!operation.working) deps.setActivity(operation.activity, null);
    }
    return {
        getSnapshot: () => inputKey,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        begin(input: PickerInput | null, authority: () => boolean) {
            if (closed || !input || current || work.size || used.has(input) || !authorized(authority)) return false;
            const operation: Operation = {id: ++generation, input, authority, abort: new AbortController(), working: false, retired: false, activity: deps.scope + ':' + instance + ':' + generation, cancel: () => { if (current === operation && !operation.working) retire(operation); }};
            used.add(input); current = operation;
            input.addEventListener?.('cancel', operation.cancel);
            // Synchronous, before click: a second menu/close request sees it.
            deps.setActivity(operation.activity, deps.reason);
            try { input.click(); return true; }
            catch { retire(operation); return false; }
        },
        /** Capture files before calling accept. The input is cleared on all paths.
         * Work must check current() after awaits and before committing side effects. */
        async accept(input: PickerInput, run: (context: PickerWork) => Promise<unknown> | unknown) {
            const operation = current;
            clear(input);
            if (!operation || operation.input !== input) return false;
            if (!owns(operation) || operation.working) { if (!operation.working) retire(operation); return false; }
            operation.input.removeEventListener?.('cancel', operation.cancel);
            operation.working = true; work.add(operation);
            try { await run({signal: operation.abort.signal, current: () => owns(operation)}); return owns(operation); }
            finally {
                work.delete(operation); operation.working = false;
                deps.setActivity(operation.activity, null);
                if (current === operation) { current = null; inputKey++; emit(); }
            }
        },
        cancel(input: PickerInput) { clear(input); if (current?.input === input && !current.working) retire(current); },
        /** New source intent, navigation, collapse, pagehide or unmount. */
        retire() { retire(); },
        dispose() { closed = true; retire(); listeners.clear(); }
    };
}
export type OwnedPicker = ReturnType<typeof createOwnedPicker>;
