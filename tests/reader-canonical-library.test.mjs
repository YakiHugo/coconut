// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import fs from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

import {createRequire} from 'node:module';

import {createLibraryStore} from '../desktop/library-store.mjs';

import {transactionDouble} from './helpers/indexeddb-transaction-double.mjs';

const require=createRequire(import.meta.url);

const idb=require('../reader/indexeddb-document-adapter.js');

const canonical=require('../reader/canonical-library.js');

const provider=require('../reader/storage-provider.js');

const legacyModule=require('../reader/library-store.js');

const doc=(key='a')=>({key,title:'Authored '+key,segments:[{id:'cue',start:0,end:1,text:'Authored text'}],notes:{cue:'kept'},unknown:{history:['retained']}});

async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-client-')),server=await createLibraryStore({directory});t.after(async()=>{server.close();await fs.rm(directory,{recursive:true,force:true});});
 const engine=transactionDouble(),values=new Map([[idb.LEGACY_KEY,JSON.stringify({documents:[doc()]})]]),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},options={indexedDB:engine.indexedDB,getLegacyStorage:()=>storage,name:'client'};
 const primitive=idb.create(options);assert.equal((await primitive.ready()).ok,true);const control={};const calls=[];
 const fetch=async(url,options={})=>{
  const parsed=new URL(url,'http://localhost'),body=options.body&&JSON.parse(options.body);calls.push({url,body,raw:options.body});
  if(control.before)await control.before(body,parsed);
  let value,status=200;
  try{if(parsed.pathname.endsWith('/migration')){value=body?server.migration.request(body):server.migration.status(parsed.searchParams.get('migrationId'));if(!value){status=404;value={state:'absent',epoch:server.describe().epoch};}}
   else if(parsed.pathname.endsWith('/batch'))value=server.commitBatch(body);
   else if(parsed.pathname.endsWith('/catalog'))value=server.list({limit:100,after:parsed.searchParams.get('after')||'',expectedSequence:parsed.searchParams.has('sequence')?Number(parsed.searchParams.get('sequence')):undefined});
   else if(parsed.pathname.endsWith('/document'))value={record:server.get(parsed.searchParams.get('key'))};else value=server.describe();
  }catch(e){status=e.status||503;value={code:e.libraryCode,error:e.message};}
  if(control.after)await control.after(body,value);
  return {ok:status<400,status,json:async()=>structuredClone(value)};
 };
 const client=canonical.create({primitive,fetch});return {server,engine,primitive,client,control,calls,storage,options,fetch};
}

test('explicit complete transfer preserves raw rows, identity, tombstones and uses canonical writes',async t=>{
 const f=await fixture(t);await f.primitive.commit(f.primitive.prepare([{kind:'remove',key:'gone',expected:null,generation:1,mutationId:'gone'}]));
 assert.equal((await f.client.begin()).state,'canonical');const marker=(await f.primitive.canonicalStatus()).value;
 assert.equal(f.server.get('a').identity.lifetime,1);assert.equal(f.server.get('gone').deleted,true);assert.equal(f.server.get('gone').document,null);
 assert.equal(f.engine.rows('client').get('meta').get('state').status,'canonical-frozen');assert.deepEqual(f.engine.rows('client').get('documents').get('a').payload,doc());
 const loaded=await f.client.initialize(marker);assert.deepEqual(loaded.loaded.documents,[doc()]);assert.equal(loaded.adapter.documentEpoch('a'),1);assert.equal((await loaded.adapter.mediaLibraryIdentity()).identity,marker.mediaLibraryIdentity);
 const updated={...doc(),notes:{cue:'New'}};const capture=loaded.adapter.prepareChanges([{key:'a',identity:updated,kind:'update',generation:4}]);updated.notes.cue='Later';
 const saved=await loaded.adapter.write(capture);assert.equal(saved.ok,true);assert.equal(saved.receipts[0].generation,4);assert.equal(f.server.get('a').document.notes.cue,'New');assert.equal(f.engine.rows('client').get('documents').get('a').payload.notes.cue,'kept');
});

test('freeze fences old tabs; lost finalize response resumes after restart without a second writer',async t=>{
 const f=await fixture(t),old=idb.create(f.options);await old.ready();let once=true;
 f.control.after=(body)=>{if(body?.action==='finalize'&&once){once=false;throw Error('lost acknowledgement');}};
 await assert.rejects(f.client.begin(),/lost acknowledgement/);assert.equal(f.server.get('a').document.key,'a');
 const attempt=await old.commit(old.prepare([{kind:'update',key:'a',expected:{epoch:1,revision:1},document:doc(),generation:2,mutationId:'late'}]));assert.equal(attempt.ok,false);
 const restarted=canonical.create({primitive:idb.create(f.options),fetch:f.fetch});assert.equal((await restarted.resume()).state,'canonical');assert.equal(f.server.describe().sequence,1);
});

test('unknown cancel outcome stays frozen; confirmed cancel restores exact ready state and delayed begin is rejected',async t=>{
 const f=await fixture(t);f.control.before=body=>{if(body?.action==='chunk')throw Error('offline');};await assert.rejects(f.client.begin(),/offline/);const m=await f.client.marker();
 f.control.before=()=>{throw Error('offline');};await assert.rejects(f.client.cancel(),/offline/);assert.equal(f.engine.rows('client').get('meta').get('state').status,'canonical-frozen');
 f.control.before=null;assert.equal((await f.client.cancel()).state,'cancelled');assert.equal(f.engine.rows('client').get('meta').get('state').status,'ready');assert.equal(await f.client.marker(),undefined);
 assert.throws(()=>f.server.migration.request({protocolVersion:1,epoch:m.epoch,migrationId:m.migrationId,action:'begin',manifest:{}}));assert.equal((await idb.create(f.options).ready()).ok,true);
});

test('cancel after commit adopts instead of rollback; offline and different server block canonical initialization',async t=>{
 const f=await fixture(t);f.control.after=body=>{if(body?.action==='finalize')throw Error('lost');};await assert.rejects(f.client.begin());f.control.after=null;
 assert.equal((await f.client.cancel()).state,'canonical');const m=await f.client.marker();f.control.before=()=>{throw Error('offline');};await assert.rejects(f.client.initialize(m),/offline/);f.control.before=null;
 f.control.after=(body,value)=>{if(value.epoch)value.epoch='other';};await assert.rejects(f.client.initialize(m),e=>e.code==='epoch_conflict');assert.equal(f.engine.rows('client').get('meta').get('state').status,'canonical-frozen');
});

test('snapshot race aborts freeze with no marker or server staging',async t=>{
 const f=await fixture(t),source=await f.primitive.canonicalSource();const text=canonical.json(source);
 await f.primitive.commit(f.primitive.prepare([{kind:'update',key:'a',expected:{epoch:1,revision:1},document:{...doc(),title:'Changed'},generation:1,mutationId:'race'}]));
 const result=await f.primitive.freezeCanonical({text});assert.equal(result.ok,false);assert.equal(result.error.code,'conflict');assert.equal((await f.primitive.canonicalStatus()).value,undefined);assert.equal(f.engine.rows('client').get('meta').get('state').status,'ready');
});

test('lossless preflight rejects structured clone values, sparse arrays, accessors and unsafe numbers',()=>{
 for(const value of [undefined,NaN,-0,Infinity,2**53,new Date(),new Map(),{x:undefined},[,,],Object.defineProperty({},'length',{value:2}),Object.defineProperty({},'x',{enumerable:true,get(){return 1;}}),{[Symbol('hidden')]:1}])assert.throws(()=>canonical.json(value));
 assert.equal(canonical.json({text:'\ud800',unknown:[null,true,1.25]}),' {"text":"\\ud800","unknown":[null,true,1.25]}'.trim());
});

test('ambiguous batch retries exact bytes and receipt keys; corrupt receipt cannot move lifetime',async t=>{
 const f=await fixture(t);await f.client.begin();const {adapter}=await f.client.initialize(await f.client.marker());const change={key:'a',identity:{...doc(),title:'Edited'},kind:'update',generation:1};let lost=true;
 f.control.after=body=>{if(body?.protocolVersion===2&&lost){lost=false;throw Error('lost');}};
 const first=adapter.prepareChanges([change]);assert.equal((await adapter.write(first)).ok,false);const retry=adapter.prepareChanges([change]);assert.equal(retry,first);assert.equal((await adapter.write(retry)).ok,true);
 const batches=f.calls.filter(c=>c.body?.protocolVersion===2);assert.equal(batches[0].raw,batches[1].raw);assert.equal(f.server.get('a').token.revision,2);
 f.control.after=(body,value)=>{if(body?.protocolVersion===2)value.receipts[0].identity.lifetime=99;};const bad=adapter.prepareChanges([{...change,generation:2,identity:{...doc(),title:'Again'}}]);assert.equal((await adapter.write(bad)).error.code,'uncertain');assert.equal(adapter.documentEpoch('a'),1);
});

test('provider inspects frozen authority before readiness and never falls back while offline',async t=>{
 const f=await fixture(t);f.control.before=body=>{if(body?.action==='chunk')throw Error('offline');};await assert.rejects(f.client.begin());
 globalThis.CoconutCanonicalLibrary={create:()=>f.client};t.after(()=>delete globalThis.CoconutCanonicalLibrary);
 const options={indexedDB:f.engine.indexedDB,name:'client',getStorage:()=>f.storage,validate:d=>d,legacyModule,documentModule:idb};const pending=await provider.initialize(options);assert.equal(pending.error.code,'canonical_pending');assert.equal(pending.adapter,undefined);assert.ok(pending.recovery);
 f.control.before=null;await f.client.resume();f.control.before=()=>{throw Error('offline');};const offline=await provider.initialize(options);assert.equal(offline.ok,false);assert.equal(offline.adapter,undefined);assert.ok(offline.recovery);
});

test('atomic multi-document adapter failure does not save any member; deletion and restore separate lifetime from transport epoch',async t=>{
 const f=await fixture(t);await f.client.begin();const m=await f.client.marker(),a=(await f.client.initialize(m)).adapter,b=(await f.client.initialize(m)).adapter;
 const changed=(key,generation=1)=>({key,identity:doc(key),kind:'update',generation});
 assert.equal((await b.write(b.prepareChanges([changed('a')]))).ok,true);
 const group=a.prepareChanges([changed('new'),changed('a')]);assert.equal((await a.write(group)).ok,false);assert.equal(f.server.get('new'),null);
 const remove=b.prepareChanges([{key:'a',identity:doc(),kind:'remove',generation:2}]);assert.equal((await b.write(remove)).ok,true);assert.equal(b.documentEpoch('a'),null);
 const restore=b.prepareChanges([changed('a',3)]);assert.equal((await b.write(restore)).ok,true);assert.equal(b.documentEpoch('a'),2);assert.equal(f.server.get('a').token.epoch,m.epoch);assert.equal(f.server.get('a').identity.position,0);
});

test('preflight rejection and local freeze abort leave browser usable and server untouched',async t=>{
 const f=await fixture(t);f.engine.rows('client').get('documents').get('a').payload.invalid=new Date();await assert.rejects(f.client.begin(),e=>e.code==='lossy_source');
 assert.equal((await f.client.marker()),undefined);assert.equal(f.server.describe().sequence,0);assert.equal(f.engine.rows('client').get('meta').get('state').status,'ready');
});

test('receipt mismatch before adoption keeps original frozen and authoritative marker unset',async t=>{
 const f=await fixture(t);f.control.after=(body,value)=>{if(body?.action==='finalize')value.receipt.sha256='0'.repeat(64);};await assert.rejects(f.client.begin(),e=>e.code==='receipt_mismatch');
 assert.equal((await f.client.marker()).state,'frozen');assert.equal(f.engine.rows('client').get('meta').get('state').status,'canonical-frozen');f.control.after=null;assert.equal((await f.client.resume()).state,'canonical');
});

test('provider reads canonical data after restart through the same adapter contract used by the reader save pipeline',async t=>{
 const f=await fixture(t);await f.client.begin();globalThis.CoconutCanonicalLibrary={create:({primitive,validate})=>canonical.create({primitive,validate,fetch:f.fetch})};t.after(()=>delete globalThis.CoconutCanonicalLibrary);
 const result=await provider.initialize({indexedDB:f.engine.indexedDB,name:'client',getStorage:()=>f.storage,validate:d=>d,legacyModule,documentModule:idb});assert.equal(result.backend,'canonical');
 const documents=result.loaded.documents,store=legacyModule.create({adapter:result.adapter,getDocuments:()=>documents});documents[0].notes.cue='Pipeline';store.queueDocument('a',documents[0]);assert.equal((await store.flush()).ok,true);assert.equal(f.server.get('a').document.notes.cue,'Pipeline');assert.equal(store.status().unsaved,0);
});

test('identical payload with different PC order is rejected before finalize and can cancel back to original browser',async t=>{
 const f=await fixture(t),epoch=f.server.describe().epoch;
 for(const key of ['other','a'])f.server.commit({protocolVersion:1,epoch,key,action:'put',expected:null,receiptKey:'preexisting-'+key,document:doc(key)});
 assert.equal(f.server.get('a').identity.position,2);
 await assert.rejects(f.client.begin(),e=>e.code==='migration_conflict');const marker=await f.client.marker();assert.equal(f.server.migration.status(marker.migrationId).state,'staging');assert.equal(f.server.describe().sequence,2);assert.equal(f.server.get('a').identity.position,2);
 assert.equal((await f.client.cancel()).state,'cancelled');assert.equal(f.engine.rows('client').get('meta').get('state').status,'ready');assert.equal((await idb.create(f.options).ready()).ok,true);
});

test('real Coconut validator null-prototype note dictionaries persist through canonical reader pipeline',async t=>{
 const f=await fixture(t),Coconut=require('../reader/core.js');await f.client.begin();const client=canonical.create({primitive:f.primitive,fetch:f.fetch,validate:Coconut.validate});const result=await client.initialize(await f.client.marker());
 const documents=result.loaded.documents;assert.equal(Object.getPrototypeOf(documents[0].notes),null);documents[0].notes.cue='Real validator note';
 const store=legacyModule.create({adapter:result.adapter,getDocuments:()=>documents});store.queueDocument('a',documents[0]);assert.equal((await store.flush()).ok,true);assert.equal(f.server.get('a').document.notes.cue,'Real validator note');
});

test('newer save pipeline generation resolves earlier ambiguous commit before advancing its captured CAS',async t=>{
 const f=await fixture(t);await f.client.begin();const {adapter,loaded}=await f.client.initialize(await f.client.marker()),documents=loaded.documents,store=legacyModule.create({adapter,getDocuments:()=>documents});let once=true;
 f.control.after=body=>{if(body?.protocolVersion===2&&once){once=false;throw Error('lost first receipt');}};
 documents[0].title='First committed';store.queueDocument('a',documents[0]);assert.equal((await store.flush()).ok,false);assert.equal(f.server.get('a').document.title,'First committed');
 documents[0].title='Newer edit';store.queueDocument('a',documents[0]);assert.equal((await store.flush()).ok,true);assert.equal(f.server.get('a').document.title,'Newer edit');assert.equal(f.server.get('a').token.revision,3);assert.equal(store.status().unsaved,0);
 const calls=f.calls.filter(c=>c.body?.protocolVersion===2);assert.equal(calls[0].raw,calls[1].raw);assert.equal(calls[2].body.commands[0].expected.revision,2);
});

test('canonical startup rejects altered archive bytes and forged committed receipt',async t=>{
 const f=await fixture(t);await f.client.begin();const marker=await f.client.marker();await assert.rejects(f.client.initialize({...marker,text:'corrupted'}),e=>e.code==='corruption');
 await assert.rejects(f.client.initialize({...marker,receipt:{...marker.receipt,sequence:1000}}),e=>e.code==='corruption');
});

test('first canonical note save preserves unknown nested segment and provenance fields',async t=>{
 const f=await fixture(t),raw=doc();raw.segments[0].unknownCue={text:'Keep \r\n雪'};raw.provenance={kind:'authored',unknownProvenance:{x:'Keep'}};
 await f.primitive.commit(f.primitive.prepare([{kind:'update',key:'a',expected:{epoch:1,revision:1},document:raw,generation:1,mutationId:'authored'}]));await f.client.begin();
 const client=canonical.create({primitive:f.primitive,fetch:f.fetch,validate:require('../reader/core.js').validate}),result=await client.initialize(await f.client.marker()),documents=result.loaded.documents;
 documents[0].notes.cue='New note';const store=legacyModule.create({adapter:result.adapter,getDocuments:()=>documents});store.queueDocument('a',documents[0]);assert.equal((await store.flush()).ok,true);
 assert.deepEqual(f.server.get('a').document.segments[0].unknownCue,raw.segments[0].unknownCue);assert.deepEqual(f.server.get('a').document.provenance.unknownProvenance,raw.provenance.unknownProvenance);
});

test('new canonical document appends after sparse migrated order while restore retains original position',async t=>{
 const f=await fixture(t);await f.primitive.commit(f.primitive.prepare([{kind:'create',key:'high',expected:null,document:doc('high'),order:50,generation:1,mutationId:'high'}]));await f.client.begin();const {adapter}=await f.client.initialize(await f.client.marker());
 assert.equal((await adapter.write(adapter.prepareChanges([{key:'new',identity:doc('new'),kind:'update',generation:1}]))).ok,true);assert.equal(f.server.get('new').identity.position,51);
});

test('lost create followed by Remove and lost delete followed by Undo reconcile exact lifecycle receipts',async t=>{
 const f=await fixture(t);await f.client.begin();const {adapter}=await f.client.initialize(await f.client.marker());let lose=true;
 f.control.after=body=>{if(body?.protocolVersion===2&&lose){lose=false;throw Error('lost');}};
 assert.equal((await adapter.write(adapter.prepareChanges([{key:'new',identity:doc('new'),kind:'update',generation:1}]))).ok,false);
 assert.equal((await adapter.write(adapter.prepareChanges([{key:'new',identity:doc('new'),kind:'remove',generation:2}]))).ok,true);assert.equal(f.server.get('new').deleted,true);
 lose=true;assert.equal((await adapter.write(adapter.prepareChanges([{key:'a',identity:doc(),kind:'remove',generation:3}]))).ok,false);
 assert.equal((await adapter.write(adapter.prepareChanges([{key:'a',identity:doc(),kind:'restore',generation:4}]))).ok,true);assert.equal(f.server.get('a').deleted,false);assert.equal(adapter.documentEpoch('a'),2);
});

test('reconciling own unknown receipt cannot overwrite an intervening other-tab edit',async t=>{
 const f=await fixture(t);await f.client.begin();const marker=await f.client.marker(),{adapter}=await f.client.initialize(marker);let once=true;
 f.control.after=body=>{if(body?.protocolVersion===2&&once){once=false;throw Error('lost');}};
 assert.equal((await adapter.write(adapter.prepareChanges([{key:'a',identity:{...doc(),title:'Own prior'},kind:'update',generation:1}]))).ok,false);
 const other=(await f.client.initialize(marker)).adapter;assert.equal((await other.write(other.prepareChanges([{key:'a',identity:{...doc(),title:'Other tab'},kind:'update',generation:1}]))).ok,true);
 assert.equal((await adapter.write(adapter.prepareChanges([{key:'a',identity:{...doc(),title:'Own newer'},kind:'update',generation:2}]))).ok,false);assert.equal(f.server.get('a').document.title,'Other tab');
});

test('unsupported server identities fail preflight before freezing the browser',async t=>{
 const f=await fixture(t);await f.primitive.commit(f.primitive.prepare([{kind:'create',key:'control\u0001',expected:null,document:doc('control\u0001'),generation:1,mutationId:'unsupported'}]));
 await assert.rejects(f.client.begin(),e=>e.code==='unsupported_key');assert.equal(await f.client.marker(),undefined);assert.equal(f.engine.rows('client').get('meta').get('state').status,'ready');assert.equal(f.server.describe().sequence,0);
});

test('unrelated adapter write never replays an uncertain structural intent',async t=>{
 const f=await fixture(t);await f.client.begin();const {adapter}=await f.client.initialize(await f.client.marker());let once=true;
 f.control.before=body=>{if(body?.protocolVersion===2&&once){once=false;throw Error('network failed before server');}};
 const uncertain=await adapter.write(adapter.prepareChanges([{key:'a',identity:doc(),kind:'remove',generation:1}]));assert.equal(uncertain.uncertain,true);
 assert.equal((await adapter.write(adapter.prepareChanges([{key:'other',identity:doc('other'),kind:'update',generation:2}]))).ok,true);assert.equal(f.server.get('a').deleted,false);assert.equal(f.calls.filter(c=>c.body?.commands?.some(command=>command.action==='delete')).length,1);
});

test('generated cue IDs preserve unknown source fields without resurrecting explicitly deleted fields',async t=>{
 const f=await fixture(t),raw=doc();delete raw.segments[0].id;raw.segments[0].unknownCue={keep:'authored'};raw.obsolete='remove deliberately';
 await f.primitive.commit(f.primitive.prepare([{kind:'update',key:'a',expected:{epoch:1,revision:1},document:raw,generation:1,mutationId:'no-id'}]));await f.client.begin();
 const client=canonical.create({primitive:f.primitive,fetch:f.fetch,validate:require('../reader/core.js').validate}),{adapter,loaded}=await client.initialize(await f.client.marker());delete loaded.documents[0].obsolete;
 assert.equal((await adapter.write(adapter.prepareChanges([{key:'a',identity:loaded.documents[0],kind:'update',generation:1}]))).ok,true);assert.deepEqual(f.server.get('a').document.segments[0].unknownCue,raw.segments[0].unknownCue);assert.equal('obsolete'in f.server.get('a').document,false);
});

for(const boundary of ['chunk','finalize'])test('legacy source changing during '+boundary+' cannot silently adopt and recovery preserves divergent raw',async t=>{
 const f=await fixture(t),changed=JSON.stringify({documents:[{...doc(),title:'Divergent old tab'}]});let once=true;
 f.control.after=body=>{if(body?.action===boundary&&once){once=false;f.storage.setItem(idb.LEGACY_KEY,changed);}};
 await assert.rejects(f.client.begin(),e=>e.code==='source_changed');assert.equal((await f.client.marker()).state,'frozen');const recovery=await f.primitive.canonicalRecovery();assert.equal(recovery.currentLegacyRaw,changed);assert.notEqual(recovery.stores.legacySnapshots[0].value.raw,changed);
});

test('cancel refuses a corrupted immutable archive before restoring any source state',async t=>{
 const f=await fixture(t);f.control.before=body=>{if(body?.action==='chunk')throw Error('offline');};await assert.rejects(f.client.begin());const row=f.engine.rows('client').get('meta').get('canonical-migration');row.text=row.text.replace('Authored a','Tampered a');f.control.before=null;
 await assert.rejects(f.client.cancel(),e=>e.code==='corruption');assert.equal(f.engine.rows('client').get('meta').get('state').status,'canonical-frozen');
});

test('newer atomic-group member reconciles unchanged peer receipt without repeating its delete',async t=>{
 const f=await fixture(t);await f.client.begin();const {adapter}=await f.client.initialize(await f.client.marker());let once=true;
 f.control.after=body=>{if(body?.protocolVersion===2&&once){once=false;throw Error('lost group');}};
 const a={key:'a',identity:doc(),kind:'remove',generation:1},b={key:'b',identity:doc('b'),kind:'update',generation:2};assert.equal((await adapter.write(adapter.prepareChanges([a,b]))).uncertain,true);
 const saved=await adapter.write(adapter.prepareChanges([a,{...b,generation:3,identity:{...doc('b'),title:'Newer b'}}]));assert.equal(saved.ok,true);assert.equal(saved.receipts.length,2);assert.equal(f.server.get('a').token.revision,2);assert.equal(f.server.get('a').deleted,true);assert.equal(f.server.get('b').document.title,'Newer b');
});

test('real canonical library drains 101 independent changes through bounded batches and reloads every exact document', async t => {
 const f=await fixture(t);await f.client.begin();const marker=await f.client.marker(),{adapter,loaded}=await f.client.initialize(marker),documents=loaded.documents;
 assert.equal(adapter.maxBatchSize,100);
 const store=legacyModule.create({adapter,getDocuments:()=>documents});
 documents.push(...Array.from({length:100},(_,index)=>doc('independent-'+index)));
 const tickets=documents.map(document=>{document.notes.cue='Saved '+document.key;return store.queueDocument(document.key,document);});
 assert.equal((await store.flush()).ok,true);assert.equal(store.status().unsaved,0);
 assert.deepEqual(f.calls.filter(call=>call.body?.protocolVersion===2).map(call=>call.body.commands.length),[100,1]);
 const receipts=await Promise.all(tickets.map(ticket=>ticket.committed));
 for(let index=0;index<documents.length;index++){
  assert.equal(receipts[index].identity,documents[index]);assert.equal(receipts[index].generation,tickets[index].generation);
  assert.equal(receipts[index].committedGeneration,tickets[index].generation);assert.deepEqual(f.server.get(documents[index].key).document,documents[index]);
 }
 const reloaded=await f.client.initialize(marker);assert.deepEqual(reloaded.loaded.documents,documents);
});

for(const boundary of ['before','after'])test('uncertain canonical Remove '+boundary+' server commit stays recoverable without rollback or unrelated replay',async t=>{
 const f=await fixture(t);await f.client.begin();const {adapter,loaded}=await f.client.initialize(await f.client.marker()),a=loaded.documents[0],b=doc('independent');let documents=[a,b],rollbacks=0,once=true;
 const store=legacyModule.create({adapter,getDocuments:()=>documents});
 f.control[boundary]=body=>{if(body?.protocolVersion===2&&once){once=false;throw Error('Unacknowledged Remove');}};
 documents=[b];const ticket=store.queueDocument(a.key,a,'remove',{rollback(){rollbacks++;documents=[a,b];return true;}});
 assert.equal((await store.flush()).ok,false);assert.equal((await ticket.committed).uncertain,true);assert.equal(rollbacks,0);
 assert.equal(f.server.get('a').deleted,boundary==='after');assert.equal(store.status(a.key).error.code,'uncertain');
 assert.deepEqual(store.snapshotForExport().pendingRemovals,['a']);
 store.queueDocument(b.key,b);assert.equal((await store.flush()).ok,false);assert.equal(f.server.get('independent').document.key,b.key);
 assert.equal(f.calls.filter(call=>call.body?.commands?.some(command=>command.action==='delete')).length,1);
 const barrier=store.acquireBarrier('uncertain-close');assert.equal((await store.discardPending(barrier)).error.code,'uncertain');store.releaseBarrier(barrier);
 assert.equal((await store.retry(a.key)).ok,true);assert.equal(f.server.get('a').deleted,true);assert.equal(f.server.get('a').token.revision,2);
 assert.equal(rollbacks,0);assert.equal(store.status().unsaved,0);
});

test('acknowledged structural peer cannot be rolled back when a newer group member conflicts',async t=>{
 const f=await fixture(t);await f.client.begin();const {adapter}=await f.client.initialize(await f.client.marker());let once=true;
 f.control.after=body=>{if(body?.protocolVersion===2&&once){once=false;throw Error('lost atomic group');}};
 const a={key:'a',identity:doc(),kind:'remove',generation:1},b={key:'b',identity:doc('b'),kind:'update',generation:2};assert.equal((await adapter.write(adapter.prepareChanges([a,b]))).uncertain,true);
 const current=f.server.get('b');f.server.commit({protocolVersion:1,epoch:current.token.epoch,key:'b',expected:current.token,receiptKey:'external-edit',action:'put',document:{...doc('b'),title:'Other writer'}});
 const result=await adapter.write(adapter.prepareChanges([a,{...b,generation:3,identity:{...doc('b'),title:'Own later'}}]));assert.equal(result.uncertain,true);assert.equal(f.server.get('a').deleted,true);assert.equal(f.server.get('a').token.revision,2);assert.equal(f.server.get('b').document.title,'Other writer');
});

test('normalized non-string source cue identity retains opaque metadata',async t=>{
 const f=await fixture(t),raw=doc();raw.segments[0].id=123;raw.segments[0].opaque={keep:true};await f.primitive.commit(f.primitive.prepare([{kind:'update',key:'a',expected:{epoch:1,revision:1},document:raw,generation:1,mutationId:'numeric-source-id'}]));await f.client.begin();
 const result=await canonical.create({primitive:f.primitive,fetch:f.fetch,validate:require('../reader/core.js').validate}).initialize(await f.client.marker());assert.equal(result.loaded.documents[0].segments[0].id,'segment-1');assert.deepEqual(result.loaded.documents[0].segments[0].opaque,{keep:true});
});

test('real canonical byte estimates pack ten 2MiB documents into bounded independent writes', async t => {
 const f=await fixture(t);await f.client.begin();const marker=await f.client.marker(),{adapter,loaded}=await f.client.initialize(marker),documents=loaded.documents;
 const store=legacyModule.create({adapter,getDocuments:()=>documents});documents.push(...Array.from({length:9},(_,index)=>doc('large-'+index)));
 for(const document of documents){document.unknown.large='x'.repeat(2*1024*1024);store.queueDocument(document.key,document);}
 assert.equal((await store.flush()).ok,true);assert.equal(store.status().unsaved,0);
 const calls=f.calls.filter(call=>call.body?.protocolVersion===2);
 assert.deepEqual(calls.map(call=>call.body.commands.length),[7,3]);
 for(const call of calls)assert.ok(Buffer.byteLength(call.raw)<=adapter.maxBatchBytes);
 for(const document of documents)assert.deepEqual(f.server.get(document.key).document,document);
 const reloaded=await f.client.initialize(marker);assert.deepEqual(reloaded.loaded.documents,documents);
});

test('canonical preflight detects exact UTF-8 request bytes, individual document limits, and unsent atomic overflow', async t => {
 const f=await fixture(t);await f.client.begin();const {adapter,loaded}=await f.client.initialize(await f.client.marker()),documents=loaded.documents,store=legacyModule.create({adapter,getDocuments:()=>documents});
 const document={...doc('measured'),unknown:{text:'雪 😀 \\" \\n'}},change={key:document.key,identity:document,kind:'update',generation:1};
 const expected=adapter.estimateBatchBytes([change]);assert.equal((await adapter.write(adapter.prepareChanges([change]))).ok,true);
 assert.equal(expected,Buffer.byteLength(f.calls.find(call=>call.body?.protocolVersion===2).raw));
 const proposed=Array.from({length:9},(_,index)=>({...doc('atomic-'+index),unknown:{large:'x'.repeat(2*1024*1024)}}));
 const before=f.calls.length,rejected=store.preflightDocuments(proposed.map(identity=>({key:identity.key,identity})));
 assert.equal(rejected.ok,false);assert.equal(rejected.error.code,'atomic_batch_too_large');assert.equal(rejected.error.retryable,false);
 assert.equal(f.calls.length,before);assert.equal(documents.length,1);assert.equal(store.status().unsaved,0);
 const oversized=documents[0];oversized.unknown.large='x'.repeat(8*1024*1024);
 const ticket=store.queueDocument(oversized.key,oversized),receipt=await ticket.committed;
 assert.equal(receipt.error.code,'document_too_large');assert.equal(receipt.error.retryable,false);assert.equal(store.status().unsaved,1);
 assert.equal(store.snapshotForExport().documents[0].unknown.large,oversized.unknown.large);assert.equal((await store.flush()).ok,false);
 assert.equal(f.calls.length,before);assert.equal(f.server.get('a').document.unknown.large,undefined);
});

async function secondClient(f, documents=[]) {
 const engine=transactionDouble(),values=new Map([[idb.LEGACY_KEY,JSON.stringify({documents})]]),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const primitive=idb.create({indexedDB:engine.indexedDB,getLegacyStorage:()=>storage,name:'second-client'});
 assert.equal((await primitive.ready()).ok,true);
 return {primitive,client:canonical.create({primitive,fetch:f.fetch}),values};
}

test('independent browser connects existing library without migration and shares CAS writes',async t=>{
 const f=await fixture(t);await f.client.begin();const a=await f.client.initialize(await f.client.marker());
 const b=await secondClient(f,[doc('browser-only')]),original=await b.primitive.readRecovery(),before=f.calls.length;
 await b.client.connect();const marker=await b.client.marker();assert.equal(marker.state,'connected');
 assert.equal(f.calls.slice(before).some(c=>c.body),false,'connection never writes the server');
 const connected=await b.client.initializeBinding(marker);assert.deepEqual(connected.loaded.documents.map(d=>d.key),['a']);
 assert.deepEqual((await b.primitive.readRecovery()).stores.documents,original.stores.documents);
 const change={key:'a',kind:'update',generation:1,identity:{...doc(),title:'B edited'}};
 assert.equal((await connected.adapter.write(connected.adapter.prepareChanges([change]))).ok,true);
 assert.equal((await f.client.initialize(await f.client.marker())).loaded.documents[0].title,'B edited');
 assert.equal((await a.adapter.write(a.adapter.prepareChanges([{...change,identity:{...doc(),title:'Stale A'}}]))).ok,false);
 assert.equal((await b.primitive.commit(b.primitive.prepare([{kind:'create',key:'stale-browser',expected:null,document:doc('stale-browser'),generation:1,mutationId:'stale-browser'}]))).ok,false);
});

test('connection reads failing before local commit leave browser authority writable',async t=>{
 const f=await fixture(t);await f.client.begin();const b=await secondClient(f,[doc('local')]);
 f.control.before=()=>{throw Error('offline');};await assert.rejects(b.client.connect());assert.equal(await b.client.marker(),undefined);
 assert.equal((await b.primitive.commit(b.primitive.prepare([{kind:'create',key:'still-local',expected:null,document:doc('still-local'),generation:1,mutationId:'still-local'}]))).ok,true);
});

test('lost local connection acknowledgement resumes binding; missing migration receipts do not revoke binding',async t=>{
 const f=await fixture(t);await f.client.begin();const b=await secondClient(f);
 const client=canonical.create({primitive:{...b.primitive,bindCanonical:async m=>{await b.primitive.bindCanonical(m);throw Error('lost local receipt');}},fetch:f.fetch});
 await assert.rejects(client.connect());const m=await b.client.marker();assert.equal(m.state,'connected');
 f.control.before=(_,url)=>{if(url.pathname.endsWith('/migration'))throw Error('migration endpoint unavailable');};
 assert.equal((await b.client.initializeBinding(m)).ok,true);
 f.control.before=undefined;f.control.after=(_,value)=>{if(value.enabled)value.epoch='00000000-0000-4000-8000-000000000000';};
 await assert.rejects(b.client.initializeBinding(m),{code:'epoch_conflict'});
 assert.equal((await b.primitive.commit(b.primitive.prepare([{kind:'create',key:'blocked',expected:null,document:doc('blocked'),generation:1,mutationId:'blocked'}]))).ok,false);
});

test('binding corruption and preserved-source changes fail closed',async t=>{
 const f=await fixture(t);await f.client.begin();const b=await secondClient(f,[doc('original')]);await b.client.connect();const m=await b.client.marker();
 await assert.rejects(b.client.initializeBinding({...m,sha256:'0'.repeat(64)}),{code:'corruption'});
 b.values.set(idb.LEGACY_KEY,'changed');await assert.rejects(b.client.initializeBinding(m),{code:'source_changed'});
});

test('API-only canonical namespace survives reopen and is separate from library epoch',async t=>{
 const f=await fixture(t);assert.equal(f.server.describe().binding,null);
 const epoch=f.server.describe().epoch;
 f.server.commit({protocolVersion:1,epoch,key:'api',action:'put',expected:null,receiptKey:'namespace-test',document:doc('api')});
 const identity=f.server.describe().binding.mediaLibraryIdentity;assert.notEqual(identity,epoch);
 const b=await secondClient(f);await b.client.connect();assert.equal((await b.client.initializeBinding(await b.client.marker())).loaded.documents[0].key,'api');
});

test('API-created library binding survives later matching browser migration without namespace change',async t=>{
 const f=await fixture(t),epoch=f.server.describe().epoch;
 f.engine.rows('client').get('catalog').get('a').order=1;f.engine.rows('client').get('meta').get('state').nextOrder=2;
 f.server.commit({protocolVersion:1,epoch,key:'a',action:'put',expected:null,receiptKey:'api-created',document:doc()});
 const namespace=f.server.describe().binding.mediaLibraryIdentity,b=await secondClient(f);await b.client.connect();const binding=await b.client.marker();
 await f.client.begin();const migration=await f.client.marker();assert.notEqual(migration.mediaLibraryIdentity,namespace);
 assert.equal(f.server.describe().binding.mediaLibraryIdentity,namespace);assert.equal((await b.client.initializeBinding(binding)).ok,true);
 const a=await f.client.initialize(migration);assert.equal((await a.adapter.mediaLibraryIdentity()).identity,namespace);
 const reconnected=await b.client.initializeBinding(binding),changed={...doc(),title:'B after migration'};
 assert.equal((await reconnected.adapter.write(reconnected.adapter.prepareChanges([{key:'a',kind:'update',generation:1,identity:changed}]))).ok,true);
 assert.equal((await f.client.initialize(migration)).loaded.documents[0].title,changed.title);
});

test('private capabilities fence migration before browser freeze and old library writes after identity change',async t=>{
 let identity='private-owner:library-a';const allowed=new Set(['libraryRead','libraryWrite']);
 globalThis.CoconutClientCapabilities={identity:()=>identity,allows:name=>allowed.has(name)};t.after(()=>{delete globalThis.CoconutClientCapabilities;});
 const f=await fixture(t);await assert.rejects(f.client.begin(),error=>error.code==='unsupported');assert.equal(await f.client.marker(),undefined);assert.equal(f.calls.length,0);
 await f.client.request();const calls=f.calls.length;identity='different-owner:library-a';
 await assert.rejects(f.client.request('/batch',{protocolVersion:2}),error=>error.code==='connection_changed');assert.equal(f.calls.length,calls);
 identity='private-owner:library-a';allowed.delete('libraryWrite');await assert.rejects(f.client.request('/batch',{}),error=>error.code==='connection_changed');assert.equal(f.calls.length,calls);
});

test('canonical late response cannot apply after connection identity changes',async t=>{
 let identity='owner:library';globalThis.CoconutClientCapabilities={identity:()=>identity,generation:1,allows:()=>true};t.after(()=>{delete globalThis.CoconutClientCapabilities;});
 const f=await fixture(t);let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);f.control.after=async()=>{started();await gate;};
 const pending=f.client.request();await ready;identity='other-owner:library';globalThis.CoconutClientCapabilities.generation++;release();await assert.rejects(pending,error=>error.code==='connection_changed');
});

test('a remote browser missing its capability module cannot read or mutate canonical state',async t=>{
 globalThis.location={hostname:'reader.example.test'};t.after(()=>{delete globalThis.location;});
 const f=await fixture(t);await assert.rejects(f.client.request(),error=>error.code==='unsupported');await assert.rejects(f.client.begin(),error=>error.code==='unsupported');assert.equal(f.calls.length,0);assert.equal(await f.client.marker(),undefined);
});
