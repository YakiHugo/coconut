// Deterministic transaction double, NOT an IndexedDB implementation or browser proof.
// It models only the request/event/atomicity surface used by the storage adapter.
export function transactionDouble() {
  const databases = new Map(), transactions = [], operations = [], connections = [];
  const control = {failMutation: null, holdNextWrite: false, holdNextRead: false, holdAbortEvents: false, abortEvents: [], held: [], openError: null,
    blocked: false, blockedOpens: [], corruptRead: null};
  let active = null, queue = [];
  const later = callback => queueMicrotask(callback);
  const error = (name, message = name) => Object.assign(new Error(message), {name});
  const fire = (target, type, extra = {}) => target['on' + type]?.({target, ...extra});
  const cloneStores = stores => new Map([...stores].map(([key, values]) => [key, new Map([...values].map(([k, v]) => [k, structuredClone(v)]))]));
  function schedule() { if (active || !queue.length) return; active = queue.shift(); active.begin(); }
  function release(tx) { if (active === tx) active = null; later(schedule); }
  function makeTransaction(connection, names, mode) {
    if (connection.closed) throw error('InvalidStateError');
    const tx = {connection, mode, names, stores: null, requests: [], ended: false, started: false, error: null, mutations: 0,
      hold: mode === 'readwrite' ? control.holdNextWrite : control.holdNextRead, failAt: mode === 'readwrite' ? control.failMutation : null,
      begin() { tx.started = true; tx.stores = cloneStores(connection.data.stores); later(drain); },
      abort() {
        if (tx.ended) throw error('InvalidStateError'); tx.ended = true;
        const complete = () => { fire(tx, 'abort'); release(tx); };
        if (control.holdAbortEvents) control.abortEvents.push(complete); else later(complete);
      },
      objectStore(name) {
        if (!names.includes(name)) throw error('NotFoundError');
        const enqueue = (op, value, key) => {
          if (tx.ended) throw error('TransactionInactiveError');
          if (['put', 'add', 'delete'].includes(op) && mode !== 'readwrite') throw error('ReadOnlyError');
          const captured = structuredClone(value), request = {result: undefined, error: null};
          tx.requests.push({op, value: captured, key, name, request});
          operations.push({store: name, op, key, mode});
          return request;
        };
        return {get: key => enqueue('get', null, key), getAll: () => enqueue('getAll'), getAllKeys: () => enqueue('getAllKeys'), count: () => enqueue('count'),
          add: (value, key) => enqueue('add', value, key), put: (value, key) => enqueue('put', value, key), delete: key => enqueue('delete', null, key)};
      }};
    if (mode === 'readwrite') { control.holdNextWrite = false; control.failMutation = null; } else control.holdNextRead = false;
    function finish() {
      if (tx.ended) return;
      tx.ended = true;
      if (mode === 'readwrite') for (const name of names) connection.data.stores.set(name, tx.stores.get(name));
      fire(tx, 'complete'); release(tx);
    }
    function drain() {
      if (tx.ended) return;
      const item = tx.requests.shift();
      if (!item) {
        if (tx.hold) { tx.hold = false; control.held.push({tx, complete: finish, abort: () => tx.abort()}); }
        else later(finish);
        return;
      }
      const {op, value, key, name, request} = item;
      try {
        const store = tx.stores.get(name);
        if (!store) throw error('NotFoundError');
        if (['add', 'put', 'delete'].includes(op) && ++tx.mutations === tx.failAt) throw error('QuotaExceededError');
        if (control.corruptRead?.store === name && control.corruptRead.key === key && op === 'get') throw error('UnknownError');
        if (op === 'get') request.result = structuredClone(store.get(key));
        else if (op === 'getAll') request.result = structuredClone([...store.keys()].sort().map(key => store.get(key)));
        else if (op === 'getAllKeys') request.result = structuredClone([...store.keys()].sort());
        else if (op === 'count') request.result = store.size;
        else if (op === 'delete') store.delete(key);
        else { if (op === 'add' && store.has(key)) throw error('ConstraintError'); store.set(key, value); request.result = key; }
        fire(request, 'success');
      } catch (failure) {
        request.error = failure; tx.error = failure; fire(request, 'error'); fire(tx, 'error', {target: request});
        if (!tx.ended) tx.abort(); return;
      }
      later(drain);
    }
    transactions.push(tx); queue.push(tx); later(schedule); return tx;
  }
  const indexedDB = {open(name, version) {
    const request = {};
    const perform = () => {
      if (control.openError) { request.error = error(control.openError); fire(request, 'error'); return; }
      let data = databases.get(name);
      if (data && data.version > version) { request.error = error('VersionError'); fire(request, 'error'); return; }
      let aborted = false;
      if (!data) data = {version, stores: new Map()};
      const connection = {data, closed: false,
        objectStoreNames: {contains: name => data.stores.has(name)},
        createObjectStore(name) { data.stores.set(name, new Map()); },
        close() { connection.closed = true; },
        transaction: (names, mode) => makeTransaction(connection, typeof names === 'string' ? [names] : names, mode)};
      connections.push(connection); request.result = connection;
      if (!databases.has(name)) {
        request.transaction = {abort() { aborted = true; later(() => fire(request.transaction, 'abort')); }}; fire(request, 'upgradeneeded', {oldVersion: 0});
        if (aborted) { request.error = error('AbortError'); fire(request, 'error'); return; }
        databases.set(name, data); fire(request.transaction, 'complete');
      }
      fire(request, 'success');
    };
    later(() => { if (control.blocked) { control.blockedOpens.push(perform); fire(request, 'blocked'); } else perform(); });
    return request;
  }};
  return {indexedDB, control, transactions, operations, connections, databases,
    async tick() { for (let i = 0; i < 250; i++) await Promise.resolve(); },
    versionchange() { for (const connection of connections) if (!connection.closed) fire(connection, 'versionchange'); },
    unexpectedClose() { for (const connection of connections) if (!connection.closed) { connection.closed = true; fire(connection, 'close'); } },
    rows(name = 'test') { return databases.get(name).stores; }};
}
