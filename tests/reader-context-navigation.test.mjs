import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {splitCueFixture} from './helpers/split-cue-fixture.mjs';
const root = new URL('../', import.meta.url);
function setup() {
 const w = new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});
 const calls=[];w.fetch=async(...args)=>{calls.push(args);throw new Error('Unexpected network request');};
 w.eval(fs.readFileSync(new URL('reader/summary.js',root),'utf8'));
 w.eval(fs.readFileSync(new URL('reader/core.js',root),'utf8'));
 w.eval(fs.readFileSync(new URL('reader/passages.js',root),'utf8'));
 w.eval(fs.readFileSync(new URL('reader/passage-playback.js',root),'utf8'));
 w.eval(['app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
 w.HTMLElement.prototype.scrollIntoView=function(options){w.scrolled=this.dataset.segmentId;w.lastScrollOptions=options;};
 return {w,$:id=>w.document.getElementById(id),calls};
}
async function load($,doc=splitCueFixture()) {
 const text=JSON.stringify(doc);Object.defineProperty($('file'),'files',{configurable:true,value:[{name:'split.json',size:text.length,text:async()=>text}]});
 await $('file').onchange();$('mode-bilingual').click();
}
const rows=w=>[...w.document.querySelectorAll('#transcript .segment')];
const row=(w,id)=>rows(w).find(node=>node.dataset.segmentId===id);
const search=($,query)=>{$('search').value=query;$('search').oninput();};
const stored=w=>JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents;

test('late fragmented search result opens real neighbors and returns without modifying saved reading work',async()=>{
 const {w,$,calls}=setup();try{
  await load($);const before=w.localStorage.getItem('coconut-reader-v1');search($,'crossing-marker');$('next-match').click();
  $('ai-consent').checked=true;row(w,'split-1750').querySelector('.context-button').click();
  assert.equal($('reading-context').hidden,false);assert.match($('reading-context-label').textContent,/crossing-marker.*第 1 \/ 1/);
  assert.equal($('search').value,'');assert.equal($('ai-consent').checked,false);
  assert.ok(rows(w).length<=100);assert.ok(row(w,'split-1749'));assert.ok(row(w,'split-1751'));
  assert.ok(row(w,'split-1750').classList.contains('context-target'));assert.equal(w.document.activeElement.dataset.segmentId,'split-1750');
  assert.equal(w.scrolled,'split-1750');assert.equal(w.lastScrollOptions.behavior,'auto','Context lands immediately rather than animating across dozens of cues');
  assert.equal(row(w,'split-1749').querySelector('.words').textContent,'to cross the road safely.');
  $('ai-consent').checked=true;$('return-reading-results').click();
  assert.equal($('reading-context').hidden,true);assert.equal($('search').value,'crossing-marker');assert.equal($('ai-consent').checked,false);
  assert.deepEqual(rows(w).map(r=>r.dataset.segmentId),['split-1750']);
  assert.equal(w.document.activeElement,row(w,'split-1750').querySelector('.context-button'));assert.match($('match-position').textContent,/1 \/ 1/);
  assert.equal($('mode-bilingual').getAttribute('aria-pressed'),'true');assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);
  assert.equal(calls.length,0);
 }finally{await w.happyDOM.close();}
});

test('context includes both neighbors at an ordinary page boundary and preserves later result page',async()=>{
 const {w,$}=setup();try{
  const fixture=splitCueFixture();fixture.segments.forEach((s,i)=>{s.text+=' needle '+i;delete s.translations;});
  await load($,fixture);search($,'needle');$('previous-match').click();
  row(w,'split-1700').querySelector('.context-button').click();
  assert.ok(row(w,'split-1699'));assert.ok(row(w,'split-1701'));assert.ok(rows(w).length<=100);
  $('return-reading-results').click();assert.equal(rows(w)[0].dataset.segmentId,'split-1700');
  assert.equal(w.document.activeElement.closest('.segment').dataset.segmentId,'split-1700');assert.match($('match-position').textContent,/1701 \/ 1771/);
 }finally{await w.happyDOM.close();}
});

test('combined excerpt and speaker filtering and bilingual display return exactly',async()=>{
 const {w,$}=setup();try{
  const fixture=splitCueFixture(20);fixture.segments.forEach(s=>s.saved_excerpt=true);
  await load($,fixture);$('filter-excerpts').click();$('speaker-filter').value='"Mina"';$('speaker-filter').onchange();
  const ids=rows(w).map(r=>r.dataset.segmentId);row(w,'split-2').querySelector('.context-button').click();
  assert.ok(row(w,'split-6'));$('mode-transcript').click();assert.equal($('reading-context').hidden,false);
  $('return-reading-results').click();assert.deepEqual(rows(w).map(r=>r.dataset.segmentId),ids);
  assert.equal($('filter-excerpts').getAttribute('aria-pressed'),'true');assert.equal($('speaker-filter').value,'"Mina"');
  assert.equal($('mode-bilingual').getAttribute('aria-pressed'),'true');assert.ok(row(w,'split-2').querySelector('.translation'));
  assert.equal(stored(w)[0].readingPosition,'split-19');
 }finally{await w.happyDOM.close();}
});

test('removing an excerpt in context returns to a surviving result and keeps the removal',async()=>{
 const {w,$}=setup();try{
  const fixture=splitCueFixture(20);fixture.segments[2].saved_excerpt=true;fixture.segments[8].saved_excerpt=true;
  await load($,fixture);$('filter-excerpts').click();row(w,'split-2').querySelector('.context-button').click();
  row(w,'split-2').querySelector('.excerpt-button').click();$('return-reading-results').click();
  assert.deepEqual(rows(w).map(r=>r.dataset.segmentId),['split-8']);assert.match($('notice').textContent,/相邻结果/);
  assert.equal(w.document.activeElement.closest('.segment').dataset.segmentId,'split-8');assert.equal(stored(w)[0].segments[2].saved_excerpt,undefined);
  row(w,'split-8').querySelector('.context-button').click();row(w,'split-8').querySelector('.excerpt-button').click();$('return-reading-results').click();
  assert.equal(rows(w).length,0);assert.equal(w.document.activeElement,$('search'));assert.match($('notice').textContent,/没有匹配/);
 }finally{await w.happyDOM.close();}
});

test('editing a searched cue keeps source correction and truthfully returns to empty results',async()=>{
 const {w,$}=setup();try{
  await load($);search($,'crossing-marker');row(w,'split-1750').querySelector('.context-button').click();
  row(w,'split-1750').querySelector('.edit-button').click();$('edit-segment').value='Corrected source wording.';$('save-edit').click();
  $('return-reading-results').click();assert.equal(rows(w).length,0);assert.equal($('search').value,'crossing-marker');
  assert.equal(stored(w)[0].segments[1750].text,'Corrected source wording.');assert.equal(stored(w)[0].readingPosition,'split-19');
 }finally{await w.happyDOM.close();}
});

test('dismissal, deliberate filter changes, summary and document switches discard old origins',async()=>{
 const {w,$}=setup();try{
  await load($,splitCueFixture(20));
  const open=()=>{search($,'station');rows(w)[0].querySelector('.context-button').click();assert.equal($('reading-context').hidden,false);};
  open();$('dismiss-reading-context').click();assert.equal($('reading-context').hidden,true);assert.equal(w.document.querySelector('.context-target'),null);
  open();search($,'cross');assert.equal($('reading-context').hidden,true);$('return-reading-results').click();assert.equal($('search').value,'cross');
  open();$('filter-notes').click();assert.equal($('reading-context').hidden,true);
  $('filter-all').click();open();$('mode-summary').click();$('mode-bilingual').click();assert.equal($('reading-context').hidden,true);
  open();await load($,{...splitCueFixture(2),title:'Another document'});assert.equal($('reading-context').hidden,true);
  $('library').firstElementChild.click();$('mode-bilingual').click();assert.equal($('reading-context').hidden,true);
 }finally{await w.happyDOM.close();}
});

test('returning after deleting a note keeps notes filter and updated annotation',async()=>{
 const {w,$}=setup();try{
  const fixture=splitCueFixture(20);fixture.notes={'split-3':'my note'};await load($,fixture);$('filter-notes').click();
  row(w,'split-3').querySelector('.context-button').click();row(w,'split-3').querySelector('.note-button').click();
  $('note').value='';$('note').oninput();$('return-reading-results').click();
  assert.equal(rows(w).length,0);assert.equal($('filter-notes').getAttribute('aria-pressed'),'true');assert.equal($('notes-panel').hidden,true);
  assert.equal(stored(w)[0].notes['split-3'],'');
 }finally{await w.happyDOM.close();}
});

test('context detour latches stop for queued translation even after returning and rechecking consent',async()=>{
 const {w,$}=setup();try{
  const fixture=splitCueFixture(66);fixture.segments.forEach((s,i)=>{s.text=i===65?'excluded neighbor':'target source '+i;delete s.translations;});
  await load($,fixture);search($,'target');let finish;const requests=[];
  w.fetch=async(url,options)=>{
   if(url.endsWith('language-tools'))return {ok:true,json:async()=>({ai:{codex:{ready:true}}})};
   const request=JSON.parse(options.body);requests.push(request);
   await new Promise(resolve=>{finish=resolve;});
   return {ok:true,json:async()=>({translations:request.segments.map(s=>({id:s.id,text:'译 '+s.id,source_text:s.text}))})};
  };
  $('ai-task').value='translation';$('ai-task').onchange();await $('check-ai').onclick();$('ai-consent').checked=true;const pending=$('subscription-translate').onclick();
  assert.equal(requests.length,1);rows(w)[0].querySelector('.context-button').click();$('return-reading-results').click();
  $('ai-consent').checked=true;finish();await pending;
  assert.equal(requests.length,1);assert.ok(!JSON.stringify(requests).includes('excluded neighbor'));
 }finally{await w.happyDOM.close();}
});


test('source passage detail navigation retains the ordinary cue scroll behavior',async()=>{
 const {w,$}=setup();try{
  await load($);$('mode-summary').click();$('overview-segments').lastElementChild.click();
  const passage=w.document.activeElement;
  assert.equal(passage.dataset.firstCueId,'split-1770');assert.equal(w.lastScrollOptions.behavior,'auto');
  passage.querySelector('.passage-details').click();
  assert.equal(w.document.activeElement.dataset.segmentId,'split-1770');
  assert.equal(w.scrolled,'split-1770');assert.equal(w.lastScrollOptions.behavior,'smooth');
  assert.equal($('reading-context').hidden,true);
 }finally{await w.happyDOM.close();}
});
