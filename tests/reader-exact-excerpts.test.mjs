import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import {transactionDouble} from './helpers/indexeddb-transaction-double.mjs';
const require=createRequire(import.meta.url),C=require('../reader/core.js'),P=require('../reader/passages.js');
const provider=require('../reader/storage-provider.js'),legacy=require('../reader/library-store.js'),storageModule=require('../reader/indexeddb-document-adapter.js');
const clone=value=>JSON.parse(JSON.stringify(value));
const stamp='2026-10-11T01:00:00.000Z';
function document(){return {...C.validate({title:'Captured title',language:'en',source_url:'https://youtu.be/captured',segments:[
 {id:'one',start:1,end:8,text:'Repeated repeated 🌴',speaker:'A'},
 {id:'two',start:2,end:4,text:'words 中文。',speaker:'A'}]}),key:'doc'};}
function save(doc=document(),from=9,to=26,id='excerpt-one'){
 return C.exactExcerptSnapshot(doc,doc.segments,doc.segments.slice(1).map((cue,i)=>P.separator(doc.segments[i].text,cue.text)),from,to,{id,createdAt:stamp});
}
function withExcerpt(){const doc=document();doc.exact_excerpts=[save(doc)];return doc;}

test('exact excerpt snapshots preserve UTF-16 ranges, display joins and overlapping source times',()=>{
 const doc=document(),record=save(doc);assert.equal(record.text,'repeated 🌴 words');
 assert.equal(C.exactExcerptParts(record)[0].from,9);assert.equal(C.exactExcerptParts(record)[1].to,5);
 assert.equal(C.exactExcerptFreshness(record,doc),'current');assert.equal(C.exactExcerptSource(record).title,'Captured title');
 assert.equal(Object.isFrozen(record.snapshot.cues[0]),true);assert.equal(Object.isFrozen(record.snapshot.source),true);
 assert.throws(()=>{record.snapshot.cues[0].text='changed';});
 // Starting on the display separator must preserve the leading space without attributing its neighbor.
 const leading=save(doc,20,26);assert.equal(leading.text,' words');assert.deepEqual(C.exactExcerptParts(leading).map(p=>p.cue.id),['two']);
 const copy=clone(doc);assert.throws(()=>C.exactExcerptSnapshot(doc,copy.segments,[' '],0,4,{id:'foreign',createdAt:stamp}));
 doc.segments.splice(1,0,{id:'inserted',text:'new',start:1.5,end:2});
 assert.equal(C.exactExcerptFreshness(record,doc),'stale');
 assert.throws(()=>C.exactExcerptSnapshot(doc,[doc.segments[0],doc.segments[2]],[' '],0,4,{id:'gap',createdAt:stamp}));
});

test('capture rejects truncated graphemes and CRLF; restores do not depend on the runtime Segmenter',()=>{
 const doc=document();doc.segments=[{id:'u',text:'e\u0301 👩‍👩‍👧‍👦\r\n你好',start:0,end:0,speaker:null}];
 const text=doc.segments[0].text,full=save(doc,0,text.length);assert.equal(full.text,text);
 for(const [from,to] of [[0,1],[4,6],[0,text.indexOf('\n')]])assert.throws(()=>save(doc,from,to));
 const segmenter=Intl.Segmenter;
 try{Intl.Segmenter=undefined;assert.throws(()=>save(doc,0,text.length),/完整字符/);assert.equal(C.validate({...doc,exact_excerpts:[full]}).exact_excerpts[0].text,text);}
 finally{Intl.Segmenter=segmenter;}
 doc.segments[0].text='a\rb';assert.throws(()=>save(doc,0,3));
 doc.segments=[{id:'a',text:'你好',start:0,end:0},{id:'b',text:'世界',start:0,end:0}];assert.equal(save(doc,1,3).text,'好世');
});

test('historical corrections, source metadata and missing cues never substitute current text',()=>{
 const doc=document();doc.segments[0].original_text='Initial bad recognition';const record=save(doc);doc.exact_excerpts=[record];
 assert.equal(C.exactExcerptFreshness(record,doc),'current');doc.segments[0].text='Latest correction';
 assert.equal(C.exactExcerptFreshness(record,doc),'stale');assert.equal(C.exactExcerptText(record),'repeated 🌴 words');
 let markdown=C.notebookMarkdown(doc);assert.match(markdown,/来源上下文已变化/);assert.doesNotMatch(markdown,/Initial bad recognition/);assert.match(markdown,/摘录时已修正/);assert.equal(record.snapshot.cues[0].original_text,'Initial bad recognition');assert.match(markdown,/repeated 🌴 words/);assert.doesNotMatch(markdown,/Latest correction/);
 doc.title='New title';doc.source_url='https://youtu.be/current';markdown=C.notebookMarkdown(doc);assert.match(markdown,/摘录时篇目：Captured title/);assert.match(markdown,/youtu\\\.be\/captured/);
 doc.segments.splice(0,1);assert.equal(C.exactExcerptFreshness(record,doc),'missing');
 assert.equal(C.validate(doc).exact_excerpts.length,1);assert.match(C.notebookMarkdown(doc),/原引用片段已移除/);
});

test('unchanged legacy documents and whole-cue excerpts remain unchanged',()=>{
 const doc=document();doc.segments[0].saved_excerpt=true;doc.notes.one='Personal note';
 const normalized=C.validate(doc);assert.equal(Object.hasOwn(normalized,'exact_excerpts'),false);assert.equal(Object.hasOwn(C.validate({...doc,exact_excerpts:[]}),'exact_excerpts'),false);
 assert.equal(C.notebookSegments(normalized).length,1);assert.match(C.notebookMarkdown(normalized),/已摘录整段/);
 doc.exact_excerpts=[save(doc)];assert.equal(C.notebookSegments(doc).length,1);assert.equal(C.exactExcerptCount(doc),1);
 assert.equal(C.libraryCaptures([doc]).length,2);assert.equal(C.libraryCaptures([doc],'','note').length,1);
 doc.exact_excerpts=[];assert.equal(doc.segments[0].saved_excerpt,true);assert.equal(doc.notes.one,'Personal note');
});

test('all authored malformed or unsupported exact records fail atomically rather than being filtered',()=>{
 const original=withExcerpt();
 const bad=[d=>d.exact_excerpts={},d=>d.exact_excerpts.push(clone(d.exact_excerpts[0])),d=>d.exact_excerpts[0].version=2,
 d=>d.exact_excerpts[0].created_at='2026-02-30T00:00:00.000Z',d=>d.exact_excerpts[0].text='invented',d=>d.exact_excerpts[0].snapshot.from=-1,
 d=>d.exact_excerpts[0].snapshot.to=1e100,d=>d.exact_excerpts[0].snapshot.from=1.5,d=>d.exact_excerpts[0].snapshot.separators=['INVENTED'],
 d=>d.exact_excerpts[0].snapshot.cues[1].id='one',d=>d.exact_excerpts[0].snapshot.cues[0].end=-1,
 d=>d.exact_excerpts[0].snapshot.cues[0].original_text=42,d=>d.exact_excerpts[0].snapshot.source.provenance={unknown:'lost'},
 d=>d.exact_excerpts[0].snapshot.future_evidence='must not disappear',d=>d.exact_excerpts[0].unexpected=true];
 for(const mutate of bad){const value=clone(original);mutate(value);const before=JSON.stringify(value);assert.throws(()=>C.validate(value));assert.equal(JSON.stringify(value),before);assert.throws(()=>C.mergeLibraryBackup({documents:[document()],active:'doc'},{format:'coconut-library',version:1,documents:[original,{...value,key:'invalid'}]}));}
 const audio={project_kind:'audio_only',title:'Audio',segments:[],podcast_source:{feed_url:'https://example.org/feed',episode_id:'episode',media_url:'https://example.org/audio.mp3',media_kind:'audio'},exact_excerpts:[]};assert.throws(()=>C.validate(audio));
});

test('JSON and additive backup restore keep exact evidence in dedup fingerprints',()=>{
 const original=withExcerpt(),roundtrip=C.validate(JSON.parse(JSON.stringify(original)));assert.deepEqual(roundtrip.exact_excerpts,original.exact_excerpts);
 const legacyDoc=document(),incoming={format:'coconut-library',version:1,documents:[original],active:original.key};
 const result=C.mergeLibraryBackup({documents:[legacyDoc],active:legacyDoc.key},incoming);assert.equal(result.documents.length,2);assert.equal(result.documents[1].key,'doc-restored-1');
 assert.deepEqual(result.documents[1].exact_excerpts,original.exact_excerpts);
 assert.equal(C.mergeLibraryBackup(result,incoming).documents.length,2);
 const changed=clone(original);changed.exact_excerpts[0].id='second-identity';assert.equal(C.mergeLibraryBackup(result,{...incoming,documents:[changed]}).documents.length,3);
 assert.equal(C.exactExcerptDuplicate(original,{...save(original),id:'fresh-id',created_at:'2026-10-12T01:00:00.000Z'}),original.exact_excerpts[0]);
 const repeated=document();repeated.segments=[{id:'r',text:'same same',start:0,end:1}];repeated.exact_excerpts=[save(repeated,0,4)];assert.equal(C.exactExcerptDuplicate(repeated,save(repeated,5,9)),null);
});

test('attaching transcript preserves capture-time source while current project attribution changes',()=>{
 const transcript=withExcerpt(),project=C.validate({project_kind:'audio_only',title:'Project title',segments:[],podcast_source:{feed_url:'https://example.org/feed',episode_id:'episode',media_url:'https://example.org/audio.mp3',media_kind:'audio'}});
 const attached=C.attachProjectTranscript(project,transcript);assert.deepEqual(attached.exact_excerpts,transcript.exact_excerpts);assert.equal(attached.title,'Project title');assert.equal(C.exactExcerptSource(attached.exact_excerpts[0]).title,'Captured title');assert.equal(C.exactExcerptFreshness(attached.exact_excerpts[0],attached),'stale');
});

test('exact-only documents participate in notebook search, stable ownership and annotated shelf',()=>{
 const doc=withExcerpt();assert.equal(C.libraryMatches(doc,'','annotated'),true);
 const captures=C.libraryCaptures([doc],'repeated','excerpt');assert.equal(captures.length,1);assert.equal(captures[0].type,'exact-excerpt');assert.equal(captures[0].time,1);assert.equal(C.libraryCaptureCurrent(captures[0],[doc]),true);
 doc.segments[0].text='New text';C.invalidateSearch(doc);assert.equal(C.libraryCaptureCurrent(captures[0],[doc]),true);assert.equal(C.libraryCaptures([doc],'repeated').length,1);
 assert.equal(C.libraryCaptures([doc],'https://youtu.be/captured').length,1);
 assert.match(C.libraryNotebookMarkdown([doc],['doc']),/repeated 🌴 words/);assert.doesNotMatch(C.libraryNotebookMarkdown([doc],[]),/repeated 🌴 words/);
 doc.exact_excerpts=[];assert.equal(C.libraryCaptureCurrent(captures[0],[doc]),false);assert.equal(C.libraryMatches(doc,'','annotated'),false);
});

test('cooperative notebook yields for large excerpt collections and invalidates replaced collections',()=>{
 const doc=withExcerpt();doc.exact_excerpts=Array.from({length:4200},(_,i)=>({...doc.exact_excerpts[0],id:'exact-'+i}));
 const tasks=[],search=C.createLibraryNotebookSearch({getDocuments:()=>[doc],schedule:fn=>tasks.push(fn)}),job=search.request('repeated','excerpt');assert.equal(job.pending,true);
 while(tasks.length)tasks.shift()();assert.equal(job.captures.length,4200);assert.equal(search.isCurrent(job),true);
 doc.exact_excerpts=doc.exact_excerpts.slice(1);assert.equal(search.isCurrent(job),false);search.cancel();
 const shelfDocs=Array.from({length:161},(_,i)=>({...doc,key:'doc-'+i})),shelfTasks=[],shelf=C.createLibrarySearch({getDocuments:()=>shelfDocs,schedule:fn=>shelfTasks.push(fn)});
 const shelfJob=shelf.request('','annotated','title');assert.equal(shelfJob.pending,true);while(shelfTasks.length)shelfTasks.shift()();assert.equal(shelfJob.docs.length,161);
 for(const item of shelfDocs)item.exact_excerpts=[];const empty=shelf.request('','annotated','title');while(shelfTasks.length)shelfTasks.shift()();assert.equal(empty.docs.length,0);shelf.cancel();
});

async function persistenceFixture(doc=withExcerpt()){
 const values=new Map([[legacy.KEY,JSON.stringify({documents:[doc],active:doc.key})]]),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)},engine=transactionDouble();
 const options={indexedDB:engine.indexedDB,getStorage:()=>storage,validate:C.validate,legacyModule:legacy,documentModule:storageModule};
 const result=await provider.initialize(options);return {result,storage,engine,options};
}

test('IDB migration and CAS save/reload preserve exact snapshots without changing legacy recovery bytes',async()=>{
 globalThis.crypto??=webcrypto;
 const f=await persistenceFixture();assert.equal(f.result.ok,true);assert.equal(f.result.loaded.documents[0].exact_excerpts.length,1);
 const raw=f.storage.getItem(legacy.KEY),documents=f.result.loaded.documents,store=legacy.create({adapter:f.result.adapter,getDocuments:()=>documents});
 const record=documents[0].exact_excerpts[0];documents[0].segments[0].text='New correction';store.queueDocument('doc',documents[0]);assert.equal((await store.flush()).ok,true);
 const reloaded=await provider.initialize(f.options);assert.equal(reloaded.ok,true);assert.deepEqual(reloaded.loaded.documents[0].exact_excerpts[0],record);assert.equal(C.exactExcerptFreshness(reloaded.loaded.documents[0].exact_excerpts[0],reloaded.loaded.documents[0]),'stale');assert.equal(f.storage.getItem(legacy.KEY),raw);
 f.result.adapter.close();reloaded.adapter.close();
});

test('legacy fallback preserves exact snapshots and IDB CAS rejects lost-update excerpt saves',async()=>{
 globalThis.crypto??=webcrypto;
 const f=await persistenceFixture(),other=await provider.initialize(f.options),left=f.result.loaded.documents,right=other.loaded.documents;
 const first=legacy.create({adapter:f.result.adapter,getDocuments:()=>left}),second=legacy.create({adapter:other.adapter,getDocuments:()=>right});
 left[0].exact_excerpts.push(save(left[0],0,4,'left'));first.queueDocument('doc',left[0]);assert.equal((await first.flush()).ok,true);
 right[0].exact_excerpts.push(save(right[0],0,4,'right'));second.queueDocument('doc',right[0]);assert.equal((await second.flush()).ok,false);assert.equal(second.status('doc').status,'conflict');assert.equal(right[0].exact_excerpts.at(-1).id,'right');
 const fresh=await provider.initialize(f.options);assert.equal(fresh.loaded.documents[0].exact_excerpts.at(-1).id,'left');
 const raw=JSON.stringify({documents:[withExcerpt()]}),values=new Map([[legacy.KEY,raw]]),adapter=legacy.createLegacyAdapter({getStorage:()=>({getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)}),validate:C.validate});
 const loaded=adapter.load();assert.equal(loaded.ok,true);assert.equal(adapter.write(adapter.prepare(loaded.documents)).ok,true);assert.deepEqual(JSON.parse(values.get(legacy.KEY)).documents[0].exact_excerpts,withExcerpt().exact_excerpts);
 f.result.adapter.close();other.adapter.close();fresh.adapter.close();
});


test('batch freshness scans current cues once per render/export and observes later in-place edits',()=>{
 const doc=withExcerpt(),record=doc.exact_excerpts[0];doc.exact_excerpts=Array.from({length:40},(_,index)=>({...record,id:'batch-'+index}));
 let reads=0;const cues=doc.segments;doc.segments=new Proxy(cues,{get(target,key,receiver){if(typeof key==='string'&&/^\d+$/.test(key))reads++;return Reflect.get(target,key,receiver);}});
 const statuses=C.exactExcerptFreshnessBatch(doc.exact_excerpts,doc);assert.equal(statuses.size,40);assert.ok([...statuses.values()].every(value=>value==='current'));
 // One index scan plus the saved snapshot length per record, never another whole transcript scan per record.
 assert.equal(reads,cues.length+40*record.snapshot.cues.length);reads=0;C.notebookMarkdown(doc);assert.ok(reads<200);
 cues[0].text='Edited after batch';assert.equal(C.exactExcerptFreshnessBatch(doc.exact_excerpts,doc).get('batch-0'),'stale');
});


test('capture ownership does not serialize validated immutable paragraph snapshots, but guards mutable fixtures',()=>{
 const doc=withExcerpt(),original=JSON.stringify;let snapshots=0;
 try{JSON.stringify=function(value,...args){if(value===doc.exact_excerpts[0])snapshots++;return original(value,...args);};const capture=C.libraryCaptures([doc])[0];assert.equal(C.libraryCaptureCurrent(capture,[doc]),true);assert.equal(snapshots,0);}
 finally{JSON.stringify=original;}
 doc.exact_excerpts=[clone(doc.exact_excerpts[0])];const capture=C.libraryCaptures([doc])[0];doc.exact_excerpts[0].snapshot.cues[0].text='Tampered';assert.equal(C.libraryCaptureCurrent(capture,[doc]),false);
});


test('current cue locations survive text/title corrections without claiming historical freshness',()=>{
 const doc=withExcerpt(),record=doc.exact_excerpts[0],before=JSON.stringify(record);
 assert.deepEqual(C.exactExcerptState(record,doc),{freshness:'current',cueId:'one'});
 doc.title='Renamed';assert.deepEqual(C.exactExcerptState(record,doc),{freshness:'stale',cueId:'one'});
 doc.segments[0].text='Corrected current text';doc.segments[0].start=0.5;
 assert.deepEqual(C.exactExcerptStateBatch([record],doc).get(record.id),{freshness:'stale',cueId:'one'});assert.equal(JSON.stringify(record),before);
 // The actual selected cue, not a neighboring cue retained only for separator context, owns navigation.
 const fresh=document(),leading=save(fresh,20,26);fresh.segments[0].text='Updated neighboring context';
 assert.deepEqual(C.exactExcerptState(leading,fresh),{freshness:'stale',cueId:'two'});
});

test('location never guesses through missing, reordered or inserted source cues',()=>{
 for(const mutate of [doc=>doc.segments.splice(0,1),doc=>doc.segments.reverse(),doc=>doc.segments.splice(1,0,{id:'new',text:'Inserted',start:1.5,end:2})]){
  const doc=withExcerpt(),record=doc.exact_excerpts[0];mutate(doc);assert.equal(C.exactExcerptState(record,doc).cueId,null);assert.notEqual(C.exactExcerptFreshness(record,doc),'current');
 }
 const doc=withExcerpt(),record=doc.exact_excerpts[0];doc.segments.unshift({id:'before',text:'Unrelated preceding cue',start:0,end:1});
 assert.deepEqual(C.exactExcerptState(record,doc),{freshness:'current',cueId:'one'});
 doc.segments.splice(1,2,{id:'replacement',text:record.text,start:1,end:8});assert.deepEqual(C.exactExcerptState(record,doc),{freshness:'missing',cueId:null});
});

test('personal excerpt sidecars preserve legacy fingerprints and strictly validate every entry',()=>{
 const doc=withExcerpt(),legacyJSON=JSON.stringify(C.validate(doc));
 assert.equal(JSON.stringify(C.validate({...doc,exact_excerpt_notes:{}})),legacyJSON);
 const text='  我的想法\r\n<script> & **bold**\n👩‍👩‍👧‍👦\t';
 for(const note of ['', ' \t\n\u2003',text,'x'.repeat(100001)]){
  const restored=C.validate({...doc,exact_excerpt_notes:{'excerpt-one':note}});
  assert.equal(Object.getPrototypeOf(restored.exact_excerpt_notes),null);
  assert.equal(restored.exact_excerpt_notes['excerpt-one'],note);
  assert.equal(C.validate(clone(restored)).exact_excerpt_notes['excerpt-one'],note);
 }
 for(const value of [null,[],0,false,'text',{'excerpt-one':null},{'excerpt-one':42},{orphan:''},{orphan:'thought'}]){
  const input={...doc,exact_excerpt_notes:value},before=JSON.stringify(input);
  assert.throws(()=>C.validate(input));assert.equal(JSON.stringify(input),before);
  assert.throws(()=>C.mergeLibraryBackup({documents:[doc],active:'doc'},{format:'coconut-library',version:1,documents:[input]}));
 }
 const project={project_kind:'audio_only',title:'Project',segments:[],podcast_source:{feed_url:'https://example.org/feed',episode_id:'episode',media_url:'https://example.org/audio.mp3',media_kind:'audio'}};
 for(const value of [{},null,{'excerpt-one':''}])assert.throws(()=>C.validate({...project,exact_excerpt_notes:value}));
});

test('personal-note helpers are copy-on-write, safe for special IDs, and preserve frozen evidence identity',()=>{
 for(const id of ['__proto__','constructor','toString']){
  const doc=document(),record=save(doc,9,26,id);doc.exact_excerpts=[record];const snapshot=JSON.stringify(record);
  const map=C.exactExcerptNotesWith(doc,id,'private');assert.equal(Object.getPrototypeOf(map),null);assert.equal(map[id],'private');assert.equal(doc.exact_excerpt_notes,undefined);
  doc.exact_excerpt_notes=map;const next=C.exactExcerptNotesWith(doc,id,'');assert.notEqual(next,map);assert.equal(map[id],'private');assert.equal(Object.hasOwn(next,id),true);assert.equal(next[id],'');
  assert.equal(C.validate({...doc,exact_excerpt_notes:next}).exact_excerpt_notes[id],'');
  assert.equal(doc.exact_excerpts[0],record);assert.equal(JSON.stringify(record),snapshot);assert.equal(Object.isFrozen(record.snapshot),true);
  assert.equal(C.exactExcerptDuplicate(doc,save(doc,9,26,'duplicate')),record);assert.equal(C.exactExcerptNote(doc,id),'private');
  assert.deepEqual(C.exactExcerptState(record,doc),{freshness:'current',cueId:'one'});
  assert.throws(()=>C.exactExcerptNotesWith(doc,'absent',''));assert.throws(()=>C.exactExcerptNotesWith(doc,id,null));assert.throws(()=>C.exactExcerptRemoval(doc,'absent'));
 }
 assert.equal(C.exactExcerptNote(document(),'__proto__'),'');
});

test('removing one exact excerpt prepares a coherent atomic patch without mutating live collections',()=>{
 const doc=withExcerpt(),first=doc.exact_excerpts[0],other=save(doc,0,4,'other');doc.exact_excerpts.push(other);doc.notes.one='whole cue note';doc.segments[0].saved_excerpt=true;
 doc.exact_excerpt_notes=C.exactExcerptNotesWith(doc,first.id,'first');doc.exact_excerpt_notes=C.exactExcerptNotesWith(doc,other.id,'second');
 const oldMap=doc.exact_excerpt_notes,oldRecords=doc.exact_excerpts,patch=C.exactExcerptRemoval(doc,first.id);
 assert.equal(doc.exact_excerpt_notes,oldMap);assert.equal(doc.exact_excerpts,oldRecords);assert.equal(oldMap[first.id],'first');assert.deepEqual(patch.exact_excerpts,[other]);assert.equal(patch.exact_excerpts[0],other);assert.equal(Object.hasOwn(patch.exact_excerpt_notes,first.id),false);assert.equal(patch.exact_excerpt_notes.other,'second');
 Object.assign(doc,patch);assert.doesNotThrow(()=>C.validate(doc));assert.equal(doc.notes.one,'whole cue note');assert.equal(doc.segments[0].saved_excerpt,true);
 const final=C.exactExcerptRemoval(doc,other.id);assert.deepEqual(final,{exact_excerpts:undefined,exact_excerpt_notes:undefined});Object.assign(doc,final);assert.doesNotThrow(()=>C.validate(doc));
});

test('exact notes share one capture across filters, retire old captures, and stay out of source search',()=>{
 const doc=withExcerpt(),record=doc.exact_excerpts[0],old=C.libraryCaptures([doc])[0];doc.exact_excerpt_notes=C.exactExcerptNotesWith(doc,record.id,'UniquePrivateThought');
 assert.equal(C.libraryCaptureCurrent(old,[doc]),false);
 for(const kind of ['all','note','excerpt']){const results=C.libraryCaptures([doc],'UniquePrivateThought',kind);assert.equal(results.length,1);assert.equal(results[0].key,old.key);assert.equal(results[0].note,'UniquePrivateThought');assert.equal(C.libraryCaptureCurrent(results[0],[doc]),true);}
 for(const scope of ['title','notes','text'])assert.equal(C.libraryMatches(doc,'UniquePrivateThought','all',scope),false);
 assert.equal(C.searchDocument(doc,'UniquePrivateThought','text').byCue.size,0);
 const current=C.libraryCaptures([doc])[0];doc.exact_excerpt_notes=C.exactExcerptNotesWith(doc,record.id,' \n\t');assert.equal(C.libraryCaptureCurrent(current,[doc]),false);assert.equal(C.libraryCaptures([doc],'','note').length,0);assert.equal(C.libraryCaptures([doc],'','excerpt').length,1);
 doc.segments=[];assert.equal(C.exactExcerptFreshness(record,doc),'missing');assert.equal(C.libraryCaptures([doc]).length,1);
});

test('cooperative note searches retire completed and in-progress work on copy-on-write sidecar replacement',()=>{
 const doc=withExcerpt(),tasks=[];doc.exact_excerpts=Array.from({length:4200},(_,i)=>({...doc.exact_excerpts[0],id:'e'+i}));
 const search=C.createLibraryNotebookSearch({getDocuments:()=>[doc],schedule:fn=>tasks.push(fn),now:()=>0,workSize:1});
 const pending=search.request('thought','note');assert.equal(pending.pending,true);tasks.shift()();
 doc.exact_excerpt_notes=C.exactExcerptNotesWith(doc,'e4199','thought');assert.equal(search.isCurrent(pending),false);while(tasks.length)tasks.shift()();assert.equal(pending.operation,null);
 const completed=search.request('thought','note');while(tasks.length)tasks.shift()();assert.equal(completed.captures.length,1);assert.equal(search.isCurrent(completed),true);
 doc.exact_excerpt_notes=C.exactExcerptNotesWith(doc,'e4199','changed');assert.equal(search.isCurrent(completed),false);search.cancel();
});

test('personal notes export separately escaped and restore without entering source or AI text',()=>{
 const doc=withExcerpt(),record=doc.exact_excerpts[0],sentinel='UniquePrivateThought <script>\n# heading **bold**';doc.exact_excerpt_notes=C.exactExcerptNotesWith(doc,record.id,sentinel);
 const markdown=C.notebookMarkdown(doc);assert.match(markdown,/我的笔记：\n\n> UniquePrivateThought &lt;script&gt;\n> \\# heading \\\*\\\*bold/);assert.equal(markdown.indexOf(record.text)<markdown.indexOf('我的笔记：'),true);
 assert.match(C.libraryNotebookMarkdown([doc],['doc']),/UniquePrivateThought/);assert.doesNotMatch(C.libraryNotebookMarkdown([doc],[]),/UniquePrivateThought/);
 for(const output of [C.transcriptText(doc),C.subtitleExport(doc,'srt'),C.subtitleExport(doc,'vtt'),C.aiReadingMarkdown(doc)])assert.doesNotMatch(typeof output==='string'?output:output.text,/UniquePrivateThought/);
 const restored=C.validate(clone(doc));assert.equal(restored.exact_excerpt_notes[record.id],sentinel);
 const merged=C.mergeLibraryBackup({documents:[withExcerpt()],active:'doc'},{format:'coconut-library',version:1,documents:[doc]});assert.equal(merged.documents.length,2);assert.ok(merged.documents.some(item=>C.exactExcerptNote(item,record.id)===sentinel));
 const project=C.validate({project_kind:'audio_only',title:'Project',segments:[],podcast_source:{feed_url:'https://example.org/feed',episode_id:'episode',media_url:'https://example.org/audio.mp3',media_kind:'audio'}});assert.equal(C.attachProjectTranscript(project,doc).exact_excerpt_notes[record.id],sentinel);
});

test('IDB and legacy persistence retain personal notes through save, reload, conflict and removal',async()=>{
 globalThis.crypto??=webcrypto;
 const initial=withExcerpt();initial.exact_excerpt_notes=C.exactExcerptNotesWith(initial,'excerpt-one','initial');
 const f=await persistenceFixture(initial),other=await provider.initialize(f.options),left=f.result.loaded.documents,right=other.loaded.documents;
 const first=legacy.create({adapter:f.result.adapter,getDocuments:()=>left}),second=legacy.create({adapter:other.adapter,getDocuments:()=>right});
 left[0].exact_excerpt_notes=C.exactExcerptNotesWith(left[0],'excerpt-one','left\r\n');first.queueDocument('doc',left[0]);assert.equal((await first.flush()).ok,true);
 right[0].exact_excerpt_notes=C.exactExcerptNotesWith(right[0],'excerpt-one','right');second.queueDocument('doc',right[0]);assert.equal((await second.flush()).ok,false);assert.equal(second.status('doc').status,'conflict');assert.equal(C.exactExcerptNote(right[0],'excerpt-one'),'right');
 const fresh=await provider.initialize(f.options);assert.equal(C.exactExcerptNote(fresh.loaded.documents[0],'excerpt-one'),'left\r\n');
 Object.assign(left[0],C.exactExcerptRemoval(left[0],'excerpt-one'));first.queueDocument('doc',left[0]);assert.equal((await first.flush()).ok,true);const removed=await provider.initialize(f.options);assert.equal(removed.loaded.documents[0].exact_excerpt_notes,undefined);assert.equal(removed.loaded.documents[0].exact_excerpts,undefined);
 const values=new Map([[legacy.KEY,JSON.stringify({documents:[initial]})]]),adapter=legacy.createLegacyAdapter({getStorage:()=>({getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)}),validate:C.validate});const loaded=adapter.load();loaded.documents[0].exact_excerpt_notes=C.exactExcerptNotesWith(loaded.documents[0],'excerpt-one','');assert.equal(adapter.write(adapter.prepare(loaded.documents)).ok,true);assert.equal(adapter.load().documents[0].exact_excerpt_notes['excerpt-one'],'');
 for(const result of [f.result,other,fresh,removed])result.adapter.close();
});
