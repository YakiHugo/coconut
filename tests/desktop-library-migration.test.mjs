import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {createLibraryStore} from '../desktop/library-store.mjs';import {CHUNK_BYTES,MIGRATION_BYTES} from '../desktop/library-migration.mjs';import {recoveryFixture,sourceId,mediaLibraryIdentity,migrationId} from './fixtures/canonical-migration.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function setup(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-migration-')),stores=[];const open=async()=>{const s=await createLibraryStore({directory});stores.push(s);return s;};t.after(async()=>{stores.forEach(s=>s.close());await fs.rm(directory,{recursive:true,force:true});});return {store:await open(),open,directory};}
function plan(store,recovery=recoveryFixture(),id=migrationId){const mediaLibraryIdentity=store.describe().binding.mediaLibraryIdentity;recovery.stores.meta.find(row=>row.key==='desktop-media-library').value=mediaLibraryIdentity;const bytes=Buffer.from(JSON.stringify(recovery)),base={protocolVersion:1,epoch:store.describe().epoch,migrationId:id},manifest={sourceId,mediaLibraryIdentity,bytes:bytes.length,chunks:Math.ceil(bytes.length/CHUNK_BYTES),sha256:hash(bytes)};return {base,bytes,manifest,begin:{...base,action:'begin',manifest},chunks:Array.from({length:manifest.chunks},(_,index)=>({...base,action:'chunk',index,data:bytes.subarray(index*CHUNK_BYTES,(index+1)*CHUNK_BYTES).toString('base64')})),finalize:{...base,action:'finalize'},cancel:{...base,action:'cancel'}};}
function stage(store,p){store.migration.request(p.begin);for(const chunk of p.chunks)store.migration.request(chunk);}
test('staging is invisible; restart resumes exact chunks and atomically adopts complete identities and tombstones',async t=>{
 const {store,open}=await setup(t),p=plan(store);stage(store,p);assert.equal(store.list().entries.length,0);store.close();const next=await open();
 stage(next,p);const result=next.migration.request(p.finalize);assert.equal(result.state,'committed');assert.equal(result.receipt.sha256,p.manifest.sha256);
 assert.deepEqual(next.get('live').document,recoveryFixture().stores.documents[0].value.payload);assert.equal(next.get('live').identity.lifetime,2);assert.equal(next.get('live').identity.position,1);
 assert.equal(next.get('removed').deleted,true);assert.equal(next.get('removed').document,null);assert.deepEqual(next.migration.request(p.finalize),result);assert.equal(next.describe().sequence,2);
 next.close();const final=await open();assert.deepEqual(final.migration.status(migrationId),result);assert.deepEqual(final.get('live').document,recoveryFixture().stores.documents[0].value.payload);
});
test('cancel before begin and after staging blocks delayed finalize, but cannot cancel committed adoption',async t=>{
 const {store}=await setup(t),p=plan(store);assert.equal(store.migration.request(p.cancel).state,'cancelled');assert.throws(()=>store.migration.request(p.begin),e=>e.libraryCode==='migration_conflict');
 const p2=plan(store,recoveryFixture(),'44444444-4444-4444-8444-444444444444');stage(store,p2);assert.equal(store.migration.request(p2.cancel).state,'cancelled');assert.throws(()=>store.migration.request(p2.finalize),e=>e.libraryCode==='migration_conflict');assert.equal(store.describe().sequence,0);
 const p3=plan(store,recoveryFixture(),'55555555-5555-4555-8555-555555555555');stage(store,p3);store.migration.request(p3.finalize);assert.equal(store.migration.request(p3.cancel).state,'committed');
});
test('changed same-ID content and missing chunks reject without partial catalog changes',async t=>{
 const {store}=await setup(t),p=plan(store);store.commit({protocolVersion:1,epoch:store.describe().epoch,receiptKey:'existing',action:'put',key:'live',expected:null,document:{key:'live',title:'Existing PC version'}});
 store.migration.request(p.begin);assert.throws(()=>store.migration.request(p.finalize),e=>e.libraryCode==='migration_invalid');stage(store,p);assert.throws(()=>store.migration.request(p.finalize),e=>e.libraryCode==='migration_conflict');
 assert.equal(store.get('live').document.title,'Existing PC version');assert.equal(store.get('removed'),null);assert.equal(store.describe().sequence,1);
});
test('digest, changed chunks, invalid identity and budget violations never publish',async t=>{
 const {store}=await setup(t),p=plan(store);store.migration.request(p.begin);const changed={...p.chunks[0],data:Buffer.alloc(p.bytes.length,65).toString('base64')};store.migration.request(changed);
 assert.throws(()=>store.migration.request(p.chunks[0]),e=>e.libraryCode==='migration_conflict');assert.throws(()=>store.migration.request(p.finalize),e=>e.libraryCode==='migration_invalid');assert.equal(store.describe().sequence,0);
 store.migration.request(p.cancel);const bad=plan(store,recoveryFixture(),'44444444-4444-4444-8444-444444444444');bad.begin.manifest.bytes=MIGRATION_BYTES+1;assert.throws(()=>store.migration.request(bad.begin),e=>e.libraryCode==='migration_invalid');
});
test('batch writes preserve logical lifetime, atomic groups, retry receipts and restore complete tombstones',async t=>{
 const {store}=await setup(t),p=plan(store);stage(store,p);store.migration.request(p.finalize);const live=store.get('live'),removed=store.get('removed');
 const body={protocolVersion:2,epoch:store.describe().epoch,commands:[{action:'put',key:'live',expected:live.token,expectedIdentity:live.identity,receiptKey:'edit',document:{...live.document,notes:{cue:'Edited'}}},{action:'restore',key:'removed',expected:removed.token,expectedIdentity:removed.identity,receiptKey:'undo',document:{key:'removed',title:'Recovered by explicit Undo'}}]};
 const saved=store.commitBatch(body);assert.equal(saved.receipts[0].identity.lifetime,2);assert.equal(saved.receipts[1].identity.lifetime,2);assert.deepEqual(store.commitBatch(body),saved);
 const broken={...body,commands:[{...body.commands[0],receiptKey:'next',expected:saved.receipts[0].token},{...body.commands[1],receiptKey:'stale'}]};assert.throws(()=>store.commitBatch(broken));assert.equal(store.get('live').token.revision,2);
});
test('archive downloads reconstruct exact original bytes and cancel cannot erase committed recovery',async t=>{
 const {store}=await setup(t),recovery=recoveryFixture();recovery.stores.legacySnapshots[0].value.raw='x'.repeat(CHUNK_BYTES+5);const p=plan(store,recovery);stage(store,p);
 assert.throws(()=>store.migration.readChunk(migrationId,0),e=>e.libraryCode==='migration_not_committed');store.migration.request(p.finalize);store.migration.request(p.cancel);
 const archive=Buffer.concat(p.chunks.map((_,index)=>{const chunk=store.migration.readChunk(migrationId,index);const bytes=Buffer.from(chunk.data,'base64');assert.equal(hash(bytes),chunk.sha256);return bytes;}));assert.deepEqual(archive,p.bytes);assert.equal(hash(archive),p.manifest.sha256);
});
test('SQLite finalize failure rolls back every imported row and allows exact retry',async t=>{
 const {store,directory}=await setup(t),p=plan(store);stage(store,p);const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(directory,'library.sqlite'));t.after(()=>db.close());
 db.exec("CREATE TRIGGER fail_finalization BEFORE UPDATE ON migrations WHEN NEW.state='committed' BEGIN SELECT RAISE(ABORT,'authored finalize failure'); END");assert.throws(()=>store.migration.request(p.finalize),/authored finalize failure/);
 assert.equal(store.get('live'),null);assert.equal(store.get('removed'),null);assert.equal(store.describe().sequence,0);assert.equal(store.migration.status(migrationId).state,'staging');
 db.exec('DROP TRIGGER fail_finalization');assert.equal(store.migration.request(p.finalize).state,'committed');
});
test('logical identity mismatch rejects entire batch and unsaved removal creates a durable tombstone',async t=>{
 const {store}=await setup(t),epoch=store.describe().epoch;
 const remove={protocolVersion:2,epoch,commands:[{action:'delete',key:'never-saved',expected:null,expectedIdentity:null,receiptKey:'remove-new'}]};const result=store.commitBatch(remove);assert.equal(result.receipts[0].token.revision,1);assert.equal(store.get('never-saved').document,null);assert.deepEqual(store.commitBatch(remove),result);
 const restore={protocolVersion:2,epoch,commands:[{action:'restore',key:'never-saved',expected:result.receipts[0].token,expectedIdentity:{lifetime:99,position:1},receiptKey:'bad-identity',document:{key:'never-saved'}}]};assert.throws(()=>store.commitBatch(restore),e=>e.libraryCode==='identity_conflict');assert.equal(store.get('never-saved').deleted,true);assert.equal(store.describe().sequence,1);
});
test('schema one upgrade preserves existing payload, epoch and receipts without reinitialization',async t=>{
 const {store,directory}=await setup(t);store.close();const file=path.join(directory,'library.sqlite');await fs.rm(file);const handle=await fs.open(file,'wx',0o600);await handle.close();const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(file);
 db.exec(`CREATE TABLE metadata (id INTEGER PRIMARY KEY,epoch TEXT,sequence INTEGER);CREATE TABLE documents (key TEXT PRIMARY KEY,revision INTEGER,deleted INTEGER,payload TEXT,title TEXT,updated TEXT,bytes INTEGER);CREATE TABLE receipts (key TEXT PRIMARY KEY,digest TEXT,receipt TEXT);PRAGMA user_version=1;`);
 const payload=JSON.stringify({key:'previous',title:'Previous source'});db.prepare('INSERT INTO metadata VALUES (1,?,1)').run(sourceId);db.prepare('INSERT INTO documents VALUES (?,1,0,?,?,?,?)').run('previous',payload,'Previous source',new Date().toISOString(),Buffer.byteLength(payload));db.close();
 const upgraded=await createLibraryStore({directory});t.after(()=>upgraded.close());assert.equal(upgraded.describe().epoch,sourceId);assert.deepEqual(upgraded.get('previous').document,JSON.parse(payload));assert.equal(upgraded.get('previous').identity.lifetime,1);assert.equal(upgraded.describe().sequence,1);
});
test('non-finite and negative-zero recovery numbers are rejected without canonical writes',async t=>{
 const {store}=await setup(t);
 for(const [index,number] of ['1e999','-0'].entries()){
  const recovery=recoveryFixture();recovery.extra='NUMBER';const raw=JSON.stringify(recovery).replace('"NUMBER"',number),bytes=Buffer.from(raw),id=index?'44444444-4444-4444-8444-444444444444':migrationId;
  const p=plan(store,recovery,id);p.begin.manifest={...p.manifest,bytes:bytes.length,sha256:hash(bytes)};p.chunks=[{...p.base,action:'chunk',index:0,data:bytes.toString('base64')}];stage(store,p);
  assert.throws(()=>store.migration.request(p.finalize),e=>e.libraryCode==='migration_invalid');assert.equal(store.describe().sequence,0);store.migration.request(p.cancel);
 }
});

test('literal unsafe integer archive bytes are rejected before rounded payloads can be imported',async t=>{
 const {store}=await setup(t);
 for(const [index,literal] of ['9007199254740993','-9007199254740993'].entries()){
  const recovery=recoveryFixture();recovery.stores.documents[0].value.payload.custom.integer='RAW_INTEGER';
  const raw=JSON.stringify(recovery).replace('"RAW_INTEGER"',literal),bytes=Buffer.from(raw),id=index?'44444444-4444-4444-8444-444444444444':migrationId;
  const p=plan(store,recovery,id);p.begin.manifest={...p.manifest,bytes:bytes.length,sha256:hash(bytes)};p.chunks=[{...p.base,action:'chunk',index:0,data:bytes.toString('base64')}];stage(store,p);
  assert.throws(()=>store.migration.request(p.finalize),e=>e.libraryCode==='migration_invalid');
  assert.equal(store.get('live'),null);assert.equal(store.get('removed'),null);assert.equal(store.describe().sequence,0);assert.equal(store.migration.status(id).state,'staging');store.migration.request(p.cancel);
 }
});

test('discovery exposes verified migration media namespace across restart and rejects altered manifest',async t=>{
 const {store,open,directory}=await setup(t),p=plan(store);stage(store,p);const committed=store.migration.request(p.finalize);
 assert.equal(store.describe().binding.mediaLibraryIdentity,p.manifest.mediaLibraryIdentity);store.close();
 const reopened=await open();assert.equal(reopened.describe().binding.mediaLibraryIdentity,p.manifest.mediaLibraryIdentity);assert.deepEqual(reopened.migration.status(migrationId).receipt,committed.receipt);
 const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(path.join(directory,'library.sqlite'));
 db.prepare('UPDATE migrations SET manifest=? WHERE id=?').run(JSON.stringify({...p.manifest,mediaLibraryIdentity:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}),migrationId);db.close();
 assert.throws(()=>reopened.describe(),error=>error.libraryCode==='library_corrupt');
 assert.deepEqual(reopened.get('live').document,recoveryFixture().stores.documents[0].value.payload);
});

test('first migration namespace and documents roll back together if receipt commit fails',async t=>{
 const {store,directory}=await setup(t),p=plan(store);stage(store,p);
 const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(path.join(directory,'library.sqlite'));
 const original=db.prepare('SELECT media FROM library_identity WHERE id=1').get().media;
 db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE OF state ON migrations WHEN NEW.state='committed' BEGIN SELECT RAISE(ABORT,'authored receipt failure'); END;");
 assert.throws(()=>store.migration.request(p.finalize));assert.equal(store.describe().sequence,0);assert.equal(store.describe().binding.mediaLibraryIdentity,original);assert.equal(store.list().entries.length,0);assert.equal(store.migration.status(migrationId).state,'staging');assert.equal(db.prepare('SELECT media FROM library_identity WHERE id=1').get().media,original);
 db.exec('DROP TRIGGER fail_receipt');db.close();assert.equal(store.migration.request(p.finalize).state,'committed');assert.equal(store.describe().binding.mediaLibraryIdentity,p.manifest.mediaLibraryIdentity);
});

test('even direct historical recovery cannot replace a published empty library namespace',async t=>{
 const {store}=await setup(t),before=store.describe(),p=plan(store);const recovery=JSON.parse(p.bytes);recovery.stores.meta.find(row=>row.key==='desktop-media-library').value=mediaLibraryIdentity;
 const bytes=Buffer.from(JSON.stringify(recovery)),manifest={...p.manifest,mediaLibraryIdentity,bytes:bytes.length,chunks:1,sha256:hash(bytes)};
 store.migration.request({...p.begin,manifest});store.migration.request({...p.base,action:'chunk',index:0,data:bytes.toString('base64')});assert.throws(()=>store.migration.request(p.finalize),e=>e.libraryCode==='migration_conflict');assert.equal(store.describe().sequence,0);assert.deepEqual(store.describe().binding,before.binding);assert.equal(store.list().entries.length,0);
});
