import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {transactionDouble} from './helpers/indexeddb-transaction-double.mjs';
const require=createRequire(import.meta.url),C=require('../reader/core.js'),Store=require('../reader/library-store.js'),Provider=require('./helpers/historical-browser-provider.cjs'),IDB=require('../reader/indexeddb-document-adapter.js');
const clone=value=>JSON.parse(JSON.stringify(value));
function source(){return {...C.validate({title:'No media',segments:[{id:'a',start:0,end:1,text:'First',speaker:'A'},{id:'b',start:0,end:2,text:'Second',speaker:'B'},{id:'c',start:10,end:20,text:'Third'}],readingPosition:'b',notes:{a:'Personal'},timestamp_bookmarks:[{id:'ordinary',time:4,note:'Media note'}]}),key:'source'};}
function add(doc,id='chapter',cueId='b',title='My chapter'){doc.reading_chapters=C.readingChaptersWith(doc,C.createReadingChapter(doc,{id,title,cueId}));return doc;}
function memory(raw){const map=new Map([[Store.KEY,raw]]),writes=[];return {writes,getItem:key=>map.get(key)??null,setItem(key,value){writes.push([key,value]);map.set(key,value);}};}
const oldValidate=doc=>{const {reading_chapters,...old}=doc;return C.validate(old);};

test('creation and updates are pure and preserve ordinary annotations, source, and reading position',()=>{
 const doc=source(),before=clone(doc),item=C.createReadingChapter(doc,{id:'one',title:'Chapter\r\nname',cueId:'b',note:'Line\r\nnext'});
 assert.deepEqual(clone(doc),before);assert.deepEqual(item,{id:'one',title:'Chapter\r\nname',cue_id:'b',time:0,note:'Line\r\nnext'});
 doc.reading_chapters=C.readingChaptersWith(doc,item);const old=clone(doc);
 const renamed=C.updateReadingChapter(doc,'one',{title:'Renamed'});assert.deepEqual(clone(doc),old);assert.equal(renamed.note,item.note);
 const moved=C.updateReadingChapter(doc,'one',{cueId:'c'});assert.equal(moved.time,10);assert.equal(moved.cue_id,'c');
 assert.equal(doc.readingPosition,'b');assert.deepEqual(doc.timestamp_bookmarks,before.timestamp_bookmarks);assert.deepEqual(clone(doc.segments),before.segments);
});
test('chapter order derives from full source order, not timestamps or insertion order',()=>{
 const doc=source();add(doc,'c','c');add(doc,'b','b');add(doc,'a','a');
 assert.deepEqual(C.readingChapters(doc).map(row=>row.item.id),['a','b','c']);
 assert.deepEqual(doc.reading_chapters.map(row=>row.id),['c','b','a']);
 assert.deepEqual(C.readingChapters(doc).map(row=>row.index),[0,1,2]);
});
test('same cue cannot acquire duplicate chapters including missing anchors; same time different cues allowed',()=>{
 const doc=add(source(),'b','b');assert.throws(()=>C.createReadingChapter(doc,{id:'other',title:'Duplicate',cueId:'b'}),/同一片段/);
 add(doc,'a','a');assert.throws(()=>C.updateReadingChapter(doc,'a',{cueId:'b'}),/同一片段/);
 doc.segments=doc.segments.filter(c=>c.id!=='b');
 assert.throws(()=>C.validate({...doc,reading_chapters:[...doc.reading_chapters,{id:'missing',title:'Missing',cue_id:'b',time:3}]}),/同一片段/);
 assert.throws(()=>C.createReadingChapter(doc,{id:'a',title:'ID duplicate',cueId:'c'}),/标识已存在/);
});
test('all existing cue ID strings and finite valid source times remain addressable',()=>{
 const doc={...C.validate({segments:[{id:'',start:700000,end:700001,text:'Empty id'},{id:'x'.repeat(500),start:800000,end:800001,text:'Long id'}]}),key:'odd'};
 add(doc,'empty','');add(doc,'long','x'.repeat(500));
 assert.equal(C.readingChapters(doc)[0].cue.id,'');assert.equal(C.validate(doc).reading_chapters[1].time,800000);
});
test('missing cues preserve immutable authored anchor evidence and never use similar text or nearest time',()=>{
 const doc=add(source(),'a','a','First chapter'),saved=clone(doc.reading_chapters);doc.segments.shift();doc.segments[0].text='First';
 let result=C.readingChapters(C.validate(doc))[0];assert.equal(result.status,'missing');assert.equal(result.cue,null);assert.equal(result.index,-1);assert.deepEqual(doc.reading_chapters,saved);
 const rename=C.updateReadingChapter(doc,'a',{title:'Still missing'});assert.equal(rename.cue_id,'a');
 doc.segments.unshift({id:'a',start:0,end:1,text:'Restored'});
 result=C.readingChapters(doc)[0];assert.equal(result.status,'current');assert.equal(result.cue,doc.segments[0]);
});
test('text, speaker, translation, and timing edits retain cue anchor with current navigation time and historic creation time',()=>{
 const doc=add(source(),'c','c');doc.segments[2]={...doc.segments[2],text:'Edited',speaker:'New',translations:{},start:15};
 const current=C.readingChapters(C.validate(doc))[0];assert.equal(current.cue.start,15);assert.equal(current.item.time,10);assert.equal(current.status,'current');
 assert.equal(C.updateReadingChapter(doc,'c',{cueId:'c'}).time,15);
});
test('deleting chapter leaves all source data and reading bookmark intact',()=>{
 const doc=add(source()),before=clone(source());doc.reading_chapters=doc.reading_chapters.filter(item=>item.id!=='chapter');
 assert.deepEqual(C.validate(doc),{...C.validate(before),reading_chapters:[]});assert.deepEqual(C.readingChapters(doc),[]);
});
test('strict chapter validation rejects malformed payloads without silently dropping entries',()=>{
 const good=add(source()).reading_chapters[0];
 for(const bad of [null,{}, {...good,extra:true},{...good,id:''},{...good,title:' '},{...good,title:'x'.repeat(201)},{...good,cue_id:1},{...good,time:Infinity},{...good,time:-1},{...good,note:3},{...good,note:'x'.repeat(10001)}]){
  assert.throws(()=>C.validate({...source(),reading_chapters:[bad]}));
 }
 assert.throws(()=>C.validate({...source(),reading_chapters:{}}));assert.throws(()=>C.validate({...source(),reading_chapters:Array(2001).fill(good)}));
 assert.throws(()=>C.updateReadingChapter(add(source()),'chapter',{id:'other'}));
 assert.throws(()=>C.updateReadingChapter(add(source()),'chapter',{cueId:'not-there'}));
 assert.throws(()=>C.updateReadingChapter(source(),'gone',{title:'new'}));
 const optional={...good};delete optional.note;assert.equal(C.validate({...source(),reading_chapters:[optional]}).reading_chapters[0].note,'');
});
test('chapter metadata does not become original text, a saved capture, project annotation, or collection item',()=>{
 const doc=source(),before=C.libraryCaptures([doc]);add(doc,'chapter','b','OnlyChapterNeedle');doc.reading_chapters[0].note='OnlyChapterNote';
 assert.deepEqual(C.libraryCaptures([doc]),before);assert.equal(C.projectAnnotationCount(doc),1);assert.deepEqual(C.librarySavedHits(doc,'OnlyChapterNeedle'),{hits:[],total:0});
 const capture=C.libraryCaptures([doc]).find(c=>c.type==='bookmark');assert.equal(capture.id,'ordinary');
 const collection=C.createReadingCollection({key:'collection',title:'Chosen',items:[C.collectionItemFromCapture(capture,[doc],{id:'item',createdAt:'2026-10-11T00:00:00.000Z'})]});
 assert.doesNotMatch(C.readingCollectionMarkdown(collection,[doc]),/OnlyChapter/);
});
test('Markdown exports ordered safe chapter titles and notes with missing anchor warning',()=>{
 const doc=source();add(doc,'c','c','<script>');add(doc,'a','a','Earlier');doc.reading_chapters[0].note='Thought\r\nnext';doc.segments.pop();
 const md=C.notebookMarkdown(doc);assert.ok(md.indexOf('Earlier')<md.indexOf('&lt;script&gt;'));assert.match(md,/原位置不可用/);assert.match(md,/Thought\n> next/);assert.match(md,/不是原文或自动摘要/);
 assert.match(C.libraryNotebookMarkdown([doc],['source']),/手动章节/);assert.doesNotMatch(C.libraryNotebookMarkdown([doc],[]),/Earlier/);
});
test('single JSON, whole and selected library backups roundtrip chapters and repeat restoration deduplicates',()=>{
 const doc=add(source());assert.deepEqual(C.parse(JSON.stringify(doc),'chapter.json').reading_chapters,doc.reading_chapters);
 const selection=C.createLibraryBackupSelection();selection.toggle(doc,true,[doc]);const backup=selection.backup([doc],doc.key);
 const restored=C.mergeLibraryBackup({documents:[],active:null},clone(backup));assert.deepEqual(restored.documents[0].reading_chapters,doc.reading_chapters);
 assert.equal(C.mergeLibraryBackup(restored,clone(backup)).documents.length,1);
 const changed=clone(doc);changed.reading_chapters[0].title='Different';
 const conflict=C.mergeLibraryBackup({documents:[changed],active:changed.key},clone(backup));assert.equal(conflict.documents.length,2);assert.deepEqual(conflict.documents[1].reading_chapters,doc.reading_chapters);
 assert.equal(C.mergeLibraryBackup(conflict,clone(backup)).documents.length,2);
});
test('plain replacement transcript does not inherit chapters, while JSON replacement explicitly carries its own',()=>{
 const old=add(source());const plain=C.parse('1\n00:00:00,000 --> 00:00:01,000\nReplacement','replacement.srt');assert.equal(plain.reading_chapters,undefined);
 const replacement=C.validate({...source(),reading_chapters:[{id:'new',title:'New',cue_id:'c',time:10}]});assert.equal(replacement.reading_chapters[0].id,'new');assert.equal(old.reading_chapters[0].id,'chapter');
});
test('audio-only and collection payloads reject chapter fields and cannot create chapters',()=>{
 const audio=C.validate({project_kind:'audio_only',segments:[],title:'Audio',local_media_source:{version:1,kind:'audio',name:'test.wav',size:40,last_modified:0,type:'audio/wav',fingerprint:'a'.repeat(64)}});
 const collection=C.createReadingCollection({key:'c',title:'Collection'});
 for(const doc of [audio,collection]){assert.throws(()=>C.validate({...doc,reading_chapters:[]}));assert.throws(()=>C.createReadingChapter(doc,{id:'c',title:'Chapter',cueId:'a'}));assert.deepEqual(C.readingChapters(doc),[]);}
});
test('legacy provider load/write preserves new top-level metadata; old JSON validation is explicitly lossy',async()=>{
 const doc=add(source()),storage=memory(JSON.stringify({documents:[doc],active:doc.key})),adapter=Store.createLegacyAdapter({getStorage:()=>storage,validate:oldValidate});
 const loaded=adapter.load();assert.equal(loaded.ok,true);assert.deepEqual(loaded.documents[0].reading_chapters,doc.reading_chapters);
 loaded.documents[0].notes.a='Edited in old reader';assert.equal((await adapter.write(adapter.prepare(loaded.documents))).ok,true);
 assert.deepEqual(JSON.parse(storage.getItem(Store.KEY)).documents[0].reading_chapters,doc.reading_chapters);assert.equal(oldValidate(doc).reading_chapters,undefined);
});
test('IDB migration, older-provider save and newer reopen preserve chapter objects',async()=>{
 const doc=add(source()),storage=memory(JSON.stringify({documents:[doc],active:doc.key})),engine=transactionDouble();
 const options={indexedDB:engine.indexedDB,name:'chapters',getStorage:()=>storage,validate:oldValidate,legacyModule:Store,documentModule:IDB};
 const old=await Provider.initialize(options);assert.equal(old.ok,true);assert.deepEqual(old.loaded.documents[0].reading_chapters,doc.reading_chapters);
 const row=old.loaded.documents[0];row.title='Older edit';const store=Store.create({adapter:old.adapter,getDocuments:()=>[row]}),ticket=store.queueDocument(row.key,row);await store.flush();assert.equal((await ticket.committed).ok,true);old.adapter.close();
 const current=await Provider.initialize({...options,validate:C.validate});assert.equal(current.ok,true);assert.deepEqual(current.loaded.documents[0].reading_chapters,doc.reading_chapters);current.adapter.close();
});
test('failed chapter writes retain prior durable document and never report success',async()=>{
 const original=source(),storage=memory(JSON.stringify({documents:[original],active:original.key})),adapter=Store.createLegacyAdapter({getStorage:()=>storage,validate:C.validate});assert.equal(adapter.load().ok,true);
 const doc=add(source()),store=Store.create({adapter,getDocuments:()=>[doc]}),before=storage.getItem(Store.KEY);
 storage.setItem=()=>{throw Object.assign(Error('full'),{name:'QuotaExceededError'});};
 const ticket=store.queueDocument(doc.key,doc);await store.flush();assert.equal((await ticket.committed).ok,false);assert.equal(storage.getItem(Store.KEY),before);assert.equal(doc.reading_chapters.length,1);
});
test('chapter aggregate budget rejects oversized imports while absent field preserves existing normalization',()=>{
 const doc=source();assert.equal(Object.hasOwn(C.validate(doc),'reading_chapters'),false);
 const rows=Array.from({length:101},(_,i)=>({id:String(i),cue_id:String(i),title:'T',time:i,note:'x'.repeat(10000)}));
 assert.throws(()=>C.validate({...doc,reading_chapters:rows}),/总量/);
 const ordinary=clone(doc.timestamp_bookmarks);assert.deepEqual(C.validate({...doc,reading_chapters:[]}).timestamp_bookmarks,ordinary);
});
