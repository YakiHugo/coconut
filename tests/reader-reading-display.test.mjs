import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {displayedTranslationExportsFixture as fixture} from './helpers/displayed-translation-exports-fixture.mjs';
const setup=(docs=[fixture()])=>libraryHarness(docs,{probe:true});
const choose=(env,value)=>{env.$('translation-view').value=value;env.$('translation-view').onchange();};
const values=env=>[...env.$('translation-view').options].map(option=>option.value);
const visible=node=>{for(let n=node;n;n=n.parentElement)if(n.hidden||n.tagName==='DETAILS'&&!n.open)return false;return true;};
const disk=env=>JSON.parse(env.w.localStorage.getItem('coconut-reader-v1')).documents;

test('one fixed visible reader picker follows actual fallback without a write or AI prerequisites',async()=>{
 const env=setup(),{w,$,pipeline}=env;try{
  const doc=w.libraryProbe.documents[0],before=JSON.stringify(doc),generation=pipeline.store.status().generation,parent=$('translation-view').parentElement;
  assert.equal(w.document.querySelectorAll('#translation-view').length,1);assert.equal($('translation-view').closest('details'),null);assert.equal(visible($('translation-view')),true);
  assert.deepEqual(values(env),['','zh','fr']);assert.equal($('translation-view').value,'zh');assert.equal($('ai-task').value,'question');assert.equal($('language-panel').open,false);
  w.libraryProbe.render();assert.equal(JSON.stringify(doc),before);assert.equal(pipeline.store.status().generation,generation);
  for(const mode of ['mode-transcript','mode-bilingual','mode-passages']){$(mode).click();assert.equal(visible($('translation-view')),true);assert.equal($('translation-view').parentElement,parent);}
  $('mode-summary').click();assert.equal(visible($('translation-view')),false);
 }finally{await w.happyDOM.close();}
});
test('source-only truly hides fallback for this page; concrete choices persist and source-only adds no schema',async()=>{
 const env=setup(),{w,$}=env;let saved;try{
  const doc=w.libraryProbe.documents[0],keys=Object.keys(doc).sort();choose(env,'fr');assert.match($('passage-body').textContent,/Traduction française/);await w.flushContentForTest();saved=disk(env)[0];assert.equal(saved.translation_view,'fr');
  choose(env,'');assert.equal($('translation-view').value,'');assert.equal($('passage-body').querySelector('.passage-translation'),null);assert.equal($('subtitle-bilingual').disabled,true);
  w.libraryProbe.render();assert.equal($('passage-body').querySelector('.passage-translation'),null);assert.deepEqual(Object.keys(doc).sort(),keys);await w.flushContentForTest();assert.equal(disk(env)[0].translation_view,'');
  const reloaded=setup(disk(env));try{assert.equal(reloaded.$('translation-view').value,'zh','source-only uses the established page-local lifecycle');}finally{await reloaded.w.happyDOM.close();}
 }finally{await w.happyDOM.close();}
 const french=setup([saved]);try{assert.equal(french.$('translation-view').value,'fr');assert.match(french.$('passage-body').textContent,/Traduction française/);}finally{await french.w.happyDOM.close();}
});
test('sparse saved options include stale and explicit missing languages, exclude empty-only records, and never leak stale wording',async()=>{
 const doc=fixture({language:'ja'});for(const cue of doc.segments){delete cue.translations.fr;if(cue.translations.zh)cue.translations.zh.source_text='Old source';cue.translations.de={text:'  ',source_text:cue.text,document_language:'en',provider:'user'};}
 const env=setup([doc]),{w,$}=env;try{
  assert.deepEqual(values(env),['','zh','ja']);assert.equal($('translation-view').value,'ja');assert.match($('translation-view').selectedOptions[0].textContent,/暂无已存译文/);assert.ok($('passage-body').querySelector('[data-state="missing"]'));
  choose(env,'zh');assert.ok($('passage-body').querySelector('[data-state="stale"]'));assert.doesNotMatch($('passage-body').textContent,/SECRET|中文译文/);
  choose(env,'');assert.equal($('translation-view').value,'');assert.equal($('passage-body').querySelector('.passage-translation'),null);
 }finally{await w.happyDOM.close();}
 const blank=fixture();for(const cue of blank.segments)cue.translations={zh:{text:' ',source_text:cue.text,document_language:'en',provider:'user'}};
 const empty=setup([blank]);try{assert.deepEqual(values(empty),['']);assert.equal(empty.$('translation-view').disabled,true);assert.match(empty.$('translation-view').textContent,/暂无已存译文/);assert.equal(empty.$('subtitle-bilingual').disabled,true);}finally{await empty.w.happyDOM.close();}
});
test('display change preserves AI controls/consent/drafts, select focus and untouched note IME/caret',async()=>{
 const env=setup(),{w,$}=env;try{
  $('mode-bilingual').click();w.document.querySelector('.note-button').click();const note=$('note');note.value='未提交输入法草稿';note.focus();note.setSelectionRange(2,5);note.dispatchEvent(new w.CompositionEvent('compositionstart',{data:'草稿'}));
  $('translation-glossary').value='authored = 未保存草稿';$('ai-question').value='An unsent question';$('ai-consent').checked=true;
  const ids=['ai-task','translation-source','translation-target','ai-provider','translation-glossary','ai-question'],before=ids.map(id=>$(id).value);let fetches=0;w.fetch=async()=>{fetches++;throw Error('not authorized');};
  choose(env,'fr');assert.equal(w.document.activeElement,note);assert.equal($('note'),note);assert.equal(note.value,'未提交输入法草稿');assert.equal(note.selectionStart,2);assert.equal(note.selectionEnd,5);assert.equal($('notes-panel').hidden,false);
  assert.deepEqual(ids.map(id=>$(id).value),before);assert.equal($('ai-consent').checked,true);assert.equal(fetches,0);assert.equal(w.document.body.dataset.readingMode,'transcript');
  $('translation-view').focus();choose(env,'zh');assert.equal(w.document.activeElement,$('translation-view'));assert.equal(note.value,'未提交输入法草稿');
 }finally{await w.happyDOM.close();}
});
test('late transcript page uses visible cue rather than selected note, preserves offset and bookmark',async()=>{
 const env=setup([fixture({count:240})]),{w,$}=env;try{
  $('mode-bilingual').click();$('next-page').click();const first=$('transcript').querySelector('.segment');first.querySelector('.note-button').click();const doc=w.libraryProbe.documents[0];doc.readingPosition='cue-2';
  const id=$('transcript').querySelectorAll('.segment')[20].dataset.segmentId,index=Number(id.slice(4)),page=$('reading-page-status').textContent,scrolls=[];
  w.HTMLElement.prototype.getBoundingClientRect=function(){if(!this.matches('.segment'))return {top:0,bottom:0};const i=Number(this.dataset.segmentId.slice(4)),top=(i-index)*100+(doc.translation_view==='fr'?123:23);return {top,bottom:top+50};};w.scrollBy=(x,y)=>scrolls.push(y);
  choose(env,'fr');assert.equal(scrolls.at(-1),100);assert.equal($('reading-page-status').textContent,page);assert.equal(doc.readingPosition,'cue-2');assert.equal($('notes-panel').hidden,false);assert.equal($('note-time').textContent.startsWith(w.Coconut.time(doc.segments.find(cue=>cue.id===first.dataset.segmentId).start)),true);
 }finally{await w.happyDOM.close();}
});
test('later passage page keeps its visible source and export checkboxes reset for language changes',async()=>{
 const env=setup([fixture({count:240})]),{w,$}=env;try{
  $('passage-next').click();const first=$('passage-body').querySelector('.passage-original .passage-cue').dataset.cueId,page=$('passage-page-status').textContent;
  $('text-bilingual').checked=$('subtitle-bilingual').checked=true;choose(env,'fr');assert.equal($('passage-body').querySelector('.passage-original .passage-cue').dataset.cueId,first);assert.equal($('passage-page-status').textContent,page);assert.equal($('text-bilingual').checked,false);assert.equal($('subtitle-bilingual').checked,false);
  $('text-bilingual').checked=$('subtitle-bilingual').checked=true;w.libraryProbe.render();assert.equal($('text-bilingual').checked,true);assert.equal($('subtitle-bilingual').checked,true);
 }finally{await w.happyDOM.close();}
});
for(const mode of ['offline','subscription'])for(const choice of ['fr','source','ABA','unchanged','replacement'])test(`${mode} late result respects ${choice} selection and original task target`,async()=>{
 const env=setup([fixture({count:4,language:'fr'})]),{w,$}=env;let release,run,request;try{
  $('mode-bilingual').click();w.fetch=async(url,options)=>{if(url.endsWith('language-tools'))return {ok:true,json:async()=>({local_translation:true,ai:{codex:{ready:true}}})};request=JSON.parse(options.body);return new Promise(resolve=>release=()=>resolve({ok:true,json:async()=>({translations:request.segments.map(cue=>({id:cue.id,source_text:cue.text,text:'Authored Japanese result',provider:'fixture'}))})}));};
  await $('check-ai').onclick();$('ai-task').value='translation';$('ai-task').onchange();$('translation-target').value='ja';$('translation-target').onchange();$('ai-consent').checked=true;
  const doc=w.libraryProbe.documents[0];run=$(mode==='offline'?'translate-document':'subscription-translate').onclick();assert.ok(release);assert.equal(request.target,'ja');
  if(choice==='fr')choose(env,'fr');if(choice==='source')choose(env,'');if(choice==='ABA'){choose(env,'zh');choose(env,'fr');}if(choice==='replacement')w.libraryProbe.documents[0]={...doc};
  const next=w.libraryProbe.documents[0];if(choice!=='replacement')assert.equal($('ai-consent').checked,true,'display change does not cancel a task');release();await run;
  if(choice==='replacement'){assert.equal(next.segments[0].translations.ja,undefined);assert.equal(next.translation_view,'fr');}
  else{assert.equal(doc.segments[0].translations.ja.text,'Authored Japanese result');assert.equal(doc.translation_view,choice==='unchanged'?'ja':choice==='source'?'':'fr');assert.equal(request.target,'ja');}
 }finally{release?.();await run;await w.happyDOM.close();}
});
for(const kind of ['audio','video'])test(`${kind} real follow owner survives picker input and the next frame; ordinary wheel still suspends`,async()=>{
 const doc=fixture();doc.source_media={job_id:'a'.repeat(32),kind};const env=setup([doc]),{w,$}=env;try{
  w.dispatchEvent(new w.Event('coconut-worker-ready'));$('mode-bilingual').click();const player=$('source-media').querySelector(kind);assert.ok(player);
  let time=37,seeks=0,plays=0,pauses=0,next=0;const frames=new Map();w.requestAnimationFrame=fn=>{frames.set(++next,fn);return next;};w.cancelAnimationFrame=id=>frames.delete(id);const tick=()=>{const ready=[...frames.values()];frames.clear();for(const fn of ready)fn();};
  Object.defineProperties(player,{currentTime:{configurable:true,get:()=>time,set:value=>{time=value;seeks++;}},paused:{configurable:true,value:false},duration:{configurable:true,value:1200}});player.playbackRate=1.5;player.loop=true;player.play=async()=>{plays++;};player.pause=()=>{pauses++;};player.onloadedmetadata();player.playbackRate=1.5;
  $('follow-playback').focus();$('follow-playback').click();tick();assert.equal($('follow-playback').dataset.state,'following');
  const control=$('translation-view');control.dispatchEvent(new w.PointerEvent('pointerdown',{bubbles:true}));control.focus();control.click();control.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));control.dispatchEvent(new w.Event('input',{bubbles:true}));
  choose(env,'fr');choose(env,'');choose(env,'zh');player.dispatchEvent(new w.Event('timeupdate'));tick();
  assert.equal($('source-media').querySelector(kind),player);assert.equal(player.currentTime,37);assert.equal(player.paused,false);assert.equal(player.playbackRate,1.5);assert.equal(player.loop,true);assert.equal($('follow-playback').dataset.state,'following');assert.deepEqual([seeks,plays,pauses],[0,0,0]);
  w.dispatchEvent(new w.WheelEvent('wheel',{deltaY:40,bubbles:true}));tick();assert.equal($('follow-playback').dataset.state,'suspended');
 }finally{await w.happyDOM.close();}
});
