import {createHash} from 'node:crypto';
import {libraryError,LIBRARY_DOCUMENT_BYTES} from './library-store.mjs';
export const MIGRATION_BYTES=64*1024*1024,CHUNK_BYTES=1024*1024;
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const bad=(message='Invalid migration request')=>{throw libraryError('migration_invalid',message);};
const conflict=message=>{throw libraryError('migration_conflict',message,409);};
const integer=value=>Number.isSafeInteger(value)&&value>=0;
export function createMigrationStore({db,transaction,epoch,metadata,validateRow,validKey,titleOf,corrupt}){
 const result=row=>{
  if(!row)return null;
  let manifest,receipt;try{manifest=row.manifest?JSON.parse(row.manifest):null;receipt=row.receipt?JSON.parse(row.receipt):null;}catch{corrupt();}
  if(!uuid(row.id)||!['staging','cancelled','committed'].includes(row.state)||row.state!=='cancelled'&&!manifest||
    manifest&&(!uuid(manifest.sourceId)||!uuid(manifest.mediaLibraryIdentity)||! /^[a-f0-9]{64}$/.test(manifest.sha256)||!integer(manifest.bytes)||manifest.bytes<1||manifest.bytes>MIGRATION_BYTES||manifest.chunks!==Math.ceil(manifest.bytes/CHUNK_BYTES))||
    row.state==='committed'&&(!receipt||receipt.epoch!==epoch||receipt.migrationId!==row.id||receipt.sha256!==manifest.sha256||receipt.sourceId!==manifest.sourceId||receipt.mediaLibraryIdentity!==manifest.mediaLibraryIdentity||!integer(receipt.sequence)||receipt.sequence>metadata().sequence||!integer(receipt.documents)))corrupt();
  return {protocolVersion:1,epoch,migrationId:row.id,state:row.state,manifest,receipt};
 };
 const status=id=>{if(!uuid(id))bad();return result(db.prepare('SELECT * FROM migrations WHERE id=?').get(id));};
 function request(input){
  if(!input||input.protocolVersion!==1||input.epoch!==epoch||!uuid(input.migrationId)||!['begin','chunk','finalize','cancel'].includes(input.action))bad();
  return transaction(()=>{
   const id=input.migrationId,row=db.prepare('SELECT * FROM migrations WHERE id=?').get(id);
   if(row)result(row);
   if(input.action==='cancel'){
    if(row?.state==='committed')return result(row);
    // Tombstone even a not-yet-seen begin: delayed requests cannot resurrect it.
    if(!row)db.prepare('INSERT INTO migrations VALUES (?,NULL,?,NULL)').run(id,'cancelled');
    else db.prepare("UPDATE migrations SET state='cancelled' WHERE id=?").run(id);
    db.prepare('DELETE FROM migration_chunks WHERE id=?').run(id);
    return status(id);
   }
   if(row?.state==='cancelled')conflict('Migration was cancelled; start a new explicit attempt');
   if(input.action==='begin'){
    const m=input.manifest;
    if(!m||!uuid(m.sourceId)||! /^[a-f0-9]{64}$/.test(m.sha256)||!integer(m.bytes)||m.bytes<1||m.bytes>MIGRATION_BYTES||
      !integer(m.chunks)||m.chunks!==Math.ceil(m.bytes/CHUNK_BYTES)||!uuid(m.mediaLibraryIdentity))bad('Migration exceeds limits or has invalid manifest');
    const encoded=JSON.stringify(m);
    if(row){if(row.manifest!==encoded)conflict('Migration manifest changed');return result(row);}
    if(db.prepare("SELECT id FROM migrations WHERE state='staging' LIMIT 1").get())conflict('Another migration is staging');
    db.prepare('INSERT INTO migrations VALUES (?,?,?,NULL)').run(id,encoded,'staging');return status(id);
   }
   if(!row)bad('Migration must begin first');
   const manifest=JSON.parse(row.manifest);
   if(input.action==='chunk'){
    if(row.state!=='staging')return result(row);
    if(!integer(input.index)||input.index>=manifest.chunks||typeof input.data!=='string'||! /^[A-Za-z0-9+/]*={0,2}$/.test(input.data))bad();
    const bytes=Buffer.from(input.data,'base64'),expected=input.index===manifest.chunks-1?manifest.bytes-input.index*CHUNK_BYTES:CHUNK_BYTES;
    if(bytes.length!==expected||bytes.toString('base64')!==input.data)bad('Invalid chunk bytes');
    const prior=db.prepare('SELECT data FROM migration_chunks WHERE id=? AND position=?').get(id,input.index);
    if(prior&&prior.data!==input.data)conflict('Migration chunk changed');
    if(!prior)db.prepare('INSERT INTO migration_chunks VALUES (?,?,?)').run(id,input.index,input.data);
    return {protocolVersion:1,epoch,migrationId:id,state:'staging',index:input.index,sha256:hash(bytes)};
   }
   if(row.state==='committed')return result(row);
   const chunks=db.prepare('SELECT position,data FROM migration_chunks WHERE id=? ORDER BY position').all(id);
   if(chunks.length!==manifest.chunks||chunks.some((c,i)=>c.position!==i))bad('Migration chunks incomplete');
   const bytes=Buffer.concat(chunks.map(c=>Buffer.from(c.data,'base64')));
   if(bytes.length!==manifest.bytes||hash(bytes)!==manifest.sha256)bad('Migration digest mismatch');
   let recovery;try{recovery=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{bad('Invalid lossless recovery JSON');}
   const inspect=[recovery];let visited=0;
   while(inspect.length){const value=inspect.pop();if(++visited>2000000)bad('Recovery structure exceeds node budget');
    if(typeof value==='number'&&(!Number.isFinite(value)||Object.is(value,-0)||Number.isInteger(value)&&!Number.isSafeInteger(value)))bad('Recovery contains a lossy JSON number');
    if(value&&typeof value==='object')for(const child of Object.values(value))inspect.push(child);
   }
   const stores=recovery?.stores;
   if(recovery?.format!=='coconut-storage-recovery'||recovery.version!==1||!stores||!['meta','documents','catalog','tombstones','legacySnapshots'].every(key=>Array.isArray(stores[key])))bad('Incomplete browser recovery snapshot');
   const maps={};for(const name of Object.keys(stores)){
    maps[name]=new Map();for(const entry of stores[name]){if(!entry||!Object.hasOwn(entry,'key')||!Object.hasOwn(entry,'value')||maps[name].has(entry.key))bad('Duplicate recovery row');maps[name].set(entry.key,entry.value);}
   }
   if(maps.meta.get('canonical-source-id')!==manifest.sourceId||maps.meta.get('desktop-media-library')!==manifest.mediaLibraryIdentity)bad('Browser source identity differs from manifest');
   const browserState=maps.meta.get('state');
   if(!browserState||browserState.status!=='ready'||!integer(browserState.nextOrder))bad('Browser source is not a verified ready snapshot');
   const existingAdoption=db.prepare('SELECT receipt FROM migrations WHERE state=? AND id<>?').get('committed',id);
   if(existingAdoption)conflict('This PC library already adopted a browser source');
   const imported=[];
   const checkIdentity=(key,value)=>{
    if(!validKey(key)||value?.key!==key||value.envelopeVersion!==1||!integer(value.epoch)||value.epoch<1||!integer(value.revision)||value.revision<value.epoch||!integer(value.generation)||!validKey(value.mutationId))bad('Invalid document identity');
   };
   for(const [key,source] of maps.documents){
    checkIdentity(key,source);const catalog=maps.catalog.get(key);
    if(maps.tombstones.has(key)||!catalog||catalog.key!==key||catalog.epoch!==source.epoch||catalog.revision!==source.revision||!integer(catalog.order)||catalog.order>=browserState.nextOrder)bad('Document catalog mismatch');
    if(!source.payload||source.payload.key!==key)bad('Document payload identity mismatch');
    const payload=JSON.stringify(source.payload);if(Buffer.byteLength(payload)>LIBRARY_DOCUMENT_BYTES)bad('Document exceeds byte budget');
    imported.push({key,source,catalog,payload,deleted:0});
   }
   if(maps.catalog.size!==maps.documents.size)bad('Orphan catalog rows');
   for(const [key,source] of maps.tombstones){
    checkIdentity(key,source);if(source.deleted!==true||Object.hasOwn(source,'payload')||!integer(source.order)||source.order>=browserState.nextOrder)bad('Invalid tombstone');
    imported.push({key,source,catalog:{order:source.order},payload:'null',deleted:1});
   }
   // Check every collision before applying any row. Even matching content must
   // preserve lifetime and deletion status; no last-writer-wins merge exists.
   const sequence=metadata().sequence;let next=sequence;
   for(const item of imported){
    const current=db.prepare('SELECT * FROM documents WHERE key=?').get(item.key);
    if(current){validateRow(current,sequence);const identity=db.prepare('SELECT lifetime,position FROM identities WHERE key=?').get(item.key);
     if(current.payload!==item.payload||current.deleted!==item.deleted||identity?.lifetime!==item.source.epoch||identity?.position!==item.catalog.order)conflict('Existing PC document conflicts: '+item.key);
     item.existing=current;
    }
   }
   for(const item of imported){
    const {key,source,catalog,payload,deleted}=item;
    if(!item.existing){
     next++;if(!Number.isSafeInteger(next))corrupt();
     const parsed=JSON.parse(payload);db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?)').run(key,1,deleted,payload,parsed?titleOf(parsed):'',new Date().toISOString(),Buffer.byteLength(payload));
     db.prepare('INSERT INTO identities VALUES (?,?,?,?)').run(key,source.epoch,catalog.order,JSON.stringify(source));
    }
   }
   db.prepare('UPDATE metadata SET sequence=? WHERE id=1').run(next);
   const receipt={epoch,migrationId:id,sourceId:manifest.sourceId,sha256:manifest.sha256,sequence:next,documents:imported.length,mediaLibraryIdentity:manifest.mediaLibraryIdentity};
   db.prepare("UPDATE migrations SET state='committed',receipt=? WHERE id=?").run(JSON.stringify(receipt),id);
   return status(id);
  });
 }
 function readChunk(id,index){
  const current=status(id);if(!current||current.state!=='committed')throw libraryError('migration_not_committed','Only committed recovery archives are downloadable',409);
  if(!integer(index)||index>=current.manifest.chunks)bad();
  const row=db.prepare('SELECT data FROM migration_chunks WHERE id=? AND position=?').get(id,index);if(!row)corrupt();
  return {protocolVersion:1,epoch,migrationId:id,index,data:row.data,sha256:hash(Buffer.from(row.data,'base64'))};
 }
 return {status,request,readChunk};
}
