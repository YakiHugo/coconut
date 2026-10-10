(function (root) {
  'use strict';

  // Document-level transactions with an immutable recovery snapshot of legacy data.
  const VERSION = 1, PROTOCOL = 1;
  const STORES = ['meta', 'documents', 'catalog', 'tombstones', 'legacySnapshots'];
  const LEGACY_KEY = 'coconut-reader-v1', FENCE_KEY = 'coconut-reader-storage-fence-v1';
  const fail = (code, message = code, detail = {}) => Object.freeze({ok: false,
    status: code === 'conflict' ? 'conflict' : code === 'cancelled' ? 'cancelled' : 'failed',
    error: Object.freeze({code, message: String(message)}), ...detail});
  const errorResult = error => fail((typeof error?.code === 'string' ? error.code : null) || ({QuotaExceededError: 'quota', SecurityError: 'denied',
    InvalidStateError: 'unavailable', VersionError: 'version', AbortError: 'cancelled',
    DataCloneError: 'validation'}[error?.name]) || 'unexpected', error?.message || error);
  const issue = (code, message) => Object.assign(new Error(message || code), {code});
  const positive = value => Number.isSafeInteger(value) && value > 0;
  const next = value => { if (!positive(value + 1)) throw issue('version', 'Revision or epoch exhausted'); return value + 1; };
  const keyOf = value => typeof value === 'string' && value.length > 0;
  const token = value => value && positive(value.epoch) && positive(value.revision) && value.epoch <= value.revision;
  const same = (a, b) => token(a) && token(b) && a.epoch === b.epoch && a.revision === b.revision;
  const orderOf = value => Number.isSafeInteger(value) && value >= 0;
  const compareKeys = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  // Legacy JSON has no cycles or non-JSON values. Compare exact data independently
  // of property insertion order, retaining all unknown payload fields.
  function equalJSON(a, b) {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equalJSON(a[key], b[key]));
  }
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const clone = value => root.structuredClone(value);

  // Hash UTF-16 code units, preserving lone surrogates in exact localStorage text.
  // Hashing never happens inside a live IDB transaction. Exact text is authoritative.
  async function hashRaw(raw) {
    const value = raw === null ? '\u0000' : '\u0001' + raw;
    const bytes = new Uint8Array(value.length * 2);
    for (let i = 0; i < value.length; i++) { const n = value.charCodeAt(i); bytes[i * 2] = n & 255; bytes[i * 2 + 1] = n >>> 8; }
    const result = await root.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(result)].map(n => n.toString(16).padStart(2, '0')).join('');
  }

  function create({indexedDB = root.indexedDB, name = 'coconut-reader-library-v1',
    getLegacyStorage, legacyKey = LEGACY_KEY, fenceKey = FENCE_KEY,
    validate = document => { if (!plain(document) || !keyOf(document.key)) throw issue('validation', 'Invalid document'); },
    summarize = document => ({title: typeof document.title === 'string' ? document.title : '',
      kind: typeof document.project_kind === 'string' ? document.project_kind : 'transcript'}),
    checkpoint = () => null, hash = hashRaw, onLifecycle = () => {}, openTimeoutMs = 10000} = {}) {
    let db = null, opening = null, initializing = null, lifecycle = 'new', writable = false, cancelOpening = null;
    const activeTransactions = new Set();
    const prepared = new WeakMap();
    const marker = JSON.stringify({protocol: PROTOCOL, database: name, legacyKey});
    let verifiedSource = null, recoveryFailure = null;
    function recovery(result) {
      writable = false; recoveryFailure = result;
      if (!['closed', 'versionchange', 'unexpected-close'].includes(lifecycle)) state('recovery-required');
      return result;
    }
    function state(value, detail = {}) { lifecycle = value; try { onLifecycle(Object.freeze({state: value, ...detail})); } catch {} }
    function close() { writable = false; db?.close(); db = null; state('closed'); cancelOpening?.(); }
    async function shutdown() {
      // Closing prevents new transactions immediately. In-flight transactions are
      // acknowledged only after their real terminal abort/complete event.
      close();
      const active = [...activeTransactions];
      for (const entry of active) { try { entry.tx.abort(); } catch { /* Already terminal: its event still supplies the truth. */ } }
      const transactions = await Promise.all(active.map(entry => entry.terminal));
      return Object.freeze({ok: true, status: 'closed', transactions: Object.freeze(transactions)});
    }
    function open() {
      if (db) return Promise.resolve({ok: true});
      if (opening) return opening;
      if (lifecycle !== 'new') return Promise.resolve(fail(lifecycle === 'versionchange' ? 'version' : 'unavailable'));
      state('opening');
      opening = new Promise(resolve => {
        let request, settled = false, abandoned = false, upgradeError, timer;
        const finish = result => { if (!settled) { settled = true; root.clearTimeout(timer); resolve(result); } };
        cancelOpening = () => { abandoned = true; finish(fail('cancelled')); };
        timer = root.setTimeout(() => { abandoned = true; state('open-timeout'); finish(fail('open-timeout', 'Database open did not finish; close other library windows and retry')); },
          Number.isFinite(openTimeoutMs) && openTimeoutMs > 0 ? openTimeoutMs : 10000);
        try { if (!indexedDB) throw issue('unavailable', 'IndexedDB is unavailable'); request = indexedDB.open(name, VERSION); }
        catch (error) { state('failed'); finish(errorResult(error)); return; }
        request.onblocked = () => { if (abandoned || lifecycle === 'closed') return; abandoned = true; state('blocked'); finish(fail('blocked', 'Another window blocks the database version')); };
        request.onupgradeneeded = event => {
          const upgrade = request.transaction, active = {tx: upgrade};
          active.terminal = new Promise(resolve => { active.resolve = resolve; }); activeTransactions.add(active);
          const finished = result => { activeTransactions.delete(active); active.resolve(result); };
          upgrade.oncomplete = () => finished({ok: true, status: 'upgraded'});
          upgrade.onabort = () => finished(errorResult(upgrade.error || issue('cancelled')));
          if (abandoned || lifecycle === 'closed') { request.transaction.abort(); return; }
          try {
            if (event.oldVersion !== 0) throw issue('version', 'Unknown database schema');
            for (const store of STORES) request.result.createObjectStore(store);
          } catch (error) { upgradeError = error; request.transaction.abort(); }
        };
        request.onerror = () => { if (!abandoned) state('failed'); finish(errorResult(upgradeError || request.error)); };
        request.onsuccess = () => {
          const connection = request.result;
          if (abandoned || lifecycle === 'closed') { connection.close(); finish(fail('cancelled')); return; }
          if (STORES.some(store => !connection.objectStoreNames.contains(store))) {
            connection.close(); state('failed'); finish(fail('version', 'Incomplete database schema')); return;
          }
          db = connection;
          connection.onversionchange = () => { writable = false; db = null; state('versionchange'); connection.close(); };
          connection.onclose = () => { if (db === connection) { writable = false; db = null; state('unexpected-close'); } };
          state('open'); finish({ok: true});
        };
      });
      return opening;
    }

    // Body and request callbacks must stay synchronous. Results become public only
    // on complete; success of any individual request is never a save receipt.
    function transaction(stores, mode, body, {signal} = {}) {
      if (signal?.aborted) return Promise.resolve(fail('cancelled'));
      if (!db) return Promise.resolve(fail(lifecycle === 'versionchange' ? 'version' : 'unavailable'));
      return new Promise(resolve => {
        let tx, result, reason, done = false, active;
        const finish = value => {
          if (done) return; done = true; signal?.removeEventListener('abort', abort);
          if (active) { activeTransactions.delete(active); active.resolve(value); }
          resolve(value);
        };
        const abort = () => {
          try { tx.abort(); reason ||= fail('cancelled'); }
          catch { /* It may have committed already. Wait for its terminal event. */ }
        };
        try { tx = db.transaction(stores, mode); }
        catch (error) { finish(errorResult(error)); return; }
        active = {tx}; active.terminal = new Promise(resolve => { active.resolve = resolve; }); activeTransactions.add(active);
        const stop = value => { reason = value; try { tx.abort(); } catch {} };
        const guard = callback => event => { try { callback(event); } catch (error) { stop(errorResult(error)); } };
        const get = (store, key, callback) => { const request = tx.objectStore(store).get(key); request.onsuccess = guard(() => callback(request.result)); };
        tx.oncomplete = () => finish(result ?? fail('unexpected', 'Transaction completed without a result'));
        tx.onabort = () => finish(reason || errorResult(tx.error || issue('cancelled')));
        tx.onerror = event => { reason ||= errorResult(event.target?.error || tx.error || issue('unexpected')); };
        signal?.addEventListener('abort', abort, {once: true});
        if (signal?.aborted) { abort(); return; }
        try { body({tx, get, guard, stop, setResult: value => { result = value; }}); }
        catch (error) { stop(errorResult(error)); }
      });
    }
    function getOne(store, key) {
      return transaction([store], 'readonly', ({get, setResult}) => get(store, key, value => setResult({ok: true, value})));
    }
    function compatible(meta) {
      return meta?.protocol === PROTOCOL && meta.minReader === PROTOCOL && ['ready', 'recovery-required'].includes(meta.status) &&
        meta.snapshot === 'legacy-v1' && typeof meta.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(meta.sourceHash) &&
        Number.isSafeInteger(meta.initialCount) && meta.initialCount >= 0 && Array.isArray(meta.report?.importedKeys) &&
        meta.report.importedKeys.length === meta.initialCount && meta.report.importedKeys.every(keyOf) &&
        new Set(meta.report.importedKeys).size === meta.initialCount && Array.isArray(meta.report.quarantine) &&
        orderOf(meta.nextOrder) && meta.nextOrder >= meta.initialCount &&
        (meta.status !== 'ready' || meta.report.quarantine.length === 0);
    }
    function envelope(value, key) {
      return value?.envelopeVersion === 1 && value.key === key && token(value) && orderOf(value.generation) && keyOf(value.mutationId) && plain(value.payload) && value.payload.key === key;
    }
    function tombstone(value, key) { return value?.envelopeVersion === 1 && value.key === key && token(value) && orderOf(value.generation) && keyOf(value.mutationId) && value.deleted === true && orderOf(value.order) && !Object.hasOwn(value, 'payload'); }
    function catalogRow(value, key) { return plain(value) && value.key === key && token(value) && orderOf(value.order); }
    function checkDocument(payload) {
      if (!plain(payload) || !keyOf(payload.key)) throw issue('validation', 'Document key is required');
      // Validators may sanitize their argument or return a lossy projection. Neither
      // is the stored payload. Keep unknown authored fields intact.
      const checked = validate(clone(payload));
      if (checked === false || typeof checked?.then === 'function') throw issue('validation', 'Validation must succeed synchronously');
    }
    function checkStoredDocument(row) {
      checkDocument(row.payload);
      const original = verifiedSource?.documents.get(row.key);
      if (original && row.epoch === 1 && row.revision === 1 &&
        (!equalJSON(row.payload, original.payload) || row.generation !== 0 ||
          row.mutationId !== 'legacy:' + verifiedSource.sourceHash + ':' + original.order)) {
        throw issue('corruption', 'Initial migration payload differs from its exact recovery snapshot');
      }
    }
    function parseLegacy(raw) {
      let source;
      try { source = raw === null ? {documents: []} : JSON.parse(raw); }
      catch { return {documents: [], quarantine: [{index: null, reason: 'invalid-json'}], parseable: false}; }
      if (!plain(source) || !Array.isArray(source.documents)) return {documents: [], quarantine: [{index: null, reason: 'invalid-library'}], parseable: false};
      const counts = new Map();
      for (const document of source.documents) if (keyOf(document?.key)) counts.set(document.key, (counts.get(document.key) || 0) + 1);
      const documents = [], quarantine = [];
      source.documents.forEach((payload, index) => {
        try {
          if (counts.get(payload?.key) > 1) throw issue('validation', 'duplicate-key');
          checkDocument(payload);
          const summary = clone(summarize(clone(payload)));
          if (!plain(summary)) throw issue('validation', 'Invalid catalog summary');
          documents.push({key: payload.key, payload, summary, order: index});
        } catch (error) { quarantine.push({index, key: typeof payload?.key === 'string' ? payload.key : null, reason: String(error.message || error)}); }
      });
      return {documents, quarantine, parseable: true};
    }
    async function migrate() {
      let storage, raw, sourceHash, parsed;
      try {
        if (typeof getLegacyStorage !== 'function') throw issue('unavailable', 'Explicit legacy storage access is required');
        storage = getLegacyStorage();
        const existingFence = storage.getItem(fenceKey);
        if (existingFence !== null && existingFence !== marker) throw issue('fenced', 'Unknown migration fence; preserve it for recovery');
        // Cooperating legacy writers check the marker. It deliberately survives all
        // failures; clearing it would reopen writes while recovery remains unresolved.
        if (existingFence === null) storage.setItem(fenceKey, marker);
        raw = storage.getItem(legacyKey);
        sourceHash = await hash(raw);
        parsed = parseLegacy(raw);
        if (storage.getItem(fenceKey) !== marker || storage.getItem(legacyKey) !== raw) throw issue('legacy-changed', 'Legacy data changed while migration was prepared');
      } catch (error) { return {...errorResult(error), ...(raw !== undefined ? {legacyRaw: raw} : {})}; }
      const report = {quarantine: parsed.quarantine, importedKeys: parsed.documents.map(item => item.key)};
      const meta = {protocol: PROTOCOL, minReader: PROTOCOL, status: parsed.parseable && parsed.quarantine.length === 0 ? 'ready' : 'recovery-required',
        snapshot: 'legacy-v1', sourceHash, initialCount: parsed.documents.length,
        nextOrder: parsed.documents.reduce((max, item) => Math.max(max, item.order + 1), 0), report};
      const result = await transaction(STORES, 'readwrite', ({tx, get, guard, stop, setResult}) => {
        get('meta', 'state', existing => {
          if (existing !== undefined) { setResult({ok: true, existing: true}); return; }
          const counts = STORES.filter(store => store !== 'meta'); let pending = counts.length;
          for (const store of counts) {
            const request = tx.objectStore(store).count();
            request.onsuccess = guard(() => {
              if (request.result !== 0) { stop(fail('corruption', 'Records exist without a migration manifest')); return; }
              if (--pending) return;
              if (storage.getItem(fenceKey) !== marker || storage.getItem(legacyKey) !== raw) { stop(fail('legacy-changed')); return; }
              tx.objectStore('legacySnapshots').add({raw, sourceHash, legacyKey, report}, 'legacy-v1');
              for (const {key, payload, summary, order} of parsed.documents) {
                tx.objectStore('documents').add({envelopeVersion: 1, key, epoch: 1, revision: 1, payload,
                  generation: 0, mutationId: 'legacy:' + sourceHash + ':' + order}, key);
                tx.objectStore('catalog').add({...summary, key, epoch: 1, revision: 1, order}, key);
              }
              tx.objectStore('meta').add(meta, 'state');
              setResult({ok: true});
            });
          }
        });
      });
      return result.ok ? result : {...result, legacyRaw: raw};
    }
    // Hash and parse the immutable source once at initialization, never as part of
    // an ordinary document commit. A verified revision-one row must match its full
    // original payload; matching just IDs and revision tokens can conceal data loss.
    async function verifyMigration() {
      const result = await transaction(['meta', 'legacySnapshots'], 'readonly', ({get, setResult, stop}) => get('meta', 'state', meta => {
        if (!compatible(meta)) { stop(fail('version', 'Unknown storage protocol')); return; }
        get('legacySnapshots', meta.snapshot, snapshot => {
          if (!snapshot || snapshot.sourceHash !== meta.sourceHash || snapshot.legacyKey !== legacyKey ||
            (snapshot.raw !== null && typeof snapshot.raw !== 'string') || !equalJSON(snapshot.report, meta.report)) {
            stop(fail('corruption', 'Migration recovery snapshot is missing or inconsistent')); return;
          }
          setResult({ok: true, meta, snapshot});
        });
      }));
      if (!result.ok) return result;
      try {
        if (await hash(result.snapshot.raw) !== result.meta.sourceHash) return fail('corruption', 'Legacy snapshot integrity check failed');
        const parsed = parseLegacy(result.snapshot.raw);
        if (!equalJSON(parsed.documents.map(item => item.key), result.meta.report.importedKeys) ||
          !equalJSON(parsed.quarantine, result.meta.report.quarantine)) return fail('corruption', 'Legacy migration report disagrees with its recovery snapshot');
        verifiedSource = {raw: result.snapshot.raw, sourceHash: result.meta.sourceHash,
          documents: new Map(parsed.documents.map(item => [item.key, item]))};
      } catch (error) { return errorResult(error); }
      return {ok: true, meta: result.meta};
    }
    function inspectLegacy() {
      try {
        if (!verifiedSource) return fail('unavailable', 'Legacy source has not been verified');
        const storage = getLegacyStorage(), raw = storage.getItem(legacyKey), fence = storage.getItem(fenceKey);
        const changed = raw !== verifiedSource.raw, fenceChanged = fence !== marker;
        return {ok: true, changed: changed || fenceChanged, ...(changed ? {raw} : {}), ...(fenceChanged ? {fenceChanged: true} : {})};
      } catch (error) { return errorResult(error); }
    }
    function checkWriteFence() {
      const legacy = inspectLegacy();
      if (!legacy.ok) return recovery(legacy);
      if (legacy.changed) return recovery(fail('legacy-changed', 'Legacy data or its migration fence changed; preserve both versions for recovery', {legacy}));
      return legacy;
    }
    async function ready() {
      if (['closed', 'versionchange', 'unexpected-close'].includes(lifecycle)) return fail(lifecycle === 'versionchange' ? 'version' : 'unavailable');
      if (recoveryFailure) return recoveryFailure;
      if (initializing) return initializing;
      initializing = (async () => {
        const opened = await open(); if (!opened.ok) return opened;
        const loaded = await getOne('meta', 'state'); if (!loaded.ok) return loaded;
        let migrated = false;
        if (loaded.value === undefined) { const result = await migrate(); if (!result.ok) return result; migrated = !result.existing; }
        const verified = await verifyMigration(); if (!verified.ok) return recovery(verified);
        if (verified.meta.status !== 'ready') return recovery(fail('corruption', 'Legacy library needs explicit recovery',
          {report: verified.meta.report, legacyRaw: verifiedSource.raw}));
        const checked = await loadLibrary(); if (!checked.ok) return recovery(checked);
        const legacy = checkWriteFence(); if (!legacy.ok) return legacy;
        if (!db || lifecycle !== 'open') return fail(lifecycle === 'versionchange' ? 'version' : 'unavailable');
        writable = true; state('ready');
        return {ok: true, status: 'ready', migrated, report: verified.meta.report, legacy, library: checked};
      })();
      return initializing;
    }
    async function checkLegacy() { return inspectLegacy(); }
    // Catalog, payloads, tombstones and manifest come from one consistent IDB
    // snapshot. No partial library is ever reported as a successful load.
    function loadLibrary() {
      if (!verifiedSource) return Promise.resolve(fail('unavailable', 'Initialize storage before loading the library'));
      const legacy = checkWriteFence(); if (!legacy.ok) return Promise.resolve(legacy);
      return transaction(['meta', 'documents', 'catalog', 'tombstones'], 'readonly', ({tx, get, guard, stop, setResult}) => {
        const rows = {}, keys = {}; let pending = 7, meta;
        const complete = () => {
          if (--pending) return;
          if (!compatible(meta) || meta.sourceHash !== verifiedSource.sourceHash) { stop(fail('version', 'Storage protocol changed')); return; }
          if (meta.status !== 'ready') { stop(fail('corruption', 'Legacy library needs explicit recovery', {report: meta.report})); return; }
          const maps = {};
          for (const store of ['documents', 'catalog', 'tombstones']) {
            if (keys[store].length !== rows[store].length) { stop(fail('corruption', 'Stored row keys are inconsistent')); return; }
            maps[store] = new Map();
            for (let index = 0; index < keys[store].length; index++) {
              const key = keys[store][index], row = rows[store][index];
              const valid = keyOf(key) && (store === 'documents' ? envelope(row, key) : store === 'catalog' ? catalogRow(row, key) : tombstone(row, key));
              if (!valid || maps[store].has(key)) { stop(fail('corruption', 'Invalid stored ' + store + ' row', {key, raw: row})); return; }
              if (store !== 'documents' && row.order >= meta.nextOrder) { stop(fail('corruption', 'Document order exceeds the manifest', {key, raw: row})); return; }
              maps[store].set(key, row);
            }
          }
          for (const [key, row] of maps.documents) {
            if (!same(row, maps.catalog.get(key)) || maps.tombstones.has(key)) { stop(fail('corruption', 'Document/catalog/tombstone mismatch', {key})); return; }
            try { checkStoredDocument(row); }
            catch (error) { stop(fail('corruption', error.message, {key, raw: row})); return; }
            if (row.epoch === 1 && row.revision === 1 && verifiedSource.documents.has(key)) {
              const original = verifiedSource.documents.get(key);
              if (maps.catalog.get(key).order !== original.order) {
                stop(fail('corruption', 'Initial migration payload differs from its exact recovery snapshot', {key, raw: row})); return;
              }
            }
          }
          for (const [key] of maps.catalog) if (!maps.documents.has(key)) { stop(fail('corruption', 'Orphan catalog row', {key})); return; }
          for (const [key, row] of maps.tombstones) {
            if (maps.documents.has(key) || maps.catalog.has(key) || (verifiedSource.documents.has(key) && row.revision <= 1)) {
              stop(fail('corruption', 'Live row has an inconsistent tombstone', {key})); return;
            }
          }
          for (const key of verifiedSource.documents.keys()) if (!maps.documents.has(key) && !maps.tombstones.has(key)) {
            stop(fail('corruption', 'Migrated document has disappeared without a tombstone', {key})); return;
          }
          const legacy = checkWriteFence(); if (!legacy.ok) { stop(legacy); return; }
          const catalog = [...maps.catalog.values()].sort((a, b) => a.order - b.order || compareKeys(a.key, b.key));
          setResult({ok: true, documents: catalog.map(row => maps.documents.get(row.key)), catalog,
            tombstones: [...maps.tombstones.values()].sort((a, b) => compareKeys(a.key, b.key)),
            legacyRaw: verifiedSource.raw, report: meta.report});
        };
        get('meta', 'state', value => { meta = value; complete(); });
        for (const store of ['documents', 'catalog', 'tombstones']) {
          const values = tx.objectStore(store).getAll(), allKeys = tx.objectStore(store).getAllKeys();
          values.onsuccess = guard(() => { rows[store] = values.result; complete(); });
          allKeys.onsuccess = guard(() => { keys[store] = allKeys.result; complete(); });
        }
      });
    }
    function prepare(changes) {
      if (!Array.isArray(changes) || !changes.length) throw issue('validation', 'Explicit dirty commands are required');
      const keys = new Set();
      const commands = changes.map(change => {
        const {kind, key, expected, generation, mutationId, order} = change;
        if (!['create', 'update', 'remove', 'restore'].includes(kind) || !keyOf(key) || keys.has(key) ||
          !Number.isSafeInteger(generation) || generation < 0 || !keyOf(mutationId) ||
          (kind === 'create' ? expected !== null : !(kind === 'remove' && expected === null) && !token(expected)) ||
          (order !== undefined && !orderOf(order))) throw issue('validation', 'Invalid document command');
        keys.add(key);
        const payload = kind === 'remove' ? null : clone(change.document);
        if (payload !== null) { if (payload?.key !== key) throw issue('validation', 'Document identity changed'); checkDocument(payload); }
        const summary = payload === null ? null : clone(summarize(clone(payload)));
        if (summary !== null && !plain(summary)) throw issue('validation', 'Invalid catalog summary');
        return {kind, key, expected: expected && {epoch: expected.epoch, revision: expected.revision}, generation, mutationId,
          payload, summary, order, checkpoint: payload === null ? null : clone(checkpoint(clone(payload)))};
      });
      // Opaque ownership prevents callers mutating the captured payload or reusing
      // a different adapter's capture while an asynchronous commit is pending.
      const capture = Object.freeze({keys: Object.freeze(commands.map(item => item.key)), count: commands.length});
      prepared.set(capture, commands); return capture;
    }
    function commit(capture, {signal} = {}) {
      const commands = prepared.get(capture);
      if (!commands) return Promise.resolve(fail('validation', 'Unknown prepared capture'));
      if (!writable || lifecycle !== 'ready') return Promise.resolve(recoveryFailure || fail(lifecycle === 'versionchange' ? 'version' : 'unavailable'));
      if (signal?.aborted) return Promise.resolve(fail('cancelled'));
      const legacy = checkWriteFence(); if (!legacy.ok) return Promise.resolve(legacy);
      return transaction(['meta', 'documents', 'catalog', 'tombstones'], 'readwrite', ({tx, get, stop, setResult}) => {
        get('meta', 'state', meta => {
          if (!compatible(meta) || meta.status !== 'ready' || meta.sourceHash !== verifiedSource.sourceHash) { stop(fail('version', 'Storage protocol is not writable')); return; }
          const fence = checkWriteFence(); if (!fence.ok) { stop(fence); return; }
          let pending = commands.length; const receipts = new Array(pending);
          // Reserve new/explicit orders in command order. Undo reuses the tombstone's original order.
          let nextOrder = meta.nextOrder; const assignedOrders = commands.map(command => {
            if (command.kind === 'restore' && command.order === undefined) return null;
            if (!['create', 'restore'].includes(command.kind) && !(command.kind === 'remove' && command.expected === null)) return null;
            const order = command.order === undefined ? nextOrder : command.order;
            if (!Number.isSafeInteger(order + 1)) throw issue('version', 'Catalog order exhausted');
            nextOrder = Math.max(nextOrder, order + 1); return order;
          });
          commands.forEach((command, index) => get('documents', command.key, current => get('tombstones', command.key, deleted => get('catalog', command.key, catalog => {
            const {kind, key, expected, generation, mutationId, payload, summary, checkpoint} = command;
            if ((current !== undefined && !envelope(current, key)) || (deleted !== undefined && !tombstone(deleted, key)) ||
              (current !== undefined && deleted !== undefined) ||
              (current !== undefined && (!same(current, catalog) || !catalogRow(catalog, key) || catalog.order >= meta.nextOrder)) ||
              (current === undefined && catalog !== undefined) ||
              (deleted !== undefined && (deleted.order >= meta.nextOrder || (verifiedSource.documents.has(key) && deleted.revision <= 1))) ||
              (current === undefined && deleted === undefined && verifiedSource.documents.has(key))) { stop(fail('corruption', 'Document identity record is invalid', {key})); return; }
            if (current !== undefined) {
              try { checkStoredDocument(current);
                if (current.epoch === 1 && current.revision === 1 && verifiedSource.documents.has(key) && catalog.order !== verifiedSource.documents.get(key).order) {
                  throw issue('corruption', 'Initial migration order changed');
                }
              }
              catch (error) { stop(fail('corruption', 'Stored document fails validation; recover its raw record before changing it', {key})); return; }
            }
            const match = kind === 'create' || (kind === 'remove' && expected === null) ? current === undefined && deleted === undefined :
              kind === 'restore' ? current === undefined && same(deleted, expected) : same(current, expected) && deleted === undefined;
            if (!match) { stop(fail('conflict', 'Document changed or was removed', {key, current: current ? {epoch: current.epoch, revision: current.revision} : null,
              tombstone: deleted ? {epoch: deleted.epoch, revision: deleted.revision} : null})); return; }
            const isNew = kind === 'create' || (kind === 'remove' && expected === null);
            const epoch = isNew ? 1 : kind === 'restore' ? next(deleted.epoch) : current.epoch;
            const revision = isNew ? 1 : next(kind === 'restore' ? deleted.revision : current.revision);
            const identity = {envelopeVersion: 1, key, epoch, revision, generation, mutationId};
            const order = isNew ? assignedOrders[index] : kind === 'restore' ? assignedOrders[index] ?? deleted.order : catalog.order;
            if (kind === 'remove') {
              tx.objectStore('documents').delete(key); tx.objectStore('catalog').delete(key);
              tx.objectStore('tombstones').put({...identity, deleted: true, order}, key);
            } else {
              tx.objectStore('documents').put({...identity, payload}, key);
              tx.objectStore('catalog').put({...summary, order, key, epoch, revision}, key);
              if (kind === 'restore') tx.objectStore('tombstones').delete(key);
            }
            receipts[index] = Object.freeze({ok: true, status: 'saved', kind, key, epoch, revision, order, generation, mutationId, checkpoint: clone(checkpoint)});
            if (--pending === 0) {
              const fence = checkWriteFence(); if (!fence.ok) { stop(fence); return; }
              if (nextOrder !== meta.nextOrder) tx.objectStore('meta').put({...meta, nextOrder}, 'state');
              setResult(Object.freeze({ok: true, status: 'saved', receipts: Object.freeze(receipts)}));
            }
          }))));
        });
      }, {signal});
    }
    async function readDocument(key) {
      if (!keyOf(key)) return fail('validation');
      const loaded = await getOne('documents', key); if (!loaded.ok) return loaded;
      if (loaded.value === undefined) return {ok: true, document: null};
      try { if (!envelope(loaded.value, key)) throw issue('corruption', 'Invalid envelope'); checkStoredDocument(loaded.value); }
      catch (error) { return fail('corruption', error.message, {key, raw: loaded.value}); }
      return {ok: true, document: loaded.value};
    }
    function readRecovery() {
      // Diagnostic export only: retain every raw key/value pair, including invalid
      // identities and orphans. Validation must never filter the rescue copy.
      return transaction(STORES, 'readonly', ({tx, guard, setResult}) => {
        const values = {}, keys = {}; let pending = STORES.length * 2;
        const complete = () => {
          if (--pending) return;
          const stores = {};
          for (const store of STORES) stores[store] = keys[store].map((key, index) => ({key, value: values[store][index]}));
          setResult({ok: true, format: 'coconut-storage-recovery', version: 1, database: name, stores});
        };
        for (const store of STORES) {
          const rows = tx.objectStore(store).getAll(), allKeys = tx.objectStore(store).getAllKeys();
          rows.onsuccess = guard(() => { values[store] = rows.result; complete(); });
          allKeys.onsuccess = guard(() => { keys[store] = allKeys.result; complete(); });
        }
      });
    }
    async function loadCatalog() {
      const result = await loadLibrary();
      return result.ok ? {ok: true, catalog: result.catalog, unreadable: []} : result;
    }
    return Object.freeze({ready, prepare, commit, readDocument, loadCatalog, loadLibrary, readRecovery, checkLegacy,
      readTombstone: key => getOne('tombstones', key), readLegacySnapshot: () => getOne('legacySnapshots', 'legacy-v1'),
      close, shutdown, status: () => Object.freeze({state: lifecycle, writable})});
  }
  const api = Object.freeze({create, VERSION, STORES: Object.freeze(STORES), LEGACY_KEY, FENCE_KEY, hashRaw});
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CoconutDocumentStorage = api;
})(typeof globalThis === 'undefined' ? this : globalThis);
