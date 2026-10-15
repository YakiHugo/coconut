// Compatibility renderer regression; this suite is not default React acceptance.
/** Authored IndexedDB/DOM fixtures; no Electron, original user files or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';
import {Window} from 'happy-dom';
import {transactionDouble} from './helpers/indexeddb-transaction-double.mjs';
const require=createRequire(import.meta.url),provider=require('../reader/storage-provider.js'),legacy=require('../reader/library-store.js'),documents=require('../reader/indexeddb-document-adapter.js'),C=require('../reader/core.js');
const root=new URL('../',import.meta.url),clone=value=>JSON.parse(JSON.stringify(value));
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const source={version:1,kind:'audio',name:'Original.wav',size:64,last_modified:7,type:'audio/wav',fingerprint:'a'.repeat(64)};
const doc=(key='authored',extra={})=>({...C.validate({title:key,local_media_source:source,segments:[{id:'one',start:10,end:20,text:'Authored source'}],notes:{one:'Keep saved note'},...extra}),key});
function native(){
 const records=new Map(),calls=[],released=[];let gate=null,rememberGate=null;
 const id=owner=>JSON.stringify([owner.library,owner.key,owner.epoch,owner.source]);
 return {records,calls,released,get gate(){return gate;},set gate(value){gate=value;},get rememberGate(){return rememberGate;},set rememberGate(value){rememberGate=value;},bridge:{
  async reconcile(owners){calls.push(['reconcile',clone(owners)]);const live=new Set(owners.map(id));for(const key of records.keys())if(!live.has(key))records.delete(key);return {status:'reconciled',rememberedKeys:owners.filter(owner=>records.has(id(owner))).map(owner=>owner.key)};},
  async resolve(owner){calls.push(['resolve',clone(owner)]);if(gate)return gate.promise;const record=records.get(id(owner));return record?{status:'ready',token:'native-'+owner.key,url:'/api/local-media/native-'+owner.key,kind:'audio',name:owner.source.name,identity:record.identity}:{status:'not-remembered'};},
  async remember(owner,file,identity){calls.push(['remember',clone(owner),file,identity]);if(rememberGate)await rememberGate.promise;records.set(id(owner),{identity});return {status:'remembered'};},
  async forget(owner){calls.push(['forget',clone(owner)]);records.delete(id(owner));return {status:'forgotten'};},
  async release(token){released.push(token);return {status:'released'};}
 }};
}
async function setup({docs=[doc()],service=native(),engine=transactionDouble(),storage,legacyMode=false,seedRemembered=false,staticWeb=false}={}){
 storage??=new Map([[legacy.KEY,JSON.stringify({documents:docs,active:docs[0]?.key??null})]]);
 const getStorage=()=>({getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)});
 const result=await provider.initialize({indexedDB:legacyMode?null:engine.indexedDB,getStorage,validate:C.validate,legacyModule:legacy,documentModule:documents});assert.equal(result.ok,true);
 if(seedRemembered){const identity=await result.adapter.mediaLibraryIdentity();for(const item of (seedRemembered==='first'?result.loaded.documents.slice(0,1):result.loaded.documents)){const owner={key:item.key,epoch:result.adapter.documentEpoch(item.key),library:identity.identity,source:item.local_media_source};await service.bridge.remember(owner,{},'authored-identity');}service.calls.length=0;}
 const w=new Window({url:'http://127.0.0.1:47831/'}),created=[],revoked=[];
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/compatibility.html',root),'utf8').split('<body>')[1].split('</body>')[0];Object.defineProperty(w,'crypto',{value:webcrypto});
 w.fetch=async()=>{throw new Error('No network');};if(!staticWeb)w.coconutLocalMedia=service.bridge;w.CoconutStorageBootstrap={phase:'ready',result};
 w.URL.createObjectURL=file=>{const value='blob:fixture-'+created.length;created.push({file,value});return value;};w.URL.revokeObjectURL=value=>revoked.push(value);
 w.eval(fs.readFileSync(new URL('reader/library-store.js',root),'utf8'));
 w.eval(['summary','core','passages','passage-playback','app'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+`\nwindow.referenceTest={active:()=>active(),docs:()=>state.documents,attachment:()=>browserMedia.get(active()?.key),owner:doc=>rememberedMediaOwner(doc),entry:doc=>rememberedMediaStates.get(doc),flush:()=>libraryStore.flush(),render:()=>render(),commit:doc=>commitDocument(doc),select:key=>{resetReaderForDocumentNavigation();selectActiveDocument(key);workspace='read';render();},replace:()=>{const old=active();state.documents[state.documents.indexOf(old)]={...old};render();},supplement:async()=>{const original=active();return attachTranscriptToProject(Coconut.validate({title:'Authored supplement',segments:[{id:'new',start:0,end:4,text:'A genuine authored cue'}]}),{key:original.key,document:original,source:projectSourceSnapshot(original)});},retire:doc=>retireRememberedMedia(doc),remove:()=>requestLibraryRemoval(active()),removeKey:key=>requestLibraryRemoval(state.documents.find(doc=>doc.key===key)),manual:()=>{browserMedia.set(active().key,{url:'blob:manual',kind:'audio',name:'manual',identity:'manual',origin:'local'});render();},store:libraryStore};`);
 const env={w,engine,storage,result,service,created,revoked,$:id=>w.document.getElementById(id)};await settle();return env;
}
async function close(env){if(!env)return;env.service.gate?.resolve({status:'not-remembered'});env.service.rememberGate?.resolve();await settle();await env.w.happyDOM.close();}
function selectedFile(w){return new w.File(['RIFF authored local audio'],'Selected.wav',{type:'audio/wav',lastModified:7});}
async function pick(env,action='open-local-media'){
 const file=selectedFile(env.w),input=env.$(action==='open-local-media'?'local-media-file':'reader-media-file');
 env.$(action).click();Object.defineProperty(input,'files',{configurable:true,value:[file]});await input.onchange();await settle();return file;
}
async function optIn(env){env.$('remember-local-media-choice').checked=true;await env.$('remember-local-media-choice').onchange();await settle();}
function ready(token='late'){return {status:'ready',token,url:'/api/local-media/'+token,kind:'audio',name:'Original.wav',identity:'authored-identity'};}

test('default off requires selected File and committed project; opt-in stays private and exact identity survives reload',async()=>{
 const env=await setup({docs:[]});let fresh;
 try{
  const file=await pick(env),current=env.w.referenceTest.active();assert.equal(env.$('remember-local-media-choice').checked,false);assert.equal(env.$('remember-local-media-choice').disabled,false);assert.equal(env.service.calls.filter(call=>call[0]==='remember').length,0);
  await optIn(env);assert.equal(env.$('remember-local-media-choice').checked,true);const remember=env.service.calls.find(call=>call[0]==='remember');assert.equal(remember[2],file);assert.equal(remember[1].key,current.key);assert.equal(remember[1].epoch,1);assert.match(remember[1].library,/^[a-f0-9-]{36}$/);assert.equal(remember[3],env.w.referenceTest.attachment().identity);
  const portable=JSON.stringify(C.validate(clone(current)));assert.doesNotMatch(portable,/nativeToken|library|path|blob:|file-candidate/);
  fresh=await setup({engine:env.engine,storage:env.storage,service:env.service});assert.ok(fresh.w.document.querySelector('#source-media audio'));assert.equal(fresh.w.document.querySelector('#source-media audio').paused,true);assert.equal(fresh.w.document.querySelector('#source-media audio').currentTime,0);assert.equal(fresh.w.referenceTest.attachment().identity,remember[3]);assert.equal(fresh.w.referenceTest.active().key,current.key);
 }finally{await close(env);await close(fresh);}
});

test('native restore keeps drafts and collapsed settings; continue-listening is the sole seek',async()=>{
 const service=native(),gate=deferred();service.gate=gate;const env=await setup({service});
 try{
  const current=env.w.referenceTest.active();env.w.localStorage.setItem('coconut-listening-v1:'+current.key,JSON.stringify({version:1,identity:'authored-identity',time:25,duration:60}));
  env.$('note').value='unsaved note draft';const collapsed=env.$('episode-media').hidden;
  gate.resolve(ready());await settle();const player=env.w.document.querySelector('#source-media audio');assert.ok(player);assert.equal(player.paused,true);assert.equal(player.currentTime,0);assert.equal(env.$('note').value,'unsaved note draft');assert.equal(env.$('episode-media').hidden,collapsed);
  Object.defineProperty(player,'duration',{configurable:true,value:60});player.dispatchEvent(new env.w.Event('loadedmetadata'));assert.equal(env.$('resume-listening').hidden,false);assert.equal(player.currentTime,0);env.$('resume-listening').click();assert.equal(player.currentTime,25);assert.equal(player.paused,true);
 }finally{await close(env);}
});

for(const action of ['navigation','new-document-object','manual-selection','temporary-detach'])test('late native resolution cannot own '+action,async()=>{
 const service=native(),gate=deferred();service.gate=gate;const env=await setup({docs:[doc(),doc('other')],service});
 try{
  if(action==='navigation')env.w.referenceTest.select('other');
  if(action==='new-document-object')env.w.referenceTest.replace();
  if(action==='manual-selection')env.$('attach-reader-media').click();
  if(action==='temporary-detach'){
   // A newer manual attachment owns the session before this old resolve ends.
   const current=env.w.referenceTest.active();env.w.referenceTest.manual();env.$('detach-reader-media').click();
  }
  service.gate=null;gate.resolve(ready());await settle();assert.ok(service.released.includes('late'));assert.notEqual(env.w.referenceTest.attachment()?.nativeToken,'late');
 }finally{await close(env);}
});

test('temporary detach suppresses auto-reattach, forget retains current media and never removes source or notes',async()=>{
 const env=await setup({seedRemembered:true});try{
  const current=env.w.referenceTest.active(),before=JSON.stringify(C.validate(clone(current)));assert.ok(env.w.referenceTest.attachment());
  await env.$('forget-local-media').onclick();assert.equal(env.service.records.size,0);assert.ok(env.w.referenceTest.attachment());assert.equal(JSON.stringify(C.validate(clone(current))),before);
  const count=env.service.calls.filter(call=>call[0]==='resolve').length;env.$('detach-reader-media').click();env.w.referenceTest.render();await settle();assert.equal(env.w.referenceTest.attachment(),undefined);assert.equal(env.service.calls.filter(call=>call[0]==='resolve').length,count);assert.equal(env.service.released.length,1);
 }finally{await close(env);}
});

for(const status of ['missing','changed','unavailable'])test(status+' reference preserves saved annotations and offers reselection',async()=>{
 const service=native();service.bridge.resolve=async owner=>{service.calls.push(['resolve',owner]);return {status};};const env=await setup({service});try{
  assert.equal(env.w.referenceTest.active().notes.one,'Keep saved note');assert.equal(env.w.document.querySelector('#source-media audio'),null);assert.match(env.$('remember-local-media-status').textContent,/重新选择|重试/);assert.equal(env.$('retry-remembered-media').hidden,false);
 }finally{await close(env);}
});

test('reference write failure is truthful and preserves selected media; content write failure never permits opt-in',async()=>{
 const env=await setup({docs:[]});try{
  env.engine.control.failMutation=1;await pick(env);assert.equal(env.$('remember-local-media-choice').disabled,true);assert.equal(env.service.calls.filter(call=>call[0]==='remember').length,0);assert.ok(env.w.referenceTest.attachment());
  env.engine.control.failMutation=null;await env.w.referenceTest.store.retry();await settle();env.service.bridge.remember=async()=>({status:'unavailable'});await optIn(env);assert.equal(env.$('remember-local-media-choice').checked,false);assert.match(env.$('remember-local-media-status').textContent,/暂时无法/);assert.ok(env.w.referenceTest.attachment());assert.equal(env.$('remember-local-media-choice').disabled,false);
 }finally{await close(env);}
});

test('successful removal retires reference and Undo gets a new lifetime without file; failed removal retains reference',async()=>{
 const env=await setup({seedRemembered:true});try{
  const current=env.w.referenceTest.active(),epoch=env.result.adapter.documentEpoch(current.key);env.w.referenceTest.remove();env.engine.control.failMutation=1;await env.$('confirm-removal').onclick();await settle();assert.equal(env.service.records.size,1);assert.equal(env.w.referenceTest.active(),current);
  env.engine.control.failMutation=null;env.w.referenceTest.remove();await env.$('confirm-removal').onclick();await settle();assert.equal(env.service.records.size,0);await env.$('undo-removal').onclick();await settle();assert.ok(env.result.adapter.documentEpoch(current.key)>epoch);assert.equal(env.w.referenceTest.attachment(),undefined);assert.equal(env.w.referenceTest.active().notes.one,'Keep saved note');
 }finally{await close(env);}
});

test('database reset or a fresh profile cannot inherit remembered reference even with same key/source/epoch',async()=>{
 const service=native(),env=await setup({service,seedRemembered:true});let fresh;
 try{const owner=env.w.referenceTest.owner(env.w.referenceTest.active());fresh=await setup({service,docs:[doc()]});assert.equal(fresh.w.referenceTest.owner(fresh.w.referenceTest.active()).epoch,owner.epoch);assert.notEqual(fresh.w.referenceTest.owner(fresh.w.referenceTest.active()).library,owner.library);assert.equal(fresh.w.referenceTest.attachment(),undefined);assert.equal(service.records.size,0);}finally{await close(env);await close(fresh);}
});

test('compatibility storage and static reader do not expose native opt-in or resolve files',async()=>{
 const env=await setup({legacyMode:true});try{assert.equal(env.$('remember-local-media').hidden,true);assert.equal(env.service.calls.length,0);}finally{await close(env);}
});

test('same-source versions keep distinct exact owners; only the opted-in project restores',async()=>{
 const env=await setup({docs:[doc(),doc('same-source-other')],seedRemembered:'first'});try{
  assert.ok(env.w.referenceTest.attachment());env.w.referenceTest.select('same-source-other');await settle();assert.equal(env.w.referenceTest.attachment(),undefined);assert.equal(env.$('remember-local-media-choice').checked,false);assert.equal(env.w.referenceTest.active().key,'same-source-other');assert.equal(env.service.records.size,1);
 }finally{await close(env);}
});

test('a newer explicit opt-in cannot be erased by cleanup of a stale remember response',async()=>{
 const env=await setup({docs:[]});try{
  await pick(env);const gate=deferred();env.service.rememberGate=gate;env.$('remember-local-media-choice').checked=true;const first=env.$('remember-local-media-choice').onchange();await settle();
  await pick(env);env.$('remember-local-media-choice').checked=true;const second=env.$('remember-local-media-choice').onchange();gate.resolve();env.service.rememberGate=null;await Promise.all([first,second]);await settle();
  assert.equal(env.service.records.size,1);assert.equal(env.$('remember-local-media-choice').checked,true);assert.deepEqual(env.service.calls.filter(call=>['remember','forget'].includes(call[0])).map(call=>call[0]),['remember','forget','remember']);
 }finally{await close(env);}
});

test('forget failure preserves the durable reference and current player for retry',async()=>{
 const env=await setup({seedRemembered:true});try{
  env.service.bridge.forget=async()=>({status:'unavailable'});await env.$('forget-local-media').onclick();assert.equal(env.service.records.size,1);assert.ok(env.w.referenceTest.attachment());assert.equal(env.$('forget-local-media').hidden,false);assert.match(env.$('remember-local-media-status').textContent,/暂时无法|本次已移除/);
 }finally{await close(env);}
});

test('plain static reader never calls a native reference bridge',async()=>{
 const env=await setup({staticWeb:true});try{assert.equal(env.$('remember-local-media').hidden,true);assert.equal(env.service.calls.length,0);}finally{await close(env);}
});


test('supplementing the same audio project preserves its settled remembered consent',async()=>{
 const env=await setup({docs:[doc('audio',{project_kind:'audio_only',segments:[]})],seedRemembered:true});try{
  const original=env.w.referenceTest.active(),owner=env.w.referenceTest.owner(original);await env.w.referenceTest.supplement();await settle();
  assert.notEqual(env.w.referenceTest.active(),original);assert.equal(env.w.referenceTest.active().key,original.key);assert.deepEqual(clone(env.w.referenceTest.owner(env.w.referenceTest.active())),clone(owner));assert.equal(env.$('remember-local-media-choice').checked,true);assert.equal(env.service.records.size,1);assert.ok(env.w.referenceTest.attachment());
 }finally{await close(env);}
});


test('pasting captions through the actual dialog retains settled native consent and player without another resolve',async()=>{
 const env=await setup({docs:[doc('audio',{project_kind:'audio_only',segments:[],project_note:'Native project note',timestamp_bookmarks:[{id:'keep',time:2,note:'Native bookmark'}]})],seedRemembered:true});try{
  const original=env.w.referenceTest.active(),owner=clone(env.w.referenceTest.owner(original)),attachment=env.w.referenceTest.attachment(),player=env.$('source-media').querySelector('audio'),calls=env.service.calls.length;
  player.currentTime=1.5;env.$('paste-project-subtitles').click();env.$('paste-subtitle-text').value='1\n00:00:00,125 --> 00:00:03,875\nAuthored native pasted words';env.$('paste-subtitle-text').dispatchEvent(new env.w.Event('input'));env.$('preview-paste-subtitle').click();await env.$('confirm-paste-subtitle').onclick();await settle();
  const attached=env.w.referenceTest.active();assert.equal(attached.key,original.key);assert.equal(attached.segments[0].text,'Authored native pasted words');assert.equal(attached.project_note,'Native project note');assert.equal(attached.timestamp_bookmarks[0].note,'Native bookmark');assert.deepEqual(clone(env.w.referenceTest.owner(attached)),owner);assert.equal(env.$('remember-local-media-choice').checked,true);assert.equal(env.service.records.size,1);assert.equal(env.w.referenceTest.attachment(),attachment);assert.equal(env.$('source-media').querySelector('audio'),player);assert.equal(player.currentTime,1.5);assert.equal(player.paused,true);assert.equal(env.service.calls.length,calls);
 }finally{await close(env);}
});


test('removing a never-visited remembered project retires its reference immediately',async()=>{
 const env=await setup({docs:[doc(),doc('unvisited')],seedRemembered:true});try{
  assert.equal(env.service.records.size,2);assert.equal(env.w.referenceTest.active().key,'authored');env.w.referenceTest.removeKey('unvisited');await env.$('confirm-removal').onclick();await settle();assert.equal(env.service.records.size,1);assert.equal(env.w.referenceTest.active().key,'authored');
  await env.$('undo-removal').onclick();env.w.referenceTest.select('unvisited');await settle();assert.equal(env.w.referenceTest.attachment(),undefined);
 }finally{await close(env);}
});

for(const cancel of ['cancel-event','empty-change'])test('canceling a chooser during native restore resumes the same exact project: '+cancel,async()=>{
 const service=native(),gate=deferred();service.gate=gate;const env=await setup({service,seedRemembered:true});try{
  env.$('attach-reader-media').click();service.gate=null;
  if(cancel==='cancel-event')env.$('reader-media-file').dispatchEvent(new env.w.Event('cancel'));
  else{Object.defineProperty(env.$('reader-media-file'),'files',{configurable:true,value:[]});await env.$('reader-media-file').onchange();}
  gate.resolve(ready('cancelled-late'));await settle();assert.equal(env.w.referenceTest.attachment()?.nativeToken,'native-authored');assert.ok(service.released.includes('cancelled-late'));assert.equal(env.w.document.querySelector('#source-media audio').paused,true);
 }finally{await close(env);}
});


for(const race of ['during-resolve','before-initialization'])test('real reselection preserves visible revocable earlier consent: '+race,async()=>{
 const service=native(),first=await setup({docs:[],service});let fresh;try{
  await pick(first);await optIn(first);const gate=deferred();service.gate=race==='during-resolve'?gate:null;
  let reconcileGate;if(race==='before-initialization'){
   reconcileGate=deferred();const original=service.bridge.reconcile;service.bridge.reconcile=async owners=>{await reconcileGate.promise;return original(owners);};
  }
  fresh=await setup({engine:first.engine,storage:first.storage,service});await pick(fresh,'attach-reader-media');
  if(reconcileGate)reconcileGate.resolve();else{service.gate=null;gate.resolve(ready('old-selection'));}
  await settle();assert.ok(fresh.w.referenceTest.attachment().file);assert.equal(service.records.size,1);assert.equal(fresh.$('remember-local-media-choice').checked,false);assert.equal(fresh.$('forget-local-media').hidden,false);assert.match(fresh.$('remember-local-media-status').textContent,/之前记住.*仍保留/);
  await fresh.$('forget-local-media').onclick();await settle();assert.equal(service.records.size,0);assert.equal(fresh.$('forget-local-media').hidden,true);assert.ok(fresh.w.referenceTest.attachment().file);
 }finally{await close(first);await close(fresh);}
});

test('an old native resolve cannot restore consent after a newer explicit Forget',async()=>{
 const service=native(),first=await setup({docs:[],service});let fresh;try{
  await pick(first);await optIn(first);const gate=deferred();service.gate=gate;fresh=await setup({engine:first.engine,storage:first.storage,service});await pick(fresh,'attach-reader-media');
  assert.equal(fresh.$('forget-local-media').hidden,false);await fresh.$('forget-local-media').onclick();service.gate=null;gate.resolve(ready('forgotten-late'));await settle();
  assert.equal(service.records.size,0);assert.equal(fresh.$('forget-local-media').hidden,true);assert.equal(fresh.$('remember-local-media-choice').checked,false);assert.ok(fresh.w.referenceTest.attachment().file);assert.ok(service.released.includes('forgotten-late'));
 }finally{await close(first);await close(fresh);}
});

for(const cancel of ['cancel-event','empty-change'])test('canceling a picker preserves earlier explicit detach suppression: '+cancel,async()=>{
 const env=await setup({seedRemembered:true});try{
  env.$('detach-reader-media').click();const calls=env.service.calls.filter(call=>call[0]==='resolve').length;env.$('attach-reader-media').click();
  if(cancel==='cancel-event')env.$('reader-media-file').dispatchEvent(new env.w.Event('cancel'));
  else{Object.defineProperty(env.$('reader-media-file'),'files',{configurable:true,value:[]});await env.$('reader-media-file').onchange();}
  await settle();assert.equal(env.w.referenceTest.attachment(),undefined);assert.equal(env.service.calls.filter(call=>call[0]==='resolve').length,calls);assert.equal(env.service.records.size,1);
 }finally{await close(env);}
});

test('explicit detach before native initialization settles cannot be undone by its late receipt',async()=>{
 const service=native(),first=await setup({docs:[],service});let fresh;try{
  await pick(first);await optIn(first);const gate=deferred(),original=service.bridge.reconcile;service.bridge.reconcile=async owners=>{await gate.promise;return original(owners);};
  fresh=await setup({engine:first.engine,storage:first.storage,service});await pick(fresh,'attach-reader-media');fresh.$('detach-reader-media').click();gate.resolve();await settle();
  assert.equal(fresh.w.referenceTest.attachment(),undefined);assert.equal(service.records.size,1);assert.match(fresh.$('remember-local-media-status').textContent,/本次已移除/);
 }finally{await close(first);await close(fresh);}
});

async function chooseReplacement(env,{fail=false,hold=false}={}){
 const pending=pick(env,'replace-reader-media');await settle();assert.equal(env.$('local-media-project-dialog').open,true);
 if(fail)env.engine.control.failMutation=1;if(hold)env.engine.control.holdNextWrite=true;
 env.$('local-media-current-project').click();return {pending};
}
async function rememberedTranscript(env){await pick(env);await env.w.referenceTest.supplement();await optIn(env);assert.equal(env.service.records.size,1);}

for(const saved of [true,false])test('explicit same-candidate replacement '+(saved?'retires old reference':'keeps old reference on content failure'),async()=>{
 const env=await setup({docs:[]});try{
  await rememberedTranscript(env);const {pending}=await chooseReplacement(env,{fail:!saved});await pending;await settle();
  assert.equal(env.service.records.size,saved?0:1);assert.equal(env.$('forget-local-media').hidden,saved);assert.ok(env.w.referenceTest.attachment().file);
 }finally{await close(env);}
});

test('same-candidate replacement blocks newer opt-in until old-reference cleanup has settled',async()=>{
 const env=await setup({docs:[]});try{
  await rememberedTranscript(env);const before=env.service.calls.filter(call=>call[0]==='remember').length;const {pending}=await chooseReplacement(env,{hold:true});await settle();assert.equal(env.engine.control.held.length,1);
  assert.equal(env.$('remember-local-media-choice').disabled,true);env.$('remember-local-media-choice').checked=true;await env.$('remember-local-media-choice').onchange();assert.equal(env.service.calls.filter(call=>call[0]==='remember').length,before);
  env.engine.control.held.shift().complete();await pending;await optIn(env);assert.equal(env.service.records.size,1);assert.equal(env.$('remember-local-media-choice').checked,true);
 }finally{for(const held of env.engine.control.held)held.complete();await close(env);}
});

test('replacement cleanup failure leaves prior reference visibly revocable instead of claiming it was removed',async()=>{
 const env=await setup({docs:[]});try{
  await rememberedTranscript(env);env.service.bridge.forget=async()=>({status:'unavailable'});const {pending}=await chooseReplacement(env);await pending;await settle();
  assert.equal(env.service.records.size,1);assert.equal(env.$('forget-local-media').hidden,false);assert.match(env.$('remember-local-media-status').textContent,/旧引用.*取消.*失败|旧引用.*未能取消/);assert.match(env.$('notice').textContent,/重启.*之前记住/);
 }finally{await close(env);}
});

test('Retry after a failed same-candidate replacement retires the old reference on its successful receipt',async()=>{
 const env=await setup({docs:[]});try{
  await rememberedTranscript(env);const {pending}=await chooseReplacement(env,{fail:true});await pending;assert.equal(env.service.records.size,1);assert.equal(env.$('remember-local-media-choice').disabled,true);
  env.engine.control.failMutation=null;assert.equal((await env.w.referenceTest.store.retry()).ok,true);await settle();assert.equal(env.service.records.size,0);assert.equal(env.$('remember-local-media-choice').disabled,false);assert.equal(env.$('forget-local-media').hidden,true);
 }finally{await close(env);}
});

test('a second replacement waiting behind old-reference cleanup keeps its newer attachment and opt-in',async()=>{
 const env=await setup({docs:[]});try{
  await rememberedTranscript(env);const gate=deferred(),forget=env.service.bridge.forget;env.service.bridge.forget=async owner=>{await gate.promise;return forget(owner);};
  const first=await chooseReplacement(env);await settle();const second=await chooseReplacement(env);await settle();const latest=env.w.referenceTest.attachment();assert.equal(env.$('remember-local-media-choice').disabled,true);
  gate.resolve();await Promise.all([first.pending,second.pending]);await settle();assert.equal(env.w.referenceTest.attachment(),latest);assert.equal(env.service.records.size,0);await optIn(env);assert.equal(env.service.records.size,1);assert.equal(env.$('remember-local-media-choice').checked,true);
 }finally{await close(env);}
});

test('navigation while replacement cleanup waits does not change newer feedback or discard local media',async()=>{
 const env=await setup({docs:[]});try{
  await rememberedTranscript(env);const current=env.w.referenceTest.active(),gate=deferred(),forget=env.service.bridge.forget;env.service.bridge.forget=async owner=>{await gate.promise;return forget(owner);};
  const {pending}=await chooseReplacement(env);await settle();const attachment=env.w.referenceTest.attachment();env.$('add-content').click();env.$('notice').textContent='Newer action feedback';gate.resolve();await pending;await settle();assert.equal(env.$('notice').textContent,'Newer action feedback');assert.equal(env.service.records.size,0);
  env.w.referenceTest.select(current.key);assert.equal(env.w.referenceTest.attachment(),attachment);
 }finally{await close(env);}
});

test('same-candidate replacement before initialization waits for and retires the old exact owner',async()=>{
 const service=native(),first=await setup({docs:[],service});let fresh;try{
  await rememberedTranscript(first);const gate=deferred(),reconcile=service.bridge.reconcile;service.bridge.reconcile=async owners=>{await gate.promise;return reconcile(owners);};
  fresh=await setup({engine:first.engine,storage:first.storage,service});const {pending}=await chooseReplacement(fresh);await settle();assert.equal(service.records.size,1);assert.equal(fresh.$('remember-local-media-choice').disabled,true);
  gate.resolve();await pending;await settle();assert.equal(service.records.size,0);assert.equal(fresh.$('forget-local-media').hidden,true);assert.ok(fresh.w.referenceTest.attachment().file);
 }finally{await close(first);await close(fresh);}
});

test('removal and Undo after failed replacement do not leave the new lifetime blocked by old cleanup',async()=>{
 const env=await setup({docs:[]});try{
  await rememberedTranscript(env);const {pending}=await chooseReplacement(env,{fail:true});await pending;env.engine.control.failMutation=null;
  env.w.referenceTest.remove();await env.$('confirm-removal').onclick();await env.$('undo-removal').onclick();await settle();
  await pick(env,'attach-reader-media');assert.equal(env.$('remember-local-media-choice').disabled,false);await optIn(env);assert.equal(env.service.records.size,1);
 }finally{await close(env);}
});

for(const cancel of ['cancel-event','empty-change'])test('picker opened during initialization holds restore and cancel resumes it: '+cancel,async()=>{
 const service=native(),first=await setup({docs:[],service});let fresh;try{
  await pick(first);await optIn(first);const gate=deferred(),reconcile=service.bridge.reconcile;service.bridge.reconcile=async owners=>{await gate.promise;return reconcile(owners);};
  fresh=await setup({engine:first.engine,storage:first.storage,service});fresh.$('attach-reader-media').click();gate.resolve();await settle();assert.equal(fresh.w.referenceTest.attachment(),undefined);
  if(cancel==='cancel-event')fresh.$('reader-media-file').dispatchEvent(new fresh.w.Event('cancel'));else{Object.defineProperty(fresh.$('reader-media-file'),'files',{configurable:true,value:[]});await fresh.$('reader-media-file').onchange();}
  await settle();assert.ok(fresh.w.referenceTest.attachment()?.nativeToken);assert.equal(fresh.w.document.querySelector('#source-media audio').paused,true);
 }finally{await close(first);await close(fresh);}
});

for(const detached of [false,true])test('navigation retires an open picker owner without changing prior detach: '+detached,async()=>{
 const service=native(),gate=deferred();service.gate=gate;const env=await setup({docs:[doc(),doc('other')],service,seedRemembered:true});try{
  const original=env.w.referenceTest.active();
  if(detached){env.w.referenceTest.manual();env.$('detach-reader-media').click();}
  env.$('attach-reader-media').click();const requests=service.calls.filter(call=>call[0]==='resolve').length;env.$('add-content').click();service.gate=null;gate.resolve(ready());await settle();assert.equal(service.calls.filter(call=>call[0]==='resolve').length,requests);
  env.w.referenceTest.select(original.key);await settle();assert.equal(Boolean(env.w.referenceTest.attachment()?.nativeToken),!detached);
 }finally{await close(env);}
});

for(const anotherProject of [false,true])test('new picker retires the previous picker owner before capturing its own: '+anotherProject,async()=>{
 const service=native(),gate=deferred();service.gate=gate;const env=await setup({docs:[doc('audio',{project_kind:'audio_only',segments:[]}),doc('second',{project_kind:'audio_only',segments:[]})],service,seedRemembered:true});try{
  const original=env.w.referenceTest.active();env.$('attach-reader-media').click();if(anotherProject)env.w.referenceTest.select('second');env.$('attach-reader-media').click();
  env.$('reader-media-file').dispatchEvent(new env.w.Event('cancel'));service.gate=null;gate.resolve(ready());await settle();if(anotherProject)env.w.referenceTest.select(original.key);await settle();assert.ok(env.w.referenceTest.attachment()?.nativeToken);
 }finally{await close(env);}
});

test('canceling a new picker resumes restore after it supersedes pending file inspection',async()=>{
 const service=native(),gate=deferred();service.gate=gate;const env=await setup({service,seedRemembered:true});const inspected=deferred(),chosen=selectedFile(env.w);try{
  const slow={name:chosen.name,type:chosen.type,size:chosen.size,lastModified:chosen.lastModified,slice:(start,end)=>{const part=chosen.slice(start,end);return start===0&&end===1024?{text:async()=>{await inspected.promise;return part.text();}}:part;}};
  env.$('attach-reader-media').click();Object.defineProperty(env.$('reader-media-file'),'files',{configurable:true,value:[slow]});const selection=env.$('reader-media-file').onchange();await settle();
  env.$('attach-reader-media').click();env.$('reader-media-file').dispatchEvent(new env.w.Event('cancel'));service.gate=null;gate.resolve(ready());inspected.resolve();await selection;await settle();assert.ok(env.w.referenceTest.attachment()?.nativeToken);
 }finally{inspected.resolve();await close(env);}
});

// Alignment coverage: native-only controls and tokens share the finalized dock
// transport. HappyDOM checks ownership and no-op writes, not native geometry.
for(const outcome of ['commit','abort'])test('remembered player keeps settled header and exact note through dock rewind and held '+outcome+' receipt',async()=>{
 const env=await setup({seedRemembered:true});try{
  const {w,$,engine}=env;let playCalls=0;const scrollCalls=[];
  $('mode-transcript').click();const player=$('source-media').querySelector('audio'),attachment=w.referenceTest.attachment();
  Object.defineProperties(player,{duration:{configurable:true,value:60},paused:{configurable:true,value:true}});player.play=async()=>{playCalls++;};
  player.currentTime=40;player.volume=.35;$('episode-media').getBoundingClientRect=()=>({bottom:-20});
  player.dispatchEvent(new w.Event('loadedmetadata'));player.playbackRate=1.5;await w.referenceTest.flush();await settle();
  w.document.querySelector('.segment .note-button').click();const note=$('note');note.value='  Native remembered note\n保留精确空白  ';note.dispatchEvent(new w.Event('input',{bubbles:true}));note.setSelectionRange(3,12);note.focus();
  engine.control.holdNextWrite=true;const saving=w.referenceTest.flush();await settle();assert.equal(engine.control.held.length,1);
  const rows=[...w.document.querySelectorAll('.segment')],documentBefore=JSON.stringify(w.referenceTest.active()),status=$('remember-local-media-status').textContent,statusNode=$('remember-local-media-status').firstChild,resume=$('resume-listening'),resumeParent=resume.parentElement;
  w.scrollTo=(...args)=>scrollCalls.push(['scrollTo',args]);w.scrollBy=(...args)=>scrollCalls.push(['scrollBy',args]);w.HTMLElement.prototype.scrollIntoView=function(...args){scrollCalls.push(['scrollIntoView',this.id,args]);};
  const mutations=[],observer=new w.MutationObserver(records=>mutations.push(...records));observer.observe($('remember-local-media'),{subtree:true,attributes:true,childList:true,characterData:true});
  $('dock-rewind').dispatchEvent(new w.PointerEvent('pointerdown',{bubbles:true}));$('dock-rewind').focus();$('dock-rewind').click();player.dispatchEvent(new w.Event('seeked'));
  assert.equal(player.currentTime,30);assert.equal(player.paused,true);assert.equal(player.playbackRate,1.5);assert.equal(player.volume,.35);assert.equal(playCalls,0);
  const held=engine.control.held.shift();outcome==='commit'?held.complete():held.abort();await saving;await settle();
  assert.equal($('source-media').querySelector('audio'),player);assert.equal(w.referenceTest.attachment(),attachment);assert.equal(attachment.nativeToken,'native-authored');assert.equal(w.document.activeElement,$('dock-rewind'));
  assert.equal($('note'),note);assert.equal(note.value,'  Native remembered note\n保留精确空白  ');assert.deepEqual([note.selectionStart,note.selectionEnd],[3,12]);assert.deepEqual([...w.document.querySelectorAll('.segment')],rows);assert.equal(JSON.stringify(w.referenceTest.active()),documentBefore);
  assert.equal($('remember-local-media-status').textContent,status);assert.ok($('remember-local-media-status').firstChild===statusNode,'settled remembered status preserves its text node');mutations.push(...observer.takeRecords());assert.equal(mutations.length,0,'settled remembered controls produce no mutations');observer.disconnect();
  assert.equal($('resume-listening'),resume);assert.equal(resume.parentElement,resumeParent);assert.deepEqual(scrollCalls,[]);assert.equal(env.service.records.size,1);
 }finally{for(const held of env.engine.control.held.splice(0))held.abort();await close(env);}
});

test('remembered ended player uses reserved resume row and remains dock-playable after Forget',async()=>{
 const env=await setup({seedRemembered:true});try{
  const {w,$}=env;$('mode-transcript').click();const player=$('source-media').querySelector('audio');
  Object.defineProperties(player,{duration:{configurable:true,value:60},paused:{configurable:true,value:true},ended:{configurable:true,get:()=>player.currentTime===60}});
  $('episode-media').getBoundingClientRect=()=>({bottom:-20});player.dispatchEvent(new w.Event('loadedmetadata'));player.currentTime=60;player.dispatchEvent(new w.Event('ended'));
  const resume=$('resume-listening'),parent=resume.parentElement;assert.equal(resume.hidden,true);$('dock-rewind').click();player.dispatchEvent(new w.Event('seeked'));assert.equal(player.currentTime,50);assert.equal(resume.hidden,false);assert.equal(resume.parentElement,parent);
  const css=fs.readFileSync(new URL('reader/style.css',root),'utf8');assert.match(css,/\.episode-media:has\(#source-media:not\(\[hidden\]\)\) \.listening-progress\s*\{[^}]*grid-template-rows: minmax\(44px, auto\) auto/);
  await $('forget-local-media').onclick();assert.equal(env.service.records.size,0);assert.equal($('source-media').querySelector('audio'),player);$('dock-rewind').click();assert.equal(player.currentTime,40);assert.equal(player.paused,true);assert.equal(env.service.released.length,0);assert.equal(w.referenceTest.active().notes.one,'Keep saved note');
 }finally{await close(env);}
});

// CPU structural/event contracts for the authored native journey. Native
// visibility, pointer trust and actual disk persistence remain CI gates.
test('audio-project JSON export is under its closed disclosure until the real summary opens it',async()=>{
 const env=await setup({docs:[]});try{
  await pick(env);const menu=env.$('export-menu'),button=env.$('export');
  assert.equal(menu.hidden,false);assert.equal(menu.open,false);assert.equal(button.closest('details'),menu);
  menu.querySelector('summary').click();assert.equal(menu.open,true);button.click();
  const blob=env.created.at(-1).file;assert.equal(blob.type,'application/json');assert.deepEqual(JSON.parse(await blob.text()),clone(env.w.referenceTest.active()));
 }finally{await close(env);}
});

test('a genuine opt-in click is unchecked while native consent is pending and checked only after its receipt',async()=>{
 const env=await setup({docs:[]});try{
  await pick(env);const choice=env.$('remember-local-media-choice'),gate=deferred();env.service.rememberGate=gate;
  assert.equal(choice.checked,false);assert.equal(choice.disabled,false);choice.click();
  assert.equal(choice.checked,false);assert.equal(choice.disabled,true);assert.match(env.$('remember-local-media-status').textContent,/正在处理/);assert.equal(env.service.records.size,0);
  gate.resolve();await settle();assert.equal(choice.checked,true);assert.equal(choice.disabled,false);assert.match(env.$('remember-local-media-status').textContent,/已在这台电脑记住/);assert.equal(env.service.records.size,1);
 }finally{await close(env);}
});
