/** All documents and AI responses here are authored fixtures, never user data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url),KEY='coconut-reader-v1';
const fixture=(title='Authored removal fixture')=>({title,language:'en',readingPosition:'cue',notes:{cue:'A private fixture note'},segments:[{id:'cue',start:0,end:5,text:'An authored correction.',original_text:'An authored original.',translations:{zh:{text:'自写译文',provider:'authored-fixture',source_text:'An authored correction.',source_language:'en',document_language:'en'}}}]});
function setup(stored){
 const w=new Window({url:'https://coconut.example/'});w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{configurable:true,value:webcrypto});if(stored)w.localStorage.setItem(KEY,stored);
 w.fetch=async()=>{throw new Error('No real network in authored fixtures');};
 w.eval(['summary','core','passages','passage-playback','app','language'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+'\nwindow.removalPlayback={listen:range=>passagePlayback.listen(range),cancel:()=>passagePlayback.cancel()};');
 return {w,$:id=>w.document.getElementById(id)};
}
async function add(w,doc=fixture()){
 const input=w.document.getElementById('file'),text=JSON.stringify(doc);Object.defineProperty(input,'files',{configurable:true,value:[{name:'authored.json',size:text.length,text:async()=>text}]});await input.onchange();
}
function request(w,title){const options=w.document.getElementById('library-options');options.open=true;options.dispatchEvent(new w.Event('toggle'));const row=[...w.document.querySelectorAll('.library-entry')].find(row=>row.textContent.includes(title));assert.ok(row);row.querySelector('.library-remove').click();}
function remove(w,title){request(w,title);w.document.getElementById('confirm-removal').click();}
function read(w){return JSON.parse(w.localStorage.getItem(KEY));}
function guard(w){const event=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(event);return event.defaultPrevented;}
async function download(w,id){let blob;w.URL.createObjectURL=value=>{blob=value;return 'blob:authored-fixture';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};w.document.getElementById(id).click();assert.ok(blob);return JSON.parse(await blob.text());}
for(const position of ['current','non-current','last'])test(`confirmed ${position} removal frees persisted capacity and undo restores the full document`,async()=>{
 const {w,$}=setup();try{
  await add(w);if(position!=='last')await add(w,fixture('Other authored fixture'));
  const title=position==='current'?'Other authored fixture':'Authored removal fixture';
  const before=read(w),original=before.documents.find(d=>d.title===title),bytes=w.localStorage.getItem(KEY).length;assert.equal(original.segments[0].translations.zh.text,'自写译文');
  request(w,title);assert.equal(w.document.activeElement,$('cancel-removal'));$('cancel-removal').click();assert.deepEqual(read(w),before);
  remove(w,title);assert.ok(w.localStorage.getItem(KEY).length<bytes);assert.ok(!read(w).documents.some(d=>d.key===original.key));
  assert.equal($('removal-recovery').hidden,false);assert.equal(guard(w),true);assert.match($('removal-recovery').textContent,/刷新、关闭或离开/);
  assert.deepEqual(await download(w,'export-removed-document'),original);
  assert.ok(!(await download(w,'export-library')).documents.some(d=>d.key===original.key));
  $('undo-removal').click();assert.deepEqual(read(w),before);assert.equal($('removal-recovery').hidden,true);assert.equal(guard(w),false);
  assert.equal(w.document.activeElement.className,'library-remove');
 }finally{await w.happyDOM.close();}
});
test('reload excludes removed content and cannot imply a persistent trash or recovery',async()=>{
 const {w,$}=setup();let reloaded;try{
  await add(w);remove(w,'Authored removal fixture');const stored=w.localStorage.getItem(KEY);assert.equal(read(w).documents.length,0);
  reloaded=setup(stored);assert.equal(reloaded.$('removal-recovery').hidden,true);assert.equal(reloaded.$('library-total').textContent,'0');assert.equal(guard(reloaded.w),false);
  assert.equal($('source-media').children.length,0);assert.equal($('reader-workspace').hidden,true);
 }finally{await w.happyDOM.close();await reloaded?.w.happyDOM.close();}
});
test('next confirmed removal replaces one slot only after clearly warning; cancellation and downloads retain it',async()=>{
 const {w,$}=setup();try{
  await add(w);await add(w,fixture('Second authored fixture'));remove(w,'Authored removal fixture');
  request(w,'Second authored fixture');assert.equal($('remove-document-dialog').open,true);assert.match($('replace-removal-warning').textContent,/Authored removal fixture/);assert.equal($('export-previous-removal').hidden,false);
  $('cancel-removal').click();assert.equal(read(w).documents.length,1);assert.equal((await download(w,'export-removed-document')).title,'Authored removal fixture');assert.equal(guard(w),true);
  remove(w,'Second authored fixture');assert.equal(read(w).documents.length,0);assert.equal((await download(w,'export-removed-document')).title,'Second authored fixture');
  $('finish-removal').click();$('cancel-finish-removal').click();assert.equal(guard(w),true);
  $('finish-removal').click();$('confirm-finish-removal').click();assert.equal(guard(w),false);assert.equal($('removal-recovery').hidden,true);
 }finally{await w.happyDOM.close();}
});
test('failed next removal leaves both the previous recovery slot and current shelf intact',async()=>{
 const {w,$}=setup();try{
  await add(w);await add(w,fixture('Second authored fixture'));remove(w,'Authored removal fixture');
  const before=w.localStorage.getItem(KEY),backing=w.localStorage;Object.defineProperty(w,'localStorage',{value:{getItem:k=>backing.getItem(k),setItem:()=>{throw Error('Injected quota');}}});
  remove(w,'Second authored fixture');assert.equal(backing.getItem(KEY),before);assert.equal((await download(w,'export-removed-document')).title,'Authored removal fixture');assert.equal($('library-total').textContent,'1');
 }finally{await w.happyDOM.close();}
});
test('failed removal rolls back both in-page and disk state',async()=>{
 const {w,$}=setup();try{
  await add(w);const before=w.localStorage.getItem(KEY),backing=w.localStorage;Object.defineProperty(w,'localStorage',{value:{getItem:k=>backing.getItem(k),setItem:()=>{throw Error('Injected quota');}}});
  remove(w,'Authored removal fixture');assert.equal(backing.getItem(KEY),before);assert.equal($('library-total').textContent,'1');assert.equal($('removal-recovery').hidden,true);assert.equal($('remove-document-dialog').open,true);assert.match($('remove-document-error').textContent,/未能保存/);
  assert.deepEqual(await download(w,'export-library'),{format:'coconut-library',version:1,...JSON.parse(before),active:w.sessionStorage.getItem('coconut-reader-active-v1')});
 }finally{await w.happyDOM.close();}
});
test('quota failure on undo retains full rescue data outside storage, permits export and later retry',async()=>{
 const {w,$}=setup();try{
  await add(w);const original=read(w).documents[0];remove(w,original.title);
  const backing=w.localStorage;let blocked=true;Object.defineProperty(w,'localStorage',{value:{getItem:k=>backing.getItem(k),setItem:(k,v)=>{if(blocked)throw Error('Injected quota');backing.setItem(k,v);}}});
  $('undo-removal').click();assert.equal(read(w).documents.length,0);assert.equal($('library-total').textContent,'0');assert.match($('notice').textContent,/撤销未成功/);assert.equal(guard(w),true);assert.deepEqual(await download(w,'export-removed-document'),original);
  blocked=false;$('undo-removal').click();assert.deepEqual(read(w).documents[0],original);assert.equal(guard(w),false);
 }finally{await w.happyDOM.close();}
});
test('another-tab conflict preserves its library and leaves the removal rescue exportable',async()=>{
 const {w,$}=setup();try{
  await add(w);remove(w,'Authored removal fixture');const replacement=JSON.stringify({documents:[],active:null,otherTab:true});w.localStorage.setItem(KEY,replacement);
  $('undo-removal').click();assert.equal(w.localStorage.getItem(KEY),replacement);assert.equal((await download(w,'export-removed-document')).title,'Authored removal fixture');assert.equal(guard(w),true);
 }finally{await w.happyDOM.close();}
});
for(const mode of ['question','subscription','offline'])test(`late ${mode} response cannot mutate or revive a removed document even after undo`,async()=>{
 const {w,$}=setup();let release;try{
  const source=fixture();source.segments[0].translations={};await add(w,source);let requests=0;
  w.fetch=async(url,options)=>{if(url.endsWith('language-tools'))return {ok:true,json:async()=>({local_translation:true,ai:{codex:{ready:true}}})};requests++;const payload=JSON.parse(options.body);await new Promise(resolve=>{release=resolve;});return {ok:true,json:async()=>mode==='question'?{answer:'Injected late answer',citations:['cue']}:{translations:payload.segments.map(cue=>({id:cue.id,source_text:cue.text,text:'迟到译文',provider:'fixture'}))}};};
  $('mode-transcript').click();$('language-panel').open=true;await $('check-ai').onclick();$('ai-task').value=mode==='question'?'question':'translation';$('ai-task').onchange();$('ai-question').value='What is this authored sentence?';$('ai-consent').checked=true;
  const run=$(mode==='question'?'ask-ai':mode==='subscription'?'subscription-translate':'translate-document').onclick();assert.equal(requests,1);
  remove(w,source.title);const rescue=await download(w,'export-removed-document');$('undo-removal').click();release();await run;
  assert.deepEqual(read(w).documents[0],rescue);assert.equal(requests,1);
 }finally{release?.();await w.happyDOM.close();}
});
test('pending local import cannot return after successful removal',async()=>{
 const {w,$}=setup();let release;try{
  await add(w);const input=$('file'),text=JSON.stringify(fixture('Late import'));Object.defineProperty(input,'files',{configurable:true,value:[{name:'late.json',size:text.length,text:()=>new Promise(resolve=>{release=()=>resolve(text);})}]});
  const pending=input.onchange();remove(w,'Authored removal fixture');release();await pending;assert.equal(read(w).documents.length,0);
 }finally{release?.();await w.happyDOM.close();}
});
test('current media is paused and pending media file validation cannot reattach after undo',async()=>{
 const {w,$}=setup();let release;try{
  await add(w);const audio=w.document.createElement('audio');let pauses=0;audio.pause=()=>{pauses++;};$('source-media').append(audio);
  $('attach-reader-media').click();const input=$('reader-media-file');Object.defineProperty(input,'files',{configurable:true,value:[{name:'authored.wav',type:'audio/wav',size:32,slice:()=>({text:()=>new Promise(resolve=>{release=()=>resolve('fixture');})})}]});
  const pending=input.onchange();remove(w,'Authored removal fixture');assert.ok(pauses>0);$('undo-removal').click();release();await pending;
  assert.equal($('source-media').children.length,0);assert.equal($('detach-reader-media').hidden,true);
 }finally{release?.();await w.happyDOM.close();}
});
test('late summary response cannot alter the rescue snapshot or restored summary job',async()=>{
 const {w,$}=setup();let release;try{
  await add(w);let requests=0;
  w.fetch=async(url)=>{if(url.endsWith('language-tools'))return {ok:true,json:async()=>({ai:{codex:{ready:true}}})};requests++;await new Promise(resolve=>{release=resolve;});return {ok:true,json:async()=>({answer:'Injected summary',citations:['cue']})};};
  await $('check-ai').onclick();$('ai-task').value='summary';$('ai-task').onchange();$('ai-consent').checked=true;
  const pending=$('ask-ai').onclick();assert.equal(requests,1);remove(w,'Authored removal fixture');const rescued=await download(w,'export-removed-document');$('undo-removal').click();release();await pending;
  assert.deepEqual(read(w).documents[0],rescued);
 }finally{release?.();await w.happyDOM.close();}
});
test('removing unrelated B does not silently cancel an in-progress new import A',async()=>{
 const {w,$}=setup();let release;try{
  await add(w,fixture('B to remove'));await add(w,fixture('Current source'));$('add-content').click();
  const input=$('file'),text=JSON.stringify(fixture('New unrelated A'));Object.defineProperty(input,'files',{configurable:true,value:[{name:'new-a.json',size:text.length,text:()=>new Promise(resolve=>{release=()=>resolve(text);})}]});
  const pending=input.onchange();remove(w,'B to remove');release();await pending;
  assert.deepEqual(read(w).documents.map(d=>d.title),['Current source','New unrelated A']);assert.equal((await download(w,'export-removed-document')).title,'B to remove');
 }finally{release?.();await w.happyDOM.close();}
});
for(const kind of ['single','library'])test(`pending ${kind} import of removed non-current B cannot resurrect B`,async()=>{
 const {w,$}=setup();let release;try{
  const doc=fixture('B to remove');await add(w,doc);const backup={format:'coconut-library',version:1,...read(w)};await add(w,fixture('Current source'));$('add-content').click();
  const input=$(kind==='single'?'file':'library-file'),text=JSON.stringify(kind==='single'?doc:backup);Object.defineProperty(input,'files',{configurable:true,value:[{name:'pending-b.json',size:text.length,text:()=>new Promise(resolve=>{release=()=>resolve(text);})}]});
  const pending=input.onchange();remove(w,'B to remove');release();await pending;
  assert.deepEqual(read(w).documents.map(d=>d.title),['Current source']);assert.match($('notice').textContent,/取消/);
 }finally{release?.();await w.happyDOM.close();}
});
for(const kind of ['single','library'])test(`late ${kind} import cannot resurrect a removed stable-key document via a different content hash`,async()=>{
 const B={...fixture('B edited stable key'),key:'stable-backup-key'},A={...fixture('A current'),key:'a'};
 const {w,$}=setup(JSON.stringify({documents:[B,A],active:'a'}));let release;try{
  const normalizedB=await download(w,'export-library').then(backup=>backup.documents[0]);$('add-content').click();
  const payload=kind==='single'?normalizedB:{format:'coconut-library',version:1,documents:[{...normalizedB,key:'another-alias'}],active:'another-alias'};
  const input=$(kind==='single'?'file':'library-file'),text=JSON.stringify(payload);Object.defineProperty(input,'files',{configurable:true,value:[{name:'alias.json',size:text.length,text:()=>new Promise(resolve=>{release=()=>resolve(text);})}]});
  const pending=input.onchange();remove(w,B.title);release();await pending;assert.deepEqual(read(w).documents.map(doc=>doc.title),[A.title]);assert.match($('notice').textContent,/取消/);
  // A fresh explicit import after removal remains permitted.
  await add(w,normalizedB);assert.equal(read(w).documents.length,2);
 }finally{release?.();await w.happyDOM.close();}
});
test('undo to another document pauses an already playing shared-path media player',async()=>{
 const source_media={job_id:'a'.repeat(32),kind:'audio'},B={...fixture('Fallback B'),key:'b',source_media},A={...fixture('Removed A'),key:'a',source_media};
 const {w,$}=setup(JSON.stringify({documents:[B,A],active:'a'}));try{
  w.dispatchEvent(new w.CustomEvent('coconut-worker-ready',{detail:{media_import:true}}));remove(w,A.title);
  const player=$('source-media').querySelector('audio');assert.ok(player);let paused=false,pauses=0;Object.defineProperty(player,'paused',{get:()=>paused});player.pause=()=>{paused=true;pauses++;};
  $('undo-removal').click();assert.equal(w.sessionStorage.getItem('coconut-reader-active-v1'),'a');assert.equal(paused,true);assert.ok(pauses>0);
 }finally{await w.happyDOM.close();}
});
test('undoing non-current B preserves Add and an unrelated pending import A',async()=>{
 const {w,$}=setup();let release;try{
  await add(w,fixture('B'));await add(w,fixture('Current'));$('add-content').click();remove(w,'B');
  const input=$('file'),text=JSON.stringify(fixture('Unrelated A'));Object.defineProperty(input,'files',{configurable:true,value:[{name:'a.json',size:text.length,text:()=>new Promise(resolve=>{release=()=>resolve(text);})}]});
  const pending=input.onchange();$('undo-removal').click();assert.equal($('add-workspace').hidden,false);release();await pending;assert.ok(read(w).documents.some(doc=>doc.title==='Unrelated A'));
 }finally{release?.();await w.happyDOM.close();}
});
test('local project attachment remains retired across non-current removal, undo and reopening',async()=>{
 const B={key:'b',title:'B audio project',project_kind:'audio_only',podcast_source:{kind:'direct_media',media_url:'https://example.org/audio.mp3',media_kind:'audio'},segments:[]},A={...fixture('A'),key:'a'};
 const {w,$}=setup(JSON.stringify({documents:[B,A],active:'b'}));let release;try{
  $('attach-project-transcript').click();const input=$('project-transcript-file'),text=JSON.stringify(fixture('Late attached transcript'));Object.defineProperty(input,'files',{configurable:true,value:[{name:'late.json',size:text.length,text:()=>new Promise(resolve=>{release=()=>resolve(text);})}]});
  const pending=input.onchange();w.document.querySelector('.library-entry[data-document-key="a"] .library-open').click();remove(w,B.title);$('undo-removal').click();w.document.querySelector('.library-entry[data-document-key="b"] .library-open').click();
  const before=w.localStorage.getItem(KEY),message=$('notice').textContent;release();await pending;assert.equal(w.localStorage.getItem(KEY),before);assert.equal($('notice').textContent,message);
 }finally{release?.();await w.happyDOM.close();}
});
test('whole-library restore rechecks earlier aliases when another document is removed during a later digest',async()=>{
 const A={...fixture('Earlier A'),key:'a'},B={...fixture('Later B'),key:'b'},D={...fixture('Unrelated D'),key:'d'},C={...fixture('Current'),key:'c'};
 const {w,$}=setup(JSON.stringify({documents:[A,B,D,C],active:'c'}));let releaseRead,releaseDigest;try{
  const all=(await download(w,'export-library')).documents;const backup={format:'coconut-library',version:1,documents:all.slice(0,2).map((doc,i)=>({...doc,key:'alias-'+i})),active:'alias-0'};$('add-content').click();
  const input=$('library-file'),text=JSON.stringify(backup);Object.defineProperty(input,'files',{configurable:true,value:[{name:'late-library.json',size:text.length,text:()=>new Promise(resolve=>{releaseRead=()=>resolve(text);})}]});
  const pending=input.onchange();remove(w,D.title);
  const originalDigest=webcrypto.subtle.digest.bind(webcrypto.subtle);let blocked=false;
  Object.defineProperty(w,'crypto',{configurable:true,value:{...webcrypto,subtle:{digest:async(algorithm,bytes)=>{if(!blocked&&new TextDecoder().decode(bytes).includes('Later B')){blocked=true;await new Promise(resolve=>{releaseDigest=resolve;});}return originalDigest(algorithm,bytes);}}}});
  releaseRead();for(let i=0;!releaseDigest&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.ok(releaseDigest);
  remove(w,A.title);releaseDigest();await pending;assert.ok(!read(w).documents.some(doc=>doc.title===A.title));assert.match($('notice').textContent,/取消/);
 }finally{releaseRead?.();releaseDigest?.();await w.happyDOM.close();}
});
test('late older JSON with a removed stable backup key cannot reappear as a different version',async()=>{
 const old={...fixture('Same stable source'),key:'stable'},newer=structuredClone(old);newer.notes.cue='A newer saved note';
 const {w,$}=setup(JSON.stringify({documents:[newer,{...fixture('Current'),key:'c'}],active:'c'}));let release;try{
  $('add-content').click();const input=$('file'),text=JSON.stringify(old);Object.defineProperty(input,'files',{configurable:true,value:[{name:'older.json',size:text.length,text:()=>new Promise(resolve=>{release=()=>resolve(text);})}]});
  const pending=input.onchange();remove(w,newer.title);release();await pending;assert.deepEqual(read(w).documents.map(doc=>doc.title),['Current']);
 }finally{release?.();await w.happyDOM.close();}
});
test('an ignored external JSON key cannot replace the computed-key tombstone evidence',async()=>{
 const {w,$}=setup();let release;try{
  const source={...fixture('B external input key'),key:'untrusted-external-key'};await add(w,source);
  w.document.querySelector('.note-button').click();$('note').value='A later saved note';$('note').oninput();await add(w,fixture('Current'));$('add-content').click();
  const input=$('file'),text=JSON.stringify(source);Object.defineProperty(input,'files',{configurable:true,value:[{name:'old-original.json',size:text.length,text:()=>new Promise(resolve=>{release=()=>resolve(text);})}]});
  const pending=input.onchange();remove(w,source.title);release();await pending;assert.deepEqual(read(w).documents.map(doc=>doc.title),['Current']);
 }finally{release?.();await w.happyDOM.close();}
});
test('raw backup-key ownership is checked after a canonical digest yields to removal',async()=>{
 const old={...fixture('Stable B older snapshot'),key:'stable-b'},newer=structuredClone(old);newer.notes.cue='A newer note';
 const D={...fixture('Unrelated D'),key:'d'},C={...fixture('Current'),key:'c'};
 const {w,$}=setup(JSON.stringify({documents:[newer,D,C],active:'c'}));let releaseRead,releaseDigest;try{
  $('add-content').click();const input=$('file'),text=JSON.stringify(old);Object.defineProperty(input,'files',{configurable:true,value:[{name:'stable-older.json',size:text.length,text:()=>new Promise(resolve=>{releaseRead=()=>resolve(text);})}]});
  const pending=input.onchange();remove(w,D.title);const originalDigest=webcrypto.subtle.digest.bind(webcrypto.subtle);let hashes=0;
  Object.defineProperty(w,'crypto',{configurable:true,value:{...webcrypto,subtle:{digest:async(algorithm,bytes)=>{if(new TextDecoder().decode(bytes).includes(old.title)&&++hashes===2)await new Promise(resolve=>{releaseDigest=resolve;});return originalDigest(algorithm,bytes);}}}});
  releaseRead();for(let i=0;!releaseDigest&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.ok(releaseDigest);remove(w,old.title);releaseDigest();await pending;
  assert.deepEqual(read(w).documents.map(doc=>doc.title),[C.title]);assert.match($('notice').textContent,/取消/);
 }finally{releaseRead?.();releaseDigest?.();await w.happyDOM.close();}
});
test('search hit card removal and undo preserve the shelf query, preview target and manual bookmark',async()=>{
 const {w,$}=setup();try{
  const wanted=fixture('Search target');wanted.segments[0].text='Find the authored needle in context.';wanted.notes.cue='A needle note';await add(w,wanted);await add(w,fixture('Unrelated document'));
  $('library-scope').value='text';$('library-scope').onchange();$('library-search').value='needle';$('library-search').oninput();
  assert.equal($('library').children.length,1);const row=$('library').firstElementChild;assert.ok(row.querySelector('.library-open'));assert.ok(row.querySelector('.library-remove'));assert.ok(row.querySelector('.library-hits .library-hit'));
  row.querySelector('.library-hit[data-hit-kind="text"]').click();const original=read(w).documents.find(doc=>doc.title===wanted.title);
  remove(w,wanted.title);assert.equal($('library-search').value,'needle');assert.equal($('library').children.length,0);$('undo-removal').click();
  assert.equal($('library-search').value,'needle');assert.equal($('library-scope').value,'text');assert.equal($('library').children.length,1);assert.ok($('library').querySelector('.library-hit[data-hit-kind="text"]'));
  assert.deepEqual(read(w).documents.find(doc=>doc.key===original.key),original);assert.equal(w.document.activeElement.className,'library-remove');
 }finally{await w.happyDOM.close();}
});
function simulateListeningPlayer(w,player){
 let paused=true;Object.defineProperties(player,{duration:{configurable:true,value:120},paused:{configurable:true,get:()=>paused}});
 player.play=async()=>{paused=false;player.dispatchEvent(new w.Event('play'));};player.pause=()=>{paused=true;player.dispatchEvent(new w.Event('pause'));};
 player.dispatchEvent(new w.Event('loadedmetadata'));return player;
}
for(const preview of [false,true])test(`removal and undo across same media retain separate primary listening positions${preview?' during bounded preview':''}`,async()=>{
 const {w,$}=setup();try{
  const source_media={job_id:'d'.repeat(32),kind:'audio'};await add(w,{...fixture('Fallback B'),source_media});await add(w,{...fixture('Listening A'),source_media});
  w.dispatchEvent(new w.CustomEvent('coconut-worker-ready',{detail:{media_import:true}}));const saved=read(w),A=saved.documents.find(doc=>doc.title==='Listening A'),B=saved.documents.find(doc=>doc.title==='Fallback B');
  const aKey='coconut-listening-v1:'+A.key,bKey='coconut-listening-v1:'+B.key,oldPlayer=simulateListeningPlayer(w,$('source-media').querySelector('audio'));
  await oldPlayer.play();oldPlayer.currentTime=47;oldPlayer.pause();await oldPlayer.play();oldPlayer.currentTime=49;
  if(preview){oldPlayer.pause();await w.removalPlayback.listen({id:'temporary',start:10,end:20});oldPlayer.currentTime=15;oldPlayer.dispatchEvent(new w.Event('timeupdate'));}
  remove(w,A.title);assert.equal(oldPlayer.paused,true);assert.equal(JSON.parse(w.localStorage.getItem(aKey)).time,49);assert.equal(w.localStorage.getItem(bKey),null);
  const fallback=simulateListeningPlayer(w,$('source-media').querySelector('audio'));assert.notEqual(fallback,oldPlayer);await fallback.play();fallback.currentTime=28;
  $('undo-removal').click();assert.equal(fallback.paused,true);assert.equal(JSON.parse(w.localStorage.getItem(bKey)).time,28);assert.equal(JSON.parse(w.localStorage.getItem(aKey)).time,49);
  const restored=simulateListeningPlayer(w,$('source-media').querySelector('audio'));assert.notEqual(restored,fallback);assert.equal(restored.paused,true);assert.equal($('resume-listening').hidden,false);
  oldPlayer.currentTime=99;oldPlayer.dispatchEvent(new w.Event('timeupdate'));fallback.currentTime=99;fallback.dispatchEvent(new w.Event('pause'));
  assert.equal(JSON.parse(w.localStorage.getItem(aKey)).time,49);assert.equal(JSON.parse(w.localStorage.getItem(bKey)).time,28);
  $('resume-listening').click();assert.equal(restored.currentTime,49);assert.equal(restored.paused,true);assert.equal(read(w).documents.find(doc=>doc.key===A.key).readingPosition,A.readingPosition);
 }finally{await w.happyDOM.close();}
});
test('removing and undoing a non-current search result never pauses or resets current listening',async()=>{
 const {w,$}=setup();try{
  const B=fixture('Remove non-current B');B.segments[0].text='A unique needle to find.';await add(w,B);await add(w,{...fixture('Listening A'),source_media:{job_id:'e'.repeat(32),kind:'audio'}});
  w.dispatchEvent(new w.CustomEvent('coconut-worker-ready',{detail:{media_import:true}}));const current=w.sessionStorage.getItem('coconut-reader-active-v1'),player=simulateListeningPlayer(w,$('source-media').querySelector('audio'));await player.play();player.currentTime=36;
  $('library-scope').value='text';$('library-scope').onchange();$('library-search').value='needle';$('library-search').oninput();remove(w,B.title);assert.equal(player.paused,false);$('undo-removal').click();
  assert.equal(w.sessionStorage.getItem('coconut-reader-active-v1'),current);assert.equal($('source-media').querySelector('audio'),player);assert.equal(player.paused,false);assert.equal(player.currentTime,36);assert.equal($('library-search').value,'needle');player.pause();assert.equal(JSON.parse(w.localStorage.getItem('coconut-listening-v1:'+current)).time,36);
 }finally{await w.happyDOM.close();}
});


test('organizing reveals removal without replacing full-width title or source-backed search content',async()=>{
 const {w,$}=setup();try{
  const title='路口观察 · 先读完整意思，再回听一次 · '+ '无空格LongAuthoredTitle'.repeat(12);
  await add(w,fixture(title));const entry=$('library').firstElementChild;
  assert.equal(entry.querySelector('.library-title').textContent,title);
  assert.equal(entry.querySelector('.library-remove').hidden,true);
  assert.equal($('library-options').open,false);
  $('library-options').open=true;$('library-options').dispatchEvent(new w.Event('toggle'));
  assert.equal(entry.querySelector('.library-remove').hidden,false);
  assert.equal(entry.querySelector('.library-open').getAttribute('aria-current'),'page');
  $('library-options').open=false;$('library-options').dispatchEvent(new w.Event('toggle'));
  assert.equal(entry.querySelector('.library-remove').hidden,true);
  assert.equal(read(w).documents[0].title,title);
 }finally{await w.happyDOM.close();}
});
test('recovery is outside the collapsed shelf; disclosure changes retain the complete slot and guard',async()=>{
 const {w,$}=setup();try{
  await add(w);const original=read(w).documents[0];remove(w,original.title);
  assert.equal($('toggle-library').getAttribute('aria-expanded'),'false');
  assert.equal($('library-list').contains($('removal-recovery')),false);
  assert.equal($('removal-recovery-details').open,false);
  assert.equal($('undo-removal').closest('details'),null);
  assert.match($('removal-recovery-limit').textContent,/上一份.*刷新、关闭或离开/);
  assert.equal($('export-removed-document').closest('details'),$('removal-recovery-details'));
  for(const open of [true,false,true,false]){
   $('removal-recovery-details').open=open;
   assert.equal(guard(w),true);assert.deepEqual(await download(w,'export-removed-document'),original);
  }
  $('library-options').open=false;$('library-options').dispatchEvent(new w.Event('toggle'));
  $('undo-removal').click();assert.deepEqual(read(w).documents[0],original);
  assert.equal(w.document.activeElement.classList.contains('library-open'),true);
  assert.equal($('toggle-library').getAttribute('aria-expanded'),'true');
  assert.equal($('removal-recovery').hidden,true);assert.equal(guard(w),false);
 }finally{await w.happyDOM.close();}
});
test('failed undo reveals export controls and a persistent local error; collapsing details never hides the error',async()=>{
 const {w,$}=setup();try{
  await add(w);remove(w,'Authored removal fixture');const backing=w.localStorage;
  Object.defineProperty(w,'localStorage',{value:{getItem:k=>backing.getItem(k),setItem:()=>{throw Error('Injected quota');}}});
  $('undo-removal').click();assert.equal($('removal-recovery-details').open,true);
  assert.equal($('removal-recovery-error').hidden,false);assert.match($('removal-recovery-error').textContent,/撤销未保存/);
  $('removal-recovery-details').open=false;assert.equal($('removal-recovery-error').closest('details'),null);
  assert.equal(guard(w),true);assert.equal(read(w).documents.length,0);
 }finally{await w.happyDOM.close();}
});
test('finish cancellation restores the actual visible disclosure action, without losing recovery',async()=>{
 const {w,$}=setup();try{
  await add(w);remove(w,'Authored removal fixture');$('removal-recovery-details').open=true;
  $('finish-removal').click();$('cancel-finish-removal').click();
  // Happy DOM does not dispatch the native dialog close event automatically.
  $('finish-removal-dialog').dispatchEvent(new w.Event('close'));
  assert.equal(w.document.activeElement,$('finish-removal'));assert.equal($('removal-recovery-details').open,true);assert.equal(guard(w),true);
  $('undo-removal').click();assert.equal($('removal-recovery-details').open,false);assert.equal($('removal-recovery-error').hidden,true);
 }finally{await w.happyDOM.close();}
});


test('rescue download failures are visible in the active confirmation and retry clears only export errors',async()=>{
 const {w,$}=setup();try{
  await add(w);await add(w,fixture('Second authored fixture'));remove(w,'Authored removal fixture');
  const original=await download(w,'export-removed-document');request(w,'Second authored fixture');
  w.URL.createObjectURL=()=>{throw Error('Injected download failure');};$('export-previous-removal').click();
  assert.equal($('removal-export-error').hidden,false);assert.match($('remove-document-error').textContent,/下载失败/);
  assert.equal($('remove-document-dialog').open,true);assert.equal(guard(w),true);
  assert.deepEqual(await download(w,'export-previous-removal'),original);
  assert.equal($('removal-export-error').hidden,true);assert.equal($('remove-document-error').textContent,'');
  $('cancel-removal').click();const backing=w.localStorage;
  Object.defineProperty(w,'localStorage',{value:{getItem:k=>backing.getItem(k),setItem:()=>{throw Error('Injected quota');}}});
  $('undo-removal').click();assert.equal($('removal-recovery-error').hidden,false);
  await download(w,'export-removed-document');assert.equal($('removal-recovery-error').hidden,false);
  assert.match($('removal-recovery-error').textContent,/撤销未保存/);
 }finally{await w.happyDOM.close();}
});


test('collapsed recovery names the removed document without truncating its accessible text',async()=>{
 const {w,$}=setup();try{
  const title='很长的移除标题 '+ '完整名称LongUnbrokenTitle'.repeat(20);
  await add(w,fixture(title));remove(w,title);
  const shortTitle=$('removal-recovery-short-title');
  assert.equal(shortTitle.textContent,title);assert.equal(shortTitle.closest('details'),null);
  assert.equal($('removal-recovery-details').open,false);
  assert.equal($('removal-recovery-title').textContent,'已移除：'+title);
  assert.ok($('undo-removal').getAttribute('aria-describedby').split(' ').includes(shortTitle.id));
  $('removal-recovery-details').open=true;$('removal-recovery-details').open=false;
  assert.equal(shortTitle.textContent,title);assert.equal(guard(w),true);
  $('undo-removal').click();assert.equal(shortTitle.textContent,'');
  assert.equal(read(w).documents[0].title,title);
 }finally{await w.happyDOM.close();}
});
