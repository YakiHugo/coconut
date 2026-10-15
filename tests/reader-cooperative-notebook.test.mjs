// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import C from '../reader/core.js';

import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';

function scheduler(){const tasks=[];return {schedule:run=>tasks.push(run),step(){assert.ok(tasks.length);tasks.shift()();},drain(){let guard=20000;while(tasks.length){assert.ok(guard-->0);tasks.shift()();}},get size(){return tasks.length;}};}

function control(documents){const queue=scheduler();let revision=0,changes=0;const search=C.createLibraryNotebookSearch({getDocuments:()=>documents,getRevision:()=>revision,schedule:queue.schedule,now:()=>0,workSize:2,onChange:()=>changes++});return {queue,search,edit(){revision++;},get changes(){return changes;}};}

function fixture(count=3,cues=1500){const docs=largeLibraryFixture(count,{cues});for(const doc of docs){for(const cue of doc.segments)cue.saved_excerpt=true;doc.notes[doc.segments.at(-1).id]='Last private thought '+doc.key;}return docs;}

function oracle(documents,query='',kind='all'){
 const needle=query.trim().toLocaleLowerCase(),captures=[];
 for(const doc of documents){const add=(type,id,text,note,timestamp,excerpt=false)=>{
  const capture={key:JSON.stringify([doc.key,type,id]),documentKey:doc.key,type,id,text,note,time:timestamp,excerpt};
  if(kind!=='all'&&!(kind==='excerpt'&&excerpt)&&!(kind==='note'&&C.hasNoteContent(note)))return;
  if(needle&&![doc.title,text,note,id,timestamp===null?'':C.time(timestamp)].some(value=>String(value||'').toLocaleLowerCase().includes(needle)))return;
  captures.push(capture);
 };
 for(const cue of doc.segments.filter(cue=>cue.saved_excerpt===true||C.hasNoteContent(doc.notes?.[cue.id])))add('cue',cue.id,cue.text,doc.notes?.[cue.id]||'',cue.start,cue.saved_excerpt===true);
 if(C.hasProjectAnnotations(doc)){if(C.hasNoteContent(doc.project_note))add('project-note','','',doc.project_note,null);for(const item of doc.timestamp_bookmarks||[])add('bookmark',item.id,'',item.note||'',item.time);}
 }return captures;
}

test('resumable captures and sync wrapper preserve independent old semantics and order',()=>{
 const docs=fixture(2,150);docs[0].segments[0].saved_excerpt=false;docs[0].notes[docs[0].segments[0].id]='\u2003\uFEFF';
 for(const doc of docs){doc.project_note='Project thought';doc.timestamp_bookmarks=[{id:'same',time:90,note:''},{id:'later',time:2,note:'Bookmark note'}];}
 docs[1].segments[0].id=docs[0].segments[1].id;
 const {queue,search}=control(docs);
 for(const kind of ['all','note','excerpt'])for(const query of ['','AUTHORED','source sentence 149','Project','Bookmark','same','01:30','missing']){
  const expected=oracle(docs,query,kind);assert.deepEqual(C.libraryCaptures(docs,query,kind),expected);
  assert.deepEqual([...C.libraryCaptureSteps(docs,query,kind)].filter(Boolean),expected);
  const job=search.request(query,kind);queue.drain();assert.deepEqual(job.captures,expected);
 }
});

test('single giant sparse document yields before scanning and repeated completed request scans no cues',()=>{
 const docs=largeLibraryFixture(1,{cues:12000});let reads=0;
 for(const cue of docs[0].segments)Object.defineProperty(cue,'saved_excerpt',{get(){reads++;return false;}});
 docs[0].notes[docs[0].segments.at(-1).id]='Last note';const {queue,search}=control(docs);
 const job=search.request('Last');assert.equal(job.pending,true);assert.equal(reads,0);assert.deepEqual(job.captures,[]);
 queue.step();assert.ok(reads<=256);assert.equal(job.pending,true);assert.deepEqual(job.captures,[]);
 queue.drain();assert.equal(job.captures.length,1);assert.equal(job.captures[0].id,docs[0].segments.at(-1).id);
 const before=reads;assert.equal(search.request('Last'),job);assert.equal(reads,before);assert.equal(queue.size,0);
});

test('dense captures publish only complete results and build stable-key indexes incrementally',()=>{
 const docs=fixture(),{queue,search}=control(docs),job=search.request();queue.step();assert.equal(job.captures.length,0);assert.equal(job.indexes.size,0);
 queue.drain();assert.equal(job.captures.length,4500);assert.equal(job.indexes.get(job.captures.at(-1).key),4499);assert.deepEqual(job.captures,oracle(docs));
});

test('bookmark-only library yields and preserves blank bookmarks and source array order',()=>{
 const docs=Array.from({length:3},(_,d)=>({key:'audio-'+d,title:'Audio',segments:[],project_note:'Project',timestamp_bookmarks:Array.from({length:2000},(_,i)=>({id:'b'+i,time:2000-i,note:''}))}));
 const {queue,search}=control(docs),job=search.request();assert.equal(job.pending,true);queue.step();assert.equal(job.captures.length,0);queue.drain();assert.deepEqual(job.captures,oracle(docs));assert.equal(job.captures.length,6003);
});

test('replacement queries and cancellation dispose partial jobs without callbacks reviving them',()=>{
 const docs=fixture(),control_=control(docs),{queue,search}=control_;
 const a=search.request('source');queue.step();assert.ok(a.building.length);const b=search.request('Last private');assert.equal(a.operation,null);assert.equal(a.building.length,0);
 search.cancel();const changes=control_.changes;queue.drain();assert.equal(b.operation,null);assert.equal(control_.changes,changes);
 const final=search.request('missing');queue.drain();assert.equal(final.pending,false);assert.equal(final.captures.length,0);assert.equal(search.isCurrent(a),false);
});

test('enqueue revisions, source/translation invalidation, replacement, removal and Undo retire snapshots',()=>{
 const docs=fixture(),state=control(docs),{queue,search}=state;
 const finish=()=>{const job=search.request('Last private');queue.drain();return job;};
 let job=finish();docs[0].notes[docs[0].segments.at(-1).id]='Removed';state.edit();assert.equal(search.isCurrent(job),false);job=finish();assert.equal(job.captures.length,2);
 const pending=search.request('source');queue.step();docs[1].segments.at(-1).text='Corrected source';C.invalidateSearch(docs[1]);queue.drain();assert.equal(pending.operation,null);assert.equal(search.isCurrent(pending),false);
 job=finish();docs[1].translation_view='zh';assert.equal(search.isCurrent(job),false);job=finish();C.invalidateSearch(docs[1]);assert.equal(search.isCurrent(job),false);
 job=finish();const old=docs[2];docs[2]={...old};assert.equal(search.isCurrent(job),false);job=finish();const removed=docs.pop();assert.equal(search.isCurrent(job),false);job=finish();assert.equal(job.captures.length,1);docs.push(removed);job=finish();assert.equal(job.captures.length,2);
});

test('capture activation rejects same-ID source replacement and in-place annotation changes',()=>{
 const docs=fixture(1,3),doc=docs[0];doc.project_note='Project';doc.timestamp_bookmarks=[{id:'b',time:90,note:'Book'}];
 const captures=C.libraryCaptures(docs);for(const capture of captures)assert.equal(C.libraryCaptureCurrent(capture,docs),true);
 doc.segments[0]={...doc.segments[0]};assert.equal(C.libraryCaptureCurrent(captures[0],docs),false);
 doc.notes[doc.segments[1].id]='New note';assert.equal(C.libraryCaptureCurrent(captures[1],docs),false);
 doc.project_note='Changed';assert.equal(C.libraryCaptureCurrent(captures[3],docs),false);
 doc.timestamp_bookmarks[0]={...doc.timestamp_bookmarks[0]};assert.equal(C.libraryCaptureCurrent(captures[4],docs),false);
});
