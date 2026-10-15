// Compatibility renderer regression; this suite is not default React acceptance.
/** Pure parser + real Happy DOM handlers. Native layout, picker, and IndexedDB remain browser-CI gates. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import C from '../reader/core.js';
import {installSavePipeline,settle,saveClock} from './helpers/save-pipeline.mjs';
import {subtitleFixtures,expectedCues,note,cueSnapshot} from './helpers/subtitle-import-fixtures.mjs';

const root=new URL('../',import.meta.url),KEY='coconut-reader-v1';
const srt='1\n00:00:01,125 --> 00:00:03,875\nFirst authored line 你好 🌿\nA second line &amp; detail.\n\n2\n00:00:04,000 --> 00:00:05,250\nSecond cue';
const vtt='WEBVTT\n\nopening\n00:01.125 --> 00:03.875 align:start\n<v Alice &amp; Bob>Hello &lt;Team&gt; 🌿</v>\n\nreply\n00:04.000 --> 00:05.250\n<v Chen>Reply</v>';
const base=key=>({...C.validate({title:key,segments:[{id:'one',start:0,end:5,text:'Existing authored document '+key}],notes:{one:'Existing '+key+' note'}}),key});
const plain=value=>JSON.parse(JSON.stringify(value));
const digest=doc=>createHash('sha256').update(JSON.stringify(doc)).digest('hex');
async function until(condition,message='condition did not settle'){
 for(let i=0;i<500;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,2));}
 assert.ok(condition(),message);
}
function setup({documents=[],storage=null,held=false}={}){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/compatibility.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 if(storage)for(const [key,value] of Object.entries(storage))w.localStorage.setItem(key,value);
 else if(documents.length)w.localStorage.setItem(KEY,JSON.stringify({documents,active:documents[0].key}));
 const network=[],downloads=[],digests=[];let holdDigest=false;
 Object.defineProperty(w,'crypto',{value:{randomUUID:()=>webcrypto.randomUUID(),subtle:{digest:(algorithm,bytes)=>holdDigest?new Promise(resolve=>digests.push({release:()=>webcrypto.subtle.digest(algorithm,bytes).then(resolve)})):webcrypto.subtle.digest(algorithm,bytes)}}});
 w.fetch=url=>{network.push(String(url));throw Error('Pasted subtitle tests must remain offline');};
 w.URL.createObjectURL=blob=>{downloads.push(blob);return 'blob:authored-paste';};w.URL.revokeObjectURL=()=>{};
 w.HTMLAnchorElement.prototype.click=function(){};
 const saves=installSavePipeline(w,{held,clock:saveClock()});
 w.eval(['summary','core','passages','passage-playback','app','language','translation-review','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+'\nwindow.pasteTest={docs:()=>state.documents,active:()=>active(),workspace:()=>workspace,owner:()=>({selection:activeSelectionRevision,imports:localImportRevision}),select:key=>{selectActiveDocument(key);render();}};');
 const $=id=>{const element=w.document.getElementById(id);assert.ok(element,'Missing production element #'+id);return element;};
 const change=(id,value)=>{$(id).value=value;$(id).dispatchEvent(new w.Event(id==='paste-subtitle-format'?'change':'input',{bubbles:true}));};
 const open=()=>{$('paste-subtitles').click();assert.equal($('paste-subtitle-dialog').open,true);};
 const fill=(text=srt,title='Pasted source',format='auto')=>{open();change('paste-subtitle-title',title);change('paste-subtitle-format',format);change('paste-subtitle-text',text);};
 const preview=()=>{$('preview-paste-subtitle').click();};
 const submit=()=>{assert.equal($('confirm-paste-subtitle').disabled,false);return $('confirm-paste-subtitle').onclick();};
 const choose=(name,text,id='file')=>{Object.defineProperty($(id),'files',{configurable:true,value:[new w.File([text],name)]});return $(id).onchange();};
 const unload=()=>{const event=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(event);return event.defaultPrevented;};
 const close=async()=>{holdDigest=false;saves.hold(false);await Promise.all(digests.map(item=>item.release()));for(const write of saves.writes)write.commit();await settle();await w.happyDOM.close();};
 return {w,$,saves,network,downloads,digests,change,open,fill,preview,submit,choose,unload,close,
  holdDigests(value=true){holdDigest=value;},docs:()=>w.pasteTest.docs(),active:()=>w.pasteTest.active(),
  stored:()=>JSON.parse(w.localStorage.getItem(KEY)),storage:()=>Object.fromEntries(Array.from({length:w.localStorage.length},(_,i)=>{const key=w.localStorage.key(i);return [key,w.localStorage.getItem(key)];}))};
}
async function validPreview(e,text=srt,title='Pasted source',format='auto'){
 e.fill(text,title,format);e.preview();assert.equal(e.$('confirm-paste-subtitle').disabled,false,e.$('paste-subtitle-status').textContent);
}
async function noteCurrent(e,text=note){
 e.$('mode-transcript').click();e.w.document.querySelector('.note-button').click();e.$('note').value=text;e.$('note').dispatchEvent(new e.w.Event('input',{bubbles:true}));e.$('close-note').click();assert.equal((await e.w.flushContentForTest()).ok,true);
}
function assertDraft(e,text,title){assert.equal(e.$('paste-subtitle-text').value,text.replace(/\r\n?/g,'\n'));assert.equal(e.$('paste-subtitle-title').value,title);}

for(const f of subtitleFixtures)test('paste parser preserves '+f.format+' BOM, CRLF, multilingual text, exact cue times and file identity',()=>{
 const result=C.parsePastedSubtitles(f.text,{title:f.title,format:'auto'});
 assert.equal(result.format,f.format);assert.equal(result.bytes,Buffer.byteLength(f.text,'utf8'));
 assert.deepEqual(result.diagnostics,[]);assert.deepEqual(cueSnapshot(result.document),expectedCues);
 assert.deepEqual(result.document,C.parse(f.text,f.name));assert.equal(digest(result.document),digest(C.parse(f.text,f.name)));
 assert.equal(Object.hasOwn(result.document,'diagnostics'),false);assert.equal(Object.hasOwn(result.document,'bytes'),false);
});
test('paste parser uses trimmed title or a stable default, with no fabricated source or language',()=>{
 const named=C.parsePastedSubtitles(srt,{title:'  Lesson.with.dots  ',format:'srt'}).document;
 assert.deepEqual(named,C.parse(srt,'Lesson.with.dots.srt'));assert.equal(named.title,'Lesson.with.dots');
 const unnamed=C.parsePastedSubtitles(srt,{title:' \t ',format:'auto'}).document;
 assert.equal(unnamed.title,'粘贴字幕');assert.equal(unnamed.source_url,'');assert.equal(unnamed.language,'');assert.equal(unnamed.provenance,undefined);
 assert.deepEqual(C.parsePastedSubtitles(srt).document,unnamed);
});
test('VTT header, headerless complete timing rows, voices and encoded markup use the original VTT parser',()=>{
 for(const text of [vtt,vtt.replace('WEBVTT\n\n',''),'00:00:01.125 --> 00:00:03.875\n<v Narrator>One &amp; two</v>']){
  const result=C.parsePastedSubtitles(text,{title:'Voices',format:'auto'});assert.equal(result.format,'vtt');assert.deepEqual(result.document,C.parse(text,'Voices.vtt'));
 }
 const result=C.parsePastedSubtitles(vtt,{title:'Voices',format:'vtt'});
 assert.equal(result.document.segments[0].speaker,'Alice & Bob');assert.equal(result.document.segments[0].text,'Hello <Team> 🌿');
 assert.equal(result.document.segments[1].speaker,'Chen');assert.equal(result.document.segments[1].start,4);assert.equal(result.document.segments[1].end,5.25);
});
test('paste parser is strict about cue timing and format without changing legacy file parsing',()=>{
 const invalid=[
  '', 'A transcript with no timestamps.', '00:01 Hello there', '[00:01] Only a start', '00:00:01,000\nOnly a start',
  '1\n00:00:01,000 -->\nNo end', '1\n--> 00:00:02,000\nNo start',
  '1\n00:00:01 --> 00:00:02\nNo milliseconds',
  '1\n0:00:01,000 --> 0:00:02,000\nShort hour',
  '1\n00:00:01,00 --> 00:00:02,000\nShort milliseconds',
  '1\n00:60:01,000 --> 00:60:02,000\nBad minutes',
  '1\n-00:00:01,000 --> 00:00:02,000\nNegative clock',
  '1\n00:00:03,000 --> 00:00:02,000\nReverse interval',
  '1\n00:00:01,000-->00:00:02,000\nNo spaces',
  'heading\nextra line\n00:00:01,000 --> 00:00:02,000\nMisplaced timing',
  JSON.stringify({title:'JSON',segments:[{start:0,end:1,text:'Must use JSON import'}]}),
 ];
 for(const input of invalid)assert.throws(()=>C.parsePastedSubtitles(input,{format:'auto'}),undefined,input);
 for(const input of ['1\n00:01,000 --> 00:02,000\nShort SRT','1\n00:00:01.000 --> 00:00:02.000\nVTT clock'])assert.throws(()=>C.parsePastedSubtitles(input,{format:'srt'}));
 assert.throws(()=>C.parsePastedSubtitles(srt,{format:'vtt'}));assert.throws(()=>C.parsePastedSubtitles(vtt,{format:'srt'}));
 assert.throws(()=>C.parsePastedSubtitles(srt,{format:'json'}));
 assert.equal(C.parse('1\n00:01,000 --> 00:02,000\nLegacy short clock','legacy.srt').segments[0].start,1);
 assert.equal(C.parse('heading\nextra line\n00:00:01,000 --> 00:00:02,000\nLegacy timing position','legacy.srt').segments[0].text,'Legacy timing position');
});
test('partial malformed-block diagnostics retain original CRLF/BOM line numbers and never become cue metadata',()=>{
 const first='17\n00:00:01,125 --> 00:00:03,875\nFirst\nSecond line',bad='42\n00:00:04,000 -> 00:00:05,000\n<img src=x onerror=alert(1)>',last='800\n00:00:06,000 --> 00:00:07,000\nLast';
 const text='\uFEFF'+[first,bad,last].join('\r\n\r\n').replace(/(?<!\r)\n/g,'\r\n');
 const result=C.parsePastedSubtitles(text,{title:'Partial',format:'srt'}),file=C.parseWithDiagnostics(text,'Partial.srt');
 assert.deepEqual(result.document,file.document);assert.deepEqual(result.diagnostics,file.diagnostics);
 assert.equal(result.diagnostics[0].startLine,6);assert.equal(result.diagnostics[0].endLine,8);assert.equal(result.diagnostics[0].cueId,'42');
 assert.deepEqual(result.document.segments.map(s=>s.text),['First\nSecond line','Last']);
 assert.equal(JSON.stringify(result.document).includes('onerror'),false);
});
test('15 MiB limit counts UTF-8 bytes, accepts its exact boundary and rejects above it before parsing',()=>{
 const limit=15*1024*1024,prefix='1\n00:00:00,000 --> 00:00:01,000\n';
 const remaining=limit-Buffer.byteLength(prefix),text=prefix+'界'.repeat(Math.floor(remaining/3))+'a'.repeat(remaining%3);
 assert.ok(text.length<limit/2,'fixture distinguishes UTF-16 length from UTF-8 byte size');
 const result=C.parsePastedSubtitles(text,{format:'srt'});assert.equal(result.bytes,limit);assert.equal(result.document.segments[0].text,text.slice(prefix.length));
 assert.throws(()=>C.parsePastedSubtitles(text+'a',{format:'srt'}),/15 MiB/);
 assert.throws(()=>C.parsePastedSubtitles('x'.repeat(limit+1),{format:'auto'}),/15 MiB/);
});
test('pasted text still enforces the existing 100,000 cue and monotone-start validation limits',()=>{
 const cue='00:00:00,000 --> 00:00:00,001\na';
 assert.throws(()=>C.parsePastedSubtitles(Array.from({length:100001},()=>cue).join('\n\n'),{format:'srt'}),/100,000/);
 assert.throws(()=>C.parsePastedSubtitles('1\n00:00:02,000 --> 00:00:03,000\nFirst\n\n2\n00:00:01,000 --> 00:00:02,000\nOut of order',{format:'srt'}),/时间戳无效/);
});

test('entry is explicit, editing never parses or writes, and preview renders only the first three actual cues offline',async()=>{
 const e=setup({documents:[base('existing')]});try{
  const prior=JSON.stringify(e.docs()),stored=e.w.localStorage.getItem(KEY),active=e.active();let parses=0;
  const parse=e.w.Coconut.parsePastedSubtitles;e.w.Coconut.parsePastedSubtitles=(...args)=>{parses++;return parse(...args);};
  assert.equal(e.$('paste-subtitle-dialog').open,false);
  const text=srt+'\n\n3\n00:00:06,000 --> 00:00:07,000\nThird visible cue\n\n4\n00:00:08,000 --> 00:00:09,000\nFourth should not preview';
  e.fill(text,'Preview source');assert.equal(parses,0);assert.equal(e.$('confirm-paste-subtitle').disabled,true);
  assert.equal(e.$('paste-subtitle-preview').textContent,'');assert.equal(e.saves.prepares,0);
  e.preview();assert.equal(parses,1);assert.equal(e.$('confirm-paste-subtitle').disabled,false);
  const preview=e.$('paste-subtitle-preview').textContent;
  for(const cue of C.parse(text,'Preview source.srt').segments.slice(0,3))assert.ok(preview.includes(cue.text),cue.text);
  assert.doesNotMatch(preview,/Fourth should not preview/);assert.match(e.$('paste-subtitle-status').textContent,/4 段/);
  assert.match(e.$('paste-subtitle-status').textContent,/00:01\.125/);assert.match(e.$('paste-subtitle-status').textContent,/00:09\.000/);
  assert.equal(JSON.stringify(e.docs()),prior);assert.equal(e.w.localStorage.getItem(KEY),stored);assert.equal(e.active(),active);assert.equal(e.saves.prepares,0);assert.deepEqual(e.network,[]);
 }finally{await e.close();}
});
for(const [id,value] of [['paste-subtitle-title','New title'],['paste-subtitle-text',srt+'\n'],['paste-subtitle-format','srt']])test(id+' input invalidates preview immediately and requires another explicit parse',async()=>{
 const e=setup();try{
  await validPreview(e);let parses=0;const parse=e.w.Coconut.parsePastedSubtitles;e.w.Coconut.parsePastedSubtitles=(...args)=>{parses++;return parse(...args);};
  e.change(id,value);assert.equal(parses,0);assert.equal(e.$('confirm-paste-subtitle').disabled,true);assert.equal(e.$('paste-subtitle-preview').textContent,'');
  await e.$('confirm-paste-subtitle').onclick();assert.equal(e.docs().length,0);assert.equal(e.saves.prepares,0);
  e.preview();assert.equal(parses,1);assert.equal(e.$('confirm-paste-subtitle').disabled,false);
 }finally{await e.close();}
});
test('preview and diagnostics treat malicious-looking cue text, speakers, titles and malformed blocks only as text',async()=>{
 const e=setup();try{
  const text='1\n00:00:00,000 --> 00:00:01,000\n<img src=x onerror=alert(1)> &lt;script&gt;not code&lt;/script&gt;\n\n42\n00:00:02,000 -> 00:00:03,000\n<svg onload=alert(1)>\n\n3\n00:00:04,000 --> 00:00:05,000\nLast';
  await validPreview(e,text,'<img src=x onerror=alert(1)>');
  assert.equal(e.$('paste-subtitle-dialog').querySelector('img,script,svg'),null);assert.match(e.$('paste-subtitle-preview').textContent,/<img/);
  const diagnosticDetails=e.$('paste-subtitle-diagnostics').querySelector('details');diagnosticDetails.open=true;diagnosticDetails.dispatchEvent(new e.w.Event('toggle'));
  assert.match(e.$('paste-subtitle-diagnostics').textContent,/42/);assert.match(e.$('paste-subtitle-diagnostics').textContent,/5/);assert.match(e.$('paste-subtitle-diagnostics').textContent,/7/);assert.match(e.$('paste-subtitle-diagnostics').textContent,/<svg/);
  await e.submit();assert.equal(e.docs().length,1);assert.equal(e.active().segments.length,2);assert.equal(e.active().notes['segment-1'],undefined);assert.deepEqual(e.network,[]);
  await validPreview(e,vtt,'Voices','vtt');assert.equal(e.$('paste-subtitle-preview').querySelector('Team'),null);assert.match(e.$('paste-subtitle-preview').textContent,/Hello <Team>/);
 }finally{await e.close();}
});
for(const input of ['Plain transcript','00:01 Only a start','1\n00:00:01,000 -->\nMissing end','1\n00:00:03,000 --> 00:00:02,000\nReversed'])test('invalid preview preserves current library and notes: '+input.slice(0,24),async()=>{
 const e=setup({documents:[base('keep')]});try{
  const prior=JSON.stringify(e.docs()),stored=e.w.localStorage.getItem(KEY);e.fill(input);e.preview();
  assert.equal(e.$('confirm-paste-subtitle').disabled,true);assert.ok(e.$('paste-subtitle-status').textContent.trim());assert.equal(e.$('paste-subtitle-preview').textContent,'');
  assert.equal(JSON.stringify(e.docs()),prior);assert.equal(e.w.localStorage.getItem(KEY),stored);assert.equal(e.active().key,'keep');assert.equal(e.saves.prepares,0);assert.deepEqual(e.network,[]);
 }finally{await e.close();}
});
for(const f of subtitleFixtures)test(f.format+' confirm waits for a durable receipt, prevents double submission and reloads with exact file identity',async()=>{
 const e=setup({documents:[base('keep')],held:true});let restored;try{
  await validPreview(e,f.text,f.title);const submitted=e.submit();await until(()=>e.saves.writes.length===1);
  assert.equal(e.active().key,'keep');assert.equal(e.$('confirm-paste-subtitle').disabled,true);assert.equal(e.$('paste-subtitle-dialog').open,true);assert.equal(e.$('save-status').dataset.state,'pending');
  const duplicate=e.$('confirm-paste-subtitle').onclick();await duplicate;assert.equal(e.saves.writes.length,1);assert.equal(e.docs().length,2);
  assert.equal(e.stored().documents.length,1);assert.equal(e.unload(),true);
  const expected=C.parse(f.text,f.name),pending=e.docs().find(doc=>doc.title===f.title);assert.equal(pending.key,digest(expected));
  e.saves.writes[0].commit();await submitted;
  assert.equal(e.active().key,pending.key);assert.equal(e.$('paste-subtitle-dialog').open,false);assert.equal(e.$('paste-subtitle-text').value,'');assert.equal(e.$('paste-subtitle-title').value,'');assert.equal(e.$('save-status').dataset.state,'saved');assert.equal(e.unload(),false);
  assert.deepEqual(plain(e.w.Coconut.validate(e.active())),plain(expected));
  restored=setup({storage:e.storage()});assert.equal(restored.docs().length,2);assert.deepEqual(plain(restored.docs().find(d=>d.key===pending.key)),plain(e.active()));assert.deepEqual(e.network,[]);
 }finally{await e.close();await restored?.close();}
});
for(const order of ['file-first','paste-first'])test('same title and content deduplicate in '+order+' order without replacing saved notes',async()=>{
 const e=setup();try{
  const f=subtitleFixtures[0];
  if(order==='file-first')await e.choose(f.name,f.text);else{await validPreview(e,f.text,f.title);await e.submit();}
  const key=e.active().key;await noteCurrent(e);const before=plain(e.active());
  if(order==='file-first'){await validPreview(e,f.text,f.title);await e.submit();}else await e.choose(f.name,f.text);
  assert.equal(e.docs().length,1);assert.equal(e.active().key,key);assert.deepEqual(plain(e.active()),before);assert.equal(e.active().notes['segment-1'],note);
  await validPreview(e,f.text,f.title+' separate');await e.submit();assert.equal(e.docs().length,2);assert.notEqual(e.active().key,key);assert.deepEqual(plain(e.active().notes),{});assert.equal(e.docs().find(d=>d.key===key).notes['segment-1'],note);
 }finally{await e.close();}
});

for(const action of ['close','escape','close-reopen','edit','clear','navigation','new-file'])test('held successful paste receipt cannot take over '+action+' or erase its newer draft',async()=>{
 const e=setup({documents:[base('a'),base('b')],held:true});try{
  await validPreview(e);const submitted=e.submit();await until(()=>e.saves.writes.length===1);
  const pasted=e.docs().find(doc=>doc.title==='Pasted source');assert.ok(pasted);let fileImport;
  if(action==='close'||action==='close-reopen')e.$('close-paste-subtitle').click();
  if(action==='escape')e.$('paste-subtitle-dialog').dispatchEvent(new e.w.Event('cancel',{cancelable:true}));
  if(action==='close-reopen'){e.open();e.change('paste-subtitle-title','New draft');e.change('paste-subtitle-text',srt.replace('Second cue','New draft cue'));}
  if(action==='edit'){e.change('paste-subtitle-title','New draft');e.change('paste-subtitle-text',srt.replace('Second cue','New draft cue'));}
  if(action==='clear')e.$('clear-paste-subtitle').click();
  if(action==='navigation')e.w.document.querySelector('.library-entry[data-document-key="b"] .library-open').click();
  if(action==='new-file'){
   fileImport=e.choose('New file.srt',srt.replace('Second cue','New file cue'));
   await until(()=>e.active()?.title==='New file');
  }
  const active=e.active(),draft=e.$('paste-subtitle-text').value,title=e.$('paste-subtitle-title').value,workspace=e.w.document.body.dataset.workspace;
  if(['close-reopen','edit'].includes(action))e.$('paste-subtitle-text').focus();else if(action==='navigation'){e.$('ai-question').value='A newer B question';e.$('ai-question').focus();}
  const focused=e.w.document.activeElement,notice=e.$('notice').textContent,open=e.$('paste-subtitle-dialog').open;
  e.saves.writes[0].commit();await submitted;
  assert.equal(e.active(),active);assert.equal(e.w.document.body.dataset.workspace,workspace);assert.equal(e.$('paste-subtitle-dialog').open,open);
  assert.equal(e.$('paste-subtitle-text').value,draft);assert.equal(e.$('paste-subtitle-title').value,title);assert.equal(e.w.document.activeElement,focused);assert.equal(e.$('notice').textContent,notice);
  assert.ok(e.stored().documents.some(doc=>doc.key===pasted.key),'accepted document remains durably saved even when its UI owner retires');
  if(fileImport){await until(()=>e.saves.writes.length===2);e.saves.writes[1].commit();await fileImport;assert.equal(e.active().title,'New file');assert.equal(e.$('paste-subtitle-text').value,draft);}
  if(action==='close'||action==='escape'){e.open();assertDraft(e,srt,'Pasted source');}
 }finally{await e.close();}
});
for(const action of ['close','escape','edit','clear','navigation','new-file'])test('late paste digest is fenced before admission after '+action,async()=>{
 const e=setup({documents:[base('a'),base('b')]});try{
  await validPreview(e);e.holdDigests();const submitted=e.submit();await until(()=>e.digests.length===1);assert.equal(e.docs().length,2);assert.equal(e.saves.prepares,0);
  if(action==='close')e.$('close-paste-subtitle').click();
  if(action==='escape')e.$('paste-subtitle-dialog').dispatchEvent(new e.w.Event('cancel',{cancelable:true}));
  if(action==='edit'){e.change('paste-subtitle-title','New draft');e.change('paste-subtitle-text',srt.replace('Second cue','New draft cue'));}
  if(action==='clear')e.$('clear-paste-subtitle').click();
  if(action==='navigation')e.w.document.querySelector('.library-entry[data-document-key="b"] .library-open').click();
  e.holdDigests(false);
  if(action==='new-file')await e.choose('New file.srt',srt.replace('Second cue','New file cue'));
  const prior=plain(e.docs()),active=e.active(),draft=e.$('paste-subtitle-text').value,title=e.$('paste-subtitle-title').value,notice=e.$('notice').textContent;
  await e.digests[0].release();await submitted;
  assert.deepEqual(plain(e.docs()),prior);assert.equal(e.active(),active);assert.equal(e.$('paste-subtitle-text').value,draft);assert.equal(e.$('paste-subtitle-title').value,title);assert.equal(e.$('notice').textContent,notice);
  assert.ok(e.docs().every(doc=>doc.title!=='Pasted source'));assert.deepEqual(e.network,[]);
 }finally{await e.close();}
});
test('close, Escape, add/read navigation and a new import preserve page-local draft; only explicit Clear discards it',async()=>{
 const e=setup({documents:[base('keep')]});try{
  e.fill(vtt,'Unsubmitted draft','vtt');assert.equal(e.unload(),true);e.$('close-paste-subtitle').click();assert.equal(e.$('paste-subtitle-dialog').open,false);assert.equal(e.unload(),true);
  e.open();assertDraft(e,vtt,'Unsubmitted draft');assert.equal(e.$('paste-subtitle-format').value,'vtt');
  e.$('paste-subtitle-dialog').dispatchEvent(new e.w.Event('cancel',{cancelable:true}));assert.equal(e.$('paste-subtitle-dialog').open,false);assert.equal(e.unload(),true);
  e.$('add-content').click();e.$('back-reading').click();e.open();assertDraft(e,vtt,'Unsubmitted draft');
  await e.choose('Other.srt',srt);assert.equal(e.$('paste-subtitle-dialog').open,false);e.open();assertDraft(e,vtt,'Unsubmitted draft');assert.equal(e.unload(),true);
  e.$('clear-paste-subtitle').click();assert.equal(e.$('paste-subtitle-text').value,'');assert.equal(e.$('paste-subtitle-title').value,'');assert.equal(e.$('paste-subtitle-preview').textContent,'');assert.equal(e.$('confirm-paste-subtitle').disabled,true);assert.equal(e.unload(),false);
  assert.equal(e.docs().length,2);assert.equal(e.docs().find(d=>d.key==='keep').notes.one,'Existing keep note');
 }finally{await e.close();}
});
test('a title-only draft synchronously guards unloading without performing an import',async()=>{
 const e=setup();try{
  assert.equal(e.unload(),false);e.open();e.change('paste-subtitle-title','A title before pasting');assert.equal(e.unload(),true);assert.equal(e.docs().length,0);assert.equal(e.saves.prepares,0);
  e.$('close-paste-subtitle').click();assert.equal(e.unload(),true);e.open();e.$('clear-paste-subtitle').click();assert.equal(e.unload(),false);
 }finally{await e.close();}
});
test('failed save preserves full unsaved document and draft, exports a clean JSON rescue, and restores it in a fresh library',async()=>{
 const e=setup({documents:[base('keep')],held:true});let restored;try{
  await validPreview(e,vtt,'Rescue voices','vtt');const submitted=e.submit();await until(()=>e.saves.writes.length===1);e.saves.writes[0].fail();await submitted;
  assert.equal(e.active().key,'keep');assert.equal(e.$('paste-subtitle-dialog').open,true);assertDraft(e,vtt,'Rescue voices');assert.equal(e.$('save-status').dataset.state,'failed');assert.equal(e.unload(),true);
  for(const id of ['retry-paste-subtitle','read-paste-subtitle','export-paste-subtitle'])assert.equal(e.$(id).hidden,false,id+' must remain available');
  const pending=e.docs().find(doc=>doc.title==='Rescue voices');assert.ok(pending);assert.equal(e.stored().documents.length,1);
  e.$('export-paste-subtitle').click();assert.equal(e.downloads.length,1);const text=await e.downloads[0].text(),backup=JSON.parse(text),rescued=backup.documents?backup.documents.find(doc=>doc.key===pending.key):backup;
  assert.deepEqual(plain(C.validate(rescued)),plain(C.validate(pending)));assert.equal(rescued.segments[0].speaker,'Alice & Bob');
  for(const key of ['diagnostics','bytes','status','owner','revision','rawText','draft','preview'])assert.equal(Object.hasOwn(rescued,key),false,'UI-only state '+key+' must not leak to backup');
  assert.equal(e.unload(),true);assert.equal(e.$('save-status').dataset.state,'failed');assertDraft(e,vtt,'Rescue voices');
  restored=setup();await restored.choose('rescue.json',text,backup.format==='coconut-library'?'library-file':'file');
  assert.equal(restored.docs().length,1);assert.deepEqual(plain(C.validate(restored.docs()[0])),plain(C.validate(pending)));assert.equal(restored.$('save-status').dataset.state,'saved');assert.equal(restored.unload(),false);
 }finally{await e.close();await restored?.close();}
});
test('retry uses the existing unsaved identity and only opens it after the retry receipt is durable',async()=>{
 const e=setup({documents:[base('keep')],held:true});try{
  await validPreview(e);const submitted=e.submit();await until(()=>e.saves.writes.length===1);e.saves.writes[0].fail();await submitted;
  const pending=e.docs().find(doc=>doc.title==='Pasted source'),key=pending.key;const retry=e.$('retry-paste-subtitle').onclick();await until(()=>e.saves.writes.length===2);
  assert.equal(e.active().key,'keep');assert.equal(e.docs().length,2);assert.equal(e.$('save-status').dataset.state,'pending');assertDraft(e,srt,'Pasted source');
  const repeated=e.$('retry-paste-subtitle').onclick();await repeated;assert.equal(e.saves.writes.length,2);
  e.saves.writes[1].commit();await retry;assert.equal(e.active().key,key);assert.equal(e.docs().length,2);assert.equal(e.$('paste-subtitle-dialog').open,false);assert.equal(e.$('paste-subtitle-text').value,'');assert.equal(e.unload(),false);
  assert.equal(e.stored().documents.filter(doc=>doc.key===key).length,1);
 }finally{await e.close();}
});
test('read-this-page recovery opens unsaved text without claiming persistence or discarding the pasted draft',async()=>{
 const e=setup({documents:[base('keep')],held:true});try{
  await validPreview(e);const submitted=e.submit();await until(()=>e.saves.writes.length===1);e.saves.writes[0].fail();await submitted;
  e.$('read-paste-subtitle').click();assert.equal(e.active().title,'Pasted source');assert.equal(e.$('paste-subtitle-dialog').open,false);assert.equal(e.$('save-status').dataset.state,'failed');assert.equal(e.unload(),true);
  assert.equal(e.stored().documents.length,1);e.open();assertDraft(e,srt,'Pasted source');
 }finally{await e.close();}
});
test('late retry receipt cannot overwrite a newer paste draft or navigate away from another document',async()=>{
 const e=setup({documents:[base('a'),base('b')],held:true});try{
  await validPreview(e);const submitted=e.submit();await until(()=>e.saves.writes.length===1);e.saves.writes[0].fail();await submitted;
  const retry=e.$('retry-paste-subtitle').onclick();await until(()=>e.saves.writes.length===2);
  e.$('close-paste-subtitle').click();e.w.document.querySelector('.library-entry[data-document-key="b"] .library-open').click();e.open();e.change('paste-subtitle-title','Newer pasted title');e.change('paste-subtitle-text',vtt);e.$('paste-subtitle-text').focus();
  const focused=e.w.document.activeElement,notice=e.$('notice').textContent;e.saves.writes[1].commit();await retry;
  assert.equal(e.active().key,'b');assertDraft(e,vtt,'Newer pasted title');assert.equal(e.$('paste-subtitle-dialog').open,true);assert.equal(e.w.document.activeElement,focused);assert.equal(e.$('notice').textContent,notice);assert.equal(e.unload(),true);
 }finally{await e.close();}
});
test('a failed late receipt keeps its unsaved document but does not replace newer draft feedback',async()=>{
 const e=setup({documents:[base('keep')],held:true});try{
  await validPreview(e);const submitted=e.submit();await until(()=>e.saves.writes.length===1);
  e.change('paste-subtitle-text',vtt);e.change('paste-subtitle-title','New draft');e.preview();
  const status=e.$('paste-subtitle-status').textContent,preview=e.$('paste-subtitle-preview').textContent;
  e.saves.writes[0].fail();await submitted;
  assert.equal(e.active().key,'keep');assertDraft(e,vtt,'New draft');assert.equal(e.$('paste-subtitle-status').textContent,status);assert.equal(e.$('paste-subtitle-preview').textContent,preview);
  assert.equal(e.docs().find(doc=>doc.title==='Pasted source').segments[0].text,C.parse(srt,'Pasted source.srt').segments[0].text);assert.equal(e.$('save-status').dataset.state,'failed');assert.equal(e.unload(),true);
 }finally{await e.close();}
});
test('opening paste retires an older local-file byte read without letting it overwrite the new pasted source',async()=>{
 const e=setup();try{
  let release;const file=new e.w.File([srt],'Late file.srt');file.arrayBuffer=()=>new Promise(resolve=>release=resolve);
  Object.defineProperty(e.$('file'),'files',{configurable:true,value:[file]});const imported=e.$('file').onchange();await until(()=>!!release);
  await validPreview(e,vtt,'Current paste');await e.submit();const current=plain(e.active());
  release(new TextEncoder().encode(srt).buffer);await imported;
  assert.equal(e.docs().length,1);assert.deepEqual(plain(e.active()),current);assert.equal(e.active().title,'Current paste');assert.equal(e.$('subtitle-encoding-dialog').open,false);assert.deepEqual(e.network,[]);
 }finally{await e.close();}
});
test('a local-file digest cannot admit old text after the pasted import has claimed ownership',async()=>{
 const e=setup();try{
  e.holdDigests();const imported=e.choose('Late file.srt',srt);await until(()=>e.digests.length===1);e.holdDigests(false);
  await validPreview(e,vtt,'Current paste');await e.submit();const current=plain(e.active());await e.digests[0].release();await imported;
  assert.equal(e.docs().length,1);assert.deepEqual(plain(e.active()),current);assert.equal(e.active().title,'Current paste');
 }finally{await e.close();}
});
test('a local-file late durable receipt cannot clear, focus, or submit a newer pasted draft',async()=>{
 const e=setup({documents:[base('keep')],held:true});try{
  const imported=e.choose('Earlier file.srt',srt);await until(()=>e.saves.writes.length===1);
  await validPreview(e,vtt,'New paste draft','vtt');e.$('paste-subtitle-text').focus();const active=e.active(),notice=e.$('notice').textContent;
  e.saves.writes[0].commit();await imported;
  assert.equal(e.active(),active);assertDraft(e,vtt,'New paste draft');assert.equal(e.$('paste-subtitle-dialog').open,true);assert.equal(e.w.document.activeElement,e.$('paste-subtitle-text'));assert.equal(e.$('notice').textContent,notice);assert.equal(e.docs().length,2);
 }finally{await e.close();}
});

test('long cue preview is visibly abbreviated but import and export preserve its full text',async()=>{
 const e=setup();try{
  const source='Authored long cue '+('🌿 multilingual 你好。'.repeat(700))+' END-OF-AUTHORED-CUE';
  const text='1\n00:00:00,001 --> 00:00:12,999\n'+source;
  await validPreview(e,text,'Long pasted cue');assert.match(e.$('paste-subtitle-preview').textContent,/预览截短/);assert.doesNotMatch(e.$('paste-subtitle-preview').textContent,/END-OF-AUTHORED-CUE/);
  assert.ok(e.$('paste-subtitle-preview').textContent.length<1500);assert.doesNotMatch(e.$('paste-subtitle-preview').textContent,/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  await e.submit();assert.equal(e.active().segments[0].text,source);e.$('export').click();const backup=JSON.parse(await e.downloads.at(-1).text());assert.equal(backup.segments[0].text,source);
 }finally{await e.close();}
});
test('an over-byte-budget DOM draft is retained but cannot preview, save, or contact a server',async()=>{
 const e=setup({documents:[base('keep')]});try{
  const text='1\n00:00:00,000 --> 00:00:01,000\n'+'界'.repeat(5*1024*1024),prior=JSON.stringify(e.docs());
  e.fill(text,'Oversized source');assert.equal(e.saves.prepares,0);e.preview();assert.match(e.$('paste-subtitle-status').textContent,/15 MiB/);assert.equal(e.$('confirm-paste-subtitle').disabled,true);assert.equal(e.$('paste-subtitle-text').value,text);
  assert.equal(JSON.stringify(e.docs()),prior);assert.equal(e.saves.prepares,0);assert.equal(e.unload(),true);assert.deepEqual(e.network,[]);
 }finally{await e.close();}
});
test('new pasted submit can supersede an accepted held save, and only its own receipt clears the new draft',async()=>{
 const e=setup({documents:[base('keep')],held:true});try{
  await validPreview(e,srt,'First paste');const first=e.submit();await until(()=>e.saves.writes.length===1);
  e.change('paste-subtitle-text',vtt);e.change('paste-subtitle-title','Second paste');e.preview();const second=e.submit();await until(()=>e.docs().length===3);
  const newerStatus=e.$('paste-subtitle-status').textContent;e.saves.writes[0].commit();await first;await until(()=>e.saves.writes.length===2);
  assert.equal(e.active().key,'keep');assertDraft(e,vtt,'Second paste');assert.equal(e.$('paste-subtitle-dialog').open,true);assert.equal(e.$('paste-subtitle-status').textContent,newerStatus);
  assert.equal(e.$('confirm-paste-subtitle').disabled,true);e.saves.writes[1].commit();await second;
  assert.equal(e.active().title,'Second paste');assert.equal(e.$('paste-subtitle-text').value,'');assert.equal(e.$('paste-subtitle-dialog').open,false);assert.equal(e.stored().documents.length,3);assert.equal(e.unload(),false);
 }finally{await e.close();}
});
test('repeated retry failures preserve the recovery identity and draft until a successful final receipt',async()=>{
 const e=setup({held:true});try{
  await validPreview(e);const first=e.submit();await until(()=>e.saves.writes.length===1);e.saves.writes[0].fail();await first;
  const identity=e.docs()[0];const retry=e.$('retry-paste-subtitle').onclick();await until(()=>e.saves.writes.length===2);e.saves.writes[1].fail('denied');await retry;
  assert.equal(e.docs().length,1);assert.equal(e.docs()[0],identity);assertDraft(e,srt,'Pasted source');assert.equal(e.$('retry-paste-subtitle').disabled,false);assert.equal(e.$('export-paste-subtitle').hidden,false);assert.equal(e.unload(),true);
  const final=e.$('retry-paste-subtitle').onclick();await until(()=>e.saves.writes.length===3);e.saves.writes[2].commit();await final;
  assert.equal(e.active(),identity);assert.equal(e.$('save-status').dataset.state,'saved');assert.equal(e.$('paste-subtitle-text').value,'');assert.equal(e.unload(),false);
 }finally{await e.close();}
});
test('JSON rescue after read-in-page includes newly authored notes and corrected source text',async()=>{
 const e=setup({held:true});let restored;try{
  await validPreview(e);const first=e.submit();await until(()=>e.saves.writes.length===1);e.saves.writes[0].fail();await first;
  e.$('read-paste-subtitle').click();e.$('mode-transcript').click();const row=e.w.document.querySelector('.segment');row.querySelector('.note-button').click();e.$('note').value=note;e.$('note').dispatchEvent(new e.w.Event('input',{bubbles:true}));e.$('close-note').click();
  row.querySelector('.edit-button').click();e.$('edit-segment').value='Corrected authored source text';e.$('save-edit').click();const flushing=e.w.flushContentForTest();await until(()=>e.saves.writes.length===2);e.saves.writes[1].fail();await flushing;
  const current=plain(e.active());e.open();e.$('export-paste-subtitle').click();const json=await e.downloads.at(-1).text(),backup=JSON.parse(json);
  assert.equal(backup.notes['segment-1'],note);assert.equal(backup.segments[0].text,'Corrected authored source text');assert.equal(backup.segments[0].original_text,C.parse(srt,'source.srt').segments[0].text);assert.equal(e.unload(),true);
  restored=setup();await restored.choose('rescued.json',json);assert.deepEqual(plain(C.validate(restored.active())),plain(C.validate(current)));assert.equal(restored.unload(),false);
 }finally{await e.close();await restored?.close();}
});

for(const ending of ['00:00:03,000','00:00:03,000 -','00:03'])test('a lone start cannot disappear beside a valid pasted cue: '+ending,async()=>{
 const text='1\n00:00:01,000 --> 00:00:02,000\nSaved first cue\n\n2\n'+ending+'\nDo not silently omit this cue';
 assert.throws(()=>C.parsePastedSubtitles(text),/第 6 行.*起止时间/);
 const e=setup({documents:[base('keep')]});try{
  const before=JSON.stringify(e.docs());e.fill(text,'Incomplete pasted source');e.preview();
  assert.equal(e.$('confirm-paste-subtitle').disabled,true);assert.match(e.$('paste-subtitle-status').textContent,/第 6 行.*起止时间/);
  assert.equal(JSON.stringify(e.docs()),before);assertDraft(e,text,'Incomplete pasted source');assert.equal(e.saves.prepares,0);
 }finally{await e.close();}
});

test('pasted retry opens its truly committed IndexedDB target while an independent document remains conflicted',async()=>{
 // Real production provider, adapter, and store; only IndexedDB transaction
 // scheduling is doubled. Neither commit receipts nor retry results are faked.
 const [{transactionDouble},{default:provider},{default:storeModule},{default:documentModule}]=await Promise.all([
  import('./helpers/indexeddb-transaction-double.mjs'),import('../reader/storage-provider.js'),
  import('../reader/library-store.js'),import('../reader/indexeddb-document-adapter.js'),
 ]);
 const engine=transactionDouble(),values=new Map([[KEY,JSON.stringify({documents:[base('a')],active:'a'})]]);
 const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
 const initialize=()=>provider.initialize({indexedDB:engine.indexedDB,getStorage:()=>storage,validate:C.validate,legacyModule:storeModule,documentModule});
 const local=await initialize(),remote=await initialize();assert.equal(local.backend,'indexeddb');assert.equal(remote.backend,'indexeddb');
 const w=new Window({url:'https://coconut.example/'});let reloaded;
 try{
  w.document.body.innerHTML=fs.readFileSync(new URL('reader/compatibility.html',root),'utf8').split('<body>')[1].split('</body>')[0];
  Object.defineProperty(w,'crypto',{value:webcrypto});const network=[];w.fetch=url=>{network.push(String(url));throw Error('Pasted retry must remain offline');};
  w.CoconutStorageBootstrap={phase:'ready',result:local};w.eval(fs.readFileSync(new URL('reader/library-store.js',root),'utf8'));
  const create=w.CoconutLibraryStore.create,retries=[];
  w.CoconutLibraryStore.create=options=>{const store=create({...options,...saveClock()});return {...store,retry:async key=>{
   const result=await store.retry(key);retries.push({key,result});return result;
  }};};
  w.eval(['summary','core','passages','passage-playback','app','language','translation-review','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+'\nwindow.pastedIDBTest={docs:()=>state.documents,active:()=>active(),store:libraryStore};');
  const $=id=>w.document.getElementById(id),store=w.pastedIDBTest.store;
  // A and newly pasted B first fail together for a real transaction quota
  // error. Independent dirty identities are not an explicit atomic group.
  $('mode-transcript').click();w.document.querySelector('.note-button').click();$('note').value='Local unsaved A';$('note').dispatchEvent(new w.Event('input',{bubbles:true}));$('close-note').click();
  $('paste-subtitles').click();$('paste-subtitle-title').value='Independent pasted B';$('paste-subtitle-title').dispatchEvent(new w.Event('input',{bubbles:true}));
  $('paste-subtitle-text').value=vtt;$('paste-subtitle-text').dispatchEvent(new w.Event('input',{bubbles:true}));$('preview-paste-subtitle').click();
  assert.equal($('confirm-paste-subtitle').disabled,false);engine.control.failMutation=1;await $('confirm-paste-subtitle').onclick();
  const a=w.pastedIDBTest.docs().find(doc=>doc.key==='a'),b=w.pastedIDBTest.docs().find(doc=>doc.title==='Independent pasted B');assert.ok(b);
  assert.equal(store.status(a.key).error.code,'quota');assert.equal(store.status(b.key).error.code,'quota');assert.equal($('paste-subtitle-dialog').open,true);assert.equal($('retry-paste-subtitle').hidden,false);
  const rows=()=>engine.rows(provider.NAME).get('documents');assert.equal(rows().has(b.key),false);assert.equal(rows().get(a.key).payload.notes.one,'Existing a note');
  // A second real store now advances A's CAS token while the first window
  // retains its original token and unsaved local note.
  const remoteA=remote.loaded.documents[0],remoteStore=storeModule.create({adapter:remote.adapter,getDocuments:()=>remote.loaded.documents,...saveClock()});
  remoteA.notes.one='Remote durable A';const remoteTicket=remoteStore.queueDocument(remoteA.key,remoteA);assert.equal((await remoteStore.flush()).ok,true);assert.equal((await remoteTicket.committed).ok,true);
  engine.control.holdAbortEvents=true;const retry=$('retry-paste-subtitle').onclick();await engine.tick();
  assert.equal(engine.control.abortEvents.length,1,'mixed A+B retry encounters an actual stale-token transaction abort');
  assert.equal(rows().has(b.key),false);assert.equal(w.pastedIDBTest.active().key,'a');
  engine.control.holdNextWrite=true;engine.control.abortEvents.shift()();await engine.tick();
  assert.equal(store.status(a.key).status,'conflict');assert.equal(store.status(b.key).status,'pending');assert.equal(engine.control.held.length,1);
  assert.equal(rows().has(b.key),false,'successful requests are not durable before transaction complete');assert.equal($('paste-subtitle-dialog').open,true);assert.equal($('paste-subtitle-text').value,vtt);assert.equal(w.pastedIDBTest.active().key,'a');
  engine.control.held.shift().complete();await retry;
  assert.equal(retries.length,1);assert.equal(retries[0].key,b.key,'dedicated recovery names exactly the pasted target');
  assert.equal(retries[0].result.ok,false,'the genuine aggregate remains false because A is conflicted');
  assert.equal(store.status(a.key).status,'conflict');assert.equal(store.status(b.key).status,'saved');assert.equal(store.status(b.key).identity,b);
  assert.deepEqual(plain(rows().get(b.key).payload),plain(b));assert.equal(rows().get(a.key).payload.notes.one,'Remote durable A');
  assert.equal(w.pastedIDBTest.active(),b);assert.equal($('paste-subtitle-dialog').open,false);assert.equal($('paste-subtitle-text').value,'');assert.equal($('paste-subtitle-title').value,'');
  assert.doesNotMatch($('paste-subtitle-status').textContent,/保存仍未成功/);assert.equal($('save-status').dataset.state,'failed','the global warning still truthfully protects A');
  assert.deepEqual(plain(store.snapshotForExport().documents.map(doc=>[doc.key,doc.notes.one])),[['a','Local unsaved A']]);
  const unload=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true,'clearing saved paste does not remove A recovery protection');
  reloaded=await initialize();assert.equal(reloaded.ok,true);assert.equal(reloaded.loaded.documents.find(doc=>doc.key==='a').notes.one,'Remote durable A');assert.deepEqual(plain(reloaded.loaded.documents.find(doc=>doc.key===b.key)),plain(b));assert.deepEqual(network,[]);
 }finally{
  engine.control.holdAbortEvents=false;for(const abort of engine.control.abortEvents.splice(0))abort();for(const held of engine.control.held.splice(0))held.complete();
  await w.happyDOM.close();local.adapter.close();remote.adapter.close();reloaded?.adapter.close();
 }
});

test('held pasted retry cannot reclaim a selection changed independently of the local-import revision',async()=>{
 const e=setup({documents:[base('a'),base('b')],held:true});try{
  await validPreview(e);const submitted=e.submit();await until(()=>e.saves.writes.length===1);e.saves.writes[0].fail();await submitted;
  const pasted=e.docs().find(doc=>doc.title==='Pasted source'),retry=e.$('retry-paste-subtitle').onclick();await until(()=>e.saves.writes.length===2);
  const previous=e.w.pasteTest.owner();
  // Model an already admitted asynchronous reader selection. Invoke actual
  // production selection/render code without cancelLocalImports, so a test
  // cannot accidentally pass using only its older import-revision fence.
  e.w.pasteTest.select('b');
  const current=e.w.pasteTest.owner();
  assert.equal(current.imports,previous.imports);assert.notEqual(current.selection,previous.selection);assert.equal(e.active().key,'b');assert.equal(e.$('paste-subtitle-dialog').open,true);
  e.$('paste-subtitle-text').focus();const focused=e.w.document.activeElement,notice=e.$('notice').textContent,title=e.$('title').textContent;
  e.saves.writes[1].commit();await retry;
  assert.equal(e.saves.store.status(pasted.key).status,'saved');assert.ok(e.stored().documents.some(doc=>doc.key===pasted.key));
  assert.equal(e.active().key,'b');assert.equal(e.$('title').textContent,title);assert.equal(e.$('paste-subtitle-dialog').open,true);assertDraft(e,srt,'Pasted source');assert.equal(e.w.document.activeElement,focused);assert.equal(e.$('notice').textContent,notice);assert.equal(e.unload(),true);
 }finally{await e.close();}
});

// Happy DOM has no native layout or Tab traversal. These explicit geometry
// doubles exercise the production focusin handler after a controlled RAF;
// the full ring, hit testing, and native keyboard journey remain browser CI.
function pastedFocusLayout(e,{top=18.640625,height=160,dialogTop=16,dialogHeight=812,viewportHeight=844,paddingTop=12,paddingBottom=12,outlineWidth=3,outlineOffset=3,outlineStyle='solid'}={}){
 const dialog=e.$('paste-subtitle-dialog'),target=e.$('paste-subtitle-text'),frames=new Map(),writes=[],scrollCalls=[],intoViewCalls=[];
 const initialScroll=100;let scrollTop=initialScroll,frameId=0;
 Object.defineProperty(dialog,'scrollTop',{configurable:true,get:()=>scrollTop,set:value=>{writes.push(value);scrollTop=Math.max(0,value);}});
 Object.defineProperty(dialog,'clientTop',{configurable:true,value:1});
 Object.defineProperty(dialog,'clientHeight',{configurable:true,value:dialogHeight-2});
 Object.defineProperty(e.w,'innerWidth',{configurable:true,value:390});
 Object.defineProperty(e.w,'innerHeight',{configurable:true,value:viewportHeight});
 dialog.getBoundingClientRect=()=>new e.w.DOMRect(16,dialogTop,358,dialogHeight);
 dialog.style.scrollPaddingTop=paddingTop+'px';dialog.style.scrollPaddingBottom=paddingBottom+'px';
 const rectangles=new Map();
 const place=(node,y,h=44)=>rectangles.set(node,{top:y+scrollTop,height:h});
 for(const node of dialog.querySelectorAll('button,input,select,textarea,summary')){
  node.style.outlineWidth=outlineWidth+'px';node.style.outlineOffset=outlineOffset+'px';node.style.outlineStyle=outlineStyle;
  place(node,200);
  node.getBoundingClientRect=()=>{const rect=rectangles.get(node);return new e.w.DOMRect(35,rect.top-scrollTop,320,rect.height);};
 }
 place(target,top,height);
 e.w.requestAnimationFrame=callback=>{frames.set(++frameId,callback);return frameId;};
 e.w.cancelAnimationFrame=id=>frames.delete(id);
 e.w.scrollTo=(...args)=>scrollCalls.push(args);
 e.w.HTMLElement.prototype.scrollIntoView=function(...args){intoViewCalls.push({node:this,args});};
 e.w.document.body.scrollTop=77;e.w.document.documentElement.scrollTop=91;
 const takeFrame=()=>{const pending=[...frames.values()];frames.clear();return()=>{for(const callback of pending)callback(0);};};
 const flush=()=>takeFrame()();
 const assertLocal=()=>{
  assert.deepEqual(scrollCalls,[],'focus correction must not scroll the window');
  assert.deepEqual(intoViewCalls,[],'focus correction must not invoke scrollIntoView');
  assert.equal(e.w.document.body.scrollTop,77);assert.equal(e.w.document.documentElement.scrollTop,91);
 };
 return {dialog,target,writes,place,takeFrame,flush,assertLocal,pending:()=>frames.size,
  clip:()=>({top:Math.max(0,dialogTop+1),bottom:Math.min(viewportHeight,dialogTop+dialogHeight-1)})};
}

for(const fixture of [
 {name:'exact 390px reverse-Tab failure',top:18.640625,height:160,expectedScroll:89},
 {name:'fractional bottom-edge focus ring',top:665.359375,height:160,expectedScroll:111},
 {name:'viewport-clipped dialog top',top:4.640625,height:160,dialogTop:-20,dialogHeight:884,expectedScroll:92},
 {name:'viewport-clipped dialog bottom',top:681.359375,height:160,dialogTop:-20,dialogHeight:884,expectedScroll:110},
])test('pasted focusin corrects '+fixture.name+' using only its dialog scroll after RAF',async()=>{
 const e=setup();try{
  const g=pastedFocusLayout(e,fixture);let focused=false;
  g.dialog.addEventListener('focusin',event=>{if(event.target===g.target)focused=true;});
  e.open();assert.equal(focused,true,'the production listener receives a real DOM focus event');assert.equal(e.w.document.activeElement,g.target);
  assert.ok(g.pending()>0);assert.deepEqual(g.writes,[],'native focus gets the frame before any correction');
  const before=g.target.getBoundingClientRect(),clip=g.clip(),ring=6;
  assert.ok(before.top-ring<clip.top||before.bottom+ring>clip.bottom,'fixture reproduces a clipped full focus ring');
  g.flush();assert.deepEqual(g.writes,[fixture.expectedScroll],'fractional correction rounds outwards, without over-scrolling');
  const after=g.target.getBoundingClientRect();
  assert.ok(after.top>=clip.top+12);assert.ok(after.bottom<=clip.bottom-12);
  assert.ok(after.top-ring>=clip.top);assert.ok(after.bottom+ring<=clip.bottom);
  assert.equal(after.width,320);assert.equal(after.height,160);assert.equal(e.w.document.activeElement,g.target);g.assertLocal();
 }finally{await e.close();}
});

test('pasted focusin leaves an already-safe complete target exactly where it is',async()=>{
 const e=setup();try{
  const g=pastedFocusLayout(e,{top:29,height:786});e.open();g.flush();
  assert.deepEqual(g.writes,[]);assert.equal(g.dialog.scrollTop,100);
  assert.equal(g.target.getBoundingClientRect().top,29);assert.equal(g.target.getBoundingClientRect().bottom,815);g.assertLocal();
 }finally{await e.close();}
});

test('pasted focusin reads the actual post-native-focus geometry in its RAF',async()=>{
 const e=setup();try{
  const g=pastedFocusLayout(e,{top:200});e.open();assert.ok(g.pending()>0);
  // A browser may scroll during native focus after the event handler returns.
  // Move the supplied layout before RAF, rather than freezing an event-time box.
  g.place(g.target,18.640625,160);g.flush();
  assert.deepEqual(g.writes,[89]);assert.equal(g.target.getBoundingClientRect().top,29.640625);g.assertLocal();
 }finally{await e.close();}
});

for(const fixture of [
 {name:'a wider outline plus positive offset',top:28,paddingTop:4,paddingBottom:4,outlineWidth:5,outlineOffset:9,expectedScroll:95,expectedTop:33},
 {name:'negative outline offsets without reducing the width',top:20,paddingTop:0,paddingBottom:0,outlineWidth:3,outlineOffset:-3,expectedScroll:98,expectedTop:22},
 {name:'no visible outline',outlineStyle:'none',expectedScroll:100,expectedTop:18.640625},
 {name:'zero outline width and offset',outlineWidth:0,outlineOffset:0,expectedScroll:100,expectedTop:18.640625},
])test('pasted focusin respects '+fixture.name,async()=>{
 const e=setup();try{
  const g=pastedFocusLayout(e,fixture);e.open();g.flush();
  assert.deepEqual(g.writes,fixture.expectedScroll===100?[]:[fixture.expectedScroll]);
  assert.equal(g.dialog.scrollTop,fixture.expectedScroll);assert.equal(g.target.getBoundingClientRect().top,fixture.expectedTop);g.assertLocal();
 }finally{await e.close();}
});

for(const action of ['newer focus','closed dialog','target moved to another dialog'])test('late pasted focusin RAF cannot scroll after '+action,async()=>{
 const e=setup();try{
  const g=pastedFocusLayout(e);e.open();assert.ok(g.pending()>0);const lateFrame=g.takeFrame();
  if(action==='newer focus')e.$('paste-subtitle-title').focus();
  if(action==='closed dialog'){e.$('close-paste-subtitle').click();assert.equal(g.dialog.open,false);}
  if(action==='target moved to another dialog'){
   const other=e.w.document.createElement('dialog');e.w.document.body.append(other);other.append(g.target);other.showModal();g.target.focus();
   assert.equal(e.w.document.activeElement,g.target,'the target still owns focus, but no longer belongs to the paste dialog');
   assert.equal(g.dialog.open,true);assert.equal(g.target.closest('dialog'),other);
  }
  const focused=e.w.document.activeElement;lateFrame();
  assert.deepEqual(g.writes,[]);assert.equal(g.dialog.scrollTop,100);assert.equal(e.w.document.activeElement,focused);g.assertLocal();
  if(action==='newer focus'){g.flush();assert.deepEqual(g.writes,[],'the newer safe target needs no correction either');}
 }finally{await e.close();}
});

test('pasted focus scrolling preserves native interior Tab and traps only current modal boundaries',async()=>{
 const e=setup();try{
  const g=pastedFocusLayout(e,{top:200});e.open();g.flush();
  const tab=(id,shiftKey=false)=>{const node=e.$(id);node.focus();const event=new e.w.KeyboardEvent('keydown',{key:'Tab',shiftKey,bubbles:true,cancelable:true});node.dispatchEvent(event);return event;};
  // Happy DOM does not traverse on an unhandled Tab. Assert the application
  // leaves those events untouched; native traversal itself is a browser gate.
  for(const id of ['paste-subtitle-title','paste-subtitle-format','paste-subtitle-text','preview-paste-subtitle'])for(const shift of [false,true]){
   assert.equal(tab(id,shift).defaultPrevented,false,id+' interior Tab stays native');assert.equal(e.w.document.activeElement,e.$(id));
  }
  assert.equal(tab('close-paste-subtitle',true).defaultPrevented,true);assert.equal(e.w.document.activeElement,e.$('clear-paste-subtitle'));
  assert.equal(tab('clear-paste-subtitle').defaultPrevented,true);assert.equal(e.w.document.activeElement,e.$('close-paste-subtitle'));
  e.change('paste-subtitle-text',srt);e.preview();assert.equal(e.$('confirm-paste-subtitle').disabled,false);
  assert.equal(tab('clear-paste-subtitle').defaultPrevented,false,'a now-enabled confirm becomes the last boundary');
  assert.equal(tab('close-paste-subtitle',true).defaultPrevented,true);assert.equal(e.w.document.activeElement,e.$('confirm-paste-subtitle'));
  assert.equal(tab('confirm-paste-subtitle').defaultPrevented,true);assert.equal(e.w.document.activeElement,e.$('close-paste-subtitle'));
  g.flush();g.assertLocal();
 }finally{await e.close();}
});
