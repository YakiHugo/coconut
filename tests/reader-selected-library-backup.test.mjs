// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import {createRequire} from 'node:module';

import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';

import {annotatedDocument} from './helpers/backup-fixtures.mjs';

const require=createRequire(import.meta.url);

const C=require('../reader/core.js');

const clone=value=>JSON.parse(JSON.stringify(value));

function richDocument(){
 const doc={...C.validate(annotatedDocument()),key:'rich'};
 const cue=doc.segments[0];C.saveManualTranslation(doc,cue,'zh','人工核对译文',C.manualReviewSnapshot(doc,cue,'zh'),JSON.stringify(cue.translations.zh));
 doc.ai_answers=Array.from({length:130},(_,index)=>({...doc.ai_answers[0],question:'Historical question '+index}));
 doc.exact_excerpts=[C.exactExcerptSnapshot(doc,doc.segments,[],0,8,{id:'capture',createdAt:'2026-10-11T00:00:00.000Z'})];
 doc.exact_excerpt_notes=C.exactExcerptNotesWith(doc,'capture','Exact private thought');
 doc.project_note='Project private note';doc.timestamp_bookmarks=[{id:'bookmark',time:2,note:'Timestamp private note'}];
 return {...C.validate(doc),key:doc.key};
}

test('selected envelope preserves all validated annotation fields, uses shelf order and restores additively',()=>{
 const rich=richDocument(),ordinary={...C.validate(largeLibraryFixture(1)[0]),key:'ordinary'},unselected={...ordinary,key:'private',title:'Do not export'};
 const docs=[ordinary,unselected,rich],selection=C.createLibraryBackupSelection();
 selection.toggle(rich,true,docs);selection.toggle(ordinary,true,docs);
 const payload=clone(selection.backup(docs,'private'));
 assert.deepEqual(payload,{format:'coconut-library',version:1,documents:clone([ordinary,rich]),active:'ordinary'});
 assert.equal(selection.backup(docs,'rich').active,'rich');
 const fresh=C.mergeLibraryBackup({documents:[],active:null},payload);assert.deepEqual(clone(fresh.documents),payload.documents);
 assert.equal(C.mergeLibraryBackup(fresh,payload).documents.length,2);
 const conflict=clone(rich);conflict.notes.cue='New version still kept';
 const merged=C.mergeLibraryBackup({documents:[unselected,conflict],active:unselected.key},payload);
 assert.equal(merged.documents.length,4);assert.equal(merged.documents[0],unselected);assert.equal(merged.documents[1],conflict);
 const restored=merged.documents.find(doc=>doc.key==='rich-restored-1');assert.deepEqual(clone({...restored,key:'rich'}),clone(rich));
 assert.equal(C.mergeLibraryBackup(merged,payload).documents.length,4);
});

test('unannotated local audio projects restore without embedding media bytes',()=>{
 const source={version:1,kind:'audio',name:'Authored.wav',size:64,last_modified:7,type:'audio/wav',fingerprint:'a'.repeat(64)};
 const doc={...C.validate({project_kind:'audio_only',title:'Unannotated audio',local_media_source:source,segments:[]}),key:'audio'};
 const selection=C.createLibraryBackupSelection();selection.toggle(doc,true,[doc]);const payload=clone(selection.backup([doc],null));
 assert.deepEqual(clone(C.mergeLibraryBackup({documents:[],active:null},payload).documents[0]),clone(doc));
 assert.equal(payload.documents[0].segments.length,0);assert.deepEqual(payload.documents[0].local_media_source,source);assert.doesNotMatch(JSON.stringify(payload),/blob:|base64/);
});

test('selection never silently adopts replacement identities or changes membership during structural operations',()=>{
 const doc=richDocument(),other={...doc,key:'other'},docs=[doc,other],selection=C.createLibraryBackupSelection();selection.toggle(doc,true,docs);
 const replacement={...doc,title:'same key, different identity'},pending=new Map([[doc.key,{}]]);
 assert.deepEqual(selection.reconcile([replacement,other],pending),{count:1,removed:0,blocked:true});
 assert.equal(selection.toggle(replacement,true,[replacement,other],pending),false);
 assert.throws(()=>selection.backup([replacement,other],other.key,pending),/正在移除或恢复/);
 assert.throws(()=>selection.backup([replacement,other],other.key),/已移除或替换/);
 assert.equal(selection.has(replacement),false);assert.equal(selection.has(doc),false);
 selection.toggle(doc,true,docs);assert.equal(selection.reconcile([other],pending).count,1);
 assert.throws(()=>selection.backup([other],other.key,pending),/正在移除或恢复/);
 assert.equal(selection.backup(docs,doc.key).documents[0],doc); // Failed operation rolled back the same identity.
 assert.equal(selection.reconcile([other]).removed,1);
 assert.throws(()=>selection.backup(docs,doc.key),/先选择/); // Undo/new same-key identity is not implicitly selected.
});
