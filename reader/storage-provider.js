(function (root) {
  'use strict';
  const NAME = 'coconut-reader-library-v1';
  const failure = (code, message = code) => ({ok: false, status: 'failed', error: {code, message}});
  // Loading is deliberately asynchronous; the application receives its entire
  // coherent library before any of its classic scripts install input handlers.
  async function initialize({indexedDB, getStorage = () => root.localStorage,
    validate, legacyModule = root.CoconutLibraryStore, documentModule = root.CoconutDocumentStorage,
    onLifecycle = () => {}, onStorage = () => {}, signal, name = NAME, openTimeoutMs} = {}) {
    if (signal?.aborted) return failure('cancelled');
    const listeners = new Set();
    let backendError = null, primitive;
    const publish = event => {
      if (['versionchange', 'unexpected-close'].includes(event.state)) backendError = failure(event.state === 'versionchange' ? 'version' : 'unavailable').error;
      onLifecycle(event);
      for (const listener of listeners) { try { listener(event); } catch {} }
    };
    const readLegacy = () => {
      try { return {ok: true, raw: getStorage().getItem(legacyModule.KEY), fence: getStorage().getItem(legacyModule.FENCE_KEY)}; }
      catch (error) { return failure('denied', error.message); }
    };
    const legacy = readLegacy();
    const fallback = reason => {
      // Absence of IDB does not make stale legacy content authoritative again.
      if (!legacy.ok || legacy.fence !== null) return {...failure(legacy.ok ? 'fenced' : 'denied'), legacyRaw: legacy.raw};
      const adapter = legacyModule.createLegacyAdapter({getStorage, validate});
      return {ok: true, backend: 'legacy', adapter, loaded: adapter.load(), fallbackReason: reason, legacyRaw: legacy.raw};
    };
    if (indexedDB === undefined) {
      try { indexedDB = root.indexedDB; }
      catch { return fallback('denied'); }
    }
    if (!indexedDB) return fallback('unavailable');
    try {
      primitive = documentModule.create({indexedDB, name, getLegacyStorage: getStorage, validate,
        onLifecycle: publish, ...(openTimeoutMs === undefined ? {} : {openTimeoutMs})});
      onStorage(primitive);
      const ready = await primitive.ready();
      if (signal?.aborted) return failure('cancelled');
      if (!ready.ok) {
        const recovery = await primitive.readRecovery();
        primitive.close();
        // Re-read the fence after readiness: a failed migration may already own
        // this origin. It must never fall through to a legacy write.
        const current = readLegacy();
        if (['unavailable', 'denied'].includes(ready.error?.code) && current.ok && current.fence === null) return fallback(ready.error.code);
        return {...ready, legacyRaw: ready.legacyRaw ?? current.raw, recovery: recovery.ok ? {...recovery, currentLegacyRaw: current.raw} : null, close: () => primitive.close()};
      }
      const loaded = ready.library || await primitive.loadLibrary();
      // The provider consumes this startup snapshot. Do not let the cached
      // readiness Promise retain a second entire library after normalization.
      delete ready.library;
      if (signal?.aborted) return failure('cancelled');
      if (!loaded.ok) { primitive.close(); return {...loaded, legacyRaw: legacy.raw}; }
      const tokens = new Map();
      for (const row of loaded.documents) tokens.set(row.key, {epoch: row.epoch, revision: row.revision, deleted: false});
      for (const row of loaded.tombstones) tokens.set(row.key, {epoch: row.epoch, revision: row.revision, deleted: true});
      const documents = loaded.documents.map(row => ({...row.payload, ...validate(row.payload), key: row.key}));
      let sequence = 0;
      const session = root.crypto.randomUUID();
      const adapter = {
        backend: 'indexeddb',
        prepareChanges(changes) {
          return primitive.prepare(changes.map(({key, identity, kind, generation}) => {
            const current = tokens.get(key);
            return {key, kind: kind === 'remove' ? 'remove' : current?.deleted ? 'restore' : current ? 'update' : 'create',
              expected: current ? {epoch: current.epoch, revision: current.revision} : null,
              document: identity, generation, mutationId: session + ':' + (++sequence)};
          }));
        },
        async write(capture, options) {
          const result = await primitive.commit(capture, options);
          // Request success is insufficient. Tokens move only with the terminal
          // transaction receipt, including a commit that races with cancellation.
          if (result.ok) for (const receipt of result.receipts) tokens.set(receipt.key,
            {epoch: receipt.epoch, revision: receipt.revision, deleted: receipt.kind === 'remove'});
          return result;
        },
        status: () => ({backend: 'indexeddb', error: backendError}),
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        close: () => primitive.close(),
      };
      let active = null;
      try { active = JSON.parse(loaded.legacyRaw)?.active ?? null; } catch {}
      return {ok: true, backend: 'indexeddb', adapter, loaded: {ok: true, documents, active}, legacyRaw: loaded.legacyRaw,
        migrated: ready.migrated, report: ready.report};
    } catch (error) {
      primitive?.close();
      return {...failure('unexpected', error.message), legacyRaw: legacy.raw};
    }
  }
  const api = {initialize, NAME};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CoconutStorageProvider = api;
})(typeof window !== 'undefined' ? window : globalThis);
