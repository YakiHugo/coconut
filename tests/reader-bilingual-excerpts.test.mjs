import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {transactionDouble} from './helpers/indexeddb-transaction-double.mjs';
const require=createRequire(import.meta.url),C=require('../reader/core.js'),P=require('../reader/passages.js'),Store=require('../reader/library-store.js'),Provider=require('../reader/storage-provider.js'),IDB=require('../reader/indexeddb-document-adapter.js');
const stamp='2026-10-11T09:00:00.000Z',copy=v=>JSON.parse(JSON.stringify(v));
function source(){
 return {...C.validate({title:'Source',language:'en',segments:['One','Two','Three'].map((word,i)=>({id:String(i),text:word,start:i*2,end:i*2+2,speaker:'A',translations:{zh:{text:['第一句。','第二句。','第三句。'][i],source_text:word,source_language:'en',provider:i===1?'user':'model'}}}))}),key:'source'};
}
const separators=doc=>doc.segments.slice(1).map((cue,i)=>P.separator(doc.segments[i].text,cue.text));
function pair(doc=source(),options={}){
 const model=options.model||C.translationSelectionModels(doc,doc.segments,options.language||'zh')[0];
 return C.pairedExactExcerptSnapshot(doc,doc.segments,separators(doc),options.from??0,options.to??3,model,options.translationFrom??0,options.translationTo??model.text.length,{id:options.id||'pair',createdAt:stamp,confirmedAt:options.confirmedAt||stamp});
}
test('independent ranges freeze bilingual evidence without touching source or marking human review',()=>{
 const doc=source(),before=copy(doc),r=pair(doc);assert.deepEqual(copy(doc),before);assert.equal(r.version,2);assert.equal(r.text,'One');assert.equal(r.translation.text,'第一句。第二句。第三句。');
 assert.equal(C.exactExcerptParts(r).length,1);assert.equal(C.exactExcerptTranslationParts(r).length,3);assert.ok(Object.isFrozen(r.translation.cues[0].translation));
 assert.equal(C.exactExcerptTranslation(r).sourceTime,null);assert.deepEqual(C.exactExcerptTranslation(r).reviewStates,['machine','user-authored']);assert.equal(doc.segments[0].translations.zh.manual_review,undefined);
});
test('missing stale and empty translations break available runs without blocking other windows',()=>{
 for(const change of [d=>delete d.segments[1].translations.zh,d=>d.segments[1].translations.zh.source_text='old',d=>d.segments[1].translations.zh.text=' ']){
  const doc=source();change(doc);const runs=C.translationSelectionModels(doc,doc.segments,'zh');assert.deepEqual(runs.map(r=>r.cues.map(c=>c.id)),[['0'],['2']]);
  const saved=pair(doc,{model:runs[1],translationTo:2});assert.equal(saved.translation.text,'第三');assert.equal(saved.text,'One');
 }
});
test('pending source and translation ownership rejects replacements and in-place changes',()=>{
 for(const change of [d=>d.segments[0]={...d.segments[0]},d=>d.segments[0].text+='x',d=>d.title+='x',d=>d.segments[0].translations.zh={...d.segments[0].translations.zh},d=>d.segments[0].translations.zh.text+='x',d=>d.segments[0].translations.zh.provider='other']){
  const doc=source(),model=C.translationSelectionModels(doc,doc.segments,'zh')[0];change(doc);assert.throws(()=>pair(doc,{model}));
 }
 const doc=source(),model=C.translationSelectionModels(doc,doc.segments,'zh')[0];assert.throws(()=>pair(doc,{model:copy(model)}));assert.throws(()=>pair(source(),{model}));
});
test('explicit confirmation is necessary, and Unicode/CRLF selection boundaries are guarded',()=>{
 const doc=source();doc.segments[0].translations.zh.text='🙂e\u0301\r\n完整';const model=C.translationSelectionModels(doc,doc.segments,'zh')[0];
 assert.throws(()=>C.pairedExactExcerptSnapshot(doc,doc.segments,separators(doc),0,3,model,0,2,{id:'x',createdAt:stamp}),/明确确认/);
 for(const translationTo of [1,3,5])assert.throws(()=>pair(doc,{model,translationTo}));
 assert.equal(pair(doc,{model,translationTo:6}).translation.text,'🙂e\u0301\r\n');
});
test('v2 validation refuses malformed versions ranges languages context and forged provenance',()=>{
 const r=pair();
 for(const change of [r=>r.version=3,r=>r.translation.text='bad',r=>r.translation.language='xx',r=>r.translation.cues[0].cue_id='unknown',r=>r.translation.cues.reverse(),r=>r.translation.cues[0].translation.source_text='bad',r=>r.translation.cues[0].translation.unknown=true,r=>r.translation.cues[0].context=[],r=>r.translation.unknown=true,r=>r.pairing.kind='auto-aligned',r=>r.pairing.confirmed_at='bad']){
  const bad=copy(r);change(bad);assert.throws(()=>C.validate({...source(),exact_excerpts:[bad]}));
 }
});
test('v1 mixed JSON and selected backup roundtrip; repeated restores dedupe and conflicts preserve versions',()=>{
 const doc=source();doc.exact_excerpts=[C.exactExcerptSnapshot(doc,doc.segments,separators(doc),0,3,{id:'v1',createdAt:stamp}),pair(doc)];doc.exact_excerpt_notes={pair:'Personal\r\nthought'};
 assert.deepEqual(C.parse(JSON.stringify(doc),'doc.json').exact_excerpts,doc.exact_excerpts);
 const selection=C.createLibraryBackupSelection();selection.toggle(doc,true,[doc]);const backup=selection.backup([doc],doc.key),restored=C.mergeLibraryBackup({documents:[],active:null},backup);
 assert.deepEqual(restored.documents[0].exact_excerpts,doc.exact_excerpts);assert.equal(restored.documents[0].exact_excerpt_notes.pair,doc.exact_excerpt_notes.pair);assert.equal(C.mergeLibraryBackup(restored,backup).documents.length,1);
 const changed=copy(doc);changed.title='Changed';assert.equal(C.mergeLibraryBackup({documents:[changed],active:changed.key},backup).documents.length,2);
});
test('duplicate equality includes independent ranges language and evidence but excludes confirmation time',()=>{
 const doc=source(),saved=pair(doc);doc.exact_excerpts=[saved];assert.equal(C.exactExcerptDuplicate(doc,pair(doc,{confirmedAt:'2026-10-11T10:00:00.000Z'})),saved);
 for(const options of [{from:1,to:3},{translationTo:2}])assert.equal(C.exactExcerptDuplicate(doc,pair(doc,options)),null);
 for(const cue of doc.segments)cue.translations.fr={text:'French',source_text:cue.text,source_language:'en',provider:'model'};assert.equal(C.exactExcerptDuplicate(doc,pair(doc,{language:'fr'})),null);
 doc.segments[0].translations.zh.provider='changed';assert.equal(C.exactExcerptDuplicate(doc,pair(doc)),null);
 const v1=C.exactExcerptSnapshot(doc,doc.segments,separators(doc),0,3,{id:'v1',createdAt:stamp});assert.equal(C.exactExcerptDuplicate(doc,v1),null);
});
test('freshness compares content after restore; source/translation edits never rewrite history',()=>{
 const doc=source(),record=pair(doc),before=JSON.stringify(record);doc.exact_excerpts=[record];assert.equal(C.exactExcerptState(record,C.validate(copy(doc))).freshness,'current');
 doc.segments[0].translations.zh.text='Changed';assert.equal(C.exactExcerptState(record,doc).freshness,'stale');assert.equal(C.exactExcerptState(record,doc).cueId,'0');
 doc.segments.shift();assert.equal(C.exactExcerptState(record,doc).freshness,'missing');assert.equal(C.exactExcerptState(record,doc).cueId,null);assert.equal(JSON.stringify(record),before);
});
test('notes search collections and Markdown retain only selected bilingual text',()=>{
 const doc=source(),record=pair(doc,{translationTo:2});doc.exact_excerpts=[record];doc.exact_excerpt_notes=C.exactExcerptNotesWith(doc,'pair','My note');
 const captures=C.libraryCaptures([doc],'第一');assert.equal(captures.length,1);assert.equal(captures[0].text,'One');
 const hit=C.librarySavedHits(doc,'第一','text').hits[0];assert.equal(hit.matchFields,'translation');assert.ok(hit.translationSnippet);assert.equal(hit.quoteSnippet,null);
 const collection=C.createReadingCollection({key:'collection',title:'Selected',items:[C.collectionItemFromCapture(captures[0],[doc],{id:'item',createdAt:stamp})]});
 assert.deepEqual(C.validate(copy(collection)).items[0].snapshot.exact_excerpt,record);const md=C.readingCollectionMarkdown(collection,[]);assert.match(md,/第一/);assert.match(md,/My note/);assert.match(md,/不等于译文人工核对/);assert.doesNotMatch(md,/第二句/);
 assert.match(C.notebookMarkdown(doc),/不是完整翻译修订历史/);
 const before=JSON.stringify(record);doc.exact_excerpts.push(pair(doc,{id:'other'}));doc.exact_excerpt_notes.other='Keep';const removed=C.exactExcerptRemoval(doc,'pair');assert.deepEqual(removed.exact_excerpts.map(r=>r.id),['other']);assert.deepEqual({...removed.exact_excerpt_notes},{other:'Keep'});assert.equal(JSON.stringify(record),before);
});
function contextual(){
 const doc=source(),cue=doc.segments[0],context='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
 cue.translations.zh={text:'Translation',source_text:cue.text,source_language:'en',provider:'test_subscription_translation',context_id:context,context_version:2,target_language:'zh',glossary_snapshot:[],input_revision:'a'.repeat(64)};
 doc.translation_contexts[context]=[{id:'0',position:0,text:cue.text,start:0,end:2,speaker:'A'}];return {doc,context};
}
test('direct context/glossary are immutable and reject contradiction or dropped evidence',()=>{
 const {doc,context}=contextual(),record=pair(doc);assert.deepEqual(record.translation.cues[0].context,doc.translation_contexts[context]);
 for(const change of [r=>r.translation.cues[0].context[0].text='bad',r=>r.translation.cues[0].context=null,r=>r.translation.cues[0].glossary=[{source:'One',target:'一'}]]){
  const bad=copy(record);change(bad);assert.throws(()=>C.validate({...doc,exact_excerpts:[bad]}));
 }
 doc.translation_contexts[context][0].text='changed';assert.equal(record.translation.cues[0].context[0].text,'One');assert.equal(C.exactExcerptFreshness(record,doc),'stale');
});
test('only selected cue provenance is summarized, never unselected human review or quality warnings',()=>{
 const doc=source(),cue=doc.segments[1];C.saveManualTranslation(doc,cue,'zh','人工译文',C.manualReviewSnapshot(doc,cue,'zh'),JSON.stringify(cue.translations.zh));doc.segments[2].translations.zh.quality_warnings=['numbers_changed'];
 const model=C.translationSelectionModels(doc,doc.segments,'zh')[0],info=C.translationSelectionInfo(model,0,2),r=pair(doc,{model,translationTo:2});
 assert.deepEqual(info.providers,['model']);assert.deepEqual(info.reviewStates,['machine']);assert.deepEqual(info.qualityWarnings,[]);assert.equal(info.sourceTime,null);assert.deepEqual(C.exactExcerptTranslation(r).reviewStates,['machine']);
 doc.exact_excerpts=[r];assert.doesNotMatch(C.notebookMarkdown(doc),/已有人工核对记录|用户自己写/);assert.throws(()=>C.translationSelectionInfo(copy(model),0,2));
 const entire=pair(doc,{model});assert.ok(C.exactExcerptTranslation(entire).reviewStates.includes('human-reviewed'));assert.ok(entire.translation.cues[1].translation.original_translation);
});
test('large sparse translation windows reuse one original snapshot across all runs',()=>{
 const doc=source();doc.segments=Array.from({length:1000},(_,i)=>({id:String(i),text:'x',start:i,end:i+1,speaker:null,translations:i%2?{}:{zh:{text:'译',source_text:'x',provider:'user',source_language:''}}}));
 let maps=0;const original=doc.segments.map;doc.segments.map=function(...args){maps++;return original.apply(this,args);};
 const runs=C.translationSelectionModels(doc,doc.segments,'zh');assert.equal(runs.length,500);assert.equal(maps,1);
 const record=C.pairedExactExcerptSnapshot(doc,doc.segments,Array(999).fill(' '),0,1,runs[0],0,1,{id:'stress',createdAt:stamp,confirmedAt:stamp});assert.equal(C.exactExcerptTranslationParts(record).length,1);
});
test('failed persistence does not acknowledge saved and leaves prior durable source intact',async()=>{
 const doc=source(),raw=JSON.stringify({documents:[doc],active:doc.key}),map=new Map([[Store.KEY,raw]]),storage={getItem:k=>map.get(k)??null,setItem(){throw Object.assign(Error('full'),{name:'QuotaExceededError'});}};
 const adapter=Store.createLegacyAdapter({getStorage:()=>storage,validate:C.validate});assert.equal(adapter.load().ok,true);doc.exact_excerpts=[pair(doc)];
 const store=Store.create({adapter,getDocuments:()=>[doc]}),ticket=store.queueDocument(doc.key,doc);await store.flush();assert.equal((await ticket.committed).ok,false);assert.equal(map.get(Store.KEY),raw);assert.equal(doc.exact_excerpts.length,1);
});
test('IDB migration and reopen roundtrip bilingual snapshots and independent notes',async()=>{
 const doc=source();doc.exact_excerpts=[pair(doc)];doc.exact_excerpt_notes={pair:'Note\r\nunchanged'};
 const map=new Map([[Store.KEY,JSON.stringify({documents:[doc],active:doc.key})]]),storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)},engine=transactionDouble(),options={indexedDB:engine.indexedDB,name:'bilingual-rebuilt',getStorage:()=>storage,validate:C.validate,legacyModule:Store,documentModule:IDB};
 const first=await Provider.initialize(options);assert.equal(first.ok,true);first.adapter.close();const second=await Provider.initialize(options);assert.equal(second.ok,true);assert.deepEqual(second.loaded.documents[0].exact_excerpts,doc.exact_excerpts);assert.equal(second.loaded.documents[0].exact_excerpt_notes.pair,doc.exact_excerpt_notes.pair);second.adapter.close();
});
test('restoration rejects translation language and subscription contradictions inferable from frozen source',()=>{
 const machine=pair(source());
 for(const mutate of [
  r=>r.translation.cues[0].translation.document_language='de',
  r=>r.translation.cues[0].translation.provider='test_subscription_translation'
 ]){
  const bad=copy(machine);mutate(bad);assert.throws(()=>C.validate({...source(),exact_excerpts:[bad]}));
 }
 const doc=source(),cue=doc.segments[0];C.saveManualTranslation(doc,cue,'zh','人工译文',C.manualReviewSnapshot(doc,cue,'zh'),JSON.stringify(cue.translations.zh));
 const human=pair(doc),bad=copy(human);bad.translation.cues[0].translation.manual_review.document_language='de';
 assert.throws(()=>C.validate({...doc,exact_excerpts:[bad]}));
 // A prior machine item's document language may differ after genuine current
 // manual review; its historical field must not override the current review.
 const historic=copy(human);historic.translation.cues[0].translation.document_language='de';
 assert.doesNotThrow(()=>C.validate({...doc,exact_excerpts:[historic]}));
});

test('long selected translation enters cooperative history search, yields late hits and cancels stale jobs',()=>{
 const doc={...C.validate({title:'Short source',language:'en',segments:Array.from({length:7},(_,i)=>({id:String(i),text:'x',start:i,end:i+1,translations:{zh:{text:'译'.repeat(11999)+(i===6?'末':'译'),source_text:'x',source_language:'en',provider:'model'}}}))}),key:'large-pair'};
 const original=C.exactExcerptSnapshot(doc,doc.segments,Array(6).fill(' '),0,1,{id:'large',createdAt:stamp});
 // Construct a valid imported snapshot, avoiding irrelevant grapheme capture
 // cost while testing the scheduler's restored-history path.
 const text=doc.segments.map(c=>c.translations.zh.text).join('');
 const record={...original,version:2,translation:{language:'zh',text,cues:doc.segments.map(c=>({cue_id:c.id,translation:c.translations.zh,context:null,glossary:[]})),separators:Array(6).fill(''),from:0,to:text.length},pairing:{kind:'user-confirmed-correspondence',confirmed_at:stamp}};
 doc.exact_excerpts=C.validate({...doc,exact_excerpts:[record]}).exact_excerpts;
 for(const cue of doc.segments)cue.translations={};
 const tasks=[],search=C.createLibrarySearch({getDocuments:()=>[doc],schedule:fn=>tasks.push(fn),now:()=>0,workSize:1}),drain=()=>{let budget=10000;while(tasks.length){assert.ok(budget-->0);tasks.shift()();}};
 const canceled=search.request('末','all','text');assert.equal(canceled.pending,true);assert.ok(tasks.length);tasks.shift()();assert.equal(canceled.savedHits.size,0);search.cancel();drain();assert.equal(search.isCurrent(canceled),false);assert.equal(canceled.savedHits.size,0);
 const late=search.request('末','all','text');assert.equal(late.pending,true);tasks.shift()();assert.equal(late.pending,true);drain();assert.equal(late.savedHits.get(doc).total,1);assert.equal(late.savedHits.get(doc).hits[0].translationSnippet.match,'末');
 const replaced=search.request('译','all','text');assert.equal(replaced.pending,true);const clear=search.request('','all','title');drain();assert.equal(search.isCurrent(replaced),false);assert.equal(replaced.savedHits.size,0);assert.equal(search.isCurrent(clear),true);
 const notebookTasks=[],notebook=C.createLibraryNotebookSearch({getDocuments:()=>[doc],schedule:fn=>notebookTasks.push(fn),now:()=>0,workSize:1}),drainNotebook=()=>{let budget=10000;while(notebookTasks.length){assert.ok(budget-->0);notebookTasks.shift()();}};
 const notebookCanceled=notebook.request('末');assert.equal(notebookCanceled.pending,true);assert.ok(notebookTasks.length);notebook.cancel();drainNotebook();assert.equal(notebook.isCurrent(notebookCanceled),false);assert.equal(notebookCanceled.captures.length,0);
 const notebookLate=notebook.request('末');assert.equal(notebookLate.pending,true);drainNotebook();assert.deepEqual(notebookLate.captures,C.libraryCaptures([doc],'末'));assert.equal(notebookLate.captures.length,1);
 const notebookOld=notebook.request('译');assert.equal(notebookOld.pending,true);const notebookClear=notebook.request('');drainNotebook();assert.equal(notebook.isCurrent(notebookOld),false);assert.equal(notebookOld.captures.length,0);assert.equal(notebook.isCurrent(notebookClear),true);

});
