import {useEffect, useState, useSyncExternalStore} from 'react';
import {createOwnedPicker, type PickerDependencies} from './owned-picker';
/** Keep scope/setActivity stable. Use key={inputKey} on the React-owned input. */
export function useOwnedPicker(deps: PickerDependencies) {
    const [controller] = useState(() => createOwnedPicker(deps));
    const inputKey = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    useEffect(() => {
        const close = () => controller.dispose();
        window.addEventListener('pagehide', close);
        return () => { window.removeEventListener('pagehide', close); controller.dispose(); };
    }, [controller]);
    return {controller, inputKey};
}
