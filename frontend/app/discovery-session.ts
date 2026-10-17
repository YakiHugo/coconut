import type {AppStore} from './store';
import type {Document} from './contracts';
import type {Episode, Ingestion} from './ingestion';
export type SourceAttempt = {url:string; language?:string; episode?:Episode; feed?:string; track?:string; intent?:'media_only'};
export type DiscoverySession = {
    url:string; catalogQuery:string; episodeQuery:string; episodeLimit:number; selection:Ingestion['selection']|null;
    tracks:Record<string,string>; attempt:SourceAttempt|null; error:string;
    receipt:Ingestion|null;
    language:string; languageChoices:string[]; languageRequired:boolean; lossReviewed:boolean;
};
// Navigation keeps discovery context, never a running request or a File handle.
const sessions = new WeakMap<AppStore,DiscoverySession>();
export function discoverySession(store:AppStore):DiscoverySession {
    let value=sessions.get(store);
    if(!value){value={url:'',catalogQuery:'',episodeQuery:'',episodeLimit:20,selection:null,tracks:{},attempt:null,error:'',receipt:null,language:'',languageChoices:[],languageRequired:false,lossReviewed:false};sessions.set(store,value);}
    return value;
}
export function saveDiscoverySession(store:AppStore,value:DiscoverySession){sessions.set(store,value);}
function publicURL(value:unknown):string|null {
    if(typeof value!=='string')return null;
    try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;url.hash='';return url.href;}catch{return null;}
}
/** Only declared canonical identities. Titles, filenames and enclosure guesses are not identity. */
export function exactSourceIdentity(value:unknown):string|null {
    if(!value||typeof value!=='object')return null;
    const doc=value as Record<string,unknown>,source=doc.podcast_source as Record<string,unknown>|undefined;
    if(source){
        if(source.kind==='direct_media'){const url=publicURL(source.media_url);return url?JSON.stringify(['direct_media',url]):null;}
        const feed=publicURL(source.feed_url),id=source.episode_id;
        return feed&&typeof id==='string'&&/^[a-f0-9]{64}$/.test(id)?JSON.stringify(['podcast',feed,id]):null;
    }
    const provenance=doc.provenance as Record<string,unknown>|undefined;
    if(provenance&&['platform_subtitles','automatic_subtitles'].includes(String(provenance.kind))&&['youtube','bilibili','x'].includes(String(provenance.source_platform))&&typeof provenance.media_id==='string'&&provenance.media_id.length>0&&provenance.media_id.length<=128){
        return JSON.stringify(['platform',provenance.source_platform,provenance.media_id]);
    }
    return null;
}
export function matchingSourceDocuments(documents:readonly Document[],value:unknown):Document[]{
    const identity=exactSourceIdentity(value);
    return identity?documents.filter(doc=>exactSourceIdentity(doc)===identity):[];
}
export function ingestionDocument(receipt:Ingestion|null):unknown|null {
    return receipt?.state==='ready'?receipt.transcript?.document||null:receipt?.state==='needs_transcription'?receipt.project?.document||null:null;
}
