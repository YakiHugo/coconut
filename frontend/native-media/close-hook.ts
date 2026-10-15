import {useEffect} from 'react';
import {createCloseController, type CloseDependencies} from './close';
/** Keep deps referentially stable for the lifetime of the application. */
export function useNativeClose(deps: CloseDependencies, enabled = true) {
    useEffect(() => {
        if (!enabled) return;
        const controller = createCloseController(deps);
        const host = window as unknown as {coconutPrepareClose?: typeof controller.close; coconutPrepareUpdate?: typeof controller.update};
        const previousClose = host.coconutPrepareClose, previousUpdate = host.coconutPrepareUpdate;
        host.coconutPrepareClose = controller.close; host.coconutPrepareUpdate = controller.update;
        return () => {
            controller.dispose();
            if (host.coconutPrepareClose === controller.close) host.coconutPrepareClose = previousClose;
            if (host.coconutPrepareUpdate === controller.update) host.coconutPrepareUpdate = previousUpdate;
        };
    }, [deps, enabled]);
}
