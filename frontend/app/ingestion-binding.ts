import type {AppStore} from './store';
import type {JobBinding} from './ingestion-jobs';
const fingerprints=new WeakMap<File,string>();
export function rememberIngestionFile(file:File,fingerprint:string){fingerprints.set(file,fingerprint);}
/** Remote jobs retain portable source authority separately from downloaded-byte evidence. */
export function ingestionBinding(store:AppStore,key:string,expected?:JobBinding):JobBinding|null{
 const doc=store.getDocument(key);if(!doc)return null;
 const local=(doc.local_media_source as {fingerprint?:string}|undefined)?.fingerprint;
 if(local)return expected?.sourceIdentity?null:{key,fingerprint:local,revision:store.getRevision(key)};
 if(!doc.podcast_source)return null;
 const sourceIdentity=JSON.stringify(doc.podcast_source),file=store.getFile(key),sampled=file?fingerprints.get(file):undefined;
 if(expected){if(expected.sourceIdentity!==sourceIdentity||sampled&&sampled!==expected.fingerprint)return null;return {...expected,revision:store.getRevision(key)};}
 return sampled?{key,fingerprint:sampled,revision:store.getRevision(key),sourceIdentity}:null;
}
