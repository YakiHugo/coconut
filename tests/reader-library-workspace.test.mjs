// Compatibility renderer regression; this suite is not default React acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {settle} from './helpers/save-pipeline.mjs';
import {evaluateNativeIME} from './helpers/native-ime-proof.mjs';
import {evaluateLibraryReturnScroll,evaluateLibraryReturnIdentity} from './helpers/library-return-scroll-proof.mjs';
const fixture=(count=1,cues=8)=>Array.from({length:count},(_,n)=>({key:'wide-'+n,title:'Wide authored document '+n,language:'en',translation_view:'de',readingPosition:'cue-2',segments:Array.from({length:cues},(_,i)=>({id:'cue-'+i,text:'Authored source '+i,start:i*2,end:i*2+2,translations:{fr:{text:'needle français '+i,source_text:'Authored source '+i,source_language:'en',document_language:'en',provider:'Authored fixture'},zh:{text:'needle 中文 '+i,source_text:'Authored source '+i,source_language:'en',document_language:'en',provider:'Authored fixture'}}})),notes:{}}));
function setup(docs=fixture()){let media,listener;const h=libraryHarness(docs,{probe:true,configureCore(w){const match=w.matchMedia.bind(w);media={matches:false,addEventListener(type,fn){listener=fn;}};w.matchMedia=query=>query==='(max-width: 650px)'?media:match(query);}});return {...h,resize(mobile){media.matches=mobile;listener();}};}
const query=($,value='needle',scope='translations')=>{$('open-library-search').click();$('library-scope').value=scope;$('library-search').value=value;$('library-search').oninput();};
const hit=(w,language='fr')=>w.document.querySelector('.library-translation-group[data-language="'+language+'"] .library-translation-hit');
const cancel=(w,$)=>$('library-search-dialog').dispatchEvent(new w.Event('cancel',{cancelable:true}));
async function ready($){for(let i=0;i<600&&$('library').hidden;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal($('library').hidden,false);}

test('wide search reuses one live tree and leaves reader, player, language and drafts unchanged on open/cancel',async()=>{
 const {w,$,pipeline}=setup();try{
  const host=$('library'),cards=[...host.children],queryNode=$('library-search'),reader=$('transcript').innerHTML,docs=JSON.stringify(pipeline.store.snapshotForExport().documents);
  const player=w.document.createElement('audio');let pauses=0,plays=0;player.pause=()=>pauses++;player.play=()=>{plays++;return Promise.resolve();};$('source-media').append(player);player.currentTime=7;
  $('note').value='unsubmitted authored draft';$('title').focus();$('open-library-search').focus();$('open-library-search').click();
  assert.equal($('library-search-dialog').open,true);assert.equal($('library'),host);assert.equal($('library-search'),queryNode);assert.deepEqual([...host.children],cards);
  assert.equal(w.document.querySelectorAll('#library').length,1);assert.equal($('library-search-results').contains(host),true);assert.equal($('library-options').closest('aside')!==null,true);
  cancel(w,$);assert.equal($('library-search-dialog').open,false);assert.equal($('library-list').contains(host),true);assert.equal(w.document.activeElement,$('open-library-search'));
  assert.equal($('transcript').innerHTML,reader);assert.equal(JSON.stringify(pipeline.store.snapshotForExport().documents),docs);assert.equal($('note').value,'unsubmitted authored draft');assert.equal(player.currentTime,7);assert.equal(pauses,0);assert.equal(plays,0);
 }finally{await w.happyDOM.close();}
});

test('pointer caret and already composing input move only when their current input operation has finished',async()=>{
 const {w,$}=setup();try{
  const input=$('library-search');input.value='Authored needle query';input.dispatchEvent(new w.Event('pointerdown'));input.focus();input.setSelectionRange(9,15,'backward');assert.equal($('library-search-dialog').open,false);
  input.dispatchEvent(new w.Event('pointerup'));assert.equal($('library-search-dialog').open,true);assert.equal(input.selectionStart,9);assert.equal(input.selectionEnd,15);assert.equal(input.selectionDirection,'backward');
  cancel(w,$);assert.equal($('library-search-dialog').open,false);assert.equal(w.document.activeElement,input);
  input.dispatchEvent(new w.Event('compositionstart'));input.value='输入中的词';input.oninput();cancel(w,$);assert.equal($('library-search-dialog').open,false);
  input.dispatchEvent(new w.Event('compositionend'));assert.equal($('library-search-dialog').open,true);assert.equal(input.value,'输入中的词');
 }finally{await w.happyDOM.close();}
});

test('cancelled input focus stays cancelled across resize until a new pointer activation',async()=>{
 const {w,$,resize}=setup();try{
  const input=$('library-search');input.focus();assert.equal($('library-search-dialog').open,true);
  cancel(w,$);assert.equal(w.document.activeElement,input);assert.equal($('library-search-dialog').open,false);
  for(const mobile of [true,false]){resize(mobile);input.focus();assert.equal(w.document.activeElement,input);assert.equal($('library-search-dialog').open,false,'refocusing the same restored input is not a new user activation');}
  input.dispatchEvent(new w.PointerEvent('pointerdown',{bubbles:true}));input.dispatchEvent(new w.PointerEvent('pointerup',{bubbles:true}));
  assert.equal($('library-search-dialog').open,true,'a new real input pointer operation opens the workspace');assert.equal(w.document.activeElement,input);
  resize(true);assert.equal($('library-search-dialog').open,true);assert.equal(w.document.activeElement,input);assert.equal($('library-search-query').contains(input),true);
 }finally{await w.happyDOM.close();}
});

for(const mobile of [false,true])test(`one search-input Escape suppresses native clearing and preserves query/page/background on ${mobile?'mobile':'desktop'}`,async()=>{
 const {w,$,resize}=setup(fixture(45));try{
  resize(mobile);
  $('mode-transcript').click();w.document.querySelector('.note-button').click();const note=$('note');note.value='  exact unsent note  ';note.selectionStart=2;note.selectionEnd=7;
  const player=w.document.createElement('audio');let pauses=0,plays=0;player.pause=()=>pauses++;player.play=()=>{plays++;return Promise.resolve();};player.currentTime=6;$('source-media').append(player);
  const before=JSON.stringify(w.libraryProbe.documents),reader=$('transcript').innerHTML;
  if(mobile)$('toggle-library').click();
  $('open-library-search').focus();query($);await ready($);$('library-next').click();const input=$('library-search');input.focus();input.setSelectionRange(1,4);$('library-search-results').scrollTop=123;
  let backgroundEscapes=0;w.document.addEventListener('keydown',event=>{if(event.key==='Escape')backgroundEscapes++;});
  const escape=new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});input.dispatchEvent(escape);
  // Model the Chromium search-field default only if the application allows it.
  if(!escape.defaultPrevented){input.value='';input.dispatchEvent(new w.Event('input',{bubbles:true}));}
  assert.equal(escape.defaultPrevented,true,'the one key cannot perform the native search clear');assert.equal(backgroundEscapes,0,'handled cancellation cannot leak to newly exposed background controls');
  assert.equal($('library-search-dialog').open,false);assert.equal(input.value,'needle');assert.equal($('library-scope').value,'translations');assert.equal($('library-page-number').value,'2');
  assert.equal(w.document.activeElement,$('open-library-search'));if(mobile)assert.equal($('toggle-library').getAttribute('aria-expanded'),'true','the same Escape does not also dismiss the underlying shelf');assert.equal($('notes-panel').hidden,false);assert.equal($('note'),note);assert.equal(note.value,'  exact unsent note  ');assert.equal(note.selectionStart,2);assert.equal(note.selectionEnd,7);
  assert.equal($('transcript').innerHTML,reader);assert.equal(JSON.stringify(w.libraryProbe.documents),before);assert.equal(player.currentTime,6);assert.equal(pauses,0);assert.equal(plays,0);
  $('open-library-search').click();assert.equal($('library-search-dialog').open,true);assert.equal(w.document.activeElement,input);assert.equal(input.value,'needle');assert.equal(input.selectionStart,1);assert.equal(input.selectionEnd,4);assert.equal($('library-page-number').value,'2');assert.equal($('library-search-results').scrollTop,123);
 }finally{await w.happyDOM.close();}
});

test('search-input Escape respects target veto and every composition owner, leaving other native controls alone',async()=>{
 const {w,$}=setup();try{
  query($);const input=$('library-search'),dialog=$('library-search-dialog');
  const press=(target=input,init={})=>{const event=new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true,...init});target.dispatchEvent(event);return event;};
  input.addEventListener('keydown',event=>event.preventDefault(),{once:true});assert.equal(press().defaultPrevented,true);assert.equal(dialog.open,true);assert.equal(input.value,'needle');
  for(const init of [{isComposing:true},{keyCode:229}]){assert.equal(press(input,init).defaultPrevented,false);assert.equal(dialog.open,true);assert.equal(input.value,'needle');}
  input.dispatchEvent(new w.Event('compositionstart'));assert.equal(press().defaultPrevented,false);assert.equal(dialog.open,true);input.dispatchEvent(new w.Event('compositionend'));
  w.document.dispatchEvent(new w.Event('compositionstart'));assert.equal(press().defaultPrevented,false);assert.equal(dialog.open,true);w.document.dispatchEvent(new w.Event('compositionend'));
  $('library-scope').focus();assert.equal(press($('library-scope')).defaultPrevented,false);assert.equal(dialog.open,true,'select retains its native Escape/cancel route');
  cancel(w,$);assert.equal(dialog.open,false);assert.equal(press().defaultPrevented,false,'the modal handler does not claim a closed workspace');
  $('open-library-search').click();input.focus();assert.equal(press().defaultPrevented,true);assert.equal(dialog.open,false);assert.equal(input.value,'needle');
  $('open-library-search').click();input.value='';input.focus();assert.equal(press().defaultPrevented,true);assert.equal(dialog.open,false);assert.equal(input.value,'');
 }finally{await w.happyDOM.close();}
});

test('650 breakpoint changes preserve modal result owner, page, scroll, focus, query caret and tool identities',async()=>{
 const {w,$,resize}=setup(fixture(45));try{query($);await ready($);$('library-next').click();const host=$('library'),pager=$('library-pagination'),field=$('library-search');field.focus();field.setSelectionRange(1,4);$('library-search-results').scrollTop=181;
  for(const width of [true,false,true,false]){resize(width);assert.equal($('library-search-dialog').open,true);assert.equal($('library'),host);assert.equal($('library-pagination'),pager);assert.equal($('library-search-dialog').contains(pager),true);assert.equal(w.document.activeElement,field);assert.equal(field.selectionStart,1);assert.equal(field.selectionEnd,4);assert.equal($('library-search-results').scrollTop,181);assert.match($('library-page-status').textContent,/41–45/);}
 }finally{await w.happyDOM.close();}
});

test('a cancelled latest page/focus takes precedence over an older selected hit, with per-language positions across pages',async()=>{
 const {w,$}=setup(fixture(45));try{query($);await ready($);hit(w).focus();hit(w).click();assert.equal($('library-search-dialog').open,false);await w.flushContentForTest();await settle();$('return-library-search').click();await ready($);
  $('library-next').click();const group=hit(w).closest('.library-translation-group');group.querySelector('.library-translation-next').click();const latest=hit(w);assert.equal(latest.dataset.hitId,'cue-1');$('library-search-results').scrollTop=321;cancel(w,$);$('open-library-search').click();await ready($);
  assert.match($('library-page-status').textContent,/41–45/);assert.equal(w.document.activeElement,latest);assert.equal(hit(w).dataset.hitId,'cue-1');assert.equal($('library-search-results').scrollTop,321);
  $('library-previous').click();$('library-next').click();assert.equal(hit(w).dataset.hitId,'cue-1');
 }finally{await w.happyDOM.close();}
});

test('a successful exact translation returns after its own save generation without changing reading position or playing media',async()=>{
 const {w,$}=setup(fixture(2,125));let plays=0;w.HTMLMediaElement.prototype.play=()=>{plays++;return Promise.resolve();};try{query($);await ready($);const group=hit(w).closest('.library-translation-group');for(let i=0;i<110;i++)group.querySelector('.library-translation-next').click();const node=hit(w);node.focus();node.click();assert.equal($('library-search-dialog').open,false);assert.equal(w.document.activeElement.dataset.segmentId,'cue-110');assert.equal(w.libraryProbe.documents[0].readingPosition,'cue-2');await w.flushContentForTest();await settle();$('return-library-search').click();await ready($);assert.equal(w.document.activeElement.dataset.hitId,'cue-110');assert.equal(w.document.activeElement.dataset.language,'fr');assert.equal($('library-search').value,'needle');assert.equal(plays,0);
 }finally{await w.happyDOM.close();}
});

for(const change of ['delete','replace-owner','replace-cue','replace-translation'])test('return never guesses a former hit after '+change,async()=>{
 const {w,$}=setup();try{query($);hit(w).focus();hit(w).click();await w.flushContentForTest();await settle();const doc=w.libraryProbe.documents[0];
  if(change==='delete')w.libraryProbe.documents.splice(0,1);if(change==='replace-owner')w.libraryProbe.documents[0]={...doc};if(change==='replace-cue')doc.segments[0]={...doc.segments[0]};if(change==='replace-translation')doc.segments[0].translations.fr={...doc.segments[0].translations.fr};
  $('return-library-search').click();await ready($);assert.equal(w.document.activeElement,$('library-search'));assert.equal($('library-search-dialog').open,true);
 }finally{await w.happyDOM.close();}
});

test('late cooperative activation cannot navigate after close and immediate reopen, and delayed close cannot take fresh focus',async()=>{
 const docs=fixture(1,600);for(const cue of docs[0].segments)cue.translations.fr.text='a';const {w,$}=setup(docs);try{query($,Array(501).fill('a').join(' '));await ready($);const node=hit(w);node.focus();node.click();cancel(w,$);$('open-library-search').click();const current=$('library-search');current.focus();$('library-search-dialog').dispatchEvent(new w.Event('close'));await new Promise(resolve=>setTimeout(resolve,30));assert.equal($('library-search-dialog').open,true);assert.equal(w.document.activeElement,current);assert.equal(w.libraryProbe.documents[0].translation_view,'de');assert.equal(w.libraryProbe.documents[0].readingPosition,'cue-2');
 }finally{await w.happyDOM.close();}
});

test('storage barrier stays in the workspace with the same recovery controls and leaves navigation untouched',async()=>{
 const {w,$,pipeline}=setup();try{query($);const doc=w.libraryProbe.documents[0],target=hit(w);target.focus();const token=pipeline.store.acquireBarrier('workspace-test');target.click();assert.equal($('library-search-dialog').open,true);assert.equal(doc.translation_view,'de');assert.match($('notice').textContent,/保存/);assert.equal($('library-search-feedback').contains($('notice-shell')),true);assert.equal($('library-search-feedback').contains($('save-status')),true);pipeline.store.releaseBarrier(token);cancel(w,$);assert.equal($('library-search-dialog').contains($('save-status')),false);
 }finally{await w.happyDOM.close();}
});

test('historical excerpt detail is a one-modal detour and source navigation retires its search focus return',async()=>{
 const docs=fixture();const record=(await import('../reader/core.js')).default.exactExcerptSnapshot(docs[0],[docs[0].segments[1]],[],0,docs[0].segments[1].text.length,{id:'history',createdAt:'2026-01-01T00:00:00.000Z'});docs[0].exact_excerpts=[record];docs[0].exact_excerpt_notes={history:'historical needle'};const {w,$}=setup(docs);try{query($,'historical needle','notes');const saved=w.document.querySelector('.library-saved-hit');saved.focus();saved.click();assert.equal($('library-notebook').open,true);assert.equal($('library-search-dialog').open,false);assert.equal(w.document.querySelectorAll('dialog[open]').length,1);$('notebook-close').click();assert.equal($('library-search-dialog').open,true);assert.equal(w.document.activeElement,saved);$('library-notebook').dispatchEvent(new w.Event('close'));assert.equal(w.document.activeElement,saved);
  saved.click();$('notebook-captures').querySelector('.notebook-open').click();const destination=w.document.activeElement;assert.equal($('library-search-dialog').open,false);$('library-notebook').dispatchEvent(new w.Event('close'));assert.equal(w.document.activeElement,destination);
 }finally{await w.happyDOM.close();}
});

test('desktop and mobile CSS make the native search pane independently wide, with 44px controls and six-pixel focus clearance',()=>{
 const css=fs.readFileSync(new URL('../reader/style.css',import.meta.url),'utf8'),html=fs.readFileSync(new URL('../reader/compatibility.html',import.meta.url),'utf8');
 assert.match(css,/#library-search-dialog \{ width:min\(960px,calc\(100vw - 48px\)\)/);assert.match(css,/#library-search-dialog \{ width:100vw; height:100dvh;/);assert.match(css,/#library-search-results \{[^}]*overflow:auto/);assert.match(css,/#library-search-dialog :is\(button,select,input,summary\) \{ min-height:44px/);assert.match(css,/#library-search-dialog :is\(button,select,input,summary\):focus-visible \{ outline:3px[^}]*outline-offset:3px/);assert.equal((html.match(/id="library"/g)||[]).length,1);assert.equal((html.match(/id="library-scope"/g)||[]).length,1);
});

for(const id of ['library-scope','library-page-number','library-kind'])test('cancel restores the actual singleton '+id+' control, retaining disclosure visibility',async()=>{
 const {w,$}=setup(fixture(45));try{query($);await ready($);$('library-search-filters').open=true;$(id).focus();cancel(w,$);$('open-library-search').click();assert.equal(w.document.activeElement,$(id));assert.equal($('library-search-dialog').contains($(id)),true);if(id==='library-kind')assert.equal($('library-search-filters').open,true);
 }finally{await w.happyDOM.close();}
});

test('late composition completion after explicit Close cannot reopen the modal or steal the restored opener',async()=>{
 const {w,$}=setup();try{const input=$('library-search');input.focus();input.dispatchEvent(new w.Event('compositionstart'));input.value='未结束的搜索';$('close-library-search').focus();$('close-library-search').click();const opener=w.document.activeElement;input.dispatchEvent(new w.Event('compositionend'));input.dispatchEvent(new w.Event('input',{bubbles:true}));assert.equal($('library-search-dialog').open,false);assert.equal(w.document.activeElement,opener);assert.equal(input.value,'未结束的搜索');
  input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'x',bubbles:true}));assert.equal($('library-search-dialog').open,true);
 }finally{await w.happyDOM.close();}
});

test('hidden or disabled cancelled filter controls never receive restore focus',async()=>{
 const {w,$}=setup();try{query($);$('library-search-filters').open=true;$('library-kind').focus();cancel(w,$);$('library-search-filters').open=false;$('open-library-search').click();assert.equal(w.document.activeElement,$('library-search'));$('library-scope').focus();cancel(w,$);$('library-scope').disabled=true;$('open-library-search').click();assert.equal(w.document.activeElement,$('library-search'));
 }finally{await w.happyDOM.close();}
});

test('generic result paging and recovery keyboard controls reveal the complete six-pixel ring in their actual port',async()=>{
 const {w,$}=setup(fixture(45));const frames=[],globalScrolls=[];w.requestAnimationFrame=fn=>{frames.push(fn);return frames.length;};w.scrollTo=options=>globalScrolls.push(options);try{query($);await ready($);
  for(const [id,hostId] of [['library-page-number','library-search-results'],['retry-save','library-search-feedback']]){
   const target=$(id),port=$(hostId);target.hidden=false;target.disabled=false;target.style.outline='3px solid black';target.style.outlineOffset='3px';port.scrollTop=0;Object.defineProperty(port,'clientHeight',{configurable:true,get:()=>200});Object.defineProperty(port,'scrollHeight',{configurable:true,get:()=>500});Object.defineProperty(port,'clientTop',{configurable:true,get:()=>0});port.getBoundingClientRect=()=>({top:100,bottom:300,left:10,right:380,width:370,height:200});target.getBoundingClientRect=()=>({top:260-port.scrollTop,bottom:304-port.scrollTop,left:20,right:84,width:64,height:44});port.scrollTo=({top})=>{port.scrollTop=Math.round(top);};
   $('library-search').focus();w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true}));target.focus();frames.splice(0).forEach(fn=>fn());const rect=target.getBoundingClientRect();assert.ok(rect.top-6>=100&&rect.bottom+6<=300);assert.equal(w.document.activeElement,target);
  }
  assert.equal(globalScrolls.length,0);
 }finally{await w.happyDOM.close();}
});

test('an existing success notice joins normal modal flow instead of retaining the background fixed overlay',async()=>{
 const {w,$}=setup();try{const style=w.document.createElement('style');style.textContent=fs.readFileSync(new URL('../reader/style.css',import.meta.url),'utf8');w.document.head.append(style);w.URL.createObjectURL=()=> 'blob:authored';w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};$('export-library').click();assert.equal($('notice').dataset.kind,'success');$('open-library-search').click();assert.equal($('library-search-feedback').contains($('notice-shell')),true);assert.equal(w.getComputedStyle($('notice-shell')).position,'static');
 }finally{await w.happyDOM.close();}
});


test('native IME proof compares exact browser end flags without accepting untrusted entry or synthetic events',()=>{
 const text='路标';
 const baseline={events:[
  {type:'compositionstart',data:'',trusted:true,same:true},
  {type:'compositionupdate',data:text,trusted:true,same:true},
  {type:'beforeinput',data:text,trusted:true,same:true,inputType:'insertCompositionText',isComposing:true},
  {type:'input',data:text,trusted:true,same:true,inputType:'insertCompositionText',isComposing:true},
  {type:'compositionend',data:text,trusted:false,same:true}
 ].map((event,index)=>({...event,focused:true,currentNodeSame:true,connected:true,value:index<2?'':text,selectionStart:index<2?0:2,selectionEnd:index<2?0:2})),value:text,selectionStart:2,selectionEnd:2,same:true,focused:true,composing:false,manualDispatches:[]};
 const clone=()=>structuredClone(baseline),valid=actual=>Object.values(evaluateNativeIME({baseline,actual,text})).every(Boolean);
 assert.equal(valid(clone()),true,'an identical engine-owned end flag is accepted only with the complete native trace');
 const trustedEnd=clone();trustedEnd.events.at(-1).trusted=true;assert.equal(Object.values(evaluateNativeIME({baseline:trustedEnd,actual:structuredClone(trustedEnd),text})).every(Boolean),true,'an engine that trusts the end event must retain that flag too');
 for(const index of [0,1,2,3]){const actual=clone();actual.events[index].trusted=false;assert.equal(valid(actual),false,'entry/update/input trust is mandatory');}
 const badTraces=[
  a=>a.events.pop(),a=>{a.events[4].trusted=true;},a=>{a.events[4].data='other';},
  a=>{[a.events[1],a.events[4]]=[a.events[4],a.events[1]];},a=>a.events.push({...a.events[4]}),
  a=>{a.events[2].inputType='insertText';},a=>{a.events[2].isComposing=false;},
  a=>{a.events[3].same=false;},a=>{a.events[3].focused=false;},a=>{a.events[3].currentNodeSame=false;},a=>{a.events[3].connected=false;},
  a=>{a.events[3].selectionStart=0;},a=>{a.events[3].value='other';},a=>{a.same=false;},a=>{a.focused=false;},
  a=>{a.value='different';},a=>{a.selectionStart=0;},a=>{a.composing=true;},
  a=>a.manualDispatches.push({type:'compositionend'})
 ];
 for(const mutate of badTraces){const actual=clone();mutate(actual);assert.equal(valid(actual),false,'a partial, different or synthetic trace cannot pass');}
 const untrusted=clone();untrusted.events[0].trusted=false;
 assert.equal(Object.values(evaluateNativeIME({baseline:untrusted,actual:untrusted,text})).every(Boolean),false,'a matching but untrusted plain input cannot authorize a weaker proof');
 const empty={...clone(),events:[]};assert.equal(Object.values(evaluateNativeIME({baseline:empty,actual:empty,text})).every(Boolean),false,'empty sequences cannot pass by equality');
});


test('native return proof permits only a real range clamp with the same visible anchor and exact owner',()=>{
 const before={scrollTop:56,maxScrollTop:56,scrollHeight:570,clientHeight:514,targetTop:547,targetPortOffset:259,query:'widebeacon',scope:'translations',page:'3',documentKey:'shelf-80',language:'zh',hitId:'shelf-80-cue-5',hitIndex:'第 5 / 5 处',focused:true,connected:true,modalOpen:true};
 const bounded={...before,scrollTop:0,maxScrollTop:0,scrollHeight:514};
 const valid=after=>evaluateLibraryReturnScroll({before,after}).pass&&Object.values(evaluateLibraryReturnIdentity({before,after})).every(Boolean);
 assert.equal(valid(bounded),true);assert.equal(evaluateLibraryReturnScroll({before,after:bounded}).clamped,true);
 assert.equal(valid({...before}),true);assert.equal(evaluateLibraryReturnScroll({before,after:before}).clamped,false);
 assert.equal(valid({...before,scrollTop:55}),true,'the old one-pixel reachable tolerance remains');
 assert.equal(valid({...before,scrollTop:54}),false,'reachable saved offsets cannot drift');
 assert.equal(valid({...bounded,targetTop:548,targetPortOffset:260}),true,'the clamped anchor keeps the same one-pixel tolerance');
 for(const patch of [{targetTop:549},{targetPortOffset:261},{scrollTop:2},{maxScrollTop:4,scrollHeight:518,scrollTop:0},{scrollHeight:513},{clientHeight:-1},{clientHeight:0,scrollHeight:0},{maxScrollTop:NaN},{targetTop:Infinity},{scrollTop:-1}])assert.equal(valid({...bounded,...patch}),false,'neither out-of-range scroll nor an altered anchor is a valid clamp');
 for(const field of ['query','scope','page','documentKey','language','hitId','hitIndex'])assert.equal(valid({...bounded,[field]:'other'}),false,'range clamping cannot change '+field);
 for(const field of ['focused','connected','modalOpen'])assert.equal(valid({...bounded,[field]:false}),false,'range clamping cannot lose '+field);
 for(const field of ['scope','page','documentKey','language','hitId','hitIndex'])for(const invalid of ['', ' ', null, undefined]){
  const missingBefore={...before,[field]:invalid},missingAfter={...bounded,[field]:invalid};
  assert.equal(Object.values(evaluateLibraryReturnIdentity({before:missingBefore,after:missingAfter})).every(Boolean),false,'matching missing '+field+' cannot prove the same owner');
 }
 for(const field of ['scrollTop','maxScrollTop','scrollHeight','clientHeight','targetTop','targetPortOffset'])for(const invalid of [NaN,Infinity,-1,null])assert.equal(evaluateLibraryReturnScroll({before:{...before,[field]:invalid},after:bounded}).pass,false,'invalid saved '+field+' cannot authorize clamping');
 assert.equal(evaluateLibraryReturnScroll({before:{...before,scrollTop:57},after:bounded}).pass,false,'an impossible saved offset is not an allowed exception');
 assert.equal(evaluateLibraryReturnScroll({before:{...before,scrollTop:0,maxScrollTop:0,scrollHeight:514},after:bounded}).clamped,false,'an equal boundary must not enter the clamp branch');
 assert.equal(evaluateLibraryReturnScroll({before:{...before,scrollTop:20},after:{...before,scrollTop:19,maxScrollTop:19,scrollHeight:533,targetTop:549}}).pass,false,'even a one-pixel true clamp still requires the visible anchor');
});
