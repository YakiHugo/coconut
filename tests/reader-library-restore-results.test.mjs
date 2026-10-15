// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);

const C=require('../reader/core.js');

const clone=value=>JSON.parse(JSON.stringify(value));

const doc=(key,title=key)=>({...C.validate({title,segments:[{id:'cue',start:0,end:3,text:'Authored source '+key}],notes:{cue:'Original '+key}}),key});

const envelope=(documents,active=documents[0]?.key||null)=>({format:'coconut-library',version:1,documents,active});

test('restore plan maps every input to its exact live destination, including collisions and in-file duplicates',()=>{
 const old=doc('same','Same title'),same=clone(old),changed={...clone(old),notes:{cue:'Backup version'}},newDoc=doc('new');
 const backup=envelope([changed,{...same,key:'alias'},newDoc,{...clone(newDoc),key:'new-alias'}],'same');
 const current={documents:[old,doc('same-restored-1')],active:'same'};
 const before=JSON.stringify(current),plan=C.planLibraryBackup(current,backup);
 assert.deepEqual(plan.entries.map(entry=>[entry.sourceKey,entry.document.key,entry.outcome]),[['same','same-restored-2','conflict'],['alias','same','duplicate'],['new','new','added'],['new-alias','new','duplicate']]);
 assert.equal(plan.entries[1].document,old);assert.equal(plan.entries[2].document,plan.entries[3].document);
 assert.equal(plan.library.active,'same-restored-2');assert.equal(plan.library.documents.length,4);assert.equal(JSON.stringify(current),before);
 assert.deepEqual(clone(C.mergeLibraryBackup(current,backup)),clone(plan.library));
 assert.deepEqual(C.planLibraryBackup(plan.library,backup).entries.map(entry=>entry.outcome),['duplicate','duplicate','duplicate','duplicate']);
});

test('plan validation is atomic and a collection-only restore never becomes an active transcript',()=>{
 const old=doc('existing'),before=JSON.stringify(old);
 assert.throws(()=>C.planLibraryBackup({documents:[old],active:old.key},envelope([doc('valid'),{key:'invalid',segments:[]}])));
 assert.equal(JSON.stringify(old),before);
 const collection=C.createReadingCollection({key:'collection',title:'Authored collection',items:[]});
 const result=C.planLibraryBackup({documents:[],active:null},envelope([collection]));
 assert.equal(result.entries[0].outcome,'added');assert.equal(result.library.active,null);
});
