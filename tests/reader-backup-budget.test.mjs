import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto,createHash} from 'node:crypto';
import {Window} from 'happy-dom';
import {MiB,annotatedDocument,chineseDocument,oversizedDocument} from './helpers/backup-fixtures.mjs';

const root=new URL('../',import.meta.url),KEY='coconut-reader-v1';
function setup(){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{configurable:true,value:webcrypto});w.fetch=()=>{throw new Error('Backups must stay local');};
 w.eval(['summary','core','passages','passage-playback','app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+'\nwindow.replaceActiveForTest=()=>{state.documents=state.documents.map(doc=>doc.key===state.active?{...doc}:doc);};');
 const $=id=>w.document.getElementById(id);
 for(const id of ['file','library-file','project-transcript-file'])Object.defineProperty($(id),'value',{configurable:true,writable:true,value:''});
 const choose=(text,{id='file',name='backup.json',read=async()=>text,size=Buffer.byteLength(text)}={})=>{
  const input=$(id);Object.defineProperty(input,'files',{configurable:true,value:[{name,size,text:read}]});input.value=name;return input.onchange();
 };
 const library=()=>JSON.parse(w.localStorage.getItem(KEY)||'{"documents":[]}');
 const download=async(id='export')=>{let blob;w.URL.createObjectURL=value=>{blob=value;return 'blob:backup';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};$(id).click();assert.ok(blob,'a complete backup download must be initiated');return blob.text();};
 const blockStorage=()=>{const backing=w.localStorage;Object.defineProperty(w,'localStorage',{configurable:true,value:{getItem:key=>backing.getItem(key),setItem(){throw new w.DOMException('No space','QuotaExceededError');}}});return backing;};
 return {w,$,choose,library,download,blockStorage};
}
const digest=value=>createHash('sha256').update(value).digest('hex');

test('6 million Chinese characters plus annotations export and reimport above the old 15 MiB limit',async()=>{
 const source=setup(),fresh=setup();
 try{
  const raw=JSON.stringify(chineseDocument());assert.ok(Buffer.byteLength(raw)>15*MiB&&Buffer.byteLength(raw)<50*MiB);
  await source.choose(raw);assert.equal(source.$('large-backup-dialog').open,false);
  const exported=await source.download(),expected=JSON.parse(exported);
  await fresh.choose(exported);const recovered=fresh.library().documents[0];
  assert.deepEqual(fresh.w.Coconut.validate(recovered),fresh.w.Coconut.validate(expected));
  assert.equal(recovered.segments.at(-1).text,'汉'.repeat(1000));assert.equal(recovered.notes.cue,expected.notes.cue);
  assert.deepEqual(recovered.translation_contexts,expected.translation_contexts);assert.deepEqual(recovered.ai_answers,expected.ai_answers);
  const count=fresh.library().documents.length;await fresh.choose(exported);assert.equal(fresh.library().documents.length,count);
 }finally{await source.w.happyDOM.close();await fresh.w.happyDOM.close();}
});

for(const bytes of [50*MiB-1,50*MiB,50*MiB+1])test(`actual UTF-8 JSON size ${bytes} uses the exact 50 MiB review threshold`,async()=>{
 const {w,$,choose,library}=setup();
 try{
  const body=JSON.stringify(annotatedDocument()),text=body+' '.repeat(bytes-Buffer.byteLength(body));assert.equal(Buffer.byteLength(text),bytes);let reads=0;
  const pending=choose(text,{read:async()=>{reads++;return text;}});
  if(bytes>50*MiB){assert.equal(reads,0);assert.equal($('large-backup-dialog').open,true);assert.equal(w.document.activeElement.id,'cancel-large-backup');$('continue-large-backup').click();}
  else assert.equal($('large-backup-dialog').open,false);
  await pending;assert.equal(reads,1);assert.equal(library().documents.length,1);assert.equal($('file').value,'');
 }finally{await w.happyDOM.close();}
});

for(const id of ['file','library-file','project-transcript-file'])for(const dismiss of ['cancel','escape','navigate','newer-file','pagehide'])test(`${id}: ${dismiss} retires large-file review without reading or replacing current work`,async()=>{
 const {w,$,choose,library}=setup();let pending;
 try{
  const audio={project_kind:'audio_only',title:'Original project',segments:[],podcast_source:{kind:'direct_media',media_url:'https://publisher.example/authored.mp3',media_kind:'audio'},project_note:'Original private note'};
  await choose(JSON.stringify(audio));const before=w.localStorage.getItem(KEY);let reads=0;
  if(id==='project-transcript-file')$('attach-project-transcript').click();
  pending=choose('{}',{id,size:50*MiB+1,read:async()=>{reads++;return '{}';}});assert.equal($('large-backup-dialog').open,true);
  if(dismiss==='cancel')$('cancel-large-backup').click();
  if(dismiss==='escape')$('large-backup-dialog').dispatchEvent(new w.Event('cancel',{cancelable:true}));
  if(dismiss==='navigate'){$('add-content').click();$('back-reading').click();}
  if(dismiss==='newer-file')await choose(JSON.stringify(annotatedDocument('Newer file')));
  if(dismiss==='pagehide')w.dispatchEvent(new w.Event('pagehide'));
  await pending;assert.equal(reads,0);assert.equal($('large-backup-dialog').open,false);assert.equal($(id).value,'');
  if(dismiss==='newer-file'){assert.equal($('title').textContent,'Newer file');assert.equal(library().documents[0].project_note,'Original private note');}
  else assert.equal(w.localStorage.getItem(KEY),before);
 }finally{$('cancel-large-backup').click();await pending;await w.happyDOM.close();}
});

test('same-file retry after cancel proceeds once, and stale approval cannot approve the newer selection',async()=>{
 const {w,$,choose,library}=setup();let first,second;
 try{
  const text=JSON.stringify(annotatedDocument());let reads=0;const options={size:50*MiB+1,read:async()=>{reads++;return text;}};
  first=choose(text,options);const oldContinue=$('continue-large-backup').onclick;
  second=choose(text,options);await first;oldContinue();$('large-backup-dialog').dispatchEvent(new w.Event('close'));assert.equal($('large-backup-dialog').open,true);assert.equal(reads,0);
  $('cancel-large-backup').click();await second;
  second=choose(text,options);$('continue-large-backup').click();await second;assert.equal(reads,1);assert.equal(library().documents.length,1);
 }finally{$('cancel-large-backup').click();await first;await second;await w.happyDOM.close();}
});

for(const id of ['file','project-transcript-file'])test(`${id}: oversized subtitles remain bounded before read, while JSON follows the backup budget`,async()=>{
 const {w,$,choose}=setup();
 try{
  if(id==='project-transcript-file')await choose(JSON.stringify({project_kind:'audio_only',title:'Audio',segments:[],podcast_source:{kind:'direct_media',media_url:'https://publisher.example/authored.mp3',media_kind:'audio'}}));
  for(const name of ['captions.srt','captions.vtt']){
   if(id==='project-transcript-file')$('attach-project-transcript').click();
   let reads=0;await choose('',{id,name,size:15*MiB+1,read:async()=>{reads++;return '';}});
   assert.equal(reads,0);assert.match($('notice').textContent,/字幕文件超过15 MiB/);assert.equal($('large-backup-dialog').open,false);
  }
 }finally{await w.happyDOM.close();}
});

test('over-50 MiB whole-library export restores every note despite quota failure, preserving the original library',async()=>{
 const source=setup(),target=setup();let pending;
 try{
  await target.choose(JSON.stringify(annotatedDocument('Original saved work')));const saved=target.w.localStorage.getItem(KEY),backing=target.blockStorage();
  source.blockStorage();await source.w.add(source.w.Coconut.validate(oversizedDocument()));
  const exported=await source.download('export-library');assert.ok(Buffer.byteLength(exported)>50*MiB);assert.match(source.$('notice').textContent,/恢复时需要确认/);
  pending=target.choose(exported,{id:'library-file'});assert.equal(target.$('large-backup-dialog').open,true);target.$('continue-large-backup').click();await pending;
  assert.equal(backing.getItem(KEY),saved);assert.equal(target.$('title').textContent,'含大笔记的完整备份');assert.equal(target.$('save-status').hidden,false);
  const rescue=await target.download();assert.equal(JSON.parse(rescue).notes.cue.length,17600000);assert.equal(digest(JSON.parse(rescue).notes.cue),digest(JSON.parse(exported).documents[0].notes.cue));
  pending=target.choose(exported,{id:'library-file'});target.$('continue-large-backup').click();await pending;
  const again=JSON.parse(await target.download('export-library'));assert.equal(again.documents.length,2);assert.equal(again.documents[0].notes.cue,'Keep this private note');assert.equal(backing.getItem(KEY),saved);
 }finally{target.$('cancel-large-backup').click();await pending;await source.w.happyDOM.close();await target.w.happyDOM.close();}
});

test('501-document exports restore without a hidden count limit and invalid late members are atomic',async()=>{
 const {w,$,choose,library,download}=setup();
 try{
  await choose(JSON.stringify(annotatedDocument('Original')));const before=w.localStorage.getItem(KEY);
  const docs=Array.from({length:501},(_,i)=>({...annotatedDocument('Backup '+i),key:'backup-'+i}));
  const backup={format:'coconut-library',version:1,documents:docs,active:'backup-500'};
  await choose(JSON.stringify({...backup,documents:[...docs,{key:'invalid',segments:[]}]}),{id:'library-file'});assert.equal(w.localStorage.getItem(KEY),before);assert.match($('notice').textContent,/恢复失败，原书架未改变/);
  await choose(JSON.stringify(backup),{id:'library-file'});assert.equal(library().documents.length,502);assert.equal($('title').textContent,'Backup 500');
  const exported=await download('export-library');await choose(exported,{id:'library-file'});assert.equal(library().documents.length,502);
 }finally{await w.happyDOM.close();}
});

test('large-file memory/read errors remain retryable and never claim persistence or mutate the old library',async()=>{
 const {w,$,choose}=setup();let pending;
 try{
  await choose(JSON.stringify(annotatedDocument()));const before=w.localStorage.getItem(KEY);
  pending=choose('{}',{size:50*MiB+1,read:async()=>{throw new RangeError('Invalid string length');}});$('continue-large-backup').click();await pending;
  assert.equal(w.localStorage.getItem(KEY),before);assert.match($('notice').textContent,/可能超出当前设备可用内存/);assert.equal($('file').value,'');
  await choose(JSON.stringify(annotatedDocument('Retry')));assert.equal($('title').textContent,'Retry');
 }finally{$('cancel-large-backup').click();await pending;await w.happyDOM.close();}
});


test('pending audio-project attachment cannot revive after replacement with the same key and source',async()=>{
 const {w,$,choose,library}=setup();let pending,release;
 try{
  await choose(JSON.stringify({project_kind:'audio_only',title:'Original audio',segments:[],podcast_source:{kind:'direct_media',media_url:'https://publisher.example/authored.mp3',media_kind:'audio'},project_note:'Keep original'}));
  $('attach-project-transcript').click();pending=choose('{}',{id:'project-transcript-file',read:()=>new Promise(resolve=>{release=resolve;})});
  w.replaceActiveForTest();const stored=w.localStorage.getItem(KEY),message=$('notice').textContent;
  release(JSON.stringify(annotatedDocument()));await pending;
  assert.equal(w.localStorage.getItem(KEY),stored);assert.equal($('notice').textContent,message);assert.equal(library().documents[0].project_kind,'audio_only');
 }finally{release?.('{}');await pending;await w.happyDOM.close();}
});

test('audio-project JSON attachment above 15 MiB preserves annotations and a complete quota-failure rescue',async()=>{
 const {w,$,choose,download,blockStorage}=setup();
 try{
  await choose(JSON.stringify({project_kind:'audio_only',title:'My audio project',segments:[],podcast_source:{kind:'direct_media',media_url:'https://publisher.example/authored.mp3',media_kind:'audio'},project_note:'Keep project note',timestamp_bookmarks:[{id:'mark',time:2,note:'Keep bookmark'}]}));
  const old=w.localStorage.getItem(KEY),oldKey=w.sessionStorage.getItem('coconut-reader-active-v1'),backing=blockStorage();
  $('attach-project-transcript').click();await choose(JSON.stringify(chineseDocument()),{id:'project-transcript-file'});
  assert.equal($('large-backup-dialog').open,false);assert.equal($('title').textContent,'My audio project');assert.equal(backing.getItem(KEY),old);assert.equal($('save-status').hidden,false);
  const exported=JSON.parse(await download());assert.equal(exported.key,oldKey);assert.equal(exported.segments.length,6001);assert.equal(exported.project_note,'Keep project note');assert.equal(exported.timestamp_bookmarks[0].note,'Keep bookmark');
  const restored=w.Coconut.parse(JSON.stringify(exported),'attachment.coconut.json');assert.equal(digest(JSON.stringify(restored)),digest(JSON.stringify(w.Coconut.validate(exported))));
 }finally{await w.happyDOM.close();}
});


const audioProject=()=>({project_kind:'audio_only',title:'Current audio project',segments:[],podcast_source:{kind:'direct_media',media_url:'https://publisher.example/authored.mp3',media_kind:'audio'},project_note:'Keep current project note'});
const libraryBackup=doc=>({format:'coconut-library',version:1,documents:[{...doc,key:'incoming-backup'}],active:'incoming-backup'});
const payloadFor=(id,title)=>JSON.stringify(id==='library-file'?libraryBackup(annotatedDocument(title)):annotatedDocument(title));

for(const oldId of ['file','library-file','project-transcript-file'])for(const newId of ['file','library-file','project-transcript-file'])test(`${newId} retires a pending ${oldId} read without clearing the newer selection`,async()=>{
 const {w,$,choose,library}=setup();let oldRun,newRun,releaseOld,releaseNew;
 try{
  await choose(JSON.stringify(audioProject()));
  if(oldId==='project-transcript-file')$('attach-project-transcript').click();
  oldRun=choose(payloadFor(oldId,'Old selection'),{id:oldId,read:()=>new Promise(resolve=>{releaseOld=resolve;})});
  if(newId==='project-transcript-file')$('attach-project-transcript').click();
  newRun=choose(payloadFor(newId,'New selection'),{id:newId,name:'newer.json',read:()=>new Promise(resolve=>{releaseNew=resolve;})});
  const before=w.localStorage.getItem(KEY),message=$('notice').textContent;
  releaseOld(payloadFor(oldId,'Old selection'));await oldRun;
  assert.equal(w.localStorage.getItem(KEY),before);assert.equal($('notice').textContent,message);assert.equal($(newId).value,'newer.json');
  releaseNew(payloadFor(newId,'New selection'));await newRun;
  const docs=library().documents;assert.ok(!docs.some(doc=>doc.title==='Old selection'));
  if(newId==='project-transcript-file'){
   assert.equal(docs.length,1);assert.equal(docs[0].title,'Current audio project');assert.equal(docs[0].project_note,'Keep current project note');assert.equal(docs[0].segments[0].text,'Authored source words');
  }else assert.deepEqual(docs.map(doc=>doc.title),['Current audio project','New selection']);
  assert.equal($(newId).value,'');
 }finally{releaseOld?.('{}');releaseNew?.('{}');await oldRun;await newRun;await w.happyDOM.close();}
});

for(const id of ['file','library-file'])test(`${id}: removal and undo while oversized JSON awaits approval retires old versions but permits a fresh explicit import`,async()=>{
 const {w,$,choose,library,download}=setup();let pending;
 try{
  await choose(JSON.stringify(annotatedDocument('Backup target')));const old=JSON.parse(await download());
  $('mode-transcript').click();w.document.querySelector('.note-button').click();$('note').value='Newer saved note';$('note').oninput();
  await choose(JSON.stringify(annotatedDocument('Current document')));$('add-content').click();
  const payload=JSON.stringify(id==='library-file'?{format:'coconut-library',version:1,documents:[old],active:old.key}:old);let reads=0;
  pending=choose(payload,{id,size:50*MiB+1,read:async()=>{reads++;return payload;}});
  const row=[...$('library').children].find(node=>node.dataset.documentKey===old.key);row.querySelector('.library-remove').click();$('confirm-removal').click();$('undo-removal').click();
  const restored=w.localStorage.getItem(KEY);assert.equal($('large-backup-dialog').open,true);
  $('continue-large-backup').click();await pending;assert.equal(reads,1);assert.equal(w.localStorage.getItem(KEY),restored);assert.match($('notice').textContent,/取消/);
  assert.equal(library().documents.find(doc=>doc.key===old.key).notes.cue,'Newer saved note');
  pending=choose(payload,{id,size:50*MiB+1});$('continue-large-backup').click();await pending;
  assert.equal(library().documents.length,id==='library-file'?3:2);assert.equal(library().documents.find(doc=>doc.key===old.key).notes.cue,'Newer saved note');assert.doesNotMatch($('notice').textContent,/取消/);
 }finally{$('cancel-large-backup').click();await pending;await w.happyDOM.close();}
});

test('a newer project attachment retires an older file already awaiting its digest',async()=>{
 const {w,$,choose,library}=setup();let pending,release;
 try{
  await choose(JSON.stringify(audioProject()));
  const digest=webcrypto.subtle.digest.bind(webcrypto.subtle);
  Object.defineProperty(w,'crypto',{configurable:true,value:{subtle:{digest:async(...args)=>{await new Promise(resolve=>{release=resolve;});return digest(...args);}}}});
  pending=choose(JSON.stringify(annotatedDocument('Old digest selection')));
  for(let i=0;!release&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.ok(release);
  $('attach-project-transcript').click();await choose(JSON.stringify(annotatedDocument('New attached source')),{id:'project-transcript-file'});
  const before=w.localStorage.getItem(KEY),message=$('notice').textContent;release();await pending;
  assert.equal(w.localStorage.getItem(KEY),before);assert.equal($('notice').textContent,message);assert.equal(library().documents.length,1);assert.equal(library().documents[0].project_note,'Keep current project note');
 }finally{release?.();await pending;await w.happyDOM.close();}
});

test('leaving and returning while the project file picker is open retires its captured target before reading',async()=>{
 const {w,$,choose,library}=setup();
 try{
  await choose(JSON.stringify(audioProject()));$('attach-project-transcript').click();$('add-content').click();$('back-reading').click();
  let reads=0;await choose(JSON.stringify(annotatedDocument()),{id:'project-transcript-file',read:async()=>{reads++;return JSON.stringify(annotatedDocument());}});
  assert.equal(reads,0);assert.equal(library().documents[0].project_kind,'audio_only');assert.match($('notice').textContent,/重新选择文字稿/);
  $('attach-project-transcript').click();await choose(JSON.stringify(annotatedDocument()),{id:'project-transcript-file'});assert.equal(library().documents[0].segments.length,1);
 }finally{await w.happyDOM.close();}
});
