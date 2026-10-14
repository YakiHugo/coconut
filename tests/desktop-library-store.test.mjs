import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLibraryStore,libraryRuntimeSupported,LIBRARY_DOCUMENT_BYTES} from '../desktop/library-store.mjs';
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-library-'));const stores=[];const open=async()=>{const store=await createLibraryStore({directory});stores.push(store);return store;};t.after(async()=>{stores.forEach(s=>s.close());await fs.rm(directory,{recursive:true,force:true});});return {directory,open,store:await open()};}
const document={key:'source:一',title:'Authored',segments:[{id:'one',text:'Original'}],notes:{one:'Note'},translations:{en:['Translation']},aiResults:[{receipt:'result-1'}],progress:{segment:'one'},unknown:{preserved:true}};
function put(store,overrides={}){return {protocolVersion:1,epoch:store.describe().epoch,key:document.key,receiptKey:'create',action:'put',expected:null,document,...overrides};}
const code=value=>error=>error.libraryCode===value;
test('runtime minimum is library-only and explicit',()=>{for(const v of ['20.20.0','22.0.0','22.12.0'])assert.equal(libraryRuntimeSupported(v),false);for(const v of ['22.13.0','22.22.0','24.0.0'])assert.equal(libraryRuntimeSupported(v),true);});
test('complete snapshots, identity and durable retry receipts survive restart',async t=>{
 const {store,open}=await fixture(t),request=put(store),receipt=store.commit(request),epoch=store.describe().epoch;
 assert.deepEqual(store.get(document.key).document,document);store.close();const reopened=await open();
 assert.equal(reopened.describe().epoch,epoch);assert.deepEqual(reopened.commit(request),receipt);assert.equal(reopened.describe().sequence,1);
 assert.deepEqual(reopened.get(document.key).document,document);
 assert.throws(()=>reopened.commit({...request,document:{...document,title:'Different'}}),code('receipt_conflict'));
});
test('two connections cannot overwrite stale revisions; failed transactions leave catalog and receipts intact',async t=>{
 const {store,open}=await fixture(t),other=await open(),first=store.commit(put(store));
 const update=put(other,{receiptKey:'edit',expected:first.token,document:{...document,notes:{one:'New note'}}});
 const second=other.commit(update);
 assert.throws(()=>store.commit(put(store,{receiptKey:'stale',expected:first.token})),code('revision_conflict'));
 assert.equal(store.describe().sequence,2);assert.equal(store.get(document.key).token.revision,2);
 assert.deepEqual(store.commit({...update,receiptKey:'stale',expected:second.token}).token,{epoch:second.token.epoch,revision:3});
});
test('recoverable delete preserves payload, rejects stale recreation and restores with a fresh revision',async t=>{
 const {store}=await fixture(t),created=store.commit(put(store));
 const command={protocolVersion:1,epoch:created.token.epoch,key:document.key,action:'delete',expected:created.token,receiptKey:'delete'};
 const removed=store.commit(command);assert.equal(store.get(document.key).deleted,true);assert.deepEqual(store.get(document.key).document,document);
 assert.throws(()=>store.commit(put(store,{receiptKey:'recreate'})),code('revision_conflict'));
 assert.throws(()=>store.commit(put(store,{receiptKey:'overwrite',expected:removed.token})),code('lifecycle_conflict'));
 const restored=store.commit({...command,action:'restore',expected:removed.token,receiptKey:'restore'});
 assert.equal(restored.token.revision,3);assert.equal(store.get(document.key).deleted,false);assert.deepEqual(store.commit(command),removed);
});
test('catalog pagination includes tombstones, excludes payloads and fences changed snapshots',async t=>{
 const {store}=await fixture(t);
 for(const key of ['a','b','c'])store.commit(put(store,{key,receiptKey:key,document:{...document,key}}));
 const page=store.list({limit:2});assert.deepEqual(page.entries.map(x=>x.key),['a','b']);assert.equal(page.next,'b');assert.ok(page.entries.every(x=>!('document'in x)));
 assert.deepEqual(store.list({limit:2,after:page.next,expectedSequence:page.sequence}).entries.map(x=>x.key),['c']);
 store.commit(put(store,{key:'d',receiptKey:'d',document:{...document,key:'d'}}));
 assert.throws(()=>store.list({after:page.next,expectedSequence:page.sequence}),code('catalog_changed'));
 for(const limit of [0,101,NaN,1.5])assert.throws(()=>store.list({limit}),code('invalid_request'));
});
test('wrong epochs, malformed documents and oversize input cannot change the store',async t=>{
 const {store}=await fixture(t);
 for(const changes of [{protocolVersion:2},{epoch:'wrong'},{expected:{}},{document:{key:'different'}},{key:'\u0000'},{receiptKey:''}])assert.throws(()=>store.commit(put(store,changes)),code('invalid_request'));
 assert.throws(()=>store.commit(put(store,{document:{...document,text:'x'.repeat(LIBRARY_DOCUMENT_BYTES)}})),code('document_too_large'));
 assert.equal(store.describe().sequence,0);assert.equal(store.get(document.key),null);
});
test('foreign and newer schemas are rejected without rewriting them',async t=>{
 const {directory,store}=await fixture(t);store.close();const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(directory,'library.sqlite'));db.exec('PRAGMA user_version=99');db.close();
 await assert.rejects(createLibraryStore({directory}),code('schema_unsupported'));const verify=new DatabaseSync(path.join(directory,'library.sqlite'));assert.equal(verify.prepare('PRAGMA user_version').get().user_version,99);verify.close();
});
test('SQLite write failure rolls back document, catalog sequence and receipt atomically',async t=>{
 const {directory,store}=await fixture(t);const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(directory,'library.sqlite'));
 t.after(()=>db.close());
 db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'authored disk-failure boundary'); END");
 const request=put(store);assert.throws(()=>store.commit(request),/authored disk-failure/);assert.equal(store.get(document.key),null);assert.equal(store.describe().sequence,0);
 db.exec('DROP TRIGGER fail_receipt');assert.equal(store.commit(request).token.revision,1);
});
test('non-JSON data is rejected rather than silently lost',async t=>{
 const {store}=await fixture(t);
 for(const value of [undefined,NaN,Infinity,()=>{},1n])assert.throws(()=>store.commit(put(store,{document:{...document,value}})),code('invalid_request'));
 assert.equal(store.describe().sequence,0);
});
test('database and sidecars stay private; unsafe existing directory is rejected unchanged',async t=>{
 if(process.platform==='win32')return;
 const {directory,store}=await fixture(t);store.commit(put(store));
 for(const file of [directory,path.join(directory,'library.sqlite'),path.join(directory,'library.sqlite-wal'),path.join(directory,'library.sqlite-shm')])assert.equal((await fs.stat(file)).mode&0o077,0,file);
 store.close();await fs.chmod(directory,0o755);await assert.rejects(createLibraryStore({directory}),code('unsafe_library_path'));assert.equal((await fs.stat(directory)).mode&0o777,0o755);
});
test('symlinked and hardlinked databases are rejected without changing their targets',async t=>{
 const {directory,store}=await fixture(t);store.close();const filename=path.join(directory,'library.sqlite'),outside=path.join(directory,'outside.sqlite');await fs.rename(filename,outside);
 const before=await fs.readFile(outside);await fs.symlink(outside,filename);await assert.rejects(createLibraryStore({directory}),code('unsafe_library_path'));assert.deepEqual(await fs.readFile(outside),before);
 await fs.unlink(filename);await fs.link(outside,filename);await assert.rejects(createLibraryStore({directory}),code('unsafe_library_path'));assert.deepEqual(await fs.readFile(outside),before);
});
test('corrupt and mismatched payloads are preserved on reopen and on a stale writer',async t=>{
 const {directory,store}=await fixture(t);const receipt=store.commit(put(store));const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(directory,'library.sqlite'));t.after(()=>db.close());
 for(const payload of ['{"truncated":',JSON.stringify({key:'different'})]){
  db.prepare('UPDATE documents SET payload=? WHERE key=?').run(payload,document.key);
  assert.throws(()=>store.get(document.key),code('library_corrupt'));
  assert.throws(()=>store.commit(put(store,{receiptKey:'replace-corrupt',expected:receipt.token})),code('library_corrupt'));
  await assert.rejects(createLibraryStore({directory}),code('library_corrupt'));
  assert.equal(db.prepare('SELECT payload FROM documents WHERE key=?').get(document.key).payload,payload);assert.equal(store.describe().sequence,1);
 }
});
test('replayed receipt is bound to the original requested key, action and next revision',async t=>{
 const {directory,store}=await fixture(t),input=put(store),receipt=store.commit(input);store.commit(put(store,{key:'b',receiptKey:'b-first',document:{key:'b'}}));
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(directory,'library.sqlite'));t.after(()=>db.close());
 for(const changed of [{...receipt,key:'b'},{...receipt,action:'delete',deleted:true}]){
  db.prepare('UPDATE receipts SET receipt=? WHERE key=?').run(JSON.stringify(changed),input.receiptKey);
  assert.throws(()=>store.commit(input),code('library_corrupt'));assert.equal(store.describe().sequence,2);
 }
});

test('schema two upgrade preserves records and receipts and namespace survives restart',async t=>{
 const {store,open,directory}=await fixture(t),request=put(store),receipt=store.commit(request),epoch=store.describe().epoch;store.close();
 const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(path.join(directory,'library.sqlite'));
 db.exec('DROP TABLE library_identity; PRAGMA user_version=2;');db.close();
 const upgraded=await open(),identity=upgraded.describe().binding.mediaLibraryIdentity;
 assert.notEqual(identity,epoch);assert.equal(upgraded.describe().epoch,epoch);assert.deepEqual(upgraded.get(document.key).document,document);assert.deepEqual(upgraded.commit(request),receipt);upgraded.close();
 const reopened=await open();assert.equal(reopened.describe().binding.mediaLibraryIdentity,identity);assert.deepEqual(reopened.get(document.key).document,document);
});
test('failed schema two upgrade rolls back identity allocation and user_version',async t=>{
 const {store,directory}=await fixture(t);store.commit(put(store));store.close();
 const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(path.join(directory,'library.sqlite'));
 db.exec('DROP TABLE library_identity; PRAGMA user_version=2; UPDATE identities SET lifetime=0;');db.close();
 await assert.rejects(createLibraryStore({directory}),code('library_corrupt'));
 const verify=new DatabaseSync(path.join(directory,'library.sqlite'));assert.equal(verify.prepare('PRAGMA user_version').get().user_version,2);assert.equal(verify.prepare("SELECT name FROM sqlite_master WHERE name='library_identity'").get(),undefined);verify.close();
});
test('corrupt media namespace never produces a discovery binding',async t=>{
 const {store,directory}=await fixture(t);store.commit(put(store));
 const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(path.join(directory,'library.sqlite'));db.prepare('UPDATE library_identity SET media=?').run('invalid');db.close();
 assert.throws(()=>store.describe(),code('library_corrupt'));
});
