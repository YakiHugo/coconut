import {useEffect, useRef} from 'react';
import {createCommandDispatcher, type CommandDependencies} from './commands';
/** Mount only after a coherent library and the actual command targets are ready. */
export function useNativeCommands(deps: CommandDependencies, enabled: boolean) {
    const current = useRef(deps); current.current = deps;
    useEffect(() => {
        if (!enabled) return;
        const controller = createCommandDispatcher({timeOrigin: deps.timeOrigin, ready: () => current.current.ready(), blocked: command => current.current.blocked(command), run: command => current.current.run(command)});
        const host = window as unknown as {coconutFileCommand?: typeof controller.command; CoconutReactDesktopReady?: boolean};
        const command = controller.command;
        host.coconutFileCommand = command;
        host.CoconutReactDesktopReady = true;
        window.dispatchEvent(new Event('coconut-react-desktop-ready'));
        const close = () => { controller.dispose(); if (host.coconutFileCommand === command) host.CoconutReactDesktopReady = false; };
        window.addEventListener('pagehide', close);
        return () => { close(); window.removeEventListener('pagehide', close); if (host.coconutFileCommand === command) delete host.coconutFileCommand; };
    }, [enabled, deps.timeOrigin]);
}
