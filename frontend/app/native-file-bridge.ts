import {inspectFile} from './ingestion';
import type {Bridge} from '../native-media/controller';
/** Playback may use a durable copy. Native opt-in must still prove the selected
 * original File, never the playback URL or the copied asset's SHA identity. */
export function nativeFileBridge(bridge:Bridge):Bridge {
    return {...bridge, async remember(owner,file,_playbackIdentity) {
        const inspected=await inspectFile(file);
        if(inspected.source.fingerprint!==owner.source.fingerprint)return {status:'unavailable'};
        return bridge.remember(owner,file,inspected.identity);
    }};
}
