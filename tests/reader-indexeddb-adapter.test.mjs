import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {transactionDouble} from './helpers/indexeddb-transaction-double.mjs';
const {create, LEGACY_KEY, FENCE_KEY, hashRaw} = createRequire(import.meta.url)('../reader/indexeddb-document-adapter.js');
const document = key => ({key, title: key, segments: [{id: 'one', text: 'Authored text'}], notes: {}, ai_answers: []});
function storage(raw = JSON.stringify({documents: []})) {
  const values = new Map(raw === null ? [] : [[LEGACY_KEY, raw]]), writes = [];
  return {values, writes, getItem: key => values.get(key) ?? null,
    setItem(key, value) { values.set(key, value); writes.push({key, value}); }};
}
function fixture({raw, validate, checkpoint, summarize} = {}) {
  const engine = transactionDouble(), legacy = storage(raw), options = {indexedDB: engine.indexedDB, name: 'test',
    getLegacyStorage: () => legacy, validate, checkpoint, summarize};
  return {engine, legacy, options, adapter: create(options)};
}
const expected = (epoch = 1, revision = 1) => ({epoch, revision});
let mutationSequence = 0;
const change = (kind, key, fields = {}) => ({kind, key, document: document(key), generation: 1,
  mutationId: `${kind}:${key}:${++mutationSequence}`, expected: kind === 'create' ? null : expected(), ...fields});
async function write(adapter, ...changes) { return adapter.commit(adapter.prepare(changes)); }

test('partial migration preserves exact raw text and unknown fields but quarantines fail closed', async () => {
  const a = {...document('a'), unknown: {history: ['untouched']}};
  const raw = ' {"documents": ' + JSON.stringify([a, document('dup'), document('dup'), {key: ''}, {...document('bad'), bad: true}]) + ', "active": "a" } ';
  const f = fixture({raw, validate(doc) { if (doc.bad) throw new Error('bad document'); doc.unknown = null; return {key: doc.key}; }});
  const result = await f.adapter.ready(); assert.equal(result.ok, false); assert.equal(result.error.code, 'corruption');
  assert.equal(f.adapter.status().writable, false);
  assert.deepEqual(result.report.importedKeys, ['a']); assert.equal(result.report.quarantine.length, 4);
  assert.equal((await f.adapter.readLegacySnapshot()).value.raw, raw);
  assert.equal(f.legacy.getItem(LEGACY_KEY), raw); assert.ok(f.legacy.getItem(FENCE_KEY));
  assert.deepEqual((await f.adapter.readDocument('a')).document.payload.unknown, {history: ['untouched']});
  assert.equal((await f.adapter.loadLibrary()).error.code, 'corruption');
  assert.equal((await create(f.options).ready()).error.code, 'corruption');
  assert.equal((await write(f.adapter, change('create', 'new'))).ok, false);
});

test('receipt waits for transaction complete, captures generation/checkpoint, and clones only dirty document', async () => {
  const f = fixture({raw: JSON.stringify({documents: [document('a'), document('b')]}), checkpoint: doc => ({answers: doc.ai_answers.length})});
  await f.adapter.ready(); f.engine.operations.length = 0;
  const a = document('a'); a.ai_answers.push({answer: 'first'});
  const capture = f.adapter.prepare([change('update', 'a', {document: a, generation: 7})]);
  a.ai_answers.push({answer: 'newer'}); f.engine.control.holdNextWrite = true;
  let settled = false; const pending = f.adapter.commit(capture).then(value => { settled = true; return value; });
  await f.engine.tick(); assert.equal(settled, false); assert.equal(f.engine.control.held.length, 1);
  assert.equal(f.engine.rows().get('documents').get('a').revision, 1);
  f.engine.control.held.shift().complete(); const result = await pending;
  assert.equal(result.ok, true); assert.equal(result.receipts[0].generation, 7); assert.deepEqual(result.receipts[0].checkpoint, {answers: 1});
  assert.equal((await f.adapter.readDocument('a')).document.payload.ai_answers.length, 1);
  assert.equal(f.engine.operations.filter(op => op.store === 'documents' && op.op === 'put').length, 1);
  assert.equal(f.engine.operations.some(op => op.key === 'b'), false);
});

test('request success then abort cannot produce a save receipt or partial document/catalog writes', async () => {
  const f = fixture({raw: JSON.stringify({documents: [document('a')]})}); await f.adapter.ready();
  const controller = new AbortController(); f.engine.control.holdNextWrite = true;
  const pending = f.adapter.commit(f.adapter.prepare([change('update', 'a')]), {signal: controller.signal});
  await f.engine.tick(); assert.equal(f.engine.control.held.length, 1); controller.abort();
  assert.equal((await pending).status, 'cancelled'); assert.equal(f.engine.rows().get('documents').get('a').revision, 1);
  assert.equal(f.engine.rows().get('catalog').get('a').revision, 1);
});

test('abort after committed terminal event reports saved truthfully', async () => {
  const f = fixture(); await f.adapter.ready(); const controller = new AbortController();
  const result = await f.adapter.commit(f.adapter.prepare([change('create', 'a')]), {signal: controller.signal});
  controller.abort(); assert.equal(result.ok, true); assert.ok((await f.adapter.readDocument('a')).document);
});

test('two connections preserve independent keys; same-key stale CAS is a local conflict', async () => {
  const f = fixture({raw: JSON.stringify({documents: [document('a'), document('b')]})}); await f.adapter.ready();
  const other = create(f.options); await other.ready();
  const results = await Promise.all([write(f.adapter, change('update', 'a')), write(other, change('update', 'b'))]);
  assert.ok(results.every(result => result.ok));
  const conflict = await write(other, change('update', 'a')); assert.equal(conflict.status, 'conflict'); assert.equal(conflict.key, 'a');
  assert.equal((await write(other, change('update', 'b', {expected: expected(1, 2)}))).ok, true);
});

test('atomic multi-document command rejects all changes if any CAS fails', async () => {
  const f = fixture({raw: JSON.stringify({documents: [document('a'), document('b')]})}); await f.adapter.ready();
  const result = await write(f.adapter, change('update', 'a'), change('update', 'b', {expected: expected(1, 9)}));
  assert.equal(result.status, 'conflict'); assert.equal((await f.adapter.readDocument('a')).document.revision, 1);
});

test('delete tombstone blocks stale callbacks and create; explicit restore changes epoch and rejects ABA', async () => {
  const f = fixture({raw: JSON.stringify({documents: [document('a')]})}); await f.adapter.ready();
  assert.equal((await write(f.adapter, change('remove', 'a'))).ok, true);
  const tomb = (await f.adapter.readTombstone('a')).value;
  assert.equal(tomb.revision, 2); assert.equal('payload' in tomb, false); assert.equal((await f.adapter.readDocument('a')).document, null);
  assert.equal((await write(f.adapter, change('update', 'a'))).status, 'conflict');
  assert.equal((await write(f.adapter, change('create', 'a'))).status, 'conflict');
  assert.equal((await write(f.adapter, change('restore', 'a', {expected: expected(1, 2)}))).ok, true);
  const restored = (await f.adapter.readDocument('a')).document; assert.equal(restored.epoch, 2); assert.equal(restored.revision, 3);
  assert.equal((await write(f.adapter, change('update', 'a', {expected: expected(1, 3)}))).status, 'conflict');
  const reopened = create(f.options); await reopened.ready();
  assert.equal((await write(reopened, change('update', 'a'))).status, 'conflict');
});

test('quota during second mutation rolls back document and catalog; retry uses unchanged expected revision', async () => {
  const f = fixture({raw: JSON.stringify({documents: [document('a')]})}); await f.adapter.ready(); f.engine.control.failMutation = 2;
  const capture = f.adapter.prepare([change('update', 'a')]); const result = await f.adapter.commit(capture);
  assert.equal(result.error.code, 'quota'); assert.equal((await f.adapter.readDocument('a')).document.revision, 1);
  assert.equal(f.engine.rows().get('catalog').get('a').revision, 1); assert.equal((await f.adapter.commit(capture)).ok, true);
});

test('each interrupted migration mutation is rolled back and reopen can retry without duplicates', async () => {
  for (let index = 1; index <= 6; index++) {
    const raw = JSON.stringify({documents: [document('a'), document('b')]}); const f = fixture({raw}); f.engine.control.failMutation = index;
    const result = await f.adapter.ready(); assert.equal(result.ok, false, `mutation ${index}`);
    assert.equal(f.engine.rows().get('documents').size, 0); assert.equal(f.engine.rows().get('meta').size, 0);
    assert.equal(f.legacy.getItem(LEGACY_KEY), raw); assert.ok(f.legacy.getItem(FENCE_KEY));
    f.adapter.close(); const retried = create(f.options); assert.equal((await retried.ready()).ok, true);
    assert.equal((await retried.loadCatalog()).catalog.length, 2);
  }
});

test('malformed JSON gets a committed raw backup and recovery state, never a writable empty replacement', async () => {
  const raw = '{"documents": [broken'; const f = fixture({raw}); const result = await f.adapter.ready();
  assert.equal(result.error.code, 'corruption'); assert.equal((await f.adapter.readLegacySnapshot()).value.raw, raw);
  assert.equal(f.adapter.status().writable, false); assert.equal((await write(f.adapter, change('create', 'a'))).ok, false);
  assert.equal(f.legacy.getItem(LEGACY_KEY), raw);
  assert.equal((await create(f.options).ready()).error.code, 'corruption');
});

test('legacy late write is surfaced for recovery; IDB remains authoritative and is not reimported', async () => {
  const f = fixture({raw: JSON.stringify({documents: [document('a')]})}); await f.adapter.ready();
  const newer = {...document('a'), title: 'new IDB content'}; await write(f.adapter, change('update', 'a', {document: newer}));
  const late = JSON.stringify({documents: [{...document('a'), title: 'late old client'}]}); f.legacy.values.set(LEGACY_KEY, late);
  assert.deepEqual(await f.adapter.checkLegacy(), {ok: true, changed: true, raw: late});
  const other = create(f.options); const ready = await other.ready(); assert.equal(ready.error.code, 'legacy-changed'); assert.equal(ready.legacy.changed, true);
  assert.equal((await write(f.adapter, change('update', 'a', {expected: expected(1, 2)}))).error.code, 'legacy-changed');
  assert.equal(f.adapter.status().writable, false); assert.equal(other.status().writable, false);
  assert.equal((await other.readDocument('a')).document.payload.title, 'new IDB content');
});

test('legacy mutation while hash is pending prevents any migration import', async () => {
  const f = fixture(); const adapter = create({...f.options, hash: async raw => { f.legacy.values.set(LEGACY_KEY, '{changed'); return hashRaw(raw); }});
  assert.equal((await adapter.ready()).error.code, 'legacy-changed'); assert.equal(f.engine.rows().get('meta').size, 0);
});

test('corrupt document and failed document request are isolated; raw record remains untouched', async () => {
  const f = fixture({raw: JSON.stringify({documents: [document('a'), document('b')]})}); await f.adapter.ready();
  f.engine.rows().get('documents').get('a').payload = {key: 'wrong'};
  const bad = await f.adapter.readDocument('a'); assert.equal(bad.error.code, 'corruption'); assert.equal(bad.raw.payload.key, 'wrong');
  assert.equal((await f.adapter.readDocument('b')).ok, true);
  assert.equal((await write(f.adapter, change('update', 'a'))).error.code, 'corruption');
  assert.equal((await write(f.adapter, change('update', 'b'))).ok, true);
  f.engine.control.corruptRead = {store: 'documents', key: 'a'};
  assert.equal((await f.adapter.readDocument('a')).ok, false); assert.equal((await f.adapter.readDocument('b')).ok, true);
});

test('blocked open settles explicitly; late unblocked open is abandoned instead of migrating', async () => {
  const f = fixture(); f.engine.control.blocked = true;
  assert.equal((await f.adapter.ready()).error.code, 'blocked'); assert.equal(f.legacy.writes.length, 0);
  f.engine.control.blockedOpens.shift()(); await f.engine.tick();
  assert.equal(f.engine.databases.size, 0); assert.equal(f.engine.connections[0].closed, false, 'upgrade is aborted before connection opens');
});

test('versionchange stops new writes and closes connection while already started transaction can settle', async () => {
  const f = fixture(); await f.adapter.ready(); f.engine.control.holdNextWrite = true;
  const pending = write(f.adapter, change('create', 'a')); await f.engine.tick(); f.engine.versionchange();
  assert.equal(f.adapter.status().state, 'versionchange'); assert.equal(f.engine.connections[0].closed, true);
  assert.equal((await write(f.adapter, change('create', 'b'))).error.code, 'version');
  f.engine.control.held.shift().complete(); assert.equal((await pending).ok, true);
});

test('unavailable, denied, version error and unexpected close never fall back to legacy writes', async () => {
  for (const [name, code] of [['SecurityError', 'denied'], ['VersionError', 'version'], ['InvalidStateError', 'unavailable']]) {
    const f = fixture(); f.engine.control.openError = name; assert.equal((await f.adapter.ready()).error.code, code); assert.equal(f.legacy.writes.length, 0);
  }
  const f = fixture(); await f.adapter.ready(); const raw = f.legacy.getItem(LEGACY_KEY); f.engine.unexpectedClose();
  assert.equal((await write(f.adapter, change('create', 'a'))).error.code, 'unavailable'); assert.equal(f.legacy.getItem(LEGACY_KEY), raw);
});

test('unknown fence and missing migration manifest fail closed without deleting user records', async () => {
  const f = fixture(); f.legacy.values.set(FENCE_KEY, 'future-version'); assert.equal((await f.adapter.ready()).error.code, 'fenced');
  assert.equal(f.legacy.getItem(FENCE_KEY), 'future-version');
  const second = fixture(); await second.adapter.ready(); second.engine.rows().get('meta').delete('state');
  assert.equal((await create(second.options).ready()).error.code, 'corruption'); assert.equal(second.engine.rows().get('legacySnapshots').size, 1);
});

test('capture validation is synchronous, opaque and rejects duplicate commands or mismatched identities', async () => {
  const f = fixture(); await f.adapter.ready();
  assert.throws(() => f.adapter.prepare([change('create', 'a', {document: document('b')})]));
  assert.throws(() => f.adapter.prepare([change('create', 'a'), change('create', 'a')]));
  assert.equal((await f.adapter.commit({})).error.code, 'validation');
  const captured = f.adapter.prepare([change('create', 'a')]); assert.equal(Object.isFrozen(captured), true);
});

test('raw hashing distinguishes lone surrogates, null and literal empty content', async () => {
  assert.notEqual(await hashRaw('\ud800'), await hashRaw('\ud801')); assert.notEqual(await hashRaw(null), await hashRaw(''));
});

test('real DOMException numeric code does not mask denied classification', async () => {
  const f = fixture();
  const adapter = create({...f.options, indexedDB: {open() { throw new DOMException('Access denied', 'SecurityError'); }}});
  assert.equal((await adapter.ready()).error.code, 'denied');
});

test('snapshot tampering fails integrity verification; records and raw remain available without writes', async () => {
  const f = fixture(); await f.adapter.ready(); f.engine.rows().get('legacySnapshots').get('legacy-v1').raw = '{broken';
  const adapter = create(f.options); assert.equal((await adapter.ready()).error.code, 'corruption');
  assert.equal((await adapter.readLegacySnapshot()).value.raw, '{broken'); assert.equal(adapter.status().writable, false);
});

test('catalog order survives update and Undo restore; mismatched catalog is not overwritten', async () => {
  const f = fixture({raw: JSON.stringify({documents: [document('a'), document('b')]})}); await f.adapter.ready();
  await write(f.adapter, change('update', 'b')); assert.equal((await f.adapter.loadCatalog()).catalog.find(row => row.key === 'b').order, 1);
  await write(f.adapter, change('remove', 'b', {expected: expected(1, 2)}));
  await write(f.adapter, change('restore', 'b', {expected: expected(1, 3)}));
  assert.equal((await f.adapter.loadCatalog()).catalog.find(row => row.key === 'b').order, 1);
  f.engine.rows().get('catalog').get('a').revision = 100;
  assert.equal((await write(f.adapter, change('update', 'a'))).error.code, 'corruption');
  assert.equal((await f.adapter.readDocument('a')).document.revision, 1);
});

test('payload-level corruption is not overwritten, and closed adapters cannot replay cached readiness', async () => {
  const f = fixture({raw: JSON.stringify({documents: [document('a')]}), validate(doc) { if (!Array.isArray(doc.segments)) throw new Error('Missing segments'); }});
  await f.adapter.ready(); f.engine.rows().get('documents').get('a').payload.segments = null;
  assert.equal((await write(f.adapter, change('update', 'a'))).error.code, 'corruption');
  assert.equal((await f.adapter.readDocument('a')).raw.payload.segments, null);
  f.adapter.close(); assert.equal((await f.adapter.ready()).error.code, 'unavailable');
});

test('an open queued behind another upgrade has a bounded recoverable timeout and closes late success', async () => {
  const f = fixture(); let request;
  const adapter = create({...f.options, openTimeoutMs: 1, indexedDB: {open() { request = {}; return request; }}});
  const result = await adapter.ready(); assert.equal(result.error.code, 'open-timeout'); assert.equal(f.legacy.writes.length, 0);
  let closed = false; request.result = {close() { closed = true; }}; request.onsuccess(); assert.equal(closed, true);
});

test('delete/restore epochs reject a stale client across a reopen with tombstone still present', async () => {
  const f = fixture({raw: JSON.stringify({documents: [document('a')]})}); await f.adapter.ready();
  await write(f.adapter, change('remove', 'a')); f.adapter.close();
  const reopened = create(f.options); await reopened.ready();
  assert.equal((await write(reopened, change('create', 'a'))).status, 'conflict');
  assert.equal((await write(reopened, change('update', 'a'))).status, 'conflict');
  assert.equal((await reopened.readTombstone('a')).value.revision, 2);
});

test('pre-aborted signal creates no write transaction; newer schema metadata stops an already ready writer', async () => {
  const f = fixture(); await f.adapter.ready(); const before = f.engine.transactions.length, controller = new AbortController(); controller.abort();
  const result = await f.adapter.commit(f.adapter.prepare([change('create', 'a')]), {signal: controller.signal});
  assert.equal(result.status, 'cancelled'); assert.equal(f.engine.transactions.length, before);
  f.engine.rows().get('meta').get('state').minReader = 2;
  assert.equal((await write(f.adapter, change('create', 'a'))).error.code, 'version');
  assert.equal(f.engine.rows().get('documents').size, 0);
});

test('initial migration readback accepts a legitimate concurrent tombstone rather than reporting corruption', async () => {
  const f = fixture({raw: JSON.stringify({documents: [document('a')]})}); let hashes = 0;
  const adapter = create({...f.options, hash: async raw => {
    const digest = await hashRaw(raw);
    if (++hashes === 2) {
      const stores = f.engine.rows(), current = stores.get('documents').get('a');
      stores.get('documents').delete('a'); stores.get('catalog').delete('a');
      stores.get('tombstones').set('a', {envelopeVersion: 1, key: 'a', epoch: current.epoch, revision: 2, deleted: true, generation: 1, mutationId: 'concurrent-remove', order: 0});
    }
    return digest;
  }});
  assert.equal((await adapter.ready()).ok, true); assert.equal((await adapter.readDocument('a')).document, null);
});

test('catalog identity corruption rejects the coherent library without hiding the bad row', async () => {
  const f = fixture({raw: JSON.stringify({documents: [document('a'), document('b')]})}); await f.adapter.ready();
  f.engine.rows().get('catalog').get('a').key = 'wrong';
  const result = await f.adapter.loadCatalog(); assert.equal(result.error.code, 'corruption');
  assert.equal(result.key, 'a'); assert.equal(result.raw.key, 'wrong'); assert.equal(result.catalog, undefined);
  assert.equal((await f.adapter.readDocument('a')).document.payload.key, 'a');
});

test('coherent library reads every row store in one readonly transaction and retains legacy active metadata', async () => {
  const raw = ' {"documents": ' + JSON.stringify([document('z'), document('a')]) + ', "active": "z", "future": {"untouched": true} } ';
  const f = fixture({raw}); await f.adapter.ready(); f.engine.transactions.length = 0;
  const loaded = await f.adapter.loadLibrary();
  assert.equal(loaded.ok, true); assert.equal(loaded.legacyRaw, raw);
  assert.deepEqual(loaded.documents.map(row => row.key), ['z', 'a']);
  assert.deepEqual(loaded.catalog.map(row => row.key), ['z', 'a']); assert.deepEqual(loaded.tombstones, []);
  assert.equal(f.engine.transactions.length, 1); assert.equal(f.engine.transactions[0].mode, 'readonly');
  assert.deepEqual(new Set(f.engine.transactions[0].names), new Set(['meta', 'documents', 'catalog', 'tombstones']));
});

test('library rejects every missing, orphan, invalid-token and inconsistent live/tombstone row', async () => {
  const corruptions = [
    rows => rows.get('catalog').delete('a'),
    rows => rows.get('documents').delete('a'),
    rows => { rows.get('documents').delete('a'); rows.get('catalog').delete('a'); },
    rows => { rows.get('catalog').get('a').revision++; },
    rows => { rows.get('catalog').get('a').order = -1; },
    rows => { rows.get('documents').get('a').epoch = 0; },
    rows => { rows.get('documents').get('a').payload.segments = null; },
    rows => rows.get('documents').set('orphan', {...rows.get('documents').get('a'), key: 'orphan', payload: document('orphan')}),
    rows => rows.get('catalog').set('orphan', {...rows.get('catalog').get('a'), key: 'orphan'}),
    rows => rows.get('tombstones').set('a', {envelopeVersion: 1, key: 'a', epoch: 1, revision: 2, generation: 1, mutationId: 'remove-a', deleted: true, order: 0}),
    rows => rows.get('tombstones').set('bad', {envelopeVersion: 1, key: 'wrong', epoch: 1, revision: 2, generation: 1, mutationId: 'remove-bad', deleted: true, order: 0})
  ];
  for (const mutate of corruptions) {
    const f = fixture({raw: JSON.stringify({documents: [document('a'), document('b')]}), validate(doc) { if (!Array.isArray(doc.segments)) throw new Error('Invalid segments'); }});
    assert.equal((await f.adapter.ready()).ok, true); mutate(f.engine.rows());
    const loaded = await f.adapter.loadLibrary(); assert.equal(loaded.error.code, 'corruption', mutate.toString()); assert.equal(loaded.documents, undefined);
    const reopened = create(f.options); assert.equal((await reopened.ready()).error.code, 'corruption'); assert.equal(reopened.status().writable, false);
  }
});

test('exact initial migration payload verification catches valid-but-lossy readback and reopen', async () => {
  for (const duringMigration of [true, false]) {
    const raw = JSON.stringify({documents: [{...document('a'), unknown: {nested: 'must survive'}}]});
    const f = fixture({raw}); let hashes = 0;
    const adapter = create({...f.options, hash: async value => {
      const digest = await hashRaw(value);
      if (duringMigration && ++hashes === 2) delete f.engine.rows().get('documents').get('a').payload.unknown;
      return digest;
    }});
    if (duringMigration) assert.equal((await adapter.ready()).error.code, 'corruption');
    else {
      assert.equal((await adapter.ready()).ok, true); delete f.engine.rows().get('documents').get('a').payload.unknown;
      assert.equal((await create(f.options).ready()).error.code, 'corruption');
    }
    assert.equal((await adapter.readLegacySnapshot()).value.raw, raw); assert.equal(f.legacy.getItem(LEGACY_KEY), raw);
  }
});

test('creates append in command order, updates and Undo preserve order, explicit order survives reopen', async () => {
  const f = fixture({raw: JSON.stringify({documents: [document('z'), document('a')]})}); await f.adapter.ready();
  assert.equal((await write(f.adapter, change('create', 'y'), change('create', 'b'))).ok, true);
  assert.equal((await write(f.adapter, change('update', 'z', {order: 999}))).ok, true);
  await write(f.adapter, change('remove', 'a')); await write(f.adapter, change('restore', 'a', {expected: expected(1, 2)}));
  assert.deepEqual((await f.adapter.loadLibrary()).documents.map(row => row.key), ['z', 'a', 'y', 'b']);
  assert.equal((await write(f.adapter, change('create', 'q', {order: 50}))).ok, true);
  assert.equal((await write(f.adapter, change('create', 'p'))).ok, true);
  f.adapter.close(); const reopened = create(f.options); assert.equal((await reopened.ready()).ok, true);
  assert.deepEqual((await reopened.loadLibrary()).catalog.map(row => [row.key, row.order]), [['z', 0], ['a', 1], ['y', 2], ['b', 3], ['q', 50], ['p', 51]]);
});

test('concurrent creates reserve disjoint append order through the shared manifest', async () => {
  const f = fixture(); await f.adapter.ready(); const other = create(f.options); await other.ready();
  const results = await Promise.all([write(f.adapter, change('create', 'z')), write(other, change('create', 'a'))]);
  assert.ok(results.every(result => result.ok));
  assert.deepEqual((await f.adapter.loadLibrary()).catalog.map(row => [row.key, row.order]), [['z', 0], ['a', 1]]);
});

test('removing an unsaved document atomically tombstones absence and permits explicit Undo restore', async () => {
  const f = fixture(); await f.adapter.ready();
  const removed = await write(f.adapter, change('remove', 'new', {expected: null}));
  assert.equal(removed.ok, true); assert.equal(removed.receipts[0].revision, 1); assert.equal(removed.receipts[0].epoch, 1);
  assert.equal((await f.adapter.loadLibrary()).tombstones[0].key, 'new');
  assert.equal((await write(f.adapter, change('create', 'new'))).status, 'conflict');
  assert.equal((await write(f.adapter, change('remove', 'new', {expected: null}))).status, 'conflict');
  assert.equal((await write(f.adapter, change('restore', 'new'))).ok, true);
  const row = (await f.adapter.readDocument('new')).document; assert.equal(row.epoch, 2); assert.equal(row.revision, 2);
  assert.equal((await write(f.adapter, change('remove', 'new', {expected: null}))).status, 'conflict');
});

test('missing or changed migration fence blocks writes and coherent reads without touching either copy', async () => {
  for (const fence of [null, 'different-writer']) {
    const f = fixture({raw: JSON.stringify({documents: [document('a')]})}); await f.adapter.ready();
    if (fence === null) f.legacy.values.delete(FENCE_KEY); else f.legacy.values.set(FENCE_KEY, fence);
    const result = await write(f.adapter, change('update', 'a')); assert.equal(result.error.code, 'legacy-changed');
    assert.equal((await f.adapter.loadLibrary()).error.code, 'legacy-changed');
    assert.equal((await f.adapter.ready()).error.code, 'legacy-changed'); assert.equal(f.adapter.status().writable, false);
    assert.equal(f.engine.rows().get('documents').get('a').revision, 1); assert.equal(f.legacy.getItem(FENCE_KEY), fence);
    assert.equal((await create(f.options).ready()).error.code, 'legacy-changed');
  }
});

test('ordinary commits do not hash or reload the full immutable source', async () => {
  const f = fixture({raw: JSON.stringify({documents: [document('a'), document('b')]})}); let hashes = 0;
  const adapter = create({...f.options, hash: async raw => { hashes++; return hashRaw(raw); }}); await adapter.ready();
  const initialHashes = hashes; f.engine.operations.length = 0;
  await write(adapter, change('update', 'a')); await write(adapter, change('update', 'a', {expected: expected(1, 2)}));
  assert.equal(hashes, initialHashes);
  assert.equal(f.engine.operations.some(op => op.store === 'legacySnapshots' || op.op === 'getAll' || op.op === 'getAllKeys' || op.key === 'b'), false);
});

test('a queued writer checks the legacy fence again after another transaction releases', async () => {
  const f = fixture(); await f.adapter.ready(); f.engine.control.holdNextWrite = true;
  const first = write(f.adapter, change('create', 'a')); await f.engine.tick();
  const second = write(f.adapter, change('create', 'b')); await f.engine.tick();
  f.legacy.values.set(LEGACY_KEY, '{"documents":[],"oldClientChanged":true}');
  f.engine.control.held.shift().complete(); assert.equal((await first).ok, true);
  assert.equal((await second).error.code, 'legacy-changed');
  assert.equal(f.engine.rows().get('documents').has('a'), true); assert.equal(f.engine.rows().get('documents').has('b'), false);
});

test('coherent load cannot mix catalog from before a queued update with payload from after it', async () => {
  const f = fixture({raw: JSON.stringify({documents: [document('a')]})}); await f.adapter.ready();
  f.engine.control.holdNextRead = true; const loading = f.adapter.loadLibrary(); await f.engine.tick();
  const writing = write(f.adapter, change('update', 'a', {document: {...document('a'), title: 'updated'}})); await f.engine.tick();
  f.engine.control.held.shift().complete(); const before = await loading;
  assert.equal(before.catalog[0].revision, 1); assert.equal(before.documents[0].revision, 1); assert.equal(before.documents[0].payload.title, 'a');
  assert.equal((await writing).ok, true); const after = await f.adapter.loadLibrary();
  assert.equal(after.catalog[0].revision, 2); assert.equal(after.documents[0].revision, 2); assert.equal(after.catalog[0].title, 'updated');
});

test('shutdown waits for the actual abort event and returns no false save receipt', async () => {
  const f = fixture(); await f.adapter.ready(); f.engine.control.holdNextWrite = true;
  let writeSettled = false; const writing = write(f.adapter, change('create', 'a')).then(result => { writeSettled = true; return result; });
  await f.engine.tick(); f.engine.control.holdAbortEvents = true;
  let shutdownSettled = false; const stopping = f.adapter.shutdown().then(result => { shutdownSettled = true; return result; });
  await f.engine.tick();
  assert.equal(writeSettled, false); assert.equal(shutdownSettled, false); assert.equal(f.adapter.status().state, 'closed');
  assert.equal(f.engine.control.abortEvents.length, 1); f.engine.control.abortEvents.shift()();
  const stopped = await stopping; assert.equal(stopped.status, 'closed'); assert.equal(stopped.transactions[0].status, 'cancelled');
  assert.equal((await writing).status, 'cancelled'); assert.equal(f.engine.rows().get('documents').size, 0);
  assert.equal((await write(f.adapter, change('create', 'b'))).error.code, 'unavailable');
});

test('shutdown aborts migration atomically but permanently preserves legacy data and fence', async () => {
  const raw = JSON.stringify({documents: [document('a')]}); const f = fixture({raw});
  const adapter = create({...f.options, hash: async () => 'a'.repeat(64)});
  f.engine.control.holdNextWrite = true; const starting = adapter.ready(); await f.engine.tick();
  assert.equal(f.engine.control.held.length, 1); f.engine.control.holdAbortEvents = true;
  const stopping = adapter.shutdown(); await f.engine.tick(); assert.equal(f.engine.control.abortEvents.length, 1);
  f.engine.control.abortEvents.shift()(); await stopping;
  assert.equal((await starting).status, 'cancelled'); assert.equal(f.engine.rows().get('meta').size, 0);
  assert.equal(f.engine.rows().get('documents').size, 0); assert.equal(f.legacy.getItem(LEGACY_KEY), raw); assert.ok(f.legacy.getItem(FENCE_KEY));
  assert.equal(adapter.status().state, 'closed');
  assert.equal((await create(f.options).ready()).ok, true);
});

test('shutdown cancels an indefinitely pending open immediately and refuses every late upgrade', async () => {
  const f = fixture(); let request;
  const adapter = create({...f.options, indexedDB: {open() { request = {}; return request; }}});
  const starting = adapter.ready(); const stopped = await adapter.shutdown();
  assert.equal(stopped.status, 'closed'); assert.equal((await starting).status, 'cancelled'); assert.equal(f.legacy.writes.length, 0);
  let aborted = false, closed = false;
  request.transaction = {abort() { aborted = true; }}; request.result = {close() { closed = true; }};
  request.onupgradeneeded({oldVersion: 0}); assert.equal(aborted, true);
  request.onsuccess(); assert.equal(closed, true); assert.equal(adapter.status().state, 'closed');
});

test('shutdown during migration hashing admits no later transaction', async () => {
  const f = fixture(); let release;
  const adapter = create({...f.options, hash: () => new Promise(resolve => { release = resolve; })});
  const starting = adapter.ready(); await f.engine.tick(); assert.equal(typeof release, 'function');
  await adapter.shutdown(); const count = f.engine.transactions.length; release('a'.repeat(64));
  assert.equal((await starting).error.code, 'unavailable'); assert.equal(f.engine.transactions.length, count);
  assert.equal(f.engine.rows().get('meta').size, 0); assert.equal(adapter.status().state, 'closed');
});

test('completed writes remain saved when shutdown follows their terminal event', async () => {
  const f = fixture(); await f.adapter.ready();
  const result = await write(f.adapter, change('create', 'a')); const stopped = await f.adapter.shutdown();
  assert.equal(result.status, 'saved'); assert.deepEqual(stopped.transactions, []); assert.equal(f.engine.rows().get('documents').has('a'), true);
});

test('an already-ready writer cannot overwrite lossy initial payloads or recreate unexplained missing migrated rows', async () => {
  for (const disappear of [false, true]) {
    const f = fixture({raw: JSON.stringify({documents: [{...document('a'), unknown: 'preserve'}]})}); await f.adapter.ready();
    if (disappear) { f.engine.rows().get('documents').delete('a'); f.engine.rows().get('catalog').delete('a'); }
    else delete f.engine.rows().get('documents').get('a').payload.unknown;
    const result = await write(f.adapter, change(disappear ? 'create' : 'update', 'a')); assert.equal(result.error.code, 'corruption');
    assert.equal(f.engine.rows().get('documents').has('a'), !disappear);
    if (!disappear) assert.equal((await f.adapter.readDocument('a')).error.code, 'corruption');
  }
});

test('impossible epoch/revision identities and revision-one tombstones for migrated rows are corrupt', async () => {
  for (const mutate of [
    rows => { rows.get('documents').get('a').epoch = 2; rows.get('catalog').get('a').epoch = 2; },
    rows => {
      rows.get('documents').delete('a'); rows.get('catalog').delete('a');
      rows.get('tombstones').set('a', {envelopeVersion: 1, key: 'a', epoch: 1, revision: 1, generation: 1, mutationId: 'impossible', deleted: true, order: 0});
    }
  ]) {
    const f = fixture({raw: JSON.stringify({documents: [document('a')]})}); await f.adapter.ready(); mutate(f.engine.rows());
    assert.equal((await f.adapter.loadLibrary()).error.code, 'corruption');
    assert.equal((await write(f.adapter, change('restore', 'a'))).error.code, 'corruption');
  }
});

test('ready returns its exact coherent startup snapshot without requiring a second full load', async () => {
  const f = fixture({raw: JSON.stringify({documents: [document('a')]})});
  const result = await f.adapter.ready(); assert.equal(result.library.ok, true); assert.equal(result.library.documents[0].key, 'a');
  const scans = f.engine.operations.filter(op => op.store === 'documents' && op.op === 'getAll'); assert.equal(scans.length, 1);
});

test('raw recovery export retains corrupt rows, orphan rows, missing-row evidence and exact source without writes', async () => {
  const raw = ' {"documents":' + JSON.stringify([document('a'), document('b')]) + '} ';
  const f = fixture({raw}); await f.adapter.ready();
  f.engine.rows().get('documents').get('a').payload.key = 'broken';
  f.engine.rows().get('catalog').delete('b');
  f.engine.rows().get('catalog').set('orphan', {key: 'unexpected', arbitrary: {saved: 'exactly'}});
  const reopened = create(f.options); assert.equal((await reopened.ready()).error.code, 'corruption');
  f.engine.transactions.length = 0; f.engine.operations.length = 0;
  const rescued = await reopened.readRecovery();
  assert.equal(rescued.ok, true); assert.equal(rescued.format, 'coconut-storage-recovery');
  assert.equal(rescued.stores.documents.find(row => row.key === 'a').value.payload.key, 'broken');
  assert.equal(rescued.stores.documents.find(row => row.key === 'b').value.key, 'b');
  assert.equal(rescued.stores.catalog.some(row => row.key === 'b'), false);
  assert.deepEqual(rescued.stores.catalog.find(row => row.key === 'orphan').value, {key: 'unexpected', arbitrary: {saved: 'exactly'}});
  assert.equal(rescued.stores.legacySnapshots[0].value.raw, raw);
  assert.equal(f.engine.transactions.length, 1); assert.equal(f.engine.transactions[0].mode, 'readonly');
  assert.equal(f.engine.operations.some(op => ['put', 'add', 'delete'].includes(op.op)), false);
});

test('raw recovery export remains readable after late old-client changes gate ordinary library access', async () => {
  const f = fixture({raw: JSON.stringify({documents: [document('a')]})}); await f.adapter.ready();
  await write(f.adapter, change('update', 'a', {document: {...document('a'), title: 'latest IDB content'}}));
  f.legacy.values.set(LEGACY_KEY, '{legacy changed'); const reopened = create(f.options);
  assert.equal((await reopened.ready()).error.code, 'legacy-changed');
  const rescued = await reopened.readRecovery(); assert.equal(rescued.ok, true);
  assert.equal(rescued.stores.documents[0].value.payload.title, 'latest IDB content');
});

test('shutdown also waits for an active schema-upgrade transaction terminal event', async () => {
  const f = fixture(); let request;
  const adapter = create({...f.options, indexedDB: {open() { request = {}; return request; }}});
  const starting = adapter.ready(); let aborted = false;
  request.transaction = {abort() { aborted = true; }}; request.result = {createObjectStore() {}, close() {}};
  request.onupgradeneeded({oldVersion: 0}); let settled = false;
  const stopping = adapter.shutdown().then(result => { settled = true; return result; });
  await f.engine.tick(); assert.equal(aborted, true); assert.equal(settled, false);
  request.transaction.onabort(); const stopped = await stopping;
  assert.equal(stopped.transactions[0].status, 'cancelled'); assert.equal((await starting).status, 'cancelled');
});


test('Undo restores the exact migrated library order and receipts expose the committed order', async () => {
  const f = fixture({raw: JSON.stringify({documents: [document('a'), document('b')]})}); await f.adapter.ready();
  const before = (await f.adapter.loadLibrary()).documents.map(row => row.payload);
  const removed = await write(f.adapter, change('remove', 'a')); assert.equal(removed.receipts[0].order, 0);
  const restored = await write(f.adapter, change('restore', 'a', {expected: expected(1, 2)})); assert.equal(restored.receipts[0].order, 0);
  assert.deepEqual((await f.adapter.loadLibrary()).documents.map(row => row.payload), before);
  await write(f.adapter, change('remove', 'a', {expected: expected(2, 3)}));
  const moved = await write(f.adapter, change('restore', 'a', {expected: expected(2, 4), order: 20})); assert.equal(moved.receipts[0].order, 20);
  assert.deepEqual((await f.adapter.loadLibrary()).documents.map(row => row.key), ['b', 'a']);
  const created = await write(f.adapter, change('create', 'c')); assert.equal(created.receipts[0].order, 21);
});
