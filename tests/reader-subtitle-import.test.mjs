/** DOM integration only; native chooser/download evidence belongs to browser CI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {subtitleFixtures,expectedCues,note,correction,cueSnapshot} from './helpers/subtitle-import-fixtures.mjs';
const root=new URL('../',import.meta.url),KEY='coconut-reader-v1';
function setup(){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});
 w.fetch=()=>{throw new Error('Local subtitle imports must not contact a server');};
 w.eval(['summary','core','app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
 const $=id=>w.document.getElementById(id),stored=()=>JSON.parse(w.localStorage.getItem(KEY));
 const choose=async(name,text)=>{Object.defineProperty($('file'),'files',{configurable:true,value:[{name,size:Buffer.byteLength(text),text:async()=>text}]});await $('file').onchange();};
 return {w,$,stored,choose};
}
for(const fixture of subtitleFixtures)test(`${fixture.format} file handler preserves authored cues, notes, exports and failed-import state`,async()=>{
 const {w,$,stored,choose}=setup();let restored;
 try{
  await choose(fixture.name,fixture.text);
  const doc=stored().documents[0];assert.equal(doc.title,fixture.title);assert.deepEqual(cueSnapshot(doc),expectedCues);
  $('mode-transcript').click();assert.equal(w.document.querySelectorAll('.segment').length,3);
  assert.equal(w.document.querySelector('.words').textContent,expectedCues[0].text);
  w.document.querySelector('.note-button').click();$('note').value=note;$('note').dispatchEvent(new w.Event('input'));$('close-note').click();
  const second=w.document.querySelectorAll('.segment')[1];second.querySelector('.cue-more > summary')?.click();second.querySelector('.edit-button').click();
  $('edit-segment').value=correction;$('save-edit').click();
  const saved=stored(),current=saved.documents[0];assert.equal(current.notes['segment-1'],note);assert.equal(current.segments[1].original_text,expectedCues[1].text);
  const before=w.localStorage.getItem(KEY);await choose('broken.'+fixture.format,fixture.invalid);
  assert.match($('notice').textContent,/导入失败/);assert.equal(w.localStorage.getItem(KEY),before);assert.equal($('title').textContent,fixture.title);
  // JSON is the full-fidelity backup; subtitle exports intentionally omit notes.
  const blobs=[];w.URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:authored-export';};w.URL.revokeObjectURL=()=>{};
  w.HTMLAnchorElement.prototype.click=function(){};
  $('export').click();const backup=await blobs.pop().text();restored=setup();await restored.choose('backup.json',backup);
  assert.deepEqual(cueSnapshot(restored.stored().documents[0]),cueSnapshot(current));assert.equal(restored.stored().documents[0].notes['segment-1'],note);
  assert.equal(restored.stored().documents[0].segments[1].original_text,expectedCues[1].text);
  $('subtitle-format').value=fixture.format;$('export-subtitles').click();const subtitles=await blobs.pop().text();
  assert.ok(!subtitles.includes(note));await restored.choose('roundtrip.'+fixture.format,subtitles);
  const roundtrip=restored.stored().documents.find(d=>d.key===restored.stored().active);
  assert.deepEqual(cueSnapshot(roundtrip),cueSnapshot(current));assert.deepEqual(roundtrip.notes,{});
 }finally{await restored?.w.happyDOM.close();await w.happyDOM.close();}
});
