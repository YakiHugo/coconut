(function (root) {
  'use strict';

  const KEY = 'coconut-reader-v1';
  const FENCE_KEY = 'coconut-reader-storage-fence-v1';
  const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
  function failure(error, fallback = 'unexpected') {
    const code = (typeof error?.code === 'string' ? error.code : null) || ({QuotaExceededError: 'quota', SecurityError: 'denied',
      AbortError: 'cancelled', InvalidStateError: 'unavailable'}[error?.name]) || fallback;
    return Object.freeze({ok: false, status: code === 'cancelled' ? 'cancelled' :
      code === 'conflict' ? 'conflict' : 'failed', error: Object.freeze({code, message: String(error?.message || error || code)})});
  }
  const problem = (code, message = code) => failure({code, message});

  // This bridge still writes one localStorage value. The read-before-write
  // comparison detects some conflicts; it is NOT a cross-window atomic CAS.
  function createLegacyAdapter({getStorage, key = KEY, fenceKey = FENCE_KEY, validate = value => value} = {}) {
    let loaded = false, readable = false, previous = null, initial;
    function load() {
      if (loaded) return initial;
      loaded = true;
      try {
        previous = getStorage().getItem(key);
        const parsed = previous === null ? {documents: []} : JSON.parse(previous);
        if (!parsed || !Array.isArray(parsed.documents)) throw new Error('Invalid saved library');
        const keys = new Set();
        const documents = parsed.documents.map(doc => {
          if (!doc || typeof doc.key !== 'string' || !doc.key || keys.has(doc.key)) throw new Error('Invalid or duplicate document key');
          keys.add(doc.key);
          return {...doc, ...validate(doc), key: doc.key};
        });
        readable = true;
        initial = {ok: true, documents, active: parsed.active ?? null, raw: previous};
      } catch (error) {
        // Access becoming available later is not permission to overwrite a
        // library that this page never successfully read and validated.
        initial = {...failure(error, 'unreadable'), documents: [], active: null, raw: previous};
      }
      return initial;
    }
    function prepare(documents) {
      // Keep navigation and listening preferences out of the content value.
      // Capture exactly once, before the writer can yield.
      return JSON.stringify({documents});
    }
    function write(value, {signal} = {}) {
      if (signal?.aborted) return problem('cancelled');
      if (!loaded || !readable) return problem('unreadable');
      try {
        const storage = getStorage();
        // Any marker, including one from a newer/unknown protocol, fails
        // closed. This cooperative fence cannot control pre-bridge clients.
        if (storage.getItem(fenceKey) !== null) return problem('fenced');
        if (storage.getItem(key) !== previous) return problem('conflict');
        if (signal?.aborted) return problem('cancelled');
        storage.setItem(key, value);
        previous = value;
        return Object.freeze({ok: true, status: 'saved'});
      } catch (error) { return failure(error); }
    }
    return Object.freeze({load, prepare, write});
  }

  // The app continues to own synchronous document objects. Every content
  // mutation must register its exact identity here. Tickets mean queued;
  // only ticket.committed.ok is evidence that a captured generation was saved.
  function create({adapter, getDocuments, checkpoint = () => null, delay = 250, maxWait = 1000,
    now = () => Date.now(), setTimer = (fn, ms) => root.setTimeout(fn, ms),
    clearTimer = timer => root.clearTimeout(timer)} = {}) {
    const entries = new Map(), listeners = new Set();
    const perDocument = typeof adapter.prepareChanges === 'function';
    // Dirty atomic groups are page-owned dependencies, not revision tokens.
    // Overlap joins groups until their captured generations are acknowledged.
    const groups = new Map();
    let generation = 0, timer = null, firstQueued = null, running = null, barrier = null;
    for (const doc of getDocuments()) entries.set(doc.key, entry(doc.key, doc, 0, 'update', 'saved'));
    function entry(key, identity, version, kind, state = 'pending') {
      return {key, identity, generation: version, committedGeneration: state === 'saved' ? version : 0,
        kind, status: state, error: null, waiters: []};
    }
    const dirty = item => item.status !== 'saved';
    function pruneGroups() {
      for (const [key, group] of groups) if (!entries.has(key) || !dirty(entries.get(key))) {
        groups.delete(key); group.keys.delete(key);
      }
    }
    function joinGroups(changes) {
      if (!perDocument || !changes.length) return null;
      pruneGroups();
      const joined = new Set(changes.map(change => groups.get(change.key)).filter(Boolean));
      const group = {keys: new Set(changes.map(change => change.key)), conflict: null};
      for (const previous of joined) {
        group.conflict ||= previous.conflict;
        for (const key of previous.keys) group.keys.add(key);
      }
      for (const key of group.keys) groups.set(key, group);
      return group;
    }
    const quarantined = item => perDocument && groups.get(item.key)?.conflict;
    const capturable = item => dirty(item) && !quarantined(item);
    const hasPending = () => [...entries.values()].some(item => item.status === 'pending' && capturable(item));
    function quarantine(group, result) {
      if (!group) return;
      group.conflict = Object.freeze({ok: false, status: result.status, error: result.error, key: result.key});
      for (const key of [...group.keys]) {
        const item = entries.get(key);
        if (!item || !dirty(item) || groups.get(key) !== group) continue;
        const version = item.generation;
        item.status = result.status; item.error = result.error || null;
        // An unsent structural command cannot remain provisionally applied once
        // its dependency is known to conflict. Ordinary text stays recoverable.
        reconcileFailure(item, version, result);
        settle(item, version, result);
      }
      pruneGroups();
    }
    function view(item) {
      return Object.freeze({key: item.key, identity: item.identity, generation: item.generation,
        committedGeneration: item.committedGeneration, kind: item.kind, status: item.status, error: item.error});
    }
    function status(key) {
      if (key !== undefined) return entries.has(key) ? view(entries.get(key)) : null;
      const documents = [...entries.values()].map(view);
      const unsaved = documents.filter(item => item.status !== 'saved');
      return Object.freeze({status: unsaved.find(item => item.status === 'conflict')?.status ||
        unsaved.find(item => item.status === 'failed' || item.status === 'cancelled')?.status ||
        (unsaved.length ? 'pending' : 'saved'), generation, blocked: barrier !== null,
        unsaved: unsaved.length, pending: unsaved.filter(item => item.status === 'pending').length,
        documents: Object.freeze(documents)});
    }
    function publish(event) {
      const current = status();
      for (const listener of listeners) { try { listener(current, event); } catch { /* UI listeners cannot undo a committed write. */ } }
    }
    function ticket(item) {
      let resolve;
      const committed = new Promise(done => { resolve = done; });
      item.waiters.push({generation: item.generation, resolve});
      return Object.freeze({accepted: true, key: item.key, identity: item.identity, generation: item.generation, committed});
    }
    function rejected(key, identity, code) {
      return Object.freeze({accepted: false, key, identity, generation, committed: Promise.resolve(problem(code))});
    }
    function settle(item, through, result) {
      const ready = item.waiters.filter(waiter => waiter.generation <= through);
      item.waiters = item.waiters.filter(waiter => waiter.generation > through);
      for (const waiter of ready) waiter.resolve(Object.freeze({...result, key: item.key, identity: item.identity,
        generation: waiter.generation, committedGeneration: result.ok ? through : item.committedGeneration}));
    }
    function cancelUncaptured(item, result) {
      const captured = running?.batch.find(saved => saved.item === item)?.generation ?? -1;
      const later = item.waiters.filter(waiter => waiter.generation > captured);
      item.waiters = item.waiters.filter(waiter => waiter.generation <= captured);
      for (const waiter of later) waiter.resolve(Object.freeze({...result, key: item.key, identity: item.identity,
        generation: waiter.generation, committedGeneration: item.committedGeneration}));
    }
    function clearClock() { if (timer !== null) clearTimer(timer); timer = null; }
    function schedule() {
      clearClock();
      if (running || barrier || !hasPending()) return;
      firstQueued ??= now();
      timer = setTimer(() => { timer = null; void start(); }, Math.max(0, Math.min(delay, maxWait - (now() - firstQueued))));
    }
    function queueDocuments(changes) {
      // Register the entire group before any subscriber can start a snapshot.
      // A rejected group has no partial registration or write-side effects.
      const keys = new Set();
      const live = new Map(getDocuments().map(doc => [doc.key, doc]));
      const invalid = barrier ? 'cancelled' : changes.some(({key, identity, kind = 'update'}) => {
        const duplicate = keys.has(key); keys.add(key);
        return duplicate || !identity || identity.key !== key || (kind === 'remove' ? live.has(key) : live.get(key) !== identity);
      }) ? 'identity' : null;
      if (invalid) return Object.freeze({accepted: false, tickets: Object.freeze(changes.map(({key, identity}) => rejected(key, identity, invalid)))});
      const group = joinGroups(changes);
      const tickets = changes.map(({key, identity, kind = 'update', rollback}) => register(key, identity, kind, rollback));
      if (group?.conflict) quarantine(group, group.conflict);
      if (tickets.length) { firstQueued ??= now(); schedule(); publish({type: 'queued', keys: Object.freeze(tickets.map(item => item.key))}); }
      return Object.freeze({accepted: true, tickets: Object.freeze(tickets)});
    }
    function queueDocument(key, identity, kind = 'update', options = {}) {
      return queueDocuments([{key, identity, kind, rollback: options.rollback}]).tickets[0];
    }
    function register(key, identity, kind, rollback) {
      let item = entries.get(key);
      const previous = typeof rollback === 'function' ? item : null;
      if (rollback || !item || item.identity !== identity || (item.kind === 'remove') !== (kind === 'remove')) {
        // Replacing/undoing a key never inherits the previous object's receipt.
        // A previously captured write still settles truthfully for that object.
        if (item) cancelUncaptured(item, problem('cancelled', 'Superseded identity'));
        item = entry(key, identity, ++generation, kind); entries.set(key, item);
      } else {
        item.generation = ++generation; item.kind = kind; item.status = 'pending'; item.error = null;
      }
      if (typeof rollback === 'function') item.operation = {generation: item.generation, previous, rollback};
      return ticket(item);
    }
    function reconcileFailure(item, version, result) {
      const owner = item.operation;
      if (owner?.generation !== version || owner.reconciled || item.generation !== version || entries.get(item.key) !== item) return;
      // Disarm before calling user-owned rollback code: it can synchronously
      // register another overlapping group and reenter conflict reconciliation.
      owner.reconciled = true;
      // Undo only this structural mutation before receipt observers or a waiting
      // flush capture another whole-library write. No success is ever rolled back.
      let rolledBack = false;
      try { rolledBack = owner.rollback(result) === true; } catch { /* Preserve failed state for rescue. */ }
      const live = getDocuments().find(doc => doc.key === item.key);
      const matchesBaseline = owner.previous ? (owner.previous.kind === 'remove' ? !live : live === owner.previous.identity) : !live;
      // A synchronous restore event may register a newer generation inside the
      // callback. Recheck ownership after it returns; that ticket must survive.
      if (rolledBack && entries.get(item.key) === item && item.generation === version && item.operation === owner && matchesBaseline) {
        if (owner.previous) {
          const previous = owner.previous;
          if (dirty(previous)) { previous.status = result.status; previous.error = result.error || null; }
          entries.set(item.key, previous);
        } else entries.delete(item.key);
      }
      if (item.operation === owner) item.operation = null;
    }
    async function start() {
      if (running) return running.done;
      clearClock(); firstQueued = null;
      if (!hasPending()) return;
      // Legacy writes still capture the complete library. Per-document writes
      // omit known-conflicted atomic groups, without rebasing their CAS tokens.
      // Other failures retain the established full dirty-batch retry behavior.
      const batch = [...entries.values()].filter(capturable).map(item => ({item, generation: item.generation, kind: item.kind}));
      const controller = new AbortController();
      const operation = {batch, controller, done: null}; running = operation;
      operation.done = (async () => {
        let result, checkpoints = [];
        try {
          const documents = getDocuments();
          const identities = new Map(documents.map(doc => [doc.key, doc]));
          for (const saved of batch) {
            const item = saved.item;
            if (item.kind === 'remove' ? identities.has(item.key) : identities.get(item.key) !== item.identity) throw {code: 'identity', message: 'Document identity changed before capture'};
          }
          const changes = batch.map(({item, generation, kind}) => ({key: item.key, identity: item.identity, generation, kind}));
          const value = perDocument ? adapter.prepareChanges(changes) : adapter.prepare(documents);
          const capturedDocuments = perDocument ? changes.filter(change => change.kind !== 'remove').map(change => change.identity) : documents;
          checkpoints = capturedDocuments.map(doc => Object.freeze({key: doc.key, identity: doc,
            generation: entries.get(doc.key)?.generation ?? 0, checkpoint: copy(checkpoint(doc))}));
          result = await adapter.write(value, {signal: controller.signal});
          if (!result || typeof result.ok !== 'boolean') result = problem('unexpected', 'Writer returned no commit receipt');
        } catch (error) { result = failure(error); }
        const changes = batch.map(saved => Object.freeze({key: saved.item.key, identity: saved.item.identity,
          generation: saved.generation, kind: saved.kind}));
        result = Object.freeze({...result, changes: Object.freeze(changes), checkpoints: Object.freeze(checkpoints)});
        // Only a keyed document CAS conflict is safely isolatable. Quota,
        // protocol, fence, connection and keyless failures remain global.
        const conflictGroup = perDocument && !controller.signal.aborted && !result.ok &&
          result.error?.code === 'conflict' && batch.some(saved => saved.item.key === result.key) ? groups.get(result.key) : null;
        if (conflictGroup) conflictGroup.conflict = Object.freeze({ok: false, status: result.status, error: result.error, key: result.key});
        for (const saved of batch) {
          const item = saved.item;
          if (conflictGroup && !quarantined(item) && entries.get(item.key) === item) {
            // The mixed transaction aborted; none of these generations saved.
            // Keep independent tickets waiting for a newly validated transaction.
            if (item.generation === saved.generation) { item.status = 'pending'; item.error = null; }
            continue;
          }
          if (result.ok) item.committedGeneration = Math.max(item.committedGeneration, saved.generation);
          // A late success or failure cannot clear a newer edit or failure.
          if (item.generation === saved.generation) { item.status = result.status; item.error = result.error || null; }
          if (!result.ok) reconcileFailure(item, saved.generation, result);
          else if (item.operation?.generation === saved.generation) item.operation = null;
          settle(item, saved.generation, result);
          // Successful deletion must not become an unbounded hidden undo bin.
          // The app owns its explicit one-slot recovery copy.
          if (result.ok && saved.kind === 'remove' && item.generation === saved.generation && entries.get(item.key) === item) entries.delete(item.key);
        }
        if (conflictGroup) quarantine(conflictGroup, result);
        pruneGroups();
        running = null;
        publish({type: 'commit', result});
        schedule();
        return result;
      })();
      return operation.done;
    }
    async function flush({token} = {}) {
      if (token && barrier?.token !== token) return problem('cancelled');
      const willCapture = hasPending();
      const waits = [...entries.values()].filter(dirty).map(item =>
        (willCapture && capturable(item)) || running?.batch.some(saved => saved.item === item && saved.generation >= item.generation) ? ticket(item).committed :
        Promise.resolve({...problem(item.error?.code || item.status), key: item.key, identity: item.identity, generation: item.generation}));
      // Force this and any successor already included in the flush boundary.
      // Edits queued later remain pending rather than extending the boundary.
      const force = () => { if (!running && hasPending()) void start(); };
      const onChange = () => force(); listeners.add(onChange); force();
      const finish = Promise.all(waits).then(results => Object.freeze({ok: results.every(result => result.ok),
        status: results.every(result => result.ok) ? 'saved' : results.find(result => !result.ok).status, results}));
      const released = token ? barrier.released : null;
      try {
        const result = await (released ? Promise.race([finish, released]) : finish);
        return token && barrier?.token !== token ? problem('cancelled') : result;
      }
      finally { listeners.delete(onChange); }
    }
    function retry(key) {
      if (barrier) return Promise.resolve(problem('cancelled'));
      const retryGroup = key === undefined ? null : groups.get(key);
      for (const item of entries.values()) if (dirty(item) && (key === undefined || item.key === key || groups.get(item.key) === retryGroup && retryGroup)) {
        const group = groups.get(item.key); if (group) group.conflict = null;
        // A timed-out discard may still be waiting for its writer to abort.
        // Recovery is a new intent; that late abort must not consume it.
        if (running?.controller.signal.aborted && running.batch.some(saved => saved.item === item)) item.generation = ++generation;
        item.status = 'pending'; item.error = null;
      }
      publish({type: 'retry'}); return flush();
    }
    function acquireBarrier(attemptId) {
      if (barrier) return null;
      const token = Object.freeze({attemptId, generation});
      let release;
      const released = new Promise(resolve => { release = resolve; });
      barrier = {token, released, release}; clearClock(); publish({type: 'barrier'}); return token;
    }
    function releaseBarrier(token) {
      if (barrier?.token !== token) return false;
      barrier.release(problem('cancelled', 'Lifecycle attempt released')); barrier = null;
      schedule(); publish({type: 'release'}); return true;
    }
    async function discardPending(token) {
      if (barrier?.token !== token) return problem('cancelled');
      clearClock();
      const operation = running;
      for (const item of entries.values()) if (dirty(item)) {
        item.status = 'cancelled'; item.error = {code: 'cancelled', message: 'Discard requested'};
        // Keep memory dirty if the native close subsequently fails or times out.
        const captured = operation?.batch.find(saved => saved.item === item)?.generation ?? -1;
        if (item.operation && item.operation.generation > captured) reconcileFailure(item, item.operation.generation, problem('cancelled'));
        cancelUncaptured(item, problem('cancelled'));
      }
      pruneGroups();
      operation?.controller.abort();
      const released = barrier.released;
      const settled = Promise.resolve(operation?.done).then(result => barrier?.token === token ?
        Object.freeze({ok: true, status: 'discarded', committed: result?.ok === true}) : problem('cancelled'));
      publish({type: 'discard'});
      const result = await Promise.race([settled, released]);
      return barrier?.token === token ? result : problem('cancelled');
    }
    function snapshotForExport() {
      const unsaved = [...entries.values()].filter(dirty);
      return {documents: copy(unsaved.map(item => getDocuments().find(doc => doc.key === item.key) || item.identity)),
        pendingRemovals: unsaved.filter(item => item.kind === 'remove').map(item => item.key)};
    }
    return Object.freeze({queueDocument, queueDocuments, flush, retry, status, snapshotForExport, acquireBarrier, releaseBarrier,
      barrierActive: token => barrier?.token === token, discardPending,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }});
  }
  const api = {create, createLegacyAdapter, KEY, FENCE_KEY};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CoconutLibraryStore = api;
})(typeof window !== 'undefined' ? window : globalThis);
