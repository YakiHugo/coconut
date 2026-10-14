/** Opt-in canonical library. Browser data is never read, migrated or removed here. */
import {mkdir,lstat,open} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createMigrationStore,MIGRATION_BYTES,CHUNK_BYTES} from './library-migration.mjs';
export const LIBRARY_BODY_BYTES=16*1024*1024;
export const LIBRARY_DOCUMENT_BYTES=8*1024*1024;
export const LIBRARY_PAGE_BYTES=256*1024;
export const LIBRARY_MIN_NODE='22.13.0';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validKey=value=>typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=1024&&!/[\u0000-\u001f\ud800-\udfff]/u.test(value);
export const libraryError=(code,message,status=400)=>Object.assign(new Error(message),{libraryCode:code,status});
const invalid=()=>{throw libraryError('invalid_request','Invalid library request');};
const encode=value=>{try{return JSON.stringify(value,(_key,item)=>{if(item===undefined||typeof item==='function'||typeof item==='symbol'||typeof item==='bigint'||(typeof item==='number'&&!Number.isFinite(item)))invalid();return item;});}catch{invalid();}};
export function libraryRuntimeSupported(version=process.versions.node){const [major,minor]=version.split('.').map(Number);return major>22||(major===22&&minor>=13);}
export async function createLibraryStore({directory,exclusiveWriter=false}={}){
  if(!libraryRuntimeSupported())throw libraryError('runtime_unsupported',`Canonical library requires Node ${LIBRARY_MIN_NODE} or newer`,503);
  if(typeof directory!=='string'||!path.isAbsolute(directory))invalid();
  // Lazy import keeps the existing reader usable on older Node versions.
  let DatabaseSync;
  try{({DatabaseSync}=await import('node:sqlite'));}
  catch{throw libraryError('runtime_unsupported',`Canonical library requires a runtime with node:sqlite (Node ${LIBRARY_MIN_NODE} or newer)`,503);}
  await mkdir(directory,{recursive:true,mode:0o700});
  const privatePath=async(file,directory=false)=>{
    const stat=await lstat(file);
    if(stat.isSymbolicLink()||!(directory?stat.isDirectory():stat.isFile())||(!directory&&stat.nlink!==1)||
      (process.platform!=='win32'&&((stat.mode&0o077)!==0||(typeof process.getuid==='function'&&stat.uid!==process.getuid()))))
      throw libraryError('unsafe_library_path','Library storage must be a private, owned directory with private regular files; choose a new directory',503);
  };
  await privatePath(directory,true);
  const filename=path.join(directory,'library.sqlite');
  // Never let SQLite follow a pre-existing symlink or initialize an aliased file.
  // A private owner-only parent prevents other users racing these checks.
  try{const file=await open(filename,'wx',0o600);await file.close();}catch(error){if(error.code!=='EEXIST')throw error;}
  await privatePath(filename);
  for(const suffix of ['-wal','-shm','-journal']){
    try{await privatePath(filename+suffix);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const db=new DatabaseSync(filename);
  let closed=false,transactionDepth=0;
  const transaction=body=>{
    if(closed)throw libraryError('library_closed','Library is closed',503);
    if(transactionDepth)return body();
    db.exec('BEGIN IMMEDIATE');transactionDepth++;
    try{const result=body();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}finally{transactionDepth--;}
  };
  let epoch;
  const corrupt=()=>{throw libraryError('library_corrupt','Library records failed integrity checks; preserve the directory for recovery',503);};
  const titleOf=document=>typeof document.title==='string'?document.title.slice(0,512).toWellFormed():'';
  function validateRow(row,sequence){
    let document;try{document=JSON.parse(row.payload);}catch{corrupt();}
    if(!validKey(row.key)||!Number.isSafeInteger(row.revision)||row.revision<1||row.revision>sequence||
      ![0,1].includes(row.deleted)||!(document===null&&row.deleted===1)&&(!plain(document)||document.key!==row.key)||
      row.bytes!==Buffer.byteLength(row.payload)||row.bytes>LIBRARY_DOCUMENT_BYTES||row.title!==(document?titleOf(document):'')||
      typeof row.updated!=='string'||!Number.isFinite(Date.parse(row.updated)))corrupt();
    return document;
  }
  function metadata(){
    const value=db.prepare('SELECT epoch,sequence FROM metadata WHERE id=1').get();
    if(!value||typeof value.epoch!=='string'||! /^[a-f0-9-]{36}$/.test(value.epoch)||
      !Number.isSafeInteger(value.sequence)||value.sequence<0||(epoch&&value.epoch!==epoch))corrupt();
    return value;
  }
  function validateReceipt(row,sequence){
    let receipt;try{receipt=JSON.parse(row.receipt);}catch{corrupt();}
    if(!validKey(row.key)||! /^[a-f0-9]{64}$/.test(row.digest)||!plain(receipt)||receipt.protocolVersion!==1||
      receipt.receiptKey!==row.key||!validKey(receipt.key)||!['put','delete','restore'].includes(receipt.action)||
      receipt.token?.epoch!==epoch||!Number.isSafeInteger(receipt.token.revision)||receipt.token.revision<1||
      !Number.isSafeInteger(receipt.sequence)||receipt.sequence<receipt.token.revision||receipt.sequence>sequence||
      receipt.deleted!==(receipt.action==='delete')||receipt.identity&&(!Number.isSafeInteger(receipt.identity.lifetime)||receipt.identity.lifetime<1||!Number.isSafeInteger(receipt.identity.position)||receipt.identity.position<0))corrupt();
    const document=db.prepare('SELECT revision FROM documents WHERE key=?').get(receipt.key);
    if(!document||document.revision<receipt.token.revision)corrupt();
    return receipt;
  }
  try{
    db.exec('PRAGMA busy_timeout=3000');
    // Service instances retain a SQLite OS lock until close/crash; no stale PID files.
    if(exclusiveWriter)db.exec('PRAGMA locking_mode=EXCLUSIVE');
    // Reject future/foreign schemas before modifying their contents.
    const version=db.prepare('PRAGMA user_version').get().user_version;
    if(![0,1,2].includes(version))throw libraryError('schema_unsupported','Unsupported library schema',503);
    transaction(()=>{
      if(version===0){
        if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get())throw libraryError('schema_unsupported','Refusing to initialize an existing foreign database',503);
        db.exec(`CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL, sequence INTEGER NOT NULL) STRICT;
          CREATE TABLE documents (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), payload TEXT NOT NULL, title TEXT NOT NULL, updated TEXT NOT NULL, bytes INTEGER NOT NULL) STRICT;
          CREATE TABLE receipts (key TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt TEXT NOT NULL) STRICT;
          PRAGMA user_version=1;`);
        db.prepare('INSERT INTO metadata VALUES (1,?,0)').run(randomUUID());
      }
      epoch=metadata().epoch;
      if(!epoch)throw libraryError('schema_unsupported','Missing library identity',503);
      db.prepare('SELECT key,revision,deleted,payload,title,updated,bytes FROM documents LIMIT 0').all();
      db.prepare('SELECT key,digest,receipt FROM receipts LIMIT 0').all();
      const sequence=metadata().sequence;
      for(const row of db.prepare('SELECT * FROM documents').iterate())validateRow(row,sequence);
      for(const row of db.prepare('SELECT * FROM receipts').iterate())validateReceipt(row,sequence);
      if(version<2){
        db.exec(`CREATE TABLE identities (key TEXT PRIMARY KEY, lifetime INTEGER NOT NULL, position INTEGER NOT NULL, source TEXT) STRICT;
          CREATE TABLE migrations (id TEXT PRIMARY KEY, manifest TEXT, state TEXT NOT NULL CHECK(state IN ('staging','cancelled','committed')), receipt TEXT) STRICT;
          CREATE TABLE migration_chunks (id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,position)) STRICT;
          INSERT INTO identities SELECT key,1,revision,NULL FROM documents;
          PRAGMA user_version=2;`);
      }
      for(const row of db.prepare('SELECT d.key,i.lifetime,i.position FROM documents d LEFT JOIN identities i ON d.key=i.key').iterate())if(!Number.isSafeInteger(row.lifetime)||row.lifetime<1||!Number.isSafeInteger(row.position)||row.position<0)corrupt();
    });
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  }catch(error){db.close();if(exclusiveWriter&&error.errcode===5)throw libraryError('library_in_use','Library is already open in another service',503);throw error;}
  const ensure=()=>{if(closed)throw libraryError('library_closed','Library is closed',503);};
  const meta=row=>({sha256:createHash('sha256').update(row.payload).digest('hex'),identity:db.prepare('SELECT lifetime,position FROM identities WHERE key=?').get(row.key),key:row.key,token:{epoch,revision:row.revision},deleted:!!row.deleted,title:row.title,updatedAt:row.updated,bytes:row.bytes});
  const describe=()=>{ensure();return {protocolVersion:1,enabled:true,backend:'sqlite',epoch,sequence:metadata().sequence,browserMigration:db.prepare("SELECT id FROM migrations WHERE state='committed' LIMIT 1").get()?'committed':'not_started',migration:{protocolVersion:1,maxBytes:MIGRATION_BYTES,chunkBytes:CHUNK_BYTES,maxNodes:2000000},batchProtocolVersion:2,limits:{documentBytes:LIBRARY_DOCUMENT_BYTES,requestBytes:LIBRARY_BODY_BYTES,pageBytes:LIBRARY_PAGE_BYTES,pageSize:100},minimumNode:LIBRARY_MIN_NODE};};
  const get=key=>{ensure();if(!validKey(key))invalid();const row=db.prepare('SELECT * FROM documents WHERE key=?').get(key);return row?{...meta(row),document:validateRow(row,metadata().sequence)}:null;};
  function list({limit=50,after='',expectedSequence}={}){
    ensure();if(!Number.isInteger(limit)||limit<1||limit>100||(after!==''&&!validKey(after)))invalid();
    // Single synchronous read transaction gives catalog rows and sequence one snapshot.
    return transaction(()=>{
      const sequence=describe().sequence;
      if(expectedSequence!==undefined&&expectedSequence!==sequence)throw libraryError('catalog_changed','Catalog changed; restart pagination',409);
      const rows=[];
      for(const row of db.prepare('SELECT * FROM documents WHERE key>? ORDER BY key LIMIT ?').iterate(after,limit+1)){validateRow(row,sequence);rows.push(meta(row));}
      const entries=[];let bytes=0;
      for(const row of rows.slice(0,limit)){const item=row,size=Buffer.byteLength(JSON.stringify(item));if(bytes+size>LIBRARY_PAGE_BYTES)break;entries.push(item);bytes+=size;}
      return {epoch,sequence,entries,next:rows.length>entries.length?entries.at(-1).key:null};
    });
  }
  function commit(input,{allowRestoreDocument=false,allowEmptyDelete=false}={}){
    ensure();
    if(!plain(input)||input.protocolVersion!==1||input.epoch!==epoch||!validKey(input.key)||!validKey(input.receiptKey)||!['put','delete','restore'].includes(input.action)||!Object.hasOwn(input,'expected'))invalid();
    if(input.expected!==null&&(!plain(input.expected)||input.expected.epoch!==epoch||!Number.isSafeInteger(input.expected.revision)||input.expected.revision<1))invalid();
    let payload;
    if(input.action==='put'||input.action==='restore'&&allowRestoreDocument){
      if(!plain(input.document)||input.document.key!==input.key)invalid();
      payload=encode(input.document);
      if(Buffer.byteLength(payload)>LIBRARY_DOCUMENT_BYTES)throw libraryError('document_too_large','Document exceeds library byte budget',413);
    }else if(Object.hasOwn(input,'document'))invalid();
    const raw=encode(input);
    if(Buffer.byteLength(raw)>LIBRARY_BODY_BYTES)throw libraryError('request_too_large','Request exceeds library byte budget',413);
    const digest=createHash('sha256').update(raw).digest('hex');
    return transaction(()=>{
      const prior=db.prepare('SELECT * FROM receipts WHERE key=?').get(input.receiptKey);
      if(prior){const sequence=metadata().sequence,receipt=validateReceipt(prior,sequence);validateRow(db.prepare('SELECT * FROM documents WHERE key=?').get(receipt.key),sequence);if(prior.digest!==digest)throw libraryError('receipt_conflict','Receipt key already belongs to another request',409);if(receipt.key!==input.key||receipt.action!==input.action||receipt.token.revision!==(input.expected?.revision||0)+1)corrupt();return receipt;}
      const current=db.prepare('SELECT * FROM documents WHERE key=?').get(input.key);
      if(current)validateRow(current,metadata().sequence);
      if(current?input.expected?.revision!==current.revision:input.expected!==null)throw libraryError('revision_conflict','Document changed; reload before saving',409);
      if((input.action==='put'&&current?.deleted)||(input.action==='delete'&&(!current&&!allowEmptyDelete||current?.deleted))||(input.action==='restore'&&(!current||!current.deleted)))throw libraryError('lifecycle_conflict','Document lifecycle changed',409);
      const sequence=describe().sequence+1;
      if(!Number.isSafeInteger(sequence)||!Number.isSafeInteger((current?.revision||0)+1))throw libraryError('revision_exhausted','Library revision exhausted',503);
      const revision=(current?.revision||0)+1,deleted=input.action==='delete'?1:0;
      payload??=current?.payload||'null';
      if(input.action==='restore'&&payload==='null')throw libraryError('missing_restore_payload','Restore requires a complete document',409);
      const parsed=JSON.parse(payload),title=parsed?titleOf(parsed):'',updated=new Date().toISOString(),bytes=Buffer.byteLength(payload);
      db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,payload=excluded.payload,title=excluded.title,updated=excluded.updated,bytes=excluded.bytes').run(input.key,revision,deleted,payload,title,updated,bytes);
      const identity=current?db.prepare('SELECT lifetime,position FROM identities WHERE key=?').get(input.key):{lifetime:1,position:Math.max(sequence,Number(db.prepare('SELECT max(position) AS position FROM identities').get().position??-1)+1)};
      if(!identity||!Number.isSafeInteger(identity.position))corrupt();
      if(input.action==='restore')identity.lifetime++;
      if(!Number.isSafeInteger(identity.lifetime))corrupt();
      db.prepare('INSERT INTO identities VALUES (?,?,?,NULL) ON CONFLICT(key) DO UPDATE SET lifetime=excluded.lifetime').run(input.key,identity.lifetime,identity.position);
      db.prepare('UPDATE metadata SET sequence=? WHERE id=1').run(sequence);
      const receipt={protocolVersion:1,receiptKey:input.receiptKey,action:input.action,key:input.key,token:{epoch,revision},deleted:!!deleted,sequence,identity:{lifetime:identity.lifetime,position:identity.position}};
      db.prepare('INSERT INTO receipts VALUES (?,?,?)').run(input.receiptKey,digest,JSON.stringify(receipt));
      return receipt;
    });
  }
  const migration=createMigrationStore({db,transaction,epoch,metadata,validateRow,validKey,titleOf,corrupt});
  function commitBatch(input){
    if(!plain(input)||input.protocolVersion!==2||input.epoch!==epoch||!Array.isArray(input.commands)||input.commands.length<1||input.commands.length>100||Buffer.byteLength(encode(input))>LIBRARY_BODY_BYTES)invalid();
    const keys=new Set();for(const command of input.commands){if(!plain(command)||keys.has(command.key)||!Object.hasOwn(command,'expectedIdentity')||command.expected===null&&command.expectedIdentity!==null||command.expected!==null&&(!plain(command.expectedIdentity)||!Number.isSafeInteger(command.expectedIdentity.lifetime)||command.expectedIdentity.lifetime<1||!Number.isSafeInteger(command.expectedIdentity.position)||command.expectedIdentity.position<0))invalid();keys.add(command.key);}
    return transaction(()=>({protocolVersion:2,epoch,receipts:input.commands.map(command=>{
      const receipt=commit({...command,protocolVersion:1,epoch},{allowRestoreDocument:command.action==='restore',allowEmptyDelete:true});
      if(!receipt.identity)throw libraryError('receipt_legacy','Legacy receipt needs explicit reload',409);
      if(receipt.identity.lifetime!==(command.expectedIdentity?command.expectedIdentity.lifetime+(command.action==='restore'?1:0):1)||command.expectedIdentity&&receipt.identity.position!==command.expectedIdentity.position)throw libraryError('identity_conflict','Document lifetime changed',409);return receipt;
    })}));
  }
  return {describe,get,list,commit,commitBatch,migration,close(){if(!closed){db.close();closed=true;}}};
}
