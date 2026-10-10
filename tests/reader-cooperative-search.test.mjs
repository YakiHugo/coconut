import test from 'node:test';
import assert from 'node:assert/strict';
import Coconut from '../reader/core.js';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
import {libraryHarness} from './helpers/large-library-harness.mjs';
function scheduler(){const tasks=[];return {schedule:run=>tasks.push(run),step(){assert.ok(tasks.length);tasks.shift()();},drain(){let guard=10000;while(tasks.length){assert.ok(guard-->0);tasks.shift()();}},get size(){return tasks.length;}};}
function controller(documents){const queue=scheduler();let revision=0,changes=0;const search=Coconut.createLibrarySearch({getDocuments:()=>documents,getRevision:()=>revision,schedule:queue.schedule,now:()=>0,batchSize:7,onChange:()=>changes++});return {queue,search,edit(){revision++;},get changes(){return changes;}};}
test('cooperative selection yields before work, publishes only complete counts, and retains all late hits',()=>{
 const documents=largeLibraryFixture(501),{queue,search}=controller(documents);for(const doc of documents)doc.segments[7].text='late authored needle';
 const result=search.request('needle','all','text','title');assert.equal(result.pending,true);assert.equal(result.scanned,0);assert.equal(result.docs.length,0);
 queue.step();assert.equal(result.scanned,7);assert.equal(result.pending,true);assert.equal(result.docs.length,0);
 queue.drain();assert.equal(result.pending,false);assert.equal(result.docs.length,501);assert.equal(result.docs.at(-1),documents.at(-1));
 assert.equal(search.request('needle','all','text','title'),result);assert.equal(queue.size,0);
});
test('rapid A to B to clear prevents stale work and complete snapshots from winning',()=>{
 const documents=largeLibraryFixture(501),{queue,search}=controller(documents);
 const a=search.request('document 1','all','text');queue.step();const b=search.request('document 4','all','text');const clear=search.request('','all','title');
 assert.equal(clear.pending,false);assert.equal(clear.docs.length,501);queue.drain();assert.equal(a.scanned,7);assert.equal(b.scanned,0);assert.equal(search.request('','all','title'),clear);
});
test('same key replacement, remove and Undo identities, import, revisions and source invalidation retire snapshots',()=>{
 const documents=largeLibraryFixture(501),control=controller(documents);const {search,queue}=control;
 let result=search.request('needle','all','text');queue.step();const original=documents[0];documents[0]={...original,segments:original.segments.map(cue=>({...cue,text:'needle'}))};
 queue.drain();assert.equal(result.pending,true);result=search.request('needle','all','text');queue.drain();assert.deepEqual(result.docs,[documents[0]]);
 const restored=documents.shift();control.edit();result=search.request('needle','all','text');queue.step();documents.push(restored);control.edit();queue.drain();result=search.request('needle','all','text');queue.drain();assert.equal(result.docs[0],restored);
 const imported=largeLibraryFixture(1)[0];imported.key='imported';imported.notes[imported.segments[0].id]='needle';documents.push(imported);result=search.request('needle','all','notes');queue.drain();assert.equal(result.docs[0],imported);
 imported.notes[imported.segments[0].id]='gone';control.edit();result=search.request('needle','all','notes');queue.drain();assert.equal(result.docs.length,0);
 restored.segments[0].text='unique revised phrase';Coconut.invalidateSearch(restored);result=search.request('unique revised phrase','all','text');queue.drain();assert.equal(result.docs[0],restored);
});
test('cooperative and synchronous matching agree across phrase boundaries, scopes, filters and sort',()=>{
 const documents=largeLibraryFixture(181);documents[180].segments[0].text='boundary';documents[180].segments[1].text='phrase';documents[180].notes[documents[180].segments[7].id]='needle';documents[180].segments[7].saved_excerpt=true;
 const {queue,search}=controller(documents);
 for(const scope of ['title','notes','text'])for(const kind of ['all','annotated','audio','transcript'])for(const order of ['recent','title','duration']){
  const query=scope==='text'?'boundary phrase':'needle';const job=search.request(query,kind,scope,order);queue.drain();
  assert.deepEqual(job.docs,Coconut.sortedLibrary(documents,order).filter(doc=>Coconut.libraryMatches(doc,query,kind,scope)));
 }
});
test('pending UI is honest, old hits unavailable, clear responsive, and editor focus survives completion',async()=>{
 const queue=scheduler();const {w,$}=libraryHarness(largeLibraryFixture(501),{probe:true,configureCore(w){const create=w.Coconut.createLibrarySearch;w.Coconut.createLibrarySearch=options=>create({...options,schedule:queue.schedule,now:()=>0,batchSize:7});}});
 try{
  $('library-scope').value='text';$('library-search').value='document 500';$('library-search').focus();$('library-search').oninput();
  assert.equal($('library').hidden,true);assert.equal($('library').getAttribute('aria-busy'),'true');assert.match($('library-page-status').textContent,/正在查找.*0 \/ 501/);assert.equal($('library-pagination').hidden,true);
  queue.step();assert.match($('library-page-status').textContent,/7 \/ 501/);
  $('library-search').value='document 400';$('library-search').oninput();$('library-search').value='';$('library-search').oninput();assert.equal($('library').hidden,false);assert.equal($('library').children.length,40);queue.drain();assert.match($('library-page-status').textContent,/1–40 \/ 501/);
  $('library-search').value='document 500';$('library-search').oninput();$('source-url').focus();const focus=w.document.activeElement;queue.drain();assert.equal($('library').hidden,false);assert.equal($('library').children.length,1);assert.equal($('library').firstElementChild.dataset.documentKey,'shelf-500');assert.equal(w.document.activeElement,focus);assert.match($('library-page-status').textContent,/1–1 \/ 1/);
 }finally{await w.happyDOM.close();}
});
test('title hits prepare source caches between yields rather than cold-building a page at completion',()=>{
 const documents=largeLibraryFixture(181);let reads=0;
 for(const doc of documents){doc.title='needle title';for(const cue of doc.segments)Object.defineProperty(cue,'text',{get(){reads++;return 'authored source';}});}
 const {search,queue}=controller(documents);const job=search.request('needle','all','text');queue.drain();assert.equal(job.docs.length,181);assert.ok(reads>0);
 const before=reads;for(const doc of job.docs.slice(0,40))Coconut.libraryHits(doc,'needle','text');assert.equal(reads,before);
});
