// Compatibility renderer regression; this suite is not default React acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {transactionDouble} from './helpers/indexeddb-transaction-double.mjs';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {settle} from './helpers/save-pipeline.mjs';
const require=createRequire(import.meta.url),C=require('../reader/core.js');
const clone=value=>JSON.parse(JSON.stringify(value));
const doc=(key,title=key)=>({...C.validate({title,segments:[{id:'cue',start:0,end:3,text:'Authored source '+key}],notes:{cue:'Original '+key}}),key});
const envelope=(documents,active=documents[0]?.key||null)=>({format:'coconut-library',version:1,documents,active});
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
function restore($,data,{name='authored-backup.json',read=async()=>JSON.stringify(data)}={}){
 const input=$('library-file');Object.defineProperty(input,'files',{configurable:true,value:[{name,size:200,text:read}]});return input.onchange();
}
const open=$=>$('open-library-restore-results').click();
const rows=$=>[...$('library-restore-results-list').children];
const outcome=$=>rows($).map(row=>row.dataset.outcome);
const statuses=$=>rows($).map(row=>row.dataset.state);
const report=$=>$('library-restore-results-summary').textContent;
const stored=w=>JSON.parse(w.localStorage.getItem('coconut-reader-v1'));

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

test('UI distinguishes same-title conflict, duplicate and new documents and opens the precise restored version',async()=>{
 const original=doc('same','Identical title'),{w,$}=libraryHarness([original],{probe:true});
 try{
  assert.equal($('open-library-restore-results').hidden,true);
  const changed={...clone(original),notes:{cue:'Restored old note'}},fresh=doc('new','New document');
  await restore($,envelope([changed,{...clone(original),key:'duplicate'},fresh]));
  assert.equal($('library-restore-results-dialog').open,false,'completion must not steal reading focus');
  open($);assert.match(report($),/共 3 项：新增 1 · 冲突副本 1 · 重复跳过 1/);
  assert.deepEqual(outcome($),['conflict','duplicate','added']);assert.deepEqual(statuses($),['saved','saved','saved']);
  assert.match(rows($)[0].textContent,/same-restored-1/);assert.match(rows($)[1].textContent,/当前内容已保存到本机/);
  rows($)[0].querySelector('button').click();assert.equal($('library-restore-results-dialog').open,false);
  assert.equal(w.sessionStorage.getItem('coconut-reader-active-v1'),'same-restored-1');
  $('mode-transcript').click();w.document.querySelector('.note-button').click();assert.equal($('note').value,'Restored old note');
  $('close-note').click();open($);rows($)[1].querySelector('button').click();assert.equal(w.sessionStorage.getItem('coconut-reader-active-v1'),'same');
  assert.equal(w.libraryProbe.documents.find(item=>item.key==='same').notes.cue,'Original same');
 }finally{await w.happyDOM.close();}
});

test('held and failed restore receipts stay truthful beside saved duplicates, support rescue and retry without replacing focused rows',async()=>{
 const original=doc('saved'),{w,$,pipeline}=libraryHarness([original],{probe:true});let pending;
 try{
  pipeline.hold();pending=restore($,envelope([clone(original),doc('new'),{...doc('new'),key:'new-alias'}]));await settle();
  open($);assert.deepEqual(statuses($),['saved','pending','pending']);
  const button=rows($)[1].querySelector('button');button.focus();
  pipeline.writes[0].fail();await pending;assert.deepEqual(statuses($),['saved','failed','failed']);
  assert.equal(w.document.activeElement,button);assert.equal(button.isConnected,true);
  assert.equal(stored(w).documents.length,1);assert.equal($('library-restore-results-retry').hidden,false);
  let blob;w.URL.createObjectURL=value=>{blob=value;return 'blob:restore-rescue';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};
  $('library-restore-results-backup').click();const rescue=JSON.parse(await blob.text());
  assert.deepEqual(rescue.documents.map(item=>item.key),['new']);assert.deepEqual(statuses($),['saved','failed','failed']);
  assert.match($('library-restore-results-feedback').textContent,/下载不会改变保存状态/);
  pipeline.hold(false);await $('library-restore-results-retry').onclick();assert.deepEqual(statuses($),['saved','saved','saved']);
  assert.equal(stored(w).documents.length,2);assert.equal(w.document.activeElement,button);
 }finally{pipeline.hold(false);for(const write of pipeline.writes)write.fail();await pending;await w.happyDOM.close();}
});

test('duplicate of a failed in-page document is not falsely reported as saved and reflects later edits/receipts',async()=>{
 const {w,$,pipeline}=libraryHarness([],{probe:true});let pending;
 try{
  pipeline.hold();pending=restore($,envelope([doc('unsaved')]));await settle();pipeline.writes[0].fail();await pending;
  await restore($,envelope([doc('unsaved')]));open($);assert.deepEqual(outcome($),['duplicate']);assert.deepEqual(statuses($),['failed']);
  assert.equal(stored(w).documents.length,0);
  pipeline.hold(false);await $('library-restore-results-retry').onclick();assert.deepEqual(statuses($),['saved']);
  const live=w.libraryProbe.documents[0];pipeline.hold();live.notes.cue='Newer local edit';pipeline.store.queueDocument(live.key,live);
  assert.deepEqual(statuses($),['pending']);const flush=pipeline.store.flush();await settle();pipeline.writes.at(-1).fail();await flush;
  assert.deepEqual(statuses($),['failed']);assert.match(rows($)[0].textContent,/当前内容未保存/);
 }finally{pipeline.hold(false);for(const write of pipeline.writes)write.fail();await pending;await w.happyDOM.close();}
});

test('result identity cannot attach to a removed/reimported document or an unregistered same-key replacement',async()=>{
 const {w,$}=libraryHarness([],{probe:true});
 try{
  await restore($,envelope([doc('reused')]));open($);const old=rows($)[0].querySelector('button');$('library-restore-results-close').click();
  $('library').querySelector('.library-remove').click();await $('confirm-removal').onclick();open($);
  assert.deepEqual(statuses($),['unavailable']);assert.equal(rows($)[0].querySelector('button').disabled,true);
  $('library-restore-results-close').click();await $('undo-removal').onclick();open($);
  assert.deepEqual(statuses($),['unavailable'],'undo uses its own restored identity, never rebind the old report');
  $('library-restore-results-close').click();await restore($,envelope([doc('reused')]));open($);assert.deepEqual(outcome($),['duplicate']);
  const title=$('title').textContent;old.onclick();assert.equal($('library-restore-results-dialog').open,true);assert.equal($('title').textContent,title);
  const live=w.libraryProbe.documents[0];w.libraryProbe.documents[0]={...live,title:'Replacement'};w.libraryProbe.renderLibrary();
  assert.deepEqual(statuses($),['unavailable']);assert.equal(rows($)[0].querySelector('button').disabled,true);
 }finally{await w.happyDOM.close();}
});

test('result opening is disabled while removal is pending and recovers after rollback',async()=>{
 const {w,$,pipeline}=libraryHarness([],{probe:true});let removing;
 try{
  await restore($,envelope([doc('keep')]));pipeline.hold();$('library').querySelector('.library-remove').click();removing=$('confirm-removal').onclick();await settle();
  open($);assert.ok(['unavailable','processing'].includes(statuses($)[0]));assert.equal(rows($)[0].querySelector('button').disabled,true);
  pipeline.writes[0].fail();await removing;assert.deepEqual(statuses($),['saved']);assert.equal(rows($)[0].querySelector('button').disabled,false);
 }finally{pipeline.hold(false);for(const write of pipeline.writes)write.fail();await removing;await w.happyDOM.close();}
});

test('newer accepted restore supersedes results, while cancelled, invalid and stale reads retain the last committed report',async()=>{
 const {w,$}=libraryHarness([],{probe:true}),read=deferred();let pending;
 try{
  await restore($,envelope([doc('first')]),{name:'first.json'});open($);const staleButton=rows($)[0].querySelector('button');
  pending=restore($,envelope([doc('stale')]),{name:'stale.json',read:()=>read.promise});
  await restore($,envelope([doc('newer')]),{name:'newer.json'});assert.equal($('library-restore-results-file').textContent,'newer.json');
  assert.equal(w.document.activeElement,$('library-restore-results-heading'));
  read.resolve(JSON.stringify(envelope([doc('stale')])));await pending;assert.equal($('library-restore-results-file').textContent,'newer.json');
  staleButton.onclick();assert.equal($('library-restore-results-dialog').open,true);
  await restore($,{invalid:true},{name:'invalid.json'});assert.equal($('library-restore-results-file').textContent,'newer.json');
  $('library-restore-results-dialog').dispatchEvent(new w.Event('cancel',{cancelable:true}));
  assert.equal($('library-restore-results-dialog').open,false);assert.equal(w.document.activeElement,$('open-library-restore-results'));
  assert.deepEqual(stored(w).documents.map(item=>item.key),['first','newer']);
 }finally{read.resolve('{}');await pending;await w.happyDOM.close();}
});

test('result list is bounded, preserves all 61 outcomes across pages and is session-only on reload',async()=>{
 const {w,$}=libraryHarness([]);let saved;
 try{
  await restore($,envelope(Array.from({length:61},(_,index)=>doc('entry-'+index))));open($);
  assert.equal(rows($).length,25);assert.match($('library-restore-results-position').textContent,/1–25 \/ 61/);
  $('library-restore-results-next').click();assert.equal(rows($).length,25);assert.equal(rows($)[0].dataset.documentKey,'entry-25');
  $('library-restore-results-next').click();assert.equal(rows($).length,11);assert.equal($('library-restore-results-next').disabled,true);
  rows($).at(-1).querySelector('button').click();assert.equal(w.sessionStorage.getItem('coconut-reader-active-v1'),'entry-60');
  open($);assert.equal(rows($).length,11);$('library-restore-results-previous').click();assert.equal(rows($)[0].dataset.documentKey,'entry-25');
  saved=stored(w).documents;
 }finally{await w.happyDOM.close();}
 const reloaded=libraryHarness(saved);try{assert.equal(reloaded.$('open-library-restore-results').hidden,true);assert.equal(stored(reloaded.w).documents.length,61);}finally{await reloaded.w.happyDOM.close();}
});

test('collection-only restore is reachable without activating a transcript and protects any collection-name draft',async()=>{
 const collection=C.createReadingCollection({key:'collection',title:'Authored collected notes',items:[]}),{w,$}=libraryHarness([],{probe:true});
 try{
  await restore($,envelope([collection]));open($);assert.match(rows($)[0].textContent,/成果集/);rows($)[0].querySelector('button').click();
  assert.equal($('library-notebook').open,true);assert.equal($('collection-select').value,collection.key);assert.equal($('reader-workspace').hidden,true);
  $('collection-title').value='Unsubmitted title';$('notebook-close').click();open($);rows($)[0].querySelector('button').click();
  assert.equal($('library-restore-results-dialog').open,true);assert.match($('library-restore-results-feedback').textContent,/尚未提交/);assert.equal($('collection-title').value,'Unsubmitted title');
 }finally{await w.happyDOM.close();}
});

test('empty restore has an honest inspectable outcome and hostile titles are rendered as text',async()=>{
 const {w,$}=libraryHarness([]);
 try{
  await restore($,envelope([]));open($);assert.equal(rows($).length,0);assert.match(report($),/共 0 项/);$('library-restore-results-close').click();
  await restore($,envelope([doc('unsafe','<img src=x onerror=alert(1)>')]),{name:'<script>authored.json</script>'});open($);
  assert.equal(rows($)[0].querySelector('.library-restore-result-title').textContent,'<img src=x onerror=alert(1)>');assert.equal($('library-restore-results-dialog').querySelector('img,script'),null);
 }finally{await w.happyDOM.close();}
});

// The production provider runs against a deterministic transaction double here;
// actual browser IndexedDB remains covered by its dedicated CI fixture.
test('production document provider reports actual atomic failure and durable retry, with independently verified reload',async()=>{
 const provider=require('../reader/storage-provider.js'),legacyModule=require('../reader/library-store.js'),documentModule=require('../reader/indexeddb-document-adapter.js'),engine=transactionDouble();
 const data=new Map([[legacyModule.KEY,JSON.stringify({documents:[doc('existing')],active:'existing'})]]);
 const storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
 const options={indexedDB:engine.indexedDB,getStorage:()=>storage,validate:C.validate,legacyModule,documentModule};
 const result=await provider.initialize(options),w=new Window({url:'https://coconut.example/'}),root=new URL('../',import.meta.url);
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/compatibility.html',root),'utf8').split('<body>')[1].split('</body>')[0];Object.defineProperty(w,'crypto',{value:webcrypto});
 w.fetch=()=>{throw Error('No network expected');};w.CoconutStorageBootstrap={phase:'ready',result};
 w.eval(['library-store','summary','core','passages','passage-playback','app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
 const $=id=>w.document.getElementById(id);
 try{
  engine.control.failMutation=3;
  await restore($,envelope([doc('existing'),doc('new-a'),doc('new-b')]));open($);
  assert.deepEqual(statuses($),['saved','failed','failed']);assert.equal(engine.rows(provider.NAME).get('documents').size,1);
  const beforeRetry=await provider.initialize(options);assert.deepEqual(beforeRetry.loaded.documents.map(item=>item.key),['existing']);
  await $('library-restore-results-retry').onclick();assert.deepEqual(statuses($),['saved','saved','saved']);
  const reloaded=await provider.initialize(options);assert.deepEqual(reloaded.loaded.documents.map(item=>item.key),['existing','new-a','new-b']);
  assert.deepEqual(clone(reloaded.loaded.documents[2]),clone(doc('new-b')));
 }finally{await w.happyDOM.close();}
});
