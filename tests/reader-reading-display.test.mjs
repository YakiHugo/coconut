import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {readingDisplayFixture} from './helpers/reading-display-fixture.mjs';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {displayedTranslationExportsFixture as fixture} from './helpers/displayed-translation-exports-fixture.mjs';
const setup=(docs=[fixture()])=>libraryHarness(docs,{localService:true,probe:true});
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

test('native seven-language fixture has the real normalized en fallback, actual text and no display write',async()=>{
 const doc=readingDisplayFixture({count:112});assert.deepEqual(Object.keys(doc.segments[0].translations),['en','zh','ja','ko','fr','de','es']);
 const env=setup([doc]),{w,$,pipeline}=env;try{
  const generation=pipeline.store.status().generation,before=JSON.stringify(w.libraryProbe.documents[0]);
  assert.equal($('translation-view').value,'en');assert.equal($('passage-body').querySelector('.passage-translation').lang,'en');assert.match($('passage-body').textContent,/en authored saved reading/);assert.equal(w.libraryProbe.documents[0].translation_view,'');
  w.libraryProbe.render();assert.equal(pipeline.store.status().generation,generation);assert.equal(JSON.stringify(w.libraryProbe.documents[0]),before);
  assert.deepEqual(values(env),['','en','zh','ja','ko','fr','de','es']);
 }finally{await w.happyDOM.close();}
});
test('the one sticky mode/display owner spans both text surfaces outside the intro, across resize and modes',async()=>{
 const env=setup(),{w,$}=env;try{
  const toolbar=$('reading-mode-toolbar'),select=$('translation-view'),parent=select.parentElement;assert.equal(toolbar.parentElement,$('reader-workspace'));assert.equal(toolbar.closest('.intro'),null);assert.equal($('reading-modes').parentElement,toolbar);assert.equal(parent.parentElement,toolbar);
  for(const surface of ['passage-workspace','transcript-controls','reader-options','transcript-layout'])assert.equal($(surface).parentElement,$('reader-workspace'));
  select.focus();for(const width of [320,1360,390]){w.happyDOM.setWindowSize({width,height:650});assert.equal($('translation-view'),select);assert.equal(select.parentElement,parent);assert.equal(w.document.activeElement,select);}
  $('mode-transcript').click();assert.equal($('translation-view'),select);$('mode-summary').click();assert.equal($('reading-display-control').hidden,true);$('mode-passages').click();assert.equal($('reading-display-control').hidden,false);
  const css=fs.readFileSync(new URL('../reader/style.css',import.meta.url),'utf8');assert.match(css,/reading-mode-toolbar \{ position:sticky; top:6px/);assert.match(css,/reading-display-control \{[^}]*margin:0; padding:0;/);assert.doesNotMatch(css,/@media\(max-width:400px\) \{ \.reading-display-control select/);
  assert.match(css,/:has\(#transcript-tools-disclosure:not\(\[open\]\)\):has\(#language-panel:not\(\[open\]\)\) #reader-workspace/);
 }finally{await w.happyDOM.close();}
});

test('language reflow anchors the first source cue below the whole sticky toolbar, not an obscured cue',async()=>{
 const env=setup(),{w,$}=env;try{
  $('mode-bilingual').click();const doc=w.libraryProbe.documents[0],scrolls=[];$('reading-mode-toolbar').style.top='6px';
  w.HTMLElement.prototype.getBoundingClientRect=function(){
   if(this.id==='reading-mode-toolbar')return {top:6,bottom:94,height:88};
   if(!this.matches('.segment'))return {top:0,bottom:0,height:0};
   const index=Number(this.dataset.segmentId.slice(4)),top=index===0?10:100+(index-1)*100+(doc.translation_view==='fr'?120:0);return {top,bottom:top+50,height:50};
  };w.scrollBy=(x,y)=>scrolls.push(y);
  choose(env,'fr');assert.equal(scrolls.at(-1),120);assert.equal(doc.readingPosition,undefined);
 }finally{await w.happyDOM.close();}
});

test('all four retained return bars stack by current DOM order, reset hidden insets, and never scroll or move focus',async()=>{
 const env=setup(),{w,$}=env;try{
  $('mode-bilingual').click();const toolbar=$('reading-mode-toolbar'),select=$('translation-view'),bars=[...w.document.querySelectorAll('#reader-workspace > .reading-context')];assert.equal(bars.length,4);
  let toolbarHeight=88;const heights=new Map(bars.map((bar,i)=>[bar,60+i*10])),parents=new Map(bars.map(bar=>[bar,bar.parentElement]));let scrolls=0;w.scrollBy=w.scrollTo=()=>{scrolls++;};
  toolbar.getBoundingClientRect=()=>({top:6,height:toolbarHeight,bottom:6+toolbarHeight});
  for(const bar of bars){bar.hidden=false;bar.getBoundingClientRect=()=>({top:parseFloat(bar.style.top)||6,height:bar.hidden?0:heights.get(bar),bottom:(parseFloat(bar.style.top)||6)+(bar.hidden?0:heights.get(bar))});}
  select.focus();w.dispatchEvent(new w.Event('resize'));let expected=100;for(const bar of bars){assert.equal(bar.style.top,expected+'px');expected+=heights.get(bar)+6;assert.equal(bar.parentElement,parents.get(bar));}
  bars[1].hidden=true;toolbarHeight=44;w.dispatchEvent(new w.Event('resize'));expected=56;for(const bar of bars){assert.equal(bar.style.top,(bar.hidden?6:expected)+'px');if(!bar.hidden)expected+=heights.get(bar)+6;}
  assert.equal(scrolls,0);assert.equal(w.document.activeElement,select);assert.equal($('translation-view'),select);
  for(const bar of bars)bar.hidden=true;w.dispatchEvent(new w.Event('resize'));assert.ok(bars.every(bar=>bar.style.top==='6px'));
 }finally{await w.happyDOM.close();}
});
test('a pinned return row also excludes covered source cues from display anchoring',async()=>{
 const env=setup(),{w,$}=env;try{
  $('mode-bilingual').click();const doc=w.libraryProbe.documents[0],scrolls=[];$('reading-context').hidden=false;
  w.HTMLElement.prototype.getBoundingClientRect=function(){
   if(this.id==='reading-mode-toolbar')return {top:6,bottom:94,height:88};
   if(this.id==='reading-context')return {top:100,bottom:188,height:88};
   if(!this.matches('.segment'))return {top:0,bottom:0,height:0};
   const index=Number(this.dataset.segmentId.slice(4)),top=index===0?110:220+(index-1)*100+(doc.translation_view==='fr'?120:0);return {top,bottom:top+50,height:50};
  };w.dispatchEvent(new w.Event('resize'));w.scrollBy=(x,y)=>scrolls.push(y);choose(env,'fr');assert.equal(scrolls.at(-1),120);assert.equal(doc.readingPosition,undefined);
 }finally{await w.happyDOM.close();}
});
test('native backup comparison crosses only the JSON prototype boundary and still rejects every changed field or cue order',()=>{
 const doc=readingDisplayFixture({count:240}),expected=JSON.parse(JSON.stringify(doc.segments));assert.equal(Object.getPrototypeOf(doc.segments[0].translations),null);assert.throws(()=>assert.deepEqual(expected,doc.segments));assert.deepEqual(expected,JSON.parse(JSON.stringify(doc.segments)));
 for(const mutate of [cues=>{cues[239].text+='changed';},cues=>{cues[0].start+=1;},cues=>{cues[239].translations.fr.text+='changed';},cues=>{delete cues[2].translations.zh.source_text;},cues=>cues.reverse()]){const changed=JSON.parse(JSON.stringify(expected));mutate(changed);assert.throws(()=>assert.deepEqual(changed,expected));}
});

test('natural-flow toolbar and return row do not exclude source cues near the viewport top',async()=>{
 const env=setup(),{w,$}=env;try{
  $('mode-bilingual').click();const doc=w.libraryProbe.documents[0],scrolls=[];$('reading-context').hidden=false;
  w.HTMLElement.prototype.getBoundingClientRect=function(){
   if(this.id==='reading-mode-toolbar')return {top:200,bottom:288,height:88};
   if(this.id==='reading-context')return {top:400,bottom:488,height:88};
   if(!this.matches('.segment'))return {top:0,bottom:0,height:0};
   const index=Number(this.dataset.segmentId.slice(4)),top=index===0?(doc.translation_view==='fr'?95:20):220+index*100+(doc.translation_view==='fr'?120:0);return {top,bottom:top+50,height:50};
  };w.dispatchEvent(new w.Event('resize'));w.scrollBy=(x,y)=>scrolls.push(y);choose(env,'fr');assert.equal(scrolls.at(-1),75);
 }finally{await w.happyDOM.close();}
});
test('narrow utility labels retain the full names, titles and expanded state without replacing control nodes',async()=>{
 const env=setup(),{w,$}=env;try{
  const info=$('reading-info').querySelector('summary'),media=$('toggle-reader-media');assert.equal(info.getAttribute('aria-label'),'信息与设置');assert.equal(info.title,'信息与设置');assert.equal(info.querySelector('.utility-label-short').textContent,'设置');
  assert.equal(media.getAttribute('aria-label'),'关联原声');assert.equal(media.title,'关联原声');assert.equal($('reader-media-short-label').textContent,'原声');assert.equal(media.getAttribute('aria-expanded'),'false');media.click();assert.equal($('toggle-reader-media'),media);assert.equal(media.getAttribute('aria-expanded'),'true');assert.equal(media.getAttribute('aria-label'),'收起原声');assert.equal(media.title,'收起原声');assert.equal($('reader-media-short-label').textContent,'收起');
  const css=fs.readFileSync(new URL('../reader/style.css',import.meta.url),'utf8');assert.match(css,/@media\(max-width:350px\)/);assert.match(css,/reading-utility\.is-compact \{ column-gap:8px;/);assert.match(css,/\.media-disclosure,\.reading-info > summary\) \{ min-width:44px;/);
 }finally{await w.happyDOM.close();}
});

test('a searched passage lands below the measured toolbar plus return row, not the fixed legacy margin',async()=>{
 const env=setup(),{w,$}=env;try{
  $('mode-bilingual').click();const doc=w.libraryProbe.documents[0];doc.readingPosition='cue-3';$('search').value='Authored source 25';$('search').oninput();$('transcript').querySelector('.context-button').click();
  let landing=112;const corrections=[];
  w.HTMLElement.prototype.getBoundingClientRect=function(){
   if(this.id==='reading-mode-toolbar')return {top:6,bottom:94,height:88};
   if(this.id==='reading-context')return {top:100,bottom:188,height:88};
   if(this.matches('.passage'))return {top:landing,bottom:landing+500,height:500};
   if(this.matches('.passage-original'))return {top:landing+40,bottom:landing+150,height:110};
   return {top:0,bottom:0,height:0};
  };w.HTMLElement.prototype.scrollIntoView=function(){if(this.matches('.passage'))landing=112;};w.scrollBy=(x,y)=>{corrections.push(y);landing-=y;};
  $('mode-passages').click();const target=w.document.activeElement;assert.ok(target.matches('.passage'));assert.equal($('reading-context').nextElementSibling,$('passage-workspace'));assert.equal(landing,194);assert.deepEqual(corrections,[-82]);assert.ok(target.querySelector('.passage-original').getBoundingClientRect().top>188);assert.equal(doc.readingPosition,'cue-3');
  $('return-reading-results').click();assert.equal($('search').value,'Authored source 25');assert.equal($('transcript').querySelectorAll('.segment').length,1);assert.equal(doc.readingPosition,'cue-3');
 }finally{await w.happyDOM.close();}
});

for(const route of ['jump-long-cue','next-page','mode-switch','next-long-match'])test(`${route} reserves the measured sticky stack for a fresh landing`,async()=>{
 const env=setup([fixture({count:240})]),{w,$}=env;try{
  $('mode-bilingual').click();if(route==='next-long-match'){$('search').value='Authored source';$('search').oninput();}
  const tops=new Map(),calls=[];const rect=(top,height)=>({top,bottom:top+height,height,width:320,left:0,right:320});
  w.HTMLElement.prototype.getBoundingClientRect=function(){if(this.id==='reading-mode-toolbar')return rect(6,88);if(this.matches('.segment'))return rect(tops.get(this)??1800,route.includes('long')?900:100);return rect(0,0);};
  w.HTMLElement.prototype.scrollIntoView=function(options){if(!this.matches('.segment'))return;calls.push({node:this,options,margin:this.style.scrollMarginTop});tops.set(this,options.block==='start'?parseFloat(this.style.scrollMarginTop):350);};
  w.scrollBy=(x,y)=>{for(const [node,top]of tops)tops.set(node,top-y);};
  if(route==='jump-long-cue'){$('reading-jump').value='cue-100';$('reading-jump').onchange();}else if(route==='next-page')$('next-page').click();else if(route==='mode-switch')$('mode-transcript').click();else $('next-match').click();
  const call=calls.at(-1);assert.ok(call);assert.equal(call.margin,'100px');assert.ok(call.node.getBoundingClientRect().top>=100);assert.equal(call.node.style.scrollMarginTop,'');if(route==='jump-long-cue')assert.equal(call.options.behavior,'smooth');
 }finally{await w.happyDOM.close();}
});
test('reader history temporary scroll margin restores its authored value and priority even if native scrolling throws',async()=>{
 const env=setup(),{w,$}=env;try{
  const heading=$('ai-history-heading');heading.style.setProperty('scroll-margin-top','31px','important');$('language-panel').open=true;
  $('reading-mode-toolbar').getBoundingClientRect=()=>({top:6,bottom:94,height:88});heading.getBoundingClientRect=()=>({top:100,bottom:140,height:40});
  let calls=0;heading.scrollIntoView=options=>{calls++;assert.equal(options.block,'start');assert.equal(heading.style.scrollMarginTop,'100px');assert.equal(heading.style.getPropertyPriority('scroll-margin-top'),'important');};
  $('ai-history-latest').onclick();assert.equal(calls,1);assert.equal(heading.style.scrollMarginTop,'31px');assert.equal(heading.style.getPropertyPriority('scroll-margin-top'),'important');
  heading.scrollIntoView=()=>{throw Error('Authored native scroll failure');};assert.throws(()=>$('ai-history-latest').onclick(),/Authored native scroll failure/);assert.equal(heading.style.scrollMarginTop,'31px');assert.equal(heading.style.getPropertyPriority('scroll-margin-top'),'important');
 }finally{await w.happyDOM.close();}
});
test('dialog-owned history retains its local scroll owner and never receives reader stack margins or page compensation',async()=>{
 const env=setup(),{w,$}=env;try{
  const heading=$('ai-history-heading'),dialog=$('passage-question-dialog');dialog.append(heading);dialog.open=true;heading.style.setProperty('scroll-margin-top','12px','important');
  let pageScrolls=0,measures=0,calls=0;w.scrollBy=()=>{pageScrolls++;};$('reading-mode-toolbar').getBoundingClientRect=()=>{measures++;return {top:6,bottom:94,height:88};};
  heading.scrollIntoView=options=>{calls++;assert.equal(options.block,'start');assert.equal(heading.style.scrollMarginTop,'12px');assert.equal(heading.style.getPropertyPriority('scroll-margin-top'),'important');};
  $('ai-history-latest').onclick();assert.equal(calls,1);assert.equal(pageScrolls,0);assert.equal(measures,0);assert.equal(w.document.activeElement,heading);
 }finally{await w.happyDOM.close();}
});
test('desktop notes reserve the measured stack while the mobile bottom-sheet rule remains independent',async()=>{
 const env=setup(),{w,$}=env;try{
  const toolbar=$('reading-mode-toolbar'),bar=$('reading-context'),workspace=$('reader-workspace');let height=88;toolbar.getBoundingClientRect=()=>({top:6,bottom:6+height,height});bar.hidden=false;bar.getBoundingClientRect=()=>({top:100,bottom:188,height:88});
  w.dispatchEvent(new w.Event('resize'));assert.equal(workspace.style.getPropertyValue('--reading-sticky-inset'),'194px');bar.hidden=true;height=44;w.dispatchEvent(new w.Event('resize'));assert.equal(workspace.style.getPropertyValue('--reading-sticky-inset'),'56px');toolbar.hidden=true;w.dispatchEvent(new w.Event('resize'));assert.equal(workspace.style.getPropertyValue('--reading-sticky-inset'),'6px');
  const css=fs.readFileSync(new URL('../reader/style.css',import.meta.url),'utf8');assert.match(css,/@media \(min-width: 1101px\) \{\s*#notes-panel \{ top: max\(24px, var\(--reading-sticky-inset, 6px\)\);/);assert.match(css,/#notes-panel \{ position: fixed;[^}]*top: auto; bottom: 12px; max-height: 65dvh;/);
 }finally{await w.happyDOM.close();}
});

function focusedPickerGeometry(env){
 const {w,$}=env;let y=0,id=0;const frames=new Map(),scrolls=[];w.requestAnimationFrame=fn=>{frames.set(++id,fn);return id;};w.cancelAnimationFrame=id=>frames.delete(id);const tick=()=>{const ready=[...frames.values()];frames.clear();for(const fn of ready)fn();};
 Object.defineProperty(w,'scrollY',{configurable:true,get:()=>y});Object.defineProperty(w,'innerHeight',{configurable:true,value:650});Object.defineProperty(w.document.documentElement,'scrollHeight',{configurable:true,value:5000});
 const rect=(left,top,width,height)=>({left,right:left+width,top,bottom:top+height,width,height});const picker=$('translation-view');picker.style.outline='4px solid red';picker.style.outlineOffset='2px';picker.getBoundingClientRect=()=>rect(76.015625,447.765625-y,203.984375,44);
 $('reading-mode-toolbar').getBoundingClientRect=()=>rect(20,403.765625-y,350,88);$('reading-feedback').hidden=false;$('reading-feedback').getBoundingClientRect=()=>rect(12,480.4375,366,75.5625);$('media-dock').getBoundingClientRect=()=>rect(12,574,366,64);
 w.scrollBy=(x,dy)=>{const delta=typeof x==='object'?x.top:dy;y+=delta;scrolls.push(delta);};return {picker,tick,scrolls,get y(){return y;}};
}
test('a focused picker resized beneath feedback moves only enough for its full ring, without dismissing or changing display state',async()=>{
 const env=setup(),{w,$}=env;try{
  const g=focusedPickerGeometry(env),doc=w.libraryProbe.documents[0],before=JSON.stringify(doc),feedback=$('reading-feedback');feedback.hidden=true;g.picker.focus();g.tick();assert.deepEqual(g.scrolls,[]);feedback.hidden=false;w.dispatchEvent(new w.Event('resize'));g.tick();assert.deepEqual(g.scrolls,[20]);assert.ok(g.picker.getBoundingClientRect().bottom+6<feedback.getBoundingClientRect().top);assert.equal(feedback.hidden,false);assert.equal(w.document.activeElement,g.picker);assert.equal(JSON.stringify(doc),before);
  w.dispatchEvent(new w.Event('resize'));g.tick();assert.deepEqual(g.scrolls,[20],'already-clear control never scrolls again');
 }finally{await w.happyDOM.close();}
});
for(const cancel of ['wheel','pointerdown','keydown','blur','hidden','replacement','language','scroll','scroll-before-event'])test(`queued picker resize reveal respects newer ${cancel} intent`,async()=>{
 const env=setup(),{w,$}=env;try{
  const g=focusedPickerGeometry(env);g.picker.focus();w.dispatchEvent(new w.Event('resize'));
  if(cancel==='language'){choose(env,'fr');g.scrolls.length=0;}else if(cancel==='scroll'||cancel==='scroll-before-event'){w.scrollBy(0,30);g.scrolls.length=0;if(cancel==='scroll')w.dispatchEvent(new w.Event('scroll'));}else if(cancel==='blur')$('search').focus();else if(cancel==='hidden')$('reading-display-control').hidden=true;else if(cancel==='replacement')w.libraryProbe.documents[0]={...w.libraryProbe.documents[0]};else if(cancel==='wheel')w.dispatchEvent(new w.WheelEvent('wheel',{deltaY:40,bubbles:true}));else w.document.body.dispatchEvent(cancel==='pointerdown'?new w.PointerEvent('pointerdown',{bubbles:true}):new w.KeyboardEvent('keydown',{key:'PageDown',bubbles:true}));
  g.tick();assert.deepEqual(g.scrolls,[]);
 }finally{await w.happyDOM.close();}
});
test('picker resize compensation preserves the current follow owner and media while later manual scrolling still suspends',async()=>{
 const doc=fixture();doc.source_media={job_id:'a'.repeat(32),kind:'audio'};const env=setup([doc]),{w,$}=env;try{
  w.dispatchEvent(new w.Event('coconut-worker-ready'));$('mode-bilingual').click();const player=$('source-media').querySelector('audio');let plays=0,pauses=0,seeks=0,time=37;Object.defineProperties(player,{currentTime:{configurable:true,get:()=>time,set:v=>{time=v;seeks++;}},paused:{configurable:true,value:false},duration:{configurable:true,value:1200}});player.play=async()=>{plays++;};player.pause=()=>{pauses++;};player.onloadedmetadata();player.playbackRate=1.5;player.loop=true;
  const g=focusedPickerGeometry(env);for(const row of $('transcript').querySelectorAll('.segment'))row.getBoundingClientRect=()=>({top:180,bottom:240,height:60});$('follow-playback').focus();$('follow-playback').click();g.tick();assert.equal($('follow-playback').dataset.state,'following');g.picker.focus();w.dispatchEvent(new w.Event('resize'));g.tick();assert.deepEqual(g.scrolls,[20]);w.dispatchEvent(new w.Event('scroll'));assert.equal($('follow-playback').dataset.state,'following');assert.equal(player.currentTime,37);assert.equal(player.playbackRate,1.5);assert.equal(player.loop,true);assert.equal($('source-media').querySelector('audio'),player);assert.deepEqual([plays,pauses,seeks],[0,0,0]);
  w.scrollBy(0,30);w.dispatchEvent(new w.Event('scroll'));assert.equal($('follow-playback').dataset.state,'suspended');
 }finally{await w.happyDOM.close();}
});

for(const overlay of ['top','separate-column','hidden'])test(`picker reveal treats ${overlay} feedback according to its actual occupied region`,async()=>{
 const env=setup(),{w,$}=env;try{
  const g=focusedPickerGeometry(env),feedback=$('reading-feedback');
  if(overlay==='hidden')feedback.hidden=true;else feedback.getBoundingClientRect=()=>overlay==='top'?{left:12,right:378,top:8,bottom:100,width:366,height:92}:{left:300,right:380,top:480,bottom:556,width:80,height:76};
  g.picker.focus();w.dispatchEvent(new w.Event('resize'));g.tick();assert.deepEqual(g.scrolls,[]);
 }finally{await w.happyDOM.close();}
});

test('focused picker skips the nearest unreachable lower slot and uses the reachable upper slot',async()=>{
 const env=setup(),{w,$}=env;try{
  const g=focusedPickerGeometry(env);$('media-dock').hidden=true;g.picker.getBoundingClientRect=()=>({left:76,right:280,top:530-g.y,bottom:574-g.y,width:204,height:44});$('reading-mode-toolbar').getBoundingClientRect=()=>({left:20,right:370,top:486-g.y,bottom:574-g.y,width:350,height:88});
  g.picker.focus();g.tick();assert.deepEqual(g.scrolls,[102]);assert.ok(g.picker.getBoundingClientRect().bottom+6<480.4375);
 }finally{await w.happyDOM.close();}
});
for(const edge of ['pinned','document-end','no-slot'])test(`picker reveal never blindly scrolls when ${edge} prevents a full-ring landing`,async()=>{
 const env=setup(),{w,$}=env;try{
  const g=focusedPickerGeometry(env);
  if(edge==='pinned'){w.scrollBy(0,1000);g.scrolls.length=0;g.picker.getBoundingClientRect=()=>({left:76,right:280,top:52,bottom:96,width:204,height:44});$('reading-mode-toolbar').getBoundingClientRect=()=>({left:20,right:370,top:6,bottom:94,width:350,height:88});$('reading-feedback').getBoundingClientRect=()=>({left:12,right:378,top:8,bottom:158,width:366,height:150});}
  if(edge==='document-end')Object.defineProperty(w.document.documentElement,'scrollHeight',{configurable:true,value:650});
  if(edge==='no-slot')$('reading-feedback').getBoundingClientRect=()=>({left:12,right:378,top:0,bottom:620,width:366,height:620});
  g.picker.focus();g.tick();assert.deepEqual(g.scrolls,[]);assert.equal(w.document.activeElement,g.picker);
 }finally{await w.happyDOM.close();}
});

for(const selector of ['#keyboard-help-open','#reading-info > summary','#toggle-reader-media','#passage-toggle-translation','#passage-search'])test(`only the focused adjacent utility ring can lift above an unpinned toolbar: ${selector}`,async()=>{
 const env=setup(),{w,$}=env;try{
  const target=w.document.querySelector(selector),utility=$('reading-utility'),toolbar=$('reading-mode-toolbar'),doc=w.libraryProbe.documents[0],before=JSON.stringify(doc);let top=170,scrolls=0;w.scrollBy=w.scrollTo=()=>{scrolls++;};target.style.outline='3px solid red';target.style.outlineOffset='3px';target.getBoundingClientRect=()=>({top:126,bottom:170,left:20,right:64,width:44,height:44});toolbar.getBoundingClientRect=()=>({top,bottom:top+88,left:20,right:300,width:280,height:88});toolbar.style.top='6px';
  target.focus();assert.equal(utility.classList.contains('utility-focus-front'),true);top=6;w.dispatchEvent(new w.Event('scroll'));assert.equal(utility.classList.contains('utility-focus-front'),false,'sticky reader controls regain their normal foreground');top=170;w.dispatchEvent(new w.Event('resize'));assert.equal(utility.classList.contains('utility-focus-front'),true);
  $('close-reading-info').focus();assert.equal(utility.classList.contains('utility-focus-front'),false,'panel controls are not one of the five utility entries');target.focus();assert.equal(utility.classList.contains('utility-focus-front'),true);target.blur();assert.equal(utility.classList.contains('utility-focus-front'),false);assert.equal(scrolls,0);assert.equal(JSON.stringify(doc),before);
 }finally{await w.happyDOM.close();}
});
