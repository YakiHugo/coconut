import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {startDevelopmentBridge} from '../desktop/dev.mjs';
import {transactionDouble} from './helpers/indexeddb-transaction-double.mjs';
const require=createRequire(import.meta.url),provider=require('../reader/storage-provider.js'),canonical=require('../reader/canonical-library.js'),pipeline=require('../reader/library-store.js'),core=require('../reader/core.js'),idb=require('../reader/indexeddb-document-adapter.js');
const compiled=await build({entryPoints:['frontend/app/store.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {createAppStore}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].contents).toString('base64'));
const doc={schema_version:1,title:'Fresh server source',language:'en',segments:[{id:'cue',start:0,end:1,text:'Authored offline source'}],notes:{},ai_answers:[]};
async function fixture(t){
 const directory=await mkdtemp('/tmp/coconut-server-default-');const {server,origin,library}=await startDevelopmentBridge({port:0,libraryDirectory:directory,taskDirectory:null,captionPython:null,captionProxy:null,privateProxy:null,providers:{status:()=>{throw Error('No provider access')}}});
 const originalFetch=globalThis.fetch,originalCanonical=globalThis.CoconutCanonicalLibrary,calls=[];globalThis.CoconutCanonicalLibrary=canonical;
 globalThis.fetch=(url,options={})=>{calls.push({url,method:options.method||'GET'});return originalFetch(new URL(url,origin),{...options,headers:{...options.headers,...(options.method==='POST'?{Origin:origin}:{})}})};
 t.after(async()=>{globalThis.fetch=originalFetch;globalThis.CoconutCanonicalLibrary=originalCanonical;await new Promise(resolve=>server.shutdown(resolve));await rm(directory,{recursive:true,force:true});});
 const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem(){throw Error('No browser storage writes permitted')}};
 const init=(extra={})=>provider.initialize({indexedDB:{databases:async()=>[],open(){throw Error('Fresh browser must not open IDB')}},getStorage:()=>storage,validate:core.validate,...extra});
 return {directory,server,origin,library,calls,values,storage,init,get:url=>originalFetch(origin+url).then(r=>r.json())};
}
test('production React store first document saves directly to real SQLite; independent clients see it',async t=>{
 const f=await fixture(t),[first,second]=await Promise.all([f.init(),f.init()]);assert.equal(first.backend,'canonical');assert.equal(second.backend,'canonical');assert.equal(f.library.sequence,0);assert.ok(f.library.binding.mediaLibraryIdentity);
 const app=createAppStore({documents:first.loaded.documents,active:null,validate:core.validate,project:canonical.project,planBackup:core.planLibraryBackup,createPipeline:getDocuments=>pipeline.create({adapter:first.adapter,getDocuments})});
 const saved=app.addDocument(doc);assert.ok(saved);assert.equal((await app.flush()).ok,true);
 const record=(await f.get('/api/v1/library/document?protocolVersion=1&key='+saved.key)).record;assert.equal(record.document.title,doc.title);assert.equal(record.token.revision,1);assert.equal(record.identity.lifetime,1);assert.equal(first.adapter.documentEpoch(saved.key),1);assert.equal((await first.adapter.mediaLibraryIdentity()).identity,f.library.binding.mediaLibraryIdentity);
 const reloaded=await f.init();assert.equal(reloaded.loaded.documents[0].key,saved.key);assert.ok(f.calls.some(call=>call.url==='/api/v1/library/batch'&&call.method==='POST'));assert.equal(f.values.size,0);assert.equal((await readFile(f.directory+'/library.sqlite')).subarray(0,16).toString(),'SQLite format 3\0');
 app.dispose?.();first.adapter.close();second.adapter.close();reloaded.adapter.close();
});
test('server unavailable fails explicitly, preserves legacy bytes, never writes browser fallback',async t=>{
 const f=await fixture(t);f.values.set('coconut-reader-v1','{broken legacy bytes\ud800');globalThis.fetch=async()=>{throw Error('Authored server offline')};
 const result=await f.init();assert.equal(result.ok,false);assert.equal(result.adapter,undefined);assert.equal(result.retainedBrowserData,true);assert.equal(result.legacyRaw,f.values.get('coconut-reader-v1'));assert.match(result.error.message,/offline/);
});
test('existing IndexedDB rows and frozen marker are observed only, without import or modification',async t=>{
 const f=await fixture(t),engine=transactionDouble(),values=new Map(),legacy={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
 values.set('coconut-reader-v1',JSON.stringify({documents:[{...doc,key:'old-browser'}]}));const primitive=idb.create({indexedDB:engine.indexedDB,name:provider.NAME,getLegacyStorage:()=>legacy,validate:core.validate});assert.equal((await primitive.ready()).ok,true);
 engine.rows(provider.NAME).get('meta').set('canonical-migration',{state:'frozen',migrationId:'authored-unknown',epoch:'old-server'});const before=structuredClone(engine.rows(provider.NAME)),originalValues=[...values];engine.transactions.length=0;let storage;
 const result=await f.init({indexedDB:engine.indexedDB,getStorage:()=>legacy,onStorage:value=>{storage=value}});assert.equal(result.backend,'canonical');assert.equal(result.loaded.documents.length,0);assert.equal(result.retainedBrowserData,true);assert.deepEqual(engine.rows(provider.NAME),before);assert.deepEqual([...values],originalValues);assert.ok(engine.transactions.every(tx=>tx.mode==='readonly'));assert.equal((await storage.readRecovery()).stores.documents[0].value.payload.key,'old-browser');assert.equal((await f.get('/api/v1/library/catalog?protocolVersion=1')).entries.length,0);primitive.close();result.adapter.close();
});
test('two current clients retain CAS conflict protection and stable empty binding',async t=>{
 const f=await fixture(t),a=await f.init(),b=await f.init(),key='shared';const change=value=>[{key,identity:{...doc,key,title:value},kind:'update',generation:1}];
 assert.equal((await a.adapter.write(a.adapter.prepareChanges(change('A')))).ok,true);const stale=await b.adapter.write(b.adapter.prepareChanges(change('B')));assert.equal(stale.ok,false);assert.equal(stale.error.code,'revision_conflict');assert.deepEqual((await f.get('/api/v1/library')).binding,f.library.binding);a.adapter.close();b.adapter.close();
});
test('startup close aborts a held server request without creating another authority',async t=>{
 const f=await fixture(t);let entered,storage;const requested=new Promise(resolve=>{entered=resolve});globalThis.fetch=(_url,{signal})=>new Promise((_resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(Object.assign(Error('Authored request cancelled'),{code:'cancelled'})),{once:true})});
 const pending=f.init({onStorage:value=>{storage=value}});await requested;await storage.shutdown();const result=await pending;assert.equal(result.ok,false);assert.equal(result.error.code,'cancelled');assert.equal(result.adapter,undefined);assert.equal(f.values.size,0);
});
