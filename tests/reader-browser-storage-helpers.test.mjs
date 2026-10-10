/** Node-only checks for acceptance polling; no browser is launched. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {storageAssertions, waitForPersistedLibrary} from './helpers/browser-storage.mjs';

test('persisted-record polling awaits false reads until the actual committed condition is true',async()=>{
 let reads=0;const arg={key:'authored'},predicate=async value=>{await Promise.resolve();assert.equal(value,arg);return ++reads>=3;};
 const page={evaluate:async(fn,value)=>fn(value)};
 await waitForPersistedLibrary(page,predicate,arg,{timeout:2000});
 assert.equal(reads,3);
});
test('persisted-record polling cannot accept an unresolved Promise as save evidence',async()=>{
 let release,settled=false,reads=0;
 const page={evaluate:()=>{reads++;return new Promise(resolve=>{release=resolve;});}};
 const waiting=waitForPersistedLibrary(page,()=>false,null,{timeout:2000}).then(()=>{settled=true;});
 for(let i=0;i<20&&!release;i++)await Promise.resolve();
 assert.equal(reads,1);assert.equal(settled,false);
 release(true);await waiting;assert.equal(settled,true);
});
test('persisted-record polling fails truthfully when storage never reaches the expected state',async()=>{
 let reads=0;
 await assert.rejects(waitForPersistedLibrary({evaluate:async()=>{reads++;return false;}},()=>false,null,{timeout:25}),/Committed library storage did not reach the expected state/);
 assert.ok(reads>=1);
});
test('persisted-record polling never converts a rejected storage read into success',async()=>{
 await assert.rejects(waitForPersistedLibrary({evaluate:async()=>{throw Error('Authored storage read failed');}},()=>false,null,{timeout:25}),/Committed library storage did not reach the expected state|Authored storage read failed/);
});
test('browser acceptance does not use truthy async predicates with waitForFunction',async()=>{
 const directory=new URL('./',import.meta.url);
 for(const filename of await fs.readdir(directory)){
  if(!filename.endsWith('.mjs')||!filename.includes('browser'))continue;
  const source=await fs.readFile(new URL(filename,directory),'utf8');
  assert.doesNotMatch(source,/\.waitForFunction\(\s*async\b/,filename+' must use awaited storage polling');
 }
});

test('prepared-job acceptance binds deferred storage polling in the top-level document helper scope',async()=>{
 const source=await fs.readFile(new URL('./browser-acceptance.mjs',import.meta.url),'utf8');
 const declaration=source.match(/^let browser, server, temporary[^;]*;/m)?.[0];assert.ok(declaration);
 const helper=source.slice(source.indexOf('async function waitForDocument('),source.indexOf('async function importFile('));
 const start=source.indexOf("  const {chromium, waitForPersistedLibrary: pollStored}");assert.notEqual(start,-1);
 const initialization=source.slice(start,source.indexOf('  browser = await chromium.launch',start))
  .replace("await import('./helpers/browser-storage.mjs')",'helpers');
 const calls=[],page={locator:selector=>({click:async()=>{calls.push(selector);}})};
 const helpers={waitForPersistedLibrary:async(target,predicate,arg)=>{assert.equal(target,page);assert.equal(typeof predicate,'function');calls.push(arg);}};
 await vm.runInNewContext(declaration+'\n'+helper+'\n(async()=>{'+initialization+'await waitForDocument(page,3);})()', {page,helpers});
 assert.deepEqual(calls,[3,'#mode-transcript']);
});

// Exercise the same injected browser function without launching Chromium. The
// doubles preserve native method receivers, arguments and restore identities.
for (const backend of ['indexeddb', 'legacy']) test(`content fault injection targets ${backend} and restores real writers`, () => {
 const calls = [];
 class Store {
  constructor(database, name) { this.transaction = {db: {name: database}}; this.name = name; }
 }
 for (const method of ['put', 'add', 'delete']) Store.prototype[method] = function(...args) { calls.push({receiver: this, method, args}); return 'written'; };
 class Storage { setItem(...args) { calls.push({receiver: this, method: 'setItem', args}); return 'written'; } }
 const localStorage = new Storage(), sessionStorage = new Storage();
 const originals = new Map(['put', 'add', 'delete'].map(method => [method, Store.prototype[method]]));
 const originalSetItem = Storage.prototype.setItem;
 const window = {CoconutStorageBootstrap: {result: {backend}}};
 vm.runInNewContext(`(${storageAssertions.toString()})();`, {window, IDBObjectStore: Store, Storage, localStorage, DOMException});
 window.failContentWrites();
 const content = new Store('coconut-reader-library-v1', 'documents');
 if (backend === 'indexeddb') {
  for (const method of originals.keys()) {
   assert.throws(() => content[method]('value', 'key'), {name: 'QuotaExceededError'});
   for (const store of [new Store('other-database', 'documents'), new Store('coconut-reader-library-v1', 'catalog')]) {
    assert.equal(store[method]('value', 'key'), 'written');
    assert.deepEqual(calls.at(-1), {receiver: store, method, args: ['value', 'key']});
   }
  }
  assert.equal(Storage.prototype.setItem, originalSetItem);
  assert.equal(localStorage.setItem('coconut-reader-v1', 'value'), 'written');
 } else {
  assert.throws(() => localStorage.setItem('coconut-reader-v1', 'value'), {name: 'QuotaExceededError'});
  assert.equal(localStorage.setItem('unrelated-preference', 'value'), 'written');
  assert.equal(sessionStorage.setItem('coconut-reader-v1', 'value'), 'written');
  for (const [method, original] of originals) assert.equal(Store.prototype[method], original);
 }
 window.restoreContentWrites();
 assert.equal(Storage.prototype.setItem, originalSetItem);
 for (const [method, original] of originals) {
  assert.equal(Store.prototype[method], original);
  assert.equal(content[method]('value', 'key'), 'written');
 }
 assert.equal(localStorage.setItem('coconut-reader-v1', 'value'), 'written');
});

test('passage quota acceptance injects the selected backend and waits for a failed receipt', async () => {
 const source = await fs.readFile(new URL('./passages-browser.mjs', import.meta.url), 'utf8');
 const scenario = source.slice(source.indexOf('    const blockedPage = await freshPage(viewport);'), source.indexOf('    await blockedPage.context().close();'));
 assert.match(scenario, /window\.failContentWrites\(\)/);
 assert.doesNotMatch(scenario, /Storage\.prototype\.setItem/);
 assert.match(scenario, /toHaveAttribute\('data-state', 'failed'\)/);
 assert.match(scenario, /window\.restoreContentWrites\(\)/);
});
