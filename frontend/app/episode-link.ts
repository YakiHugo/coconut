import type {Episode,Ingestion} from './ingestion';

function episodeId(value:unknown):string|null {
    if(typeof value!=='string')return null;
    try {
        const url=new URL(value);
        if(url.protocol!=='https:'||url.username||url.password||url.port||!['xiaoyuzhoufm.com','www.xiaoyuzhoufm.com'].includes(url.hostname))return null;
        return url.pathname.match(/^\/episode\/([a-f0-9]{24})\/?$/)?.[1]||null;
    } catch {return null;}
}

/** An exact episode link already supplies the choice; show and RSS links do not. */
export async function resolveEpisodeLink(url:string,selection:Ingestion['selection']):Promise<Episode|null> {
    if(selection?.kind!=='feed'||selection.source_type!=='xiaoyuzhou_public_page'||selection.feeds?.length||selection.episodes?.length!==1)return null;
    const eid=episodeId(url),episode=selection.episodes[0];
    if(!eid||episodeId(selection.feed_url)!==eid||episodeId(episode.source_url)!==eid||!episode.media?.length)return null;
    if(episode.transcripts?.some(track=>track.supported)&&episode.transcript_selection?.status!=='default')return null;
    if(!globalThis.crypto?.subtle)return null;
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(eid));
    const id=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
    return episode.id===id?episode:null;
}
