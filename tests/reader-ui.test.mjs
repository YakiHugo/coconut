import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url);
function setup(stored){
  const window=new Window({url:'https://coconut.example/'});
  window.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
  Object.defineProperty(window,'crypto',{value:webcrypto});
  if(stored!==undefined)window.localStorage.setItem('coconut-reader-v1',stored);
  window.eval(fs.readFileSync(new URL('reader/core.js',root),'utf8'));
  window.eval(fs.readFileSync(new URL('reader/app.js',root),'utf8'));
  return window;
}
async function importDocument(w, document) {
  const input=w.document.getElementById('file');
  const text=JSON.stringify(document);
  Object.defineProperty(input,'files',{configurable:true,value:[{name:'backup.json',size:text.length,text:async()=>text}]});
  await input.onchange();
}
test('editing B does not redirect the open A note',async()=>{
  const w=setup();try{
    await w.document.getElementById('sample').onclick();
    let rows=w.document.querySelectorAll('.segment');rows[0].querySelectorAll('button')[1].click();
    const note=w.document.getElementById('note');note.value='First note';note.oninput();
    rows=w.document.querySelectorAll('.segment');rows[1].querySelector('button').click();
    w.document.getElementById('edit-segment').value='Corrected second segment';w.document.getElementById('save-edit').click();
    note.value='Still first note';note.oninput();
    const stored=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];
    assert.equal(stored.notes['demo-1'],'Still first note');assert.equal(stored.notes['demo-2'],undefined);
    assert.equal(stored.segments[1].text,'Corrected second segment');assert.ok(stored.segments[1].original_text);
  }finally{await w.happyDOM.close();}
});
test('damaged saved data remains intact while temporary reading works',async()=>{
  for(const original of ['{broken','{"unexpected":"data"}']){
    const w=setup(original);try{await w.document.getElementById('sample').onclick();
      assert.equal(w.localStorage.getItem('coconut-reader-v1'),original);
      assert.equal(w.document.querySelectorAll('.segment').length,3);
    }finally{await w.happyDOM.close();}
  }
});
test('notes survive restore and can be searched',async()=>{
  const first=setup();let stored;try{
    await first.document.getElementById('sample').onclick();
    first.document.querySelector('.segment').querySelectorAll('button')[1].click();
    const note=first.document.getElementById('note');note.value='My unique memory';note.oninput();
    stored=first.localStorage.getItem('coconut-reader-v1');
  }finally{await first.happyDOM.close();}
  const restored=setup(stored);try{
    const search=restored.document.getElementById('search');search.value='unique memory';search.oninput();
    assert.equal(restored.document.querySelectorAll('.segment').length,1);
    assert.equal(restored.document.querySelector('.saved-note').textContent,'My unique memory');
  }finally{await restored.happyDOM.close();}
});

test('leaving the note editor preserves the pending row click target',async()=>{
 const w=setup();try{
  await w.document.getElementById('sample').onclick();
  w.document.querySelector('.segment').querySelectorAll('button')[1].click();
  const note=w.document.getElementById('note');note.value='Live preview';note.oninput();
  const target=w.document.querySelectorAll('.segment')[1].querySelector('button');
  note.blur();
  assert.ok(target.isConnected,'blur must not replace the pending pointer target');
  target.click();
  assert.ok(w.document.getElementById('edit-dialog').open);
  assert.equal(w.document.querySelector('.saved-note').textContent,'Live preview');
 }finally{await w.happyDOM.close();}
});

test('stale tabs cannot overwrite newer persisted notes',async()=>{
 const w=setup();try{
  await w.document.getElementById('sample').onclick();
  const newest=JSON.parse(w.localStorage.getItem('coconut-reader-v1'));
  newest.documents[0].notes['demo-1']='Newer note from another tab';
  const external=JSON.stringify(newest);w.localStorage.setItem('coconut-reader-v1',external);
  w.document.getElementById('library').querySelector('button').click();
  assert.equal(w.localStorage.getItem('coconut-reader-v1'),external);
  assert.match(w.document.getElementById('notice').textContent,/另一个页面/);
 }finally{await w.happyDOM.close();}
});

test('local source playback activates only with the local worker and seeks to source time',async()=>{
 const id='a'.repeat(32);
 const stored=JSON.stringify({active:'local-doc',documents:[{key:'local-doc',schema_version:1,title:'Local source',source_url:'',source_media:{job_id:id,kind:'audio'},provenance:{kind:'local_asr',model:'small'},notes:{},segments:[{id:'one',start:12,end:15,text:'A verifiable phrase'}]}]});
 const w=setup(stored);try{
  assert.equal(w.document.querySelector('audio'),null);
  assert.match(w.document.getElementById('provenance').textContent,/本机语音识别.*small/);
  w.dispatchEvent(new w.Event('coconut-worker-ready'));
  const player=w.document.querySelector('audio');assert.ok(player);
  assert.equal(player.getAttribute('src'),'/api/jobs/'+id+'/media');
  let played=false;player.play=async()=>{played=true;};
  w.document.querySelector('.time button').click();
  assert.equal(player.currentTime,12);assert.equal(played,true);
  w.document.querySelector('.note-button').click();
  assert.equal(w.document.querySelector('audio'),player,'note edits must not reload the source');
 }finally{await w.happyDOM.close();}
});

test('source dialog saves to its original document even if another import becomes active',async()=>{
 const w=setup();try{
  await w.document.getElementById('sample').onclick();
  const firstKey=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).active;
  w.document.getElementById('source').click();
  await importDocument(w,{title:'Second document',segments:[{start:0,end:1,text:'Second'}]});
  w.document.getElementById('source-url').value='https://www.youtube.com/watch?v=jNQXAC9IVRw';
  w.document.getElementById('save-source').click();
  const stored=JSON.parse(w.localStorage.getItem('coconut-reader-v1'));
  assert.equal(stored.documents.find(d=>d.key===firstKey).source_url,'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  assert.equal(stored.documents.find(d=>d.key===stored.active).source_url,'');
 }finally{await w.happyDOM.close();}
});

test('new import clears the previous document search',async()=>{
 const w=setup();try{
  await w.document.getElementById('sample').onclick();
  const search=w.document.getElementById('search');search.value='absent word';search.oninput();
  await importDocument(w,{title:'Second document',segments:[{start:0,end:1,text:'Second'}]});
  assert.equal(search.value,'');assert.equal(w.document.querySelectorAll('.segment').length,1);
 }finally{await w.happyDOM.close();}
});

test('backup requests a connected download and restores corrections, notes and provenance',async()=>{
 const w=setup();try{
  await importDocument(w,{title:'A/B',provenance:{kind:'local_asr',model:'small'},source_url:'https://youtu.be/jNQXAC9IVRw',segments:[{id:'one',start:2,end:4,text:'Correction',original_text:'Original'}],notes:{one:'Keep this'}});
  let backup,clicked=false;
  w.URL.createObjectURL=blob=>{backup=blob;return 'blob:https://coconut.example/backup';};
  w.URL.revokeObjectURL=()=>{};
  w.HTMLAnchorElement.prototype.click=function(){assert.ok(this.isConnected);assert.equal(this.download,'A_B.coconut.json');clicked=true;};
  w.document.getElementById('export').onclick();
  assert.ok(clicked);
  const doc=w.Coconut.parse(await backup.text(),'backup.json');
  assert.equal(doc.segments[0].original_text,'Original');assert.equal(doc.segments[0].text,'Correction');
  assert.equal(doc.notes.one,'Keep this');assert.equal(doc.provenance.model,'small');assert.equal(doc.segments[0].start,2);
  assert.match(w.document.getElementById('notice').textContent,/检查.*下载/);
  assert.doesNotMatch(w.document.getElementById('notice').textContent,/已导出/);
  assert.equal(w.document.querySelectorAll('a[download]').length,0);
 }finally{await w.happyDOM.close();}
});

test('failed backup creation keeps the document and gives a retryable error',async()=>{
 const w=setup();try{
  await w.document.getElementById('sample').onclick();const before=w.localStorage.getItem('coconut-reader-v1');
  w.URL.createObjectURL=()=>{throw new Error('unavailable');};
  assert.doesNotThrow(()=>w.document.getElementById('export').onclick());
  assert.match(w.document.getElementById('notice').textContent,/导出.*失败/);
  assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);
 }finally{await w.happyDOM.close();}
});
