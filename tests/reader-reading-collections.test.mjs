import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {transactionDouble} from './helpers/indexeddb-transaction-double.mjs';
const require=createRequire(import.meta.url),C=require('../reader/core.js'),Store=require('../reader/library-store.js'),Provider=require('../reader/storage-provider.js');
const stamp='2026-10-11T00:00:00.000Z',clone=v=>JSON.parse(JSON.stringify(v));
function source(key='source'){
 const doc={...C.validate({title:'Source '+key,language:'en',source_url:'https://www.youtube.com/watch?v=authored',segments:[{id:'a',start:1,end:3,text:'First exact original',speaker:'Alice',saved_excerpt:true},{id:'b',start:4,end:6,text:'Second original',original_text:'Before correction'}],notes:{a:'Private\r\nthought',b:'Second thought'},project_note:'Project thought',timestamp_bookmarks:[{id:'mark',time:7,note:'Time thought'}]}),key};
 doc.exact_excerpts=[C.exactExcerptSnapshot(doc,doc.segments, [' '],0,5,{id:'exact',createdAt:stamp})];doc.exact_excerpt_notes={exact:'Exact thought'};return doc;
}
function items(doc=source()) {return C.libraryCaptures([doc]).map((capture,i)=>C.collectionItemFromCapture(capture,[doc],{id:'item-'+i,createdAt:stamp}));}
function collection(doc=source()){return C.createReadingCollection({key:'collection',title:'My selected results',items:items(doc)});}
function memory(raw=JSON.stringify({documents:[]})) {const map=new Map([[Store.KEY,raw]]),writes=[];return {map,writes,getItem:key=>map.get(key)??null,setItem(key,value){writes.push([key,value]);map.set(key,value);}};}
const oldShapeValidator=doc=>{if(!doc.segments?.length&&doc.project_kind!=='audio_only')throw Error('文字稿必须包含 1–100,000 个片段');return C.validate(doc);};

test('collection snapshots every supported record without source writes or mutable sharing',()=>{
 const doc=source(),before=JSON.stringify(doc),saved=collection(doc);assert.equal(JSON.stringify(doc),before);assert.equal(saved.items.length,5);
 assert.deepEqual(saved.items.map(i=>i.origin.type),['cue','cue','exact-excerpt','project-note','bookmark']);
 assert.equal(saved.items[0].snapshot.note,'Private\r\nthought');assert.equal(saved.items[1].snapshot.original_text,'Before correction');assert.equal(saved.items[2].snapshot.exact_excerpt.text,'First');
 assert.ok(Object.isFrozen(saved.items[2].snapshot.exact_excerpt.snapshot));doc.notes.a='Changed';doc.title='Changed';doc.segments[0].text='Changed';doc.exact_excerpt_notes.exact='Changed';
 assert.equal(saved.items[0].snapshot.text,'First exact original');assert.equal(saved.items[0].snapshot.title,'Source source');assert.equal(saved.items[2].snapshot.note,'Exact thought');
});

test('multi-document ordered selection, rename and removal export only those exact items',()=>{
 const a=source('a'),b=source('b');b.notes.a='B thought';const first=items(a)[0],second={...items(b)[1],id:'b-item'};
 const saved=C.createReadingCollection({key:'set',title:'Ordered <topic>',items:[second,first]});const text=C.readingCollectionMarkdown(saved,[a,b]);
 assert.ok(text.indexOf('Second original')<text.indexOf('First exact original'));assert.match(text,/B|Second thought/);assert.doesNotMatch(text,/Project thought|Exact thought|Time thought/);assert.match(text,/Private\n> thought/);assert.match(text,/Ordered &lt;topic&gt;/);
 const changed=C.createReadingCollection({...saved,title:'New name',items:[first]});assert.equal(changed.key,saved.key);assert.equal(changed.items[0].id,first.id);assert.doesNotMatch(C.readingCollectionMarkdown(changed,[a,b]),/Second original/);
});

test('no current-source rebinding is fabricated from matching keys, labels or text',()=>{
 const doc=source(),item=items(doc)[0];assert.deepEqual(C.readingCollectionItemState(item,[doc]),{status:'historical',doc:null,cueId:null});
 assert.deepEqual(C.readingCollectionItemState(item,[]),{status:'missing',doc:null,cueId:null});
 const impostor={...source(),title:'Other version'};assert.equal(C.readingCollectionItemState(item,[impostor]).cueId,null);
 const before=JSON.stringify(item);C.mergeLibraryBackup({documents:[impostor],active:impostor.key},{format:'coconut-library',version:1,documents:[doc,collection(doc)],active:doc.key});assert.equal(JSON.stringify(item),before);
});

test('stale captures cannot be collected and collections cannot recursively become source records',()=>{
 const doc=source(),capture=C.libraryCaptures([doc])[0];doc.notes.a='New edit';assert.throws(()=>C.collectionItemFromCapture(capture,[doc],{id:'stale',createdAt:stamp}),/已更改/);
 const saved=collection();assert.deepEqual(C.libraryCaptures([saved]),[]);assert.equal(C.libraryMatches(saved,'My','all','title'),false);assert.deepEqual(C.libraryHits(saved,'My'),[]);
 assert.deepEqual(C.sortedLibrary([saved],'duration'),[]);assert.equal(C.documentDuration(saved),0);assert.equal(C.summaryReadiness(saved).ready,false);assert.throws(()=>C.transcriptText(saved),/成果集/);assert.throws(()=>C.subtitleExport(saved),/成果集/);
});

test('cooperative shelf and notebook engines exclude typed entries without cancelling valid ordinary results',()=>{
 const doc=source(),saved=collection(doc),docs=[saved,doc];const shelf=C.createLibrarySearch({getDocuments:()=>docs}),notebook=C.createLibraryNotebookSearch({getDocuments:()=>docs});
 const found=shelf.request('Source','all','title','title');assert.deepEqual(found.docs,[doc]);assert.equal(shelf.isCurrent(found),true);
 const captures=notebook.request('','all');assert.equal(captures.captures.length,5);assert.equal(notebook.isCurrent(captures),true);
});

for(const mode of ['single','mixed'])test(mode+' collection library v1 backup restores, deduplicates and never selects collection as transcript',()=>{
 const doc=source(),saved=collection(doc),documents=mode==='single'?[saved]:[doc,saved],backup={format:'coconut-library',version:1,documents,active:saved.key};
 const once=C.mergeLibraryBackup({documents:[],active:null},clone(backup));assert.equal(once.documents.length,documents.length);assert.equal(once.active,mode==='single'?null:doc.key);
 const again=C.mergeLibraryBackup(once,clone(backup));assert.equal(again.documents.length,documents.length);assert.deepEqual(again.documents.find(C.isReadingCollection).items,saved.items);
});

test('conflict copies retain immutable origins and repeated conflict restore is idempotent',()=>{
 const doc=source(),saved=collection(doc),edited={...clone(doc),title:'Current edited source'},changed={...clone(saved),title:'Current edited collection'};
 const backup={format:'coconut-library',version:1,documents:[doc,saved],active:doc.key};const merged=C.mergeLibraryBackup({documents:[edited,changed],active:edited.key},clone(backup));assert.equal(merged.documents.length,4);
 const restored=merged.documents.find(d=>d.key==='collection-restored-1');assert.deepEqual(restored.items,saved.items);assert.equal(restored.items[0].origin.documentKey,doc.key);assert.equal(C.readingCollectionItemState(restored.items[0],merged.documents).doc,null);
 assert.equal(C.mergeLibraryBackup(merged,clone(backup)).documents.length,4);
});

test('selected backup includes standalone collection and no implicitly attached source/private records',()=>{
 const doc=source(),saved=collection(doc),selection=C.createLibraryBackupSelection(),docs=[doc,saved];selection.toggle(saved,true,docs);const backup=selection.backup(docs,doc.key);assert.deepEqual(backup.documents,[saved]);const restored=C.mergeLibraryBackup({documents:[],active:null},clone(backup));assert.equal(restored.active,null);assert.equal(restored.documents[0].items.length,5);assert.match(C.readingCollectionMarkdown(restored.documents[0],restored.documents),/本书架未找到/);
});

test('source deletion and exact record removal cannot erase a collection, JSON remains byte-faithful',()=>{
 const doc=source(),saved=collection(doc),before=JSON.stringify(saved.items);delete doc.exact_excerpts;delete doc.exact_excerpt_notes;doc.segments=[];assert.equal(JSON.stringify(C.validate(saved).items),before);
 const restored=C.mergeLibraryBackup({documents:[],active:null},{format:'coconut-library',version:1,documents:[saved]});assert.equal(JSON.stringify(restored.documents[0].items),before);
});

for(const alter of [d=>{d.collection_version=2;},d=>{d.items[0].snapshot.text=7;},d=>{d.items[2].snapshot.exact_excerpt.text='fake';},d=>{d.items.push(d.items[0]);},d=>{d.items[0].origin.type='collection';},d=>{d.segments=[{id:'fake',text:'fake',start:0,end:1}];},d=>{d.title=' ';},d=>{d.items[0].extra='future';},d=>{d.items[0].snapshot.source_url='https://other.example';}])test('invalid typed collection rejects whole document instead of dropping fields: '+alter.toString(),()=>{
 const d=clone(collection());alter(d);assert.throws(()=>C.validate(d));
});

test('legacy writer persists collection payload atomically and receipt failure cannot claim saved',async()=>{
 const doc=source(),saved=collection(doc),storage=memory(),adapter=Store.createLegacyAdapter({getStorage:()=>storage,validate:C.validate});assert.equal(adapter.load().ok,true);const docs=[doc,saved],store=Store.create({adapter,getDocuments:()=>docs});
 const ticket=store.queueDocument(saved.key,saved);await store.flush();assert.equal((await ticket.committed).ok,true);assert.deepEqual(JSON.parse(storage.getItem(Store.KEY)).documents,clone(docs));assert.equal(storage.writes.length,1);
 storage.setItem=()=>{throw Object.assign(Error('quota'),{name:'QuotaExceededError'});};saved.title='Unsaved new name';const failed=store.queueDocument(saved.key,saved);await store.flush();assert.equal((await failed.committed).ok,false);assert.equal(JSON.parse(storage.getItem(Store.KEY)).documents[1].title,'My selected results');
});

test('older legacy reader fails closed on collection library and cannot overwrite original payload',async()=>{
 const raw=JSON.stringify({documents:[source(),collection()]}),storage=memory(raw),adapter=Store.createLegacyAdapter({getStorage:()=>storage,validate:oldShapeValidator});assert.equal(adapter.load().ok,false);const result=await adapter.write(adapter.prepare([]));assert.equal(result.ok,false);assert.equal(storage.getItem(Store.KEY),raw);assert.equal(storage.writes.length,0);
});

test('IDB provider migrates mixed collection library losslessly; old validator startup fails without replacing contents',async()=>{
 const raw=JSON.stringify({documents:[source(),collection()]}),storage=memory(raw),engine=transactionDouble(),opts={indexedDB:engine.indexedDB,name:'collections',getStorage:()=>storage,validate:C.validate,legacyModule:Store,documentModule:require('../reader/indexeddb-document-adapter.js')};
 const result=await Provider.initialize(opts);assert.equal(result.ok,true);assert.equal(result.backend,'indexeddb');assert.deepEqual(result.loaded.documents.map(d=>d.items||null),[null,collection().items]);result.adapter.close();
 const legacyBefore=storage.getItem(Store.KEY),old=await Provider.initialize({...opts,validate:oldShapeValidator});assert.equal(old.ok,false);assert.equal(storage.getItem(Store.KEY),legacyBefore);
 const reopened=await Provider.initialize(opts);assert.equal(reopened.ok,true);assert.equal(reopened.loaded.documents.length,2);assert.deepEqual(reopened.loaded.documents.find(C.isReadingCollection).items,collection().items);reopened.adapter.close();
});

test('audio-only project thoughts and timestamp notes remain personal evidence without fabricated source text',()=>{
 const local_media_source={version:1,kind:'audio',name:'authored.wav',size:40,last_modified:0,type:'audio/wav',fingerprint:'a'.repeat(64)};
 const doc={...C.validate({project_kind:'audio_only',title:'Audio',segments:[],local_media_source,project_note:'My thought',timestamp_bookmarks:[{id:'point',time:12.5,note:'At this time'}]}),key:'audio'};
 const saved=C.createReadingCollection({key:'audio-set',title:'Audio ideas',items:items(doc)});assert.equal(saved.items.length,2);assert.ok(saved.items.every(item=>item.snapshot.text===''&&item.snapshot.source_kind==='audio'));
 const markdown=C.readingCollectionMarkdown(saved,[doc]);assert.match(markdown,/My thought/);assert.match(markdown,/12\.5/);assert.doesNotMatch(markdown,/选取时原话/);assert.match(markdown,/非原话/);
});
