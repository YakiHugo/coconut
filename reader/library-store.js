(function (root) {
  'use strict';

  const KEY = 'coconut-reader-v1';
  const FENCE_KEY = 'coconut-reader-storage-fence-v1';
  const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
  function failure(error, fallback = 'unexpected') {
    const code = (typeof error?.code === 'string' ? error.code : null) || ({QuotaExceededError: 'quota', SecurityError: 'denied',
      AbortError: 'cancelled', InvalidStateError: 'unavailable'}[error?.name]) || fallback;
    return Object.freeze({ok: false, status: code === 'cancelled' ? 'cancelled' :
      code === 'conflict' ? 'conflict' : 'failed', error: Object.freeze({code, message: String(error?.message || error || code),
      ...(typeof error?.retryable === 'boolean' ? {retryable: error.retryable} : {})})});
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
          const normalized={...validate(doc),key:doc.key},project=root.CoconutCanonicalLibrary?.project||(typeof module!=='undefined'&&module.exports?require('./canonical-library.js').project:null);
          return project?project(doc,normalized):{...doc,...normalized};
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
    const maxBatchSize = perDocument && Number.isSafeInteger(adapter.maxBatchSize) && adapter.maxBatchSize > 0 ? adapter.maxBatchSize : Infinity;
    const maxBatchBytes = perDocument && typeof adapter.estimateBatchBytes === 'function' && Number.isSafeInteger(adapter.maxBatchBytes) && adapter.maxBatchBytes > 0 ? adapter.maxBatchBytes : Infinity;
    const bounded = Number.isFinite(maxBatchSize) || Number.isFinite(maxBatchBytes);
    // Dirty atomic groups are page-owned dependencies, not revision tokens.
    // Overlap joins groups until their captured generations are acknowledged.
    const groups = new Map();
    let generation = 0, attempt = 0, timer = null, firstQueued = null, running = null, barrier = null;
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
      const group = {keys: new Set(changes.map(change => change.key)), conflict: null, conflicted: false};
      for (const previous of joined) {
        group.conflicted ||= previous.conflicted || Boolean(previous.conflict && !previous.conflict.uncertain);
        // Preserve an unknown outcome without making an existing CAS conflict
        // implicitly retryable when the two dependency groups are joined.
        if (previous.conflict?.uncertain || !group.conflict) group.conflict = previous.conflict;
        for (const key of previous.keys) group.keys.add(key);
      }
      if (group.keys.size > maxBatchSize) return {error: {code: 'atomic_batch_too_large', retryable: false,
        message: `Atomic document group contains ${group.keys.size} changes; this storage backend accepts at most ${maxBatchSize}.`}};
      for (const key of group.keys) groups.set(key, group);
      return group;
    }
    const quarantined = item => perDocument && groups.get(item.key)?.conflict;
    const capturable = item => dirty(item) && item.error?.code !== 'uncertain' && !quarantined(item);
    // A failed bounded transaction cannot starve untouched successor batches.
    // A fresh queue/retry intent still retries the full eligible dirty library.
    const eligible = item => capturable(item) && (item.status === 'pending' || item.failedAttempt !== attempt);
    const changesFor = items => items.map(item => ({key: item.key, identity: item.identity, generation: item.generation, kind: item.kind}));
    function batchProblem(changes) {
      if (changes.length > maxBatchSize) return {code: 'atomic_batch_too_large', retryable: false, limit: 'count',
        message: `Atomic document group contains ${changes.length} changes; this storage backend accepts at most ${maxBatchSize}.`};
      if (Number.isFinite(maxBatchBytes)) {
        try {
          const size = adapter.estimateBatchBytes(changes);
          if (!Number.isSafeInteger(size) || size < 0) return {code: 'protocol', retryable: false, message: 'Invalid storage batch byte estimate.'};
          if (size > maxBatchBytes) return {code: 'atomic_batch_too_large', retryable: false, limit: 'bytes',
            message: `Atomic document group requires ${size} bytes; this storage backend accepts at most ${maxBatchBytes}.`};
        } catch (error) { return failure(error).error; }
      }
      return null;
    }
    function preflightDocuments(changes) {
      // Restore can check proposed identities before inserting them into the
      // live library. This does not register, capture, or mutate any document.
      const proposed = new Map();
      for (const change of changes) {
        if (!change.identity || change.identity.key !== change.key || proposed.has(change.key)) return problem('identity');
        proposed.set(change.key, {...change, kind: change.kind || 'update'});
      }
      for (const change of changes) for (const key of groups.get(change.key)?.keys || []) {
        const item = entries.get(key);
        if (item && dirty(item) && !proposed.has(key)) proposed.set(key, changesFor([item])[0]);
      }
      const error = batchProblem([...proposed.values()]);
      return error ? Object.freeze({...failure(error), limit: error.limit || 'document'}) : Object.freeze({ok: true});
    }
    function captureBatch() {
      const candidates = [...entries.values()].filter(capturable);
      if (!bounded) return candidates;
      const grouped = new Map();
      for (const item of candidates) {
        const group = groups.get(item.key) || item;
        if (!grouped.has(group)) grouped.set(group, []);
        grouped.get(group).push(item);
      }
      const units = [...grouped.values()].filter(unit => unit.some(eligible));
      const select = count => {
        const members = new Set(units.slice(0, count).flat());
        return candidates.filter(item => members.has(item));
      };
      // Find the largest ordered prefix of complete groups. Binary search
      // avoids repeatedly serializing growing multi-megabyte document batches.
      let low = 0, high = units.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (batchProblem(changesFor(select(middle)))) high = middle - 1;
        else low = middle;
      }
      // A document may grow after registration. Capture that one whole group
      // so its budget failure settles honestly rather than spinning or hanging.
      return select(Math.max(1, low));
    }
    const hasPending = () => [...entries.values()].some(item => item.status === 'pending' && capturable(item));
    function quarantine(group, result) {
      if (!group) return;
      group.conflicted ||= !result.uncertain && result.error?.code === 'conflict';
      group.conflict = Object.freeze({ok: false, status: result.status, error: result.error, key: result.key, ...(result.uncertain ? {uncertain: true} : {})});
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
    function rejected(key, identity, reason) {
      return Object.freeze({accepted: false, key, identity, generation, committed: Promise.resolve(typeof reason === 'string' ? problem(reason) : failure(reason))});
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
      const preflight = preflightDocuments(changes);
      if (!preflight.ok && (preflight.limit === 'count' || preflight.error.code === 'identity')) return Object.freeze({accepted: false, tickets: Object.freeze(changes.map(({key, identity}) => rejected(key, identity, preflight.error)))});
      const group = joinGroups(changes);
      if (group?.error) return Object.freeze({accepted: false, tickets: Object.freeze(changes.map(({key, identity}) => rejected(key, identity, group.error)))});
      if (preflight.ok && group?.conflict?.uncertain && !group.conflicted) {
        // New intent on an uncertain member re-enables its entire dependency
        // group. An unrelated document must not replay that structural intent.
        group.conflict = null;
        for (const key of group.keys) {
          const item = entries.get(key);
          if (item && dirty(item)) { item.status = 'pending'; item.error = null; }
        }
      }
      if (changes.length) attempt++;
      const tickets = changes.map(({key, identity, kind = 'update', rollback}) => register(key, identity, kind, rollback));
      if (group?.conflict) quarantine(group, group.conflict);
      else if (!preflight.ok) {
        // Ordinary editors mutate before enqueue. A byte-budget rejection must
        // retain that exact content as dirty/rescuable, never leave it 'saved'.
        // Older generations already captured by a writer keep their own receipt.
        for (const key of group?.keys || changes.map(change => change.key)) {
          const item = entries.get(key); if (!item || !dirty(item)) continue;
          const captured = running?.batch.find(saved => saved.item === item)?.generation ?? -1;
          if (item.generation <= captured) continue;
          item.status = preflight.status; item.error = preflight.error; item.failedAttempt = attempt;
          reconcileFailure(item, item.generation, preflight); cancelUncaptured(item, preflight);
        }
        pruneGroups();
      }
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
      // An unacknowledged write may already be durable; never invent a rollback.
      if (result.uncertain) return;
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
      // Other failures retry on new intent, without replaying a failed chunk
      // simply because an untouched independent successor is still pending.
      const batch = captureBatch().map(item => ({item, generation: item.generation, kind: item.kind}));
      const controller = new AbortController();
      const operation = {batch, controller, attempt, done: null}; running = operation;
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
          const budget = batchProblem(changes); if (budget) throw budget;
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
          if (!result.ok) item.failedAttempt = operation.attempt;
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
        if (result.uncertain) {
          for (const group of new Set(batch.map(saved => groups.get(saved.item.key)).filter(Boolean))) quarantine(group, result);
        }
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
        (willCapture && (bounded ? eligible(item) : capturable(item))) || running?.batch.some(saved => saved.item === item && saved.generation >= item.generation) ? ticket(item).committed :
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
      attempt++;
      const retryGroup = key === undefined ? null : groups.get(key);
      for (const item of entries.values()) if (dirty(item) && (key === undefined || item.key === key || groups.get(item.key) === retryGroup && retryGroup)) {
        const group = groups.get(item.key); if (group) { group.conflict = null; group.conflicted = false; }
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
      if ([...entries.values()].some(item => dirty(item) && item.error?.code === 'uncertain')) {
        return problem('uncertain', 'Resolve the uncertain storage write before discarding pending changes.');
      }
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
        result?.uncertain || [...entries.values()].some(item => dirty(item) && item.error?.code === 'uncertain') ?
          problem('uncertain', 'Resolve the uncertain storage write before discarding pending changes.') :
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
    return Object.freeze({queueDocument, queueDocuments, preflightDocuments, flush, retry, status, snapshotForExport, acquireBarrier, releaseBarrier,
      barrierActive: token => barrier?.token === token, discardPending,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }});
  }
  const api = {create, createLegacyAdapter, KEY, FENCE_KEY};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CoconutLibraryStore = api;
})(typeof window !== 'undefined' ? window : globalThis);
