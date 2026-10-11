import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import C from '../reader/core.js';
import P from '../reader/passages.js';
const stamp='2026-10-11T01:00:00.000Z';
function fixture(text='Historical needle',count=1){
 const doc={...C.validate({title:'Current title',language:'en',source_url:'',segments:[{id:'live-cue',text,start:0,end:5}]}),key:'document'};
 const record=C.exactExcerptSnapshot(doc,doc.segments,[],0,text.length,{id:'saved-record',createdAt:stamp});
 doc.exact_excerpts=Array.from({length:count},(_,i)=>i?Object.freeze({...record,id:'saved-'+i}):record);doc.segments=[];return doc;
}
function controller(documents,options={}){
 const tasks=[];let revision=0;
 const search=C.createLibrarySearch({getDocuments:()=>documents,getRevision:()=>revision,schedule:fn=>tasks.push(fn),now:()=>0,workSize:1,...options});
 return {search,tasks,edit(){revision++;},step(){assert.ok(tasks.length);tasks.shift()();},drain(){let guard=100000;while(tasks.length){assert.ok(guard-->0);tasks.shift()();}}};
}
test('shelf scopes separate current sources from selected historical quote, personal note and attribution',()=>{
 const doc=fixture();doc.exact_excerpt_notes=C.exactExcerptNotesWith(doc,'saved-record','My unique thought needle');
 assert.equal(C.libraryMatches(doc,'needle','all','title'),false);
 assert.equal(C.libraryMatches(doc,'Historical','all','notes'),false);
 assert.equal(C.libraryMatches(doc,'thought','all','notes'),true);
 assert.equal(C.libraryMatches(doc,'Historical','all','text'),true);
 assert.equal(C.libraryMatches(doc,'Historical','audio','text'),false);
 assert.equal(C.libraryMatches(doc,'Historical','annotated','text'),true);
 assert.deepEqual(C.libraryHits(doc,'needle','text'),[]);
 assert.equal(C.searchDocument(doc,'needle','text').byCue.size,0);
 for(const [query,scope,field] of [['Historical','text','quote'],['thought','notes','note'],['needle','text','both']]){
  const result=C.librarySavedHits(doc,query,scope);assert.equal(result.total,1);const hit=result.hits[0];
  assert.equal(hit.kind,'exact-excerpt');assert.equal(hit.matchFields,field);assert.equal(hit.captureKey,JSON.stringify([doc.key,'exact-excerpt','saved-record']));assert.equal(hit.key,hit.captureKey);
  assert.equal(Object.hasOwn(hit,'ids'),false);assert.equal(C.librarySavedHitCurrent(hit,[doc]),true);
 }
 const oldTitle=doc.exact_excerpts[0].snapshot.source.title;doc.title='new shelf title';assert.equal(C.librarySavedHits(doc,oldTitle,'text').total,0);
 for(const scope of ['title','notes','text'])assert.deepEqual(C.librarySavedHits(doc,' ',scope),{hits:[],total:0});
});
test('only selected quotation text is searchable, never captured context or corrections',()=>{
 const doc={...C.validate({title:'a',segments:[{id:'cue',text:'context selected remainder',original_text:'prior correction',start:0,end:1}]}),key:'a'};
 doc.exact_excerpts=[C.exactExcerptSnapshot(doc,doc.segments,[],8,16,{id:'record',createdAt:stamp})];doc.segments=[];
 assert.equal(C.librarySavedHits(doc,'selected','text').total,1);
 for(const query of ['context','remainder','prior correction'])assert.equal(C.librarySavedHits(doc,query,'text').total,0);
});
test('whitespace sidecars never match while independent quotation remains searchable and raw notes survive',()=>{
 const doc=fixture('quotation \u0085 more');
 for(const note of ['', ' \n\t', '\u0085\uFEFF']){
  doc.exact_excerpt_notes={'saved-record':note};assert.equal(C.librarySavedHits(doc,'\u0085','notes').total,0);
  const hit=C.librarySavedHits(doc,'quotation','text').hits[0];assert.equal(hit.noteSnippet,null);assert.equal(hit.note,note);
 }
 delete doc.exact_excerpt_notes;assert.equal(C.librarySavedHits(doc,'quotation','text').total,1);
});
test('distinct historical identities retain complete counts and bounded previews without displacing live hits',()=>{
 const doc=fixture('needle',4103);doc.segments=[{id:'saved-record',text:'needle live',start:0,end:1}];doc.notes['saved-record']='needle note';
 const result=C.librarySavedHits(doc,'needle','text');assert.equal(result.total,4103);assert.equal(result.hits.length,3);assert.equal(new Set(result.hits.map(h=>h.captureKey)).size,3);
 assert.equal(C.librarySavedHits(doc,'needle','text',0).total,4103);assert.equal(C.librarySavedHits(doc,'needle','text',0).hits.length,0);
 assert.deepEqual(C.libraryHits(doc,'needle','text').map(h=>h.kind),['note','text']);
 const ctl=controller([doc]),job=ctl.search.request('needle','all','text');assert.equal(job.pending,true);assert.equal(job.savedHits.size,0);ctl.step();assert.equal(job.savedHits.size,0);ctl.drain();
 assert.deepEqual(job.savedHits.get(doc),result);assert.equal(job.docs.length,1);assert.equal(ctl.search.request('needle','all','text'),job);assert.equal(ctl.tasks.length,0);
});
test('giant quote and note yield, include late and cross-checkpoint matches, and preserve Unicode snippets',()=>{
 for(const useNote of [false,true]){
  const text='x'.repeat(65535)+'İΣA ΟΣ <b> 🌴 cross boundary '+ 'x'.repeat(200000)+'late needle';
  // Avoid asking Intl.Segmenter to re-capture giant fixture text; saved text is
  // immutable input here, matching a previously validated imported record.
  const doc=fixture('original'),record=doc.exact_excerpts[0];
  if(useNote)doc.exact_excerpt_notes={'saved-record':text};else doc.exact_excerpts=[Object.freeze({...record,text})];
  for(const query of ['cross boundary','late needle','i\u0307σ','ος','<b>','🌴']){
   const ctl=controller([doc]),job=ctl.search.request(query,'all',useNote?'notes':'text');assert.equal(job.pending,true);ctl.step();assert.equal(job.pending,true);assert.equal(job.savedHits.size,0);ctl.drain();
   const hit=job.savedHits.get(doc).hits[0],snippet=useNote?hit.noteSnippet:hit.quoteSnippet;assert.ok(snippet);assert.ok(snippet.match.length<=122);assert.equal(job.savedHits.get(doc).total,1);
  }
 }
 const iterator=P.searchSnippetSteps('x'.repeat(2047)+'boundary phrase','boundary phrase');let yields=0,result;do{result=iterator.next();if(!result.done)yields++;}while(!result.done);assert.ok(yields>0);assert.equal(result.value.match,'boundary phrase');
});
test('snapshot freshness fences maps, arrays, objects, removal, Undo and in-place final click changes',()=>{
 const doc=fixture(),documents=[doc],ctl=controller(documents);let job=ctl.search.request('needle','all','text');let hit=job.savedHits.get(doc).hits[0];
 doc.exact_excerpt_notes={};assert.equal(ctl.search.isCurrent(job),false);assert.equal(C.librarySavedHitCurrent(hit,documents),false);
 job=ctl.search.request('needle','all','text');hit=job.savedHits.get(doc).hits[0];doc.exact_excerpt_notes['saved-record']='changed';assert.equal(C.librarySavedHitCurrent(hit,documents),false);ctl.edit();assert.equal(ctl.search.isCurrent(job),false);
 job=ctl.search.request('needle','all','text');hit=job.savedHits.get(doc).hits[0];const record=doc.exact_excerpts[0];doc.exact_excerpts[0]={...record};assert.equal(C.librarySavedHitCurrent(hit,documents),false);ctl.edit();
 job=ctl.search.request('needle','all','text');hit=job.savedHits.get(doc).hits[0];doc.exact_excerpts=[...doc.exact_excerpts];assert.equal(ctl.search.isCurrent(job),false);assert.equal(C.librarySavedHitCurrent(hit,documents),false);
 job=ctl.search.request('needle','all','text');hit=job.savedHits.get(doc).hits[0];documents[0]={...doc};assert.equal(ctl.search.isCurrent(job),false);assert.equal(C.librarySavedHitCurrent(hit,documents),false);
 documents.length=0;assert.equal(ctl.search.request('needle','all','text').docs.length,0);documents.push(doc);job=ctl.search.request('needle','all','text');assert.deepEqual(job.docs,[doc]);
 doc.exact_excerpts=[];assert.equal(ctl.search.isCurrent(job),false);assert.equal(ctl.search.request('needle','all','text').docs.length,0);
});
test('cancel and A to B to clear discard partial saved previews and prevent stale publication',()=>{
 const doc=fixture('needle',4200),ctl=controller([doc]);const a=ctl.search.request('needle','all','text');ctl.step();assert.equal(a.savedHits.size,0);
 const b=ctl.search.request('absent','all','notes');const clear=ctl.search.request('','all','title');ctl.drain();assert.equal(ctl.search.isCurrent(a),false);assert.equal(ctl.search.isCurrent(b),false);assert.equal(ctl.search.isCurrent(clear),true);assert.deepEqual(clear.savedHits.get(doc),{hits:[],total:0});assert.equal(a.savedHits.size,0);
 const c=ctl.search.request('needle','all','text');ctl.step();doc.exact_excerpt_notes={};ctl.drain();assert.equal(ctl.search.isCurrent(c),false);assert.equal(c.savedHits.size,0);
 const d=ctl.search.request('needle','all','text');ctl.step();ctl.search.cancel();ctl.drain();assert.equal(ctl.search.isCurrent(d),false);assert.equal(d.savedHits.size,0);
});
test('completed saved previews require no record-text reads on cached page renders',()=>{
 const doc=fixture('needle',4101);let reads=0;doc.exact_excerpts=doc.exact_excerpts.map(record=>({...record,get text(){reads++;return 'needle';}}));
 const ctl=controller([doc]),job=ctl.search.request('needle','all','text');ctl.drain();const before=reads;
 for(let i=0;i<10;i++){assert.equal(ctl.search.request('needle','all','text'),job);assert.equal(job.savedHits.get(doc).hits.length,3);}
 assert.equal(reads,before);
});
test('browser classic script order loads lazy passage helper without a circular dependency',()=>{
 const context=vm.createContext({console,Intl,performance,setTimeout});context.window=context;
 vm.runInContext(readFileSync(new URL('../reader/summary.js',import.meta.url),'utf8'),context);
 vm.runInContext(readFileSync(new URL('../reader/core.js',import.meta.url),'utf8'),context);
 vm.runInContext(readFileSync(new URL('../reader/passages.js',import.meta.url),'utf8'),context);
 const doc=fixture();assert.equal(context.Coconut.librarySavedHits(doc,'needle','text').total,1);
});
test('long repetitive queries span many checkpoints without truncation or context-field joins',()=>{
 const needle='a'.repeat(7000)+'b',doc=fixture('original'),record=doc.exact_excerpts[0];
 doc.exact_excerpts=[Object.freeze({...record,text:'a'.repeat(90000)+'b'})];doc.exact_excerpt_notes={'saved-record':'tail'};
 const ctl=controller([doc]),job=ctl.search.request(needle,'all','text');ctl.drain();assert.equal(job.savedHits.get(doc).total,1);assert.ok(job.savedHits.get(doc).hits[0].quoteSnippet.match.endsWith('…'));
 assert.equal(C.librarySavedHits(doc,'b tail','text').total,0);
 const job2=ctl.search.request('missing','all','text');ctl.step();ctl.search.cancel();ctl.drain();assert.equal(job2.savedHits.size,0);
});
