import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url);
function setup(){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});
 w.eval(['summary','core','app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
 return {w,$:id=>w.document.getElementById(id),row:id=>w.document.querySelector(`[data-segment-id="${id}"]`)};
}
const cue=(id,text='A short source fragment',translation='一小段译文')=>({id,start:10,end:10.8,text,translations:{zh:{text:translation,source_text:text,source_language:'en',document_language:'en',provider:'Authored QA'}}});
async function add(env,segments){const {$}=env,text=JSON.stringify({title:'Short cue reading',language:'en',translation_view:'zh',source_media:{job_id:'a'.repeat(32),kind:'audio'},segments});Object.defineProperty($('file'),'files',{configurable:true,value:[{name:'short.json',size:text.length,text:async()=>text}]});await $('file').onchange();$('mode-bilingual').click();}
test('short cues preserve every identity and bilingual text; long, multiline and stale text stay full size',async()=>{
 const env=setup();try{
  const stale=cue('stale');stale.translations.zh.source_text='Different';
  await add(env,[cue('short'),cue('long-source','中'.repeat(80)),cue('long-translation','Small','译'.repeat(80)),{...cue('long-duration'),end:20},cue('multiline','Line one\nLine two'),stale]);
  assert.equal(env.w.document.querySelectorAll('.segment').length,6);
  assert.deepEqual([...env.w.document.querySelectorAll('.short-cue')].map(r=>r.dataset.segmentId),['short']);
  assert.equal(env.row('short').querySelector('.words').textContent,'A short source fragment');
  assert.equal(env.row('short').querySelector('.translation').textContent,'一小段译文');
  const disclosure=env.row('short').querySelector('details');assert.equal(disclosure.open,false);
  assert.match(disclosure.querySelector('summary').getAttribute('aria-label'),/00:10.*修正.*摘录/);
  assert.ok(!env.row('short').querySelector('.note-button').closest('details'));
  assert.ok(env.row('stale').querySelector('.translation.stale'));
 }finally{await env.w.happyDOM.close();}
});
test('secondary actions retain open disclosure and keyboard position through rerenders and corrections',async()=>{
 const env=setup();try{
  const {$,w,row}=env;await add(env,[cue('first'),{...cue('second'),start:11,end:11.8}]);
  row('first').querySelector('details').open=true;row('first').querySelector('.excerpt-button').click();
  assert.equal(row('first').querySelector('details').open,true);assert.equal(w.document.activeElement,row('first').querySelector('.excerpt-button'));
  assert.match(row('first').querySelector('summary').textContent,/已摘录/);
  row('first').querySelector('.bookmark-button').click();assert.equal(w.document.activeElement,row('first').querySelector('.bookmark-button'));assert.equal(row('first').querySelector('details').open,true);
  $('mode-transcript').click();assert.equal(row('first').querySelector('details').open,true);$('mode-bilingual').click();
  row('first').querySelector('.edit-button').click();$('edit-segment').value='Corrected source';$('save-edit').click();
  assert.equal(w.document.activeElement,row('first').querySelector('.edit-button'));
  // Correction makes the old translation stale, so the full treatment returns.
  assert.equal(row('first').classList.contains('short-cue'),false);
  row('second').querySelector('details').open=true;row('second').querySelector('.note-button').click();$('note').value='Keep my thought';$('note').oninput();$('close-note').click();
  assert.equal(row('second').querySelector('details').open,true);assert.equal(w.document.activeElement,row('second').querySelector('.note-button'));assert.match(row('second').textContent,/Keep my thought/);
 }finally{await env.w.happyDOM.close();}
});
test('short cue timestamp and disclosed loop operate on the same precise source range',async()=>{
 const env=setup();try{
  const {$,w,row}=env;await add(env,[cue('first')]);w.dispatchEvent(new w.Event('coconut-worker-ready'));
  const player=$('source-media').querySelector('audio');Object.defineProperty(player,'duration',{value:50});player.play=async()=>{};player.pause=()=>{};
  row('first').querySelector('.time > button').click();assert.equal(player.currentTime,10);
  assert.equal(row('first').querySelector('.time .repeat-button'),null);
  const more=row('first').querySelector('details');more.open=true;more.querySelector('.repeat-button').click();assert.equal(player.currentTime,10);assert.equal(more.querySelector('.repeat-button').getAttribute('aria-pressed'),'true');
  player.currentTime=10.9;player.dispatchEvent(new w.Event('timeupdate'));assert.equal(player.currentTime,10);
  more.querySelector('.repeat-button').click();assert.equal(more.querySelector('.repeat-button').getAttribute('aria-pressed'),'false');
 }finally{await env.w.happyDOM.close();}
});
test('disclosures survive filtering and note rerender without leaking to a new document or reopening a closed summary',async()=>{
 const env=setup();try{
  const {$,w,row}=env;await add(env,[cue('first','短字幕'),cue('second')]);
  const disclosure=row('first').querySelector('details');disclosure.open=true;
  $('search').value='短字幕';$('search').oninput();assert.equal(row('first').querySelector('details').open,true);
  row('first').querySelector('details').open=false;row('first').querySelector('summary').focus();$('search').oninput();
  assert.equal(row('first').querySelector('details').open,false);assert.equal(w.document.activeElement,row('first').querySelector('summary'));
  row('first').querySelector('details').open=true;
  await add(env,[cue('first','Another source')]);assert.equal(row('first').querySelector('details').open,false);
 }finally{await env.w.happyDOM.close();}
});
test('carriage returns and Unicode line separators retain full source and translation treatment',async()=>{
 const env=setup();try{
  const breaks=['\r','\r\n','\u2028','\u2029'];
  await add(env,breaks.flatMap((separator,i)=>[cue('source-'+i,'First'+separator+'second'),cue('translation-'+i,'Source','第一'+separator+'第二')]));
  assert.equal(env.w.document.querySelectorAll('.segment').length,8);
  assert.equal(env.w.document.querySelectorAll('.short-cue').length,0);
 }finally{await env.w.happyDOM.close();}
});
test('more describes loop actions only while the same cue actually offers a loop control',async()=>{
 const env=setup();try{
  const {$,w,row}=env;await add(env,[cue('first')]);
  assert.equal(row('first').querySelector('.repeat-button'),null);
  assert.doesNotMatch(row('first').querySelector('summary').getAttribute('aria-label'),/循环/);
  w.dispatchEvent(new w.Event('coconut-worker-ready'));
  const player=$('source-media').querySelector('audio');Object.defineProperty(player,'duration',{value:50});player.play=async()=>{};player.pause=()=>{};
  assert.ok(row('first').querySelector('.repeat-button'));
  assert.match(row('first').querySelector('summary').getAttribute('aria-label'),/循环回听/);
  row('first').querySelector('.repeat-button').click();
  assert.match(row('first').querySelector('summary').getAttribute('aria-label'),/循环中.*循环回听/);
  row('first').querySelector('.repeat-button').click();
  assert.doesNotMatch(row('first').querySelector('summary').getAttribute('aria-label'),/循环中/);
  assert.match(row('first').querySelector('summary').getAttribute('aria-label'),/循环回听/);
 }finally{await env.w.happyDOM.close();}
});
