export const commandNames = ['import-transcript', 'open-local-media', 'backup-library', 'find-transcript'] as const;
export type NativeCommand = typeof commandNames[number];
export type CommandDependencies = {
    ready(): boolean;
    blocked(command: NativeCommand): boolean;
    /** Must be synchronous: invoke the actual picker/focus/download in this gesture. */
    run(command: NativeCommand): boolean;
    now?: () => number;
    timeOrigin: number;
};
export function createCommandDispatcher(deps: CommandDependencies) {
    let closed = false;
    return {
        command(command: string, request?: {issuedAt: number; expiresAt: number}) {
            const now = (deps.now || Date.now)();
            if (closed || !commandNames.includes(command as NativeCommand) || !request || !Number.isFinite(request.issuedAt) || !Number.isFinite(request.expiresAt) || request.issuedAt < deps.timeOrigin || request.issuedAt > now || request.expiresAt <= now || request.expiresAt <= request.issuedAt || request.expiresAt > request.issuedAt + 2000 || !deps.ready() || deps.blocked(command as NativeCommand)) return false;
            try { return deps.run(command as NativeCommand) === true; } catch { return false; }
        },
        dispose() { closed = true; }
    };
}
