import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {settle} from './helpers/save-pipeline.mjs';
const fixture=()=>({key:'source',title:'Local source corrections',language:'en',segments:Array.from({length:240},(_,i)=>({id:'cue-'+i,start:i*2,end:i*2+2,text:'Name '+i+' Name',speaker:i%2?'B':'A',...(i===1?{original_text:'ASR baseline'}:{})})),notes:{}});
const setup=(docs=[fixture()])=>libraryHarness(docs,{probe:true});
const input=(env,id,value)=>{env.$(id).value=value;env.$(id).dispatchEvent(new env.w.Event('input',{bubbles:true}));};
function preview(env,find='Name',replacement='New Name'){env.$('open-source-correction').click();input(env,'source-find',find);input(env,'source-replace',replacement);env.$('preview-source-correction').click();}
async function ready(){await settle();await new Promise(resolve=>setTimeout(resolve,0));}

test('explicit preview covers hidden cues, paginates hits, and preserves cross-page partial selection',async()=>{
 const env=setup(),{w,$,pipeline}=env;try{
  const doc=w.libraryProbe.documents[0];$('search').value='Name 1 ';$('search').dispatchEvent(new w.Event('input'));await ready();preview(env,'Name','Correct');
  assert.match($('source-correction-count').textContent,/480 处 \/ 240 个原片段/);assert.equal($('source-correction-results').children.length,20);assert.equal(pipeline.prepares,0);
  $('source-correction-results').querySelector('input[value="1"]').click();$('source-correction-next').click();$('clear-source-page').click();$('source-correction-prev').click();assert.equal($('source-correction-results').querySelector('input[value="1"]').checked,false);assert.match($('source-correction-count').textContent,/已选 459 处/);
  $('apply-source-correction').click();await w.flushContentForTest();await ready();assert.equal(doc.segments[0].text,'Correct 0 Name');assert.equal(doc.segments[10].text,'Name 10 Name');assert.equal(doc.segments[239].text,'Correct 239 Correct');assert.equal($('search').value,'Name 1 ');assert.match($('source-correction-status').textContent,/已保存到本机/);
  assert.equal($('apply-source-correction').disabled,true);assert.equal($('undo-source-correction').hidden,false);assert.match($('source-correction-undo-help').textContent,/新批次将替换/);
 }finally{await w.happyDOM.close();}
});

test('editing either input discards preview, and Escape, no-op and zero matches never save',async()=>{
 const env=setup(),{w,$,pipeline}=env;try{
  const doc=w.libraryProbe.documents[0],bytes=JSON.stringify(doc);preview(env);input(env,'source-replace','Another');assert.equal($('apply-source-correction').disabled,true);assert.equal($('source-correction-results').children.length,0);$('apply-source-correction').click();assert.equal(JSON.stringify(doc),bytes);
  $('preview-source-correction').click();input(env,'source-find','Absent');$('preview-source-correction').click();assert.match($('source-correction-count').textContent,/没有匹配/);assert.equal($('apply-source-correction').disabled,true);
  input(env,'source-find','Name');input(env,'source-replace','Name');$('preview-source-correction').click();assert.match($('source-correction-count').textContent,/相同/);assert.equal($('apply-source-correction').disabled,true);
  $('source-correction-dialog').dispatchEvent(new w.Event('cancel',{cancelable:true}));assert.equal($('source-correction-dialog').open,false);assert.equal(w.document.activeElement,$('open-source-correction'));assert.equal(pipeline.prepares,0);assert.equal(JSON.stringify(doc),bytes);
 }finally{await w.happyDOM.close();}
});

test('old previews reject added or edited source but preserve new annotations when source still matches',async()=>{
 const env=setup(),{w,$}=env;try{
  const doc=w.libraryProbe.documents[0];preview(env);doc.segments[239].text+=' changed';$('apply-source-correction').click();assert.match($('source-correction-error').textContent,/重新预览/);assert.equal(doc.segments[0].text,'Name 0 Name');$('preview-source-correction').click();doc.notes['cue-0']='While preview open';doc.segments[0].speaker='New label';$('apply-source-correction').click();await w.flushContentForTest();assert.equal(doc.notes['cue-0'],'While preview open');assert.equal(doc.segments[0].speaker,'New label');
 }finally{await w.happyDOM.close();}
});

test('save failure retains memory, JSON rescue and retry saves once without repeating replacement',async()=>{
 const env=setup(),{w,$,pipeline}=env;try{
  pipeline.hold();preview(env,'Name','Name Name');$('apply-source-correction').click();await ready();assert.equal(pipeline.writes.length,1);assert.match($('source-correction-status').textContent,/正在保存/);assert.equal(w.libraryProbe.documents[0].segments[0].text,'Name Name 0 Name Name');
  pipeline.writes[0].fail();await ready();assert.equal($('source-correction-retry').hidden,false);assert.equal($('source-correction-export').hidden,false);assert.match($('source-correction-status').textContent,/尚未保存/);
  const before=JSON.stringify(w.libraryProbe.documents[0]);$('source-correction-retry').click();await ready();assert.equal(pipeline.writes.length,2);pipeline.writes[1].commit();await ready();assert.equal(JSON.stringify(w.libraryProbe.documents[0]),before);assert.match($('source-correction-status').textContent,/已保存/);assert.equal(pipeline.store.status().unsaved,0);
  const disk=JSON.parse(w.localStorage.getItem('coconut-reader-v1'));assert.equal(disk.documents[0].segments[239].text,'Name Name 239 Name Name');
 }finally{await w.happyDOM.close();}
});

test('immediate undo queues a newer version, old receipt cannot clear it, and undo failure also retries only persistence',async()=>{
 const env=setup(),{w,$,pipeline}=env;try{
  pipeline.hold();preview(env);$('apply-source-correction').click();await ready();$('undo-source-correction').click();assert.equal(w.libraryProbe.documents[0].segments[0].text,'Name 0 Name');assert.equal(Object.hasOwn(w.libraryProbe.documents[0].segments[0],'original_text'),false);assert.equal(w.libraryProbe.documents[0].segments[1].original_text,'ASR baseline');
  $('source-find').focus();pipeline.writes[0].commit();await ready();assert.equal(pipeline.writes.length,2);assert.equal(w.document.activeElement,$('source-find'));assert.notEqual(pipeline.store.status().unsaved,0);assert.doesNotMatch($('source-correction-status').textContent,/已保存/);
  pipeline.writes[1].fail();await ready();assert.equal($('source-correction-retry').hidden,false);$('source-correction-retry').click();await ready();pipeline.writes[2].commit();await ready();const disk=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.equal(disk.segments[0].text,'Name 0 Name');assert.equal(Object.hasOwn(disk.segments[0],'original_text'),false);assert.match($('source-correction-status').textContent,/撤销；已保存/);
 }finally{await w.happyDOM.close();}
});

test('closing or navigating before a late save never reopens the dialog, applies twice, or steals newer focus',async()=>{
 for(const navigate of [false,true]){
  const env=setup([fixture(),{...fixture(),key:'other',title:'Other'}]),{w,$,pipeline}=env;try{
   pipeline.hold();preview(env);$('apply-source-correction').click();await ready();$('close-source-correction').click();if(navigate)w.document.querySelector('[data-document-key="other"] .library-open').click();$('search').focus();pipeline.writes[0].commit();await ready();assert.equal($('source-correction-dialog').open,false);assert.equal(w.document.activeElement,$('search'));assert.equal(w.libraryProbe.documents[0].segments[0].text,'New Name 0 New Name');assert.equal(w.libraryProbe.documents[1].segments[0].text,'Name 0 Name');assert.equal(pipeline.writes.length,1);
  }finally{await w.happyDOM.close();}
 }
});

test('navigation cannot revive a draft, latest-batch undo remains local and refuses later related edits',async()=>{
 const env=setup([fixture(),{...fixture(),key:'other'}]),{w,$,pipeline}=env;try{
  preview(env);w.document.querySelector('[data-document-key="other"] .library-open').click();assert.equal($('source-correction-dialog').open,false);$('apply-source-correction').click();assert.equal(pipeline.prepares,0);
  w.document.querySelector('[data-document-key="source"] .library-open').click();preview(env);$('apply-source-correction').click();await w.flushContentForTest();$('close-source-correction').click();$('open-source-correction').click();assert.equal($('undo-source-correction').hidden,false);
  w.libraryProbe.documents[0].segments[0].text='Later manual source';$('undo-source-correction').click();assert.match($('source-correction-error').textContent,/不能覆盖/);assert.equal(w.libraryProbe.documents[0].segments[0].text,'Later manual source');
 }finally{await w.happyDOM.close();}
});

test('known correction and undo keep inline exact excerpt association current without accepting an unknown same-ID replacement',async()=>{
 const env=setup(),{w,$}=env;try{
  const doc=w.libraryProbe.documents[0],cue=doc.segments[0];doc.exact_excerpts=[w.Coconut.exactExcerptSnapshot(doc,[cue],[],0,cue.text.length,{id:'exact',createdAt:'2026-10-11T00:00:00.000Z'})];w.libraryProbe.render();const bytes=JSON.stringify(doc.exact_excerpts);
  preview(env);$('apply-source-correction').click();assert.equal(w.document.querySelector('[data-segment-id="cue-0"] .reading-excerpt-open').dataset.history,'true');$('undo-source-correction').click();assert.equal(w.document.querySelector('[data-segment-id="cue-0"] .reading-excerpt-open').dataset.history,'false');assert.equal(JSON.stringify(doc.exact_excerpts),bytes);
  doc.segments[0]={...doc.segments[0]};w.libraryProbe.render();assert.equal(w.document.querySelector('[data-segment-id="cue-0"] .reading-excerpt-open').dataset.history,'true');
  await w.flushContentForTest();
 }finally{await w.happyDOM.close();}
});

test('modal Tab wraps valid boundaries, unsaved preview is guarded, and applied input no longer counts as a draft',async()=>{
 const env=setup(),{w,$}=env;try{
  preview(env);const event=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(event);assert.equal(event.defaultPrevented,true);
  const tab=(node,shiftKey=false)=>{node.focus();const event=new w.KeyboardEvent('keydown',{key:'Tab',shiftKey,bubbles:true,cancelable:true});node.dispatchEvent(event);return event;};
  assert.equal(tab($('close-source-correction')).defaultPrevented,true);assert.equal(w.document.activeElement,$('source-find'));assert.equal(tab($('source-find'),true).defaultPrevented,true);assert.equal(w.document.activeElement,$('close-source-correction'));
  $('apply-source-correction').click();await w.flushContentForTest();await ready();const clean=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(clean);assert.equal(clean.defaultPrevented,false);
 }finally{await w.happyDOM.close();}
});

for(const control of ['source-correction-retry','source-correction-export'])test(`late save keeps focused ${control} mounted until focus leaves`,async()=>{
 const env=setup(),{w,$,pipeline}=env;try{
  pipeline.hold();preview(env);$('apply-source-correction').click();await ready();pipeline.writes[0].fail();await ready();$(control).focus();
  if(control==='source-correction-retry')$(control).click();else void pipeline.store.retry();
  await ready();assert.equal($(control).hidden,false);assert.equal($(control).disabled,false);assert.equal(w.document.activeElement,$(control));pipeline.writes[1].commit();await ready();assert.equal($(control).hidden,false);assert.equal($(control).disabled,false);assert.equal(w.document.activeElement,$(control));
  $('source-find').focus();await ready();assert.equal($(control).hidden,true);
 }finally{await w.happyDOM.close();}
});

test('continuous-reading correction returns to settings, whose visible close restores access to transcript mode',async()=>{
 const env=setup(),{w,$,pipeline}=env;try{
  const doc=w.libraryProbe.documents[0],before=JSON.stringify(doc);
  assert.equal(w.document.body.dataset.readingMode,'passages');assert.equal($('reading-info-settings').contains($('reading-settings')),true);
  $('reading-info').open=true;preview(env);$('close-source-correction').click();
  assert.equal($('source-correction-dialog').open,false);assert.equal($('reading-info').open,true);assert.equal(w.document.activeElement,$('open-source-correction'));
  $('close-reading-info').click();assert.equal($('reading-info').open,false);assert.equal(w.document.activeElement,$('reading-info').querySelector('summary'));
  $('mode-transcript').click();assert.equal($('mode-transcript').getAttribute('aria-pressed'),'true');assert.equal(w.document.body.dataset.readingMode,'transcript');
  assert.equal(JSON.stringify(doc),before);assert.equal(pipeline.prepares,0);
 }finally{await w.happyDOM.close();}
});

for(const width of [390,1360])test(`${width} reading-mode pointer targets retain their explicit minimum across correction return modes`,async()=>{
 const env=setup(),{w,$}=env;try{
  w.happyDOM.setWindowSize({width,height:844});
  const style=w.document.createElement('style');style.textContent=fs.readFileSync(new URL('../reader/style.css',import.meta.url),'utf8');w.document.head.append(style);
  for(const mode of ['passages','transcript']){
   $('mode-'+mode).click();
   for(const button of w.document.querySelectorAll('.reading-modes button'))assert.equal(w.getComputedStyle(button).minWidth,width===390?'52px':'44px',button.id+' in '+mode);
  }
  // Computed CSS bounds are not a claim about real layout or hit-testing. The
  // Actions journey keeps its native clicks and 44px / five-point checks.
 }finally{await w.happyDOM.close();}
});
