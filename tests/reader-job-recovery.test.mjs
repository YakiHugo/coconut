// Compatibility renderer regression; this suite is not default React acceptance.
/** Authored API fixtures only; no real import jobs, network, media or providers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';
import {transactionDouble} from './helpers/indexeddb-transaction-double.mjs';
import {Window} from 'happy-dom';
import {installSavePipeline} from './helpers/save-pipeline.mjs';
const root=new URL('../',import.meta.url),KEY='coconut-reader-v1',A='a'.repeat(32),B='b'.repeat(32);
const warning='Local playback download unavailable; use the original source link';
const source=(id,recovered=false,text='An authored recovery passage.')=>({title:'Same authored title',language:'en',source_url:'https://x.com/example/status/123',provenance:{kind:'original_subtitles',...(!recovered?{playback_warning:warning}:{})},...(recovered?{source_media:{job_id:id,kind:'video'}}:{}),segments:[{id:'cue',start:0,end:4,text}]});
const json=data=>({ok:true,json:async()=>data});
const copy=value=>JSON.parse(JSON.stringify(value));
function deferred(){let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};}
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,0));}assert.ok(check(),'asynchronous checkpoint reached');}
async function setup(stored){
 const w=new Window({url:'http://127.0.0.1:8080/'}),$=id=>w.document.getElementById(id),statuses=new Map([[A,'done'],[B,'done']]),documents=new Map([[A,source(A)],[B,source(B)]]),responses=new Map(),failures=new Set(),calls=[];
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/compatibility.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:{subtle:{digest:(...args)=>webcrypto.subtle.digest(...args)},randomUUID:()=>webcrypto.randomUUID()}});
 if(stored)w.localStorage.setItem(KEY,stored);
 w.fetch=async(url,options)=>{
  calls.push([url,options?.method]);
  if(url==='api/health')return json({local_worker:true});
  if(url==='api/jobs')return json({jobs:[A,B].map(id=>({id,title:'Same authored title',status:statuses.get(id),stage:statuses.get(id),playback_retryable:statuses.get(id)==='done'&&!documents.get(id).source_media}))});
  const match=/^api\/jobs\/([ab]{32})\/(result|retry|cancel)$/.exec(url);if(!match)throw Error('Unexpected fixture request '+url);
  const [,id,action]=match;
  if(action==='result'){if(failures.has(id))throw Error('Authored temporary failure');return responses.get(id)?.promise||json(copy(documents.get(id)));}
  statuses.set(id,action==='retry'?'queued':'cancelled');return json({id,status:statuses.get(id)});
 };
 const pipeline=installSavePipeline(w);
 w.eval(['summary','core','passages','passage-playback','app','language','podcasts','jobs'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+'\nwindow.jobRecovery={active,add,render,commitDocument};');
 await until(()=>$('jobs').children.length===2);
 let scrolls=0;$('title').scrollIntoView=()=>scrolls++;
 return {w,$,pipeline,statuses,documents,failures,calls,get scrolls(){return scrolls;},active:()=>w.jobRecovery.active(),docs:()=>JSON.parse(w.localStorage.getItem(KEY)).documents,
  action:(id,name)=>$('jobs').querySelector(`[data-job-id="${id}"] [data-job-action="${name}"]`).onclick(),refresh:()=>$('retry-worker').onclick(),
  hold(id){const gate=deferred();responses.set(id,gate);return ()=>{responses.delete(id);gate.resolve(json(copy(documents.get(id))));};},
  async recover(id=A){documents.set(id,source(id,true));statuses.set(id,'done');await this.refresh();},
  async add(doc){return w.jobRecovery.add(w.Coconut.validate(doc));},
 };
}
async function annotate(h){
 const doc=h.active();
 h.w.document.querySelector('.note-button').click();h.$('note').value='Retain my note';h.$('note').oninput();h.$('close-note').click();
 h.w.document.querySelector('.edit-button').click();h.$('edit-segment').value='My corrected passage';h.$('save-edit').click();
 doc.title='My renamed job';doc.language='fr';doc.readingPosition='cue';doc.segments[0].saved_excerpt=true;
 doc.segments[0].translations={zh:{text:'自写译文',source_text:doc.segments[0].text,provider:'user',source_language:'fr'}};
 doc.exact_excerpts=[h.w.Coconut.exactExcerptSnapshot(doc,doc.segments,[],0,2,{id:'authored-excerpt',createdAt:'2026-10-11T00:00:00.000Z'})];
 await h.w.jobRecovery.commitDocument(doc);return copy(doc);
}
function assertAnnotations(doc,before){for(const field of ['key','title','language','notes','segments','exact_excerpts','readingPosition'])assert.deepEqual(copy(doc[field]),before[field],field+' preserved');}
test('playback retry updates the same annotated job across restart without replacing content',async()=>{
 let h=await setup();try{
  await h.action(A,'open');const before=await annotate(h);h.$('show-jobs').click();await h.action(A,'retry');assert.equal(h.statuses.get(A),'queued');
  h.statuses.set(A,'failed');await h.refresh();await h.action(A,'retry');
  const stored=h.w.localStorage.getItem(KEY);await h.w.happyDOM.close();h=await setup(stored);await h.recover();await h.action(A,'open');
  assert.equal(h.docs().length,1);assertAnnotations(h.active(),before);assert.deepEqual(copy(h.active().source_media),{job_id:A,kind:'video'});assert.equal(h.active().provenance.playback_warning,undefined);
  const recovered=h.w.localStorage.getItem(KEY);await h.w.happyDOM.close();h=await setup(recovered);await h.recover();await h.action(A,'open');assert.equal(h.docs().length,1);assertAnnotations(h.active(),before);
 }finally{await h.w.happyDOM.close();}
});
test('different jobs with the same title and identical transcript never merge bindings',async()=>{
 const h=await setup();try{
  await h.action(A,'open');const a=h.active();h.$('show-jobs').click();await h.action(B,'open');assert.notEqual(h.active(),a);assert.equal(h.docs().length,2);
  await h.recover(A);await h.action(A,'open');assert.equal(h.active(),a);assert.equal(h.docs().length,2);assert.equal(h.docs().filter(d=>d.source_media?.job_id===A).length,1);
 }finally{await h.w.happyDOM.close();}
});
test('same job with changed original transcript does not overwrite its annotated previous draft',async()=>{
 const h=await setup();try{
  await h.action(A,'open');const before=await annotate(h);h.documents.set(A,source(A,true,'A genuinely different draft.'));await h.action(A,'open');
  assert.equal(h.docs().length,2);assert.notEqual(h.active().key,before.key);assertAnnotations(h.docs().find(d=>d.key===before.key),before);
 }finally{await h.w.happyDOM.close();}
});
test('ordinary imported edited job backup cannot acquire recovery ownership',async()=>{
 const h=await setup();try{
  await h.action(A,'open');const original=h.active(),edited=copy(original);edited.segments[0].text='A later externally edited draft';await h.add(edited);const draft=h.active();assert.notEqual(draft,original);assert.equal(draft.local_job_binding,undefined);
  await h.recover();await h.action(A,'open');assert.equal(h.active(),original);assert.equal(h.docs().length,2);assert.equal(draft.source_media,undefined);assert.equal(draft.segments[0].text,'A later externally edited draft');
 }finally{await h.w.happyDOM.close();}
});
for(const change of ['newer-job','different-library-entry','leave-and-return'])test(`late recovery refresh preserves newer navigation: ${change}`,async()=>{
 const h=await setup();try{
  await h.action(A,'open');const before=await annotate(h);h.$('show-jobs').click();await h.recover();const release=h.hold(A),pending=h.action(A,'open');
  if(change==='newer-job')await h.action(B,'open');
  else if(change==='different-library-entry')await h.add({title:'Newer file',segments:[{id:'other',start:0,end:1,text:'Another authored text'}]});
  else{h.$('back-reading').click();h.$('add-content').click();}
  const active=h.active(),workspace=h.w.document.body.dataset.workspace,scrolls=h.scrolls;h.$('notice').textContent='Newer feedback';release();await pending;
  assert.equal(h.active(),active);assert.equal(h.w.document.body.dataset.workspace,workspace);assert.equal(h.scrolls,scrolls);assert.equal(h.$('notice').textContent,'Newer feedback');
  const recovered=h.docs().find(d=>d.key===before.key);assertAnnotations(recovered,before);assert.equal(recovered.source_media.job_id,A);
 }finally{await h.w.happyDOM.close();}
});
test('recovery fetch failure leaves annotations intact and the next open can recover',async()=>{
 const h=await setup();try{
  await h.action(A,'open');const before=await annotate(h);await h.recover();h.failures.add(A);await h.action(A,'open');assert.equal(h.docs().length,1);assertAnnotations(h.active(),before);h.failures.delete(A);await h.action(A,'open');assert.equal(h.docs().length,1);assertAnnotations(h.active(),before);assert.equal(h.active().source_media.job_id,A);
 }finally{await h.w.happyDOM.close();}
});

test('an older missing-playback result cannot downgrade a recovered persisted job',async()=>{
 let h=await setup();try{
  await h.action(A,'open');await h.recover();await h.action(A,'open');const stored=h.w.localStorage.getItem(KEY),key=h.active().key;
  await h.w.happyDOM.close();h=await setup(stored); // This fixture returns the older warning-only snapshot.
  await h.action(A,'open');assert.equal(h.docs().length,1);assert.equal(h.active().key,key);assert.equal(h.active().source_media.job_id,A);assert.equal(h.active().provenance.playback_warning,undefined);
 }finally{await h.w.happyDOM.close();}
});
test('removing an annotated job while its playback recovery loads prevents resurrection',async()=>{
 const h=await setup();try{
  await h.action(A,'open');const before=await annotate(h);h.$('show-jobs').click();await h.recover();const release=h.hold(A),pending=h.action(A,'open');
  h.$('library').querySelector(`[data-document-key="${before.key}"] .library-remove`).click();await h.$('confirm-removal').onclick();release();await pending;
  assert.equal(h.docs().length,0);assert.equal(h.active(),undefined);
 }finally{await h.w.happyDOM.close();}
});
test('held recovery save fails CAS instead of overwriting a newer window annotation',async()=>{
 const h=await setup();let second;try{
  await h.action(A,'open');await annotate(h);second=await setup(h.w.localStorage.getItem(KEY));
  await h.recover();h.pipeline.hold();const pending=h.action(A,'open');await until(()=>h.pipeline.writes.length===1);
  second.active().notes.cue='Newer note from another window';await second.w.jobRecovery.commitDocument(second.active());
  const newer=second.w.localStorage.getItem(KEY);h.w.localStorage.setItem(KEY,newer);h.pipeline.hold(false);h.pipeline.writes[0].commit();await pending;
  assert.equal(h.w.localStorage.getItem(KEY),newer);assert.equal(h.docs()[0].notes.cue,'Newer note from another window');assert.equal(h.$('save-status').dataset.state,'failed');assert.equal(h.pipeline.store.status(h.active().key).error.code,'conflict');
  assert.equal(h.active().source_media.job_id,A,'unsaved recovery remains available locally');
 }finally{await h.w.happyDOM.close();await second?.w.happyDOM.close();}
});
test('new annotation while recovery save is held survives its final queued save',async()=>{
 const h=await setup();try{
  await h.action(A,'open');await h.recover();h.pipeline.hold();const pending=h.action(A,'open');await until(()=>h.pipeline.writes.length===1);
  h.w.document.querySelector('.note-button').click();h.$('note').value='Written during recovery';h.$('note').oninput();h.$('close-note').click();
  h.pipeline.hold(false);h.pipeline.writes[0].commit();await pending;await h.w.flushContentForTest();assert.equal(h.docs()[0].notes.cue,'Written during recovery');assert.equal(h.docs()[0].source_media.job_id,A);assert.equal(h.docs().length,1);
 }finally{await h.w.happyDOM.close();}
});

test('task binding survives IndexedDB migration/reload and same-key CAS protects annotations',async()=>{
 const h=await setup();let raw,key,binding;try{await h.action(A,'open');await annotate(h);raw=h.w.localStorage.getItem(KEY);key=h.active().key;binding=copy(h.active().local_job_binding);}finally{await h.w.happyDOM.close();}
 const require=createRequire(import.meta.url),provider=require('../reader/storage-provider.js'),legacyModule=require('../reader/library-store.js'),documentModule=require('../reader/indexeddb-document-adapter.js'),Coconut=require('../reader/core.js');
 const values=new Map([[KEY,raw]]),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)},engine=transactionDouble();
 const initialize=()=>provider.initialize({indexedDB:engine.indexedDB,getStorage:()=>storage,validate:Coconut.validate,legacyModule,documentModule});
 const first=await initialize(),second=await initialize();assert.equal(first.backend,'indexeddb');assert.deepEqual(first.loaded.documents[0].local_job_binding,binding);assert.deepEqual(second.loaded.documents[0].local_job_binding,binding);
 const firstStore=legacyModule.create({adapter:first.adapter,getDocuments:()=>first.loaded.documents}),secondStore=legacyModule.create({adapter:second.adapter,getDocuments:()=>second.loaded.documents});
 const newer=first.loaded.documents[0],stale=second.loaded.documents[0];newer.notes.cue='Newer IndexedDB window annotation';firstStore.queueDocument(key,newer);assert.equal((await firstStore.flush()).ok,true);
 stale.source_media={job_id:A,kind:'video'};delete stale.provenance.playback_warning;secondStore.queueDocument(key,stale);assert.equal((await secondStore.flush()).ok,false);assert.equal(secondStore.status(key).error.code,'conflict');
 const reopened=await initialize();assert.equal(reopened.loaded.documents[0].notes.cue,'Newer IndexedDB window annotation');assert.deepEqual(reopened.loaded.documents[0].local_job_binding,binding);assert.equal(reopened.loaded.documents[0].source_media,undefined);
});

test('unbound edited legacy copies are retained without guessed job association',async()=>{
 let h=await setup();try{
  await h.action(A,'open');const before=await annotate(h);delete h.active().local_job_binding;await h.w.jobRecovery.commitDocument(h.active());const stored=h.w.localStorage.getItem(KEY);
  await h.w.happyDOM.close();h=await setup(stored);await h.recover();await h.action(A,'open');assert.equal(h.docs().length,2);
  const original=h.docs().find(doc=>doc.key===before.key);assertAnnotations(original,before);assert.equal(original.local_job_binding,undefined);assert.equal(original.source_media,undefined);
 }finally{await h.w.happyDOM.close();}
});

test('historical hash of an edited ordinary import cannot establish a job binding',async()=>{
 const h=await setup();try{
  await h.add(source(A));const before=await annotate(h);await h.action(A,'open');assert.equal(h.docs().length,2);assert.notEqual(h.active().key,before.key);
  const original=h.docs().find(doc=>doc.key===before.key);assertAnnotations(original,before);assert.equal(original.local_job_binding,undefined);assert.equal(h.active().local_job_binding.id,A);
 }finally{await h.w.happyDOM.close();}
});

test('late same-book recovery mounts paused media without replacing note editor or transcript',async()=>{
 const h=await setup();try{
  await h.action(A,'open');await annotate(h);h.$('show-jobs').click();await h.recover();const release=h.hold(A),pending=h.action(A,'open');h.$('back-reading').click();
  h.w.document.querySelector('.note-button').click();h.$('note').value='Draft while playback recovers';h.$('note').oninput();h.$('note').focus();
  const row=h.w.document.querySelector('.segment'),note=h.$('note'),focused=h.w.document.activeElement,hidden=h.$('episode-media').hidden,workspace=h.w.document.body.dataset.workspace,scrolls=h.scrolls;
  release();await pending;
  assert.equal(h.$('source-media').querySelector('video').getAttribute('src'),`/api/jobs/${A}/media`);assert.equal(h.$('source-media').querySelector('video').paused,true);
  assert.equal(h.$('episode-media').hidden,hidden);assert.equal(h.w.document.querySelector('.segment'),row);assert.equal(h.$('note'),note);assert.equal(note.value,'Draft while playback recovers');assert.equal(h.w.document.activeElement,focused);assert.equal(h.w.document.body.dataset.workspace,workspace);assert.equal(h.scrolls,scrolls);
  const control=h.$('toggle-reader-media'),full=h.$('reader-media-label'),short=h.$('reader-media-short-label'),player=h.$('source-media').querySelector('video');
  assert.ok(full&&short);assert.equal(control.getAttribute('aria-label'),'本地原声已就绪 · 打开回听');assert.equal(control.title,'本地原声已就绪 · 打开回听');assert.equal(full.textContent,'本地原声已就绪 · 打开回听');assert.equal(short.textContent,'原声');
  control.click();assert.equal(h.$('toggle-reader-media'),control);assert.equal(h.$('reader-media-label'),full);assert.equal(h.$('reader-media-short-label'),short);assert.equal(control.getAttribute('aria-expanded'),'true');assert.equal(control.getAttribute('aria-label'),'收起原声设置');assert.equal(h.$('source-media').querySelector('video'),player);assert.equal(player.paused,true);
 }finally{await h.w.happyDOM.close();}
});

test('late recovery does not replace a user-selected local attachment or change its position',async()=>{
 const h=await setup();try{
  await h.action(A,'open');h.w.URL.createObjectURL=()=> 'blob:http://127.0.0.1/authored-local';h.w.URL.revokeObjectURL=()=>{};
  h.$('attach-reader-media').click();Object.defineProperty(h.$('reader-media-file'),'files',{configurable:true,value:[{name:'authored.mp3',type:'audio/mpeg',size:10,slice:()=>({text:async()=> 'ID3 authored'})}]});await h.$('reader-media-file').onchange();
  const player=h.$('source-media').querySelector('audio');assert.ok(player);player.currentTime=2;const src=player.getAttribute('src');
  h.$('show-jobs').click();await h.recover();const release=h.hold(A),pending=h.action(A,'open');h.$('back-reading').click();release();await pending;
  assert.equal(h.$('source-media').querySelector('audio'),player);assert.equal(player.getAttribute('src'),src);assert.equal(player.currentTime,2);assert.equal(h.active().source_media.job_id,A);
 }finally{await h.w.happyDOM.close();}
});
