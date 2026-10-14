import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {create, createLegacyAdapter, KEY, FENCE_KEY} = require('../reader/library-store.js');
const turn = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const doc = key => ({key, title: key, notes: {}, ai_answers: [], segments: [{id: 'one', text: 'Authored fixture'}]});
function memoryStorage(initial) {
  const values = new Map(initial === undefined ? [] : [[KEY, initial]]);
  const writes = [];
  return {values, writes, getItem: key => values.get(key) ?? null,
    setItem(key, value) { writes.push({key, value}); values.set(key, value); }};
}
function clock() {
  let time = 0, id = 0;
  const jobs = new Map();
  return {now: () => time, setTimer(fn, ms) { const handle = ++id; jobs.set(handle, {at: time + ms, fn}); return handle; },
    clearTimer: handle => jobs.delete(handle),
    async tick(ms) {
      const end = time + ms;
      while ([...jobs.values()].some(job => job.at <= end)) {
        const [handle, job] = [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
        jobs.delete(handle); time = job.at; job.fn(); await turn();
      }
      time = end; await turn();
    }, get size() { return jobs.size; }};
}
function fixture({documents = [doc('a'), doc('b')], delayed = true, delay = 250, maxWait = 1000} = {}) {
  const storage = memoryStorage(JSON.stringify({documents, active: 'a'}));
  const legacy = createLegacyAdapter({getStorage: () => storage});
  legacy.load();
  const writes = [], timers = clock();
  const adapter = {...legacy, write(value, {signal}) {
    if (!delayed) return legacy.write(value, {signal});
    return new Promise(resolve => writes.push({value, signal,
      commit: ({ignoreAbort = false} = {}) => resolve(legacy.write(value, ignoreAbort ? {} : {signal})),
      fail: error => resolve({ok: false, status: 'failed', error}),
      abort: () => resolve({ok: false, status: 'cancelled', error: {code: 'cancelled'}})}));
  }};
  let current = documents;
  const store = create({adapter, getDocuments: () => current,
    checkpoint: doc => ({answerCount: doc.ai_answers.length, evidence: {title: doc.title}}), ...timers, delay, maxWait});
  return {store, writes, storage, timers, get documents() { return current; }, set documents(value) { current = value; }};
}

test('queue is an explicit ticket; debounce coalesces input with a bounded maximum wait', async () => {
  const f = fixture(), a = f.documents[0];
  const first = f.store.queueDocument(a.key, a);
  assert.equal(first.accepted, true); assert.equal(typeof first.committed.then, 'function');
  assert.equal(f.store.status('a').status, 'pending'); assert.equal(f.writes.length, 0);
  let complete = false; first.committed.then(() => { complete = true; });
  for (let index = 0; index < 4; index++) { await f.timers.tick(200); a.notes.one = String(index); f.store.queueDocument(a.key, a); }
  assert.equal(f.writes.length, 0); await f.timers.tick(200);
  assert.equal(f.writes.length, 1); assert.equal(complete, false);
  f.writes[0].commit(); const receipt = await first.committed;
  assert.equal(receipt.ok, true); assert.equal(receipt.committedGeneration, 5);
  assert.equal(f.store.status().status, 'saved');
  assert.equal(JSON.parse(f.storage.getItem(KEY)).documents[0].notes.one, '3');
  assert.equal('active' in JSON.parse(f.storage.getItem(KEY)), false);
});

test('one whole-library receipt captures A and B; a later B edit remains pending with its newer AI history', async () => {
  const f = fixture(), [a, b] = f.documents;
  a.notes.one = 'A first'; const ta = f.store.queueDocument('a', a);
  b.ai_answers.push({answer: 'B first'}); const tb = f.store.queueDocument('b', b);
  const flush = f.store.flush(); assert.equal(f.writes.length, 1);
  b.ai_answers.push({answer: 'B second'}); b.title = 'B newer';
  const newer = f.store.queueDocument('b', b);
  f.writes[0].commit(); const first = await ta.committed;
  assert.equal((await tb.committed).ok, true);
  assert.deepEqual(first.changes.map(item => [item.key, item.generation]), [['a', 1], ['b', 2]]);
  const captured = first.checkpoints.find(item => item.key === 'b');
  assert.equal(captured.identity, b); assert.equal(captured.checkpoint.answerCount, 1);
  assert.equal(captured.checkpoint.evidence.title, 'b');
  assert.equal(f.store.status('a').status, 'saved'); assert.equal(f.store.status('b').status, 'pending');
  assert.equal(f.store.status('b').committedGeneration, 2);
  assert.equal((await flush).ok, true, 'flush acknowledges its boundary, not future edits');
  await turn();
  if (f.writes.length < 2) await f.timers.tick(250);
  f.writes[1].commit(); const second = await newer.committed;
  assert.equal(second.checkpoints.find(item => item.key === 'b').checkpoint.answerCount, 2);
  assert.equal(f.store.status('b').status, 'saved');
  assert.equal(JSON.parse(f.storage.getItem(KEY)).documents[1].ai_answers.length, 2);
});

test('removal and undo receipts belong to captured identities; edits to another document are never rolled back', async () => {
  const f = fixture(), [original, b] = f.documents;
  f.documents = [b]; const removal = f.store.queueDocument('a', original, 'remove');
  const removing = f.store.flush(); assert.equal(f.writes.length, 1);
  const restored = {...original, notes: {one: 'Restored and changed'}};
  f.documents = [restored, b]; const undo = f.store.queueDocument('a', restored, 'restore');
  b.notes.one = 'Edited while removal was saving'; const tb = f.store.queueDocument('b', b);
  f.writes[0].commit(); const removed = await removal.committed;
  assert.equal(removed.ok, true); assert.equal(removed.changes[0].kind, 'remove');
  assert.equal(removed.changes[0].identity, original);
  assert.equal(removed.checkpoints.some(item => item.key === 'a'), false);
  assert.equal(f.store.status('a').identity, restored); assert.equal(f.store.status('a').status, 'pending');
  assert.equal((await removing).ok, true); await turn();
  if (f.writes.length < 2) await f.timers.tick(250);
  f.writes[1].commit(); assert.equal((await undo.committed).ok, true); assert.equal((await tb.committed).ok, true);
  assert.equal(JSON.parse(f.storage.getItem(KEY)).documents[1].notes.one, 'Edited while removal was saving');
  assert.equal(f.store.queueDocument('a', original).accepted, false, 'a late callback cannot queue an old identity');
});

test('replacing a not-yet-captured document cancels the old ticket instead of claiming its content was saved', async () => {
  const f = fixture(), original = f.documents[0];
  const stale = f.store.queueDocument('a', original);
  const replacement = doc('a'); f.documents = [replacement, f.documents[1]];
  const current = f.store.queueDocument('a', replacement, 'restore');
  assert.equal((await stale.committed).status, 'cancelled');
  const flush = f.store.flush(); f.writes[0].commit(); await flush;
  assert.equal((await current.committed).identity, replacement);
});

test('identity replacement settles every superseded ticket, including an edit newer than an in-flight snapshot', async () => {
  const f = fixture(), original = f.documents[0];
  const captured = f.store.queueDocument('a', original); const firstFlush = f.store.flush();
  original.notes.one = 'Not captured'; const uncaptured = f.store.queueDocument('a', original);
  const replacement = doc('a'); f.documents = [replacement, f.documents[1]];
  const current = f.store.queueDocument('a', replacement, 'restore');
  assert.equal((await uncaptured.committed).status, 'cancelled');
  f.writes[0].commit(); assert.equal((await captured.committed).ok, true); await firstFlush; await turn();
  if (f.writes.length < 2) await f.timers.tick(250);
  f.writes[1].commit(); assert.equal((await current.committed).identity, replacement);
});

test('quota failure keeps all memory and rescue data; explicit retry confirms the captured whole library', async () => {
  const f = fixture(), [a, b] = f.documents;
  a.notes.one = 'Preserve me'; const first = f.store.queueDocument('a', a);
  const flush = f.store.flush(); f.writes[0].fail({code: 'quota', message: 'Quota exceeded'});
  assert.equal((await first.committed).error.code, 'quota'); assert.equal((await flush).ok, false);
  await f.timers.tick(10000); assert.equal(f.writes.length, 1, 'failure must not spin on a timer');
  const rescued = f.store.snapshotForExport(); assert.equal(rescued.documents[0].notes.one, 'Preserve me');
  rescued.documents[0].notes.one = 'Changed export'; assert.equal(a.notes.one, 'Preserve me');
  assert.equal(f.store.status().unsaved, 1, 'export is not confirmation of a save');
  b.notes.one = 'B new edit'; const second = f.store.queueDocument('b', b);
  const retry = f.store.retry(); assert.equal(f.writes.length, 2);
  f.writes[1].commit(); const receipt = await second.committed;
  assert.deepEqual(receipt.changes.map(item => item.key), ['a', 'b']);
  assert.equal((await retry).ok, true); assert.equal(f.store.status().unsaved, 0);
});

test('an old failed generation cannot discard a newer queued edit', async () => {
  const f = fixture(), a = f.documents[0];
  const old = f.store.queueDocument('a', a); const flush = f.store.flush();
  a.notes.one = 'Newer'; const newer = f.store.queueDocument('a', a);
  f.writes[0].fail({code: 'quota'}); assert.equal((await old.committed).ok, false); await flush;
  assert.equal(f.store.status('a').status, 'pending'); await turn();
  if (f.writes.length < 2) await f.timers.tick(250);
  f.writes[1].commit(); assert.equal((await newer.committed).ok, true);
});

test('flush joins a failed A when a newly queued B will save both, without replaying A\'s stale error', async () => {
  const f = fixture(), [a, b] = f.documents;
  f.store.queueDocument('a', a); const failed = f.store.flush();
  f.writes[0].fail({code: 'quota'}); assert.equal((await failed).ok, false);
  assert.equal((await f.store.flush()).ok, false); assert.equal(f.writes.length, 1, 'flush alone does not infinitely retry a failed generation');
  b.notes.one = 'New B'; f.store.queueDocument('b', b);
  const flush = f.store.flush(); f.writes[1].commit();
  const result = await flush; assert.equal(result.ok, true);
  assert.deepEqual(result.results.map(item => item.key), ['a', 'b']); assert.equal(f.store.status().status, 'saved');
});

test('an attempt released after timeout cannot later report a close-ready save or acquire the next barrier', async () => {
  const f = fixture(), a = f.documents[0]; f.store.queueDocument('a', a);
  const old = f.store.acquireBarrier('close-1'); const flush = f.store.flush({token: old});
  assert.equal(f.store.queueDocument('a', a).accepted, false);
  assert.equal(f.store.releaseBarrier(old), true); assert.equal((await flush).status, 'cancelled');
  const current = f.store.acquireBarrier('close-2'); assert.ok(current);
  f.writes[0].commit(); await turn();
  assert.equal(f.store.barrierActive(old), false); assert.equal(f.store.barrierActive(current), true);
  assert.equal(f.store.releaseBarrier(old), false); assert.equal(f.store.status().blocked, true);
  assert.equal((await f.store.flush({token: current})).ok, true);
  f.store.releaseBarrier(current); assert.equal(f.store.status().blocked, false);
});

test('release between a clean completion and its return still invalidates the lifecycle receipt', async () => {
  for (const action of ['flush', 'discard']) {
    const f = fixture(), token = f.store.acquireBarrier(action);
    const pending = action === 'flush' ? f.store.flush({token}) : f.store.discardPending(token);
    await Promise.resolve(); f.store.releaseBarrier(token);
    assert.equal((await pending).status, 'cancelled');
  }
});

test('discard waits for actual abort, cancels later edits, and preserves dirty memory after a failed native close', async () => {
  const f = fixture(), a = f.documents[0];
  const first = f.store.queueDocument('a', a); const flushing = f.store.flush();
  a.notes.one = 'Later unsaved'; const later = f.store.queueDocument('a', a);
  const token = f.store.acquireBarrier('discard'); let settled = false;
  const discard = f.store.discardPending(token).then(result => { settled = true; return result; });
  assert.equal(f.writes[0].signal.aborted, true); await turn(); assert.equal(settled, false);
  assert.equal((await later.committed).status, 'cancelled');
  f.writes[0].abort(); assert.equal((await discard).status, 'discarded');
  assert.equal((await first.committed).status, 'cancelled'); await flushing;
  f.store.releaseBarrier(token); assert.equal(f.store.status().unsaved, 1);
  assert.equal(f.store.snapshotForExport().documents[0].notes.one, 'Later unsaved');
  const retry = f.store.retry(); f.writes[1].commit(); assert.equal((await retry).ok, true);
});

test('discard cannot pretend to roll back a write which already committed', async () => {
  const f = fixture(), a = f.documents[0]; a.notes.one = 'Already committed';
  const saved = f.store.queueDocument('a', a); const flush = f.store.flush();
  const token = f.store.acquireBarrier('discard'); const discard = f.store.discardPending(token);
  f.writes[0].commit({ignoreAbort: true}); assert.equal((await saved.committed).ok, true);
  assert.equal((await discard).committed, true); await flush;
  assert.equal(JSON.parse(f.storage.getItem(KEY)).documents[0].notes.one, 'Already committed');
  f.store.releaseBarrier(token); assert.equal(f.store.status().unsaved, 0);
});

test('a released discard does not cancel the next lifecycle attempt when its abort arrives late', async () => {
  const f = fixture(), a = f.documents[0]; f.store.queueDocument('a', a); const flush = f.store.flush();
  const old = f.store.acquireBarrier('old'); const discard = f.store.discardPending(old);
  f.store.releaseBarrier(old); assert.equal((await discard).status, 'cancelled');
  const current = f.store.acquireBarrier('new'); f.writes[0].abort(); await flush;
  assert.equal(f.store.barrierActive(current), true); f.store.releaseBarrier(current);
});

test('retry after a timed-out discard survives the old writer\'s late abort', async () => {
  const f = fixture(), a = f.documents[0]; a.notes.one = 'Recover after timeout';
  f.store.queueDocument('a', a); const flushing = f.store.flush();
  const token = f.store.acquireBarrier('close'); const discard = f.store.discardPending(token);
  f.store.releaseBarrier(token); assert.equal((await discard).status, 'cancelled');
  const retry = f.store.retry(); f.writes[0].abort(); await flushing; await turn();
  assert.equal(f.writes.length, 2); assert.equal(f.store.status('a').status, 'pending');
  f.writes[1].commit(); assert.equal((await retry).ok, true);
  assert.equal(JSON.parse(f.storage.getItem(KEY)).documents[0].notes.one, 'Recover after timeout');
});

test('clean flush and repeated read-only status checks do not serialize or write', async () => {
  let prepares = 0;
  const a = doc('a'), store = create({adapter: {prepare() { prepares++; }, write() { throw Error('Unexpected write'); }}, getDocuments: () => [a]});
  for (let index = 0; index < 20; index++) store.status();
  assert.equal((await store.flush()).ok, true); assert.equal(prepares, 0);
});

test('capture failure and rejected writer promises both settle tickets without losing input', async () => {
  for (const stage of ['capture', 'write']) {
    const a = doc('a'), timers = clock();
    const store = create({adapter: {prepare() { if (stage === 'capture') throw Error('Bad snapshot'); return 'snapshot'; },
      write() { return Promise.reject(new DOMException('Unavailable', 'SecurityError')); }}, getDocuments: () => [a], ...timers});
    a.notes.one = 'Still here'; const saved = store.queueDocument('a', a); const flush = store.flush();
    assert.equal((await saved.committed).ok, false); assert.equal((await flush).ok, false);
    assert.equal(store.status().unsaved, 1); assert.equal(a.notes.one, 'Still here'); assert.equal(timers.size, 0);
  }
});

test('legacy conflict and migration fence are detected before writing; the original data stays untouched', () => {
  for (const reason of ['conflict', 'fenced']) {
    const storage = memoryStorage(JSON.stringify({documents: [doc('a')], active: 'a'}));
    const adapter = createLegacyAdapter({getStorage: () => storage}); assert.equal(adapter.load().ok, true);
    if (reason === 'conflict') storage.values.set(KEY, JSON.stringify({documents: [doc('remote')]}));
    else storage.values.set(FENCE_KEY, 'newer/unknown protocol');
    const before = storage.getItem(KEY); const result = adapter.write(adapter.prepare([doc('local')]));
    assert.equal(result.error.code, reason); assert.equal(storage.getItem(KEY), before); assert.equal(storage.writes.length, 0);
    assert.equal(adapter.write(adapter.prepare([doc('retry')])).ok, false, 'retry never rebases over unknown remote content');
  }
});

test('legacy write errors distinguish quota, denied access and unexpected failures', () => {
  for (const [name, code] of [['QuotaExceededError', 'quota'], ['SecurityError', 'denied'], ['Error', 'unexpected']]) {
    const storage = memoryStorage(); const adapter = createLegacyAdapter({getStorage: () => storage}); adapter.load();
    storage.setItem = () => { const error = new Error('Failure'); error.name = name; throw error; };
    assert.equal(adapter.write(adapter.prepare([doc('a')])).error.code, code);
  }
});

test('unreadable startup never becomes permission to overwrite later, including corrupt and duplicate-key libraries', () => {
  for (const raw of ['{bad JSON', JSON.stringify({documents: [doc('a'), doc('a')]}), 'null']) {
    const storage = memoryStorage(raw), adapter = createLegacyAdapter({getStorage: () => storage});
    assert.equal(adapter.load().ok, false); assert.equal(adapter.write(adapter.prepare([doc('new')])).error.code, 'unreadable');
    assert.equal(storage.getItem(KEY), raw); assert.equal(storage.writes.length, 0);
  }
  const storage = memoryStorage(); let denied = true;
  const adapter = createLegacyAdapter({getStorage() { if (denied) throw new DOMException('Denied', 'SecurityError'); return storage; }});
  assert.equal(adapter.load().error.code, 'denied'); denied = false;
  assert.equal(adapter.write(adapter.prepare([doc('new')])).error.code, 'unreadable'); assert.equal(storage.writes.length, 0);
});

test('a pending removal remains available to rescue, and observers cannot turn a committed write into failure', async () => {
  const f = fixture(), removed = f.documents[0]; f.documents = f.documents.slice(1);
  f.store.subscribe(() => { throw Error('Broken render'); });
  const ticket = f.store.queueDocument('a', removed, 'remove');
  assert.equal(f.store.snapshotForExport().documents[0].key, 'a');
  assert.deepEqual(f.store.snapshotForExport().pendingRemovals, ['a']);
  const flush = f.store.flush(); f.writes[0].commit();
  assert.equal((await ticket.committed).ok, true); assert.equal((await flush).ok, true);
  assert.equal(f.store.status('a'), null, 'successful removals do not accumulate hidden retained document copies');
  assert.equal(f.store.snapshotForExport().documents.length, 0);
});

test('atomic registration precedes every observer snapshot and rejects a partial invalid group', async () => {
 const f=fixture(), [a,b]=f.documents;let flush;
 f.store.subscribe((_state,event)=>{if(event.type==='queued')flush=f.store.flush();});
 a.notes.one='A batch';b.notes.one='B batch';
 const result=f.store.queueDocuments([{key:'a',identity:a},{key:'b',identity:b}]);
 assert.equal(result.accepted,true);assert.equal(f.writes.length,1);
 f.writes[0].commit();await flush;
 for(const ticket of result.tickets){const receipt=await ticket.committed;assert.deepEqual(receipt.changes.map(item=>item.key),['a','b']);}
 assert.deepEqual(JSON.parse(f.writes[0].value).documents.map(item=>item.notes.one),['A batch','B batch']);
 const rejected=f.store.queueDocuments([{key:'a',identity:a},{key:'b',identity:doc('b')}]);
 assert.equal(rejected.accepted,false);assert.equal(f.store.status().unsaved,0);assert.equal(f.writes.length,1);
});

for(const kind of ['remove','restore'])test(`failed ${kind} reconciles only its own identity before a waiting B flush captures`,async()=>{
 const f=fixture(), [a,b]=f.documents;
 if(kind==='restore'){
  f.documents=[b];f.store.queueDocument('a',a,'remove');const flush=f.store.flush();f.writes[0].commit();await flush;
 }
 let rollbacks=0;
 if(kind==='remove')f.documents=[b];else f.documents=[a,b];
 const structural=f.store.queueDocument('a',a,kind,{rollback(){rollbacks++;f.documents=kind==='remove'?[a,...f.documents]:f.documents.filter(item=>item!==a);return true;}});
 const operation=f.store.flush(),index=f.writes.length-1;
 b.notes.one='Concurrent B';const editing=f.store.queueDocument('b',b),waiting=f.store.flush();
 f.writes[index].fail({code:'quota'});assert.equal((await structural.committed).ok,false);await operation;
 assert.equal(rollbacks,1);assert.equal(f.store.status('a')?.status??null,kind==='remove'?'saved':null);
 assert.equal(f.writes.length,index+2,'waiting B captures after rollback');
 assert.deepEqual(JSON.parse(f.writes[index+1].value).documents.map(item=>item.key),kind==='remove'?['a','b']:['b']);
 f.writes[index+1].commit();assert.equal((await editing.committed).ok,true);
 assert.equal((await waiting).ok,false,'captured failed structural generation remains an honest failed receipt');
 assert.equal(b.notes.one,'Concurrent B');assert.equal(f.store.status().unsaved,0);
});

test('failed removal restores a previously dirty identity as failed, never saved, and includes it in retry',async()=>{
 const f=fixture(),[a,b]=f.documents;a.notes.one='Not saved yet';const old=f.store.queueDocument('a',a);
 f.documents=[b];const removal=f.store.queueDocument('a',a,'remove',{rollback(){f.documents=[a,b];return true;}});
 assert.equal((await old.committed).status,'cancelled');const flushing=f.store.flush();f.writes[0].fail({code:'quota'});await flushing;
 assert.equal((await removal.committed).ok,false);assert.equal(f.store.status('a').status,'failed');assert.equal(f.store.status('a').kind,'update');
 assert.equal(f.store.snapshotForExport().documents[0].notes.one,'Not saved yet');
 const retry=f.store.retry();f.writes[1].commit();assert.equal((await retry).ok,true);assert.equal(f.store.status().unsaved,0);
});

test('new identity or generation supersedes a structural rollback owner',async()=>{
 for(const replace of [true,false]){
  const f=fixture(),[original,b]=f.documents;let rollbacks=0;
  f.documents=[b];const first=f.store.queueDocument('a',original,'remove',{rollback(){rollbacks++;return true;}}),flushing=f.store.flush();
  const a=replace?doc('a'):original;f.documents=[a,b];a.notes.one='New intent';const newer=f.store.queueDocument('a',a,'restore');
  f.writes[0].fail({code:'quota'});assert.equal((await first.committed).ok,false);await flushing;
  assert.equal(rollbacks,0);assert.equal(f.store.status('a').identity,a);assert.equal(f.store.status('a').status,'pending');
  if(f.writes.length<2)await f.timers.tick(250);f.writes[1].commit();assert.equal((await newer.committed).ok,true);
  assert.equal(JSON.parse(f.storage.getItem(KEY)).documents[0].notes.one,'New intent');
 }
});

test('throwing structural rollback fails closed rather than acknowledging a mismatched identity',async()=>{
 const f=fixture(),[a,b]=f.documents;f.documents=[b];
 f.store.queueDocument('a',a,'remove',{rollback(){f.documents=[a,b];throw Error('Failed rollback callback');}});
 const removal=f.store.flush();f.writes[0].fail({code:'quota'});assert.equal((await removal).ok,false);
 b.notes.one='Keep B';f.store.queueDocument('b',b);const following=await f.store.flush();
 assert.equal(following.ok,false);assert.equal(f.writes.length,1,'identity mismatch blocks another writer');
 assert.equal(f.store.status('a').status,'failed');assert.equal(f.store.snapshotForExport().documents.find(doc=>doc.key==='b').notes.one,'Keep B');
});

test('a synchronous rollback listener can register a newer generation without losing its ticket',async()=>{
 const f=fixture(),[a,b]=f.documents;let newer;
 f.documents=[b];const removal=f.store.queueDocument('a',a,'remove',{rollback(){
  f.documents=[a,b];a.notes.one='New edit from restore listener';newer=f.store.queueDocument('a',a,'restore');return true;
 }});
 const flushing=f.store.flush();f.writes[0].fail({code:'quota'});assert.equal((await removal.committed).ok,false);await flushing;
 assert.equal(f.store.status('a').generation,newer.generation);assert.equal(f.store.status('a').status,'pending');
 if(f.writes.length<2)await f.timers.tick(250);f.writes[1].commit();assert.equal((await newer.committed).ok,true);
 assert.equal(JSON.parse(f.storage.getItem(KEY)).documents[0].notes.one,'New edit from restore listener');
});

test('discard reconciles an uncaptured structural operation while waiting for the older writer to acknowledge abort',async()=>{
 const f=fixture(),[a,b]=f.documents;b.notes.one='Older B';f.store.queueDocument('b',b);const flushing=f.store.flush();
 f.documents=[b];let rolledBack=0;const removal=f.store.queueDocument('a',a,'remove',{rollback(){rolledBack++;f.documents=[a,b];return true;}});
 const token=f.store.acquireBarrier('close'),discard=f.store.discardPending(token);
 assert.equal((await removal.committed).status,'cancelled');assert.equal(rolledBack,1);assert.equal(f.store.status('a').status,'saved');
 f.writes[0].abort();await flushing;assert.equal((await discard).status,'discarded');f.store.releaseBarrier(token);
 const retry=f.store.retry();f.writes[1].commit();assert.equal((await retry).ok,true);
 assert.deepEqual(JSON.parse(f.storage.getItem(KEY)).documents.map(doc=>doc.key),['a','b']);
});

for(const earlierSuccess of [true,false])test(`structural rollback retains an older captured ${earlierSuccess?'success':'failure'} receipt and baseline generation`,async()=>{
 const f=fixture(),[a,b]=f.documents;a.notes.one='Older A';b.notes.one='Older B';const ta=f.store.queueDocument('a',a),tb=f.store.queueDocument('b',b),earlier=f.store.flush();
 f.documents=[b];const removal=f.store.queueDocument('a',a,'remove',{rollback(){f.documents=[a,b];return true;}}),removing=f.store.flush();
 if(earlierSuccess)f.writes[0].commit();else f.writes[0].fail({code:'quota'});await earlier;await turn();
 assert.equal((await ta.committed).ok,earlierSuccess);assert.equal((await tb.committed).ok,earlierSuccess);
 f.writes[1].fail({code:'quota'});await removing;assert.equal((await removal.committed).ok,false);
 assert.equal(f.store.status('a').generation,ta.generation);assert.equal(f.store.status('a').committedGeneration,earlierSuccess?ta.generation:0);assert.equal(f.store.status('a').status,earlierSuccess?'saved':'failed');
});
test('a Promise-returning rollback never claims that its unverified structural baseline is saved',async()=>{
 const f=fixture(),[a,b]=f.documents;f.documents=[b];const removal=f.store.queueDocument('a',a,'remove',{rollback(){f.documents=[a,b];return Promise.resolve(true);}}),flush=f.store.flush();
 f.writes[0].fail({code:'quota'});await flush;assert.equal((await removal.committed).ok,false);assert.equal(f.store.status('a').status,'failed');assert.equal(f.store.status('a').kind,'remove');
});

function boundedFixture(count, maxBatchSize = 100, maxBatchBytes = Infinity) {
  let documents = Array.from({length: count}, (_, index) => doc('bounded-' + index));
  const writes = [], timers = clock();
  const adapter = {maxBatchSize, maxBatchBytes, estimateBatchBytes: changes => new TextEncoder().encode(JSON.stringify(changes.map(change => change.identity))).length, prepareChanges(changes) {
    assert.ok(changes.length <= maxBatchSize, 'adapter limit is never exceeded');
    assert.ok(adapter.estimateBatchBytes(changes) <= maxBatchBytes, 'adapter byte limit is never exceeded');
    return changes.map(change => ({...change, document: JSON.parse(JSON.stringify(change.identity))}));
  }, write(value, {signal}) {
    return new Promise(resolve => writes.push({value, signal,
      commit: () => resolve({ok: true, status: 'saved', receipts: value.map(change => ({key: change.key, generation: change.generation}))}),
      fail: (error, extra = {}) => resolve({ok: false, status: error.code === 'conflict' ? 'conflict' : 'failed', error, ...extra})}));
  }};
  const store = create({adapter, getDocuments: () => documents, checkpoint: document => ({title: document.title}), ...timers});
  return {store, writes, timers, get documents() { return documents; }, set documents(value) { documents = value; }};
}

test('101 independent dirty documents drain in bounded batches with exact generation, identity, checkpoint and receipt ownership', async () => {
  const f = boundedFixture(101);
  const tickets = f.documents.map(document => { document.notes.one = 'Exact ' + document.key; return f.store.queueDocument(document.key, document); });
  let finished = false;
  const flush = f.store.flush().then(result => { finished = true; return result; });
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].value.length, 100);
  f.writes[0].commit(); await turn();
  assert.equal(finished, false); assert.equal(f.writes.length, 2); assert.equal(f.writes[1].value.length, 1);
  assert.equal(f.store.status().unsaved, 1);
  const first = await tickets[0].committed;
  assert.equal(first.identity, f.documents[0]); assert.equal(first.generation, tickets[0].generation);
  assert.equal(first.committedGeneration, tickets[0].generation); assert.equal(first.changes.length, 100);
  assert.equal(first.checkpoints[0].identity, f.documents[0]); assert.equal(first.checkpoints[0].checkpoint.title, f.documents[0].title);
  assert.equal(first.receipts.length, 100);
  f.writes[1].commit(); assert.equal((await flush).ok, true);
  const last = await tickets[100].committed;
  assert.equal(last.identity, f.documents[100]); assert.equal(last.generation, tickets[100].generation);
  assert.deepEqual(last.changes.map(change => change.key), [f.documents[100].key]);
  assert.deepEqual(f.writes.flatMap(write => write.value.map(change => change.document.notes.one)), f.documents.map(document => document.notes.one));
  assert.equal(f.store.status().unsaved, 0);
});

test('bounded capture keeps an atomic group intact across a transaction boundary', async () => {
  const f = boundedFixture(102);
  for (const document of f.documents.slice(0, 99)) f.store.queueDocument(document.key, document);
  const atomic = f.store.queueDocuments(f.documents.slice(99).map(identity => ({key: identity.key, identity})));
  const flush = f.store.flush();
  assert.equal(f.writes[0].value.length, 99); f.writes[0].commit(); await turn();
  assert.equal(f.writes[1].value.length, 3);
  assert.deepEqual(f.writes[1].value.map(change => change.key), f.documents.slice(99).map(document => document.key));
  f.writes[1].commit(); assert.equal((await flush).ok, true);
  assert.ok((await Promise.all(atomic.tickets.map(ticket => ticket.committed))).every(result => result.changes.length === 3));
});

test('oversized direct and transitively joined atomic groups reject before registration with a nonretryable error', async () => {
  const f = boundedFixture(101);
  const rejected = f.store.queueDocuments(f.documents.map(identity => ({key: identity.key, identity})));
  assert.equal(rejected.accepted, false); assert.equal(f.store.status().generation, 0); assert.equal(f.store.status().unsaved, 0);
  for (const result of await Promise.all(rejected.tickets.map(ticket => ticket.committed))) {
    assert.equal(result.error.code, 'atomic_batch_too_large'); assert.equal(result.error.retryable, false); assert.match(result.error.message, /101.*100/);
  }
  assert.equal((await f.store.flush()).ok, true); assert.equal(f.writes.length, 0);
  const first = f.store.queueDocuments(f.documents.slice(0, 100).map(identity => ({key: identity.key, identity})));
  const before = f.store.status().generation;
  const overlap = f.store.queueDocuments(f.documents.slice(99).map(identity => ({key: identity.key, identity})));
  assert.equal(overlap.accepted, false); assert.equal(f.store.status().generation, before); assert.equal(f.store.status(f.documents[100].key).status, 'saved');
  assert.ok((await Promise.all(overlap.tickets.map(ticket => ticket.committed))).every(result => result.error.retryable === false));
  const flush = f.store.flush(); assert.equal(f.writes[0].value.length, 100); f.writes[0].commit(); assert.equal((await flush).ok, true);
  assert.ok((await Promise.all(first.tickets.map(ticket => ticket.committed))).every(result => result.ok));
});

test('a failed first bounded batch cannot spin or starve its pending successor; fresh intent retries failed content', async () => {
  const f = boundedFixture(101);
  for (const document of f.documents) f.store.queueDocument(document.key, document);
  const flush = f.store.flush(); f.writes[0].fail({code: 'quota'}); await turn();
  assert.equal(f.writes.length, 2); assert.deepEqual(f.writes[1].value.map(change => change.key), [f.documents[100].key]);
  const secondFlush = f.store.flush(); f.writes[1].commit();
  assert.equal((await flush).ok, false); assert.equal((await secondFlush).ok, false);
  await f.timers.tick(10000); assert.equal(f.writes.length, 2); assert.equal(f.store.status().unsaved, 100);
  const last = f.documents[100]; last.notes.one = 'New intent'; f.store.queueDocument(last.key, last);
  const retry = f.store.flush(); assert.equal(f.writes[2].value.length, 100); f.writes[2].commit(); await turn();
  assert.equal(f.writes[3].value.length, 1); f.writes[3].commit(); assert.equal((await retry).ok, true);
});

test('a later edit and replaced identity keep truthful tickets while bounded predecessors drain', async () => {
  const f = boundedFixture(101), original = f.documents[0], last = f.documents[100];
  const old = f.store.queueDocument(original.key, original);
  for (const document of f.documents.slice(1)) f.store.queueDocument(document.key, document);
  const flush = f.store.flush();
  const replacement = {...original, title: 'Replacement identity'}; f.documents = [replacement, ...f.documents.slice(1)];
  const replacing = f.store.queueDocument(replacement.key, replacement);
  last.title = 'Last edited before capture'; const newer = f.store.queueDocument(last.key, last);
  f.writes[0].commit(); await turn();
  assert.equal((await old.committed).identity, original); assert.equal(f.writes[1].value.length, 2);
  assert.equal(f.writes[1].value[0].identity, replacement); assert.equal(f.writes[1].value[1].document.title, last.title);
  f.writes[1].commit(); assert.equal((await flush).ok, true);
  assert.equal((await replacing.committed).identity, replacement); assert.equal((await newer.committed).committedGeneration, newer.generation);
});

test('unknown structural outcome retains its operation and rescue data, blocks discard, and unrelated work cannot replay it', async () => {
  const f = boundedFixture(2), [a, b] = f.documents;
  f.documents = [b]; let rollbacks = 0;
  const removal = f.store.queueDocument(a.key, a, 'remove', {rollback() { rollbacks++; f.documents = [a, b]; return true; }});
  const flush = f.store.flush(); f.writes[0].fail({code: 'uncertain', message: 'Receipt lost'}, {uncertain: true});
  assert.equal((await flush).ok, false); assert.equal((await removal.committed).uncertain, true); assert.equal(rollbacks, 0);
  assert.equal(f.store.status(a.key).status, 'failed'); assert.deepEqual(f.store.snapshotForExport().pendingRemovals, [a.key]);
  const token = f.store.acquireBarrier('unknown-discard');
  assert.equal((await f.store.discardPending(token)).error.code, 'uncertain'); assert.equal(rollbacks, 0); f.store.releaseBarrier(token);
  const independent = f.store.queueDocument(b.key, b); const savingB = f.store.flush();
  assert.deepEqual(f.writes[1].value.map(change => change.key), [b.key]); f.writes[1].commit();
  assert.equal((await independent.committed).ok, true); assert.equal((await savingB).ok, false); assert.equal(f.store.status().unsaved, 1);
  const retry = f.store.retry(a.key); assert.deepEqual(f.writes[2].value.map(change => change.key), [a.key]);
  f.writes[2].commit(); assert.equal((await retry).ok, true); assert.equal(rollbacks, 0); assert.equal(f.store.status(a.key), null);
});

test('discard begun before an uncertain result cannot claim a confirmed discard', async () => {
  const f = boundedFixture(1), a = f.documents[0]; f.documents = []; let rollbacks = 0;
  f.store.queueDocument(a.key, a, 'remove', {rollback() { rollbacks++; return true; }});
  const flush = f.store.flush(), token = f.store.acquireBarrier('inflight-discard'), discard = f.store.discardPending(token);
  f.writes[0].fail({code: 'uncertain'}, {uncertain: true});
  assert.equal((await flush).ok, false); assert.equal((await discard).error.code, 'uncertain'); assert.equal(rollbacks, 0);
  assert.deepEqual(f.store.snapshotForExport().pendingRemovals, [a.key]); f.store.releaseBarrier(token);
});

test('new intent on an uncertain atomic member recaptures its whole group, while late edits receive an honest uncertainty receipt', async () => {
  const f = boundedFixture(3), [a, b, c] = f.documents;
  f.store.queueDocuments([a, b].map(identity => ({key: identity.key, identity})));
  const flush = f.store.flush(); a.notes.one = 'Queued before receipt loss'; const late = f.store.queueDocument(a.key, a);
  f.writes[0].fail({code: 'uncertain'}, {uncertain: true}); await flush;
  assert.equal((await late.committed).uncertain, true); await f.timers.tick(1000); assert.equal(f.writes.length, 1);
  f.store.queueDocument(c.key, c); const independent = f.store.flush();
  assert.deepEqual(f.writes[1].value.map(change => change.key), [c.key]); f.writes[1].commit(); assert.equal((await independent).ok, false);
  const newer = f.store.queueDocument(a.key, a), retry = f.store.flush();
  assert.deepEqual(f.writes[2].value.map(change => change.key), [a.key, b.key]); f.writes[2].commit();
  assert.equal((await newer.committed).ok, true); assert.equal((await retry).ok, true);
});

test('a keyed conflict in a bounded batch isolates its atomic group and drains independent successors', async () => {
  const f = boundedFixture(3, 2), [a, b, c] = f.documents;
  const atomic = f.store.queueDocuments([a, c].map(identity => ({key: identity.key, identity})));
  const independent = f.store.queueDocument(b.key, b), flush = f.store.flush();
  assert.deepEqual(f.writes[0].value.map(change => change.key), [a.key, c.key]);
  f.writes[0].fail({code: 'conflict'}, {key: c.key}); await turn();
  assert.deepEqual(f.writes[1].value.map(change => change.key), [b.key]); f.writes[1].commit();
  assert.equal((await independent.committed).ok, true); assert.equal((await flush).ok, false);
  assert.ok((await Promise.all(atomic.tickets.map(ticket => ticket.committed))).every(result => result.status === 'conflict'));
  assert.equal(f.store.status().unsaved, 2); await f.timers.tick(10000); assert.equal(f.writes.length, 2);
});

test('joining an uncertain group cannot silently re-enable a known CAS conflict or roll back uncertain structure', async () => {
  const f = boundedFixture(2), [a, b] = f.documents;
  f.store.queueDocument(a.key, a); const first = f.store.flush(); f.writes[0].fail({code: 'conflict'}, {key: a.key}); await first;
  f.documents = [a]; let rollbacks = 0;
  f.store.queueDocument(b.key, b, 'remove', {rollback() { rollbacks++; f.documents = [a, b]; return true; }});
  const removal = f.store.flush(); f.writes[1].fail({code: 'uncertain'}, {uncertain: true}); await removal;
  const joined = f.store.queueDocuments([{key: b.key, identity: b, kind: 'remove'}, {key: a.key, identity: a}]);
  assert.ok((await Promise.all(joined.tickets.map(ticket => ticket.committed))).every(result => result.uncertain));
  assert.equal((await f.store.flush()).ok, false); await f.timers.tick(10000);
  assert.equal(f.writes.length, 2); assert.equal(rollbacks, 0); assert.deepEqual(f.store.snapshotForExport().pendingRemovals, [b.key]);
  const retry = f.store.retry(a.key); assert.equal(f.writes[2].value.length, 2); f.writes[2].commit(); assert.equal((await retry).ok, true);
});

test('byte-aware packing keeps independent documents and atomic groups within both limits', async () => {
  const f = boundedFixture(5, 100, 600);
  const size = document => new TextEncoder().encode(JSON.stringify(document)).length;
  for (const document of f.documents) { document.notes.one = 'x'.repeat(200 - size(document)); }
  const tickets = f.documents.slice(0, 3).map(document => f.store.queueDocument(document.key, document));
  const atomic = f.store.queueDocuments(f.documents.slice(3).map(identity => ({key: identity.key, identity})));
  const flush = f.store.flush();
  assert.equal(f.writes[0].value.length, 2); f.writes[0].commit(); await turn();
  assert.equal(f.writes[1].value.length, 1); f.writes[1].commit(); await turn();
  assert.deepEqual(f.writes[2].value.map(change => change.key), f.documents.slice(3).map(document => document.key));
  f.writes[2].commit(); assert.equal((await flush).ok, true);
  assert.ok((await Promise.all([...tickets, ...atomic.tickets].map(ticket => ticket.committed))).every(result => result.ok));
});

test('restore preflight rejects byte overflow before identities enter the live library and sees transitive dependencies', async () => {
  const f = boundedFixture(0, 100, 600), a = doc('proposed-a'), b = doc('proposed-b'), c = doc('proposed-c');
  for (const document of [a, b, c]) document.notes.one = 'x'.repeat(80);
  const before = f.store.status();
  const rejected = f.store.preflightDocuments([a, b, c].map(identity => ({key: identity.key, identity})));
  assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'atomic_batch_too_large'); assert.equal(rejected.error.retryable, false);
  assert.deepEqual(f.store.status(), before); assert.equal(f.documents.length, 0); assert.equal(f.writes.length, 0);
  f.documents = [a, b]; f.store.queueDocuments([a, b].map(identity => ({key: identity.key, identity})));
  assert.equal(f.store.preflightDocuments([{key: b.key, identity: b}, {key: c.key, identity: c}]).ok, false);
  const flush = f.store.flush(); f.writes[0].commit(); assert.equal((await flush).ok, true);
});

test('oversized edited content remains dirty and exportable, preserves an older captured receipt, and recovers after reduction', async () => {
  const f = boundedFixture(1, 100, 500), a = f.documents[0];
  const older = f.store.queueDocument(a.key, a), firstFlush = f.store.flush();
  a.notes.one = '雪'.repeat(300); const oversized = f.store.queueDocument(a.key, a);
  assert.equal(oversized.accepted, true, 'changed content is registered for rescue even though it cannot save');
  const failed = await oversized.committed;
  assert.equal(failed.error.code, 'atomic_batch_too_large'); assert.equal(failed.error.retryable, false);
  assert.equal(f.store.status(a.key).status, 'failed'); assert.equal(f.store.status(a.key).generation, oversized.generation);
  assert.equal(f.store.snapshotForExport().documents[0].notes.one, a.notes.one);
  f.writes[0].commit(); assert.equal((await older.committed).ok, true); assert.equal((await firstFlush).ok, true);
  assert.equal(f.store.status(a.key).status, 'failed'); await f.timers.tick(10000); assert.equal(f.writes.length, 1);
  a.notes.one = 'Reduced'; const reduced = f.store.queueDocument(a.key, a), retry = f.store.flush();
  f.writes[1].commit(); assert.equal((await reduced.committed).ok, true); assert.equal((await retry).ok, true);
});

test('a group that grows past its byte budget after enqueue fails without starving a valid successor', async () => {
  const f = boundedFixture(2, 100, 500), [a, b] = f.documents;
  const tooLarge = f.store.queueDocument(a.key, a), valid = f.store.queueDocument(b.key, b);
  a.notes.one = 'x'.repeat(600);
  const flush = f.store.flush(); await turn();
  assert.equal((await tooLarge.committed).error.code, 'atomic_batch_too_large');
  assert.deepEqual(f.writes[0].value.map(change => change.key), [b.key]); f.writes[0].commit();
  assert.equal((await valid.committed).ok, true); assert.equal((await flush).ok, false);
  await f.timers.tick(10000); assert.equal(f.writes.length, 1); assert.equal(f.store.snapshotForExport().documents[0].notes.one, a.notes.one);
});

test('oversized new text cannot roll back a structural peer already captured in the earlier atomic generation', async () => {
  const f = boundedFixture(2, 100, 600), [a, b] = f.documents; f.documents = [a]; let rollbacks = 0;
  const atomic = f.store.queueDocuments([{key: a.key, identity: a}, {key: b.key, identity: b, kind: 'remove', rollback() { rollbacks++; f.documents = [a, b]; return true; }}]);
  const flush = f.store.flush(); a.notes.one = 'x'.repeat(700);
  const failed = f.store.queueDocument(a.key, a); assert.equal((await failed.committed).error.code, 'atomic_batch_too_large');
  assert.equal(rollbacks, 0); assert.equal(f.store.status(b.key).status, 'pending');
  f.writes[0].commit(); assert.equal((await flush).ok, true);
  assert.ok((await Promise.all(atomic.tickets.map(ticket => ticket.committed))).every(result => result.ok));
  assert.equal(rollbacks, 0); assert.equal(f.store.status(b.key), null); assert.equal(f.store.status(a.key).status, 'failed');
});
