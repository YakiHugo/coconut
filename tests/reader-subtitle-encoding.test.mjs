/** Pure/DOM byte coverage only. Real picker, layout and IndexedDB are CI-only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {installSavePipeline} from './helpers/save-pipeline.mjs';
import {encodingFixtures,bytesFor} from './helpers/subtitle-encoding-fixtures.mjs';
const C=createRequire(import.meta.url)('../reader/core.js'),root=new URL('../',import.meta.url);
const fixture=name=>encodingFixtures.find(f=>f.name.startsWith(name));
const until=async condition=>{for(let i=0;i<100;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,1));}assert.ok(condition(),'condition did not settle');};
function setup(storage={}){
 const w=new Window({url:'https://coconut.example/'});w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});for(const [key,value] of Object.entries(storage))w.localStorage.setItem(key,value);
 const network=[];w.fetch=url=>{network.push(url);throw Error('No network permitted');};w.URL.createObjectURL=()=> 'blob:authored';w.URL.revokeObjectURL=()=>{};
 const saves=installSavePipeline(w);
 w.eval(['summary','core','passages','passage-playback','app'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+'\nwindow.encodingTest={docs:()=>state.documents,active:()=>active(),cancel:()=>cancelLocalImports()};');
 const $=id=>w.document.getElementById(id);
 const choose=(files,id='file')=>{Object.defineProperty($(id),'files',{configurable:true,value:files});return $(id).onchange();};
 const file=f=>new w.File([bytesFor(f)],f.name);
 return {w,$,saves,network,choose,file,docs:()=>w.encodingTest.docs(),active:()=>w.encodingTest.active()};
}
function preview(e,encoding){e.$('subtitle-encoding').value=encoding;e.$('subtitle-encoding').dispatchEvent(new e.w.Event('change'));}
async function accept(e,encoding){await until(()=>e.$('subtitle-encoding-dialog').open);preview(e,encoding);assert.equal(e.$('confirm-subtitle-encoding').disabled,false);e.$('confirm-subtitle-encoding').click();}
function snapshot(w){return Object.fromEntries(Array.from({length:w.localStorage.length},(_,i)=>{const key=w.localStorage.key(i);return [key,w.localStorage.getItem(key)];}));}
for(const f of encodingFixtures)test('real bytes decode '+f.name,()=>{
 const bytes=bytesFor(f),initial=C.decodeSubtitleBytes(bytes);
 assert.equal(initial.ok,!f.encoding);
 const decoded=f.encoding?C.decodeSubtitleBytes(bytes,f.encoding):initial;
 assert.equal(decoded.ok,true);assert.equal(decoded.text,f.text);
 const parsed=C.parse(decoded.text,f.name);assert.equal(parsed.segments[0].start,.125);assert.equal(parsed.segments[0].end,2.75);
 assert.equal(parsed.segments[0].text,f.text.trim().split('\r\n').slice(-2).join('\n'));
});
test('fatal bytes, BOM mismatch, unsupported label, NUL and literal replacement character have distinct results',()=>{
 for(const bytes of [[0xff,0xfe,0x31],[0xfe,0xff,0xd8,0],[0xff,0xfe,0,0xdc],[0xc3,0x28]])assert.equal(C.decodeSubtitleBytes(new Uint8Array(bytes)).ok,false);
 assert.match(C.decodeSubtitleBytes(bytesFor(fixture('utf16le')),'utf-16be').error,/BOM/);
 assert.match(C.decodeSubtitleBytes(bytesFor(fixture('utf8')),'arbitrary').error,/不支持/);
 assert.match(C.decodeSubtitleBytes(new Uint8Array([65,0,66])).error,/NUL/);
 assert.equal(C.decodeSubtitleBytes(new TextEncoder().encode('Actual � in source')).text,'Actual � in source');
 const old=global.TextDecoder;try{global.TextDecoder=class extends old{constructor(label,options){if(label==='gb18030')throw Error('Unavailable');super(label,options);}};assert.equal(C.subtitleEncodings().find(e=>e.id==='gb18030').available,false);assert.match(C.decodeSubtitleBytes(bytesFor(fixture('gb18030')),'gb18030').error,/当前浏览器不支持/);}finally{global.TextDecoder=old;}
});
for(const f of encodingFixtures)test('single-file original bytes, explicit preview if needed, save and JSON roundtrip '+f.name,async()=>{
 const e=setup();let restored;try{
  const pending=e.choose([e.file(f)]);
  if(f.encoding){await until(()=>e.$('subtitle-encoding-dialog').open);assert.equal(e.docs().length,0);assert.equal(e.$('confirm-subtitle-encoding').disabled,true);await accept(e,f.encoding);}
  await pending;assert.equal(e.docs().length,1);assert.equal(e.active().segments[0].text,C.parse(f.text,f.name).segments[0].text);assert.equal(e.$('save-status').dataset.state,'saved');
  e.w.document.querySelector('.note-button').click();e.$('note').value='Encoding recovery note';e.$('note').dispatchEvent(new e.w.Event('input'));await e.w.flushContentForTest();
  const exported=[];e.w.URL.createObjectURL=blob=>{exported.push(blob);return 'blob:export';};e.w.HTMLAnchorElement.prototype.click=function(){};e.$('export').click();
  restored=setup();await restored.choose([new restored.w.File([await exported.pop().text()],'backup.json')]);
  assert.equal(restored.active().segments[0].text,e.active().segments[0].text);assert.equal(restored.active().notes['segment-1'],'Encoding recovery note');assert.equal(restored.$('subtitle-encoding-dialog').open,false);
  assert.equal(e.network.length+restored.network.length,0);
 }finally{await e.w.happyDOM.close();await restored?.w.happyDOM.close();}
});
test('preview re-decodes retained bytes, renders source as text, rejects bad decoding and cancel keeps current notes',async()=>{
 const e=setup();try{
  await e.choose([e.file(fixture('utf8'))]);const before=JSON.stringify(e.active());
  const f=fixture('gb18030'),pending=e.choose([e.file(f)]);await until(()=>e.$('subtitle-encoding-dialog').open);
  preview(e,'utf-8');assert.equal(e.$('confirm-subtitle-encoding').disabled,true);assert.match(e.$('subtitle-encoding-status').textContent,/无法完整解码/);
  preview(e,'gb18030');assert.equal(e.$('subtitle-encoding-preview').textContent,f.text);assert.equal(JSON.stringify(e.active()),before);
  preview(e,'utf-16be');assert.equal(e.$('confirm-subtitle-encoding').disabled,true);
  preview(e,'gb18030');assert.equal(e.$('subtitle-encoding-preview').textContent,f.text);e.$('cancel-subtitle-encoding').click();await pending;assert.equal(JSON.stringify(e.active()),before);assert.equal(e.$('subtitle-encoding-preview').textContent,'');
  const bytes=Buffer.concat([Buffer.from('1\n00:00:00,000 --> 00:00:01,000\n<img src=x onerror=alert(1)>'),Buffer.from([0xe9])]);
  const html=e.choose([new e.w.File([bytes],'markup.srt')]);await until(()=>e.$('subtitle-encoding-dialog').open);preview(e,'windows-1252');assert.equal(e.$('subtitle-encoding-preview').querySelector('img'),null);assert.match(e.$('subtitle-encoding-preview').textContent,/<img/);e.$('cancel-subtitle-encoding').click();await html;
 }finally{await e.w.happyDOM.close();}
});
test('mixed batch waits for encoding, skip advances, Escape stops remaining and keeps saved rows',async()=>{
 const e=setup();try{
  const files=[e.file(fixture('utf8')),e.file(fixture('gb18030')),e.file(fixture('big5'))];const pending=e.choose(files);
  await until(()=>e.$('subtitle-encoding-dialog').open);assert.equal(e.docs().length,1);assert.equal(e.$('transcript-import-list').children[1].dataset.status,'encoding');
  e.$('cancel-subtitle-encoding').click();await until(()=>e.$('subtitle-encoding-file').textContent==='big5.vtt');assert.equal(e.$('transcript-import-list').children[1].dataset.status,'skipped');
  e.$('subtitle-encoding-dialog').dispatchEvent(new e.w.Event('cancel',{cancelable:true}));await pending;
  assert.equal(e.docs().length,1);assert.deepEqual(Array.from(e.$('transcript-import-list').children,r=>r.dataset.status),['saved','skipped','cancelled']);assert.equal(e.$('subtitle-encoding-dialog').open,false);
 }finally{await e.w.happyDOM.close();}
});
test('mixed batch confirms valid encodings, partial diagnostics remain separate and duplicate detection is unchanged',async()=>{
 const e=setup();try{
  const pending=e.choose([e.file(fixture('utf8')),e.file(fixture('gb18030')),e.file(fixture('big5'))]);await accept(e,'gb18030');await until(()=>e.$('subtitle-encoding-file').textContent==='big5.vtt');await accept(e,'big5');await pending;
  assert.equal(e.docs().length,3);assert.deepEqual(Array.from(e.$('transcript-import-list').children,r=>r.dataset.status),['saved','saved','saved']);
  const partial=Buffer.concat([bytesFor(fixture('gb18030')),Buffer.from('\r\n2\r\n00:00:03,000 -- 00:00:04,000\r\nBad timing\r\n')]);const attempt=e.choose([new e.w.File([partial],'gb18030.srt')]);await accept(e,'gb18030');await attempt;
  assert.match(e.$('notice').textContent,/部分字幕未导入/);assert.equal(e.$('transcript-import-list').children[0].dataset.parseState,'partial');assert.equal(e.docs().length,3);
 }finally{await e.w.happyDOM.close();}
});
test('new selection or navigation cancels old preview; late byte read never opens a dialog or saves',async()=>{
 const e=setup();try{
  let release;const f=e.file(fixture('gb18030'));f.arrayBuffer=()=>new Promise(resolve=>release=resolve);const pending=e.choose([f]);await until(()=>!!release);
  await e.choose([e.file(fixture('utf8'))]);release(Uint8Array.from(bytesFor(fixture('gb18030'))).buffer);await pending;
  assert.equal(e.$('subtitle-encoding-dialog').open,false);assert.equal(e.docs().length,1);
  const old=e.choose([e.file(fixture('big5'))]);await until(()=>e.$('subtitle-encoding-dialog').open);e.$('add-content').click();await old;assert.equal(e.$('subtitle-encoding-dialog').open,false);assert.equal(e.docs().length,1);
  const retired=e.choose([e.file(fixture('big5'))]);await until(()=>e.$('subtitle-encoding-dialog').open);const fresh=e.choose([e.file(fixture('gb18030'))]);await retired;await until(()=>e.$('subtitle-encoding-file').textContent==='gb18030.srt');e.$('subtitle-encoding-dialog').dispatchEvent(new e.w.Event('close'));assert.equal(e.$('subtitle-encoding-dialog').open,true);await accept(e,'gb18030');await fresh;assert.equal(e.docs().length,2);
 }finally{await e.w.happyDOM.close();}
});
test('failed held save stops batch, preserves decoded source for rescue and retry then reload',async()=>{
 const e=setup();let reloaded;try{
  e.saves.hold();const pending=e.choose([e.file(fixture('gb18030')),e.file(fixture('big5'))]);await accept(e,'gb18030');await until(()=>e.saves.writes.length===1);assert.equal(e.$('save-status').dataset.state,'pending');e.saves.writes[0].fail();await pending;
  assert.equal(e.docs().length,1);assert.equal(e.$('transcript-import-list').children[0].dataset.status,'unsaved');assert.equal(e.$('transcript-import-list').children[1].dataset.status,'cancelled');
  const blobs=[];e.w.URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:rescue';};e.w.HTMLAnchorElement.prototype.click=function(){};e.$('export-pending-documents').click();const rescue=JSON.parse(await blobs.pop().text());assert.equal(rescue.documents[0].segments[0].text,C.parse(fixture('gb18030').text,'f.srt').segments[0].text);
  e.saves.hold(false);e.$('retry-save').click();await until(()=>e.$('save-status').dataset.state==='saved');assert.equal(e.$('transcript-import-list').children[0].dataset.status,'saved');
  reloaded=setup(snapshot(e.w));assert.equal(reloaded.docs()[0].segments[0].text,e.docs()[0].segments[0].text);
 }finally{await e.w.happyDOM.close();await reloaded?.w.happyDOM.close();}
});
test('project subtitle recovery retains project identity, source, bookmarks, notes and failed-save rescue',async()=>{
 const e=setup();try{
  e.$('open-local-media').click();await e.choose([new e.w.File(['RIFF authored'],'original.wav',{type:'audio/wav',lastModified:7})],'local-media-file');
  const original=e.active();e.$('project-note').value='Original project note';e.$('project-note').dispatchEvent(new e.w.Event('input'));await e.w.flushContentForTest();
  e.$('attach-project-transcript').click();const pending=e.choose([e.file(fixture('big5'))],'project-transcript-file');await until(()=>e.$('subtitle-encoding-dialog').open);preview(e,'big5');assert.equal(e.active(),original);assert.equal(original.segments.length,0);e.$('cancel-subtitle-encoding').click();await pending;assert.equal(e.active(),original);
  e.saves.hold();e.$('attach-project-transcript').click();const accepted=e.choose([e.file(fixture('gb18030'))],'project-transcript-file');await accept(e,'gb18030');await until(()=>e.saves.writes.length===1);e.saves.writes[0].fail();await accepted;
  assert.equal(e.active().key,original.key);assert.equal(e.active().project_note,'Original project note');assert.deepEqual(e.active().local_media_source,original.local_media_source);assert.equal(e.active().segments[0].text,C.parse(fixture('gb18030').text,'f.srt').segments[0].text);assert.match(e.$('notice').textContent,/未能保存/);assert.equal(e.network.length,0);
 }finally{await e.w.happyDOM.close();}
});
test('JSON does not use the subtitle encoding picker, and size rejection happens before reading bytes',async()=>{
 const e=setup();try{
  await e.choose([new e.w.File([bytesFor(fixture('gb18030'))],'invalid.json')]);assert.equal(e.$('subtitle-encoding-dialog').open,false);assert.equal(e.docs().length,0);assert.match(e.$('notice').textContent,/导入失败/);
  let reads=0;await e.choose([{name:'oversize.srt',size:16*1024*1024,arrayBuffer:async()=>{reads++;return new ArrayBuffer(0);}}]);assert.equal(reads,0);assert.match(e.$('notice').textContent,/15 MiB/);
 }finally{await e.w.happyDOM.close();}
});
for(const f of encodingFixtures)test('project byte reader handles '+f.name+' without altering annotations',async()=>{
 const e=setup();try{
  e.$('open-local-media').click();await e.choose([new e.w.File(['RIFF authored'],'original.wav',{type:'audio/wav',lastModified:7})],'local-media-file');const original=e.active();
  e.$('audio-bookmark-time').value='1';e.$('audio-bookmark-note').value='Keep timestamp note';e.$('audio-bookmark-form').dispatchEvent(new e.w.Event('submit',{cancelable:true}));await e.w.flushContentForTest();
  e.$('attach-project-transcript').click();const pending=e.choose([e.file(f)],'project-transcript-file');if(f.encoding)await accept(e,f.encoding);await pending;
  assert.equal(e.active().key,original.key);assert.equal(e.active().segments[0].text,C.parse(f.text,f.name).segments[0].text);assert.equal(e.active().timestamp_bookmarks[0].note,'Keep timestamp note');assert.deepEqual(e.active().local_media_source,original.local_media_source);
 }finally{await e.w.happyDOM.close();}
});
test('all byte fixtures also use the same decoder in a drag/drop batch',async()=>{
 const e=setup();try{
  const pending=e.$('transcript-drop-target').ondrop({preventDefault(){},dataTransfer:{types:['Files'],files:encodingFixtures.map(e.file)}});
  for(const f of encodingFixtures.filter(f=>f.encoding)){await until(()=>e.$('subtitle-encoding-dialog').open&&e.$('subtitle-encoding-file').textContent===f.name);await accept(e,f.encoding);}await pending;
  assert.equal(e.docs().length,encodingFixtures.length);for(const [i,f] of encodingFixtures.entries())assert.equal(e.docs()[i].segments[0].text,C.parse(f.text,f.name).segments[0].text);
 }finally{await e.w.happyDOM.close();}
});
test('explicit stop and pagehide release encoding choice without reading subsequent files',async()=>{
 for(const end of ['stop','pagehide']){
  const e=setup();try{let read=false;const later=e.file(fixture('big5'));later.arrayBuffer=async()=>{read=true;return new ArrayBuffer(0);};const pending=e.choose([e.file(fixture('gb18030')),later]);await until(()=>e.$('subtitle-encoding-dialog').open);
   if(end==='stop')e.$('stop-subtitle-encoding').click();else e.w.dispatchEvent(new e.w.Event('pagehide'));await pending;
   assert.equal(read,false);assert.equal(e.docs().length,0);assert.equal(e.$('subtitle-encoding-dialog').open,false);assert.equal(e.$('subtitle-encoding-preview').textContent,'');
  }finally{await e.w.happyDOM.close();}
 }
});
test('late project byte read cannot attach to a newer document and a current read failure preserves its project',async()=>{
 const e=setup();try{
  e.$('open-local-media').click();await e.choose([new e.w.File(['RIFF authored'],'original.wav',{type:'audio/wav',lastModified:7})],'local-media-file');const original=e.active();
  let release;const delayed=e.file(fixture('gb18030'));delayed.arrayBuffer=()=>new Promise(resolve=>release=resolve);e.$('attach-project-transcript').click();const pending=e.choose([delayed],'project-transcript-file');await until(()=>!!release);
  await e.choose([e.file(fixture('utf8'))]);release(Uint8Array.from(bytesFor(fixture('gb18030'))).buffer);await pending;
  assert.equal(original.segments.length,0);assert.notEqual(e.active().key,original.key);assert.equal(e.$('subtitle-encoding-dialog').open,false);
  let reads=0;const failed=e.file(fixture('big5'));failed.arrayBuffer=async()=>{reads++;throw new Error('Authored unreadable bytes');};await e.choose([failed]);assert.equal(reads,1);assert.equal(e.docs().length,2);assert.match(e.$('notice').textContent,/Authored unreadable bytes/);
 }finally{await e.w.happyDOM.close();}
});
const invalidJSON=()=>Buffer.concat([Buffer.from('{"title":"Broken JSON","segments":[{"start":0,"end":1,"text":"'),Buffer.from([0xd6,0xd0]),Buffer.from('"}]}')]);
test('valid JSON structure with malformed UTF8 is rejected in all three transcript entrances without a recovery picker',async()=>{
 const e=setup();try{
  await e.choose([e.file(fixture('utf8'))]);const before=JSON.stringify(e.active());
  await e.choose([new e.w.File([invalidJSON()],'broken.json')]);assert.match(e.$('notice').textContent,/JSON.*UTF-8/);assert.equal(JSON.stringify(e.active()),before);assert.equal(e.docs().length,1);assert.equal(e.$('subtitle-encoding-dialog').open,false);
  await e.choose([new e.w.File([invalidJSON()],'broken.json'),e.file(fixture('utf16be'))]);assert.deepEqual(Array.from(e.$('transcript-import-list').children,r=>r.dataset.status),['failed','saved']);assert.equal(e.docs().length,2);assert.equal(e.$('subtitle-encoding-dialog').open,false);
  e.$('open-local-media').click();await e.choose([new e.w.File(['RIFF authored'],'original.wav',{type:'audio/wav',lastModified:7})],'local-media-file');e.$('project-note').value='Preserved note';e.$('project-note').dispatchEvent(new e.w.Event('input'));await e.w.flushContentForTest();const project=JSON.stringify(e.active());
  e.$('attach-project-transcript').click();await e.choose([new e.w.File([invalidJSON()],'broken.json')],'project-transcript-file');assert.equal(JSON.stringify(e.active()),project);assert.match(e.$('notice').textContent,/JSON.*UTF-8/);assert.equal(e.$('subtitle-encoding-dialog').open,false);
 }finally{await e.w.happyDOM.close();}
});
test('JSON preserves literal U+FFFD, escaped NUL and UTF8 BOM; fatal verification late result remains owned',async()=>{
 const e=setup();try{
  const doc={title:'Actual replacement symbol',segments:[{start:0,end:1,text:'Literal � and \0 in JSON'}]},bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(JSON.stringify(doc))]);
  // Node's native File models Blob.text BOM removal; HappyDOM retains it.
  await e.choose([new File([bytes],'valid.json')]);assert.equal(e.active().segments[0].text,doc.segments[0].text);assert.equal(e.$('subtitle-encoding-dialog').open,false);
  await e.choose([new File([Buffer.from([0xef,0xbb,0xbf]),bytes],'double-bom.json')]);assert.equal(e.docs().length,1);assert.match(e.$('notice').textContent,/导入失败/);
  let release;const old=new e.w.File([invalidJSON()],'bad.json');old.arrayBuffer=()=>new Promise(resolve=>release=resolve);const pending=e.choose([old]);await until(()=>!!release);await e.choose([e.file(fixture('utf8'))]);release(Uint8Array.from(invalidJSON()).buffer);await pending;assert.equal(e.active().title,'utf8');assert.equal(e.docs().length,2);assert.doesNotMatch(e.$('notice').textContent,/JSON.*UTF-8/);
 }finally{await e.w.happyDOM.close();}
});
test('encoding dialog traps its two Tab boundaries and restores the owned entry focus on cancel',async()=>{
 const e=setup();try{
  e.$('import').focus();const pending=e.choose([e.file(fixture('gb18030'))]);await until(()=>e.$('subtitle-encoding-dialog').open);preview(e,'gb18030');
  e.$('confirm-subtitle-encoding').focus();e.$('confirm-subtitle-encoding').dispatchEvent(new e.w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));assert.equal(e.w.document.activeElement,e.$('subtitle-encoding'));
  e.$('subtitle-encoding').dispatchEvent(new e.w.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));assert.equal(e.w.document.activeElement,e.$('confirm-subtitle-encoding'));
  e.$('cancel-subtitle-encoding').click();await pending;assert.equal(e.w.document.activeElement,e.$('import'));
 }finally{await e.w.happyDOM.close();}
});
