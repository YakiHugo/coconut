import {useEffect, useRef} from 'react';
import type {AppStore} from './store';
import type {AppSnapshot} from './contracts';

const readPrefix = '#read/';
const route = (state: AppSnapshot) => state.workspace === 'read' && state.activeKey
    ? readPrefix + encodeURIComponent(state.activeKey)
    : '#' + state.workspace;

function readingKey(hash: string) {
    try {
        return decodeURIComponent(hash.slice(readPrefix.length));
    } catch {
        return '';
    }
}

/** Browser history carries only a library key; never transcript/source text. */
export function useNavigation(store: AppStore, state: AppSnapshot) {
    const renderedRoute = route(state);
    const previous = useRef(renderedRoute);

    useEffect(() => {
        const apply = () => {
            const current = store.getSnapshot(), hash = location.hash;
            const currentRoute = route(current);
            if (hash === currentRoute) return;
            if (current.dirty) {
                history.replaceState(null, '', currentRoute);
                store.setMessage('请先保存或取消编辑，再返回其他内容。');
                return;
            }

            const reading = hash === '#read' || hash.startsWith(readPrefix);
            const key = reading ? readingKey(hash) : '';
            if (!key || !store.select(key)) {
                const workspace = reading || hash === '#library' ? 'library' : 'discover';
                if (workspace !== current.workspace) store.navigate(workspace);
            }
            const next = route(store.getSnapshot());
            if (hash !== next) history.replaceState(null, '', next);
        };

        apply();
        window.addEventListener('popstate', apply);
        window.addEventListener('hashchange', apply);
        return () => {
            window.removeEventListener('popstate', apply);
            window.removeEventListener('hashchange', apply);
        };
    }, [store]);

    useEffect(() => {
        // Applying the incoming URL can update the store before this render's effect runs.
        if (renderedRoute === previous.current || renderedRoute !== route(store.getSnapshot())) return;
        if (location.hash !== renderedRoute) history.pushState(null, '', renderedRoute);
        previous.current = renderedRoute;
        const heading = window.document.querySelector<HTMLElement>('#main-content h1');
        heading?.setAttribute('tabindex', '-1');
        heading?.focus({preventScroll: true});
    }, [renderedRoute, store]);
}
