import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {createRequire} from 'node:module';
import {transactionDouble} from './helpers/indexeddb-transaction-double.mjs';
import {installSavePipeline} from './helpers/save-pipeline.mjs';
const root=new URL('../',import.meta.url),KEY='coconut-reader-v1';
const doc=title=>({title,language:'en',segments:[{id:'cue',start:0,end:3,text:'Authored source '+title}],notes:{cue:'Keep '+title}});
const file=(title,{name=title+'.json',text=JSON.stringify(doc(title)),size=100}={})=>({name,size,text:typeof text==='function'?text:async()=>text});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function until(predicate,timeoutMs=5000){
 const deadline=performance.now()+timeoutMs;
 while(!predicate()){
  assert.ok(performance.now()<deadline,'Expected the authored async checkpoint');
  await new Promise(resolve=>setTimeout(resolve,1));
 }
}
function releaseSaves(f){
 // Stop holding future writes before draining current ones: a failed wait may
 // precede async fingerprint admission, or releasing one receipt may queue more.
 f.saves.hold(false);for(const write of f.saves.writes)write.commit();
}
function setup({held=false,raw=null,storageResult=null,digestDelay=0}={}){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:{subtle:{digest:async(...args)=>{if(digestDelay)await new Promise(resolve=>setTimeout(resolve,digestDelay));return webcrypto.subtle.digest(...args);}}}});
 w.fetch=()=>{throw new Error('Transcript file imports must not send network requests');};if(raw)w.localStorage.setItem(KEY,raw);
 if(storageResult)w.CoconutStorageBootstrap={phase:'ready',result:storageResult};
 const saves=installSavePipeline(w,{held});
 w.eval(['summary','core','passages','passage-playback','app','language','translation-review','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+'\nwindow.multiTest={get documents(){return state.documents},get active(){return active()},get batch(){return transcriptImportBatch},set closing(value){readerClosing=value}};');
 const $=id=>w.document.getElementById(id),input=$('file');
 Object.defineProperty(input,'value',{configurable:true,writable:true,value:''});
 const choose=files=>{Object.defineProperty(input,'files',{configurable:true,value:files});input.value=files.map(f=>f.name).join(',');return input.onchange();};
 const rows=()=>[...$('transcript-import-list').children],statuses=()=>rows().map(row=>row.dataset.status);
 const stored=()=>JSON.parse(w.localStorage.getItem(KEY)||'{"documents":[]}');
 const drag=(type,{files=[],types=['Files'],relatedTarget=null,target=$('transcript-drop-target')}={})=>{
  const event=new w.Event(type,{bubbles:true,cancelable:true});
  Object.defineProperties(event,{dataTransfer:{value:{files,types,dropEffect:'none'}},relatedTarget:{value:relatedTarget}});
  target.dispatchEvent(event);return event;
 };
 const drop=files=>$('transcript-drop-target').ondrop({dataTransfer:{types:['Files'],files},preventDefault(){}});
 return {w,$,saves,choose,drop,drag,rows,statuses,stored};
}

test('native picker permits several transcripts while library restore remains single-file',async()=>{
 const f=setup();try{assert.equal(f.$('file').multiple,true);assert.equal(f.$('library-file').multiple,false);}finally{await f.w.happyDOM.close();}
});
test('mixed JSON SRT VTT continues after malformed, duplicate, oversized subtitle and library-backup files',async()=>{
 const f=setup();try{
  let oversizedRead=false;
  await f.choose([file('JSON'),file('broken',{text:'{'}),file('JSON'),file('字幕',{name:'字幕.srt',text:'1\n00:00:01,000 --> 00:00:03,000\nAuthored SRT\n'}),file('voice',{name:'voice.vtt',text:'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Ada>Authored VTT\n'}),file('library',{text:JSON.stringify({format:'coconut-library',version:1,documents:[],...doc('Never single')})}),file('huge',{name:'huge.srt',size:16*1024*1024,text:async()=>{oversizedRead=true;return '';} }),file('Last')]);
  assert.deepEqual(f.statuses(),['saved','failed','duplicate','saved','saved','failed','failed','saved']);
  assert.equal(oversizedRead,false);assert.equal(f.stored().documents.length,4);
  assert.equal(f.stored().documents[0].notes.cue,'Keep JSON');assert.equal(f.stored().documents.find(d=>d.title==='voice').segments[0].speaker,'Ada');
  assert.match(f.rows()[5].textContent,/恢复书架备份/);assert.match(f.rows()[6].textContent,/15 MiB/);
  assert.match(f.$('transcript-import-progress').textContent,/导入完成 · 8 \/ 8/);assert.equal(f.w.document.body.dataset.workspace,'add');
  f.rows()[3].querySelector('button').click();assert.equal(f.$('title').textContent,'字幕');assert.equal(f.w.document.body.dataset.workspace,'read');assert.equal(f.w.document.activeElement,f.$('reader-workspace'));assert.equal(f.$('transcript-import-results').closest('#add-workspace').hidden,true);
  const reload=setup({raw:f.w.localStorage.getItem(KEY)});try{assert.deepEqual(reload.stored(),f.stored());}finally{await reload.w.happyDOM.close();}
 }finally{await f.w.happyDOM.close();}
});
test('large JSON review can skip one file and retain earlier successes before continuing',async()=>{
 const f=setup();let pending;try{
  let read=false;pending=f.choose([file('First'),file('large',{size:51*1024*1024,text:async()=>{read=true;return '{}';}}),file('Third')]);
  await until(()=>f.$('large-backup-dialog').open);assert.equal(f.stored().documents.length,1);assert.match(f.$('large-backup-size').textContent,/large.json/);
  assert.deepEqual(f.statuses(),['saved','review','queued']);f.$('cancel-large-backup').click();await pending;
  assert.equal(read,false);assert.deepEqual(f.statuses(),['saved','skipped','saved']);assert.deepEqual(f.stored().documents.map(d=>d.title),['First','Third']);
 }finally{f.$('cancel-large-backup').click();await pending;await f.w.happyDOM.close();}
});
test('large JSON approval imports its complete payload and does not cap the whole batch',async()=>{
 const f=setup();let pending;try{
  pending=f.choose([file('large',{size:51*1024*1024}),file('Next')]);await until(()=>f.$('large-backup-dialog').open);f.$('continue-large-backup').click();await pending;
  assert.deepEqual(f.statuses(),['saved','saved']);assert.equal(f.stored().documents[0].notes.cue,'Keep large');
 }finally{f.$('cancel-large-backup').click();await pending;await f.w.happyDOM.close();}
});
test('stop during file read keeps saved results and never reads later files',async()=>{
 const f=setup(),gate=deferred();let pending,reads=0;try{
  pending=f.choose([file('First'),file('Slow',{text:()=>gate.promise}),file('Last',{text:async()=>{reads++;return JSON.stringify(doc('Last'));}})]);
  await until(()=>f.statuses()[1]==='reading');f.$('stop-transcript-import').click();gate.resolve(JSON.stringify(doc('Slow')));await pending;
  assert.equal(reads,0);assert.deepEqual(f.statuses(),['saved','cancelled','cancelled']);assert.deepEqual(f.stored().documents.map(d=>d.title),['First']);assert.equal(f.$('file').value,'');
 }finally{gate.resolve('{}');await pending;await f.w.happyDOM.close();}
});
test('each next read waits for durable receipt and stopping cannot erase an in-flight successful save',async()=>{
 const f=setup({held:true});let pending,secondRead=0;try{
  pending=f.choose([file('First'),file('Second',{text:async()=>{secondRead++;return JSON.stringify(doc('Second'));}})]);
  await until(()=>f.saves.writes.length===1);assert.equal(secondRead,0);assert.equal(f.stored().documents.length,0);assert.deepEqual(f.statuses(),['saving','queued']);
  f.$('stop-transcript-import').click();assert.match(f.$('transcript-import-progress').textContent,/等待当前文件确认/);assert.equal(f.rows()[0].querySelector('button').hidden,true);
  f.saves.writes[0].commit();await pending;assert.equal(secondRead,0);assert.deepEqual(f.statuses(),['saved','cancelled']);assert.equal(f.stored().documents[0].title,'First');
 }finally{releaseSaves(f);await pending;await f.w.happyDOM.close();}
});
for(const digestDelay of [0,100])test('quota failure preserves earlier receipts, keeps the unsaved identity and stops reads until explicit retry'+(digestDelay?' with a 100ms fingerprint delay':''),async()=>{
 const f=setup({held:true,digestDelay});let pending,thirdRead=0;try{
  pending=f.choose([file('First'),file('Second'),file('Third',{text:async()=>{thirdRead++;return JSON.stringify(doc('Third'));}})]);
  await until(()=>f.saves.writes.length===1);f.saves.writes[0].commit();await until(()=>f.saves.writes.length===2);f.saves.writes[1].fail();await pending;
  assert.deepEqual(f.statuses(),['saved','unsaved','cancelled']);assert.equal(thirdRead,0);assert.equal(f.stored().documents.length,1);assert.equal(f.w.multiTest.documents.length,2);assert.equal(f.$('export-unsaved-documents').hidden,false);
  f.saves.hold(false);await f.$('retry-save').onclick();assert.equal(f.stored().documents.length,2);assert.deepEqual(f.statuses(),['saved','saved','cancelled']);
 }finally{releaseSaves(f);await pending;await f.w.happyDOM.close();}
});
test('newer navigation during a pending write survives its receipt and prevents the remaining files',async()=>{
 const f=setup();let pending;try{
  await f.choose([file('Existing')]);f.$('add-content').click();f.saves.hold();pending=f.choose([file('First'),file('Never')]);await until(()=>f.saves.writes.length===1);
  f.$('back-reading').click();f.$('mode-transcript').click();f.w.document.querySelector('.note-button').click();f.$('note').value='A newer note';f.$('note').oninput();f.$('note').focus();
  f.saves.hold(false);f.saves.writes[0].commit();await pending;await f.w.flushContentForTest();
  assert.equal(f.$('title').textContent,'Existing');assert.equal(f.$('note').value,'A newer note');assert.equal(f.w.document.activeElement,f.$('note'));assert.deepEqual(f.statuses(),['saved','cancelled']);assert.equal(f.stored().documents.length,2);
 }finally{releaseSaves(f);await pending;await f.w.happyDOM.close();}
});
test('a newer file selection retires an old batch without clearing or overwriting its pending selection',async()=>{
 const f=setup(),old=deferred(),newer=deferred();let first,second;try{
  first=f.choose([file('Old',{text:()=>old.promise}),file('Old remaining')]);await until(()=>f.statuses()[0]==='reading');
  second=f.choose([file('New',{text:()=>newer.promise}),file('New remaining')]);old.resolve(JSON.stringify(doc('Old')));await first;
  assert.equal(f.$('file').value,'New.json,New remaining.json');assert.deepEqual(f.statuses(),['reading','queued']);assert.equal(f.stored().documents.length,0);
  newer.resolve(JSON.stringify(doc('New')));await second;assert.deepEqual(f.stored().documents.map(d=>d.title),['New','New remaining']);assert.equal(f.$('file').value,'');
 }finally{old.resolve('{}');newer.resolve('{}');await first;await second;await f.w.happyDOM.close();}
});
test('duplicate batch import cannot overwrite newer notes or source edits on the existing identity',async()=>{
 const f=setup();try{
  await f.choose([file('Existing')]);const existing=f.w.multiTest.active;
  f.$('mode-transcript').click();f.w.document.querySelector('.note-button').click();f.$('note').value='Latest note';f.$('note').oninput();
  f.$('source').click();f.$('source-url').value='https://youtu.be/jNQXAC9IVRw';await f.$('save-source').onclick({preventDefault(){}});f.$('add-content').click();
  await f.choose([file('Existing'),file('Next')]);assert.deepEqual(f.statuses(),['duplicate','saved']);assert.equal(f.w.multiTest.documents[0],existing);assert.equal(existing.notes.cue,'Latest note');assert.equal(existing.source_url,'https://youtu.be/jNQXAC9IVRw');
 }finally{await f.w.happyDOM.close();}
});
test('batch file names are rendered as text and a removed result cannot reopen an old identity',async()=>{
 const f=setup();try{
  await f.choose([file('First',{name:'<img src=x onerror=alert(1)>.json'}),file('Second')]);assert.equal(f.$('transcript-import-list').querySelector('img'),null);
  f.w.document.querySelector('.library-remove').onclick();await f.$('confirm-removal').onclick();assert.equal(f.w.multiTest.batch.items[0].identity,null,'results do not retain removed document payloads as a hidden archive');f.rows()[0].querySelector('button').click();assert.match(f.rows()[0].textContent,/已移除/);assert.equal(f.stored().documents.length,1);
 }finally{await f.w.happyDOM.close();}
});

// This is a deterministic transaction double; actual IndexedDB proof is CI-only.
test('production IndexedDB provider uses terminal per-file receipts and reload keeps partial success after quota',async()=>{
 const require=createRequire(import.meta.url),provider=require('../reader/storage-provider.js'),legacyModule=require('../reader/library-store.js'),documentModule=require('../reader/indexeddb-document-adapter.js'),Coconut=require('../reader/core.js');
 const engine=transactionDouble(),values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
 const initialize=()=>provider.initialize({indexedDB:engine.indexedDB,getStorage:()=>storage,validate:Coconut.validate,legacyModule,documentModule});
 const result=await initialize();assert.equal(result.backend,'indexeddb');
 const f=setup({storageResult:result});let pending;try{
  engine.control.holdNextWrite=true;
  pending=f.choose([file('IDB first'),file('IDB quota'),file('IDB unstarted')]);await until(()=>engine.control.held.length===1);
  assert.deepEqual(f.statuses(),['saving','queued','queued']);assert.equal(engine.rows(provider.NAME).get('documents').size,0);
  engine.control.failMutation=1;engine.control.held.shift().complete();await pending;
  assert.deepEqual(f.statuses(),['saved','unsaved','cancelled']);assert.equal(engine.rows(provider.NAME).get('documents').size,1);
  const reload=await initialize();assert.deepEqual(reload.loaded.documents.map(d=>d.title),['IDB first']);reload.close?.();
  await f.$('retry-save').onclick();assert.deepEqual(f.statuses(),['saved','saved','cancelled']);assert.equal(engine.rows(provider.NAME).get('documents').size,2);
  assert.equal(values.has(KEY),false,'per-document success never rewrites legacy library');
 }finally{for(const held of engine.control.held)held.complete();await pending;await f.w.happyDOM.close();result.close?.();}
});

test('batch preserves removal tombstones for an old backup key without stopping unrelated valid files',async()=>{
 const f=setup(),gate=deferred();let pending;try{
  await f.choose([file('Removed')]);await f.choose([file('Keep active')]);
  const stale={...f.stored().documents[0],title:'Changed backup of removed document'};f.$('add-content').click();
  pending=f.choose([file('Stale',{text:()=>gate.promise}),file('Still valid')]);await until(()=>f.statuses()[0]==='reading');
  [...f.$('library').children].find(row=>row.querySelector('.library-title').textContent==='Removed').querySelector('.library-remove').onclick();await f.$('confirm-removal').onclick();
  gate.resolve(JSON.stringify(stale));await pending;
  assert.deepEqual(f.statuses(),['failed','saved']);assert.match(f.rows()[0].textContent,/导入已取消/);
  assert.deepEqual(f.stored().documents.map(d=>d.title),['Keep active','Still valid']);
 }finally{gate.resolve('{}');await pending;await f.w.happyDOM.close();}
});
test('batch has no aggregate byte budget beyond existing per-file review',async()=>{
 const f=setup();try{
  await f.choose(['One','Two','Three'].map(title=>file(title,{size:40*1024*1024})));
  assert.deepEqual(f.statuses(),['saved','saved','saved']);assert.equal(f.$('large-backup-dialog').open,false);assert.equal(f.stored().documents.length,3);
 }finally{await f.w.happyDOM.close();}
});
for(const action of ['stop','escape'])test(`large-file batch review ${action} stops remaining files while preserving saved results`,async()=>{
 const f=setup();let pending,reads=0;try{
  pending=f.choose([file('First'),file('Large',{size:51*1024*1024,text:async()=>{reads++;return '{}';}}),file('Never',{text:async()=>{reads++;return '{}';}})]);
  await until(()=>f.$('large-backup-dialog').open);assert.equal(f.$('cancel-large-backup').textContent,'跳过此文件');assert.equal(f.$('stop-large-backup-batch').hidden,false);
  if(action==='stop')f.$('stop-large-backup-batch').click();else f.$('large-backup-dialog').dispatchEvent(new f.w.Event('cancel',{cancelable:true}));
  await pending;assert.deepEqual(f.statuses(),['saved','cancelled','cancelled']);assert.equal(reads,0);assert.equal(f.stored().documents.length,1);assert.equal(f.$('large-backup-dialog').open,false);
 }finally{f.$('cancel-large-backup').click();await pending;await f.w.happyDOM.close();}
});

test('batch failure text follows the selected reading theme error palette',()=>{
 const css=fs.readFileSync(new URL('reader/style.css',root),'utf8');
 assert.match(css,/\.transcript-import-item\[data-status="failed"\][^{}]+\{ color: var\(--tone-error, #9a3e28\); \}/);
});


test('drop target owns only file drags, including protected empty file lists, and keeps nested highlighting stable',async()=>{
 const f=setup();try{
  const target=f.$('transcript-drop-target'),child=f.$('import');
  for(const types of [[],['text/plain'],['text/uri-list']])for(const type of ['dragenter','dragover','dragleave','drop']){
   assert.equal(f.drag(type,{types}).defaultPrevented,false);
   assert.equal(target.classList.contains('is-file-drag'),false);
  }
  assert.equal(f.drag('dragenter').defaultPrevented,true);
  const over=f.drag('dragover');assert.equal(over.defaultPrevented,true);assert.equal(over.dataTransfer.dropEffect,'copy');
  f.drag('dragenter',{target:child});f.drag('dragleave',{target:child,relatedTarget:target});
  assert.equal(target.classList.contains('is-file-drag'),true);
  f.drag('dragleave');assert.equal(target.classList.contains('is-file-drag'),false);
  f.drag('dragenter');f.drag('dragleave',{relatedTarget:child});assert.equal(target.classList.contains('is-file-drag'),true);
  f.drag('dragenter',{target:child});f.drag('dragleave',{relatedTarget:f.$('url')});assert.equal(target.classList.contains('is-file-drag'),false);
  assert.equal(f.drag('dragover',{target:f.w.document.body}).defaultPrevented,false,'no global navigation interception');
  f.drag('dragenter');f.w.dispatchEvent(new f.w.Event('pagehide'));assert.equal(target.classList.contains('is-file-drag'),false);
  let picks=0;f.$('file').click=()=>picks++;child.focus();child.click();assert.equal(picks,1);assert.equal(f.w.document.activeElement,child);
 }finally{await f.w.happyDOM.close();}
});
test('mixed unsupported drops reject before reading or retiring an active batch and render filenames as text',async()=>{
 const f=setup(),gate=deferred();let pending,reads=0;try{
  pending=f.choose([file('Held',{text:()=>gate.promise}),file('Next')]);await until(()=>f.statuses()[0]==='reading');
  const batch=f.w.multiTest.batch;
  await f.drop([file('Valid',{text:async()=>{reads++;return '{}';}}),file('unsupported',{name:'<img src=x>.mp3',text:async()=>{reads++;return '{}';}})]);
  assert.equal(reads,0);assert.equal(f.w.multiTest.batch,batch);assert.equal(batch.cancelled,false);assert.equal(f.stored().documents.length,0);
  assert.match(f.$('transcript-drop-status').textContent,/未导入任何文件.*<img src=x>.mp3/);assert.equal(f.$('transcript-drop-status').querySelector('img'),null);
  gate.resolve(JSON.stringify(doc('Held')));await pending;assert.deepEqual(f.statuses(),['saved','saved']);
 }finally{gate.resolve('{}');await pending;await f.w.happyDOM.close();}
});
test('drop shares ordering, malformed feedback, dedupe, subtitle sizes and large JSON review',async()=>{
 const f=setup();let pending,reads=0;try{
  pending=f.drop([file('First'),file('First'),file('Broken',{text:'{'}),file('Too big',{name:'Too big.srt',size:16*1024*1024,text:async()=>{reads++;return '';}}),file('Large',{size:51*1024*1024,text:async()=>{reads++;return '{}';}}),file('Captions',{name:'Captions.VTT',text:'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Ada>Local voice\n'})]);
  await until(()=>f.$('large-backup-dialog').open);assert.deepEqual(f.statuses(),['saved','duplicate','failed','failed','review','queued']);
  f.$('cancel-large-backup').click();await pending;
  assert.equal(reads,0);assert.deepEqual(f.statuses(),['saved','duplicate','failed','failed','skipped','saved']);
  assert.deepEqual(f.stored().documents.map(d=>d.title),['First','Captions']);assert.equal(f.stored().documents[1].segments[0].speaker,'Ada');
 }finally{f.$('cancel-large-backup').click();await pending;await f.w.happyDOM.close();}
});
test('drop uses the same durable receipt and stop ownership without reading later files',async()=>{
 const f=setup({held:true});let pending,reads=0;try{
  pending=f.drop([file('First'),file('Never',{text:async()=>{reads++;return '{}';}})]);await until(()=>f.saves.writes.length===1);
  assert.deepEqual(f.statuses(),['saving','queued']);assert.equal(f.stored().documents.length,0);f.$('stop-transcript-import').click();
  f.saves.writes[0].commit();await pending;assert.deepEqual(f.statuses(),['saved','cancelled']);assert.equal(reads,0);
 }finally{releaseSaves(f);await pending;await f.w.happyDOM.close();}
});
test('drop save failure stops remaining files and explicit retry updates its existing receipt',async()=>{
 const f=setup({held:true});let pending,reads=0;try{
  pending=f.drop([file('Pending'),file('Never',{text:async()=>{reads++;return '{}';}})]);await until(()=>f.saves.writes.length===1);f.saves.writes[0].fail();await pending;
  assert.deepEqual(f.statuses(),['unsaved','cancelled']);assert.equal(reads,0);assert.equal(f.stored().documents.length,0);
  f.saves.hold(false);await f.$('retry-save').onclick();assert.deepEqual(f.statuses(),['saved','cancelled']);assert.equal(f.stored().documents.length,1);
 }finally{releaseSaves(f);await pending;await f.w.happyDOM.close();}
});
test('drop admission obeys lifecycle locks before reads or cancelling an existing import',async()=>{
 const f=setup(),gate=deferred();let pending,reads=0;try{
  pending=f.choose([file('Held',{text:()=>gate.promise}),file('Next')]);await until(()=>f.statuses()[0]==='reading');const batch=f.w.multiTest.batch;
  f.w.multiTest.closing=true;await f.drop([file('Blocked',{text:async()=>{reads++;return '{}';}})]);
  assert.equal(reads,0);assert.equal(f.w.multiTest.batch,batch);assert.equal(batch.cancelled,false);assert.match(f.$('transcript-drop-status').textContent,/暂时无法导入/);
  assert.equal(f.drag('dragover').dataTransfer.dropEffect,'none');f.w.multiTest.closing=false;gate.resolve(JSON.stringify(doc('Held')));await pending;
 }finally{gate.resolve('{}');await pending;await f.w.happyDOM.close();}
});
test('new drop supersedes an old picker through the shared revision and single drop preserves picker activation',async()=>{
 const f=setup(),gate=deferred();let pending;try{
  pending=f.choose([file('Old',{text:()=>gate.promise}),file('Old remaining')]);await until(()=>f.statuses()[0]==='reading');
  await f.drop([file('New')]);gate.resolve(JSON.stringify(doc('Old')));await pending;
  assert.deepEqual(f.stored().documents.map(d=>d.title),['New']);assert.equal(f.$('title').textContent,'New');assert.equal(f.w.document.body.dataset.workspace,'read');
 }finally{gate.resolve('{}');await pending;await f.w.happyDOM.close();}
});


test('mixed directory drops reject before reading or replacing an active batch even with a transcript extension',async()=>{
 const f=setup(),gate=deferred();let pending,reads=0;try{
  pending=f.choose([file('Held',{text:()=>gate.promise}),file('Next')]);await until(()=>f.statuses()[0]==='reading');const batch=f.w.multiTest.batch;
  await f.$('transcript-drop-target').ondrop({preventDefault(){},dataTransfer:{types:['Files'],files:[file('Valid',{text:async()=>{reads++;return '{}';}}),file('Folder')],items:[{kind:'file',webkitGetAsEntry:()=>({isDirectory:true,name:'Folder.json'})}]}});
  assert.equal(reads,0);assert.equal(f.w.multiTest.batch,batch);assert.equal(batch.cancelled,false);assert.match(f.$('transcript-drop-status').textContent,/未导入任何文件.*文件夹.*Folder.json/);
  gate.resolve(JSON.stringify(doc('Held')));await pending;
 }finally{gate.resolve('{}');await pending;await f.w.happyDOM.close();}
});


test('rejected picker resets its own selection while a rejected drop preserves the active picker input',async()=>{
 const f=setup(),gate=deferred();let pending;try{
  pending=f.choose([file('Held',{text:()=>gate.promise}),file('Next')]);await until(()=>f.statuses()[0]==='reading');const batch=f.w.multiTest.batch;
  await f.drop([file('Wrong',{name:'wrong.mp3'})]);assert.equal(f.$('file').value,'Held.json,Next.json');
  await f.choose([file('Wrong',{name:'wrong.mp3'})]);assert.equal(f.$('file').value,'');assert.equal(f.w.multiTest.batch,batch);assert.equal(batch.cancelled,false);
  f.w.multiTest.closing=true;await f.choose([file('Blocked')]);assert.equal(f.$('file').value,'');f.w.multiTest.closing=false;
  gate.resolve(JSON.stringify(doc('Held')));await pending;
 }finally{gate.resolve('{}');await pending;await f.w.happyDOM.close();}
});
test('uninspectable dropped entries reject safely before any file reads',async()=>{
 const f=setup();let reads=0;try{
  await f.$('transcript-drop-target').ondrop({preventDefault(){},dataTransfer:{types:['Files'],files:[file('Valid',{text:async()=>{reads++;return '{}';}})],items:[{kind:'file',webkitGetAsEntry(){throw new Error('Unavailable entry');}}]}});
  assert.equal(reads,0);assert.match(f.$('transcript-drop-status').textContent,/未导入任何文件.*无法检查/);assert.equal(f.stored().documents.length,0);
 }finally{await f.w.happyDOM.close();}
});

function resumedTranscript({bookmark=900,cues=1000}={}){
 const segments=Array.from({length:cues},(_,index)=>({id:'resume-'+index,start:index*2,end:index*2+1,text:'Authored saved reading sentence '+index+'.'}));
 return {title:'Saved reading',language:'en',segments,notes:{},...(bookmark===null?{}:{readingPosition:'resume-'+bookmark})};
}
function assertResume(f,id){
 const cue=f.$('passage-body').querySelector(`[data-cue-id="${id}"]`);
 assert.ok(cue,'saved cue is mounted in the passage window');
 assert.equal(f.w.document.activeElement,cue.closest('.passage'),'saved passage receives focus');
 assert.equal(f.w.document.body.dataset.readingMode,'passages');
 assert.equal(f.w.multiTest.active.readingPosition,id,'opening does not rewrite the saved cue');
}
for(const entry of ['picker','drop','batch'])test(`${entry} saved JSON opens its late reading cue just like the library card without playback`,async()=>{
 const f=setup();let plays=0;f.w.HTMLMediaElement.prototype.play=function(){plays++;return Promise.resolve();};
 try{
  const saved=resumedTranscript(),input=file('Saved reading',{text:JSON.stringify(saved)});
  if(entry==='batch'){
   await f.choose([input,file('Other')]);assert.equal(f.w.document.body.dataset.workspace,'add');
   f.rows()[0].querySelector('button').click();
  }else await f[entry==='drop'?'drop':'choose']([input]);
  assertResume(f,'resume-900');
  const first=f.$('passage-body').firstElementChild.dataset.firstCueId;
  const last=f.$('passage-body').lastElementChild.dataset.firstCueId;
  [...f.$('library').querySelectorAll('.library-open')].find(button=>button.querySelector('.library-title').textContent==='Saved reading').click();
  assertResume(f,'resume-900');
  assert.equal(f.$('passage-body').firstElementChild.dataset.firstCueId,first);
  assert.equal(f.$('passage-body').lastElementChild.dataset.firstCueId,last);
  assert.equal(plays,0);assert.equal(f.stored().documents.find(d=>d.title==='Saved reading').readingPosition,'resume-900');
 }finally{await f.w.happyDOM.close();}
});
test('single JSON import resumes short transcripts in the cue view and preserves unbookmarked drafts',async()=>{
 const f=setup();try{
  await f.choose([file('Short',{text:JSON.stringify(resumedTranscript({bookmark:2,cues:4}))})]);
  assert.equal(f.w.document.body.dataset.readingMode,'transcript');
  assert.equal(f.w.document.activeElement.dataset.segmentId,'resume-2');
  for(const bookmark of [null,900]){
   await f.choose([file('Draft',{text:JSON.stringify({...resumedTranscript({bookmark,cues:4}),title:'Draft '+bookmark})})]);
   assert.equal(f.w.document.body.dataset.readingMode,'transcript','source-only drafts without a valid reading position open for reading');
   assert.equal(f.w.multiTest.active.readingPosition,undefined);
  }
 }finally{await f.w.happyDOM.close();}
});
test('single import resumes before its receipt and a late receipt cannot reclaim newer reading or focus',async()=>{
 const f=setup();let pending;try{
  await f.choose([file('Existing')]);f.saves.hold();
  pending=f.choose([file('Saved reading',{text:JSON.stringify(resumedTranscript())})]);
  await until(()=>f.saves.writes.length===1);assertResume(f,'resume-900');
  [...f.$('library').querySelectorAll('.library-open')].find(button=>button.querySelector('.library-title').textContent==='Existing').click();
  f.$('mode-transcript').click();f.w.document.querySelector('.note-button').click();f.$('note').focus();
  f.saves.hold(false);f.saves.writes[0].commit();await pending;
  assert.equal(f.$('title').textContent,'Existing');assert.equal(f.w.document.activeElement,f.$('note'));
  assert.equal(f.w.document.body.dataset.readingMode,'transcript');
 }finally{releaseSaves(f);await pending;await f.w.happyDOM.close();}
});


test('failed checkpoint cleanup releases writes admitted after the failure', {timeout:5000}, async()=>{
 const f=setup({held:true}),gate=deferred();let pending;
 try{
  pending=f.choose([file('Delayed',{text:()=>gate.promise}),file('Later')]);
  await assert.rejects(until(()=>f.saves.writes.length===1,20),/Expected the authored async checkpoint/);
  assert.equal(f.saves.writes.length,0,'failure occurs before any save admission');
  releaseSaves(f);gate.resolve(JSON.stringify(doc('Delayed')));await pending;
  assert.deepEqual(f.statuses(),['saved','saved']);assert.equal(f.stored().documents.length,2);
 }finally{releaseSaves(f);gate.resolve('{}');await pending;await f.w.happyDOM.close();}
});

const partialSubtitle='1\n00:00:00,000 --> 00:00:01,000\nOpening\n\n2\n00:00:01,000 -> 00:00:02,000\nCritical <img src=x onerror=alert(1)> sentence\n\n3\n00:00:02,000 --> 00:00:03,000\nClosing';
const partialFile=(title='Partial')=>file(title,{name:title+'.srt',text:partialSubtitle});
const warning=row=>row.querySelector('.transcript-import-warning');
function expandWarning(f,row){const details=warning(row);details.open=true;details.ontoggle();return details;}
test('normal partial normal batch keeps parse diagnostics orthogonal to saved receipts and untrusted previews',async()=>{
 const f=setup();try{
  await f.choose([file('Before'),partialFile(),file('After')]);
  assert.deepEqual(f.statuses(),['saved','saved','saved']);assert.deepEqual(f.rows().map(row=>row.dataset.parseState),['complete','partial','complete']);
  const details=expandWarning(f,f.rows()[1]);assert.match(details.textContent,/跳过 1 个字幕块/);assert.match(details.textContent,/第 5–7 行/);assert.match(details.textContent,/Critical <img/);assert.equal(details.querySelector('img'),null);
  assert.match(f.$('transcript-import-progress').textContent,/部分字幕未导入 1 块/);
  const saved=f.stored().documents.find(doc=>doc.title==='Partial');assert.equal(saved.segments.length,2);assert.equal(saved.diagnostics,undefined);assert.equal(saved.segments[1].text,'Closing');
  f.rows()[1].querySelector('button').click();assert.equal(f.$('title').textContent,'Partial');f.$('add-content').click();assert.equal(warning(f.rows()[1]),details);assert.equal(details.open,true);
 }finally{await f.w.happyDOM.close();}
});
for(const ingress of ['choose','drop'])test(ingress+' single partial result survives completion and ordinary single imports retain old experience',async()=>{
 const f=setup();try{
  await f[ingress]([partialFile()]);assert.deepEqual(f.statuses(),['saved']);assert.equal(f.w.document.body.dataset.workspace,'read');assert.match(f.$('notice').textContent,/部分字幕未导入.*添加内容/);
  f.$('add-content').click();assert.equal(f.$('transcript-import-results').hidden,false);assert.match(expandWarning(f,f.rows()[0]).textContent,/第 5–7 行/);
  await f[ingress]([file('Normal')]);assert.equal(f.$('transcript-import-results').hidden,true);assert.match(f.$('notice').textContent,/已导入并保存在本机/);
 }finally{await f.w.happyDOM.close();}
});
for(const multiple of [false,true])test('partial '+(multiple?'batch':'single')+' warning survives pending, save failure and explicit retry',async()=>{
 const f=setup({held:true});let pending;try{
  pending=f.choose(multiple?[partialFile(),file('Never')]:[partialFile()]);await until(()=>f.saves.writes.length===1);
  assert.equal(f.rows()[0].dataset.status,'saving');const details=expandWarning(f,f.rows()[0]);assert.match(details.textContent,/第 5–7 行/);assert.doesNotMatch(f.rows()[0].querySelector('.transcript-import-outcome').textContent,/已保存/);
  f.saves.writes[0].fail();await pending;assert.equal(f.rows()[0].dataset.status,'unsaved');assert.equal(warning(f.rows()[0]),details);assert.equal(f.stored().documents.length,0);
  f.saves.hold(false);await f.$('retry-save').onclick();assert.equal(f.rows()[0].dataset.status,'saved');assert.equal(warning(f.rows()[0]),details);assert.equal(f.stored().documents[0].segments.length,2);
  if(multiple)assert.deepEqual(f.statuses(),['saved','cancelled']);
 }finally{releaseSaves(f);await pending;await f.w.happyDOM.close();}
});
test('duplicate partial import retains warning and does not duplicate or replace saved identity',async()=>{
 const f=setup();try{
  await f.choose([partialFile()]);const identity=f.w.multiTest.active;f.$('add-content').click();await f.choose([partialFile()]);assert.deepEqual(f.statuses(),['duplicate']);assert.equal(f.w.multiTest.active,identity);f.$('add-content').click();await f.choose([partialFile(),file('Next')]);
  assert.deepEqual(f.statuses(),['duplicate','saved']);assert.equal(f.w.multiTest.documents[0],identity);assert.match(expandWarning(f,f.rows()[0]).textContent,/第 5–7 行/);assert.equal(f.stored().documents.length,2);
 }finally{await f.w.happyDOM.close();}
});
test('cancel and newer navigation cannot erase a pending partial warning or steal the note editor',async()=>{
 const f=setup();let pending;try{
  await f.choose([file('Existing')]);f.$('add-content').click();f.saves.hold();pending=f.choose([partialFile(),file('Never')]);await until(()=>f.saves.writes.length===1);
  const details=expandWarning(f,f.rows()[0]);f.$('stop-transcript-import').click();assert.equal(warning(f.rows()[0]),details);
  f.$('back-reading').click();f.$('mode-transcript').click();f.w.document.querySelector('.note-button').click();f.$('note').value='Keep focus and edit';f.$('note').oninput();f.$('note').focus();
  f.saves.hold(false);f.saves.writes[0].commit();await pending;await f.w.flushContentForTest();
  assert.equal(f.$('title').textContent,'Existing');assert.equal(f.w.document.activeElement,f.$('note'));assert.equal(f.$('note').value,'Keep focus and edit');assert.deepEqual(f.statuses(),['saved','cancelled']);assert.equal(warning(f.rows()[0]),details);assert.match(details.textContent,/第 5–7 行/);
 }finally{releaseSaves(f);await pending;await f.w.happyDOM.close();}
});
test('late partial receipt cannot replace a newer import result or notice',async()=>{
 const f=setup({digestDelay:80});let pending;try{
  pending=f.choose([partialFile()]);await until(()=>f.rows()[0]?.dataset.status==='saving');const retired=f.w.multiTest.batch;
  await f.choose([file('New first'),file('New last')]);await pending;
  assert.deepEqual(f.statuses(),['saved','saved']);assert.equal(f.w.multiTest.batch.items.some(item=>item.diagnostics.length),false);assert.equal(retired.items[0].status,'cancelled');assert.match(warning(retired.items[0].row).textContent,/跳过 1/);assert.deepEqual(f.stored().documents.map(doc=>doc.title),['New first','New last']);
 }finally{await pending;await f.w.happyDOM.close();}
});
test('many warning line details expand in bounded batches without truncating access to later diagnostics',async()=>{
 const f=setup();try{
  const text='1\n00:00:00,000 --> 00:00:01,000\nKeep\n\n'+Array.from({length:103},(_,i)=>`${i+2}\n00:00:01,000 -> 00:00:02,000\nLost ${i}`).join('\n\n');
  await f.choose([file('Many',{name:'Many.srt',text})]);const details=expandWarning(f,f.rows()[0]);assert.equal(details.querySelectorAll('li').length,50);details.querySelector('button').click();assert.equal(details.querySelectorAll('li').length,100);details.querySelector('button').click();assert.equal(details.querySelectorAll('li').length,103);assert.equal(details.querySelector('button').hidden,true);
 }finally{await f.w.happyDOM.close();}
});
