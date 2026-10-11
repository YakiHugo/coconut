import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {settle} from './helpers/save-pipeline.mjs';
const fixture=()=>({key:'speakers',title:'Local conversation',segments:Array.from({length:207},(_,i)=>({id:'cue-'+i,start:i*2,end:i*2+2,text:'Original [Name] words '+i,speaker:i%3===0?'Guest':'Speaker 1',...(i===1?{saved_excerpt:true}:{} )})),notes:{'cue-1':'Keep note'},readingPosition:'cue-1'});
const setup=()=>libraryHarness([fixture()],{probe:true});
function open(env,id='cue-1'){env.w.document.querySelector(`[data-segment-id="${id}"] .speaker-correction-button`).click();}
function input(env,value){env.$('speaker-name').value=value;env.$('speaker-name').dispatchEvent(new env.w.Event('input',{bubbles:true}));}
function select(env,id,value){env.$(id).value=value;env.$(id).dispatchEvent(new env.w.Event('change',{bubbles:true}));}
async function ready(){await settle();await new Promise(resolve=>setTimeout(resolve,0));}

test('single correction preserves cue annotations and text, restores initial label and no-op/cancel do not queue',async()=>{
 const env=setup(),{w,$,pipeline}=env;try{
  const doc=w.libraryProbe.documents[0],before=JSON.stringify(doc);open(env);$('save-speaker').click();await w.flushContentForTest();await ready();assert.equal(JSON.stringify(doc),before);assert.equal(pipeline.prepares,0);
  open(env);input(env,'Cancelled');$('cancel-speaker').click();assert.equal(JSON.stringify(doc),before);
  open(env);input(env,'Host');assert.match($('speaker-preview').textContent,/00:02.*Speaker 1 → Host/);$('save-speaker').click();await w.flushContentForTest();await ready();
  assert.equal(doc.segments[1].speaker,'Host');assert.equal(doc.segments[1].original_speaker,'Speaker 1');assert.equal(doc.segments[2].speaker,'Speaker 1');assert.equal(doc.segments[1].text,'Original [Name] words 1');assert.equal(doc.readingPosition,'cue-1');assert.equal(doc.notes['cue-1'],'Keep note');assert.equal(doc.segments[1].saved_excerpt,true);assert.equal(pipeline.prepares,1);
  open(env);select(env,'speaker-action','restore');$('save-speaker').click();await w.flushContentForTest();await ready();assert.equal(doc.segments[1].speaker,'Speaker 1');assert.equal(doc.segments[1].original_speaker,'Speaker 1');
  open(env);select(env,'speaker-action','restore');assert.match($('speaker-count').textContent,/将修改 0 段/);$('save-speaker').click();await w.flushContentForTest();await ready();assert.equal(pipeline.prepares,2);
 }finally{await w.happyDOM.close();}
});

test('whole group includes hidden pages and query results, follows speaker filter and rebuilds passages',async()=>{
 const env=setup(),{w,$}=env;try{
  const doc=w.libraryProbe.documents[0];select(env,'speaker-filter',JSON.stringify('Speaker 1'));$('search').value='words 1';$('search').dispatchEvent(new w.Event('input'));await ready();
  open(env);select(env,'speaker-scope','speaker');input(env,'Guest');assert.match($('speaker-count').textContent,/范围内 138 段/);assert.match($('speaker-merge').textContent,/归入同一标签组/);$('save-speaker').click();await w.flushContentForTest();await ready();
  assert.equal(doc.segments.filter(cue=>cue.speaker==='Guest').length,207);assert.equal($('speaker-filter').value,JSON.stringify('Guest'));assert.equal($('search').value,'words 1');assert.equal(w.document.activeElement.closest('.segment').dataset.segmentId,'cue-1');
  assert.ok(w.CoconutPassages.build(doc.segments).length<207);
  open(env);select(env,'speaker-scope','speaker');select(env,'speaker-action','restore');assert.match($('speaker-merge').textContent,/不同标签/);assert.match($('speaker-preview').textContent,/Guest → Speaker 1/);$('save-speaker').click();await w.flushContentForTest();await ready();assert.equal(doc.segments[1].speaker,'Speaker 1');assert.equal(doc.segments[0].speaker,'Guest');assert.equal(doc.segments[206].speaker,'Speaker 1');
 }finally{await w.happyDOM.close();}
});

test('single correction retains remaining old-filter results and returns to adjacent cue',async()=>{
 const env=setup(),{w,$}=env;try{
  select(env,'speaker-filter',JSON.stringify('Speaker 1'));open(env);input(env,'Host');$('save-speaker').click();await w.flushContentForTest();await ready();assert.equal($('speaker-filter').value,JSON.stringify('Speaker 1'));assert.equal(w.document.activeElement.closest('.segment').dataset.segmentId,'cue-2');
 }finally{await w.happyDOM.close();}
});

test('reading context saved filter follows whole-group correction and return finds cue by identity',async()=>{
 const env=setup(),{w,$}=env;try{
  select(env,'speaker-filter',JSON.stringify('Speaker 1'));w.document.querySelector('[data-segment-id="cue-1"] .context-button').click();open(env);select(env,'speaker-scope','speaker');input(env,'Host');$('save-speaker').click();await w.flushContentForTest();await ready();assert.match($('reading-context-label').textContent,/Host/);$('return-reading-results').click();assert.equal($('speaker-filter').value,JSON.stringify('Host'));assert.equal(w.document.activeElement.closest('.segment').dataset.segmentId,'cue-1');
 }finally{await w.happyDOM.close();}
});

test('stale target and replaced document cannot be changed by an old dialog; invalid input keeps draft guarded',async()=>{
 const env=setup(),{w,$,pipeline}=env;try{
  const doc=w.libraryProbe.documents[0];open(env);input(env,'Host');doc.segments[1].text='Changed after preview';$('save-speaker').click();assert.equal(doc.segments[1].speaker,'Speaker 1');assert.ok($('speaker-error').textContent);assert.equal(pipeline.prepares,0);
  $('cancel-speaker').click();open(env);input(env,'Host');w.libraryProbe.documents[0]=structuredClone(doc);$('save-speaker').click();assert.equal(doc.segments[1].speaker,'Speaker 1');assert.match($('speaker-error').textContent,/已变化/);
  input(env,' ');const event=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(event);assert.equal(event.defaultPrevented,true);$('cancel-speaker').click();const clean=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(clean);assert.equal(clean.defaultPrevented,false);
 }finally{await w.happyDOM.close();}
});

test('one queued write exposes failure backup and global retry, retaining corrected source for recovery',async()=>{
 const env=setup(),{w,$,pipeline}=env;try{
  pipeline.hold();open(env);input(env,'Host');select(env,'speaker-scope','speaker');$('save-speaker').click();void w.flushContentForTest();await ready();assert.equal(pipeline.writes.length,1);assert.equal($('speaker-dialog').open,false);
  pipeline.writes[0].fail();await ready();assert.equal($('retry-save').hidden,false);assert.equal(w.libraryProbe.documents[0].segments[1].speaker,'Host');
  $('retry-save').click();await ready();assert.equal(pipeline.writes.length,2);pipeline.writes[1].commit();await ready();assert.equal(pipeline.store.status().unsaved,0);
  const saved=JSON.parse(w.localStorage.getItem('coconut-reader-v1'));assert.equal(saved.documents[0].segments[206].speaker,'Host');assert.equal(saved.documents[0].segments[206].original_speaker,'Speaker 1');
 }finally{await w.happyDOM.close();}
});

test('changing documents and returning cannot revive an old correction dialog',async()=>{
 const env=libraryHarness([fixture(),{...fixture(),key:'other',title:'Other source'}],{probe:true}),{w,$,pipeline}=env;try{
  open(env);input(env,'Host');w.document.querySelector('[data-document-key="other"] .library-open').click();$('save-speaker').click();assert.match($('speaker-error').textContent,/已变化/);
  w.document.querySelector('[data-document-key="speakers"] .library-open').click();$('speaker-name').value='Still stale';$('speaker-name').dispatchEvent(new w.Event('input',{bubbles:true}));assert.equal($('save-speaker').disabled,true);assert.equal(w.libraryProbe.documents[0].segments[1].speaker,'Speaker 1');assert.equal(pipeline.prepares,0);
 }finally{await w.happyDOM.close();}
});

test('empty and overlong new labels cannot mutate the document',async()=>{
 const env=setup(),{w,$}=env;try{
  open(env);input(env,' ');assert.equal($('save-speaker').disabled,true);assert.match($('speaker-error').textContent,/不能为空/);input(env,'x'.repeat(1001));assert.equal($('save-speaker').disabled,true);assert.match($('speaker-error').textContent,/1,000/);assert.equal(w.libraryProbe.documents[0].segments[1].speaker,'Speaker 1');
 }finally{await w.happyDOM.close();}
});

for(const empty of [false,true])test(`speaker correction context reports ${empty?'no matching results':'the clamped neighboring result'} after the original cue leaves`,async()=>{
 const doc={key:'context-speaker',title:'Speaker context',segments:[{id:'a',start:0,end:2,text:'First',speaker:'A'},{id:'b',start:2,end:4,text:'Second',speaker:'A'}],notes:{}};
 const env=libraryHarness([doc],{probe:true}),{w,$}=env;try{
  select(env,'speaker-filter',JSON.stringify('A'));
  if(empty){$('search').value='Second';$('search').dispatchEvent(new w.Event('input'));}
  w.document.querySelector('[data-segment-id="b"] .context-button').click();open(env,'b');input(env,'B');$('save-speaker').click();await w.flushContentForTest();await ready();
  assert.match($('reading-context-label').textContent,empty?/原筛选已无匹配结果/:/原片段已离开结果 · 返回第 1 \/ 1 个结果/);
  assert.doesNotMatch($('reading-context-label').textContent,/第 2 \/ 1|第 1 \/ 0/);
  $('return-reading-results').click();assert.equal($('speaker-filter').value,JSON.stringify('A'));
  if(empty){assert.equal($('search').value,'Second');assert.equal($('transcript').querySelectorAll('.segment').length,0);assert.equal(w.document.activeElement,$('search'));}
  else {assert.equal(w.document.activeElement.closest('.segment')?.dataset.segmentId,'a');assert.equal($('transcript').children.length,1);}
 }finally{await w.happyDOM.close();}
});

for(const label of ['A\nB','A\rB','A\r\nB','L'.repeat(1200)])test(`raw speaker label (${label.length} chars, ${JSON.stringify(label.slice(0,8))}) stays clean through display normalization and edit-revert`,async()=>{
 const doc={key:'raw-label',title:'Raw speaker label',segments:[{id:'a',start:0,end:2,text:'Source one',speaker:label},{id:'b',start:2,end:4,text:'Source two',speaker:label}],notes:{}};
 const env=libraryHarness([doc],{probe:true}),{w,$,pipeline}=env;try{
  open(env,'a');const display=label.replace(/[\r\n]/g,'');assert.equal($('speaker-name').value,display);assert.match($('speaker-count').textContent,/将修改 0 段/);
  select(env,'speaker-scope','speaker');assert.match($('speaker-count').textContent,/将修改 0 段/);
  input(env,'Temporary edited label');assert.match($('speaker-count').textContent,/将修改 2 段/);input(env,display);assert.match($('speaker-count').textContent,/将修改 0 段/);
  const event=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(event);assert.equal(event.defaultPrevented,false);
  $('save-speaker').click();await w.flushContentForTest();await ready();assert.equal(pipeline.prepares,0);assert.equal(w.libraryProbe.documents[0].segments[0].speaker,label);assert.equal(w.libraryProbe.documents[0].segments[1].speaker,label);
  open(env,'a');input(env,'New name');assert.match($('speaker-count').textContent,/将修改 1 段/);$('save-speaker').click();await w.flushContentForTest();await ready();assert.equal(w.libraryProbe.documents[0].segments[0].original_speaker,label);
 }finally{await w.happyDOM.close();}
});
